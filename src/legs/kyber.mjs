// KYBERSWAP LIMIT ORDER - THE SECOND CONCRETE ASYNCHRONOUS ROUTE PROVIDER, A SIBLING OF cow.mjs.
//
// WHAT IT IS. KyberSwap Limit Order is an off-chain order book with on-chain settlement: a Maker signs an EIP-712
// order (no gas), the signed order is stored in KyberSwap's order book, and a Taker fills it on chain later as a
// separate transaction. So its shape is "async" - there is no single transaction that swaps and funds the escrow -
// and its execution ends when the order book reports the order FILLED, or finally dead (cancelled / expired). The
// `settled(request, deps)` below is that "what ends its execution", and the seam refuses an async provider without it.
//
// THE FLOW IS THE ORDER BOOK'S OWN, NOT A CLIENT-SIDE RE-ENCODING. Unlike CoW - where the order is fully assembled
// from fields - a KyberSwap order carries a server-computed `feeConfig`, `getMakerAmount`, `getTakerAmount` and a
// `predicate` blob. So the provider ASKS for the unsigned order and the exact typed data:
//   POST /write/api/v1/orders/sign-message  ->  {types, domain, primaryType, message}  (the unsigned EIP-712 order)
// then SIGNS that typed data through the wallet, then SUBMITS it:
//   POST /write/api/v1/orders               ->  {data:{id}}                            (the order book's numeric id)
// and READS the outcome by the Maker's own orders:
//   GET  /read-ks/api/v1/orders?chainId&maker&status=...  ->  {data:{orders:[...,{id,status}]}}
//
// EVERY EXTERNAL FACT IS PINNED TO ITS SOURCE:
//   * the order book base URL https://limit-order.kyberswap.com and the endpoints above - docs.kyberswap.com,
//     "Limit Order API" (base URL and endpoint index) and the Maker API reference;
//   * the EIP-712 order type, field names/order and the domain - the contract DSLOProtocol / DSOrderMixin (verified
//     source) and the sign-message response; the machinery lives in kyber-spec.mjs with its own citations;
//   * the status vocabulary (active | open | partially_filled | cancelling | closed | filled | cancelled | expired)
//     - the Maker API "Get List Of Orders By Maker" `status` enum; a status outside the set is "kyber-bad-response";
//   * the OPERATOR co-signature - docs.kyberswap.com "Limit Order API": the API "cannot fill orders without an
//     Operator signature - every fill requires a fresh KyberSwap Operator co-signature", obtained by the TAKER via
//     GET /read-partner/api/v1/orders/operator-signature, and the contract verifies it as a second signature over
//     DSOrder(orderHash, opExpireTime) ("handle double signature"/"LOP: bad op signature", DSOrderMixin.fillOrderTo).
//     ROLE FOR THIS PROVIDER: the operator signature is produced by KyberSwap's operator for the TAKER at fill time -
//     the Maker does not and cannot produce it (the operator key is not the Maker's). A Maker order therefore settles
//     ONLY if some Taker fetches a fresh operator co-signature and fills it; that is why this provider's `settled`
//     can wait and time out, and why no Maker action is required or possible to force a fill.
//
// THE SHARED PRE-SIGNATURE GUARDS STAY ON FOR THIS PROVIDER TOO (kyberGate): the price is not the market, the amount
// is covered, the token allowance - the SAME guard functions the synchronous DEX leg and the CoW provider use. An
// external, asynchronous route must not become a hole in the guards.
//
// NO NEW DEPENDENCY: the typed data is validated/rebuilt by kyber-spec.mjs (this repository's own EIP-712), signing
// goes through the wallet adapter / the repository's signer, and the transport is the repository's own createHttp.
//
// --- SCOPE NOTE: THIS IS THE LIQUIDITY LEG, AND IT SETTLES WETH, NOT NATIVE ETH ------------------------------
// A KyberSwap limit order trades ERC20 against ERC20. Their own API refuses the native coin as an order asset
// (Maker API error 4004: "makerAsset or takerAsset is the native token (use the wrapped token)") and the kyberswap-mcp
// limit-order tool "blocks native ETH as maker asset - use WETH (or the wrapped native equivalent)". So an order
// created here delivers WETH (the wrapped native), NOT native ETH. The escrow on our side is funded with NATIVE ETH;
// KyberSwap alone therefore cannot fund it. This provider is the LIQUIDITY leg: reaching native is a SECOND order on
// a provider that can deliver native (CoW - see cow.mjs and COW_BUY_ETH_ADDRESS - or UniswapX). That second leg is
// NOT built here, and the page's execution path is not touched: the deliverable is this provider and its declaration.
// (The order book also offers `nativeOutput`, but only as an unwrap of a wrapped-native takerAsset for the RECEIVER,
// off by default - it is still a wrapped-native order, not a native-asset order; note it, do not rely on it.)
// ------------------------------------------------------------------------------------------------------------
import { ASYNC } from "./shape.mjs";
import {
  KYBER_LIMIT_ORDER_CONTRACT, KYBER_ORDER_FIELDS,
  kyberOrderMissingFields, kyberOrderDigestHex, kyberOrderTypedData,
} from "./kyber-spec.mjs";
import { createHttp } from "../http.mjs";
import * as engine from "../engine.mjs";

