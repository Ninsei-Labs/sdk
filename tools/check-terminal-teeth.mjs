#!/usr/bin/env node
// THE BREAKING RUN FOR THE `terminal` CHECK: patch the files the guard reads, watch it come back RED with a NAMED
// reason, put every file back byte for byte, and prove the bytes came back (sha256 compared before and after).
//
// ONE CASE PER PROMISE THE GUARD MAKES ABOUT THE TERMINAL STATE A SWAP ENDS IN:
//   a) THE KEY IS THE KIND THE ENGINE WRITES - put the dead key `refunded` back and the refund has no key at all;
//   b) THE CODE IS PINNED - send the refund's kind to another declared code and the guard must not accept it;
//   c) NO KEY WITHOUT A WRITER - add a key for a code nothing writes back and the guard must name it;
//   d) THIS PACKAGE'S OWN KIND KEEPS ITS KEY - drop `declined` and a declined order is reported as the fallback;
//   e) THE KINDS ARE READ FROM THE ENGINE - rename the engine's own refund kind and the guard must notice, which is
//      what makes (a) a comparison against the engine rather than against a list written by hand.
//
// The guard is run as its own process, before and after: the baseline must be GREEN (a red guard proves nothing
// about a bite), every case must turn it RED and NAME its own reason, and the run after the last restore must be
// GREEN again.
//
// Run: node tools/check-terminal-teeth.mjs
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
    const stdout = execFileSync(process.execPath, [p("tools", "check.mjs"), "--only=terminal"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

// EACH `patch` MUST ACTUALLY CHANGE THE TEXT - a patch that found nothing proves nothing, and the case fails with
// that said out loud rather than passing quietly. Every patch is a SINGLE-LINE substitution, so the same case
// applies on a CRLF checkout and on a Windows one.
const CASES = [
  {
    name: "the dead key `refunded` is put back for the engine's `refund_eth`",
    wants: "a) the key is the kind the engine writes: the map must have no key without a writer",
    file: "src/swaps.mjs",
    expects: 'the terminal map has the key "refunded" and no code path writes that kind',
    patch: (text) => text.replace('  refund_eth: "refunded_eth",', '  refunded: "refunded_eth",'),
  },
  {
    name: "the refund's kind is sent to another declared code",
    wants: "b) the refund's own state is pinned: a declared code that is not `refunded_eth` must redden",
    file: "src/swaps.mjs",
    expects: 'the map sends the refund\'s kind "refund_eth" to "xmr_returned"',
    patch: (text) => text.replace('  refund_eth: "refunded_eth",', '  refund_eth: "xmr_returned",'),
  },
  {
    name: "a key for a code nothing writes is added back",
    wants: "c) no key without a writer: `xmr_returned` is a declared code with no writer, not a mapping",
    file: "src/swaps.mjs",
    expects: 'the terminal map has the key "xmr_returned" and no code path writes that kind',
    patch: (text) => text.replace('  success: "success",', '  success: "success", xmr_returned: "xmr_returned",'),
  },
  {
    name: "this package's own kind `declined` loses its key",
    wants: "d) the third kind keeps its key: the decline's own state is not the fallback",
    file: "src/swaps.mjs",
    expects: 'this package writes the settlement kind "declined" and the terminal map has no key for it',
    patch: (text) => text.replace("  [DECLINED_TERMINAL]: DECLINED_TERMINAL,", "  // BREAKING RUN D: the key of this package's own kind is gone."),
  },
  {
    name: "the engine renames its own refund kind",
    wants: "e) the kinds are read from the engine: a rename in the mirror must redden the comparison",
    file: "engine/core/swap.js",
    expects: 'the engine writes the settlement kind "refund_eth_v2" and the terminal map has no key for it',
    patch: (text) => text.replace('kind: "refund_eth", phase: TERMINAL.refunded_eth.phase',
      'kind: "refund_eth_v2", phase: TERMINAL.refunded_eth.phase'),
  },
];

const main = () => {
  const baseline = guard();
  console.log(`THE GUARD BEFORE ANY PATCH: ${baseline.code === 0 ? "GREEN" : `RED (exit ${baseline.code})`}`);
  if (baseline.code !== 0) {
    console.log("a guard that is already red cannot show a bite: fix the check, then run this again");
    for (const line of baseline.text.split("\n").filter((l) => l.includes("FAIL") || (l.trim().length && l.startsWith("          "))).slice(0, 12)) {
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
