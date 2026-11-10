#!/usr/bin/env node
// THE QUOTE LIFETIME, START MARGIN AND PREPARATION ALLOWANCE ARE PUBLIC AND ONE RULE.
//
// A node imports DEFAULT_ORDER_QUOTE_TTL_SEC instead of carrying its own copy. A buy quote must leave room for the
// lock block and for the SDK's own preparation; a sell quote is checked only for its own expiry because the node has
// already funded the escrow.
import {
  DEFAULT_ORDER_QUOTE_TTL_SEC, LOCK_START_MARGIN_SEC, START_PREP_SEC, quoteLifeVerdict,
} from "../src/quotePolicy.mjs";

let passed = 0;
const problems = [];
const check = (condition, name) => {
  if (condition) { passed += 1; console.log("  ok    " + name); }
  else problems.push(name);
};

check(LOCK_START_MARGIN_SEC === 30, "the start margin is 30 seconds");
check(START_PREP_SEC === 15, "the preparation allowance is 15 seconds");
check(DEFAULT_ORDER_QUOTE_TTL_SEC === 60, "the default quote lifetime is 60 seconds");
check(DEFAULT_ORDER_QUOTE_TTL_SEC > LOCK_START_MARGIN_SEC + START_PREP_SEC,
  "the default lifetime leaves more than the margin plus preparation");

const askAt = (left) => quoteLifeVerdict({ validUntil: 1_000, nowSec: 1_000 - left, side: "ask" });
check(askAt(30).code === "quote-too-short", "a buy with exactly the start margin left is refused");
check(askAt(45).code === "quote-too-short", "a buy with only the margin plus allowance left is refused");
check(askAt(60).ok === true, "a buy with the default lifetime left is accepted");
check(askAt(60).confirmBySec === 1_000 - LOCK_START_MARGIN_SEC - START_PREP_SEC,
  "the accepted buy names the last second to start it");

const bidAt = (left) => quoteLifeVerdict({ validUntil: 1_000, nowSec: 1_000 - left, side: "bid" });
check(bidAt(5).ok === true, "a sell with five seconds left is accepted");
check(bidAt(0).code === "quote-too-short", "a sell with no life left is refused");
check(bidAt(5).marginSec === 0 && bidAt(5).prepSec === 0,
  "the sell check reserves no local lock margin");

check(quoteLifeVerdict({ validUntil: null, nowSec: 1_000, side: "ask" }).code === "quote-too-short",
  "an unreadable quote lifetime is refused, not treated as long");

console.log("");
console.log(problems.length ? "FAILED: " + problems.length + " (passed " + passed + ")" : "quote defaults: " + passed + " checks passed.");
if (problems.length) process.exit(1);