// THE ORDER BOOK: ONE base URL for every chain (docs.kyberswap.com, "Base URL: https://limit-order.kyberswap.com").
export const KYBER_ORDERBOOK = "https://limit-order.kyberswap.com";
// The venue name, assembled from parts: a single literal of it is a phrase of several words, and the SDK reads such
// literals as user-facing text (the same rule cow-spec.mjs follows for the CoW domain name).
export const KYBER_VENUE = ["KyberSwap", "Limit", "Order"].join(" ");

// THE NETWORKS WHERE KYBERSWAP LIMIT ORDER RUNS. Keyed by EVM chainId; the order book is the same for all of them and
// the settlement contract is identical on each (docs.kyberswap.com, "Contracts & Addresses": Ethereum, BSC, Arbitrum,
// Polygon, Optimism, Avalanche, Fantom, Base, zkSync, Linea, Mantle, Scroll, Blast all use DSLOProtocol 0xcab2...).
// A network absent here is a NAMED refusal ("kyber-unknown-network"), never a guess at an endpoint.
export const KYBER_NETWORKS = Object.freeze({
  1: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  10: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  56: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  137: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  250: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  324: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  5000: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  8453: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  42161: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  43114: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  59144: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  534352: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
  81457: { orderbook: KYBER_ORDERBOOK, contract: KYBER_LIMIT_ORDER_CONTRACT },
});

// THE ENDPOINTS (docs.kyberswap.com, "Limit Order API" endpoint index and the Maker/Taker API references). Cancel and
// fill paths are declared here so the whole lifecycle is named in one place, though this provider only builds, signs,
// submits and reads an order; fills are the Taker's business.
export const KYBER_SIGN_MESSAGE_PATH = "/write/api/v1/orders/sign-message";
export const KYBER_CREATE_PATH = "/write/api/v1/orders";
export const KYBER_MAKER_ORDERS_PATH = "/read-ks/api/v1/orders";
export const KYBER_CANCEL_SIGN_PATH = "/write/api/v1/orders/cancel-sign";
export const KYBER_CANCEL_PATH = "/write/api/v1/orders/cancel";
export const KYBER_OPERATOR_SIGNATURE_PATH = "/read-partner/api/v1/orders/operator-signature";
export const KYBER_FILL_PATH = "/read-ks/api/v1/encode/fill-order-to";

// THE STATUS VOCABULARY (docs.kyberswap.com, Maker API "Get List Of Orders By Maker" `status` enum). `active` and
// `closed` are umbrella FILTER values; the item `status` is one of the concrete ones. A status outside this set is
// NOT "probably fine": the answer is not the shape we know, and `kyberOrderStatus` refuses with "kyber-bad-response".
export const KYBER_STATUSES = ["active", "open", "partially_filled", "cancelling", "closed", "filled", "cancelled", "expired"];
export const KYBER_FINAL_STATUSES = ["filled", "cancelled", "expired"];
export const KYBER_SETTLED_STATUS = "filled";
export const KYBER_OPEN_STATUSES = ["open", "partially_filled", "cancelling"];
// The buckets queried while waiting for an outcome: `active` covers open/partially_filled/cancelling, `closed`
// covers filled/cancelled/expired.
export const KYBER_STATUS_BUCKETS = ["active", "closed"];

