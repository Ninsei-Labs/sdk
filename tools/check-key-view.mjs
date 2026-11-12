#!/usr/bin/env node
// A ONE-KEY SWAP MUST FUND THE ADDRESS THE TWELVE WORDS REBUILD.
//
// On the key path the maker's view half is derived from the words (domain, chain, index). If `start` accepts
// another view half from the quote, the funded Monero address differs from the one `sweep.fromOrder` rebuilds,
// and the buyer cannot withdraw after the funds are locked.
//
// Run: node tools/check-key-view.mjs
import { createSwaps } from "../src/swaps.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { primitives } from "../src/primitives.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";
import { halfCommitmentHex } from "../engine/atomic/orderHalfCommit.js";
import { loadState, memoryStorage, saveState, setStorage } from "../engine/core/store.js";
import { FACTORY_METHODS, ORDER_CREATED_TOPIC } from "../engine/evm/factory.js";
import { encodeStatus } from "../engine/evm/escrow.js";
import { takerHalvesV2 } from "../src/recovery-key.mjs";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const addr = (b) => "0x" + b.repeat(20);
const now = Math.floor(Date.now() / 1000);
const order = { chainId: 421614, factory: addr("11"), locker: addr("22"), claimer: addr("33"),
  amount: "1000000000000000000", readyBy: now + 7200, t1: now + 14400, salt: "0x" + "44".repeat(32) };
const maker = buildOwnSideFromHalves(order, { spendHalf: "0x03", viewHalf: "0x04" });
const derived = takerHalvesV2({ mnemonic: WORDS, chainId: 421614, factory: order.factory, salt: order.salt });
const makerKey = "0x" + "11".repeat(32);
const pub = primitives.secp256k1.getPublicKey(Buffer.from(makerKey.slice(2), "hex"), false);
const quote = { ...order, provider: order.claimer,
  quoteKey: "0x" + Buffer.from(primitives.keccak256(pub.slice(1)).slice(12)).toString("hex"),
  registry: addr("55"), cashier: addr("66"),
  commitHalfClaimer: halfCommitmentHex(3n, primitives.secp256k1, primitives.keccak256),
  edPointClaimer: maker.spendPoint, feeBps: 0, fee: "0", feeRecipient: addr("77"),
  validUntil: now + 600, nonce: "1", xmrAmount: "1000000000000", claimTip: "0", commitHalfLocker: "0x" + "a1".repeat(32), edPointLocker: "0x" + "a2".repeat(32), edViewPointLocker: "0x" + "a3".repeat(32) };
quote.signature = signQuoteDigest({ crypto: primitives, digest: quoteDigest({ crypto: primitives, quote }), privateKey: makerKey });
// A COPY OF THE SAME SIGNED QUOTE WITH ANOTHER LIFETIME. The lock check runs after the answer's preparation was paid;
// the case below needs a quote that is already inside the answer's combined window but outside the next-block margin.
const quoteForLock = (validUntil) => {
  const copy = { ...quote, validUntil };
  copy.signature = signQuoteDigest({ crypto: primitives, digest: quoteDigest({ crypto: primitives, quote: copy }), privateKey: makerKey });
  return copy;
};

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

async function startWith(view, salt = order.salt, extra = {}, autoSalt = false, options = {}) {
  if (options.fresh !== false) setStorage(memoryStorage());
  let sent = 0;
  let atSend = null;
  const wallet = { chainId: async () => order.chainId, address: async () => order.locker,
    send: async () => { sent += 1; atSend = loadState(); throw Object.assign(new Error("stop before broadcast"), { code: "wallet-rejected" }); },
    receipt: async () => null };
  const counterparty = { proof: maker.side.proof, edPointClaimer: maker.spendPoint,
    commitHalfClaimer: quote.commitHalfClaimer, ...extra };
  if (view === "missing") delete counterparty.viewHalfClaimer;
  else counterparty.viewHalfClaimer = view;
  const activeOrder = options.order || order;
  const activeQuote = Object.prototype.hasOwnProperty.call(options, "quote") ? options.quote : quote;
  const request = { quote: { id: "q", chain: "arbitrum-sepolia", asset: "ETH", amount: 1, size: 1, xmrAmount: quote.xmrAmount }, order: activeOrder, orderQuote: activeQuote,
    counterparty, recoveryKey: WORDS, ...(autoSalt ? {} : { recoverySalt: salt }),
    receiveTo: "synthetic-xmr-destination", restoreHeight: 100, wallet, onRecoveryKey: async () => true };
  const result = await createSwaps({ mode: "live", xmrNetwork: "stagenet", logs: async () => [],
    now: options.nowMs === undefined ? null : () => options.nowMs,
    call: async ({ data }) => (data.startsWith(FACTORY_METHODS.predict) ? "0x" + "0".repeat(24) + "88".repeat(20) : "0x"),
  }).start(request).catch((error) => error);
  return { result, sent, atSend };
}

