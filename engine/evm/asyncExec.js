// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/asyncExec.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// THE ASYNCHRONOUS ROUTE, EXECUTED: INTENT -> SIGNATURE -> ORDER BOOK -> SETTLEMENT -> FUNDING.
//
// WHAT THIS MODULE IS AND WHY IT SITS IN THE ENGINE. Step 1 put the route PROVIDER in the package
// (sdk/src/legs/cow.mjs: the shape, the order book, the named refusals, settled()) and step 2 put the
// BALANCE-DRIVEN CHOICE in the engine (evm/permit.js: usdcWithoutEthVerdict, evm/asyncRoute.js: the network
// table). Neither of them moves anything: the decision says "the asynchronous path fits" and nothing runs it.
// This module is that missing half - the engine code that TAKES the asynchronous path on the page: it builds the
// intent, signs it through the page wallet, submits it to an order book, waits for settlement with a timeout and
// NAMED refusals, and only then hands control to the ordinary escrow funding.
//
// WHY HERE AND NOT IN THE PACKAGE. The page cannot import the package's sources (they pull bare npm specifiers
// and the DOM-free package never sees the page wallet); it reaches the core only through a built bundle whose
// surface is fixed. So the provider's CONTRACT (order fields, status vocabulary, refusal codes, order book path)
// is repeated here - exactly as the network table is repeated in evm/asyncRoute.js - and the agreement of the two
// is a CHECK (tools/check-async-route-live.mjs compares every constant against sdk/src/legs/cow.mjs), never a
// promise in a comment.
//
// NO NEW DEPENDENCY: the transport is the page's fetch, the signature is the wallet's own eth_signTypedData_v4,
// the EIP-712 typed data is assembled here from the order fields. Nothing is trusted to a library.
//
// EVERY FAILURE IS A NAMED VALUE, NEVER SILENCE AND NEVER A FUNDED DEAL WITH NO SWAP BEHIND IT.
import { asyncRouteForChain } from "./asyncRoute.js";

// THE SETTLEMENT CONTRACT AND THE NATIVE MARKER - the same two facts the package pins (sdk/src/legs/cow-spec.mjs):
// GPv2Settlement is deterministic and identical on every CoW network, and buying native uses the BUY_ETH_ADDRESS
// marker. A divergence between here and the package reddens the check.
export const ASYNC_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
export const ASYNC_BUY_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// THE ORDER BOOK PATH (the package's createOrder endpoint, OpenAPI: POST /api/v1/orders).
export const ASYNC_SUBMIT_PATH = "/api/v1/orders";
export const ASYNC_ORDER_PATH = "/api/v1/orders/";

// THE DOMAIN NAME AND VERSION - GPv2Signing.sol (keccak256("Gnosis Protocol"), keccak256("v2")). Built from parts
// so no literal here is a multi-word phrase (the package's own rule: the SDK reads such literals as user-facing text).
export const ASYNC_DOMAIN_NAME = ["Gnosis", "Protocol"].join(" ");
export const ASYNC_DOMAIN_VERSION = "v2";

// THE ORDER FIELDS AND THEIR TYPES, IN PROTOCOL ORDER - GPv2Order.Data. THE ORDER IS THE PROTOCOL: a reordered
// or retyped field still produces a valid signature and is refused by the settlement, so the field list is pinned
// against the package's COW_ORDER_FIELDS by the check.
export const ASYNC_ORDER_FIELDS = [
  ["sellToken", "address"],
  ["buyToken", "address"],
  ["receiver", "address"],
  ["sellAmount", "uint256"],
  ["buyAmount", "uint256"],
  ["validTo", "uint32"],
  ["appData", "bytes32"],
  ["feeAmount", "uint256"],
  ["kind", "string"],
  ["partiallyFillable", "bool"],
  ["sellTokenBalance", "string"],
  ["buyTokenBalance", "string"],
];

// THE STATUS VOCABULARY OF THE ORDER BOOK (OpenAPI: OrderStatus). A status outside this set is not "probably fine":
// the answer is not the shape we know and it is refused with cow-bad-response.
export const ASYNC_STATUSES = ["presignaturePending", "open", "fulfilled", "cancelled", "expired"];
export const ASYNC_FINAL_STATUSES = ["fulfilled", "cancelled", "expired"];
export const ASYNC_SETTLED_STATUS = "fulfilled";
export const ASYNC_OPEN_STATUSES = ["presignaturePending", "open"];