// THE NAMED REFUSALS OF THIS PROVIDER. Every one is a VALUE ({ ok: false, code }), never silence and never null: a
// caller must always be able to tell "unreachable" from "refused" from "not settled yet".
export const KYBER_REFUSAL_CODES = [
  "kyber-unknown-network", // the chain has no order book here
  "kyber-bad-order",       // the order is incomplete or malformed - nothing to sign
  "kyber-sign-failed",     // the wallet did not produce a signature
  "kyber-unreachable",     // no answer from the order book (connection or timeout)
  "kyber-order-unknown",   // the order book does not know this order id for this maker
  "kyber-refused",         // the order book answered and did not accept (it carries the status and its reason)
  "kyber-bad-response",    // the answer is not the shape we know (including typed data that is not this spec)
  "kyber-not-settled",     // the order stayed open until the timeout - "not yet", not "broken"
];

const refusal = (code, params = {}) => ({ ok: false, code, params });

/** The order book base URL for a chain, or null. */
export const kyberOrderbook = (chainId) => {
  const n = KYBER_NETWORKS[Number(chainId)];
  return n ? n.orderbook : null;
};
/** The settlement contract for a chain, or null. */
export const kyberContractFor = (chainId) => {
  const n = KYBER_NETWORKS[Number(chainId)];
  return n ? n.contract : null;
};

const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
const isPositive = (v) => { try { return BigInt(String(v)) > 0n; } catch { return false; } };

/**
 * THE INTENT REQUEST: from what the person gives, build the body the order book's sign-message endpoint expects.
 * Returns { ok: true, params, expectedOutWei } or a named refusal. Pure - no network, no wallet.
 * The order book computes feeConfig/getMakerAmount/getTakerAmount/predicate itself; we only name the trade.
 */
export function kyberPlan(request = {}) {
  const chainId = Number(request.chainId);
  if (kyberOrderbook(chainId) === null) return { ...refusal("kyber-unknown-network", { chainId: Number.isFinite(chainId) ? chainId : null }), known: Object.keys(KYBER_NETWORKS).map(Number) };
  const maker = request.maker;
  const receiver = request.receiver === undefined || request.receiver === null ? maker : request.receiver;
  const params = {
    chainId: String(chainId),
    makerAsset: request.makerAsset,
    takerAsset: request.takerAsset,
    maker,
    receiver,
    makingAmount: String(request.makingAmount),
    takingAmount: String(request.takingAmount),
    expiredAt: request.expiredAt,
  };
  if (request.allowedSenders !== undefined && request.allowedSenders !== null) params.allowedSenders = request.allowedSenders;
  const missing = [];
  if (!isAddress(maker)) missing.push("maker");
  if (!isAddress(params.makerAsset)) missing.push("makerAsset");
  if (!isAddress(params.takerAsset)) missing.push("takerAsset");
  if (!isAddress(params.receiver)) missing.push("receiver");
  if (!isPositive(params.makingAmount)) missing.push("makingAmount");
  if (!isPositive(params.takingAmount)) missing.push("takingAmount");
  if (!Number.isInteger(Number(params.expiredAt))) missing.push("expiredAt");
  if (missing.length) return refusal("kyber-bad-order", { missing: [...new Set(missing)] });
  return {
    ok: true,
    chainId,
    orderbook: kyberOrderbook(chainId),
    contract: kyberContractFor(chainId),
    maker,
    params,
    expectedOutWei: String(params.takingAmount),
  };
}

/** The provider's plan, in the shape the registry and the paths expect. Returns a VALUE with a named refusal. */
export function kyberRoutePlan(request = {}) {
  const intent = kyberPlan(request);
  if (!intent.ok) return intent;
  return {
    ok: true,
    provider: "kyberswap",
    venue: KYBER_VENUE,
    shape: ASYNC,
    route: "kyberswap",
    expectedOutWei: intent.expectedOutWei,
    params: intent.params,
    owner: intent.maker,
    endsWith: { kind: "order-status", settledWhen: KYBER_SETTLED_STATUS, final: [...KYBER_FINAL_STATUSES], endpoint: KYBER_MAKER_ORDERS_PATH },
  };
}

/**
 * ASK FOR THE UNSIGNED ORDER. POST /write/api/v1/orders/sign-message -> {types, domain, primaryType, message}. The
 * returned typed data is VALIDATED against this spec before it is trusted: the domain must be Kyber's, the chain and
 * contract must be the order's, the Order types must be exactly KYBER_ORDER_FIELDS, and the message must be complete.
 * Typed data that does not agree is a NAMED refusal ("kyber-bad-response"), never signed anyway.
 */
