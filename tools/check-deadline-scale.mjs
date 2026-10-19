#!/usr/bin/env node
// SECONDS AT THE CHAIN, MILLISECONDS EVERYWHERE ELSE - AND ONE CONVERSION BETWEEN THEM.
//
// One log line carried ready_by = 1791828827 (seconds) and funded_at = 1791825228449 (milliseconds). The payout path
// subtracted a millisecond margin from the seconds value, got a moment around 1970, declared the deadline past and
// never asked the money-origin hook at all. The rule is not "milliseconds everywhere": the signed order terms and
// EVM block time are seconds, and they are not ours to change.
//
// WHAT IS PROVEN:
//   1) a value below 1e11 is seconds, one from 1e12 is milliseconds, and the gap between them has NO scale;
//   2) empty, zero, a non-number and a negative value are unknown - never "probably seconds";
//   3) the conversion happens once: seconds in, milliseconds out, empty gives null, and a value already in
//      milliseconds is REFUSED rather than multiplied again;
//   4) a write of a value that is not in milliseconds stops instead of being stored.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory):
//   A) the conversion multiplies by 1 -> case 3 reddens;
//   B) the gap between the thresholds is treated as seconds -> case 1 reddens.
//
// Run: node tools/check-deadline-scale.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertMsScale, isMsScale, isSecondsScale, msFromOrderSeconds, scaleOf } from "../src/public/core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "engine", "core", "deadlineScale.js");

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(name + " -> " + JSON.stringify(want));
  else bad(name + " -> " + JSON.stringify(got) + ", expected " + JSON.stringify(want));
};

console.log("=== 1) THE SCALE OF A VALUE ===");
eq("1.79e9 is seconds", scaleOf(1_791_828_827), "seconds");
eq("1.79e12 is milliseconds", scaleOf(1_791_828_827_449), "milliseconds");
eq("the gap has no scale", scaleOf(5e11), "unknown");
eq("just below the second threshold is still seconds", scaleOf(1e11 - 1), "seconds");
eq("exactly the millisecond threshold is milliseconds", scaleOf(1e12), "milliseconds");
eq("empty is unknown", scaleOf(""), "unknown");
eq("zero is unknown", scaleOf(0), "unknown");
eq("a non-number is unknown", scaleOf("soon"), "unknown");
eq("a negative value is unknown", scaleOf(-5), "unknown");
eq("the predicates agree with the scale", [isSecondsScale(1_791_828_827), isMsScale(1_791_828_827_449)], [true, true]);

console.log("=== 2) THE ONE CONVERSION ===");
eq("seconds -> milliseconds", msFromOrderSeconds(1_791_828_827), 1_791_828_827_000);
eq("empty stays unnamed, not zero", msFromOrderSeconds(""), null);
{
  for (const [name, value] of [["a value already in milliseconds", 1_791_828_827_449], ["a value in the gap", 5e11], ["a non-number", "soon"]]) {
    let threw = false;
    try { msFromOrderSeconds(value); } catch { threw = true; }
    if (threw) ok(name + " is refused");
    else bad(name + " was converted");
  }
}

console.log("=== 3) A WRITE GUARD ===");
{
  eq("milliseconds pass the write guard", assertMsScale(1_791_828_827_449), true);
  let threw = false;
  try { assertMsScale(1_791_828_827); } catch { threw = true; }
  if (threw) ok("seconds are stopped at the write, not stored");
  else bad("seconds passed the write guard");
}

function mutated(mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-deadline-scale-"));
  const source = mutate(readFileSync(MODULE, "utf8").replace(/\r\n/g, "\n"));
  const file = join(dir, name + ".mjs");
  writeFileSync(file, source, "utf8");
  return { file, dir };
}
const importFresh = (p) => import(pathToFileURL(p).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 4) BREAKING RUN A: the conversion multiplies by 1 -> reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("return n * 1000;", "return n;");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const mod = await importFresh(file);
    if (mod.msFromOrderSeconds(1_791_828_827) !== 1_791_828_827_000) ok("breaking run A REDDENS: the result stayed in seconds");
    else bad("breaking run A does not redden");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 5) BREAKING RUN B: the gap treated as seconds -> reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("  if (n < SECONDS_SCALE_MAX) return DEADLINE_SCALE.seconds;", "  if (n < MS_SCALE_MIN) return DEADLINE_SCALE.seconds;");
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "b");
  try {
    const mod = await importFresh(file);
    if (mod.scaleOf(5e11) === "seconds") ok("breaking run B REDDENS: the gap became seconds");
    else bad("breaking run B does not redden");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "deadline scale: " + pass + " checks passed.");
if (fails.length) process.exit(1);
