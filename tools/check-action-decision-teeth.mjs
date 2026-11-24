#!/usr/bin/env node
// BREAKING RUNS FOR THE ACTION DECISION. Each case damages one load-bearing boundary, runs the table and requires
// the table's own message. A guard without a breaking run is decoration.
//
// Run: node tools/run-teeth-isolated.mjs tools/check-action-decision-teeth.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(ROOT, "src", "action-decision.mjs");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const original = readFileSync(source, "utf8");
const cases = [
  {
    name: "the late refund opens after t1 instead of at t1",
    from: "if (blockTimeSec >= t1) return answer(\"refund\", \"late-refund\");",
    to: "if (blockTimeSec > t1) return answer(\"refund\", \"late-refund\");",
    wants: "a read block at t1 opens the late refund",
  },
  {
    name: "the device clock no longer closes the early refund",
    from: "if (closingNow >= earlyRefundClosesAt) return answer(\"none\", \"refund-margin\");",
    to: "if (false) return answer(\"none\", \"refund-margin\");",
    wants: "a device clock 200 s ahead closes the early refund",
  },
  {
    name: "the sale send deadline accepts its boundary second",
    from: "if (blockTimeSec < sendClosesAt && closingNow < sendClosesAt) return answer(\"sendXmr\", \"send-window\", sendClosesAt);",
    to: "if (blockTimeSec <= sendClosesAt && closingNow <= sendClosesAt) return answer(\"sendXmr\", \"send-window\", sendClosesAt);",
    wants: "the deadline second is not a send",
  },
];
const fail = (message) => { console.log("  FAIL  " + message); process.exitCode = 1; };
const okay = (message) => console.log("  ok    " + message);
let failed = false;

for (const item of cases) {
  const normalized = original.replace(/\r\n/g, "\n");
  const mutated = normalized.replace(item.from, item.to);
  if (mutated === normalized) { fail(item.name + ": the anchor was not found"); failed = true; continue; }
  try {
    writeFileSync(source, mutated, "utf8");
    let text = "";
    try {
      text = execFileSync(process.execPath, [join(ROOT, "tools", "check-action-decision.mjs")], {
        cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      fail(item.name + ": the table stayed green");
      failed = true;
    } catch (error) {
      text = `${error.stdout || ""}${error.stderr || ""}`;
      if (text.includes(item.wants)) okay(item.name + " reddens with " + item.wants);
      else { fail(item.name + ": red without " + JSON.stringify(item.wants)); failed = true; }
    }
  } finally {
    writeFileSync(source, original, "utf8");
  }
}

if (hash(readFileSync(source, "utf8")) !== hash(original)) {
  fail("src/action-decision.mjs was not restored byte for byte");
  failed = true;
} else {
  okay("source restored byte for byte");
}
if (failed) process.exit(1);
console.log("action decision teeth: " + (cases.length + 1) + " checks passed.");
