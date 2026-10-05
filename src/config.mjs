// SDK CONFIGURATION: networks, tokens, thresholds - the engine's data, not the interface's constants.
//
// THE SETTLEMENT NETWORK IS NAMED BY THE PAIR "network + virtual machine": vm already lives in the engine's
// network registry (`vm: "evm" | "bitcoin" | "solana" | "tron"`), and the SDK does not invent it anew. If there
// is no leg driver for a vm, the call does not "quietly assume EVM" - it answers with a code naming what is
// already supported: so adding Tron or Solana will not require edits in the quotes, the Monero leg and the state
// machine.
import * as engine from "./engine.mjs";
import { CHECK_CODES, ERROR_CODES, STEP_CODES } from "./codes.mjs";
import { fail } from "./errors.mjs";
import { implementedVms, legFor } from "./legs/index.mjs";
import { routeProviders } from "./legs/evm.mjs";

// TOKENS ARE TAKEN BY AN ENGINE FUNCTION, NOT FROM A NETWORK FIELD: `tokensOf` returns the native coin first,
// followed by the declared tokens - exactly the list the interface should show. The identifier is the lowercase
// symbol ("usdc"), the same one used in quotes and in API paths.
// TOKENS ARE TAKEN BY NETWORK IDENTIFIER AND WITHOUT A SILENT DEFAULT.
//
// The engine's `tokensOf` looks the network up by slug (`chainById`), and when it does not find it, it SILENTLY
// returns the default network (`DEFAULT_CHAIN`). For the interface that makes sense: showing the default network
// is better than showing emptiness. The core must not do that. A call `tokensOf(chain.chainId)` once stood here -
// a NUMBER where a slug is expected: the network was never found, and the answer was assigned the tokens of
// ANOTHER network, while the `id` field held the correct network identifier. The error was invisible: the list
// looked plausible on an unknown network too.
//
// So the network is looked up by number honestly, absence is a refusal, and additionally it is VERIFIED that the
// list belongs to exactly this network: if the engine ever substitutes the default network again, this will show
// up here, not in a swap that went to the wrong network.
const tokensOfNetwork = (chainId) => {
  const network = typeof engine.config.chainByChainId === "function" ? engine.config.chainByChainId(chainId) : null;
  if (!network) fail("bad-input", { field: "chain.chainId", unknown: chainId, why: "no-network-with-this-chainId" });
  const got = engine.config.tokensOf(network.id);
  const own = [network.native, ...(network.tokens || [])].filter(Boolean);
  const asId = (t) => String(t.symbol).toLowerCase();
  if (got.map(asId).join("|") !== own.map(asId).join("|")) {
    fail("bad-input", { field: "chain.tokens", unknown: chainId, why: "tokens-belong-to-another-network" });
  }
  return got;
};

const chainConfig = (chain) => ({
  id: chain.id,
  name: chain.name,
  vm: chain.vm || "evm",
  chainId: chain.chainId,
  nativeSymbol: chain.native && chain.native.symbol ? chain.native.symbol : null,
  tokens: tokensOfNetwork(chain.chainId).map((t) => ({
    id: String(t.symbol).toLowerCase(),
    symbol: String(t.symbol),
    address: t.address || null,
    decimals: Number(t.decimals),
  })),
  dex: chain.dex ? { routes: chain.dex.routes || [] } : null,
});

