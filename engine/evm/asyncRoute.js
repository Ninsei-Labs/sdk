// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/asyncRoute.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// ASYNCHRONOUS ROUTE PROVIDERS BY NETWORK - "IS THERE A PATH FOR A PERSON WITH NO OWN NATIVE COIN".
//
// WHY THIS MODULE EXISTS. The declared routes in the registry (www/js/core/config.js: DEX_ROUTES) are ROUTER
// swaps: they run INSIDE the person's own transaction (shape "sync"), so the person must hold native coin to pay
// for that transaction. A person coming from USDC who holds NONE cannot sign it at all. The way out is an INTENT
// AUCTION (shape "async"): sign an intent, let solvers settle it later, and only THEN pay for the escrow deposit -
// so the deposit's gas is paid AFTER the swap, not before it. Whether such a provider serves a network is DATA
// (core/config.js: ASYNC_ROUTE_PROVIDERS), and this module is the ONE engine place that answers it - as a value,
// with a NAMED refusal, never by silence and never as a silent "yes".
//
// STEP 5: THE CHOICE CONSIDERS BOTH PROVIDERS AND WHAT A PROVIDER SETTLES. The escrow is funded with NATIVE coin,
// so the choice is asked "can you carry the route ALL THE WAY to native?". A provider declares what it ends at
// (`settles`: "native" for CoW, "wrapped" for KyberSwap - whose orders trade ERC20 against ERC20 and whose API
// refuses native as an order asset). So a wrapped provider is NEVER chosen as the sole provider for a native need:
// it is a LIQUIDITY leg, and the route to native is a COMPOSITION of two orders - the liquidity leg (token -> WETH)
// and a native leg on a native-capable provider (WETH -> native coin, CoW). The choice returns a route record or a
// composition; the composition is EXECUTED in evm/asyncExec.js, which pays the second leg's own fee out of the
// reserve so the person is not sent into a composition that leaves them short of the deposit.
//
// IT MIRRORS THE PACKAGE'S PROVIDER LAYER ON PURPOSE. The move to async lives in the SDK package
// (sdk/src/legs/{shape,cow,kyber}.mjs): there `cowOrderbook(chainId)` / `kyberOrderbook(chainId)` answer whether a
// provider covers a network and `requireAsyncProvider(id)` answers whether a registered provider is complete. The
// engine cannot import the package at runtime (the page loads www/js; the package is a separate bundle), so the
// network table is repeated HERE and the agreement of the two is a CHECK - tools/check-buy-async-route.mjs compares
// this table against sdk/src/legs/cow.mjs and sdk/src/legs/kyber.mjs (including `settles`), so a repeated truth
// cannot drift silently.
import { ASYNC_ROUTE_PROVIDERS } from "../core/config.js";

// WHAT THE PERSON NEEDS TO END WITH. The escrow is funded with the network's NATIVE coin, so the default is native.
export const ASYNC_NEEDS = ["native", "wrapped"];
export const ASYNC_DEFAULT_NEED = "native";
// WHAT A PROVIDER SETTLES: the two values the table's `settles` field may take.
export const ASYNC_SETTLES = Object.freeze({ NATIVE: "native", WRAPPED: "wrapped" });

// A NAMED SEAM FOR CHECKS: route record(s) injected for a network the table does not serve, so the asynchronous path
// can be exercised end to end against a local stand-in order book. PRODUCTION NEVER SETS IT - the page reads the
// table, and the table is what the guard cross-checks against the package. The injection is explicit, named at the
// call site and cleared by the same function, so "the path was taken against a stand-in" is never mistaken for
// "a real provider serves this network". Step 5 needs MORE THAN ONE provider at once (a composition), so the seam
// takes a single record OR a list; the verdict stays a VALUE either way.
let injectedRoutes = [];
const injectionValue = () => (injectedRoutes.length === 0 ? null : injectedRoutes.length === 1 ? injectedRoutes[0] : injectedRoutes);
export const setAsyncRouteInjection = (route = null) => {
  if (Array.isArray(route)) injectedRoutes = route.filter(Boolean);
  else if (route && typeof route === "object") injectedRoutes = [route];
  else injectedRoutes = [];
  return injectionValue();
};
export const asyncRouteInjection = () => injectionValue();
const injectedFor = (chainId) => injectedRoutes.filter((r) => r && Number(r.chainId) === Number(chainId));

/** The provider record by id, or null. */
export const asyncRouteProvider = (id) => (id && ASYNC_ROUTE_PROVIDERS[id]) || null;

/** Every declared asynchronous provider id, sorted. */
export const asyncRouteProviderIds = () => Object.keys(ASYNC_ROUTE_PROVIDERS).sort();

/** The networks (numeric chainIds, ascending) a provider serves, or an empty list. */
export const asyncRouteChains = (id) => Object.keys((asyncRouteProvider(id) || {}).networks || {})
  .map(Number).filter(Number.isFinite).sort((a, b) => a - b);

/** WHAT A PROVIDER SETTLES ("native" | "wrapped"), or null. The table declares it; an injection may override it. */
export const asyncRouteProviderSettles = (id) => {
  const provider = asyncRouteProvider(id);
  return provider ? (provider.settles === undefined ? null : provider.settles) : null;
};

