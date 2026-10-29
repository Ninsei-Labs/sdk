#!/usr/bin/env node
// A SELL HAS A RECORD BEFORE THE PERSON SENDS XMR.
//
// `startSell` takes the verified relay offer, derives the same half the offer names, and stores the one-time
// address, escrow, half and expectations. A retry of the same offer returns the same record; a mismatched
// commitment is refused. Nothing is sent here.
import { createRecoveryKey, takerHalvesV2 } from "../src/recovery-key.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { keccak256, secp256k1 } from "../src/primitives.mjs";
import { createSwaps } from "../src/swaps.mjs";

const order = {
  chainId: 421614,
  factory: "0x" + "11".repeat(20),
  locker: "0x" + "a1".repeat(20),
  claimer: "0x" + "b2".repeat(20),
  amount: "1000000000000000000",
  readyBy: 1_800_000_000,
  t1: 1_800_003_600,
  salt: "0x" + "44".repeat(32),
  asset: "ETH",
};
const mnemonic = createRecoveryKey().mnemonic;
const derived = takerHalvesV2({ mnemonic, chainId: order.chainId, factory: order.factory, salt: order.salt });
const own = buildOwnSideFromHalves(order, { spendHalf: derived.spendHalf, viewHalf: derived.viewHalf });
const ownCommit = "0x" + Buffer.from(keccak256(secp256k1.Point.fromHex(own.side.proof.XA).toBytes(false).slice(1))).toString("hex");
const escrow = "0x" + "dd".repeat(20);
const quote = {
  id: "oq_sell_record", provider: order.locker, factory: order.factory,
  locker: order.locker, claimer: order.claimer, chainId: order.chainId,
  amount: order.amount, xmrAmount: "1000000000000", claimTip: "0",
  edPointClaimer: own.spendPoint, commitHalfClaimer: ownCommit,
};
const offer = {
  order,
  quote,
  orderQuote: { ...quote, signature: "0x" + "55".repeat(65) },
  nodeHalf: { commitHalf: "0x" + "77".repeat(32), edPoint: "0x" + "88".repeat(32) },
  edViewPointClaimer: own.viewPoint,
  edViewPointLocker: "0x" + "99".repeat(32),
  jointAddress: "52TsoaDECj3P6WFzmChWEq6WMLf9gYp831b76bRNzFN4EMDgNXuxDQXY8hRcmncmMMF3o5bYqFeTEbzPQ3joqdABAeGwY3z",
  escrow,
  context: "sell-record",
  recovery: { kind: "salt-v2", salt: order.salt },
  viewHalfClaimer: derived.makerViewHalf,
};
const problems = [];
const check = (condition, message) => { if (condition) console.log("  ok    " + message); else problems.push(message); };

const swaps = createSwaps({ config: {} });
try {
  const first = await swaps.startSell({ offer, recoveryKey: mnemonic });
  check(first.side === "sell" && first.escrow === escrow && first.address === offer.jointAddress,
    "the record carries the escrow and the one-time address");
  check(first.xmrAmount === quote.xmrAmount && first.next === "send-xmr", "the amount and the next step are named");
  const again = await swaps.startSell({ offer, recoveryKey: mnemonic });
  check(again.resumed === true && again.id === first.id, "the same offer resumes the same record");
} catch (error) {
  check(false, "startSell failed: " + JSON.stringify(error && (error.code || error.message)) + " " + JSON.stringify(error && error.params));
}

try {
  await swaps.startSell({ offer: { ...offer, quote: { ...quote, commitHalfClaimer: "0x" + "00".repeat(32) } }, recoveryKey: mnemonic });
  check(false, "a changed offer passed a retry");
} catch (error) {
  check(error && error.code === "quote-refused" && error.params && error.params.why === "offer-changed",
    "a changed offer is refused instead of resumed");
}

try {
  const other = { ...offer, quote: { ...quote, id: "oq_sell_other", commitHalfClaimer: "0x" + "00".repeat(32) },
    escrow: "0x" + "ee".repeat(20), jointAddress: "5" + "A".repeat(94) };
  await swaps.startSell({ offer: other, recoveryKey: mnemonic });
  check(false, "a foreign commitment passed");
} catch (error) {
  check(error && error.code === "quote-refused" && error.params && error.params.why === "commitment",
    "a foreign commitment is refused");
}

if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log("FAILED: " + problems.length + " problem(s)");
  process.exit(1);
}
console.log("PASSED: a sell record is made from the verified offer and survives a retry");
