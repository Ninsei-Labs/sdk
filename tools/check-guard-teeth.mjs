#!/usr/bin/env node
// THE BREAKING RUNS FOR THE GUARDS THAT TOUCH MONEY. Each case removes one guard from a source copy, runs the
// named check, and requires it to redden with its own reason. Every source file is restored byte for byte.
//
// Run: node tools/check-guard-teeth.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const read = (file) => readFileSync(join(ROOT, file), "utf8");

const guard = (check) => {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "tools", "check.mjs"), "--only=" + check], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

const cases = [
  {
    check: "action-state", source: "src/swap-flow.mjs",
    name: "the clock guard is removed",
    from: "if (!Number.isSafeInteger(at) || at <= 0) {", to: "if (false) {",
    wants: "no clock",
  },
  {
    check: "action-state", source: "src/swap-flow.mjs",
    name: "the claim deadline margin is removed",
    from: "if (at + margin >= Number(deadlines.t1))", to: "if (false)",
    wants: "inside the t1 margin",
  },
  {
    check: "action-state", source: "src/swap-flow.mjs",
    name: "the simulation refusal is removed",
    from: "if (!reverted) throw error;\n    throw new SdkError(\"contract-reverted\", {",
    to: "if (true) return;\n    throw new SdkError(\"contract-reverted\", {",
    wants: "simulation",
  },
  {
    check: "sell-start", source: "src/swaps.mjs",
    name: "the full-width commitment check is removed",
    from: "if (!ownCommit || fullHex(ownCommit) !== fullHex(quote.commitHalfClaimer)) {", to: "if (false) {",
    wants: "low 160 bits",
  },
  {
    check: "sell-watch", source: "src/swaps.mjs",
    name: "the claim-open report is removed",
    from: "if (at !== null && at >= Number(deadlines.readyBy)) {", to: "if (false) {",
    wants: "claim-open",
  },
];

const originals = new Map();
for (const item of cases) if (!originals.has(item.source)) originals.set(item.source, read(item.source));
let failed = 0;
const fail = (message) => { failed += 1; console.log("  FAIL  " + message); };
const ok = (message) => console.log("  ok    " + message);

const baselines = new Set(cases.map((item) => item.check));
for (const check of baselines) {
  const result = guard(check);
  if (result.code !== 0) fail("baseline " + check + " is already red");
  else ok("baseline " + check + " is green");
}

for (const item of cases) {
  const original = originals.get(item.source);
  const normalized = original.replace(/\r\n/g, "\n");
  const mutated = normalized.replace(item.from, item.to);
  if (mutated === normalized) { fail(item.name + ": the anchor was not found"); continue; }
  try {
    writeFileSync(join(ROOT, item.source), mutated, "utf8");
    const result = guard(item.check);
    if (result.code === 0) fail(item.name + ": " + item.check + " stayed green");
    else if (!result.text.includes(item.wants)) fail(item.name + ": red without " + JSON.stringify(item.wants));
    else ok(item.name + " reddens " + item.check + " with " + item.wants);
  } finally {
    writeFileSync(join(ROOT, item.source), original, "utf8");
  }
}

for (const [source, original] of originals) {
  if (sha256(read(source)) !== sha256(original)) fail(source + " was not restored byte for byte");
}
if (!failed) ok("sources restored byte for byte");

if (failed) {
  console.log("FAILED: " + failed + " case(s)");
  process.exit(1);
}
console.log("guard teeth: " + (cases.length + baselines.size + 1) + " checks passed.");
