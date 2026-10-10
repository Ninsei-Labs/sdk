// THE EVM LEG DRIVER. Everything the SDK knows about an EVM network as a settlement side.
//
// This is not the full leg yet: the escrow reads and writes (fund/markReady/claim/refund, the order state) will
// land here in stage 2. Already here: what the network is called for the wallet, how to tell that the wallet is on
// the right network, how balances are read, and the ROUTE-PROVIDER REGISTRY (our declared routes today, an
// external aggregator when it arrives).
// THE SHARED SHAPE VOCABULARY lives in its own module (./shape.mjs) so the registry and the concrete providers can
// both depend on it without an import cycle. The CoWSwap provider is registered below like any other route provider.
import { SYNC, ASYNC, providerShapeVerdict } from "./shape.mjs";
import { cowProvider } from "./cow.mjs";
import { kyberProvider } from "./kyber.mjs";

export const vm = "evm";

/** What this network is called for the wallet: for EVM - a numeric chainId. */
export const walletChainId = (chain) => Number(chain.chainId);

/** Does the wallet's network match the settlement network. The comparison is VM-specific, so it lives in the driver. */
export const sameChain = (walletChainIdValue, chain) => {
  const want = walletChainId(chain);
  const got = Number(walletChainIdValue);
  return Number.isFinite(got) && Number.isFinite(want) && got === want;
};

// THE balanceOf(address) SELECTOR - 0x70a08231. It is not taken from memory: the same value is declared in the
// project (rfq/evm.mjs, "verified against the project's code") and used by the engine (www/js/evm/session.js). The
// match is checked by tools/check-sdk.mjs - it reads the engine's registry and fails if they diverge.
export const BALANCE_OF_SELECTOR = "0x70a08231";

const toMinimal = (hex) => {
  try {
    return BigInt(hex).toString(10);
  } catch {
    return null;
  }
};
const addrWord = (address) => String(address).replace(/^0x/, "").toLowerCase().padStart(64, "0");

/**
 * BALANCES: the native coin - eth_getBalance, a token - balanceOf via eth_call. decimals are taken from the
 * registry (they held the BSC trap), not from the chain's answer: the answer carries only the number in minimal
 * units.
 * Not read - null, not zero: zero would look like an empty wallet.
 */
export async function balances({ driver, address, tokens }) {
  const out = [];
  for (const token of tokens) {
    let amount = null;
    try {
      if (token.address === null) {
        amount = toMinimal(await driver.request({ method: "eth_getBalance", params: [address, "latest"] }));
      } else {
        const data = BALANCE_OF_SELECTOR + addrWord(address);
        amount = toMinimal(await driver.request({ method: "eth_call", params: [{ to: token.address, data }, "latest"] }));
      }
    } catch {
      amount = null;
    }
    out.push({ token: token.id, symbol: token.symbol, decimals: token.decimals, amount });
  }
  return out;
}

// THE ROUTE-PROVIDER REGISTRY (DEX/aggregator). Their role is one: turn what the person gives into what the escrow
// is funded with, and name the expected output. They DIFFER in the method: your own declared routes (DEX_ROUTES
// data in the engine's registry) or an external aggregator (1inch and the like).
//
// WHAT THIS GIVES: an aggregator becomes a CHOICE, not a rewrite - a new file and a line in this registry. The
// pre-signature guards are shared by all providers: the price is not market, the amount is covered, the token
// allowance - otherwise an external route would become a hole in those very guards.
//
// THE SHAPE OF THE SWAP IS DECLARED, NOT ASSUMED. A provider says which way its swap settles, because the deal
// path differs by it. Uniswap and SushiSwap are router AMMs - the router runs INSIDE the user's transaction, so
// the swap and the escrow funding are ONE transaction (shape "sync"). CoWSwap is an intent auction - the person
// signs an intent, and the settlement arrives LATER as a separate transaction sent by someone else (shape
// "async"). Hard-coding "one transaction" into the deal path would fit only the first and force a rewrite for the
// second, so the shape lives HERE and the path ASKS for it (see requireSyncProvider) instead of assuming it.
//
// AN ASYNCHRONOUS PROVIDER MUST DECLARE WHAT ENDS ITS EXECUTION - not a stub field, but something that can really
// be checked: `settled(request)`, a check that reads the outcome (for an intent auction - the settlement of the
// signed order) and answers whether the swap has ended and with what. A provider that cannot say this is
// incomplete, and the check refuses it by NAME rather than treating it as synchronous.
//
// REQUIREMENT FOR A PROVIDER: id, kind, shape ("sync" | "async"), plan(...) -> { ok, expectedOutWei | code,
// route?, calldata?, to? } and, for shape "async", settled(...). Execution (assembling and sending the
// transaction) is stage 3; for now only our provider is declared, and its plan honestly answers with a code.
export { SYNC, ASYNC };

const ROUTE_PROVIDERS = {
  declared: {
    id: "declared",
    kind: "declared",
    // OUR ROUTES ARE A ROUTER: the swap runs inside the user's own transaction and funds the escrow in it - hence
    // "sync", and hence no completion step: there is no later action to wait for.
    shape: SYNC,
    async plan() {
      return { ok: false, code: "not-implemented", stage: 3 };
    },
  },
  // COWSWAP - AN INTENT AUCTION: "async". The person signs an intent, and the settlement arrives LATER as a separate
  // transaction sent by someone else. Its record therefore carries `settled(...)` - what ends its execution (the
  // order book reporting the order settled or finally dead). The provider itself lives in ./cow.mjs.
  cowswap: cowProvider,
  // KYBERSWAP LIMIT ORDER - A SECOND INTENT AUCTION, ALSO "async". Same role as CoW (the person signs an
  // order, someone else settles it later), a different book and contract. It is the LIQUIDITY leg: its order
  // trades ERC20 against ERC20 and settles WETH, not native coin (see the scope note in ./kyber.mjs). The
  // provider itself lives in ./kyber.mjs.
  kyberswap: kyberProvider,
};

