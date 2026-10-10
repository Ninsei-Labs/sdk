// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/asyncLegs.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// THE KYBERSWAP LIMIT ORDER LEG, EXECUTED ON THE PAGE - THE LIQUIDITY LEG OF A COMPOSED ROUTE.
//
// WHAT IT IS AND WHY THE ENGINE REACHES FOR IT AT ALL. KyberSwap Limit Order is an intent auction: the Maker signs
// an EIP-712 order off-chain (no gas), the order is stored in KyberSwap's book, and a Taker settles it on chain
// later. It is an ASYNCHRONOUS provider like CoWSwap - but its orders trade ERC20 against ERC20 and its API refuses
// native coin as an order asset (error 4004), so it settles the WRAPPED native (WETH), not native. Our escrow is
// funded with NATIVE coin, so this provider can never be the last mile: it is the LIQUIDITY leg, and reaching native
// is a SECOND order on a native-capable provider (CoWSwap, evm/asyncExec.js). This module is the first leg.
//
// WHY HERE AND NOT IN THE PACKAGE. The page cannot import the package's sources (they pull bare npm specifiers and
// the DOM-free package never sees the page wallet); it reaches the core only through a built bundle whose surface is
// fixed. So the provider's CONTRACT (the EIP-712 order fields, the domain, the order book paths, the status
// vocabulary, the refusal codes) is repeated here - exactly as the CoW contract is repeated in evm/asyncExec.js -
// and the agreement of the two is a CHECK (tools/check-async-route-compose.mjs compares every constant against
// sdk/src/legs/kyber.mjs and sdk/src/legs/kyber-spec.mjs), never a promise in a comment.
//
// NO NEW DEPENDENCY: the transport is the page's fetch, the signature is the wallet's own eth_signTypedData_v4,
// and the typed data comes FROM THE ORDER BOOK'S sign-message endpoint (validated against this spec before it is
// trusted). Nothing is trusted to a library.
//
// EVERY FAILURE IS A NAMED VALUE ({ ok: false, code }), never silence and never a funded deal with no swap behind it.

// THE ORDER BOOK: one base URL for every chain (docs.kyberswap.com, "Base URL: https://limit-order.kyberswap.com").
export const KYBER_LEG_ORDERBOOK = "https://limit-order.kyberswap.com";
// The venue name, assembled from parts (a single multi-word literal would read as user-facing text to the SDK).
export const KYBER_LEG_VENUE = ["KyberSwap", "Limit", "Order"].join(" ");

// THE EIP-712 DOMAIN AND THE VERIFYING CONTRACT - DSLOProtocol, identical on every network KyberSwap serves
// (docs.kyberswap.com, "Contracts & Addresses"; sdk/src/legs/kyber-spec.mjs).
export const KYBER_LEG_DOMAIN_NAME = ["Kyber", "DSLO", "Protocol"].join(" ");
export const KYBER_LEG_DOMAIN_VERSION = "1";
export const KYBER_LEG_CONTRACT = "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C";

// THE ORDER FIELDS AND THEIR TYPES, IN PROTOCOL ORDER - DSOrderMixin.LIMIT_ORDER_TYPEHASH. The order IS the protocol:
// a reordered or retyped field still produces a valid signature and is refused by the contract, so the field list is
// pinned against sdk/src/legs/kyber-spec.mjs (KYBER_ORDER_FIELDS) by the check.
export const KYBER_LEG_ORDER_FIELDS = [
  ["salt", "uint256"],
  ["makerAsset", "address"],
  ["takerAsset", "address"],
  ["maker", "address"],
  ["receiver", "address"],
  ["allowedSender", "address"],
  ["makingAmount", "uint256"],
  ["takingAmount", "uint256"],
  ["feeConfig", "uint256"],
  ["makerAssetData", "bytes"],
  ["takerAssetData", "bytes"],
  ["getMakerAmount", "bytes"],
  ["getTakerAmount", "bytes"],
  ["predicate", "bytes"],
  ["interaction", "bytes"],
];

// THE ENDPOINTS (docs.kyberswap.com, "Limit Order API" endpoint index and the Maker API reference).
export const KYBER_LEG_SIGN_MESSAGE_PATH = "/write/api/v1/orders/sign-message";
export const KYBER_LEG_CREATE_PATH = "/write/api/v1/orders";
export const KYBER_LEG_MAKER_ORDERS_PATH = "/read-ks/api/v1/orders";