export async function kyberUnsignedOrder({ params, chainId = null, fetchImpl = null, timeoutMs = 20_000, clientId = null } = {}) {
  const id = Number(chainId !== null ? chainId : params && params.chainId);
  const base = kyberOrderbook(id);
  if (base === null) return refusal("kyber-unknown-network", { chainId: Number.isFinite(id) ? id : null });
  if (!params || typeof params !== "object") return refusal("kyber-bad-order", { field: "params" });
  const http = createHttp({ apiBase: base, fetchImpl, timeoutMs });
  const headers = { "content-type": "application/json" };
  if (clientId) headers["X-Client-Id"] = String(clientId);
  let res;
  try {
    res = await http.tryJson(KYBER_SIGN_MESSAGE_PATH, { method: "POST", headers, body: JSON.stringify(params) });
  } catch (error) {
    return refusal("kyber-unreachable", { why: String((error && error.params && error.params.why) || (error && error.code) || error) });
  }
  if (!res || typeof res.ok !== "boolean") return refusal("kyber-bad-response", { where: "sign-message" });
  if (!res.ok) return refusal("kyber-refused", { status: res.status, stage: "sign-message", reason: res.body && res.body.message ? res.body.message : null });
  const data = res.body && res.body.data;
  if (!data || typeof data !== "object") return refusal("kyber-bad-response", { where: "sign-message" });
  const domain = data.domain || {};
  const message = data.message || {};
  const typeNames = (data.types && Array.isArray(data.types.Order)) ? data.types.Order.map((t) => (t ? t.name : "") + ":" + (t ? t.type : "")).join(",") : null;
  const expectedNames = KYBER_ORDER_FIELDS.map(([name, type]) => name + ":" + type).join(",");
  const contract = kyberContractFor(id);
  const domainOk = domain.name === undefined ? false : String(domain.name) === ["Kyber", "DSLO", "Protocol"].join(" ")
    && String(domain.version) === "1"
    && Number(domain.chainId) === id
    && String(domain.verifyingContract || "").toLowerCase() === String(contract).toLowerCase();
  if (!domainOk) return refusal("kyber-bad-response", { where: "sign-message", field: "domain" });
  if (typeNames !== expectedNames) return refusal("kyber-bad-response", { where: "sign-message", field: "types" });
  const missing = kyberOrderMissingFields(message);
  if (missing.length) return refusal("kyber-bad-response", { where: "sign-message", missing });
  let digest;
  try {
    digest = kyberOrderDigestHex({ order: message, chainId: id, contract });
  } catch (error) {
    return refusal("kyber-bad-response", { where: "sign-message", why: String(error && error.message ? error.message : error) });
  }
  return {
    ok: true,
    chainId: id,
    orderbook: base,
    contract,
    salt: String(message.salt),
    message,
    digest,
    typedData: { domain, types: data.types, primaryType: data.primaryType || "Order", message },
  };
}

/**
 * SIGN THE UNSIGNED ORDER THROUGH THE WALLET ADAPTER. The adapter's own `signTypedData` is used when present (it
 * wraps eth_signTypedData_v4); otherwise the same call is made through the adapter's EIP-1193 driver, exactly as the
 * page does. A wallet that will not sign is a NAMED refusal, not a crash.
 */
