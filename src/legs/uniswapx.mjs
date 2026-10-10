
// UNISWAPX - THE THIRD CONCRETE ASYNCHRONOUS ROUTE PROVIDER, A SIBLING OF cow.mjs AND kyber.mjs.
//
// WHAT IT IS. UniswapX is an intent auction: the swapper signs an EIP-712 order (gasless) and fillers compete to
// settle it on chain LATER as a separate transaction. So its shape is "async" - there is no single transaction that
// swaps and funds the escrow - and its execution ends when the order service reports the order FILLED, or finally
// dead (expired / error / cancelled / insufficient-funds). The `settled(request, deps)` below is that "what ends its
// execution", and the seam refuses an async provider without it.
//
// WHY THIS ONE CAN CARRY A ROUTE ALL THE WAY TO NATIVE. Its output token may be address(0), the protocol's NATIVE
// sentinel (uniswapx-spec.mjs, UNISWAPX_NATIVE, from Uniswap/UniswapX CurrencyLibrary). So a route to a native need
// can end HERE, unlike the KyberSwap leg (which settles the wrapped native only). `settles: "native"`.
//
// THE FLOW, AND WHERE THE HOSTED SERVICE IS.
//   1) BUILD the swapper's own part of the order LOCALLY (uniswapxPlan below): every field of a V2 Dutch order that
//      the swapper signs is known here, and the digest is computed from this repository's own EIP-712
//      (uniswapx-spec.mjs). This part needs no service.
//   2) SIGN it through the wallet adapter (eth_signTypedData_v4 over Permit2's domain, the order as the witness).
//   3) CO-SIGN AND PUBLISH. A V2 Dutch order is COSIGNED: `cosignerData` (the decay window and any overrides) and a
//      `cosignature` are produced by the cosigner AFTER the swapper signs. Uniswap's own documentation states that
//      the Uniswap Interface and the Uniswap API set the cosigner to Uniswap Labs ("Auction Types"), and orders
//      reach fillers through the Uniswap API: "Order submission is handled by the Uniswap Trading API" (the UniswapX
//      orders OpenAPI). That endpoint (POST /order on the Trading API) REQUIRES AN API KEY in the `x-api-key` header
//      - so PUBLISHING AN ORDER IS BLOCKED WITHOUT A KEY AND A HOSTED QUOTER. This provider says so plainly: with
//      no key it refuses by name ("uniswapx-no-api-key") instead of inventing an endpoint. It does NOT invent one.
//   4) READ THE OUTCOME from the UniswapX orders service (GET /orders on https://api.uniswap.org/v2 - the endpoint
//      Uniswap's own filler documentation tells fillers to poll), by the order hash, and read `orderStatus`.
//
// EVERY EXTERNAL FACT IS PINNED TO ITS SOURCE:
//   * the order type, the field names/order, the Permit2 domain and the native sentinel - uniswapx-spec.mjs, with
//     its own citations (Uniswap/UniswapX src/lib/V2DutchOrderLib.sol, DutchOrderLib.sol, OrderInfoLib.sol,
//     CurrencyLibrary.sol; Uniswap/permit2 src/EIP712.sol; Uniswap/uniswapx-sdk src/order/V2DutchOrder.ts);
//   * the reactor addresses per chain - developers.uniswap.org/deployments.json (the feed the UniswapX "Deployment"
//     page points to): Ethereum mainnet V2DutchOrderReactor 0x00000011F84B9aa48e5f8aA8B9897600006289Be. Other chains
//     run the Dutch V3 reactor, whose order struct is a different type and is NOT built here;
//   * the publishing endpoint and its API key requirement - developers.uniswap.org, "Swapping via the Uniswap API"
//     (POST /order for a UniswapX order) and the Trading API OpenAPI (trade-api.gateway.uniswap.org/v1/api.json:
//     path /order, operation "Create a gasless order", security apiKey in header `x-api-key`);
//   * the READ endpoint and status vocabulary - api.uniswap.org/v2/uniswapx/docs.json (GET /orders; OrderStatus
//     enum open | expired | error | cancelled | filled | insufficient-funds) and developers.uniswap.org,
//     "Fillers Overview" (poll the orders endpoint, at most 4 RPS).
//
// THE SHARED PRE-SIGNATURE GUARDS STAY ON FOR THIS PROVIDER TOO (uniswapxGate): the price is not the market, the
// amount is covered, the token allowance - the SAME guard functions the synchronous DEX leg and the other two
// providers use. An external, asynchronous route must not become a hole in the guards.
//
// NO NEW DEPENDENCY: the typed data is built by uniswapx-spec.mjs (this repository's own EIP-712), signing goes
// through the wallet adapter / the repository's signer, and the transport is the repository's own createHttp.
import { ASYNC } from "./shape.mjs";
import {
  UNISWAPX_PERMIT2, UNISWAPX_NATIVE, UNISWAPX_ORDER_FIELDS,
  uniswapxOrderMissingFields, uniswapxOrderHashHex, uniswapxOrderTypedData,
} from "./uniswapx-spec.mjs";
import { createHttp } from "../http.mjs";
import * as engine from "../engine.mjs";