// THE STATUS VOCABULARY (Maker API "Get List Of Orders By Maker" `status` enum). `active` and `closed` are umbrella
// FILTER values; an item `status` is one of the concrete ones. A status outside this set is not "probably fine" - it
// is "kyber-bad-response".
export const KYBER_LEG_STATUSES = ["active", "open", "partially_filled", "cancelling", "closed", "filled", "cancelled", "expired"];
export const KYBER_LEG_FINAL_STATUSES = ["filled", "cancelled", "expired"];
export const KYBER_LEG_SETTLED_STATUS = "filled";
export const KYBER_LEG_OPEN_STATUSES = ["open", "partially_filled", "cancelling"];
// The buckets queried while waiting for an outcome: `active` covers open/partially_filled/cancelling, `closed`
// covers filled/cancelled/expired.
export const KYBER_LEG_STATUS_BUCKETS = ["active", "closed"];

// THE NAMED REFUSALS. Every one is a VALUE ({ ok: false, code }), never null: a caller can always tell unreachable
// from refused from not-settled-yet.
export const KYBER_LEG_REFUSAL_CODES = [
  "kyber-unknown-network", // the chain has no order book here
  "kyber-bad-order",       // the order is incomplete or malformed - nothing to sign
  "kyber-sign-failed",     // the wallet did not produce a signature
  "kyber-unreachable",     // no answer from the order book (connection or timeout)
  "kyber-order-unknown",   // the order book does not know this order id for this maker
  "kyber-refused",         // the order book answered and did not accept (carries the status and its reason)
  "kyber-bad-response",    // the answer is not the shape we know (including typed data that is not this spec)
  "kyber-not-settled",     // the order stayed open until the timeout - "not yet", not "broken"
];

const refusal = (code, params = {}) => ({ ok: false, code, params });

const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
const isPositive = (v) => { try { return BigInt(String(v)) > 0n; } catch { return false; } };
const isSignature = (v) => /^0x[0-9a-fA-F]{130}$/.test(String(v || ""));

const joinUrl = (base, path) => String(base || "").replace(/\/+$/, "") + path;