// --- ADDRESSES AND PATHS THAT ARE SUPPLIED FROM OUTSIDE ------------------------------------
//
// The default is OUR service and our explorers: everything the engine already knows. Options can name others:
// your own API, your own node, a third-party explorer, a different set of paths. This matters to whoever runs
// the swap for themselves, not to whoever uses it, so it lives in options, not in the interface.
//
// A RULE THAT IS NOT UP FOR DISCUSSION: ADDRESSES are configurable, not CHECKS. Your own API, your own node,
// your own explorer - fine. But the pre-signature guards (the price is not market, the amount is covered, the
// token allowance, the deadlines from the chain) stay enabled under any configuration: otherwise "maximum
// configurability" would become a way to switch the checks off with a single field, which is exactly what the
// core exists to prevent.
//
// PATHS ARE NAMED BY NAMES, NOT BY STRINGS IN CODE. `route("swept", { id })` substitutes the value and encodes
// it; the path holds `{id}`. So changing the host or using a third-party server is an edit of an object, not an
// edit of the core.
// WHY THESE PATHS DID NOT EXIST BEFORE AND WHERE THEY COME FROM. The "server" step (recording the swap with us
// and watching the Monero address) is done with THE SAME requests as the current interface, so the paths are
// named after its calls, not invented: the watch state - GET /swaps/{id} (www/js/core/chainSource.js:184,
// fetchSession), the factory record of a swap - POST /evm-swaps (www/js/evm/auth.js:111, saveServerSwap; in app
// the full path /api/evm-swaps is declared by the template /^\/api\/evm-swaps$/ in app/server.mjs:1230).
export const DEFAULT_ROUTES = Object.freeze({
  swaps: "/swaps",
  swap: "/swaps/{id}",
  evmSwaps: "/evm-swaps",
  // A quote for an order: the provider's commitment under keys, not a market snapshot.
  orderQuote: "/order-quote",
  revealedHalf: "/escrow/revealed-half",
  swept: "/swaps/{id}/swept",
});

// THE MONERO NODES THE ARRIVAL IS CHECKED AGAINST. Defaults are the list verified on 2026-10-02 (issue #85):
// mainnet - four public nodes of different operators; stagenet - our node and the one independent public node.
// `ready` opens only when two nodes of DIFFERENT operators agree on the block (see sdk/src/xmr-arrival.mjs), so
// the list is a list of WITNESSES, not of equal endpoints.
//
// OVERRIDABLE BY THE INTERFACE AND THE USER: `options.nodes` replaces the list (an array for the chosen network,
// or an object keyed by network) and `options.addNodes` appends to the defaults (that is how a user adds their
// own node). The checks themselves are not configurable - only the addresses.
export const DEFAULT_XMR_NODES = Object.freeze({
  mainnet: [
    { url: "https://xmr-node.cakewallet.com:18081", operator: "Cake Wallet" },
    { url: "https://xmr.cryptostorm.is", operator: "cryptostorm" },
    { url: "https://node.monero.fail", operator: "monero.fail" },
    { url: "https://mainnet.xmr.kernal.eu:18089", operator: "kernal.eu" },
  ],
  stagenet: [
    { url: "https://xmr.arrakisswap.trade", operator: "arrakisswap" },
    { url: "https://stagenet.xmr.kernal.eu:38089", operator: "kernal.eu" },
  ],
});

const nodeEntryOk = (raw) => (typeof raw === "string" && raw)
  || (raw && typeof raw === "object" && typeof raw.url === "string" && raw.url);
const nodesArrayOk = (a) => Array.isArray(a) && a.every(nodeEntryOk);

// The resolved node map: the defaults, then the overrides. An unknown network key is a typo, not a silent no-op.
const nodesOf = (options, selected) => {
  const custom = options && options.nodes;
  const extra = options && options.addNodes;
  const out = { mainnet: [...DEFAULT_XMR_NODES.mainnet], stagenet: [...DEFAULT_XMR_NODES.stagenet] };
  if (custom !== undefined && custom !== null) {
    if (nodesArrayOk(custom)) {
      if (!(selected in out)) fail("bad-input", { field: "nodes", network: selected });
      out[selected] = [...custom];
    } else if (custom && typeof custom === "object" && !Array.isArray(custom)) {
      for (const name of Object.keys(custom)) {
        if (!(name in out)) fail("bad-input", { field: "nodes", unknown: name, known: Object.keys(out) });
        if (!nodesArrayOk(custom[name])) fail("bad-input", { field: "nodes." + name });
        out[name] = [...custom[name]];
      }
    } else fail("bad-input", { field: "nodes" });
  }
  if (extra !== undefined && extra !== null) {
    if (!nodesArrayOk(extra)) fail("bad-input", { field: "addNodes" });
    if (!(selected in out)) fail("bad-input", { field: "addNodes", network: selected });
    out[selected] = [...out[selected], ...extra];
  }
  return out;
};

