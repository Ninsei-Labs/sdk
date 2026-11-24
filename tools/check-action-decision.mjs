#!/usr/bin/env node
// ONE DECISION FOR EVERY SWAP ACTION.
//
// The function under test is pure: the escrow read's block time and the device time are inputs, and no branch
// calls Date.now(). The table below is the contract the site, the recovery page and the SDK paths must share.
import { actionDecision } from "../src/action-decision.mjs";

const problems = [];
const check = (condition, message, detail = null) => {
  if (condition) console.log("  ok    " + message);
  else problems.push(detail ? `${message}: ${JSON.stringify(detail)}` : message);
};
const equal = (got, want, message) => check(got === want, message, { got, want });

const READY_BY = 1_800_000_000;
const T1 = READY_BY + 3_600;
const BLOCK = 1_799_900_000;

const escrow = (overrides = {}) => ({
  status: { isFunded: true, isClaimed: false, isRefunded: false, balance: 1n },
  ready: false,
  readyBy: READY_BY,
  t1: T1,
  block: { number: 1_000, hash: "0x" + "11".repeat(32), timestamp: BLOCK },
  ...overrides,
});
const arrived = (overrides = {}) => ({ seen: true, state: "arrived", txid: "aa".repeat(32), amountAtomic: "1000",
  amountRule: "exact", amountComparison: "exact", confirmations: 10, needConfirmations: 10, ...overrides });
const short = () => ({ seen: false, state: "short", txid: "bb".repeat(32), amountAtomic: "700",
  amountRule: "exact", amountComparison: "short" });
const locked = () => ({ seen: false, state: "locked", txid: "cc".repeat(32), amountAtomic: "1000",
  amountRule: "exact", amountComparison: "exact" });
const absent = () => ({ seen: false, state: "pending", absent: true, txid: null, amountAtomic: "0",
  amountRule: "exact", amountComparison: "short", completedOperators: ["a", "b"] });
const pending = () => ({ seen: false, state: "confirming", txid: "dd".repeat(32), amountAtomic: "1000",
  amountRule: "exact", amountComparison: "exact", confirmations: 2, needConfirmations: 10 });
const unknown = () => ({ seen: false, state: "unknown", txid: null, amountAtomic: "0", amountRule: "exact" });
const oneNode = () => ({ seen: false, state: "one-node", txid: "ee".repeat(32), amountAtomic: "1000",
  amountRule: "exact", amountComparison: "exact" });

const decide = (request) => actionDecision({
  side: "buy",
  escrow: escrow(),
  arrival: unknown(),
  deviceTimeSec: BLOCK,
  refundLeadSec: 780,
  saleLeadSec: 1_200,
  ...request,
});

console.log("=== 0) INPUTS ARE EXPLICIT ===");
{
  let refused = null;
  try { actionDecision({ side: "hold", escrow: escrow(), deviceTimeSec: BLOCK }); }
  catch (error) { refused = error; }
  check(refused && refused.code === "bad-input" && refused.params.field === "side",
    "an unknown side is refused", refused && refused.params);
  refused = null;
  try { decide({ deviceTimeSec: undefined }); }
  catch (error) { refused = error; }
  check(refused && refused.code === "bad-input" && refused.params.field === "deviceTimeSec",
    "a missing device time is refused", refused && refused.params);
  equal(decide({ escrow: null }).action, "unknown", "an unreadable escrow is unknown");
}

console.log("=== 1) A CLOSED OR UNFUNDED ORDER HAS NO ACTION ===");
{
  equal(decide({ escrow: escrow({ status: { isFunded: true, isClaimed: true, isRefunded: false, balance: 0n } }) }).reason,
    "closed", "a claimed order is closed");
  equal(decide({ escrow: escrow({ status: { isFunded: true, isClaimed: false, isRefunded: true, balance: 0n } }) }).reason,
    "closed", "a refunded order is closed");
  equal(decide({ escrow: escrow({ status: { isFunded: false, isClaimed: false, isRefunded: false, balance: 0n } }) }).reason,
    "not-funded", "an unfunded order has no action");
  equal(decide({ escrow: escrow({ readyBy: T1, t1: READY_BY }) }).reason, "bad-deadlines",
    "deadlines in the wrong order are refused as unknown");
}

