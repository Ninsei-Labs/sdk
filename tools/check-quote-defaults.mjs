#!/usr/bin/env node
// THE QUOTE LIFETIME AND THE START MARGIN ARE PUBLIC, AND THE START USES THE MARGIN.
//
// A node imports DEFAULT_ORDER_QUOTE_TTL_SEC instead of carrying its own copy. The value has to leave room for the
// margin, and swaps.start has to read the same margin constant rather than a second literal that could drift.
import { readFileSync } from "node:fs";
import { DEFAULT_ORDER_QUOTE_TTL_SEC, LOCK_START_MARGIN_SEC, quoteLifeVerdict } from "../src/quotePolicy.mjs";

const swaps = readFileSync(new URL("../src/swaps.mjs", import.meta.url), "utf8");
const quotes = readFileSync(new URL("../src/quotes.mjs", import.meta.url), "utf8");
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
check(quotes.includes("quoteLifeVerdict"), "a quote is checked for remaining life when it arrives");
check(quoteLifeVerdict({ validUntil: 1_000, nowSec: 970 }).code === "quote-too-short",
  "a quote with exactly the start margin left is refused on arrival");
check(quoteLifeVerdict({ validUntil: 1_000, nowSec: 969 }).ok === true,
  "a quote with more than the start margin left is accepted");
check(quoteLifeVerdict({ validUntil: null, nowSec: 1_000 }).code === "quote-too-short",
  "an unreadable quote lifetime is refused, not treated as long");

console.log("");
console.log(problems.length ? "FAILED: " + problems.length + " (passed " + passed + ")" : "quote defaults: " + passed + " checks passed.");
if (problems.length) process.exit(1);
