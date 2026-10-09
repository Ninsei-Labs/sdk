// COWSWAP - THE FIRST CONCRETE ASYNCHRONOUS ROUTE PROVIDER.
//
// WHAT IT IS. CoWSwap is an intent auction: the person signs an EIP-712 intent (an "order"), the order goes to a
// public order book, and solvers settle it LATER as a separate transaction someone else sends. So its shape is
// "async" - there is no single transaction that swaps and funds the escrow - and its execution ends when the order
// book reports the order SETTLED (fulfilled), or finally dead (cancelled / expired). `settled(request, deps)` below
// is that "what ends its execution", and the seam refuses an async provider that cannot name it.
//
// EVERY EXTERNAL FACT IS PINNED TO ITS SOURCE:
//   * the order book base URLs (https://api.cow.fi/<slug>) - the order book OpenAPI `servers` list,
//     github.com/cowprotocol/services, crates/orderbook/openapi.yml (and docs.cow.fi "Order book API");
//   * POST /api/v1/orders  ->  201 with the order UID (a 56-byte hex string) - the same OpenAPI (createOrder);
//   * GET  /api/v1/orders/{UID}  ->  the order, with `status` one of presignaturePending | open | fulfilled |
//     cancelled | expired - the same OpenAPI (OrderStatus enum, getOrder);
//   * POST body fields (sellToken, buyToken, receiver, sellAmount, buyAmount, validTo, appData, feeAmount, kind,
//     partiallyFillable, sellTokenBalance, buyTokenBalance, signingScheme, signature, from) - createOrder and the
//     OrderCreation schema (docs.cow.fi, API integration; the per-endpoint docs mirror the OpenAPI);
//   * the settlement contract and the domain - cow-spec.mjs (GPv2Settlement / GPv2Signing sources).
//
// THE SHARED PRE-SIGNATURE GUARDS STAY ON FOR THIS PROVIDER TOO (cowGate): the price is not the market, the amount
// is covered, the token allowance - the SAME guard functions the synchronous DEX leg uses. An external, asynchronous
// route must not become a hole in the guards.
//
// NO NEW DEPENDENCY: the typed data is built by cow-spec.mjs (this repository's own EIP-712), signing goes through
// the wallet adapter / the repository's signer, and the transport is the repository's own createHttp.
import { ASYNC } from "./shape.mjs";
import {
  COW_SETTLEMENT, COW_BUY_ETH_ADDRESS, COW_ORDER_FIELDS,
  cowOrderMissingFields, cowOrderDigestHex, cowOrderUid, cowOrderTypedData,
} from "./cow-spec.mjs";
import { createHttp } from "../http.mjs";
import * as engine from "../engine.mjs";

// THE NETWORKS WHERE COWSWAP RUNS. Keyed by EVM chainId; the base URL comes from the order book OpenAPI `servers`
// list. A network absent here is a NAMED refusal ("cow-unknown-network"), never a guess at an endpoint.
// The settlement contract is the same on every one of them (see cow-spec.mjs).
export const COW_NETWORKS = Object.freeze({
  1: { slug: "mainnet", orderbook: "https://api.cow.fi/mainnet" },
  100: { slug: "xdai", orderbook: "https://api.cow.fi/xdai" },
  42161: { slug: "arbitrum_one", orderbook: "https://api.cow.fi/arbitrum_one" },
  8453: { slug: "base", orderbook: "https://api.cow.fi/base" },
  56: { slug: "bnb", orderbook: "https://api.cow.fi/bnb" },
  11155111: { slug: "sepolia", orderbook: "https://api.cow.fi/sepolia" },
});

// THE STATUS VOCABULARY OF THE ORDER BOOK (OpenAPI: OrderStatus). A status outside this set is NOT "probably fine":
// it means the answer is not the shape we know, and `cowOrderStatus` refuses with "cow-bad-response".
export const COW_STATUSES = ["presignaturePending", "open", "fulfilled", "cancelled", "expired"];
export const COW_FINAL_STATUSES = ["fulfilled", "cancelled", "expired"];
export const COW_SETTLED_STATUS = "fulfilled";
export const COW_OPEN_STATUSES = ["presignaturePending", "open"];

// THE NAMED REFUSALS OF THIS PROVIDER. Every one of them is a VALUE ({ ok: false, code }), never silence and never
// null: a caller must always be able to tell "unreachable" from "refused" from "not settled yet".
export const COW_REFUSAL_CODES = [
  "cow-unknown-network", // the chain has no order book here
  "cow-bad-order",       // the order is incomplete or malformed - nothing to sign
  "cow-sign-failed",     // the wallet did not produce a signature
  "cow-unreachable",     // no answer from the order book (connection or timeout)
  "cow-order-unknown",   // the order book answered 404: no such order
  "cow-refused",         // the order book answered and did not accept (it carries the status and its reason)
  "cow-bad-response",    // the answer is not the shape we know
  "cow-not-settled",     // the order stayed open until the timeout - "not yet", not "broken"
];

