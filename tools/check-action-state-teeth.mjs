#!/usr/bin/env node
// THE BREAKING RUN FOR THE ACTION WINDOW. Each case removes one guard from a copy of src/swap-flow.mjs and requires
// `check:action-state` to redden with the case's own reason. The tree is restored byte for byte after every case.
//
// Run: node tools/check-action-state-teeth.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(ROOT, "src", "swap-flow.mjs");
const read = () => readFileSync(target, "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const guard = () => {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "tools", "check.mjs"), "--only=action-state"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

const cases = [
  {
    name: "the clock guard is removed",
    from: "if (!Number.isSafeInteger(at) || at <= 0) {",
    to: "if (false) {",
    wants: "no clock",
  },
  {
    name: "the claim deadline margin is removed",
    from: "if (at + margin >= Number(deadlines.t1))",
    to: "if (false)",
    wants: "inside the t1 margin",
  },
  {
    name: "the simulation refusal is removed",
    from: "if (!reverted) throw error;\n    throw new SdkError(\"contract-reverted\", {",
    to: "if (true) return;\n    throw new SdkError(\"contract-reverted\", {",
    wants: "simulation",
  },
];

const original = read();
// The mutation anchors use \n; the worktree can be CRLF on Windows.
const normalized = original.replace(/\r\n/g, "\n");
const before = sha256(original);
let failed = 0;
const fail = (message) => { failed += 1; console.log("  FAIL  " + message); };
const ok = (message) => console.log("  ok    " + message);

const baseline = guard();
if (baseline.code !== 0) fail("baseline is already red: " + baseline.text.trim());
else ok("baseline is green");

for (const item of cases) {
  const mutated = normalized.replace(item.from, item.to);
  if (mutated === normalized) { fail(item.name + ": the anchor was not found"); continue; }
  try {
    writeFileSync(target, mutated, "utf8");
    const result = guard();
    if (result.code === 0) fail(item.name + ": the check stayed green");
    else if (!result.text.includes(item.wants)) fail(item.name + ": red without " + JSON.stringify(item.wants));
    else ok(item.name + " reddens with " + item.wants);
  } finally {
    writeFileSync(target, original, "utf8");
  }
}

if (sha256(read()) !== before) fail("the source was not restored byte for byte");
else ok("source restored byte for byte");

if (failed) {
  console.log("FAILED: " + failed + " case(s)");
  process.exit(1);
}
console.log("action-state teeth: " + (cases.length + 2) + " checks passed.");