console.log("=== 2) BUY: A VERIFIED ARRIVAL IS MARKED READY BEFORE THE MARGIN ===");
{
  const at = READY_BY - 1_000;
  const result = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: arrived(), deviceTimeSec: at });
  equal(result.action, "markReady", "an arrived buy is marked ready");
  equal(result.untilSec, READY_BY - 60, "the mark deadline is the protective margin before readyBy");
  equal(result.reason, "arrival-verified", "the mark names the verified arrival");
  const closed = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 60 } }), arrival: arrived(), deviceTimeSec: READY_BY - 60 });
  equal(closed.action, "none", "the mark closes at the margin boundary");
  equal(closed.reason, "ready-window-closed", "the closed mark names its reason");
}

console.log("=== 3) BUY: SHORT OR LOCKED XMR OPENS THE EARLY REFUND ===");
{
  const at = READY_BY - 2_000;
  const result = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: short(), deviceTimeSec: at });
  equal(result.action, "refund", "a short payment is refundable early");
  equal(result.reason, "arrival-short", "the short refund names the amount");
  equal(result.untilSec, READY_BY - 180, "the early refund deadline is the protective margin");
  const lockedResult = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: locked(), deviceTimeSec: at });
  equal(lockedResult.action, "refund", "a locked payment is refundable early");
  equal(lockedResult.reason, "arrival-locked", "the locked refund names the lock");
}

console.log("=== 4) BUY: AN UNKNOWN OR ABSENT READ WAITS FOR THE REFUND WINDOW ===");
{
  const early = READY_BY - 2_000;
  const waiting = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: early } }), arrival: absent(), deviceTimeSec: early });
  equal(waiting.action, "later", "absence far from readyBy waits");
  equal(waiting.untilSec, READY_BY - 780, "the wait names when the refund window opens");
  equal(waiting.reason, "refund-window-opens", "the wait names the opening");
  const near = READY_BY - 700;
  const offered = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: near } }), arrival: unknown(), deviceTimeSec: near });
  equal(offered.action, "refund", "an unknown read in the warning window is offered as a refund");
  equal(offered.reason, "refund-window", "the offer names the unknown read");
  equal(offered.read, "unknown", "the offer keeps the read uncertainty visible");
  const absentFlag = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: near } }), arrival: { ...absent(), state: "unknown" }, deviceTimeSec: near });
  equal(absentFlag.read, "complete", "an explicit absent flag stays a complete read");
}

console.log("=== 5) BUY: THE DEVICE CLOCK ONLY NARROWS THE EARLY WINDOW ===");
{
  const block = READY_BY - 300;
  const result = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: block } }), arrival: unknown(), deviceTimeSec: READY_BY - 100 });
  equal(result.action, "none", "a device clock 200 s ahead closes the early refund");
  equal(result.reason, "refund-margin", "the closed window names the margin");
  const farAhead = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 2_000 } }), arrival: unknown(), deviceTimeSec: READY_BY - 100 });
  equal(farAhead.action, "none", "a device clock ahead closes the window even before the block reaches it");
  const behind = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 700 } }), arrival: unknown(), deviceTimeSec: READY_BY - 1_400 });
  equal(behind.action, "refund", "a device clock behind does not delay the opening");
}

console.log("=== 6) BUY: THE READY MARK CLOSES THE EARLY REFUND AND THE CLAIM WINDOW OPENS ===");
{
  const at = READY_BY - 900;
  const marked = decide({ escrow: escrow({ ready: true, block: { ...escrow().block, timestamp: at } }), arrival: short(), deviceTimeSec: at });
  equal(marked.action, "none", "a ready-marked order has no early refund");
  equal(marked.reason, "ready-marked", "the refusal names the ready mark");
  const inWindow = READY_BY + 10;
  const claimWindow = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: inWindow } }), arrival: arrived(), deviceTimeSec: inWindow });
  equal(claimWindow.action, "none", "after readyBy the buyer has no action");
  equal(claimWindow.reason, "claim-window", "the buy names the claim window");
}

