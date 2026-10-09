// THE SDK ENTRY POINT. Assembles the facades and holds rules common to all: no DOM, no texts, no windows.
import { buildConfig } from "./config.mjs";
import { createHttp } from "./http.mjs";
import { createQuotes } from "./quotes.mjs";
import { createPreflight } from "./preflight.mjs";
import { createRecovery } from "./recovery.mjs";
import { createSim } from "./sim.mjs";
import { createWallet } from "./wallet.mjs";
import { legFor } from "./legs/index.mjs";
import * as engine from "./engine.mjs";
import { createSwaps } from "./swaps.mjs";
// ORDER ACTIONS - ON THE FACADE: marking ready, claiming and refunding go through the same chain-read seam as
// the lock. The page gets them from the facade, not by importing the module separately.
import { createActions } from "./actions.mjs";
import { contextOf, verifyCounterparty, jointAddress } from "./order.mjs";
// THE DEAL ENGINE, NOW A PACKAGE MODULE (#32, wave 3): the order flow used to be an engine file the page pulled
// out of www/js. It is declared here so the facade carries the order READS the page needs (state and deadlines)
// on the same chain-read seam as the actions.
import * as orderFlow from "./swap-flow.mjs";
import { createSweep } from "./sweep.mjs";
import { SdkError, fail } from "./errors.mjs";
import { ERROR_CODES, STEP_CODES, CHECK_CODES } from "./codes.mjs";

// A surface declared by the contract but answering with a code: that is more honest than returning an empty
// value that looks like data. The stage number is named so the interface understands what to expect
// (sdk/README.md, "Stages").
const stageOf = {
  "quotes.firm": 2,
  "swaps.start": 2,
  "swaps.list": 2,
  "swaps.get": 2,
};

const notImplemented = (surface) => {
  const error = new SdkError("not-implemented", { surface, stage: stageOf[surface] ?? null });
  return async () => { throw error; };
};

