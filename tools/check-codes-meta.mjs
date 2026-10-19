#!/usr/bin/env node
// WHAT A REFUSAL MEANS FOR THE INTERFACE: retry or not, and whose problem it is.
//
// The sweep page kept two hand-written lists next to a code dictionary - which codes are retryable, and which are
// "ours". A code added to the vocabulary and forgotten in those lists showed the person the wrong advice. The table
// lives beside the vocabulary now, and this guard keeps the two in step by machine.
//
// WHAT IS PROVEN:
//   1) every code in ERROR_CODES has exactly one entry, and there are no entries for codes that do not exist;
//   2) every entry has a boolean `retryable` and a `side` from the closed list;
//   3) `unknown` is not dressed up as a known side;
//   4) the package's main entry exports the table (a consumer must not import an internal path).
//
// BREAKING RUN (mutates a COPY of codes.mjs in a temp directory):
//   A) drop one entry -> the "every code is named" case reddens.
//
// Run: node tools/check-codes-meta.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ERROR_CODES, ERROR_META, ERROR_SIDES } from "../src/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODES = join(ROOT, "src", "codes.mjs");

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

console.log("=== 1) THE TWO NAMES MUST MATCH ===");
{
  const named = Object.keys(ERROR_META);
  const missing = ERROR_CODES.filter((code) => !named.includes(code));
  const extra = named.filter((code) => !ERROR_CODES.includes(code));
  if (!missing.length) ok("all " + ERROR_CODES.length + " codes have an entry");
  else bad("codes without an entry: " + JSON.stringify(missing));
  if (!extra.length) ok("no entry for a code outside the vocabulary");
  else bad("entries for unknown codes: " + JSON.stringify(extra));
}

console.log("=== 2) THE SHAPE OF EVERY ENTRY ===");
{
  const sides = new Set(ERROR_SIDES);
  const wrong = Object.entries(ERROR_META).filter(([, meta]) =>
    !meta || typeof meta.retryable !== "boolean" || !sides.has(meta.side));
  if (!wrong.length) ok("every entry has a boolean retryable and a side from " + JSON.stringify(ERROR_SIDES));
  else bad("entries of the wrong shape: " + JSON.stringify(wrong.map(([code]) => code)));
  if (ERROR_META.unknown && ERROR_META.unknown.side === "unknown") ok("`unknown` names itself, not a guess");
  else bad("`unknown` has side " + JSON.stringify(ERROR_META.unknown && ERROR_META.unknown.side));
}

console.log("=== 3) A DRIFTED MEANING IS CAUGHT ===");
{
  // The retry decision is part of the contract, so a table that says "retry a payment refusal" is a defect, not a
  // preference. These are the codes where a retry would move money again; all of them must be non-retryable.
  const money = ["bad-input", "insufficient-funds", "wallet-rejected", "xmr-underpaid", "xmr-too-late", "contract-reverted", "server-refused"];
  const wrong = money.filter((code) => ERROR_META[code] && ERROR_META[code].retryable !== false);
  if (!wrong.length) ok("a refused payment is never marked retryable (" + money.length + " codes)");
  else bad("marked retryable: " + JSON.stringify(wrong));
}

function mutated(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "check-codes-meta-"));
  const source = mutate(readFileSync(CODES, "utf8").replace(/\r\n/g, "\n"));
  const file = join(dir, "codes.mjs");
  writeFileSync(file, source, "utf8");
  return { file, dir };
}
const importFresh = (p) => import(pathToFileURL(p).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 4) BREAKING RUN A: an entry dropped -> the missing-code case reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('  "xmr-underpaid": { retryable: false, side: "chain" },\n', "");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  });
  try {
    const mod = await importFresh(file);
    const missing = mod.ERROR_CODES.filter((code) => !(code in mod.ERROR_META));
    if (missing.includes("xmr-underpaid")) ok("breaking run A REDDENS: xmr-underpaid has no entry");
    else bad("breaking run A does not redden: every code still has an entry");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "codes meta: " + pass + " checks passed.");
if (fails.length) process.exit(1);
