#!/usr/bin/env node
// THE PENDING IDENTITY CHECK IS LOAD-BEARING.
//
// A record that carries a factory must not be resumed by a request naming another factory, even when the salt and
// the predicted address are the same. This check removes that guard and shows the mismatch becomes a resume.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "sdk-pending-teeth-"));
const salt = "0x" + "22".repeat(32);
const escrow = "0x" + "55".repeat(20);
const factory = "0x" + "33".repeat(20);
const anotherFactory = "0x" + "44".repeat(20);
const record = {
  fundingPending: true,
  escrow: { address: escrow, salt, chainId: 421614, factory },
  order: { chainId: 421614, factory },
  quote: {},
};
const identity = { salt, chainId: 421614, factory: anotherFactory, escrow };

let pass = 0;
const problems = [];
const ok = (name) => { pass += 1; console.log("  ok    " + name); };
const bad = (name, why) => { problems.push(name + ": " + why); console.log("  FAIL  " + name + ": " + why); };

async function mutated(from, to, name) {
  const source = readFileSync(join(ROOT, "src", "swaps.mjs"), "utf8").replace(/\r\n/g, "\n");
  const changed = source.split(from).join(to);
  if (changed === source) throw new Error("the mutation changed nothing: " + from.slice(0, 70));
  const rewritten = changed.replace(/from\s+"(\.\.?\/[^"]+)"/g,
    (whole, rel) => `from "${pathToFileURL(join(ROOT, "src", rel)).href}"`);
  const file = join(dir, name + ".mjs");
  writeFileSync(file, rewritten, "utf8");
  return import(pathToFileURL(file).href + "?v=" + name);
}

try {
  const real = await import(pathToFileURL(join(ROOT, "src", "swaps.mjs")).href);
  if (real.samePendingFunding(record, identity) === false) {
    ok("the shipped identity check refuses another factory");
  } else bad("shipped identity check", "it accepted another factory");

  const noFactory = await mutated(
    "if (recorded.factory && recorded.factory !== wanted.factory) return false;",
    "if (false) return false;", "no-factory-check");
  if (noFactory.samePendingFunding(record, identity) === true) {
    ok("removing the factory check makes the mismatch resume (the guard is load-bearing)");
  } else bad("factory mutation", "it still refused");
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (problems.length) {
  console.log("FAILED: " + problems.length + " (passed " + pass + ")");
  process.exit(1);
}
console.log("pending funding teeth: " + pass + " checks passed.");
