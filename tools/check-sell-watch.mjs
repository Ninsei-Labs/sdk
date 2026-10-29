#!/usr/bin/env node
// THE SELL WAIT READS THE ESCROW ITSELF.
//
// The client sends XMR to the joint address; the node (the locker) marks the order ready before the claimer may
// take the ETH. This check drives the real `swaps.sellWatch` against a synthetic status()/ready() reader: no
// backend, no signature, no guessed address.
import * as engine from "../src/engine.mjs";
import { createSwaps } from "../src/swaps.mjs";

const escrow = "0x" + "a1".repeat(20);
const status = (funded, claimed, refunded, balance = 0n) => "0x"
  + [funded, claimed, refunded].map((v) => (v ? "1" : "0").padStart(64, "0")).join("")
  + balance.toString(16).padStart(64, "0");
const word = (v) => "0x" + v.toString(16).padStart(64, "0");
const problems = [];
const check = (condition, message) => { if (condition) console.log("  ok    " + message); else problems.push(message); };

function swapsWith(reader) {
  return createSwaps({ config: {}, call: reader });
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
    let calls = 0;
    const quotes = swapsWith(async ({ data }) => {
      calls += 1;
      if (data === engine.evm.ESCROW_METHODS.status) return status(true, claimed, refunded, 0n);
      throw new Error("ready must not be asked for a terminal order " + data);
    });
    const result = await quotes.sellWatch({ escrow, pollMs: 1, timeoutMs: 1_000 });
    check(result.state === state && calls === 1, "a " + state + " order ends the wait without reading ready");
  } catch (error) { check(false, state + " path failed: " + JSON.stringify(error && (error.code || error.message))); }
}

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

console.log("=== 4) THE ADDRESS IS REQUIRED ===");
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
