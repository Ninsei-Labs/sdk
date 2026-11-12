#!/usr/bin/env node
// THE SELL WAIT READS THE ESCROW ITSELF.
//
// The client sends XMR to the joint address; the node (the locker) marks the order ready before the claimer may
// take the ETH. This check drives the real `swaps.sellWatch` against a synthetic status()/ready() reader: no
// backend, no signature, no guessed address.
import * as engine from "../src/engine.mjs";
import { createSwaps, sellWatchTimeoutMs } from "../src/swaps.mjs";

const escrow = "0x" + "a1".repeat(20);
const status = (funded, claimed, refunded, balance = 0n) => "0x"
  + [funded, claimed, refunded].map((v) => (v ? "1" : "0").padStart(64, "0")).join("")
  + balance.toString(16).padStart(64, "0");
const word = (v) => "0x" + v.toString(16).padStart(64, "0");
const problems = [];
const check = (condition, message) => { if (condition) console.log("  ok    " + message); else problems.push(message); };

function swapsWith(reader, options = {}) {
  return createSwaps({ config: {}, call: reader, ...options });
}

console.log("=== 0) THE DEFAULT WAIT COVERS THE READY DEADLINE ===");
{
  const now = 1_700_000_000;
  const short = sellWatchTimeoutMs({ configuredMs: 1_200_000, readyBySec: now + 600, nowSec: now });
  check(short === 1_200_000, "a short deadline did not keep the configured floor");
  const long = sellWatchTimeoutMs({ configuredMs: 1_200_000, readyBySec: now + 1_800, nowSec: now });
  check(long === (1_800 + 300) * 1000, "a later readyBy did not extend the sell wait: " + long);
}

console.log("=== 1) FUNDED AND READY ===");
let polls = 0;
try {
  const quotes = swapsWith(async ({ data }) => {
    if (data === engine.evm.ESCROW_METHODS.status) {
      polls += 1;
      return status(true, false, false, 1_000_000n);
    }
    if (data === engine.evm.ESCROW_METHODS.ready) return word(polls >= 2 ? 1n : 0n);
    throw new Error("unexpected selector " + data);
  });
  const result = await quotes.sellWatch({ escrow, pollMs: 1, timeoutMs: 2_000 });
  check(result.state === "ready" && result.ready === true && result.funded === true, "a funded, ready order returns ready");
  check(result.balanceWei === "1000000", "the escrow balance is returned");
  check(polls >= 2, "the wait polls until the ready mark");
} catch (error) { check(false, "ready path failed: " + JSON.stringify(error && (error.code || error.message))); }

console.log("=== 2) TERMINAL STATES END THE WAIT ===");
for (const [claimed, refunded, state] of [[true, false, "claimed"], [false, true, "refunded"]]) {
  try {
    let statusCalls = 0;
    const quotes = swapsWith(async ({ data }) => {
      if (data === engine.evm.ESCROW_METHODS.status) { statusCalls += 1; return status(true, claimed, refunded, 0n); }
      throw new Error("ready must not be asked for a terminal order " + data);
    });
    const result = await quotes.sellWatch({ escrow, pollMs: 1, timeoutMs: 1_000 });
    check(result.state === state && statusCalls === 1, "a " + state + " order ends the wait without reading ready");
  } catch (error) { check(false, state + " path failed: " + JSON.stringify(error && (error.code || error.message))); }
}

// The reader deliberately throws on readyBy/t1 here: the deadline read fails, so this is a timeout and not a
// claim-open scenario. A future mock that answers those selectors would turn this case into claim-open.
console.log("=== 3) A WAIT THAT EXPIRES IS NAMED ===");
try {
  const quotes = swapsWith(async ({ data }) => {
    if (data === engine.evm.ESCROW_METHODS.status) return status(true, false, false, 1n);
    if (data === engine.evm.ESCROW_METHODS.ready) return word(0n);
    throw new Error("unexpected selector " + data);
  });
  await quotes.sellWatch({ escrow, pollMs: 1, timeoutMs: 2 });
  check(false, "an unready order passed");
} catch (error) {
  check(error && error.code === "sell-timeout" && error.params && error.params.escrow === escrow,
    "an unready order ends with sell-timeout");
}

console.log("=== 4) THE CLAIM OPENS AT readyBy WITHOUT A MARK ===");
try {
  const readyBy = 1_700_000_000;
  let calls = 0;
  const reader = async ({ data }) => {
    calls += 1;
    if (data === engine.evm.ESCROW_METHODS.status) return status(true, false, false, 5n);
    if (data === engine.evm.ESCROW_METHODS.ready) return word(0n);
    if (data === engine.evm.ESCROW_METHODS.readyBy) return word(BigInt(readyBy));
    if (data === engine.evm.ESCROW_METHODS.t1) return word(BigInt(readyBy + 3_600));
    if (data === engine.evm.ESCROW_METHODS.termsHash) return "0x" + "00".repeat(32);
    throw new Error("unexpected selector " + data);
  };
  const result = await swapsWith(reader, { now: () => (readyBy + 1) * 1000 })
    .sellWatch({ escrow, pollMs: 1, timeoutMs: 2_000 });
  check(result.state === "claim-open" && result.claimOpen === true && result.ready === false,
    "a funded order past readyBy reports the open claim");
  check(result.t1 === readyBy + 3_600 && result.secondsLeft === 3_599,
    "the open claim carries t1 and the seconds left");
  check(calls >= 1, "the open claim needs no extra wait");
} catch (error) { check(false, "claim-open path failed: " + JSON.stringify(error && (error.code || error.message))); }

console.log("=== 4a) THE CLAIM WINDOW CLOSES AT t1 ===");
for (const [label, at] of [["at t1", 1_700_003_600], ["inside the last minute", 1_700_003_570]]) {
  try {
    const readyBy = 1_700_000_000;
    const t1 = 1_700_003_600;
    const reader = async ({ data }) => {
      if (data === engine.evm.ESCROW_METHODS.status) return status(true, false, false, 5n);
      if (data === engine.evm.ESCROW_METHODS.ready) return word(0n);
      if (data === engine.evm.ESCROW_METHODS.readyBy) return word(BigInt(readyBy));
      if (data === engine.evm.ESCROW_METHODS.t1) return word(BigInt(t1));
      if (data === engine.evm.ESCROW_METHODS.termsHash) return "0x" + "00".repeat(32);
      throw new Error("unexpected selector " + data);
    };
    const result = await swapsWith(reader, { now: () => at * 1000 })
      .sellWatch({ escrow, pollMs: 1, timeoutMs: 2_000 });
    check(result.state === "claim-window-closed" && result.claimOpen === false && result.ready === false,
      label + " does not report an open claim");
    check(result.secondsLeft === Math.max(0, t1 - at),
      label + " carries the seconds left at the closed window");
  } catch (error) { check(false, label + " path failed: " + JSON.stringify(error && (error.code || error.message))); }
}

console.log("=== 5) THE ADDRESS IS REQUIRED ===");
try {
  await swapsWith(async () => word(0n)).sellWatch({ pollMs: 1, timeoutMs: 1 });
  check(false, "a missing escrow passed");
} catch (error) {
  check(error && error.code === "bad-input" && error.params && error.params.field === "escrow",
    "a missing escrow is refused before a read");
}

if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log("FAILED: " + problems.length + " problem(s)");
  process.exit(1);
}
console.log("PASSED: the sell wait reads the escrow, ends on a terminal state and names a timeout");
