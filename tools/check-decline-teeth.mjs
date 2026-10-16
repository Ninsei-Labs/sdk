#!/usr/bin/env node
// THE BREAKING RUN FOR THE `decline` CHECK: patch the files the guard reads, watch it come back RED with a NAMED
// reason, put every file back byte for byte, and prove the bytes came back (sha256 compared before and after).
//
// ONE CASE PER PROMISE THE GUARD MAKES (issue #40):
//   a) THE ESCROW'S `Declined` EVENT IS THE DECLINE - cut the topic comparison and the chain source goes silent;
//   b) THE EVENT'S IDENTITY IS PINNED - move the event's name and the topic stops being the contract's event;
//   c) THE NODE'S `declined` + `compliance` STATUS IS THE OTHER SOURCE - drop it from the decision and the wait
//      runs on to `xmr-timeout` about an order whose ETH is already back;
//   d) THE STATE IS WRITTEN DOWN - stop writing the settlement and nothing that reads the record reports it;
//   e) NO REASON TRAVELS - let one key named like a reason into the answer and the guard refuses it.
//
// The guard is run as its own process, before and after: the baseline must be GREEN (a red guard proves nothing
// about a bite), every case must turn it RED and NAME its own reason, and the run after the last restore must be
// GREEN again.
//
// Run: node tools/check-decline-teeth.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const p = (...parts) => join(ROOT, ...parts);
const read = (file) => readFileSync(file, "utf8");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The guard's verdict: its exit code and everything it printed, red or green. */
const guard = () => {
  try {
    const stdout = execFileSync(process.execPath, [p("tools", "check.mjs"), "--only=decline"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

// EACH `patch` MUST ACTUALLY CHANGE THE TEXT - a patch that found nothing proves nothing, and the case fails with
// that said out loud rather than passing quietly. The patterns tolerate either line ending, so the same case
// applies on the CI checkout and on a Windows one.
const CASES = [
  {
    name: "the escrow's Declined event is no longer recognised",
    wants: "a) the chain source is load-bearing: cut the topic comparison and the decline stops being read",
    file: "src/decline.mjs",
    expects: "a decline was not read from the escrow's Declined event",
    patch: (text) => text.replace(
      /if \(String\(topics\[0\] \|\| ""\)\.toLowerCase\(\) === DECLINED_TOPIC0\) return declineSeen\(\{ source: "event", at \}\);\r?\n/,
      "// BREAKING RUN A: the topic comparison is cut.\n"),
  },
  {
    name: "the event's identity drifts (the name is not Declined any more)",
    wants: "b) the pinned topic is load-bearing: the event's name cannot move without reddening",
    file: "src/decline.mjs",
    expects: "src/decline.mjs: the Declined topic is",
    patch: (text) => text.replace(
      /export const DECLINE_EVENT_NAME = "Declined";/,
      'export const DECLINE_EVENT_NAME = "DeclinedAgain";'),
  },
  {
    name: "the node's declined + compliance status is dropped from the decision",
    wants: "c) the wire source is load-bearing: without it the wait runs to xmr-timeout",
    file: "src/swaps.mjs",
    expects: "the node's declined status did not end the wait as a decline",
    patch: (text) => text.replace(
      "const declineNow = declineOf({ logs: chainDecline.logs, status: body, escrow: escrowAddress, at: Date.now() });",
      "const declineNow = declineOf({ logs: chainDecline.logs, escrow: escrowAddress, at: Date.now() });"),
  },
  {
    name: "the decline is not written into the record",
    wants: "d) the write-down is load-bearing: nothing that reads the record reports the state",
    file: "src/swaps.mjs",
    expects: "the record of a declined swap does not report the state",
    patch: (text) => text.replace(
      /        try \{ engine\.swap\.saveSwap\(swap\); \} catch \{ throw new SdkError\("storage-unavailable", \{ step: "decline" \}\); \}\r?\n/,
      "        // BREAKING RUN D: the record is not written.\n"),
  },
  {
    name: "a reason travels with the decline",
    wants: "e) the neutrality is enforced: one key named like a reason reddens the guard",
    file: "src/decline.mjs",
    expects: "carries reason",
    patch: (text) => text.replace(
      /  for \(const key of DECLINE_FIELDS\) out\[key\] = fields\[key\] === undefined \? null : fields\[key\];\r?\n/,
      "  for (const key of DECLINE_FIELDS) out[key] = fields[key] === undefined ? null : fields[key];\n  out.reason = \"BREAKING RUN E\";\n"),
  },
];

const main = () => {
  const baseline = guard();
  console.log(`THE GUARD BEFORE ANY PATCH: ${baseline.code === 0 ? "GREEN" : `RED (exit ${baseline.code})`}`);
  if (baseline.code !== 0) {
    console.log("a guard that is already red cannot show a bite: fix the check, then run this again");
    for (const line of baseline.text.split("\n").filter((l) => l.includes("FAIL") || l.trim().length > 0 && l.startsWith("          ")).slice(0, 12)) {
      console.log(`          ${line.trim()}`);
    }
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const item of CASES) {
    const file = p(...item.file.split("/"));
    const beforeSha = sha256(file);
    const before = read(file);
    const patched = item.patch(before);
    if (patched === before) {
      console.log(`  FAIL  ${item.name}`);
      console.log(`          the patch did not apply (${item.file}: the anchor is gone), so nothing was proven`);
      failed += 1;
      continue;
    }

    writeFileSync(file, patched, "utf8");
    let verdict;
    try {
      verdict = guard();
    } finally {
      // THE FILE GOES BACK WHATEVER THE GUARD DID, including when it threw.
      writeFileSync(file, before, "utf8");
    }

    const afterSha = sha256(file);
    const restored = afterSha === beforeSha;
    const reddened = verdict.code !== 0;
    const named = verdict.text.includes(item.expects);
    if (!reddened || !named || !restored) failed += 1;

    console.log(`  ${reddened && named && restored ? "ok  " : "FAIL"}  ${item.name} - ${item.wants}`);
    console.log(`          ${item.file}: sha256 ${beforeSha.slice(0, 16)}... patched, guard ran, restored to ${afterSha.slice(0, 16)}... ${restored ? "identical, byte for byte" : "DIFFERENT - THE FILE WAS NOT RESTORED"}`);
    console.log(`          the guard ${reddened ? `came back RED (exit ${verdict.code})` : `did NOT redden (exit ${verdict.code})`}${named ? `, naming: ${item.expects}` : `, and DID NOT name: ${item.expects}`}`);
    if (!named) {
      for (const line of verdict.text.split("\n").filter((l) => l.includes("FAIL") || l.startsWith("          ")).slice(0, 8)) console.log(`          it said: ${line.trim()}`);
    }
  }

  const after = guard();
  console.log(`THE GUARD AFTER THE LAST RESTORE: ${after.code === 0 ? "GREEN" : `RED (exit ${after.code}) - a file did not come back`}`);
  if (after.code !== 0) failed += 1;
  console.log(failed
    ? `FAILED: ${failed} of ${CASES.length + 1} steps`
    : `PASSED: ${CASES.length} breaking runs, each RED and each naming its own reason, every file restored byte for byte`);
  process.exitCode = failed ? 1 : 0;
};

main();