/** Who can execute a route at all. The list is needed by the "no such provider" error. */
export const routeProviders = () => Object.keys(ROUTE_PROVIDERS).sort();
export const routeProviderFor = (id) => ROUTE_PROVIDERS[id] || null;

/**
 * THE GATE OF A PATH THAT ASSUMES "SWAP AND FUNDING IN ONE TRANSACTION". Such a path (stage 3: the router leg that
 * funds the escrow with the very transaction that swaps) needs a provider whose swap happens in the user's OWN
 * transaction. An asynchronous provider settles in a LATER, separate action, and silently treating it as
 * synchronous would fund an escrow with nothing behind it - so it is refused BY NAME, with a `reason` token (the
 * same shape of refusal the level book uses), not assumed to be synchronous.
 *
 * Returns { ok: true, provider } or { ok: false, reason, ... } - a refusal as a VALUE, not an exception: the
 * caller keeps its own wording for the token.
 */
export const requireSyncProvider = (id) => {
  const provider = routeProviderFor(id);
  if (!provider) return { ok: false, reason: "provider-unknown", provider: typeof id === "string" ? id : null, known: routeProviders() };
  if (provider.shape !== SYNC) {
    return { ok: false, reason: "provider-not-synchronous", provider: provider.id, shape: provider.shape === undefined ? null : provider.shape };
  }
  return { ok: true, provider };
};

/**
 * THE GATE OF A PATH THAT ASSUMES AN ASYNCHRONOUS INTENT. The mirror of requireSyncProvider: it accepts a provider
 * whose swap settles in a LATER, separate action, and refuses by NAME - never silently - a provider that is
 * unknown, that is in fact synchronous, or that declares itself asynchronous without naming what ends execution
 * (`settled`). Refusals are VALUES: { ok: true, provider } or { ok: false, reason, ... }.
 */
export const requireAsyncProvider = (id) => {
  const provider = routeProviderFor(id);
  if (!provider) return { ok: false, reason: "provider-unknown", provider: typeof id === "string" ? id : null, known: routeProviders() };
  if (provider.shape !== ASYNC) return { ok: false, reason: "provider-not-asynchronous", provider: provider.id, shape: provider.shape === undefined ? null : provider.shape };
  const verdict = providerShapeVerdict(provider);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, provider: provider.id, shape: provider.shape === undefined ? null : provider.shape, missing: verdict.missing ?? null };
  return { ok: true, provider };
};

/**
 * A GENERAL GATE: may a path use this provider at all, whatever the shape, and is the provider complete (an
 * asynchronous one names what ends its execution). The shape itself is NOT required to match a path's assumption
 * here - that is what requireSyncProvider / requireAsyncProvider are for.
 */
export const requireProvider = (id) => {
  const provider = routeProviderFor(id);
  if (!provider) return { ok: false, reason: "provider-unknown", provider: typeof id === "string" ? id : null, known: routeProviders() };
  const verdict = providerShapeVerdict(provider);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, provider: provider.id, shape: verdict.shape ?? null, missing: verdict.missing ?? null };
  return { ok: true, provider };
};

// --- WHAT A PROVIDER SETTLES: THE COMPOSITION CAPABILITY --------------------------------------------
//
// A native need (the escrow is funded with the chain's NATIVE coin) can be carried by a provider only if the
// provider SETTLES native. A provider that settles the WRAPPED native (KyberSwap Limit Order) can never be the last
// mile: it is usable only as the LIQUIDITY leg of a COMPOSITION, and the composition needs a native-capable provider
// on the SAME network to finish (WETH -> native). So the capability is DATA on each provider (`settles`) and the
// question is answered HERE by a VALUE, never assumed from the provider's name - the same rule the engine's
// composition follows (www/js/evm/asyncRoute.js, asyncRouteChoice).
export const SETTLES = Object.freeze({ NATIVE: "native", WRAPPED: "wrapped" });

/** WHAT A PROVIDER SETTLES ("native" | "wrapped"), or null when it does not say. */
export const providerSettles = (provider) => (provider && provider.settles ? provider.settles : null);

/**
 * CAN THIS PROVIDER CARRY A NATIVE NEED ALL THE WAY - a VALUE, by name.
 *   { ok: true,  settles: "native", provider }                     - it settles native: it can be the native leg;
 *   { ok: false, reason: "settles-wrapped", settles, provider }    - wrapped native only: a liquidity leg at most;
 *   { ok: false, reason: "settles-unstated", settles: null, ... }  - it does not say: refused, never assumed native.
 */
export const carriesNativeVerdict = (provider) => {
  const settles = providerSettles(provider);
  const id = provider && provider.id ? provider.id : null;
  if (settles === SETTLES.NATIVE) return { ok: true, settles, provider: id };
  if (settles === SETTLES.WRAPPED) return { ok: false, reason: "settles-wrapped", settles, provider: id };
  return { ok: false, reason: "settles-unstated", settles: null, provider: id };
};
