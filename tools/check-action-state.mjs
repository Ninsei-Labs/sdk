// AN ACTION MUST READ THE ORDER BEFORE IT REVEALS A HALF.
//
// A claimed or refunded order has nothing left to sign, and a claim without the ready mark reverts. The slot
// check answers a different question (are these the points and commitments we assembled?); this guard answers
// whether the action is still open.
import { claimOrder, refundOrder, markReadyOrder } from "../src/swap-flow.mjs";
import * as engine from "../src/engine.mjs";

const { encodeStatus, encodeRead, encodeClaim, encodeRefund, encodeMarkReady } = engine.escrow;
const slot = "0x" + "11".repeat(32);
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const status = (funded, claimed, refunded) => "0x" + [funded, claimed, refunded, 0].map(word).join("");
const expect = { edPointLocker: slot, edPointClaimer: slot, edViewPointLocker: slot, commitHalfLocker: slot, commitHalfClaimer: slot };
const fake = ({ state = status(1, 0, 0), ready = 1, now = 1000, readyBy = 2000, t1 = 3000, clock = true, revertAction = null } = {}) => {
  const sent = [];
  const call = async ({ data }) => {
    if (revertAction && data === revertAction) throw new Error("execution reverted: simulation");
    if (data === encodeStatus()) return state;
    if (data === encodeRead("ready")) return "0x" + word(ready);
    if (data === encodeRead("readyBy")) return "0x" + word(readyBy);
    if (data === engine.escrow.encodeT1()) return "0x" + word(t1);
    if (data === engine.escrow.encodeTermsHash()) return slot;
    return slot;
  };
  return { sent, call, deps: { call,
    send: async (tx) => { sent.push(tx); return "0x" + "ab".repeat(32); },
    blockTime: async () => (clock ? now : null) } };
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
  const claimFake = fake({ ready: 1 });
  const claimed = await claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps: claimFake.deps });
  if (claimFake.sent.length !== 1 || !claimed.hash) problems.push("an open claim after readyBy did not send");
  const tooEarly = fake({ ready: 0, now: 1500, readyBy: 2000, t1: 3000 });
  const tooEarlyWhy = await why(() => claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps: tooEarly.deps }));
  if (tooEarlyWhy !== "not-ready" || tooEarly.sent.length) problems.push(`a claim before readyBy without the mark answered ${JSON.stringify(tooEarlyWhy)}`);
  const afterT1 = fake({ ready: 1, now: 3000, readyBy: 2000, t1: 3000 });
  const afterT1Why = await why(() => claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps: afterT1.deps }));
  if (afterT1Why !== "window-closed" || afterT1.sent.length) problems.push(`a claim at t1 answered ${JSON.stringify(afterT1Why)}`);

  const refundClosed = fake({ state: closed });
  const refundWhy = await why(() => refundOrder({ escrow: "0x" + "aa".repeat(20), halfLocker: slot, expect, deps: refundClosed.deps }));
  if (refundWhy !== "closed" || refundClosed.sent.length) problems.push(`a refund on a closed order answered ${JSON.stringify(refundWhy)}`);

  const refundFake = fake({ ready: 0 });
  const refunded = await refundOrder({ escrow: "0x" + "aa".repeat(20), halfLocker: slot, expect, deps: refundFake.deps });
  if (refundFake.sent.length !== 1 || !refunded.hash) problems.push("an open refund did not send exactly one transaction");
  const deadZone = fake({ ready: 0, now: 2500, readyBy: 2000, t1: 3000 });
  const deadWhy = await why(() => refundOrder({ escrow: "0x" + "aa".repeat(20), halfLocker: slot, expect, deps: deadZone.deps }));
  if (deadWhy !== "too-early" || deadZone.sent.length) problems.push(`a refund between readyBy and t1 answered ${JSON.stringify(deadWhy)}`);

  const marked = fake({ ready: 1 });
  const markWhy = await why(() => markReadyOrder({ escrow: "0x" + "aa".repeat(20), expect, deps: marked.deps }));
  if (markWhy !== "already-ready" || marked.sent.length) problems.push(`a second ready mark answered ${JSON.stringify(markWhy)}`);
  const markFake = fake({ ready: 0 });
  const mark = await markReadyOrder({ escrow: "0x" + "aa".repeat(20), expect, deps: markFake.deps });
  if (markFake.sent.length !== 1 || !mark.hash) problems.push("an open ready mark did not send exactly one transaction");
  const lateMark = fake({ ready: 0, now: 2000, readyBy: 2000, t1: 3000 });
  const lateWhy = await why(() => markReadyOrder({ escrow: "0x" + "aa".repeat(20), expect, deps: lateMark.deps }));
  if (lateWhy !== "ready-window-closed" || lateMark.sent.length) problems.push(`a mark at readyBy answered ${JSON.stringify(lateWhy)}`);

  // A CLOCK THAT CANNOT BE READ CANNOT PROVE A WINDOW; THE HALF MUST STAY UNREVEALED.
  for (const [name, work, ready] of [
    ["claim", (deps) => claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps }), 1],
    ["refund", (deps) => refundOrder({ escrow: "0x" + "aa".repeat(20), halfLocker: slot, expect, deps }), 0],
    ["mark-ready", (deps) => markReadyOrder({ escrow: "0x" + "aa".repeat(20), expect, deps }), 0],
  ]) {
    const f = fake({ ready, clock: false });
    const got = await why(() => work(f.deps));
    if (got !== "clock-unreadable" || f.sent.length) problems.push(`${name} with no clock answered ${JSON.stringify(got)} and sent ${f.sent.length}`);
  }

  {
    const inMargin = fake({ ready: 1, now: 2950, readyBy: 2000, t1: 3000 });
    const got = await why(() => claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps: inMargin.deps }));
    if (got !== "window-closed" || inMargin.sent.length) problems.push(`a claim inside the t1 margin answered ${JSON.stringify(got)} and sent ${inMargin.sent.length}`);
  }

  // A SEND LANDS IN A LATER BLOCK: THE LAST MINUTE BEFORE EACH DEADLINE IS NOT A SAFE WINDOW.
  for (const [name, work, ready, expected] of [
    ["claim", (deps) => claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps }), 0, "not-ready"],
    ["refund", (deps) => refundOrder({ escrow: "0x" + "aa".repeat(20), halfLocker: slot, expect, deps }), 0, "too-early"],
    ["mark-ready", (deps) => markReadyOrder({ escrow: "0x" + "aa".repeat(20), expect, deps }), 0, "ready-window-closed"],
  ]) {
    const f = fake({ ready, now: 1950, readyBy: 2000, t1: 3000 });
    const got = await why(() => work(f.deps));
    if (got !== expected || f.sent.length) problems.push(`${name} inside the margin answered ${JSON.stringify(got)} and sent ${f.sent.length}`);
  }

  // A SIMULATION REVERT MUST NOT BECOME A SENT TRANSACTION. The guards above are a subset of the contract's
  // rules; the eth_call is the part that answers with the contract itself.
  for (const [name, work, revertAction, ready] of [
    ["claim", (deps) => claimOrder({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, expect, deps }), encodeClaim(slot), 1],
    ["refund", (deps) => refundOrder({ escrow: "0x" + "aa".repeat(20), halfLocker: slot, expect, deps }), encodeRefund(slot), 0],
    ["mark-ready", (deps) => markReadyOrder({ escrow: "0x" + "aa".repeat(20), expect, deps }), encodeMarkReady(), 0],
  ]) {
    const f = fake({ ready, revertAction });
    const got = await why(() => work(f.deps));
    if (got !== "simulation" || f.sent.length) problems.push(`${name} simulation revert answered ${JSON.stringify(got)} and sent ${f.sent.length}`);
  }

  return { note: "claim, refund and mark-ready check the order and the chain clock before signing",
    problems, notes: problems.length ? [] : ["closed, ready and deadline states are read before the half is signed"] };
};