// THE NAMED REFUSALS. Every one is a VALUE ({ ok: false, code }), never null and never an exception escaping to the
// caller - the same codes the package's provider uses, so a caller can tell unreachable from refused from not-settled.
export const ASYNC_REFUSAL_CODES = [
  "cow-unknown-network",
  "cow-bad-order",
  "cow-sign-failed",
  "cow-unreachable",
  "cow-order-unknown",
  "cow-refused",
  "cow-bad-response",
  "cow-not-settled",
];

const refusal = (code, params = {}) => ({ ok: false, code, params });

const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
const isBytes32 = (v) => /^(0x)?[0-9a-fA-F]{64}$/.test(String(v || ""));
const isUid = (v) => /^0x[0-9a-fA-F]{112}$/.test(String(v || ""));
const isSignature = (v) => /^0x[0-9a-fA-F]{130}$/.test(String(v || ""));

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (/^0x[0-9a-fA-F]+$/.test(s) || /^[0-9]+$/.test(s)) return s.replace(/^0x/, "");
  return null;
};

// A NAMED REFUSAL IS A VALUE. The caller reads `ok`, and a caller that ignores it would be reading its own lie:
// so the flow below checks `ok` after EVERY step and stops at the first refusal.
const joinUrl = (base, path) => String(base || "").replace(/\/+$/, "") + path;

/** The order book base URL: the caller's explicit one, else the served network's (evm/asyncRoute.js), else null. */
export const asyncOrderbookFor = (chainId, orderbook = null, providerId = null) => {
  if (orderbook) return String(orderbook).replace(/\/+$/, "");
  const route = asyncRouteForChain(chainId, providerId);
  return route && route.orderbook ? String(route.orderbook).replace(/\/+$/, "") : null;
};

/** The EIP-712 typed data the wallet signs (eth_signTypedData_v4). The message carries kind/balances as STRINGS,
 *  matching the type - the wallet shows them readably and the settlement hashes them (see the package's cow-spec). */
export const asyncOrderTypedData = ({ order, chainId, settlement = ASYNC_SETTLEMENT }) => ({
  domain: { name: ASYNC_DOMAIN_NAME, version: ASYNC_DOMAIN_VERSION, chainId: Number(chainId), verifyingContract: settlement },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Order: ASYNC_ORDER_FIELDS.map(([name, type]) => ({ name, type })),
  },
  primaryType: "Order",
  message: {
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: String(order.sellAmount),
    buyAmount: String(order.buyAmount),
    validTo: Number(order.validTo),
    appData: order.appData,
    feeAmount: String(order.feeAmount),
    kind: String(order.kind),
    partiallyFillable: Boolean(order.partiallyFillable),
    sellTokenBalance: String(order.sellTokenBalance),
    buyTokenBalance: String(order.buyTokenBalance),
  },
});

/**
 * BUILD THE INTENT: from what the person gives, assemble the order and the typed data the wallet will sign.
 * Returns { ok: true, order, typedData } or a named refusal. Pure - no network, no wallet, no DOM.
 *
 * The order book existence is checked FIRST: an unknown network is cow-unknown-network, never a guess at a URL.
 */