console.log("=== 0) A SELL START IS REFUSED BEFORE ANY WALLET ===");
{
  const result = await createSwaps({}).start({ side: "sell" }).catch((error) => error);
  if (result && result.code === "bad-input" && result.params && result.params.field === "side" &&
      result.params.why === "sell-not-supported") {
    ok("a sell start is refused by its side");
  } else bad("sell start -> " + JSON.stringify(result && (result.code || result)));
}

console.log("=== 0) THE PER-SWAP FILE PATH IS GONE ===");
{
  const result = await createSwaps({}).start({ quote: {}, order: {}, receiveTo: "synthetic-xmr-destination" }).catch((error) => error);
  if (result && result.code === "bad-input" && result.params && result.params.field === "recoveryKey") {
    ok("a start without a recovery key is refused by name");
  } else bad("start without a key -> " + JSON.stringify(result && (result.code || result)));
}

console.log("=== 1) THE DERIVED VIEW HALF IS ACCEPTED ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf);
  if (result && result.code === "wallet-rejected" && sent === 1) ok("the derived half reaches the wallet");
  else bad("derived half: " + JSON.stringify({ code: result && result.code, sent }));
}

console.log("=== 1b) THE SALT-BASED KEY USES THE SAME CHECK ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf);
  if (result && result.code === "wallet-rejected" && sent === 1) ok("a v2 salt start reaches the wallet with its own derived half");
  else bad("v2 salt start: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 1b2) A NEW START DEFAULTS TO THE ORDER SALT, NOT A V1 INDEX ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf, order.salt, {}, true);
  if (result && result.code === "wallet-rejected" && sent === 1) ok("a start without recoverySalt derives the v2 half from the order salt");
  else bad("default salt start: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 1c) A SALT THE QUOTE DID NOT CARRY IS REFUSED ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf, "0x" + "55".repeat(32));
  if (result && result.code === "bad-input" && result.params && result.params.field === "recoverySalt" &&
      result.params.why === "order-salt" && sent === 0) ok("a salt different from order.salt is refused before the wallet");
  else bad("salt mismatch: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 1c1) A MALFORMED SALT IS REFUSED BY NAME, NOT IGNORED ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf, "not-a-salt");
  if (result && result.code === "bad-input" && result.params && result.params.field === "recoverySalt" &&
      result.params.why === "unreadable" && sent === 0) {
    ok("a malformed recoverySalt is named before the pending lookup");
  } else bad("malformed salt: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

async function startPending({ fresh = true, receipt = { status: "0x1", logs: [], blockNumber: 10 }, funded = false, withId = true, withQuote = true, withSignature = true, escrow = null, recoverySalt = order.salt, orderSalt = order.salt, predictThrows = false } = {}) {
  if (fresh) setStorage(memoryStorage());
  let sent = 0;
  const wallet = { chainId: async () => order.chainId, address: async () => order.locker,
    send: async () => { sent += 1; return "0x" + "99".repeat(32); },
    receipt: async () => receipt };
  const counterparty = { proof: maker.side.proof, edPointClaimer: maker.spendPoint,
    commitHalfClaimer: quote.commitHalfClaimer, viewHalfClaimer: derived.makerViewHalf };
  const activeQuote = withSignature ? quote : { ...quote, signature: undefined };
  const request = { quote: { ...(withId ? { id: "q" } : {}), chain: "arbitrum-sepolia", asset: "ETH", amount: 1, size: 1 }, order: { ...order, salt: orderSalt }, ...(withQuote ? { orderQuote: activeQuote } : {}),
    counterparty, recoveryKey: WORDS, recoverySalt, receiveTo: "synthetic-xmr-destination",
    restoreHeight: 100, wallet, onRecoveryKey: async () => true, ...(escrow ? { escrow } : {}) };
  const fundedStatus = "0x" + [1, 0, 0, 0].map((value) => BigInt(value).toString(16).padStart(64, "0")).join("");
  const result = await createSwaps({ mode: "live", xmrNetwork: "stagenet", logs: async () => [],
    call: async ({ data }) => {
      if (predictThrows && data.startsWith(FACTORY_METHODS.predict)) throw new Error("factory read failed");
      if (data === encodeStatus()) return funded ? fundedStatus : "0x";
      return data.startsWith(FACTORY_METHODS.predict) ? "0x" + "0".repeat(24) + "88".repeat(20) : "0x";
    },
  }).start(request).catch((error) => error);
  return { result, sent };
}

console.log("=== 1c3) A RELOADED PENDING RETRY FINDS THE SAME ESCROW ===");
{
  const first = await startPending();
  const second = await startPending({ fresh: false });
  const records = Object.keys((loadState() || {}).swaps || {});
  if (first.result && first.result.step === "funding-pending" &&
      second.result && second.result.step === "funding-pending" &&
      second.result.id === first.result.id && second.sent === 0 && records.length === 1) {
    ok("a retry without an escrow field resumes the pending record and leaves one record");
  } else {
    bad("pending retry: " + JSON.stringify({ first: first.result && first.result.step,
      second: second.result && second.result.step, same: second.result && first.result && second.result.id === first.result.id,
      sent: second.sent, records }));
  }
}

console.log("=== 1c4) A DIFFERENT ESCROW ON RETRY IS REFUSED, NOT SENT AGAIN ===");
{
  const first = await startPending();
  const second = await startPending({ fresh: false, escrow: "0x" + "77".repeat(20) });
  if (first.result && first.result.step === "funding-pending" &&
      second.result && second.result.code === "bad-input" && second.result.params &&
      second.result.params.why === "escrow-mismatch" && second.sent === 0) {
    ok("a retry naming another escrow is refused by name");
  } else {
    bad("wrong escrow retry: " + JSON.stringify({ code: second.result && second.result.code,
      params: second.result && second.result.params, sent: second.sent }));
  }
}

console.log("=== 1c5) A RETRY WITHOUT THE SIGNED QUOTE IS REFUSED, NOT SENT AGAIN ===");
{
  const first = await startPending();
  const second = await startPending({ fresh: false, withSignature: false });
  if (first.result && first.result.step === "funding-pending" &&
      second.result && second.result.code === "bad-input" && second.result.params &&
      second.result.params.why === "required-for-pending-funding" && second.sent === 0) {
    ok("a retry that cannot name the predicted escrow is refused by name");
  } else {
    bad("missing quote retry: " + JSON.stringify({ code: second.result && second.result.code,
      params: second.result && second.result.params, sent: second.sent }));
  }
}

console.log("=== 1c6) A PENDING RECORD WRITTEN BEFORE THE IDENTITY FIELDS IS MATCHED BY ITS REMAINING FIELDS ===");
{
  const first = await startPending();
  const state = loadState();
  const record = Object.values((state && state.swaps) || {})[0];
  if (!record) bad("old-record fixture: no pending record");
  else {
    delete record.chainId;
    delete record.factory;
    if (record.order) { delete record.order.chainId; delete record.order.factory; }
    if (record.quote) { delete record.quote.chainId; delete record.quote.factory; }
    if (record.escrow) { delete record.escrow.chainId; delete record.escrow.factory; }
    saveState(state);
    const second = await startPending({ fresh: false });
    if (first.result && first.result.step === "funding-pending" &&
        second.result && second.result.step === "funding-pending" && second.sent === 0) {
      ok("an old pending record is matched by salt and predicted escrow");
    } else {
      bad("old-record retry: " + JSON.stringify({ code: second.result && second.result.code,
        params: second.result && second.result.params, step: second.result && second.result.step, sent: second.sent }));
    }
  }
}

console.log("=== 1c2) A PENDING ROW WITHOUT ITS SALT IS REFUSED, NOT STARTED AGAIN ===");
{
  const first = await startPending();
  const noSaltOrder = { ...order, salt: "", xmrAmount: quote.xmrAmount };
  const second = await startWith(derived.makerViewHalf, "", {}, false, { fresh: false, order: noSaltOrder, quote: null });
  if (first.result && first.result.step === "funding-pending" && second.result &&
      second.result.code === "bad-input" && second.result.params && second.result.params.field === "recoverySalt" && second.sent === 0) {
    ok("a pending quote id without a salt is refused instead of opening a second deposit");
  } else {
    bad("salt-less pending retry: " + JSON.stringify({ first: first.result && first.result.step, code: second.result && second.result.code, params: second.result && second.result.params, sent: second.sent }));
  }
}

console.log("=== 1c3) A BIGINT SALT RESUMES THE SAME PENDING DEPOSIT ===");
{
  const first = await startPending();
  const second = await startPending({ fresh: false, recoverySalt: BigInt(order.salt) });
  if (first.result && first.result.step === "funding-pending" &&
      second.result && second.result.step === "funding-pending" && second.sent === 0) {
    ok("a bigint recoverySalt is canonicalised before the pending lookup and sends nothing");
  } else {
    bad("bigint salt retry: " + JSON.stringify({ first: first.result && first.result.step,
      code: second.result && second.result.code, params: second.result && second.result.params,
      step: second.result && second.result.step, sent: second.sent }));
  }
}

console.log("=== 1c3b) A FAILED PREDICT ON RETRY IS NOT A MISSING ESCROW ===");
{
  const first = await startPending();
  const second = await startPending({ fresh: false, predictThrows: true });
  if (first.result && first.result.step === "funding-pending" &&
      second.result && second.result.code === "quote-factory-unchecked" &&
      second.result.params && second.result.params.step === "factory" &&
      second.result.params.why === "predict-failed" && second.sent === 0) {
    ok("a factory read failure on retry is named as predict-failed, not as a missing escrow");
  } else {
    bad("predict retry: " + JSON.stringify({ first: first.result && first.result.step,
      code: second.result && second.result.code, params: second.result && second.result.params, sent: second.sent }));
  }
}

console.log("=== 1d) A RECEIPT WITHOUT THE EVENT IS NOT xmr-incoming ===");
{
  const { result, sent } = await startPending();
  if (result && result.step === "funding-pending" && result.txHash && result.escrow && sent === 1) {
    ok("a status-1 receipt with no OrderCreated is funding-pending, not a funded escrow");
  } else bad("pending funding: " + JSON.stringify({ step: result && result.step, txHash: result && result.txHash, sent }));
}

console.log("=== 1d1) THE PENDING RECORD IS WRITTEN BEFORE THE SEND ===");
{
  const { result, sent, atSend } = await startWith(derived.makerViewHalf, order.salt);
  const atSendRecords = Object.values((atSend && atSend.swaps) || {});
  const atSendPending = atSendRecords.find((item) => item && item.fundingPending === true);
  const after = Object.values((loadState() && loadState().swaps) || {}).some((item) => item && item.fundingPending === true);
  if (result && result.code === "wallet-rejected" && sent === 1 && atSendPending && atSendPending.escrow &&
      atSendPending.escrow.fundingReason === "not-sent" &&
      /^0x8{40}$/i.test(String(atSendPending.escrow.address || "")) && !after) {
    ok("the pending record exists at send time and a rejected wallet clears it for a retry");
  } else bad("pre-send record: " + JSON.stringify({ code: result && result.code, sent, atSend: atSendPending && atSendPending.escrow, after }));
}

console.log("=== 1d1b) THE LOCK RESERVES THE NEXT BLOCK, NOT THE PREPARATION AGAIN ===");
{
  // 35 s left: inside the answer's 45 s window, outside the lock's 30 s margin. The preparation was already spent
  // between the answer and this send, so the lock must not charge START_PREP_SEC a second time.
  const fixedSec = Math.floor(Date.now() / 1000);
  const { result, sent } = await startWith(derived.makerViewHalf, order.salt, {}, false,
    { quote: quoteForLock(fixedSec + 35), nowMs: fixedSec * 1000 });
  if (result && result.code === "wallet-rejected" && sent === 1) {
    ok("a quote with 35 s left reaches the lock after the answer already paid the preparation");
  } else {
    bad("lock life: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
  }
}

console.log("=== 1d2) A RETRY READS THE SAME HASH AND DOES NOT SEND AGAIN ===");
{
  const first = await startPending();
  const predicted = first.result && first.result.escrow;
  const pad = (v) => "0x" + String(v).replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const created = { address: order.factory, topics: [ORDER_CREATED_TOPIC, pad(predicted), pad(order.locker), pad(order.claimer)],
    data: "0x" + "00".repeat(12 * 32) };
  const second = await startPending({ fresh: false, receipt: { status: "0x1", logs: [created], blockNumber: 11 }, escrow: predicted });
  if (predicted && second.result && second.result.step === "xmr-incoming" && second.result.escrow === predicted && second.sent === 0) {
    ok("the retry reads the pending hash, saves the escrow and sends nothing");
  } else bad("pending retry: " + JSON.stringify({ ctor: second.result && second.result.constructor && second.result.constructor.name, code: second.result && second.result.code, params: second.result && second.result.params, msg: second.result && second.result.message, sent: second.sent }));
}

console.log("=== 1d2b) A RETRY WITHOUT AN ORDER ID FINDS THE SALT-KEYED PENDING RECORD ===");
{
  const first = await startPending();
  const predicted = first.result && first.result.escrow;
  const pad = (v) => "0x" + String(v).replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const created = { address: order.factory, topics: [ORDER_CREATED_TOPIC, pad(predicted), pad(order.locker), pad(order.claimer)],
    data: "0x" + "00".repeat(12 * 32) };
  const second = await startPending({ fresh: false, withId: false, receipt: { status: "0x1", logs: [created], blockNumber: 11 }, escrow: predicted });
  if (predicted && second.result && second.result.step === "xmr-incoming" && second.result.escrow === predicted && second.sent === 0) {
    ok("the salt identifies the pending record when the relay answer has no order id");
  } else bad("salt-keyed retry: " + JSON.stringify({ predicted, step: second.result && second.result.step, escrow: second.result && second.result.escrow, sent: second.sent, code: second.result && second.result.code }));
}

console.log("=== 1d2c) A STALE not-sent RECORD IS CLEARED WHEN THE ESCROW IS NOT FUNDED ===");
{
  const first = await startWith(derived.makerViewHalf, order.salt);
  const state = loadState();
  const record = Object.values((state && state.swaps) || {})[0];
  const predicted = record && record.escrow && record.escrow.address;
  if (!record || !predicted) bad("stale not-sent fixture: " + JSON.stringify({ code: first.result && first.result.code }));
  else {
    record.fundingPending = true;
    record.escrow = { ...record.escrow, fundingPending: true, fundingReason: "not-sent" };
    delete record.escrow.fundTx;
    delete record.fundTx;
    saveState(state);
    const pad = (v) => "0x" + String(v).replace(/^0x/, "").toLowerCase().padStart(64, "0");
    const created = { address: order.factory, topics: [ORDER_CREATED_TOPIC, pad(predicted), pad(order.locker), pad(order.claimer)],
      data: "0x" + "00".repeat(12 * 32) };
    const second = await startPending({ fresh: false, receipt: { status: "0x1", logs: [created], blockNumber: 11 } });
    if (second.result && second.result.step === "xmr-incoming" && second.result.escrow === predicted && second.sent === 1) {
      ok("a not-sent record with an unfunded escrow is cleared and the retry sends once");
    } else bad("stale not-sent retry: " + JSON.stringify({ step: second.result && second.result.step, escrow: second.result && second.result.escrow, predicted, sent: second.sent, code: second.result && second.result.code }));
  }
}

console.log("=== 1d3) A FUNDED STATUS RESCUES A MISSING RECEIPT ===");
{
  const first = await startPending();
  const predicted = first.result && first.result.escrow;
  const second = await startPending({ fresh: false, receipt: null, funded: true, escrow: predicted });
  if (predicted && second.result && second.result.step === "xmr-incoming" && second.result.escrow === predicted && second.sent === 0) {
    ok("a funded status saves the predicted escrow when the receipt is gone");
  } else bad("funded status fallback: " + JSON.stringify({ step: second.result && second.result.step, escrow: second.result && second.result.escrow, predicted, sent: second.sent, code: second.result && second.result.code }));
}

console.log("=== 1f) A HALF AND A DIFFERENT POINT ARE REFUSED ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf, order.salt, { viewPoint: maker.viewPoint });
  if (result && result.code === "bad-input" && result.params && result.params.why === "view-half-point-mismatch" && sent === 0) {
    ok("a point that is not the half's point is refused");
  } else bad("half/point mismatch: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 1g) CONFLICTING VIEW ALIASES ARE REFUSED ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf, order.salt, { viewHalf: "0x05" });
  if (result && result.code === "bad-input" && result.params && result.params.why === "conflicting-view-half" && sent === 0) {
    ok("two different view halves are refused");
  } else bad("conflicting halves: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 2) ANOTHER VIEW HALF IS REFUSED BEFORE FUNDING ===");
{
  const { result, sent } = await startWith("0x04");
  if (result && result.code === "quote-refused" && result.params && result.params.step === "viewHalfClaimer" && sent === 0) {
    ok("a foreign view half is refused before the wallet");
  } else bad("foreign half: " + JSON.stringify({ code: result && result.code, sent }));
}

console.log("=== 3) A MISSING VIEW HALF IS REFUSED, NOT INVENTED ===");
{
  const { result, sent } = await startWith("missing");
  if (result && result.code === "quote-field-unbound" && sent === 0) ok("a missing half is named");
  else bad("missing half: " + JSON.stringify({ code: result && result.code, sent }));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "key view: " + pass + " checks passed.");
if (fails.length) process.exit(1);