// A route record: { id, venue, shape, chainId, slug, orderbook, contract, settles }. `settles` resolves the
// injection's own value first, then the table's for the same id (so an injection that names a real provider inherits
// its capability and does not have to repeat it).
const settlesOf = (id, extra = {}) => (extra.settles ? extra.settles : asyncRouteProviderSettles(id));
const recordFor = (id, chainId, net, extra = {}) => {
  const provider = asyncRouteProvider(id) || {};
  return {
    id,
    venue: extra.venue || provider.venue || id,
    shape: extra.shape || provider.shape || "async",
    chainId: Number(chainId),
    slug: net.slug === undefined ? null : net.slug,
    orderbook: net.orderbook === undefined ? null : net.orderbook,
    contract: net.contract === undefined ? null : net.contract,
    settles: settlesOf(id, extra),
  };
};

/**
 * EVERY provider that serves a network, as route records (sorted by id). An injection for the same id WINS over the
 * table (checks drive the path against a stand-in book). An empty list means no asynchronous provider serves the
 * network - the caller must refuse BY NAME, never guess.
 */
export const asyncRouteProvidersForChain = (chainId) => {
  const n = Number(chainId);
  const byId = new Map();
  for (const id of asyncRouteProviderIds()) {
    const provider = asyncRouteProvider(id);
    const net = provider.networks && provider.networks[n];
    if (net) byId.set(id, recordFor(id, n, net));
  }
  for (const inj of injectedFor(n)) {
    byId.set(inj.id, recordFor(inj.id, n, { slug: inj.slug, orderbook: inj.orderbook, contract: inj.contract },
      { settles: inj.settles, venue: inj.venue, shape: inj.shape }));
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * The provider record for a network, or null. `providerId` names the provider; absent, the first by id (the
 * historical default, kept so a caller that passes only a chain sees the same record as before). The injection is
 * consulted first (checks only).
 */
export const asyncRouteForChain = (chainId, providerId = null) => {
  const n = Number(chainId);
  if (providerId) {
    const inj = injectedFor(n).find((r) => r.id === providerId);
    if (inj) return recordFor(inj.id, n, { slug: inj.slug, orderbook: inj.orderbook, contract: inj.contract },
      { settles: inj.settles, venue: inj.venue, shape: inj.shape });
    return asyncRouteProvidersForChain(n).find((r) => r.id === providerId) || null;
  }
  const served = asyncRouteProvidersForChain(n);
  return served.length ? served[0] : null;
};

// The chains a named provider (or the first, when unnamed) serves - the `known` list of a refusal, unchanged in
// meaning from before the step.
const knownChainsFor = (providerId) => asyncRouteChains(providerId || asyncRouteProviderIds()[0] || null);

/**
 * WHICH WAY AN ASYNCHRONOUS NEED GOES FOR A NETWORK - as a VALUE, with a NAMED refusal.
 *
 *   { ok: true,  kind: "single",      ...route, need }                 - one provider carries the need all the way;
 *   { ok: true,  kind: "composition", legs: [liquidity, native], ... } - no single provider carries a NATIVE need,
 *                                                                        but a liquidity (wrapped) leg and a
 *                                                                        native-capable leg both serve the network;
 *   { ok: false, reason: "no-async-provider" | "no-native-async-provider", ... } - a named refusal.
 *
 * The rule that matters: a provider that does not settle what the person needs is NEVER chosen as the sole provider
 * for that need (a route that ends in WETH must not pass as native). It may only be a leg of a composition, and a
 * composition is possible only when a native-capable provider serves the SAME network to finish it.
 */
export const asyncRouteChoice = ({ chainId = null, providerId = null, need = ASYNC_DEFAULT_NEED } = {}) => {
  const n = Number(chainId);
  const finite = Number.isFinite(n);
  const want = ASYNC_NEEDS.includes(need) ? need : ASYNC_DEFAULT_NEED;
  const served = finite ? asyncRouteProvidersForChain(n) : [];
  if (!served.length) {
    return { ok: false, reason: "no-async-provider", chainId: finite ? n : null, need: want, provider: providerId || null, known: knownChainsFor(providerId) };
  }
  let named = null;
  if (providerId) {
    named = served.find((r) => r.id === providerId) || null;
    if (!named) return { ok: false, reason: "no-async-provider", chainId: n, need: want, provider: providerId, known: served.map((r) => r.id) };
  }
  const considered = named ? [named] : served;
  const direct = considered.filter((r) => r.settles === want);
  if (direct.length) {
    const first = direct[0];
    return { ok: true, kind: "single", ...first, need: want, provider: first.id, legs: [first] };
  }
  // No single provider carries the need. Compose when the need is native and BOTH legs exist on this network.
  const liquidity = considered.filter((r) => r.settles === ASYNC_SETTLES.WRAPPED);
  const native = served.filter((r) => r.settles === ASYNC_SETTLES.NATIVE);
  if (want === ASYNC_SETTLES.NATIVE && liquidity.length && native.length) {
    const leg1 = liquidity[0];
    const leg2 = native[0];
    return { ok: true, kind: "composition", need: want, chainId: n, provider: leg1.id, venue: leg1.venue, shape: "async",
      orderbook: leg1.orderbook, legs: [leg1, leg2] };
  }
  // The truthful reason: the network DOES serve asynchronous providers, but none can finish at what the person needs.
  const reason = want === ASYNC_SETTLES.NATIVE && liquidity.length && !native.length
    ? "no-native-async-provider" : "no-async-provider";
  return { ok: false, reason, chainId: n, need: want, missing: want, provider: (named || liquidity[0] || served[0]).id, known: served.map((r) => r.id) };
};

/** The historical name of the same verdict, kept so existing callers (evm/permit.js) see one implementation. */
export const asyncRouteVerdict = asyncRouteChoice;