// THE ORDER SERVICE (read side): the UniswapX orders API, one base URL for every chain (api.uniswap.org/v2).
export const UNISWAPX_API = "https://api.uniswap.org/v2";
// THE TRADING API (write side): where a signed gasless order is published. Requires an API key.
export const UNISWAPX_TRADING_API = "https://trade-api.gateway.uniswap.org/v1";
export const UNISWAPX_ORDER_PATH = "/orders";
export const UNISWAPX_SUBMIT_PATH = "/order";
// The venue name, in one word (no assembly needed: it is a single token).
export const UNISWAPX_VENUE = "UniswapX";

// THE COSIGNER. A V2 Dutch order is cosigned, and Uniswap's documentation states the Uniswap Interface and the
// Uniswap API set the cosigner to Uniswap Labs ("Auction Types", concepts). The address below is the one every real
// mainnet Dutch_V2 order we read carries; it is a DEFAULT for building a well-formed order, and the cosignature
// itself is the cosigner's - this provider cannot produce it.
export const UNISWAPX_COSIGNER = "0x4449Cd34d1eb1FEDCF02A1Be3834FfDe8E6A6180";

// ZERO - used for the absent additional-validation contract.
export const UNISWAPX_ZERO = "0x0000000000000000000000000000000000000000";

// THE NETWORKS WHERE THIS PROVIDER CAN BUILD AN ORDER. Keyed by EVM chainId. Only the chains whose reactor accepts
// the V2 Dutch order this spec implements: Ethereum mainnet (V2DutchOrderReactor). A network absent here is a NAMED
// refusal ("uniswapx-unknown-network"), never a guess at an endpoint or a reactor.
export const UNISWAPX_NETWORKS = Object.freeze({
  1: { orderbook: UNISWAPX_API, reactor: "0x00000011F84B9aa48e5f8aA8B9897600006289Be" },
});

// THE STATUS VOCABULARY OF THE ORDER SERVICE (api.uniswap.org/v2/uniswapx/docs.json: OrderStatus). A status outside
// this set is NOT "probably fine": the answer is not the shape we know and it is refused with "uniswapx-bad-response".
export const UNISWAPX_STATUSES = ["open", "expired", "error", "cancelled", "filled", "insufficient-funds"];
export const UNISWAPX_FINAL_STATUSES = ["expired", "error", "cancelled", "filled", "insufficient-funds"];
export const UNISWAPX_SETTLED_STATUS = "filled";
export const UNISWAPX_OPEN_STATUSES = ["open"];

// THE NAMED REFUSALS OF THIS PROVIDER. Every one is a VALUE ({ ok: false, code }), never silence and never null: a
// caller must always be able to tell "unreachable" from "refused" from "not settled yet", and "no key" from "no
// submitter configured" - the two ways publishing is blocked here.
export const UNISWAPX_REFUSAL_CODES = [
  "uniswapx-unknown-network", // the chain has no V2 Dutch reactor here
  "uniswapx-bad-order",      // the order is incomplete or malformed - nothing to sign
  "uniswapx-sign-failed",    // the wallet did not produce a signature
  "uniswapx-no-api-key",     // publishing needs the Uniswap Trading API key, and none was given
  "uniswapx-no-submitter",   // no order service to publish to was named
  "uniswapx-unreachable",    // no answer from the order service (connection or timeout)
  "uniswapx-order-unknown",  // the service does not know this order hash
  "uniswapx-refused",        // the service answered and did not accept (it carries the status and its reason)
  "uniswapx-bad-response",   // the answer is not the shape we know
  "uniswapx-not-settled",    // the order stayed open until the timeout - "not yet", not "broken"
];