export function asyncIntentVerdict(request = {}) {
  const chainId = Number(request.chainId);
  const orderbook = asyncOrderbookFor(chainId, request.orderbook || null, request.providerId || null);
  if (!orderbook) return refusal("cow-unknown-network", { chainId: Number.isFinite(chainId) ? chainId : null });
  const owner = request.owner;
  const receiver = request.receiver === undefined || request.receiver === null ? owner : request.receiver;
  const order = {
    sellToken: request.sellToken,
    buyToken: request.buyToken,
    receiver,
    sellAmount: num(request.sellAmountWei) === null ? request.sellAmountWei : String(request.sellAmountWei),
    buyAmount: num(request.buyAmountWei) === null ? request.buyAmountWei : String(request.buyAmountWei),
    validTo: request.validTo,
    appData: request.appData === undefined || request.appData === null ? "0x" + "00".repeat(32) : request.appData,
    feeAmount: request.feeAmountWei === undefined || request.feeAmountWei === null ? "0" : String(request.feeAmountWei),
    kind: request.kind === undefined || request.kind === null ? "sell" : request.kind,
    partiallyFillable: request.partiallyFillable === undefined || request.partiallyFillable === null ? false : request.partiallyFillable,
    sellTokenBalance: request.sellTokenBalance === undefined || request.sellTokenBalance === null ? "erc20" : request.sellTokenBalance,
    buyTokenBalance: request.buyTokenBalance === undefined || request.buyTokenBalance === null ? "erc20" : request.buyTokenBalance,
  };
  const missing = [];
  for (const [name] of ASYNC_ORDER_FIELDS) {
    const v = order[name];
    if (v === undefined || v === null || v === "") missing.push(name);
  }
  if (!isAddress(owner)) missing.push("owner");
  if (!isBytes32(order.appData)) missing.push("appData");
  if (!isAddress(order.sellToken) || !isAddress(order.buyToken) || !isAddress(order.receiver)) missing.push("token");
  if (num(order.sellAmount) === null || num(order.buyAmount) === null) missing.push("amount");
  if (num(order.validTo) === null) missing.push("validTo");
  if (!ASYNC_STATUSES.length || !["sell", "buy"].includes(order.kind)) missing.push("kind");
  if (missing.length) return { ...refusal("cow-bad-order", { missing: [...new Set(missing)] }), orderbook };
  return {
    ok: true,
    chainId: Number.isFinite(chainId) ? chainId : null,
    orderbook,
    owner,
    order,
    typedData: asyncOrderTypedData({ order, chainId, settlement: request.settlement || ASYNC_SETTLEMENT }),
  };
}

/**
 * SIGN THE INTENT THROUGH THE WALLET. The adapter's own signTypedData when present, otherwise eth_signTypedData_v4
 * through its EIP-1193 driver (or directly, when the caller hands the provider itself). A wallet that will not sign
 * is cow-sign-failed, not a crash.
 */
