// THE NODE'S READY WINDOW, NOT A LOCAL 1200 s.
//
// The maker advertises `readyMinSeconds`/`readyMaxSeconds` in its signed firm features. A sale must use those
// numbers for its wait, its late-arrival boundary and its refund lead; a record without them is refused by name
// rather than filled with the retired local constants.
import { SdkError } from "../src/errors.mjs";
import { createSwaps } from "../src/swaps.mjs";
import { assertTimeForConfirmations } from "../src/xmr-arrival.mjs";
import { readReadyWindow, readyLateSec, readyLeadSec, readyWindowMs } from "../src/readyWindow.mjs";

let passed = 0;
const problems = [];
const ok = (name) => { passed += 1; console.log("  ok    " + name); };
const check = (condition, message) => { if (condition) ok(message); else problems.push(message); };
const expectRefusal = (fn, code, field) => {
  try { fn(); return null; } catch (error) { return { error, code, field }; }
};

// 1. THE WINDOW IS READ AND BOUNDED.
{
  const window = readReadyWindow({ market: "421614:ETH", side: "bid", xmrNetwork: "stagenet",
    readyMinSeconds: 2400, readyMaxSeconds: 3000, settlementMinSeconds: 3600, settlementMaxSeconds: 7200, quoteTtlSeconds: 30 });
  check(window.readyMinSeconds === 2400 && window.readyMaxSeconds === 3000, "the advertised window is kept");
  check(readyWindowMs(window) === (3000 + 300) * 1000, "the wait is the node's maximum plus one margin");
  check(readyLeadSec(window) === 600, "the default 2400..3000 window yields the 600 s refund lead");
  check(readyLeadSec(window, { minConfirmations: 20, blockTimeSec: 120 }) === 600,
    "the refund lead is the window's own headroom, not the confirmation setting");
  check(readyLeadSec({ readyMinSeconds: 3000, readyMaxSeconds: 4200 }) === 1200,
    "a wider node window moves the lead with it");
  check(readyLeadSec({ readyMinSeconds: 2400, readyMaxSeconds: 2400 }) === 0,
    "a window without headroom leaves no early refund reserve");
  check(readyLateSec(window) === 1800, "the same window gives the 1800 s payout margin");
  check(readyLateSec({ readyMinSeconds: 3000, readyMaxSeconds: 4200 }) === 1800,
    "a wider window keeps the payout margin at its minimum minus its headroom");
  const sideMismatch = expectRefusal(() => readReadyWindow(window, { side: "ask" }), "bad-input", "readyWindow");
  check(sideMismatch && sideMismatch.error.code === "bad-input" && sideMismatch.error.params.why === "side",
    "a window for another side is refused");
  const badBounds = expectRefusal(() => readReadyWindow({ readyMinSeconds: 3000, readyMaxSeconds: 2400 }), "bad-input", "readyWindow");
  check(badBounds && badBounds.error.code === "bad-input" && badBounds.error.params.why === "bounds",
    "reversed bounds are refused");
  const missing = expectRefusal(() => readReadyWindow(null), "bad-input", "readyWindow");
  check(missing && missing.error.code === "bad-input" && missing.error.params.why === "missing",
    "a missing window is named, not defaulted");
}

// 2. THE LATE-ARRIVAL BOUNDARY COMES FROM THE NODE, NOT FROM 1200 s.
{
  const now = 1_800_000_000;
  let refusal = null;
  try {
    assertTimeForConfirmations({ readyBySec: now + 1500, nowSec: now, minConfirmations: 10, blockTimeSec: 120,
      minLeadSec: 1800 });
  } catch (error) { refusal = error; }
  check(refusal && refusal.code === "xmr-too-late" && refusal.params.needSec === 1800,
    "less than the node's lead refuses with xmr-too-late and the node's needSec");
  const left = assertTimeForConfirmations({ readyBySec: now + 2000, nowSec: now, minConfirmations: 10, blockTimeSec: 120,
    minLeadSec: 1800 });
  check(left === 2000, "a sale with the node's lead still has time");
}

// 3. THE REFUND LEAD IS THE NODE'S WINDOW. The old 1200 s would have signed a refund here while the maker was
// still inside its 1800 s settlement margin.
const now = 1_800_000_000;
const escrow = "0x" + "aa".repeat(20);
const half = "0x" + "11".repeat(32);
const readyWindow = { side: "bid", readyMinSeconds: 2400, readyMaxSeconds: 3000 };
const refundBase = {
  escrow, halfLocker: half, address: "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq",
  viewSecret: "0x" + "22".repeat(32), spendPub: "0x" + "33".repeat(32),
  expect: { edPointLocker: half, edPointClaimer: half, edViewPointLocker: half, commitHalfLocker: half, commitHalfClaimer: half },
  expectedAtomic: "1", fromHeight: 1, nowSec: now,
  swap: { escrow: { address: escrow, half }, readyWindow },
};
{
  let verified = 0;
  const result = await createSwaps({}).refundIfXmrMissing({ ...refundBase, readyBySec: now + 1000 }, {
    verify: async () => { verified += 1; return { absent: true, seen: false }; },
    refund: async () => { throw new Error("must not refund before the node's lead"); },
    now: () => now,
  });
  check(result.refunded === false && result.state === "waiting" && result.needSec === 600,
    "the old 1200 s refund is held back to the node's 600 s lead");
  check(verified === 0, "a refund before the lead does not even walk the arrival");
}
{
  let verified = 0;
  const result = await createSwaps({}).refundIfXmrMissing({ ...refundBase, readyBySec: now + 1000 }, {
    verify: async () => { verified += 1; return { absent: true, seen: false }; },
    refund: async () => { throw new Error("must not refund before the node's lead"); },
    now: () => now,
  });
  check(result.refunded === false && verified === 0, "the refund holds the whole margin");
}
{
  const missing = await createSwaps({}).refundIfXmrMissing({ ...refundBase, readyBySec: now + 1700, swap: { escrow: { address: escrow, half } } }, {
    verify: async () => ({ absent: true, seen: false }), refund: async () => ({ hash: "0x" }), now: () => now,
  }).catch((error) => error);
  check(missing && missing.code === "bad-input" && missing.params && missing.params.field === "readyWindow",
    "a record without the node's window is refused by name");
}
{
  const missing = await createSwaps({}).sellWatch({ escrow, pollMs: 1 }).catch((error) => error);
  check(missing && missing.code === "bad-input" && missing.params && missing.params.field === "readyWindow"
    && missing.params.why === "not-in-record",
  "a sell watch without the node's window is refused by name");
}

console.log("");
console.log((problems.length ? "FAILURES " + problems.length : "PASSED") + ": " + passed + " checks");
if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  process.exitCode = 1;
}