const pathOf = (template, params) => template.replace(/\{([a-z]+)\}/g, (whole, name) => {
  const value = params ? params[name] : undefined;
  if (value === undefined || value === null || value === "") fail("bad-input", { field: "route.param", param: name });
  return encodeURIComponent(String(value));
});

const routesOf = (options) => {
  const custom = (options && options.routes) || {};
  for (const name of Object.keys(custom)) {
    // AN UNKNOWN NAME IS A TYPO, NOT "let's add our own": otherwise the path silently fails to apply, and the
    // call falls back to a default nobody knows about.
    if (!(name in DEFAULT_ROUTES)) fail("bad-input", { field: "routes", unknown: name, known: Object.keys(DEFAULT_ROUTES) });
    if (typeof custom[name] !== "string" || !custom[name]) fail("bad-input", { field: "routes." + name });
  }
  return { ...DEFAULT_ROUTES, ...custom };
};

// THE POLL RATE AND TIMEOUT FOR WATCHING THE MONERO ADDRESS. The defaults come from the engine's settings, not
// from numbers in the code: the rate is the same as the page's (www/js/core/chainSource.js, pollInterval =
// API.pollMs), and the timeout is from the Monero timings (blockTimeReal x confirmTarget): that is how long it
// takes to gather the confirmations of the target, and declaring the wait expired before that would be lying
// about the money. Both numbers are overridable by the `watch` option.
const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const watchOf = (options) => {
  const w = (options && options.watch) || {};
  const pollMs = w.pollMs === undefined ? (positive(engine.config.API && engine.config.API.pollMs) || 5000) : Number(w.pollMs);
  if (!Number.isFinite(pollMs) || pollMs <= 0) fail("bad-input", { field: "watch.pollMs" });
  const monero = engine.config.MONERO || {};
  const fallback = (positive(monero.blockTimeReal) || 120000) * (positive(monero.confirmTarget) || 10);
  const timeoutMs = w.timeoutMs === undefined ? fallback : Number(w.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("bad-input", { field: "watch.timeoutMs" });
  return { pollMs, timeoutMs };
};

const endpointsOf = (raw, options) => {
  const e = (options && options.endpoints) || {};
  const explorer = e.explorer || {};
  const rpc = e.rpc || {};
  const text = (v) => (typeof v === "string" && v ? v : null);
  return {
    explorer: {
      evmTx: text(explorer.evmTx) || text(raw.explorerTx),
      evmAddr: text(explorer.evmAddr) || text(raw.explorerAddr),
      evmName: text(explorer.evmName) || text(raw.explorerName),
      // The engine builds the Monero explorer from the swap's network; here you can supply your own template with `{tx}`.
      xmrTx: text(explorer.xmrTx),
    },
    rpc: {
      // The EVM node: for the engine it serves as a parameter for wallet_addEthereumChain, for the core as the
      // read address if the leg driver talks to it itself. Overriding is allowed, but the network and the
      // contract addresses must change together: changing the node without the network produces refusals that
      // look like a code error (that is why chainId is checked separately and that check is not configurable).
      evm: text(rpc.evm) || text(raw.rpcUrl),
      monero: text(rpc.monero),
    },
  };
};

export function buildConfig(options) {
  const chains = engine.config.CHAINS.map(chainConfig);
  const chosen = chains.find((c) => c.id === options.settlement.chain) || null;
  if (!chosen) fail("bad-input", { field: "settlement.chain", known: chains.map((c) => c.id) });
  const rawChain = engine.config.CHAINS.find((c) => c.id === options.settlement.chain) || {};
  const routes = routesOf(options);
  const watch = watchOf(options);
  const endpoints = endpointsOf(rawChain, options);
  const nodes = nodesOf(options, options.xmrNetwork);
  const vm = options.settlement.vm || chosen.vm;
  if (!vm) fail("bad-input", { field: "settlement.vm" });
  if (vm !== chosen.vm) fail("bad-input", { field: "settlement.vm", chain: chosen.id, vm: chosen.vm, got: vm });
  const leg = legFor(vm);
  if (!leg) fail("not-implemented", { surface: "settlement.vm", vm, implemented: implementedVms() });

  // ROUTE PROVIDERS: our declared routes today, an external aggregator when it arrives. The choice comes through
  // options and is checked against the registry: an unknown provider is a typo, not "we'll try and see".
  // One beating another is decided by an explicit order, not by response speed: otherwise the price would change
  // based on who made it over the network first.
  const known = routeProviders();
  const prefer = Array.isArray(options.routing && options.routing.prefer) && options.routing.prefer.length
    ? options.routing.prefer.map((id) => String(id))
    : known.filter((id) => id === "declared");
  for (const id of prefer) {
    if (!known.includes(id)) fail("bad-input", { field: "routing.prefer", unknown: id, known });
  }

  // MONERO NETWORKS THE CORE KNOWS. The engine's registry declares only the one the demo is configured for
  // (XMR_NETWORKS: stagenet). But the SDK contract (index.d.ts, xmrNetwork) names THREE standard names -
  // mainnet/stagenet/testnet - and that is not about the demo: the withdrawal page takes the network FROM THE
  // NODE, and on a production network its network is mainnet, not a typo. So three standard ones are added to
  // the declared ones; anything else is still a refusal with the known list.
  const STANDARD_XMR_NETWORKS = ["mainnet", "stagenet", "testnet"];
  const xmrNetworks = [...new Set([...Object.values(engine.config.XMR_NETWORKS || {}), ...STANDARD_XMR_NETWORKS])];
  if (!xmrNetworks.includes(options.xmrNetwork)) {
    fail("bad-input", { field: "xmrNetwork", known: xmrNetworks });
  }
  const guards = engine.config.SIGNING_GUARDS || {};
  return {
    settlement: { chain: chosen, vm },
    chains,
    xmrNetworks,
    assetsBase: options.assetsBase,
    apiBase: options.apiBase,
    mode: options.mode,
    limits: {
      // SIZE LIMITS COME WITH THE LIVE QUOTE, NOT FROM A FILE: the provider node declares them, and different
      // nodes have different ones. While there is no quote, the honest value is null, not an invented number.
      minAmount: null,
      maxAmount: null,
      stepAmount: null,
      xmrConfirmTarget: engine.config.MONERO.confirmTarget ?? null,
      // WATCH POLLING: the values above (engine settings or the `watch` option).
      watchPollMs: watch.pollMs,
      watchTimeoutMs: watch.timeoutMs,
      // HOW MANY CONFIRMATIONS BEFORE `ready` - a NUMBER IN THE CONFIGURATION so it changes in one place. The
      // default is the engine's target (10 blocks ~ 20 minutes at 2-minute blocks, the owner's decision). The
      // confirmation window must fit before the ready deadline, or a hopeless trade would start - see
      // xmr-arrival.mjs (assertTimeForConfirmations) and SIGNING_GUARDS.minReadyLeadSec under www/js.
      xmrConfirmations: engine.config.MONERO.confirmTarget ?? 10,
      xmrBlockTimeSec: Math.round((engine.config.MONERO.blockTimeReal ?? 120000) / 1000),
      readyLeadWarnSec: guards.readyLeadWarnSec ?? null,
      // THE PRICE POLL RATE AND THE REQUEST TIMEOUT - from the engine's settings, not from numbers in the SDK:
      // two numbers in two places would silently diverge, and polling would become more frequent than the
      // backend allows.
      quotePollMs: engine.config.API.pollMs ?? 5000,
      httpTimeoutMs: engine.config.API.timeoutMs ?? 20000,
    },
    routing: { providers: known, prefer },
    // NAMED PATHS AND ADDRESSES: `route` substitutes parameters, `endpoints` carries the already-resolved values
    // (the default from the registry, the override from the options).
    routes: { ...routes },
    endpoints,
    // THE NODES THE XMR ARRIVAL IS CHECKED AGAINST - by network, with the defaults from the verified list and any
    // overrides the caller (or the user) brought. `nodesFor` is the pick for one network.
    xmrNodes: nodes,
    nodesFor: (network) => (nodes && nodes[network]) ? nodes[network] : [],
    route: (name, params) => {
      if (!(name in routes)) fail("bad-input", { field: "route", unknown: name, known: Object.keys(routes) });
      return pathOf(routes[name], params);
    },
    codes: { steps: STEP_CODES, checks: CHECK_CODES, errors: ERROR_CODES },
  };
}