console.log("=== 7) BUY: THE LATE REFUND OPENS ON THE READ BLOCK, NOT THE DEVICE ===");
{
  const before = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: T1 - 1 } }), arrival: unknown(), deviceTimeSec: T1 });
  equal(before.action, "none", "a device clock at t1 does not open a late refund");
  const at = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: T1 } }), arrival: unknown(), deviceTimeSec: T1 - 500 });
  equal(at.action, "refund", "a read block at t1 opens the late refund");
  equal(at.reason, "late-refund", "the late refund names the time");
  equal(at.untilSec, null, "the late refund has no closing time");
}

console.log("=== 8) SALE: SEND XMR UNTIL THE NODE'S DEADLINE ===");
{
  const at = READY_BY - 2_000;
  const send = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: unknown(), deviceTimeSec: at });
  equal(send.action, "sendXmr", "a sale before its send deadline may send");
  equal(send.untilSec, READY_BY - 1_200, "the send deadline is readyBy less the node's lead");
  equal(send.reason, "send-window", "the send names its window");
  const edge = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 1_200 } }), arrival: unknown(), deviceTimeSec: READY_BY - 1_200 });
  equal(edge.action, "later", "the deadline second is not a send");
  equal(edge.reason, "claim-window-opens", "the seller waits for readyBy after the send deadline");
  const oneBefore = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 1_201 } }), arrival: unknown(), deviceTimeSec: READY_BY - 1_201 });
  equal(oneBefore.action, "sendXmr", "one second before the deadline is still open");
  const at1500 = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 1_500 } }), arrival: unknown(), deviceTimeSec: READY_BY - 1_500 });
  equal(at1500.action, "sendXmr", "1500 s left is open with a 1200 s lead");
  const at1500LongLead = decide({ side: "sale", saleLeadSec: 1_800, escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 1_500 } }), arrival: unknown(), deviceTimeSec: READY_BY - 1_500 });
  equal(at1500LongLead.action, "later", "1500 s left is closed with an 1800 s lead");
  const alreadyThere = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 2_000 } }), arrival: arrived(), deviceTimeSec: READY_BY - 2_000 });
  equal(alreadyThere.action, "later", "an exact arrival already at the address is not sent twice");
  equal(alreadyThere.reason, "claim-window-opens", "the seller waits for readyBy after the exact arrival");
}

console.log("=== 9) SALE: READY MARK ALLOWS A CLAIM WITHOUT A MONERO READ ===");
{
  const at = READY_BY - 500;
  const result = decide({ side: "sale", escrow: escrow({ ready: true, block: { ...escrow().block, timestamp: at } }), arrival: unknown(), deviceTimeSec: at });
  equal(result.action, "claim", "a ready-marked sale claims even when Monero is unknown");
  equal(result.untilSec, T1 - 60, "the claim deadline is the settlement margin");
  equal(result.reason, "claim-ready", "the claim names the ready mark");
  equal(result.action === "claim", true, "the claim is allowed before readyBy when marked");
}

console.log("=== 10) SALE: NO MARK AFTER readyBy NEEDS THE EXACT ARRIVAL ===");
{
  const at = READY_BY + 10;
  const seen = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: arrived(), deviceTimeSec: at });
  equal(seen.action, "claim", "an exact arrival opens the unmarked claim");
  equal(seen.reason, "claim-proof", "the claim names the proof");
  const unknownRead = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: unknown(), deviceTimeSec: at });
  equal(unknownRead.action, "unknown", "an unknown arrival cannot open the unmarked claim");
  equal(unknownRead.reason, "arrival-unknown", "the refusal names the unknown read");
  const shortRead = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: short(), deviceTimeSec: at });
  equal(shortRead.action, "none", "a short arrival cannot claim");
  equal(shortRead.reason, "claim-not-proven", "the refusal names the missing proof");
}

console.log("=== 11) SALE: THE CLAIM MARGIN AND t1 ARE BOTH CLOSED ===");
{
  const margin = decide({ side: "sale", escrow: escrow({ ready: true, block: { ...escrow().block, timestamp: T1 - 60 } }), deviceTimeSec: T1 - 60, arrival: arrived() });
  equal(margin.action, "none", "the claim closes at the settlement margin");
  equal(margin.reason, "claim-margin", "the refusal names the margin");
  const end = decide({ side: "sale", escrow: escrow({ ready: true, block: { ...escrow().block, timestamp: T1 } }), deviceTimeSec: T1, arrival: arrived() });
  equal(end.action, "none", "the claim closes at t1");
  equal(end.reason, "claim-window-closed", "the refusal names the closed window");
}