const normalizeOptions = (options) => {
  const o = options && typeof options === "object" ? options : {};
  const settlement = o.settlement && typeof o.settlement === "object" ? o.settlement : null;
  if (!settlement || typeof settlement.chain !== "string" || !settlement.chain) {
    fail("bad-input", { field: "settlement.chain" });
  }
  if (settlement.vm !== undefined && (typeof settlement.vm !== "string" || !settlement.vm)) {
    fail("bad-input", { field: "settlement.vm" });
  }
  if (typeof o.xmrNetwork !== "string" || !o.xmrNetwork) fail("bad-input", { field: "xmrNetwork" });
  const mode = o.mode === undefined ? "live" : o.mode;
  if (mode !== "live" && mode !== "sim") fail("bad-input", { field: "mode", known: ["live", "sim"] });
  if (o.storage !== undefined) {
    const s = o.storage;
    if (!(s && typeof s.get === "function" && typeof s.set === "function" && typeof s.remove === "function")) {
      fail("bad-input", { field: "storage" });
    }
  }
  if (o.fetch !== undefined && typeof o.fetch !== "function") fail("bad-input", { field: "fetch" });
  if (o.now !== undefined && typeof o.now !== "function") fail("bad-input", { field: "now" });
  if (o.routing !== undefined) {
    const r = o.routing;
    if (!r || typeof r !== "object" || (r.prefer !== undefined && !Array.isArray(r.prefer))) fail("bad-input", { field: "routing" });
  }
  // PATHS AND ADDRESSES: the shape is checked here, the meaning - when the configuration is built (where the
  // registry's defaults live). They must not be silently dropped: an override nobody knows about is worse than
  // a refusal.
  if (o.routes !== undefined && (!o.routes || typeof o.routes !== "object" || Array.isArray(o.routes))) {
    fail("bad-input", { field: "routes" });
  }
  if (o.endpoints !== undefined && (!o.endpoints || typeof o.endpoints !== "object" || Array.isArray(o.endpoints))) {
    fail("bad-input", { field: "endpoints" });
  }
  // THE WITNESS NODES FOR THE ARRIVAL CHECK: the list the interface or the user brings. A shape check only - the
  // meaning (defaults, per-network) is worked out when the configuration is built. An array replaces the list for
  // the chosen network, an object replaces per network, and `addNodes` appends (that is how a user adds their own).
  if (o.nodes !== undefined && !Array.isArray(o.nodes) && (!o.nodes || typeof o.nodes !== "object")) {
    fail("bad-input", { field: "nodes" });
  }
  if (o.addNodes !== undefined && !Array.isArray(o.addNodes)) fail("bad-input", { field: "addNodes" });
  // THE CHAIN-READ SEAM. By default the core reads the chain through the page's wallet (the engine's
  // readContract), and in Node there is no such wallet: a live run from Node was impossible because there was
  // nothing to read predict/status/fee with. From outside you can bring your own reader - a READ, not a node
  // substitution: the calls go to the network whose address the registry returned. The shape is the same as the
  // lock seam: ({to, data}) -> hex.
  if (o.evmCall !== undefined && typeof o.evmCall !== "function") fail("bad-input", { field: "evmCall" });
  // THE CODE-READ SEAM (issue #103): ({address}) -> hex code, for the extcodehash check of the factory. Same
  // rule as evmCall - a read brought from outside, not a substitution of the chain.
  if (o.evmCode !== undefined && typeof o.evmCode !== "function") fail("bad-input", { field: "evmCode" });
  // THE INTERFACE'S ALLOW-LIST (POLICY, NOT PROOF): an array of provider addresses (or providerIds) OR a
  // predicate. It is NOT the check itself - that is `providerOf` on chain, taken from the quote - but the
  // interface's own decision about whom it trades with. A wrong shape is a typo, not a silent no-op.
  if (o.allowedProviders !== undefined && o.allowedProviders !== null) {
    const a = o.allowedProviders;
    if (!Array.isArray(a) && typeof a !== "function") fail("bad-input", { field: "allowedProviders" });
  }
  // THE INTERFACE'S FACTORY POLICY (issue #103): an array of code hashes (extcodehash) the interface accepts.
  // Like allowedProviders - a POLICY list, not proof; empty/absent means "no policy".
  if (o.knownFactoryCodes !== undefined && o.knownFactoryCodes !== null && !Array.isArray(o.knownFactoryCodes)) {
    fail("bad-input", { field: "knownFactoryCodes" });
  }
  // THE INTERFACE'S ESCROW-IMPLEMENTATION POLICY (issue #114): an array of code hashes of known implementations
  // of the escrow - the code every order's clone delegatecalls. The client checks the pair (implementation,
  // implementationCodeHash) the factory carries, exactly as the factory does at creation; this list pins WHICH
  // builds the interface accepts. Same rule as knownFactoryCodes: a POLICY list, empty/absent means "no policy"
  // (then the pair is still read and the code at the implementation's address must be non-empty).
  if (o.knownImplementationCodes !== undefined && o.knownImplementationCodes !== null && !Array.isArray(o.knownImplementationCodes)) {
    fail("bad-input", { field: "knownImplementationCodes" });
  }
  // THE INTERFACE'S ADDRESS DENYLIST (issue #16): policy, like allowedProviders - addresses the interface will not
  // trade to or from. An empty/absent list means "no check"; an entry that is not a string is a typo, not a silent
  // no-op. The SDK fetches nothing: the interface brings the list in.
  if (o.denylist !== undefined && o.denylist !== null) {
    if (!Array.isArray(o.denylist) || o.denylist.some((a) => typeof a !== "string")) fail("bad-input", { field: "denylist" });
  }
  // A PASS TO OUR SERVICE - A SEAM FROM OUTSIDE, like the wallet: only a wallet can sign the sign-in message
  // (www/js/evm/auth.js, signIn), and requiring it of the core would mean opening windows and signing messages
  // inside the SDK. The core receives a ready pass and presents it. A missing pass is NOT an option error: the
  // "server" step then answers with the app's refusal (401) under a named code.
  if (o.serverAuth !== undefined && typeof o.serverAuth !== "function") fail("bad-input", { field: "serverAuth" });
  // YOUR OWN SWAP RECORD - A CAPABILITY, NOT A REQUIREMENT. By default the core builds the record and the order
  // side itself (record.mjs + order.mjs) and uses that side both for the record and for the lock terms. The
  // function is for whoever wants to bring THEIR OWN side; it must be a function, otherwise it is a typo, not a
  // setting.
  if (o.createRecord !== undefined && typeof o.createRecord !== "function") fail("bad-input", { field: "createRecord" });
  // WATCHING THE MONERO ADDRESS: the rate and the timeout. They are checked here by shape, and their meaning is
  // worked out when the configuration is built (where the engine settings' defaults live).
  if (o.watch !== undefined) {
    const w = o.watch;
    if (!w || typeof w !== "object" || Array.isArray(w)) fail("bad-input", { field: "watch" });
    for (const name of ["pollMs", "timeoutMs"]) {
      if (w[name] !== undefined && !(Number.isFinite(Number(w[name])) && Number(w[name]) > 0)) fail("bad-input", { field: "watch." + name });
    }
  }
  return {
    settlement: { chain: settlement.chain, vm: settlement.vm },
    xmrNetwork: o.xmrNetwork,
    apiBase: typeof o.apiBase === "string" && o.apiBase ? o.apiBase : "/api",
    assetsBase: typeof o.assetsBase === "string" && o.assetsBase ? o.assetsBase : "/",
    mode,
    storage: o.storage || null,
    fetch: o.fetch || null,
    now: o.now || null,
    routing: o.routing || null,
    // PATHS AND ADDRESSES PASS ON AS THEY ARE: their meaning is worked out when the configuration is built,
    // where the registry's defaults live. They must not be dropped here - an override nobody knows about is
    // worse than a refusal.
    routes: o.routes || null,
    endpoints: o.endpoints || null,
    nodes: o.nodes === undefined ? null : o.nodes,
    addNodes: o.addNodes === undefined ? null : o.addNodes,
    evmCall: o.evmCall || null,
    evmCode: o.evmCode || null,
    allowedProviders: o.allowedProviders === undefined ? null : o.allowedProviders,
    knownFactoryCodes: o.knownFactoryCodes === undefined ? null : o.knownFactoryCodes,
    knownImplementationCodes: o.knownImplementationCodes === undefined ? null : o.knownImplementationCodes,
    denylist: o.denylist === undefined ? null : o.denylist,
    serverAuth: o.serverAuth || null,
    watch: o.watch || null,
    createRecord: o.createRecord || null,
  };
};