const refusal = (code, params = {}) => ({ ok: false, code, params });

/** The order book base URL for a chain, or null. */
export const cowOrderbook = (chainId) => {
  const n = COW_NETWORKS[Number(chainId)];
  return n ? n.orderbook : null;
};

const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
const isBytes32 = (v) => /^(0x)?[0-9a-fA-F]{64}$/.test(String(v || ""));

/**
 * THE INTENT: from what the person gives, build the order, its EIP-712 typed data, its digest and its UID.
 * Returns { ok: true, order, typedData, digest, uid, owner } or a named refusal. Pure - no network, no wallet.
 */
export function buildCowIntent(request = {}) {
  const chainId = Number(request.chainId);
  if (cowOrderbook(chainId) === null) return { ...refusal("cow-unknown-network", { chainId: Number.isFinite(chainId) ? chainId : null }), known: Object.keys(COW_NETWORKS).map(Number) };
  const owner = request.owner;
  const receiver = request.receiver === undefined || request.receiver === null ? owner : request.receiver;
  const order = {
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    receiver: receiver || owner,
    sellAmount: request.sellAmountWei,
    buyAmount: request.buyAmountWei,
    validTo: request.validTo,
    appData: request.appData === undefined || request.appData === null ? "0x" + "00".repeat(32) : request.appData,
    feeAmount: request.feeAmountWei === undefined || request.feeAmountWei === null ? "0" : request.feeAmountWei,
    kind: request.kind === undefined || request.kind === null ? "sell" : request.kind,
    partiallyFillable: request.partiallyFillable === undefined || request.partiallyFillable === null ? false : request.partiallyFillable,
    sellTokenBalance: request.sellTokenBalance === undefined || request.sellTokenBalance === null ? "erc20" : request.sellTokenBalance,
    buyTokenBalance: request.buyTokenBalance === undefined || request.buyTokenBalance === null ? "erc20" : request.buyTokenBalance,
  };
  const missing = cowOrderMissingFields(order);
  if (!isAddress(owner)) missing.push("owner");
  if (!isBytes32(order.appData)) missing.push("appData");
  if (!isAddress(order.sellToken) || !isAddress(order.buyToken) || !isAddress(order.receiver)) missing.push("token");
  if (missing.length) return refusal("cow-bad-order", { missing: [...new Set(missing)] });
  try {
    const digest = cowOrderDigestHex({ order, chainId, settlement: COW_SETTLEMENT });
    const uid = cowOrderUid({ digest, owner, validTo: order.validTo });
    const typedData = cowOrderTypedData({ order, chainId, settlement: COW_SETTLEMENT });
    return { ok: true, chainId, owner, order, digest, uid, typedData };
  } catch (error) {
    // A malformed number/address inside the encoder: a NAMED refusal, not an exception escaping to the caller.
    return refusal("cow-bad-order", { why: String(error && error.message ? error.message : error) });
  }
}

// THE PAYLOAD THE ORDER BOOK EXPECTS (createOrder / OrderCreation). Every field is set EXPLICITLY - no relying on a
// server default that could contradict the signed order: the signed fields must travel exactly as signed.
export function cowOrderSubmission({ order, signature, owner, signingScheme = "eip712", from = null }) {
  return {
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: String(order.sellAmount),
    buyAmount: String(order.buyAmount),
    validTo: Number(order.validTo),
    appData: String(order.appData),
    feeAmount: String(order.feeAmount),
    kind: String(order.kind),
    partiallyFillable: Boolean(order.partiallyFillable),
    sellTokenBalance: String(order.sellTokenBalance),
    buyTokenBalance: String(order.buyTokenBalance),
    signingScheme,
    signature,
    from: from || owner,
  };
}

/**
 * THE PROVIDER'S PLAN. For an async provider the plan is the INTENT: the signed order that will be submitted, with
 * the typed data, the digest and the UID, plus what ends execution. Returns { ok, ... } - a value.
 */