const refusal = (code, params = {}) => ({ ok: false, code, params });

/** The reactor for a chain, or null. */
export const uniswapxReactorFor = (chainId) => {
  const n = UNISWAPX_NETWORKS[Number(chainId)];
  return n ? n.reactor : null;
};
/** The order service base URL for a chain, or null. */
export const uniswapxOrderbook = (chainId) => {
  const n = UNISWAPX_NETWORKS[Number(chainId)];
  return n ? n.orderbook : null;
};

const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
const isPositive = (v) => { try { return BigInt(String(v)) > 0n; } catch { return false; } };
const isHash = (v) => /^0x[0-9a-fA-F]{64}$/.test(String(v || ""));

/**
 * THE INTENT: from what the person gives, build the swapper's own V2 Dutch order, its EIP-712 typed data and its
 * order hash. Returns { ok: true, order, typedData, orderHash, chainId, owner, reactor } or a named refusal.
 * Pure - no network, no wallet. The cosignerData / cosignature are NOT here: the cosigner adds them after the
 * swapper signs (see the header) and this provider cannot produce them.
 */
export function buildUniswapxIntent(request = {}) {
  const chainId = Number(request.chainId);
  const net = UNISWAPX_NETWORKS[chainId];
  if (!net) return { ...refusal("uniswapx-unknown-network", { chainId: Number.isFinite(chainId) ? chainId : null }), known: Object.keys(UNISWAPX_NETWORKS).map(Number) };
  const swapper = request.swapper;
  const recipient = request.recipient === undefined || request.recipient === null ? swapper : request.recipient;
  const order = {
    reactor: request.reactor === undefined || request.reactor === null ? net.reactor : request.reactor,
    swapper,
    nonce: request.nonce,
    deadline: request.deadline,
    additionalValidationContract: request.additionalValidationContract === undefined || request.additionalValidationContract === null ? UNISWAPX_ZERO : request.additionalValidationContract,
    additionalValidationData: request.additionalValidationData === undefined || request.additionalValidationData === null ? "0x" : request.additionalValidationData,
    cosigner: request.cosigner === undefined || request.cosigner === null ? UNISWAPX_COSIGNER : request.cosigner,
    baseInputToken: request.sellToken,
    baseInputStartAmount: request.sellAmountWei,
    baseInputEndAmount: request.sellAmountEndWei === undefined || request.sellAmountEndWei === null ? request.sellAmountWei : request.sellAmountEndWei,
    baseOutputs: [{
      token: request.buyToken,
      startAmount: request.buyAmountWei,
      endAmount: request.buyAmountEndWei === undefined || request.buyAmountEndWei === null ? request.buyAmountWei : request.buyAmountEndWei,
      recipient,
    }],
  };
  const missing = uniswapxOrderMissingFields(order);
  if (!isAddress(swapper)) missing.push("swapper");
  if (!isAddress(order.reactor)) missing.push("reactor");
  if (!isAddress(order.cosigner)) missing.push("cosigner");
  if (!isAddress(order.baseInputToken)) missing.push("sellToken");
  if (!isPositive(order.baseInputStartAmount) || !isPositive(order.baseInputEndAmount)) missing.push("sellAmountWei");
  if (!isPositive(order.baseOutputs[0].startAmount) || !isPositive(order.baseOutputs[0].endAmount)) missing.push("buyAmountWei");
  if (!isAddress(order.baseOutputs[0].token) || !isAddress(order.baseOutputs[0].recipient)) missing.push("buyToken");
  if (!Number.isInteger(Number(order.deadline))) missing.push("deadline");
  if (missing.length) return refusal("uniswapx-bad-order", { missing: [...new Set(missing)] });
  try {
    const typedData = uniswapxOrderTypedData({ order, chainId });
    const orderHash = uniswapxOrderHashHex(order);
    return { ok: true, chainId, owner: swapper, reactor: order.reactor, order, orderHash, typedData };
  } catch (error) {
    // A malformed number/address inside the encoder: a NAMED refusal, not an exception escaping to the caller.
    return refusal("uniswapx-bad-order", { why: String(error && error.message ? error.message : error) });
  }
}