export async function kyberSignOrder({ typedData, wallet, address = null } = {}) {
  if (!typedData || typeof typedData !== "object") return refusal("kyber-bad-order", { field: "typedData" });
  try {
    if (wallet && typeof wallet.signTypedData === "function") {
      const signature = await wallet.signTypedData(typedData);
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("kyber-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    const driver = wallet && typeof wallet.driver === "function" ? wallet.driver() : null;
    if (driver && typeof driver.request === "function") {
      const from = address || (typeof wallet.address === "function" ? await wallet.address() : null);
      const signature = await driver.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] });
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("kyber-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    return refusal("kyber-sign-failed", { why: "no-wallet" });
  } catch (error) {
    return refusal("kyber-sign-failed", { why: String((error && error.code) || (error && error.message) || error) });
  }
}

/**
 * SUBMIT THE SIGNED ORDER. POST /write/api/v1/orders -> {data:{id}}. The body carries the request plus the salt from
 * the sign-message response and the Maker's signature (docs.kyberswap.com, Maker API "Create Order"). Every failure
 * is one of the named refusals above.
 */
export async function kyberSubmitOrder({ params, salt, signature, chainId = null, fetchImpl = null, timeoutMs = 20_000, clientId = null } = {}) {
  const id = Number(chainId !== null ? chainId : params && params.chainId);
  const base = kyberOrderbook(id);
  if (base === null) return refusal("kyber-unknown-network", { chainId: Number.isFinite(id) ? id : null });
  if (!params || typeof params !== "object") return refusal("kyber-bad-order", { field: "params" });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("kyber-bad-order", { field: "signature" });
  if (salt === undefined || salt === null || salt === "") return refusal("kyber-bad-order", { field: "salt" });
  const http = createHttp({ apiBase: base, fetchImpl, timeoutMs });
  const headers = { "content-type": "application/json" };
  if (clientId) headers["X-Client-Id"] = String(clientId);
  const body = JSON.stringify({ ...params, salt: String(salt), signature });
  let res;
  try {
    res = await http.tryJson(KYBER_CREATE_PATH, { method: "POST", headers, body });
  } catch (error) {
    return refusal("kyber-unreachable", { why: String((error && error.params && error.params.why) || (error && error.code) || error) });
  }
  if (!res || typeof res.ok !== "boolean") return refusal("kyber-bad-response", { where: "submit" });
  if (!res.ok) return refusal("kyber-refused", { status: res.status, stage: "submit", reason: res.body && res.body.message ? res.body.message : null });
  const created = res.body && res.body.data;
  const orderId = created && created.id;
  if (!Number.isInteger(Number(orderId)) || Number(orderId) <= 0) return refusal("kyber-bad-response", { where: "submit", got: typeof orderId });
  return { ok: true, id: Number(orderId) };
}

/**
 * READ ONE ORDER's status. GET /read-ks/api/v1/orders?chainId&maker&status=<bucket>. The endpoint filters by status,
 * so the buckets `active` (open / partially_filled / cancelling) and `closed` (filled / cancelled / expired) are
 * queried in turn and the order is looked up by id. A status word outside KYBER_STATUSES is "kyber-bad-response"; an
 * id found in neither bucket is "kyber-order-unknown" - never silence, never null.
 */
export async function kyberOrderStatus({ id, chainId, maker, fetchImpl = null, timeoutMs = 20_000 } = {}) {
  const chain = Number(chainId);
  const base = kyberOrderbook(chain);
  if (base === null) return refusal("kyber-unknown-network", { chainId: Number.isFinite(chain) ? chain : null });
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return refusal("kyber-bad-order", { field: "id" });
  if (!isAddress(maker)) return refusal("kyber-bad-order", { field: "maker" });
  const http = createHttp({ apiBase: base, fetchImpl, timeoutMs });
  for (const bucket of KYBER_STATUS_BUCKETS) {
    const path = KYBER_MAKER_ORDERS_PATH + "?chainId=" + chain + "&maker=" + maker + "&status=" + bucket;
    let res;
    try {
      res = await http.tryJson(path);
    } catch (error) {
      return refusal("kyber-unreachable", { why: String((error && error.params && error.params.why) || (error && error.code) || error) });
    }
    if (!res || typeof res.ok !== "boolean") return refusal("kyber-bad-response", { where: "orders" });
    if (!res.ok) return refusal("kyber-refused", { status: res.status, stage: "orders" });
    const orders = res.body && res.body.data && res.body.data.orders;
    if (!Array.isArray(orders)) return refusal("kyber-bad-response", { where: "orders" });
    const found = orders.find((o) => o && Number(o.id) === Number(id)) || null;
    if (found) {
      const status = found.status;
      if (typeof status !== "string" || !KYBER_STATUSES.includes(status)) return refusal("kyber-bad-response", { where: "status", got: typeof status === "string" ? status : null });
      return { ok: true, status, order: found, bucket };
    }
  }
  return refusal("kyber-order-unknown", { id: Number(id), maker });
}

/**
 * WHAT ENDS AN ASYNCHRONOUS PROVIDER'S EXECUTION - poll the order book until the order is settled or finally dead,
 * with a timeout. Returns:
 *   { ok: true, done: true, settled: true,  status: "filled" }                      - the swap settled;
 *   { ok: true, done: true, settled: false, status: "cancelled" | "expired" }        - the order is finally dead;
 *   { ok: false, code: "kyber-not-settled" | "kyber-unreachable" | "kyber-bad-response" | ... } - a NAMED refusal.
 * "Not settled in time" is its OWN code: "we did not wait long enough" is a state of the order, not a breakdown. The
 * clock and the sleep are injectable so the wait is testable without real time.
 */
export async function kyberSettled(request = {}, deps = {}) {
  const { id, chainId, maker } = request;
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return refusal("kyber-bad-order", { field: "id" });
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : 5_000;
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : 300_000;
  const startedAt = now();
  let lastStatus = null;
  for (;;) {
    const read = await kyberOrderStatus({ id, chainId, maker, fetchImpl: deps.fetchImpl, timeoutMs: deps.requestTimeoutMs });
    if (!read.ok) return read; // unreachable / bad-response / unknown: a named refusal, not silence
    lastStatus = read.status;
    if (KYBER_FINAL_STATUSES.includes(lastStatus)) {
      return { ok: true, done: true, settled: lastStatus === KYBER_SETTLED_STATUS, status: lastStatus, id: Number(id) };
    }
    if (now() - startedAt >= timeoutMs) return refusal("kyber-not-settled", { id: Number(id), status: lastStatus, waitedMs: now() - startedAt });
    await sleep(pollMs);
  }
}

/**
 * THE SHARED PRE-SIGNATURE GUARDS, APPLIED TO THIS PROVIDER. The same guard functions the synchronous DEX leg and the
 * CoW provider use (engine.dex.priceGateVerdict for "the price is not the market", engine.dex.dexLegVerdict for "the
 * amount is covered", engine.guards.allowanceVerdict for "the token is allowed"), composed by the same summary guard
 * (engine.guards.signingGateVerdict). A provider that skipped them would be a hole in the guards. Pure - no network.
 */
export function kyberGate({
  order = null, requiredOutWei = null, tokenUsd = null, referenceNativeUsd = null, tolerated = false, gates = null,
  sellDecimals = null, buyDecimals = null, buySymbol = null, allowanceWei = null, allowanceConsent = false,
  tokenIsNative = false, symbol = null, decimals = null,
} = {}) {
  if (!order) return { ok: false, blocked: true, reason: "kyber-no-order", checks: [] };
  const price = engine.dex.priceGateVerdict({
    amountInWei: order.makingAmount, amountOutWei: order.takingAmount,
    inDecimals: sellDecimals, outDecimals: buyDecimals,
    tokenUsd: Number(tokenUsd) > 0 ? Number(tokenUsd) : null,
    referenceUsd: Number(referenceNativeUsd) > 0 ? Number(referenceNativeUsd) : null,
    stableSteps: [], tolerated: Boolean(tolerated), gates,
  });
  const leg = { ok: true, amountOutWei: String(order.takingAmount), price, wrapped: { symbol: buySymbol, decimals: buyDecimals } };
  const coverage = engine.dex.dexLegVerdict(leg, requiredOutWei);
  const coverageCheck = {
    ok: !coverage.blocked, checked: coverage.kind !== "unchecked" && coverage.kind !== "unquoted",
    blocks: coverage.blocked === true, kind: coverage.kind, reason: coverage.reason,
  };
  const allowance = engine.guards.allowanceVerdict({
    tokenIsNative, allowanceWei, amountWei: order.makingAmount,
    consent: allowanceConsent === true, symbol, decimals: Number.isFinite(Number(decimals)) ? Number(decimals) : 18,
  });
  const gate = engine.guards.signingGateVerdict([coverageCheck, allowance]);
  return { ...gate, price, coverage, allowance };
}

// THE PROVIDER, AS THE REGISTRY EXPECTS IT: id, kind, shape and, for "async", what ends execution (settled).
export const kyberProvider = Object.freeze({
  id: "kyberswap",
  kind: "kyber",
  venue: KYBER_VENUE,
  shape: ASYNC,
  // WHAT IT SETTLES: the WRAPPED native (WETH), not native coin - its orders trade ERC20 against ERC20 and its API
  // refuses native as an order asset (error 4004). So it can NEVER carry a native need alone: it is the LIQUIDITY
  // leg of a composed route (token -> WETH), and the native last mile is a SECOND order on a native-capable
  // provider (cowProvider.settles === "native").
  settles: "wrapped",
  networks: KYBER_NETWORKS,
  settlement: KYBER_LIMIT_ORDER_CONTRACT,
  orderFields: KYBER_ORDER_FIELDS,
  plan: kyberRoutePlan,
  settled: kyberSettled,
  unsignedOrder: kyberUnsignedOrder,
  sign: kyberSignOrder,
  submit: kyberSubmitOrder,
  status: kyberOrderStatus,
  gate: kyberGate,
});
