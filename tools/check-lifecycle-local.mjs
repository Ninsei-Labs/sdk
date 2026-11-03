#!/usr/bin/env node
// LOCAL LIFECYCLE SCENARIOS - fast, deterministic, no Docker or live chain.
//
// The scheduled local-stand owns the full cross-repository lifecycle. This check owns the SDK-side state that is
// cheap to drive in-process: a sell record survives a restart and a retry, a changed offer is still refused, and
// an unreadable store stops the start before a record is reported as created.
import { createRecoveryKey, takerHalvesV2 } from "../src/recovery-key.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { keccak256, secp256k1 } from "../src/primitives.mjs";
import { createSwaps } from "../src/swaps.mjs";
import { memoryStorage, setStorage } from "../engine/core/store.js";
import { encodeRead, encodeStatus } from "../engine/evm/escrow.js";

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
  id: "oq_lifecycle",
  provider: order.locker,
  factory: order.factory,
  locker: order.locker,
  claimer: order.claimer,
  chainId: order.chainId,
  amount: order.amount,
  xmrAmount: "1000000000000",
  claimTip: "0", commitHalfLocker: "0x" + "a1".repeat(32), edPointLocker: "0x" + "a2".repeat(32), edViewPointLocker: "0x" + "a3".repeat(32),
  edPointClaimer: own.spendPoint,
  commitHalfClaimer: ownCommit,
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

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const bytes = (value) => String(value).replace(/^0x/, "").padStart(64, "0");
const slotReads = {
  [encodeRead("t1")]: word(order.t1),
  [encodeRead("readyBy")]: word(order.readyBy),
  [encodeRead("termsHash")]: "00".repeat(32),
  [encodeRead("edPointLocker")]: bytes(offer.nodeHalf.edPoint),
  [encodeRead("edPointClaimer")]: bytes(quote.edPointClaimer),
  [encodeRead("edViewPointLocker")]: bytes(offer.edViewPointLocker),
  [encodeRead("commitHalfLocker")]: bytes(offer.nodeHalf.commitHalf),
  [encodeRead("commitHalfClaimer")]: bytes(quote.commitHalfClaimer),
  [encodeStatus()]: word(1) + word(0) + word(0) + word(1_000_000_000_000_000_000n),
};
const read = async ({ data }) => {
  const answer = slotReads[data];
  if (!answer) throw new Error("unexpected chain read " + data);
  return "0x" + answer;
};

const problems = [];
const ok = (condition, message) => { if (condition) console.log("  ok    " + message); else problems.push(message); };
const codeOf = async (work) => {
  try { await work(); return null; }
  catch (error) { return error && error.code ? { code: error.code, params: error.params } : { code: null }; }
};

const originalStore = memoryStorage();
setStorage(originalStore);
const firstSwaps = createSwaps({ config: {}, call: read });
let first = null;
try {
  first = await firstSwaps.startSell({ offer, recoveryKey: mnemonic });
  ok(first && first.side === "sell" && first.escrow === escrow, "the first start records the sell");
} catch (error) {
  ok(false, "first start failed: " + JSON.stringify(error && (error.code || error.message)));
}

// A RESTART IS A NEW FACADE OVER THE SAME STORAGE. It must find the durable record and resume it, not create a
// second promise for the same one-time address.
if (first) {
  const restarted = createSwaps({ config: {}, call: read });
  const again = await codeOf(async () => {
    const result = await restarted.startSell({ offer, recoveryKey: mnemonic });
    ok(result.resumed === true && result.id === first.id, "a restarted client resumes the same record");
    const list = await restarted.list();
    ok(list.length === 1, "a restart did not create a second record");
  });
  if (again) ok(false, "restart resume failed: " + JSON.stringify(again));
}

// THE SELL START READS THE ESCROW AND SLOTS IT WILL RELY ON. A golden trace makes the read set explicit: a
// dropped slot read is a guard that no longer checks the order.
{
  setStorage(memoryStorage());
  const trace = [];
  const tracedRead = async ({ data }) => { trace.push(data); return read({ data }); };
  const traced = createSwaps({ config: {}, call: tracedRead });
  try {
    await traced.startSell({ offer, recoveryKey: mnemonic });
    const required = [encodeStatus(), encodeRead("t1"), encodeRead("readyBy"), encodeRead("termsHash"),
      encodeRead("edPointLocker"), encodeRead("edPointClaimer"), encodeRead("edViewPointLocker"),
      encodeRead("commitHalfLocker"), encodeRead("commitHalfClaimer")];
    const missing = required.filter((data) => !trace.includes(data));
    ok(missing.length === 0, "the sell start reads the status, deadlines and every expected slot");
  } catch (error) {
    ok(false, "traced sell start failed: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }
}

// A FAILURE IN THE ESCROW READ IS A REFUSAL BEFORE THE RECORD IS PERSISTED. The person must not see a saved
// send-xmr record for an order the SDK could not check.
{
  setStorage(memoryStorage());
  const failingRead = async ({ data }) => {
    if (data === encodeStatus()) throw new Error("rpc unavailable");
    return read({ data });
  };
  const failed = createSwaps({ config: {}, call: failingRead });
  const got = await codeOf(() => failed.startSell({ offer, recoveryKey: mnemonic }));
  ok(got && got.code === "quote-refused" && got.params && got.params.why === "escrow-unreadable",
    "an unreadable escrow is a named refusal");
  const list = await failed.list();
  ok(list.length === 0, "an unreadable escrow did not leave a send-xmr record");
  setStorage(memoryStorage());
}

// A changed commitment in the same offer is not a retry: it must be refused, not silently resumed.
if (first) {
  setStorage(originalStore);
  const changed = { ...offer, quote: { ...quote, commitHalfClaimer: "0x" + "00".repeat(32) } };
  const got = await codeOf(() => firstSwaps.startSell({ offer: changed, recoveryKey: mnemonic }));
  ok(got && got.code === "quote-refused" && got.params && got.params.why === "offer-changed",
    "a changed offer is refused after a restart");
}

// AN UNREADABLE STORE IS NOT AN EMPTY STORE. The start must name the failure before it can return a record.
{
  setStorage({ get() { throw new Error("denied"); }, set() {}, remove() {} });
  const unreadable = createSwaps({ config: {}, call: read });
  const got = await codeOf(() => unreadable.startSell({ offer, recoveryKey: mnemonic }));
  ok(got && got.code === "storage-unavailable" && got.params && got.params.step === "read",
    "an unreadable store is a named storage refusal");
  setStorage(memoryStorage());
}

if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log("FAILED: " + problems.length + " problem(s)");
  process.exit(1);
}
console.log("PASSED: local sell lifecycle scenarios");
