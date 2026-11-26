#!/usr/bin/env node
// BREAKING RUN FOR THE EXPLICIT RETRY OF AN AMBIGUOUS SEND.
//
// The guard under test is the real key-view check, driven by `check-key-view.mjs`. The mutation removes
// `send-unknown` from the release gate. A green guard after that mutation would mean the explicit retry is
// certified without proving the state it exists for; the child must exit non-zero.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(ROOT, "src", "swaps.mjs");
const original = readFileSync(sourcePath, "utf8");
const anchor = `(escrowRecord.fundingReason === "not-sent" || escrowRecord.fundingReason === "send-unknown")`;
const mutated = `escrowRecord.fundingReason === "not-sent"`;
if (original.split(anchor).length !== 2) {
  console.error("breaking run: the release-gate anchor was not found exactly once");
  process.exit(2);
}
let childFailed = false;
try {
  writeFileSync(sourcePath, original.replace(anchor, mutated));
  try {
    execFileSync(process.execPath, [join(ROOT, "tools", "check-key-view.mjs")], {
      cwd: ROOT, stdio: "pipe", timeout: 320000,
    });
  } catch (error) {
    childFailed = Boolean(error && error.status);
  }
} finally {
  writeFileSync(sourcePath, original);
}
if (!childFailed) {
  console.error("breaking run: the explicit-retry guard stayed green after removing send-unknown");
  process.exit(1);
}
console.log("breaking run: the explicit-retry guard turns red without send-unknown");
