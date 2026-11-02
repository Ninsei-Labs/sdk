// AN ACTION MUST READ THE ORDER BEFORE IT REVEALS A HALF.
//
// A claimed or refunded order has nothing left to sign, and a claim without the ready mark reverts. The slot
// check answers a different question (are these the points and commitments we assembled?); this guard answers
// whether the action is still open.
import { claimOrder, refundOrder, markReadyOrder } from "../src/swap-flow.mjs";
import * as engine from "../src/engine.mjs";

const { encodeStatus, encodeRead } = engine.escrow;
const slot = "0x" + "11".repeat(32);
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const status = (funded, claimed, refunded) => "0x" + [funded, claimed, refunded, 0].map(word).join("");
const expect = { edPointLocker: slot, edPointClaimer: slot, edViewPointLocker: slot, commitHalfLocker: slot, commitHalfClaimer: slot };
const fake = ({ state = status(1, 0, 0), ready = 1 } = {}) => {
  const sent = [];
  const call = async ({ data }) => {
    if (data === encodeStatus()) return state;
    if (data === encodeRead("ready")) return "0x" + word(ready);
    return slot;
  };
  return { sent, call, deps: { call, send: async (tx) => { sent.push(tx); return "0x" + "ab".repeat(32); } } };
};
const why = async (work) => {
  try { await work(); return null; }
  catch (error) { return error && error.params && error.params.why ? error.params.why : (error && error.code); }
};

export const actionStateCheck = async () => {
  const problems = [];
  const closed = status(1, 0, 1);
  const unfunded = status(0, 0, 0);

  for (const [name, state, ready, expected] of [
    ["claim on a refunded order", closed, 1, "closed"],
    ["claim on an unfunded address", unfunded, 1, "closed"],
  ]) {
    const f = fake({ state, ready });
    const got = await why(() => claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps: f.deps }));
    if (got !== expected) problems.push(`${name} answered ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    if (f.sent.length) problems.push(`${name} sent a transaction`);
  }

  // THE READY RULE IS TIME-DEPENDENT AND STAYS ON CHAIN. After `readyBy` the contract allows a claim without the
  // mark; before it, the same transaction reverts with NotReady. The SDK must not turn the time rule into a blanket
  // "not-ready" refusal.
  const claimFake = fake({ ready: 0 });
  const claimed = await claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps: claimFake.deps });
  if (claimFake.sent.length !== 1 || !claimed.hash) problems.push("an open claim without the mark did not send; the time rule belongs to the contract");

  const refundClosed = fake({ state: closed });
  const refundWhy = await why(() => refundOrder({ escrow: "0x" + "aa".repeat(20), halfLocker: slot, expect, deps: refundClosed.deps }));
  if (refundWhy !== "closed" || refundClosed.sent.length) problems.push(`a refund on a closed order answered ${JSON.stringify(refundWhy)}`);

  const refundFake = fake();
  const refunded = await refundOrder({ escrow: "0x" + "aa".repeat(20), halfLocker: slot, expect, deps: refundFake.deps });
  if (refundFake.sent.length !== 1 || !refunded.hash) problems.push("an open refund did not send exactly one transaction");

  const marked = fake({ ready: 1 });
  const markWhy = await why(() => markReadyOrder({ escrow: "0x" + "aa".repeat(20), expect, deps: marked.deps }));
  if (markWhy !== "already-ready" || marked.sent.length) problems.push(`a second ready mark answered ${JSON.stringify(markWhy)}`);
  const markFake = fake({ ready: 0 });
  const mark = await markReadyOrder({ escrow: "0x" + "aa".repeat(20), expect, deps: markFake.deps });
  if (markFake.sent.length !== 1 || !mark.hash) problems.push("an open ready mark did not send exactly one transaction");

  return { note: "claim, refund and mark-ready refuse a closed order; the claim time rule stays on chain",
    problems, notes: problems.length ? [] : ["state is read before the half is signed; mark-ready checks ready"] };
};