export function createNinsei(options) {
  const o = normalizeOptions(options);
  const config = buildConfig({
    settlement: o.settlement,
    xmrNetwork: o.xmrNetwork,
    apiBase: o.apiBase,
    assetsBase: o.assetsBase,
    mode: o.mode,
    routing: o.routing,
    routes: o.routes,
  endpoints: o.endpoints,
  watch: o.watch,
  nodes: o.nodes,
  addNodes: o.addNodes,
});
  const leg = legFor(config.settlement.vm);
  const wallet = createWallet({ settlement: config.settlement.chain, leg });
  // THE GUARDS READ THE NETWORK UNDER THE NAME evmNetwork, WHILE THE CONFIGURATION BUILDER RETURNS IT AS
  // settlement.chain (preflight.mjs: both chain.nativeSymbol and config.evmNetwork.id). The names diverged, and
  // ANY guard call failed with a TypeError - without a code, that is, not as a refusal but as a breakdown. A
  // live swap start was therefore impossible in principle: preflight is called as the first step of start. We
  // hand the guards a record of the same network under the name they expect; from outside it is the same config
  // as before.
  const preflight = createPreflight({ config: { ...config, evmNetwork: config.settlement.chain }, wallet, limits: config.limits });
  const sim = o.mode === "sim" ? createSim() : null;
  // THE STORAGE THE INTERFACE BROUGHT BECOMES THE CORE'S STORAGE: unfinished swaps and the agent session live
  // where the interface decided (browser storage, memory, a server). Without the option the core takes its
  // default: web storage if it is present in the environment, otherwise memory.
  if (o.storage) {
    engine.store.setStorage(o.storage);
    engine.auth.setSessionStore(o.storage);
  }
  const http = createHttp({ apiBase: config.apiBase, fetchImpl: o.fetch, timeoutMs: config.limits.httpTimeoutMs });
  // THE CHAIN READ AND THE ALLOW-LIST GO INTO THE QUOTE CHECK: without the read the signature certifies itself,
  // so the same evmCall seam the lock and the actions use is handed to the quotes too.
  const providerAllowed = (() => {
    const a = o.allowedProviders;
    if (a === null || a === undefined) return null;
    if (typeof a === "function") return (provider) => a(provider) === true;
    const set = new Set(a.map((v) => String(v).toLowerCase()));
    return (provider) => set.has(String(provider).toLowerCase());
  })();
  // THE DENYLIST IS LOWER-CASED ONCE HERE, so the comparison rule (case-insensitive membership) lives in ONE
  // place and BOTH the quote check (`quotes.firm`) and the lock check (`swaps.start`) use it. An empty list is
  // "no policy" (null), not an empty check.
  const denylist = Array.isArray(o.denylist) && o.denylist.length
    ? new Set(o.denylist.map((a) => String(a).toLowerCase()))
    : null;
  const quotes = createQuotes({ config, http, now: o.now || (() => Date.now()), evmCall: o.evmCall || null,
    evmCode: o.evmCode || null, providerAllowed, knownFactoryCodes: o.knownFactoryCodes, knownImplementationCodes: o.knownImplementationCodes,
    denylist });
  // THE SAME CHAIN-READ SEAM AS THE LOCK AND THE CORE: checking the slots and signing must go one way, otherwise
  // part of the check goes past the wallet and part does not.
  const actions = createActions({ call: o.evmCall });
  // THE SAME CHAIN-READ SEAM FOR THE ORDER READS: state and deadlines must be read by the wallet that will sign,
  // not by a second provider. Without a caller reader the module keeps its engine default.
  const orderDeps = typeof o.evmCall === "function" ? { call: o.evmCall } : {};

  return Object.freeze({
    config,
    wallet,
    preflight,
    recovery: createRecovery(),

    // THE ORDER: checking the counterparty's side and the joint address. Both checks - BEFORE signing: after it
    // there is nothing to fix.
    // ORDER ACTIONS ON THE ESCROW: marking ready, claiming, refunding. Expectations (expect) are mandatory -
    // without them there is nothing to check against, and the signature does not go out.
    actions,
    order: {
      context: (terms) => contextOf(terms),
      verifyCounterparty: (request) => verifyCounterparty(request),
      jointAddress: (request) => jointAddress(request),
      // ORDER STATE FROM THE CHAIN (escrow slot 3): which of the four states the order is in. Read, not guessed
      // from logs - the very call the engine used to make from www/js/core/swap-flow.js.
      status: (escrow) => orderFlow.orderStatus(escrow, orderDeps),
      // THE ORDER DEADLINES (t1, readyBy, termsHash) from the chain: the screen needs them to say whether the
      // person is in the dead zone.
      deadlines: (escrow) => orderFlow.orderDeadlines(escrow, orderDeps),
    },
    sim,
    quotes: {
      // LIVE INDICATIVE QUOTES. The subscription delivers data on every poll tick and is removed by the function
      // watch returned; the last listener to leave stops the polling.
      watch: (request, onSnapshot) => quotes.watch(request, onSnapshot),
      snapshot: () => quotes.snapshot(),
      // A firm quote is stage 2: it is signed with a key and lives in the order protocol, not in a market snapshot.
      // A FIRM QUOTE: accepted only with a confirmed provider signature.
      firm: (request) => quotes.firm(request),
    },
    // READING STATE WORKS, STARTING IS NAMED HONESTLY: list/get raise swaps from storage after a page reload;
    // start holds the step order and runs into the step that creates the record (stage 2).
    // THE MODE AND THE MONERO NETWORK GO INTO THE SWAP START: in the sandbox the counterparty's side is built by
    // a stand-in, on a live chain - only from the quote (a stand-in there would mean money against a
    // non-existent side), and the network is needed to build the shared Monero address.
    // THE CHAIN READER GOES INTO THE SWAP START: it will check the escrow address, the order state and the fee
    // before signing.
    // THE PATHS, THE POLL TIMINGS AND THE PASS GO INTO THE START: without the configuration the "server" step
    // would not know where to knock, and without the pass there is nothing to present to the service (and that
    // is a refusal with a CODE, not an invented path).
    swaps: createSwaps({ preflight, http, mode: o.mode, xmrNetwork: o.xmrNetwork, call: o.evmCall,
      config, auth: o.serverAuth, denylist, watch: o.watch,
      // THE RECORD IS BUILT HERE ITSELF, and one brought from outside is only the caller's preference.
      createRecord: o.createRecord }),
    // XMR WITHDRAWAL: parsing the file and requesting data work; the withdrawal itself is named (the Monero
    // wallet as an adapter).
    sweep: createSweep({ http, config }),
  });
}

export { SdkError, ERROR_CODES, STEP_CODES, CHECK_CODES };

// THE LEVEL WALK IS ON THE PACKAGE SURFACE. A maker publishes a level set (chunks of volume with their own prices)
// and both the node and the client compute a firm price by WALKING it - the client must reach the SAME price before
// signing. `levelsWalkSpec.mjs` is the ONE implementation, a byte-identical twin of the node's copy, and it is
// exported so a consumer can run the same walk: the set in, the answer out. Answers are values with a `reason`
// token on refusal, never exceptions.
export { checkLevels, xmrForAsset, assetForXmr, toBigInt, XMR_ATOMIC_PER_ONE } from "./levelsWalkSpec.mjs";
