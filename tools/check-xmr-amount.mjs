#!/usr/bin/env node
// XMR AMOUNTS: TWELVE DECIMALS, BIGINT, NO SILENT ROUNDING.
//
// The sweep page kept `ATOMIC_UNITS = 10^12n` and its own formatter. A second copy of this rule is how a page shows
// "0.000000000001" while a node reports 0, and how a value above 2^53 (about 9007 XMR in piconero) is rounded by a
// JavaScript number without anyone noticing.
//
// WHAT IS PROVEN:
//   1) formatting keeps every one of the twelve decimals that matters and drops only trailing zeros;
//   2) dust does not vanish - one atomic unit is "0.000000000001", not "0";
//   3) a value beyond Number's exact range survives a format -> parse round trip unchanged;
//   4) more than twelve decimals is null, not a rounded amount;
//   5) garbage, a mixed separator and a negative entry are null / refused, and a fractional number is refused by
//      format rather than truncated.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory):
//   A) format through Number -> the large-value round trip reddens;
//   B) truncate the fraction to twelve decimals -> the "more than twelve is null" case reddens.
//
// Run: node tools/check-xmr-amount.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatXmr, parseXmr } from "../src/public/core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "engine", "core", "xmrAmount.js");

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const show = (value) => (typeof value === "bigint" ? value.toString() + "n" : JSON.stringify(value));
const eq = (name, got, want) => {
  const same = typeof got === "bigint" || typeof want === "bigint" ? String(got) === String(want) : show(got) === show(want);
  if (same) ok(name + " -> " + show(want));
  else bad(name + " -> " + show(got) + ", expected " + show(want));
};

console.log("=== 1) FORMAT ===");
eq('one XMR', formatXmr(10n ** 12n), "1");
eq('a whole amount with piconero', formatXmr(1_234_567_890_000n), "1.23456789");
eq('trailing zeros are dropped', formatXmr(1_500_000_000_000n), "1.5");
eq('dust does not vanish', formatXmr(1n), "0.000000000001");
eq('zero', formatXmr(0n), "0");
eq('a string of atomic units is accepted', formatXmr("2000000000000"), "2");
eq('trim:false keeps the full fraction', formatXmr(1_500_000_000_000n, { trim: false }), "1.500000000000");
eq('a negative amount keeps its sign', formatXmr(-1_500_000_000_000n), "-1.5");
eq('a value beyond Number exactness keeps every digit', formatXmr(9_007_199_254_740_993n), "9007.199254740993");

console.log("=== 2) PARSE ===");
eq('a plain amount', parseXmr("1.23456789"), 1_234_567_890_000n);
eq('a comma is the decimal separator', parseXmr("0,05"), 50_000_000_000n);
eq('leading zeros', parseXmr("001.5"), 1_500_000_000_000n);
eq('trailing zeros in the text', parseXmr("2.500000000000"), 2_500_000_000_000n);
eq('twelve decimals', parseXmr("0.000000000001"), 1n);
eq('more than twelve decimals is null, not rounded', parseXmr("0.0000000000001"), null);
eq('a mixed separator is null', parseXmr("1,234.5"), null);
eq('garbage is null', parseXmr("1.2.3"), null);
eq('empty is null', parseXmr(""), null);
eq('a negative entry is null', parseXmr("-1"), null);
eq('a very large amount parses exactly', parseXmr("9007.199254740993"), 9_007_199_254_740_993n);

console.log("=== 3) ROUND TRIPS ===");
{
  const values = [0n, 1n, 10n ** 12n, 1_234_567_890_000n, 9_007_199_254_740_993n, 123_456_789_012_345n];
  const wrong = values.filter((v) => parseXmr(formatXmr(v)) !== v);
  if (!wrong.length) ok("format -> parse returns the same atomic value for " + values.length + " values");
  else bad("round trips changed: " + JSON.stringify(wrong.map((v) => [v.toString(), formatXmr(v)])));
}

console.log("=== 4) REFUSALS IN FORMAT ===");
{
  for (const [name, value] of [["a fractional number", 0.5], ["a non-numeric string", "one"], ["null", null]]) {
    let threw = false;
    try { formatXmr(value); } catch { threw = true; }
    if (threw) ok(name + " is refused, not truncated");
    else bad(name + " was accepted by formatXmr");
  }
}

function mutated(mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-xmr-amount-"));
  const source = mutate(readFileSync(MODULE, "utf8").replace(/\r\n/g, "\n"));
  const file = join(dir, name + ".mjs");
  writeFileSync(file, source, "utf8");
  return { file, dir };
}
const importFresh = (file) => import(pathToFileURL(file).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 5) BREAKING RUN A: format through Number -> the large value is rounded ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("const abs = negative ? -value : value;", "const abs = BigInt(Number(negative ? -value : value));");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const mod = await importFresh(file);
    let text = null;
    try { text = mod.formatXmr(9_007_199_254_740_993n); } catch { /* below */ }
    if (text !== "9007.199254740993") ok("breaking run A REDDENS: through Number the value is " + JSON.stringify(text));
    else bad("breaking run A does not redden: the large value survived");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 6) BREAKING RUN B: truncate instead of refusing -> more than twelve decimals is accepted ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('if (digits.length > DECIMALS) return null;', 'const cut = digits.slice(0, DECIMALS);');
    if (src === before) throw new Error("mutation B did not apply");
    src = src.replace('BigInt((digits || "0").padEnd(DECIMALS, "0"))', 'BigInt((cut || "0").padEnd(DECIMALS, "0"))');
    return src;
  }, "b");
  try {
    const mod = await importFresh(file);
    let got = "not null";
    try { got = mod.parseXmr("0.0000000000001"); } catch { /* below */ }
    if (got !== null) ok("breaking run B REDDENS: an over-precise amount became " + JSON.stringify(String(got)));
    else bad("breaking run B does not redden: it is still null");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "xmr amounts: " + pass + " checks passed.");
if (fails.length) process.exit(1);
