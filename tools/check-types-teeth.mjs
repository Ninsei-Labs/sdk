#!/usr/bin/env node
// THE BREAKING RUN FOR THE `types` CHECK: patch a file, watch the guard come back RED with a NAMED reason, put
// the file back byte for byte, and prove the bytes came back (sha256 compared before and after).
//
// ONE CASE PER PROMISE THE GUARD MAKES:
//   a) a subpath with an import/default target must declare "types";
//   b) the declared types file must BE in the package;
//   c) it must read as declarations (balanced blocks, every declaration named);
//   d) every symbol the barrel re-exports must be declared, and nothing else.
//
// The guard is run as its own process, before and after: the baseline must be GREEN (a red guard proves nothing
// about a bite), every case must turn it RED and NAME its own reason, and the run after the last restore must be
// GREEN again.
//
// Run: node tools/check-types-teeth.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const p = (...parts) => join(ROOT, ...parts);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The guard's verdict: its exit code and everything it printed, red or green. */
const guard = () => {
  try {
    const stdout = execFileSync(process.execPath, [p("tools", "check.mjs"), "--only=types"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

// EACH `patch` MUST ACTUALLY CHANGE THE TEXT - a patch that found nothing proves nothing, and the case fails with
// that said out loud rather than passing quietly.
const CASES = [
  {
    name: "a subpath loses its types target",
    wants: "a TypeScript consumer would get nothing for ./core",
    file: "package.json",
    expects: '"./core" points at ./src/public/core.mjs and declares no "types"',
    patch: (text) => text.replace(/^ {6}"types": "\.\/src\/public\/core\.d\.ts",\r?\n/m, ""),
  },
  {
    name: "the types target names a file that is not in the package",
    wants: "the declared file must exist",
    file: "package.json",
    expects: "the declared types file ./src/public/evm.d.ts.typo is not in the package",
    patch: (text) => text.replace('"types": "./src/public/evm.d.ts"', '"types": "./src/public/evm.d.ts.typo"'),
  },
  {
    name: "a declarations file stops reading as declarations",
    wants: "a file whose blocks do not balance is not readable as declarations",
    file: "src/public/xmr.d.ts",
    expects: "braces do not balance",
    // A stray opening block, the shape a half-applied edit leaves behind.
    patch: (text) => `${text}{\r\n`,
  },
  {
    name: "a declaration the barrel re-exports is dropped",
    wants: "the declarations must carry every symbol the barrel re-exports",
    file: "src/public/core.d.ts",
    expects: "re-exports parseAmount",
    patch: (text) => text.replace(/^export declare function parseAmount[^\r\n]*\r?\n/m, ""),
  },
];

const main = () => {
  const baseline = guard();
  console.log(`THE GUARD BEFORE ANY PATCH: ${baseline.code === 0 ? "GREEN" : `RED (exit ${baseline.code})`}`);
  if (baseline.code !== 0) {
    console.log("a guard that is already red cannot show a bite: fix the check, then run this again");
    for (const line of baseline.text.split("\n").filter((l) => l.includes("FAIL") || l.trim().startsWith('"'))) console.log(`          ${line.trim()}`);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const item of CASES) {
    const file = p(...item.file.split("/"));
    const beforeSha = sha256(file);
    const before = readFileSync(file, "utf8");
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
    console.log(`          ${item.file}: sha256 ${beforeSha.slice(0, 16)}… patched, guard ran, restored to ${afterSha.slice(0, 16)}… ${restored ? "identical, byte for byte" : "DIFFERENT - THE FILE WAS NOT RESTORED"}`);
    console.log(`          the guard ${reddened ? `came back RED (exit ${verdict.code})` : `did NOT redden (exit ${verdict.code})`}${named ? `, naming: ${item.expects}` : `, and DID NOT name: ${item.expects}`}`);
    if (!named) {
      for (const line of verdict.text.split("\n").filter((l) => l.includes("FAIL") || l.trim().startsWith('"'))) console.log(`          it said: ${line.trim()}`);
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