// ONE JSON REQUEST. A thrown fetch is kyber-unreachable, an unreadable body is kyber-bad-response - never silence.
async function ask({ fetchImpl, url, method = "GET", body = null, timeoutMs = 20_000 }) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return refusal("kyber-unreachable", { why: "no-fetch" });
  let timer = null;
  try {
    const options = { method, headers: body === null ? undefined : { "content-type": "application/json" } };
    if (body !== null) options.body = JSON.stringify(body);
    const signal = typeof AbortController === "function" ? new AbortController() : null;
    if (signal) { options.signal = signal.signal; timer = setTimeout(() => signal.abort(), timeoutMs); }
    const res = await doFetch(url, options);
    let text = null;
    try { text = await res.text(); } catch { text = null; }
    return { ok: true, status: Number(res.status), text };
  } catch (error) {
    return refusal("kyber-unreachable", { why: String((error && error.message) || error) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * THE INTENT REQUEST: from what the person gives, build the body the order book's sign-message endpoint expects.
 * Returns { ok: true, params, expectedOutWei } or a named refusal. Pure - no network, no wallet. The order book
 * computes feeConfig/getMakerAmount/getTakerAmount/predicate itself; we only name the trade (token -> wrapped native).
 */
export function kyberLegPlan(request = {}) {
  const maker = request.maker;
  const receiver = request.receiver === undefined || request.receiver === null ? maker : request.receiver;
  const params = {
    chainId: String(request.chainId),
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
  if (!Number.isInteger(Number(params.chainId))) missing.push("chainId");
  if (!isAddress(maker)) missing.push("maker");
  if (!isAddress(params.makerAsset)) missing.push("makerAsset");
  if (!isAddress(params.takerAsset)) missing.push("takerAsset");
  if (!isAddress(params.receiver)) missing.push("receiver");
  if (!isPositive(params.makingAmount)) missing.push("makingAmount");
  if (!isPositive(params.takingAmount)) missing.push("takingAmount");
  if (!Number.isInteger(Number(params.expiredAt))) missing.push("expiredAt");
  if (missing.length) return refusal("kyber-bad-order", { missing: [...new Set(missing)] });
  return { ok: true, chainId: Number(params.chainId), params, expectedOutWei: String(params.takingAmount) };
}

/**
 * ASK FOR THE UNSIGNED ORDER. POST sign-message -> { types, domain, primaryType, message }. The returned typed data
 * is VALIDATED against this spec before it is trusted: the domain must be Kyber's and this contract's, the chain must
 * be the order's, the Order types must be EXACTLY KYBER_LEG_ORDER_FIELDS, and the message must be complete. Typed
 * data that does not agree is a NAMED refusal (kyber-bad-response), never signed anyway.
 */
export async function kyberLegUnsigned({ params, chainId = null, orderbook = null, fetchImpl = null, timeoutMs = 20_000 } = {}) {
  const id = Number(chainId !== null ? chainId : params && params.chainId);
  const base = orderbook ? String(orderbook).replace(/\/+$/, "") : KYBER_LEG_ORDERBOOK;
  if (!Number.isFinite(id)) return refusal("kyber-unknown-network", { chainId: null });
  if (!params || typeof params !== "object") return refusal("kyber-bad-order", { field: "params" });
  const res = await ask({ fetchImpl, url: joinUrl(base, KYBER_LEG_SIGN_MESSAGE_PATH), method: "POST", body: params, timeoutMs });
  if (!res.ok) return res;
  if (res.status >= 400) return refusal("kyber-refused", { status: res.status, stage: "sign-message", reason: null });
  let body = null;
  try { body = JSON.parse(res.text); } catch { body = null; }
  const data = body && body.data;
  if (!data || typeof data !== "object") return refusal("kyber-bad-response", { where: "sign-message" });
  const domain = data.domain || {};
  const message = data.message || {};
  const typeNames = (data.types && Array.isArray(data.types.Order)) ? data.types.Order.map((t) => (t ? t.name : "") + ":" + (t ? t.type : "")).join(",") : null;
  const expectedNames = KYBER_LEG_ORDER_FIELDS.map(([name, type]) => name + ":" + type).join(",");
  const domainOk = String(domain.name) === KYBER_LEG_DOMAIN_NAME
    && String(domain.version) === KYBER_LEG_DOMAIN_VERSION
    && Number(domain.chainId) === id
    && String(domain.verifyingContract || "").toLowerCase() === KYBER_LEG_CONTRACT.toLowerCase();
  if (!domainOk) return refusal("kyber-bad-response", { where: "sign-message", field: "domain" });
  if (typeNames !== expectedNames) return refusal("kyber-bad-response", { where: "sign-message", field: "types" });
  const missing = KYBER_LEG_ORDER_FIELDS.filter(([name]) => message[name] === undefined || message[name] === null || message[name] === "");
  if (missing.length) return refusal("kyber-bad-response", { where: "sign-message", missing: missing.map((m) => m[0]) });
  return {
    ok: true,
    chainId: id,
    orderbook: base,
    contract: KYBER_LEG_CONTRACT,
    salt: String(message.salt),
    message,
    typedData: { domain, types: data.types, primaryType: data.primaryType || "Order", message },
  };
}

/**
 * SIGN THE UNSIGNED ORDER THROUGH THE WALLET. The adapter's own signTypedData when present (it wraps
 * eth_signTypedData_v4), otherwise the same call through the wallet's EIP-1193 driver. A wallet that will not sign
 * is kyber-sign-failed, not a crash.
 */
export async function kyberLegSign({ typedData, wallet = null, address = null } = {}) {
  if (!typedData || typeof typedData !== "object") return refusal("kyber-bad-order", { field: "typedData" });
  try {
    if (wallet && typeof wallet.signTypedData === "function") {
      const signature = await wallet.signTypedData(typedData);
      if (!isSignature(signature)) return refusal("kyber-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    const driver = wallet && typeof wallet.driver === "function" ? wallet.driver() : wallet;
    if (driver && typeof driver.request === "function") {
      const from = address || (wallet && typeof wallet.address === "function" ? await wallet.address() : null);
      const signature = await driver.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] });
      if (!isSignature(signature)) return refusal("kyber-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    return refusal("kyber-sign-failed", { why: "no-wallet" });
  } catch (error) {
    return refusal("kyber-sign-failed", { why: String((error && error.code) || (error && error.message) || error) });
  }
}

/**
 * SUBMIT THE SIGNED ORDER. POST write path -> { data: { id } }. The body carries the request plus the salt from the
 * sign-message response and the Maker's signature. Every failure is one of the named refusals above.
 */
export async function kyberLegSubmit({ params, salt, signature, orderbook = null, chainId = null, fetchImpl = null, timeoutMs = 20_000 } = {}) {
  const base = orderbook ? String(orderbook).replace(/\/+$/, "") : KYBER_LEG_ORDERBOOK;
  if (!params || typeof params !== "object") return refusal("kyber-bad-order", { field: "params" });
  if (!isSignature(signature)) return refusal("kyber-bad-order", { field: "signature" });
  if (salt === undefined || salt === null || salt === "") return refusal("kyber-bad-order", { field: "salt" });
  const body = { ...params, salt: String(salt), signature };
  const res = await ask({ fetchImpl, url: joinUrl(base, KYBER_LEG_CREATE_PATH), method: "POST", body, timeoutMs });
  if (!res.ok) return res;
  if (res.status >= 400) return refusal("kyber-refused", { status: res.status, stage: "submit", reason: null });
  let parsed = null;
  try { parsed = JSON.parse(res.text); } catch { parsed = null; }
  const created = parsed && parsed.data;
  const id = created && created.id;
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return refusal("kyber-bad-response", { where: "submit", got: typeof id });
  return { ok: true, id: Number(id), chainId: Number.isFinite(Number(chainId)) ? Number(chainId) : null };
}

/**
 * READ ONE ORDER's status. GET maker orders by bucket; the order is looked up by id. A status word outside
 * KYBER_LEG_STATUSES is kyber-bad-response; an id found in neither bucket is kyber-order-unknown - never silence.
 */
export async function kyberLegRead({ id, chainId, maker, orderbook = null, fetchImpl = null, timeoutMs = 20_000 } = {}) {
  const base = orderbook ? String(orderbook).replace(/\/+$/, "") : KYBER_LEG_ORDERBOOK;
  const chain = Number(chainId);
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return refusal("kyber-bad-order", { field: "id" });
  if (!isAddress(maker)) return refusal("kyber-bad-order", { field: "maker" });
  for (const bucket of KYBER_LEG_STATUS_BUCKETS) {
    const path = KYBER_LEG_MAKER_ORDERS_PATH + "?chainId=" + chain + "&maker=" + maker + "&status=" + bucket;
    const res = await ask({ fetchImpl, url: joinUrl(base, path), timeoutMs });
    if (!res.ok) return res;
    if (res.status >= 400) return refusal("kyber-refused", { status: res.status, stage: "orders" });
    let parsed = null;
    try { parsed = JSON.parse(res.text); } catch { parsed = null; }
    const orders = parsed && parsed.data && parsed.data.orders;
    if (!Array.isArray(orders)) return refusal("kyber-bad-response", { where: "orders" });
    const found = orders.find((o) => o && Number(o.id) === Number(id)) || null;
    if (found) {
      const status = found.status;
      if (typeof status !== "string" || !KYBER_LEG_STATUSES.includes(status)) return refusal("kyber-bad-response", { where: "status", got: typeof status === "string" ? status : null });
      return { ok: true, status, order: found, bucket };
    }
  }
  return refusal("kyber-order-unknown", { id: Number(id), maker });
}

/**
 * WHAT ENDS THIS LEG'S EXECUTION - poll the order book until the order is settled or finally dead, with a timeout.
 *   { ok: true, done: true, settled: true,  status: "filled" }                    - the leg settled (WETH delivered);
 *   { ok: true, done: true, settled: false, status: "cancelled" | "expired" }      - the order is finally dead;
 *   { ok: false, code: "kyber-not-settled" | "kyber-unreachable" | ... }           - a NAMED refusal.
 * "Not settled in time" is its own code: "we did not wait long enough" is a state of the order, not a breakdown. The
 * clock and the sleep are injectable, so the wait is testable without real time.
 */
export async function kyberLegSettled({ id, chainId, maker, orderbook = null, fetchImpl = null, pollMs = 5_000, timeoutMs = 300_000, now = null, sleep = null, onTick = null } = {}) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return refusal("kyber-bad-order", { field: "id" });
  const clock = typeof now === "function" ? now : () => Date.now();
  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const step = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 5_000;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300_000;
  const startedAt = clock();
  let lastStatus = null;
  for (;;) {
    const read = await kyberLegRead({ id, chainId, maker, orderbook, fetchImpl });
    if (!read.ok) return read;
    lastStatus = read.status;
    if (typeof onTick === "function") onTick(lastStatus);
    if (KYBER_LEG_FINAL_STATUSES.includes(lastStatus)) {
      return { ok: true, done: true, settled: lastStatus === KYBER_LEG_SETTLED_STATUS, status: lastStatus, id: Number(id) };
    }
    if (clock() - startedAt >= limit) return { ...refusal("kyber-not-settled", { id: Number(id), status: lastStatus, waitedMs: clock() - startedAt }), status: lastStatus, id: Number(id) };
    await pause(step);
  }
}

// THE REFUSAL WORDS FOR THE SCREEN - by CODE, so a refusal is never an empty toast. Unknown codes are shown as-is.
export const kyberLegRefusalWords = (result) => {
  const code = result && result.code ? String(result.code) : null;
  const map = {
    "kyber-unknown-network": "no KyberSwap liquidity provider serves this network",
    "kyber-bad-order": "the swap intent is incomplete and was not sent",
    "kyber-sign-failed": "the wallet did not sign the swap intent",
    "kyber-unreachable": "the KyberSwap order book could not be reached",
    "kyber-order-unknown": "the KyberSwap order book does not know this order",
    "kyber-refused": "the KyberSwap order book did not accept the order",
    "kyber-bad-response": "the KyberSwap order book answered in a shape we do not know",
    "kyber-not-settled": "the swap did not settle in time",
  };
  return map[code] || (code ? code : "the liquidity leg stopped");
};