export function cowPlan(request = {}) {
  const intent = buildCowIntent(request);
  if (!intent.ok) return intent;
  return {
    ok: true,
    provider: "cowswap",
    venue: "CoWSwap",
    shape: ASYNC,
    route: "cowswap",
    expectedOutWei: String(intent.order.buyAmount),
    order: intent.order,
    typedData: intent.typedData,
    digest: intent.digest,
    uid: intent.uid,
    owner: intent.owner,
    endsWith: { kind: "order-status", settledWhen: COW_SETTLED_STATUS, final: [...COW_FINAL_STATUSES], endpoint: "/api/v1/orders/{uid}" },
  };
}

/**
 * SIGN THE INTENT THROUGH THE WALLET ADAPTER. The adapter's own `signTypedData` is used when present (it wraps
 * eth_signTypedData_v4); otherwise the same call is made through the adapter's EIP-1193 driver, exactly as the page
 * does (www/js/evm/session.js, signTypedData). A wallet that will not sign is a NAMED refusal, not a crash.
 */
export async function cowSignOrder({ typedData, wallet, address = null } = {}) {
  if (!typedData || typeof typedData !== "object") return refusal("cow-bad-order", { field: "typedData" });
  try {
    if (wallet && typeof wallet.signTypedData === "function") {
      const signature = await wallet.signTypedData(typedData);
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("cow-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    const driver = wallet && typeof wallet.driver === "function" ? wallet.driver() : null;
    if (driver && typeof driver.request === "function") {
      const from = address || (typeof wallet.address === "function" ? await wallet.address() : null);
      const signature = await driver.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] });
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("cow-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    return refusal("cow-sign-failed", { why: "no-wallet" });
  } catch (error) {
    return refusal("cow-sign-failed", { why: String((error && error.code) || (error && error.message) || error) });
  }
}

/**
 * SUBMIT THE SIGNED ORDER. POST /api/v1/orders -> 201 with the order UID. The transport is the repository's own
 * createHttp (one place for the timeout and the status check). Every failure is one of the named refusals above.
 */
export async function submitCowOrder({ order, signature, owner, chainId, fetchImpl = null, timeoutMs = 20_000, signingScheme = "eip712", from = null } = {}) {
  const base = cowOrderbook(chainId);
  if (base === null) return refusal("cow-unknown-network", { chainId: Number(chainId) });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refusal("cow-bad-order", { field: "signature" });
  const http = createHttp({ apiBase: base, fetchImpl, timeoutMs });
  const body = JSON.stringify(cowOrderSubmission({ order, signature, owner, signingScheme, from }));
  let res;
  try {
    res = await http.tryJson("/api/v1/orders", { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (error) {
    return refusal("cow-unreachable", { why: String((error && error.params && error.params.why) || (error && error.code) || error) });
  }
  if (!res || typeof res.ok !== "boolean") return refusal("cow-bad-response", { where: "submit" });
  if (!res.ok) return refusal("cow-refused", { status: res.status, reason: res.body && res.body.errorType ? res.body.errorType : null });
  if (typeof res.body !== "string" || !/^0x[0-9a-fA-F]{112}$/.test(res.body)) return refusal("cow-bad-response", { where: "submit", got: typeof res.body });
  return { ok: true, uid: res.body };
}

/**
 * READ ONE ORDER. GET /api/v1/orders/{UID} -> the order, with `status`. A 404 is "cow-order-unknown"; a body whose
 * status is not a known status is "cow-bad-response" - never silence, never null.
 */
export async function cowOrderStatus({ uid, chainId, fetchImpl = null, timeoutMs = 20_000 } = {}) {
  const base = cowOrderbook(chainId);
  if (base === null) return refusal("cow-unknown-network", { chainId: Number(chainId) });
  if (typeof uid !== "string" || !/^0x[0-9a-fA-F]{112}$/.test(uid)) return refusal("cow-bad-order", { field: "uid" });
  const http = createHttp({ apiBase: base, fetchImpl, timeoutMs });
  let res;
  try {
    res = await http.tryJson("/api/v1/orders/" + uid);
  } catch (error) {
    return refusal("cow-unreachable", { why: String((error && error.params && error.params.why) || (error && error.code) || error) });
  }
  if (!res || typeof res.ok !== "boolean") return refusal("cow-bad-response", { where: "status" });
  if (res.status === 404) return refusal("cow-order-unknown", { uid });
  if (!res.ok) return refusal("cow-refused", { status: res.status });
  const status = res.body && res.body.status;
  if (typeof status !== "string" || !COW_STATUSES.includes(status)) return refusal("cow-bad-response", { where: "status", got: typeof status === "string" ? status : null });
  return { ok: true, status, order: res.body };
}

/**
 * WHAT ENDS AN ASYNCHRONOUS PROVIDER'S EXECUTION - poll the order book until the order is settled or finally dead,
 * with a timeout. Returns:
 *   { ok: true, done: true, settled: true,  status: "fulfilled" }             - the swap settled;
 *   { ok: true, done: true, settled: false, status: "cancelled" | "expired" } - the order is finally dead;
 *   { ok: false, code: "cow-not-settled" | "cow-unreachable" | "cow-bad-response" | ... } - a NAMED refusal.
 * "Not settled in time" is its OWN code: "we did not wait long enough" is a state of the order, not a breakdown.
 * The clock and the sleep are injectable so the wait is testable without real time.
 */
export async function cowSettled(request = {}, deps = {}) {
  const { uid, chainId } = request;
  if (typeof uid !== "string" || !/^0x[0-9a-fA-F]{112}$/.test(uid)) return refusal("cow-bad-order", { field: "uid" });
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : 5_000;
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : 300_000;
  const startedAt = now();
  let lastStatus = null;
  for (;;) {
    const read = await cowOrderStatus({ uid, chainId, fetchImpl: deps.fetchImpl, timeoutMs: deps.requestTimeoutMs });
    if (!read.ok) return read; // unreachable / bad-response / unknown: a named refusal, not silence
    lastStatus = read.status;
    if (COW_FINAL_STATUSES.includes(lastStatus)) {
      return { ok: true, done: true, settled: lastStatus === COW_SETTLED_STATUS, status: lastStatus, uid };
    }
    if (now() - startedAt >= timeoutMs) return refusal("cow-not-settled", { uid, status: lastStatus, waitedMs: now() - startedAt });
    await sleep(pollMs);
  }
}

/**
 * THE SHARED PRE-SIGNATURE GUARDS, APPLIED TO THIS PROVIDER. The same guard functions the synchronous DEX leg uses
 * (engine/evm/dex.js priceGateVerdict + dexLegVerdict for "the price is not the market" and "the amount is covered";
 * engine/core/preSignGuards.js allowanceVerdict for "the token is allowed"), composed by the same summary guard
 * (signingGateVerdict). A provider that skipped them would be a hole in the guards. Pure - no network, no wallet.
 */
export function cowGate({
  order = null, requiredOutWei = null, tokenUsd = null, referenceNativeUsd = null, tolerated = false, gates = null,
  sellDecimals = null, buyDecimals = null, buySymbol = null, allowanceWei = null, allowanceConsent = false,
  tokenIsNative = false, symbol = null, decimals = null,
} = {}) {
  if (!order) return { ok: false, blocked: true, reason: "cow-no-order", checks: [] };
  const price = engine.dex.priceGateVerdict({
    amountInWei: order.sellAmount, amountOutWei: order.buyAmount,
    inDecimals: sellDecimals, outDecimals: buyDecimals,
    tokenUsd: Number(tokenUsd) > 0 ? Number(tokenUsd) : null,
    referenceUsd: Number(referenceNativeUsd) > 0 ? Number(referenceNativeUsd) : null,
    stableSteps: [], tolerated: Boolean(tolerated), gates,
  });
  const leg = { ok: true, amountOutWei: String(order.buyAmount), price, wrapped: { symbol: buySymbol, decimals: buyDecimals } };
  const coverage = engine.dex.dexLegVerdict(leg, requiredOutWei);
  const coverageCheck = {
    ok: !coverage.blocked, checked: coverage.kind !== "unchecked" && coverage.kind !== "unquoted",
    blocks: coverage.blocked === true, kind: coverage.kind, reason: coverage.reason,
  };
  const allowance = engine.guards.allowanceVerdict({
    tokenIsNative, allowanceWei, amountWei: order.sellAmount,
    consent: allowanceConsent === true, symbol, decimals: Number.isFinite(Number(decimals)) ? Number(decimals) : 18,
  });
  const gate = engine.guards.signingGateVerdict([coverageCheck, allowance]);
  return { ...gate, price, coverage, allowance };
}

// THE PROVIDER, AS THE REGISTRY EXPECTS IT: id, kind, shape and, for "async", what ends execution (settled).
export const cowProvider = Object.freeze({
  id: "cowswap",
  kind: "cow",
  venue: "CoWSwap",
  shape: ASYNC,
  networks: COW_NETWORKS,
  settlement: COW_SETTLEMENT,
  buyEthAddress: COW_BUY_ETH_ADDRESS,
  orderFields: COW_ORDER_FIELDS,
  plan: cowPlan,
  settled: cowSettled,
  buildIntent: buildCowIntent,
  sign: cowSignOrder,
  submit: submitCowOrder,
  status: cowOrderStatus,
  gate: cowGate,
});
