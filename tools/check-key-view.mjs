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
import { memoryStorage, setStorage } from "../engine/core/store.js";
import { FACTORY_METHODS } from "../engine/evm/factory.js";
import { takerHalves, takerHalvesV2 } from "../src/recovery-key.mjs";
import { markBodyOf } from "../src/swaps.mjs";
import { SDK_VERSION } from "../src/version.mjs";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const addr = (b) => "0x" + b.repeat(20);
const now = Math.floor(Date.now() / 1000);
const order = { chainId: 421614, factory: addr("11"), locker: addr("22"), claimer: addr("33"),
  amount: "1000000000000000000", readyBy: now + 7200, t1: now + 14400, salt: "0x" + "44".repeat(32) };
const maker = buildOwnSideFromHalves(order, { spendHalf: "0x03", viewHalf: "0x04" });
const derived = takerHalves({ mnemonic: WORDS, chainId: 421614, index: 0 });
const derivedV2 = takerHalvesV2({ mnemonic: WORDS, chainId: 421614, factory: order.factory, salt: order.salt });
const makerKey = "0x" + "11".repeat(32);
const pub = primitives.secp256k1.getPublicKey(Buffer.from(makerKey.slice(2), "hex"), false);
const quote = { ...order, provider: order.claimer,
  quoteKey: "0x" + Buffer.from(primitives.keccak256(pub.slice(1)).slice(12)).toString("hex"),
  registry: addr("55"), cashier: addr("66"),
  commitHalfClaimer: halfCommitmentHex(3n, primitives.secp256k1, primitives.keccak256),
  edPointClaimer: maker.spendPoint, feeBps: 0, fee: "0", feeRecipient: addr("77"),
  validUntil: now + 600, nonce: "1", xmrAmount: "1000000000000", claimTip: "0" };
quote.signature = signQuoteDigest({ crypto: primitives, digest: quoteDigest({ crypto: primitives, quote }), privateKey: makerKey });

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

async function startWith(view, v2 = false, salt = order.salt, extra = {}, autoSalt = false) {
  setStorage(memoryStorage());
  let sent = 0;
  const wallet = { address: async () => order.locker,
    send: async () => { sent += 1; throw Object.assign(new Error("stop before broadcast"), { code: "wallet-rejected" }); },
    receipt: async () => null };
  const counterparty = { proof: maker.side.proof, edPointClaimer: maker.spendPoint,
    commitHalfClaimer: quote.commitHalfClaimer, ...extra };
  if (view === "missing") delete counterparty.viewHalfClaimer;
  else counterparty.viewHalfClaimer = view;
  const request = { quote: { id: "q", chain: "arbitrum-sepolia", asset: "ETH", amount: 1, size: 1 }, order, orderQuote: quote,
    counterparty, recoveryKey: WORDS, ...(autoSalt ? {} : (v2 ? { recoverySalt: salt } : { recoveryIndex: 0 })),
    receiveTo: "synthetic-xmr-destination", restoreHeight: 100, wallet, onRecoveryKey: async () => true };
  const result = await createSwaps({ mode: "live", xmrNetwork: "stagenet", logs: async () => [],
    call: async ({ data }) => (data.startsWith(FACTORY_METHODS.predict) ? "0x" + "0".repeat(24) + "88".repeat(20) : "0x"),
  }).start(request).catch((error) => error);
  return { result, sent };
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
  const { result, sent } = await startWith(derivedV2.makerViewHalf, true);
  if (result && result.code === "wallet-rejected" && sent === 1) ok("a v2 salt start reaches the wallet with its own derived half");
  else bad("v2 salt start: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 1b2) A NEW START DEFAULTS TO THE ORDER SALT, NOT A V1 INDEX ===");
{
  const { result, sent } = await startWith(derivedV2.makerViewHalf, false, order.salt, {}, true);
  if (result && result.code === "wallet-rejected" && sent === 1) ok("a start without recoverySalt derives the v2 half from the order salt");
  else bad("default salt start: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 1c) A SALT THE QUOTE DID NOT CARRY IS REFUSED ===");
{
  const { result, sent } = await startWith(derivedV2.makerViewHalf, true, "0x" + "55".repeat(32));
  if (result && result.code === "bad-input" && result.params && result.params.field === "recoverySalt" &&
      result.params.why === "order-salt" && sent === 0) ok("a salt different from order.salt is refused before the wallet");
  else bad("salt mismatch: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

async function startPending() {
  setStorage(memoryStorage());
  let sent = 0;
  const wallet = { address: async () => order.locker,
    send: async () => { sent += 1; return "0x" + "99".repeat(32); },
    receipt: async () => ({ status: "0x1", logs: [], blockNumber: 10 }) };
  const counterparty = { proof: maker.side.proof, edPointClaimer: maker.spendPoint,
    commitHalfClaimer: quote.commitHalfClaimer, viewHalfClaimer: derived.makerViewHalf };
  const request = { quote: { id: "q", chain: "arbitrum-sepolia", asset: "ETH", amount: 1, size: 1 }, order, orderQuote: quote,
    counterparty, recoveryKey: WORDS, recoveryIndex: 0, receiveTo: "synthetic-xmr-destination",
    restoreHeight: 100, wallet, onRecoveryKey: async () => true };
  const result = await createSwaps({ mode: "live", xmrNetwork: "stagenet", logs: async () => [],
    call: async ({ data }) => (data.startsWith(FACTORY_METHODS.predict) ? "0x" + "0".repeat(24) + "88".repeat(20) : "0x"),
  }).start(request).catch((error) => error);
  return { result, sent };
}

console.log("=== 1d) A RECEIPT WITHOUT THE EVENT IS NOT xmr-incoming ===");
{
  const { result, sent } = await startPending();
  if (result && result.code === "funding-pending" && result.params && result.params.txHash && sent === 1) {
    ok("a status-1 receipt with no OrderCreated is funding-pending, not a funded escrow");
  } else bad("pending funding: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 1e) THE MARK BODY NAMES THE SDK LINE ===");
{
  const mark = markBodyOf({ id: "x", network: "n", escrow: {} });
  if (mark.sdkVersion === SDK_VERSION) ok("the mark body carries the SDK version");
  else bad("mark body version: " + JSON.stringify(mark.sdkVersion));
}

console.log("=== 1f) A HALF AND A DIFFERENT POINT ARE REFUSED ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf, false, order.salt, { viewPoint: maker.viewPoint });
  if (result && result.code === "bad-input" && result.params && result.params.why === "view-half-point-mismatch" && sent === 0) {
    ok("a point that is not the half's point is refused");
  } else bad("half/point mismatch: " + JSON.stringify({ code: result && result.code, params: result && result.params, sent }));
}

console.log("=== 1g) CONFLICTING VIEW ALIASES ARE REFUSED ===");
{
  const { result, sent } = await startWith(derived.makerViewHalf, false, order.salt, { viewHalf: "0x05" });
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
