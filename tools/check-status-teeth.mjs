#!/usr/bin/env node
// THE EMPTY/INVALID STATUS SPLIT IS LOAD-BEARING.
//
// The pending-funding path must treat an empty status answer as "no contract" and a nonempty wrong-length answer
// as "unknown". This check mutates the matcher back to accepting any status-shaped error and shows that the
// nonempty answer becomes "empty" under the mutation. Without that reddening result, the split is decoration.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "sdk-status-teeth-"));

let pass = 0;
const problems = [];
const ok = (name) => { pass += 1; console.log("  ok    " + name); };
const bad = (name, why) => { problems.push(name + ": " + why); console.log("  FAIL  " + name + ": " + why); };

try {
  const real = await import(pathToFileURL(join(ROOT, "src", "swaps.mjs")).href);
  const empty = new Error("empty answer status()");
  const invalid = new Error("invalid answer status(): expected 128 bytes, got 32");
  if (real.statusAnswerIsEmpty(empty) === true) ok("the shipped matcher accepts the empty answer");
  else bad("shipped empty answer", "it was not accepted");
  if (real.statusAnswerIsEmpty(invalid) === false) ok("the shipped matcher rejects the nonempty wrong-length answer");
  else bad("shipped short answer", "it was treated as an empty answer");

  const source = readFileSync(join(ROOT, "src", "swaps.mjs"), "utf8").replace(/\r\n/g, "\n");
  const mutated = source.replace("empty answer status", "status");
  if (mutated === source) throw new Error("the mutation changed nothing");
  const rewritten = mutated.replace(/from\s+"(\.\.?\/[^"]+)"/g,
    (whole, rel) => `from "${pathToFileURL(join(ROOT, "src", rel)).href}"`);
  const file = join(dir, "swaps.mjs");
  writeFileSync(file, rewritten, "utf8");
  const broken = await import(pathToFileURL(file).href + "?v=" + Date.now());
  if (broken.statusAnswerIsEmpty(invalid) === true) {
    ok("removing the empty/invalid distinction makes the nonempty answer look empty (the guard is load-bearing)");
  } else bad("status split mutation", "the nonempty answer was still refused");
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (problems.length) {
  console.log("FAILED: " + problems.length + " (passed " + pass + ")");
  process.exit(1);
}
console.log("status teeth: " + pass + " checks passed.");
