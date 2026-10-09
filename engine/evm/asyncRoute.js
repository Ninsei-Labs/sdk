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
// IT MIRRORS THE PACKAGE'S PROVIDER LAYER ON PURPOSE. The move to async lives in the SDK package
// (sdk/src/legs/{shape,cow}.mjs): there `cowOrderbook(chainId)` answers whether the CoWSwap order book covers a
// network and `requireAsyncProvider(id)` answers whether a registered provider is complete. The engine cannot
// import the package at runtime (the page loads www/js; the package is a separate bundle), so the network table is
// repeated HERE and the agreement of the two is a CHECK - tools/check-buy-async-route.mjs compares this table
// against sdk/src/legs/cow.mjs, so a repeated truth cannot drift silently. That is the same rule the gas limits
// follow against sdk/src/swap-flow.mjs.
import { ASYNC_ROUTE_PROVIDERS } from "../core/config.js";

// A NAMED SEAM FOR CHECKS: a route record injected for a network the table does not serve, so the asynchronous path
// can be exercised end to end against a local stand-in order book. PRODUCTION NEVER SETS IT - the page reads the
// table, and the table is what the guard cross-checks against the package. The injection is explicit, named at the
// call site and cleared by the same function, so "the path was taken against a stand-in" is never mistaken for
// "a real provider serves this network". The verdict stays a VALUE either way.
let injectedRoute = null;
export const setAsyncRouteInjection = (route = null) => { injectedRoute = route || null; return injectedRoute; };
export const asyncRouteInjection = () => injectedRoute;
// The injection matches a chain (and, when named, a provider id); a record for another chain is ignored.
const injectedFor = (chainId, providerId) => {
  if (!injectedRoute) return null;
  if (Number(injectedRoute.chainId) !== Number(chainId)) return null;
  if (providerId && injectedRoute.id !== providerId) return null;
  return injectedRoute;
};

/** The provider record by id, or null. */
export const asyncRouteProvider = (id) => (id && ASYNC_ROUTE_PROVIDERS[id]) || null;

/** Every declared asynchronous provider id, sorted. */
export const asyncRouteProviderIds = () => Object.keys(ASYNC_ROUTE_PROVIDERS).sort();

/** The networks (numeric chainIds, ascending) a provider serves, or an empty list. */
export const asyncRouteChains = (id) => Object.keys((asyncRouteProvider(id) || {}).networks || {})
  .map(Number).filter(Number.isFinite).sort((a, b) => a - b);

/** The provider record for a network, or null: { id, venue, shape, chainId, slug, orderbook }. */
export const asyncRouteForChain = (chainId, providerId = null) => {
  // THE SEAM FIRST: an injected stand-in for this chain (checks only). It is a full record of the same shape.
  const injected = injectedFor(chainId, providerId);
  if (injected) return { id: injected.id, venue: injected.venue || injected.id, shape: injected.shape || "async", chainId: Number(chainId), slug: injected.slug ?? null, orderbook: injected.orderbook ?? null };
  const id = providerId || asyncRouteProviderIds()[0] || null;
  if (!id) return null;
  const provider = asyncRouteProvider(id);
  if (!provider) return null;
  const n = Number(chainId);
  const net = provider.networks && provider.networks[n];
  if (!net) return null;
  return { id, venue: provider.venue || id, shape: provider.shape || "async", chainId: n, slug: net.slug ?? null, orderbook: net.orderbook ?? null };
};

/**
 * WHETHER AN ASYNCHRONOUS PATH EXISTS FOR A NETWORK - as a VALUE, with a NAMED refusal.
 *   { ok: true,  ...route }                                   - a provider serves the network;
 *   { ok: false, reason: "no-async-provider", chainId, known } - none does; `known` lists the served chains.
 * The refusal is a VALUE, not an exception (the same shape the package's requireAsyncProvider returns): the caller
 * keeps its own wording for the token, and "not served" must never be read as "served" or as silence.
 */
export const asyncRouteVerdict = ({ chainId = null, providerId = null } = {}) => {
  const route = asyncRouteForChain(chainId, providerId);
  // `provider` is the id the caller names in its own refusal (the same field name the package's
  // requireAsyncProvider returns), `id` is kept too so a reader of the raw record is never surprised.
  if (route) return { ok: true, provider: route.id, ...route };
  const id = providerId || asyncRouteProviderIds()[0] || null;
  return {
    ok: false, reason: "no-async-provider",
    chainId: Number.isFinite(Number(chainId)) ? Number(chainId) : null,
    provider: id, known: id ? asyncRouteChains(id) : [],
  };
};