/** The provider's plan, in the shape the registry and the paths expect. Returns a VALUE with a named refusal. */
export function uniswapxPlan(request = {}) {
  const intent = buildUniswapxIntent(request);
  if (!intent.ok) return intent;
  const output = intent.order.baseOutputs[0];
  return {
    ok: true,
    provider: "uniswapx",
    venue: UNISWAPX_VENUE,
    shape: ASYNC,
    route: "uniswapx",
    expectedOutWei: String(output.endAmount),
    order: intent.order,
    orderHash: intent.orderHash,
    typedData: intent.typedData,
    owner: intent.owner,
    reactor: intent.reactor,
    nativeOutput: String(output.token).toLowerCase() === UNISWAPX_NATIVE,
    endsWith: { kind: "order-status", settledWhen: UNISWAPX_SETTLED_STATUS, final: [...UNISWAPX_FINAL_STATUSES], endpoint: UNISWAPX_ORDER_PATH },
  };
}

/**
 * SIGN THE ORDER THROUGH THE WALLET ADAPTER. The adapter's own `signTypedData` is used when present (it wraps
 * eth_signTypedData_v4); otherwise the same call is made through the adapter's EIP-1193 driver. A wallet that will
 * not sign is a NAMED refusal, not a crash.
 */
export async function uniswapxSignOrder({ typedData, wallet, address = null } = {}) {
  if (!typedData || typeof typedData !== "object") return refusal("uniswapx-bad-order", { field: "typedData" });
  try {
    if (wallet && typeof wallet.signTypedData === "function") {
      const signature = await wallet.signTypedData(typedData);
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("uniswapx-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    const driver = wallet && typeof wallet.driver === "function" ? wallet.driver() : null;
    if (driver && typeof driver.request === "function") {
      const from = address || (typeof wallet.address === "function" ? await wallet.address() : null);
      const signature = await driver.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] });
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("uniswapx-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    return refusal("uniswapx-sign-failed", { why: "no-wallet" });
  } catch (error) {
    return refusal("uniswapx-sign-failed", { why: String((error && error.code) || (error && error.message) || error) });
  }
}

/**
 * PUBLISH THE SIGNED ORDER. POST {signature, quote, routing} to the Uniswap Trading API's /order ("Create a gasless
 * order"), with the API key in `x-api-key` (Trading API OpenAPI). The `quote` is the object the host returned from
 * POST /quote - this provider does not fabricate it, and the cosigner is Uniswap Labs' (see the header). With no key
 * it refuses by name ("uniswapx-no-api-key"); with no submitter URL it refuses with "uniswapx-no-submitter". The
 * endpoint is NEVER guessed.
 */
export async function submitUniswapxOrder({ quote = null, signature = null, routing = "DUTCH_V2", apiKey = null, fetchImpl = null, timeoutMs = 20_000, base = null, tradingApi = UNISWAPX_TRADING_API } = {}) {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("uniswapx-bad-order", { field: "signature" });
  if (!quote || typeof quote !== "object") return refusal("uniswapx-bad-order", { field: "quote" });
  const target = base ? String(base) : (tradingApi ? String(tradingApi) : null);
  if (!target) return refusal("uniswapx-no-submitter", { field: "tradingApi" });
  if (typeof apiKey !== "string" || apiKey === "") return refusal("uniswapx-no-api-key", { field: "apiKey" });
  const http = createHttp({ apiBase: target, fetchImpl, timeoutMs });
  const body = JSON.stringify({ signature, quote, routing });
  let res;
  try {
    res = await http.tryJson(UNISWAPX_SUBMIT_PATH, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey }, body });
  } catch (error) {
    return refusal("uniswapx-unreachable", { why: String((error && error.params && error.params.why) || (error && error.code) || error) });
  }
  if (!res || typeof res.ok !== "boolean") return refusal("uniswapx-bad-response", { where: "submit" });
  if (!res.ok) return refusal("uniswapx-refused", { status: res.status, stage: "submit" });
  const data = res.body && typeof res.body === "object" ? res.body : null;
  if (!data || typeof data.orderId !== "string" || data.orderId === "") return refusal("uniswapx-bad-response", { where: "submit", field: "orderId" });
  const status = data.orderStatus;
  if (typeof status !== "string" || !UNISWAPX_STATUSES.includes(status)) return refusal("uniswapx-bad-response", { where: "submit", field: "orderStatus" });
  return { ok: true, orderId: data.orderId, orderStatus: status, requestId: typeof data.requestId === "string" ? data.requestId : null };
}