console.log("=== 12) A POOL-ONLY OR ONE-OPERATOR READ IS NEVER CALLED ARRIVED ===");
{
  const at = READY_BY - 700;
  for (const [name, arrival] of [["pool", { ...unknown(), state: "pool", txid: "ff".repeat(32) }], ["one-node", oneNode()]]) {
    const result = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival, deviceTimeSec: at });
    check(result.action === "refund" && result.read === "unknown", `${name} is an unknown refund offer`, result);
  }
  const confirming = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: pending(), deviceTimeSec: at });
  equal(confirming.action, "later", "a full amount still accruing confirmations is not refunded");
  equal(confirming.reason, "confirmations", "the wait names the confirmations");
  equal(confirming.read, "unknown", "a confirming read is not yet complete");
  const sale = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY + 10 } }), arrival: oneNode(), deviceTimeSec: READY_BY + 10 });
  equal(sale.action, "unknown", "a one-operator sale cannot claim");
}

console.log("=== 13) THE PAIRED UNKNOWN SALE: READY MARK VERSUS NO MARK ===");
{
  const at = READY_BY - 500;
  const marked = decide({ side: "sale", escrow: escrow({ ready: true, block: { ...escrow().block, timestamp: at } }), arrival: unknown(), deviceTimeSec: at });
  const unmarked = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY + 10 } }), arrival: unknown(), deviceTimeSec: READY_BY + 10 });
  equal(marked.action, "claim", "the same unknown read claims when Ready is set");
  equal(unmarked.action, "unknown", "without Ready after readyBy the unknown read gives no claim");
  const deviceAtSendDeadline = decide({ side: "sale", escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY - 1_300 } }), arrival: unknown(), deviceTimeSec: READY_BY - 1_200 });
  equal(deviceAtSendDeadline.action, "later", "a device clock at the send deadline closes the send even when the block is earlier");
  const markedAtClaimMargin = decide({ side: "sale", escrow: escrow({ ready: true, block: { ...escrow().block, timestamp: READY_BY } }), arrival: unknown(), deviceTimeSec: T1 - 60 });
  equal(markedAtClaimMargin.action, "none", "a device clock at the claim margin closes a marked claim");
}

console.log("=== 14) THE TWO BUY STATES THAT MUST STAY APART ===");
{
  const at = READY_BY - 700;
  const seen = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: pending(), deviceTimeSec: at });
  const one = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: oneNode(), deviceTimeSec: at });
  equal(seen.action, "later", "both nodes seeing the full amount is not a refund");
  equal(one.action, "refund", "one node seeing the amount is an offered refund");
  const over = decide({ escrow: escrow({ block: { ...escrow().block, timestamp: at } }), arrival: arrived({ state: "over", amountComparison: "over" }), deviceTimeSec: at });
  equal(over.action, "markReady", "an overpayment on a buy is still a ready mark");
}

console.log("=== 15) THE BOUNDARIES ARE THE CONTRACT'S, NOT ROUNDED ===");
{
  const at = (offset) => decide({ escrow: escrow({ block: { ...escrow().block, timestamp: READY_BY + offset } }), arrival: unknown(), deviceTimeSec: READY_BY + offset });
  equal(at(-781).action, "later", "781 s before readyBy is before the refund window");
  equal(at(-780).action, "refund", "780 s before readyBy opens the refund window");
  equal(at(-181).action, "refund", "181 s before readyBy is still inside the early window");
  equal(at(-180).action, "none", "180 s before readyBy closes the early window");
  equal(at(-1).action, "none", "the last second before readyBy has no early refund");
  equal(at(0).action, "none", "readyBy itself is the claim window");
  equal(at(1).action, "none", "one second after readyBy is the claim window");
}

if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log("FAILED: " + problems.length + " problem(s)");
  process.exit(1);
}
console.log("action decision: " + "checks passed");