export async function asyncSignVerdict({ typedData, wallet = null, address = null } = {}) {
  if (!typedData || typeof typedData !== "object") return refusal("cow-bad-order", { field: "typedData" });
  try {
    if (wallet && typeof wallet.signTypedData === "function") {
      const signature = await wallet.signTypedData(typedData);
      if (!isSignature(signature)) return refusal("cow-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    const driver = wallet && typeof wallet.driver === "function" ? wallet.driver() : wallet;
    if (driver && typeof driver.request === "function") {
      const from = address || (wallet && typeof wallet.address === "function" ? await wallet.address() : null);
      const signature = await driver.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] });
      if (!isSignature(signature)) return refusal("cow-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    return refusal("cow-sign-failed", { why: "no-wallet" });
  } catch (error) {
    return refusal("cow-sign-failed", { why: String((error && error.code) || (error && error.message) || error) });
  }
}

// THE PAYLOAD THE ORDER BOOK EXPECTS (createOrder / OrderCreation). Every field is set EXPLICITLY - no relying on a
// server default that could contradict the signed order: the signed fields must travel exactly as signed.
export const asyncOrderSubmission = ({ order, signature, owner, signingScheme = "eip712", from = null }) => ({
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
});

// ONE JSON REQUEST. The transport is the caller's (the page's fetch, or a stand-in in a check); a thrown fetch is
// cow-unreachable, a body we cannot read is cow-bad-response - never silence.
async function ask({ fetchImpl, url, method = "GET", body = null, timeoutMs = 20_000 }) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return refusal("cow-unreachable", { why: "no-fetch" });
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
    return refusal("cow-unreachable", { why: String((error && error.message) || error) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * SUBMIT THE SIGNED ORDER. POST /api/v1/orders -> 201 with the order UID (56 bytes). Every failure is a named
 * refusal: unreachable, refused (the book answered and did not accept), or an answer that is not the shape we know.
 */
export async function asyncSubmitVerdict({ orderbook, order, signature, owner, fetchImpl = null, timeoutMs = 20_000, signingScheme = "eip712", from = null } = {}) {
  const base = orderbook ? String(orderbook).replace(/\/+$/, "") : null;
  if (!base) return refusal("cow-unknown-network", {});
  if (!isSignature(signature)) return refusal("cow-bad-order", { field: "signature" });
  const res = await ask({ fetchImpl, url: joinUrl(base, ASYNC_SUBMIT_PATH), method: "POST", body: asyncOrderSubmission({ order, signature, owner, signingScheme, from }), timeoutMs });
  if (!res.ok) return res;
  if (res.status >= 400) return refusal("cow-refused", { status: res.status, reason: null });
  if (typeof res.text !== "string" || !isUid(res.text.trim())) return refusal("cow-bad-response", { where: "submit" });
  return { ok: true, uid: res.text.trim() };
}

/**
 * READ ONE ORDER. GET /api/v1/orders/{UID} -> the order, with `status`. A 404 is cow-order-unknown; a body whose
 * status is not a known status word is cow-bad-response - never silence, never null.
 */
export async function asyncReadVerdict({ orderbook, uid, fetchImpl = null, timeoutMs = 20_000 } = {}) {
  const base = orderbook ? String(orderbook).replace(/\/+$/, "") : null;
  if (!base) return refusal("cow-unknown-network", {});
  if (!isUid(uid)) return refusal("cow-bad-order", { field: "uid" });
  const res = await ask({ fetchImpl, url: joinUrl(base, ASYNC_ORDER_PATH + uid), timeoutMs });
  if (!res.ok) return res;
  if (res.status === 404) return refusal("cow-order-unknown", { uid });
  if (res.status >= 400) return refusal("cow-refused", { status: res.status });
  let body = null;
  try { body = JSON.parse(res.text); } catch { body = null; }
  const status = body && body.status;
  if (typeof status !== "string" || !ASYNC_STATUSES.includes(status)) return refusal("cow-bad-response", { where: "status", got: typeof status === "string" ? status : null });
  return { ok: true, status, order: body };
}

/**
 * WHAT ENDS AN ASYNCHRONOUS EXECUTION - poll the order book until the order is settled or finally dead, with a
 * timeout. Returns:
 *   { ok: true, done: true, settled: true,  status: "fulfilled" }              - the swap settled;
 *   { ok: true, done: true, settled: false, status: "cancelled" | "expired" }  - the order is finally dead;
 *   { ok: false, code: "cow-not-settled" | "cow-unreachable" | ... }           - a NAMED refusal.
 * "Not settled in time" is its own code: "we did not wait long enough" is a state of the order, not a breakdown.
 * The clock and the sleep are injectable, so the wait is testable without real time.
 */
export async function asyncSettledVerdict({ orderbook, uid, fetchImpl = null, pollMs = 5_000, timeoutMs = 300_000, now = null, sleep = null, onTick = null } = {}) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const pause = typeof sleep === "function" ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const step = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 5_000;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300_000;
  const startedAt = clock();
  let lastStatus = null;
  for (;;) {
    const read = await asyncReadVerdict({ orderbook, uid, fetchImpl });
    if (!read.ok) return read;
    lastStatus = read.status;
    if (typeof onTick === "function") onTick(lastStatus);
    if (ASYNC_FINAL_STATUSES.includes(lastStatus)) {
      return { ok: true, done: true, settled: lastStatus === ASYNC_SETTLED_STATUS, status: lastStatus, uid };
    }
    if (clock() - startedAt >= limit) return { ...refusal("cow-not-settled", { uid, status: lastStatus, waitedMs: clock() - startedAt }), status: lastStatus, uid };
    await pause(step);
  }
}

// THE WORDS THE SCREEN SHOWS, IN ONE PLACE. English, and they carry the state rather than a promise: the person must
// see the swap, the wait for settlement and the funding as separate steps, and a refusal must reach the screen with
// its own name. The screen renders these; the engine never touches the DOM.
export function asyncStageWords(stage, detail = "") {
  const line = String(detail || "").trim();
  const base = {
    "async-plan": "Building the swap intent",
    "async-sign": "Waiting for the wallet to sign the swap intent",
    "async-submit": "Submitting the swap intent to the order book",
    "async-wait": "Waiting for the swap to settle",
    "async-settled": "Swap settled - now funding the escrow",
    "async-fund": "Funding the escrow with the settled funds",
  }[stage] || null;
  return base ? base + (line ? ": " + line : "") : (line || String(stage || ""));
}

// THE REFUSAL WORDS FOR THE SCREEN - by CODE, so a refusal is never an empty toast. Unknown codes are shown as-is.
export const asyncRefusalWords = (result) => {
  const code = result && result.code ? String(result.code) : null;
  const map = {
    "cow-unknown-network": "no asynchronous provider serves this network",
    "cow-bad-order": "the swap intent is incomplete and was not sent",
    "cow-sign-failed": "the wallet did not sign the swap intent",
    "cow-unreachable": "the order book could not be reached",
    "cow-order-unknown": "the order book does not know this order",
    "cow-refused": "the order book did not accept the order",
    "cow-bad-response": "the order book answered in a shape we do not know",
    "cow-not-settled": "the swap did not settle in time",
    "async-order-dead": "the swap order was cancelled or expired - nothing was funded",
  };
  return map[code] || (code ? code : "the asynchronous route stopped");
};

/**
 * RUN THE ASYNCHRONOUS ROUTE, THEN THE ORDINARY FUNDING - AND ONLY THEN.
 *
 * The order is the whole point: plan the intent, sign it, submit it, WAIT until the order book says the swap
 * SETTLED, and only after a settled result call `fund()`. If anything does not settle, `fund` is NOT called and the
 * caller gets a named refusal: a funded deal with no swap behind it is exactly the failure this ordering forbids.
 *
 * The caller supplies:
 *   route    - { chainId, orderbook?, providerId? } (the order book from the table or an explicit stand-in);
 *   request  - the intent fields (owner, sellToken, buyToken, sellAmountWei, buyAmountWei, validTo, ...);
 *   wallet   - the page wallet (adapter or EIP-1193 provider);
 *   fund     - async () => {...} the ordinary escrow funding, called ONCE and only after settlement;
 *   onStep   - (stage, detail) -> the screen shows asyncStageWords(stage, detail).
 * Returns { ok: true, uid, status, funded } on settlement, or { ok: false, stage, code, ... } on a refusal.
 */
export async function runAsyncRoute({
  route = {}, request = {}, wallet = null, fund = null,
  fetchImpl = null, pollMs = 5_000, timeoutMs = 300_000, now = null, sleep = null, onStep = null,
} = {}) {
  const say = (stage, detail) => { if (typeof onStep === "function") onStep(stage, detail, asyncStageWords(stage, detail)); };
  const chainId = route.chainId !== undefined && route.chainId !== null ? route.chainId : request.chainId;
  const orderbook = asyncOrderbookFor(chainId, route.orderbook || request.orderbook || null, route.providerId || request.providerId || null);

  say("async-plan", "");
  const intent = asyncIntentVerdict({ ...request, chainId, orderbook });
  if (!intent.ok) return { ok: false, stage: "plan", ...intent, words: asyncRefusalWords(intent) };

  say("async-sign", "");
  const signed = await asyncSignVerdict({ typedData: intent.typedData, wallet, address: request.owner });
  if (!signed.ok) return { ok: false, stage: "sign", ...signed, words: asyncRefusalWords(signed) };

  say("async-submit", "");
  const submitted = await asyncSubmitVerdict({ orderbook: intent.orderbook, order: intent.order, signature: signed.signature, owner: request.owner, fetchImpl });
  if (!submitted.ok) return { ok: false, stage: "submit", ...submitted, words: asyncRefusalWords(submitted) };

  say("async-wait", "order " + String(submitted.uid).slice(0, 12));
  const settled = await asyncSettledVerdict({
    orderbook: intent.orderbook, uid: submitted.uid, fetchImpl, pollMs, timeoutMs, now, sleep,
    onTick: (status) => say("async-wait", "status " + status),
  });
  if (!settled.ok) return { ok: false, stage: "settle", uid: submitted.uid, ...settled, words: asyncRefusalWords(settled) };
  if (!settled.settled) {
    const dead = { ok: false, code: "async-order-dead", params: { uid: submitted.uid, status: settled.status } };
    return { ok: false, stage: "settle", uid: submitted.uid, ...dead, words: asyncRefusalWords(dead) };
  }

  say("async-settled", "");
  if (typeof fund !== "function") return { ok: false, stage: "fund", code: "async-no-fund", uid: submitted.uid, words: asyncRefusalWords({ code: "async-no-fund" }) };
  say("async-fund", "");
  const funded = await fund({ uid: submitted.uid, status: settled.status, order: intent.order });
  return { ok: true, uid: submitted.uid, status: settled.status, funded };
}