/**
 * READ ONE ORDER by its hash. GET /orders?orderHash=<hash> -> { orders: [ ... ] }. The entry's `orderStatus` must be
 * a known status word (else "uniswapx-bad-response"); an empty list means the service does not know the order
 * ("uniswapx-order-unknown") - never silence, never null.
 */
export async function uniswapxOrderStatus({ orderHash, chainId = null, fetchImpl = null, timeoutMs = 20_000, api = null } = {}) {
  const chain = Number(chainId);
  const base = api ? String(api) : (Number.isFinite(chain) ? uniswapxOrderbook(chain) : null);
  if (!base) return refusal("uniswapx-unknown-network", { chainId: Number.isFinite(chain) ? chain : null });
  if (!isHash(orderHash)) return refusal("uniswapx-bad-order", { field: "orderHash" });
  const http = createHttp({ apiBase: base, fetchImpl, timeoutMs });
  let res;
  try {
    res = await http.tryJson(UNISWAPX_ORDER_PATH + "?orderHash=" + orderHash);
  } catch (error) {
    return refusal("uniswapx-unreachable", { why: String((error && error.params && error.params.why) || (error && error.code) || error) });
  }
  if (!res || typeof res.ok !== "boolean") return refusal("uniswapx-bad-response", { where: "orders" });
  if (!res.ok) return refusal("uniswapx-refused", { status: res.status, stage: "orders" });
  const orders = res.body && res.body.orders;
  if (!Array.isArray(orders)) return refusal("uniswapx-bad-response", { where: "orders" });
  const found = orders.find((o) => o && String(o.orderHash || "").toLowerCase() === String(orderHash).toLowerCase()) || orders[0] || null;
  if (!found) return refusal("uniswapx-order-unknown", { orderHash });
  const status = found.orderStatus;
  if (typeof status !== "string" || !UNISWAPX_STATUSES.includes(status)) return refusal("uniswapx-bad-response", { where: "orderStatus", got: typeof status === "string" ? status : null });
  return { ok: true, status, order: found };
}

/**
 * WHAT ENDS AN ASYNCHRONOUS PROVIDER'S EXECUTION - poll the order service until the order is settled or finally
 * dead, with a timeout. Returns:
 *   { ok: true, done: true, settled: true,  status: "filled" }                                    - the swap settled;
 *   { ok: true, done: true, settled: false, status: "expired" | "error" | "cancelled" | ... }      - finally dead;
 *   { ok: false, code: "uniswapx-not-settled" | "uniswapx-unreachable" | ... }                     - a NAMED refusal.
 * "Not settled in time" is its OWN code: "we did not wait long enough" is a state of the order, not a breakdown.
 * The clock and the sleep are injectable so the wait is testable without real time.
 */
