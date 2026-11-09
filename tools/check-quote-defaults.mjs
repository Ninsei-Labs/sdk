#!/usr/bin/env node
// THE QUOTE LIFETIME AND THE START MARGIN ARE PUBLIC, AND THE START USES THE MARGIN.
//
// A node imports DEFAULT_ORDER_QUOTE_TTL_SEC instead of carrying its own copy. The value has to leave room for the
// margin, and swaps.start has to read the same margin constant rather than a second literal that could drift.
import { readFileSync } from "node:fs";
import { DEFAULT_ORDER_QUOTE_TTL_SEC, LOCK_START_MARGIN_SEC } from "../src/index.mjs";

const swaps = readFileSync(new URL("../src/swaps.mjs", import.meta.url), "utf8");
let passed = 0;
const problems = [];
const check = (condition, name) => {
  if (condition) { passed += 1; console.log("  ok    " + name); }
  else problems.push(name);
};

check(LOCK_START_MARGIN_SEC === 30, "the start margin is 30 seconds");
check(DEFAULT_ORDER_QUOTE_TTL_SEC === 60, "the default quote lifetime is 60 seconds");
check(DEFAULT_ORDER_QUOTE_TTL_SEC > LOCK_START_MARGIN_SEC, "the default lifetime leaves more than the start margin");
check(swaps.includes("nowSec + LOCK_START_MARGIN_SEC"), "swaps.start reads the margin constant");
check(swaps.includes("marginSec: LOCK_START_MARGIN_SEC"), "the quote-expired refusal reports the margin constant");

console.log("");
console.log(problems.length ? "FAILED: " + problems.length + " (passed " + passed + ")" : "quote defaults: " + passed + " checks passed.");
if (problems.length) process.exit(1);