export async function uniswapxSettled(request = {}, deps = {}) {
  const { orderHash, chainId = null } = request;
  if (!isHash(orderHash)) return refusal("uniswapx-bad-order", { field: "orderHash" });
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : 5_000;
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : 300_000;
  const startedAt = now();
  let lastStatus = null;
  for (;;) {
    const read = await uniswapxOrderStatus({ orderHash, chainId, fetchImpl: deps.fetchImpl, timeoutMs: deps.requestTimeoutMs, api: deps.api });
    if (!read.ok) return read; // unreachable / bad-response / unknown: a named refusal, not silence
    lastStatus = read.status;
    if (UNISWAPX_FINAL_STATUSES.includes(lastStatus)) {
      return { ok: true, done: true, settled: lastStatus === UNISWAPX_SETTLED_STATUS, status: lastStatus, orderHash };
    }
    if (now() - startedAt >= timeoutMs) return refusal("uniswapx-not-settled", { orderHash, status: lastStatus, waitedMs: now() - startedAt });
    await sleep(pollMs);
  }
}

/**
 * THE SHARED PRE-SIGNATURE GUARDS, APPLIED TO THIS PROVIDER. The same guard functions the synchronous DEX leg and the
 * other two providers use (engine.dex.priceGateVerdict, engine.dex.dexLegVerdict, engine.guards.allowanceVerdict),
 * composed by the same summary guard (engine.guards.signingGateVerdict). Pure - no network, no wallet.
 */
export function uniswapxGate({
  order = null, requiredOutWei = null, tokenUsd = null, referenceNativeUsd = null, tolerated = false, gates = null,
  sellDecimals = null, buyDecimals = null, buySymbol = null, allowanceWei = null, allowanceConsent = false,
  tokenIsNative = false, symbol = null, decimals = null,
} = {}) {
  if (!order) return { ok: false, blocked: true, reason: "uniswapx-no-order", checks: [] };
  const output = Array.isArray(order.baseOutputs) && order.baseOutputs.length ? order.baseOutputs[0] : null;
  const amountOut = output ? output.endAmount : null;
  const price = engine.dex.priceGateVerdict({
    amountInWei: order.baseInputEndAmount, amountOutWei: amountOut,
    inDecimals: sellDecimals, outDecimals: buyDecimals,
    tokenUsd: Number(tokenUsd) > 0 ? Number(tokenUsd) : null,
    referenceUsd: Number(referenceNativeUsd) > 0 ? Number(referenceNativeUsd) : null,
    stableSteps: [], tolerated: Boolean(tolerated), gates,
  });
  const leg = { ok: true, amountOutWei: amountOut === null ? null : String(amountOut), price, wrapped: { symbol: buySymbol, decimals: buyDecimals } };
  const coverage = engine.dex.dexLegVerdict(leg, requiredOutWei);
  const coverageCheck = {
    ok: !coverage.blocked, checked: coverage.kind !== "unchecked" && coverage.kind !== "unquoted",
    blocks: coverage.blocked === true, kind: coverage.kind, reason: coverage.reason,
  };
  const allowance = engine.guards.allowanceVerdict({
    tokenIsNative, allowanceWei, amountWei: order.baseInputEndAmount,
    consent: allowanceConsent === true, symbol, decimals: Number.isFinite(Number(decimals)) ? Number(decimals) : 18,
  });
  const gate = engine.guards.signingGateVerdict([coverageCheck, allowance]);
  return { ...gate, price, coverage, allowance };
}

// THE PROVIDER, AS THE REGISTRY EXPECTS IT: id, kind, shape and, for "async", what ends execution (settled).
export const uniswapxProvider = Object.freeze({
  id: "uniswapx",
  kind: "uniswapx",
  venue: UNISWAPX_VENUE,
  shape: ASYNC,
  // WHAT IT SETTLES: native coin. An UniswapX output token may be the NATIVE sentinel address(0)
  // (uniswapx-spec.mjs), so this provider can carry a native need ALL THE WAY - it is a native leg of a composed
  // route, or a single route on its own.
  settles: "native",
  networks: UNISWAPX_NETWORKS,
  settlement: UNISWAPX_NETWORKS[1].reactor,
  permit2: UNISWAPX_PERMIT2,
  nativeToken: UNISWAPX_NATIVE,
  orderFields: UNISWAPX_ORDER_FIELDS,
  plan: uniswapxPlan,
  settled: uniswapxSettled,
  buildIntent: buildUniswapxIntent,
  sign: uniswapxSignOrder,
  submit: submitUniswapxOrder,
  status: uniswapxOrderStatus,
  gate: uniswapxGate,
});
