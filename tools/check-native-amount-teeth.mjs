#!/usr/bin/env node
// BREAKING RUN FOR THE NATIVE AMOUNT GUARD.
//
// Two rules keep a token-funded order from funding a different amount than the quote:
//   a) a significant digit beyond the token's decimals is refused, not sliced away;
//   b) a numeric payNative above Number.MAX_SAFE_INTEGER is refused before conversion.
//
// Each case removes one rule, runs `tools/check.mjs --only=native-amount`, requires a RED answer that names its
// case, and restores the file byte for byte. The baseline and the final run must be green.
//
// Run: pnpm run check:native-amount-teeth (isolated copy; do not run this file directly)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const p = (...parts) => join(ROOT, ...parts);
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const guard = () => {
  try {
    const stdout = execFileSync(process.execPath, [p("tools", "check.mjs"), "--only=native-amount"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

const CASES = [
  {
    name: "a significant digit beyond the decimals is sliced away",
    file: "engine/evm/funding.js",
    wants: "the amount must not fund a different value from the signed one",
    expects: "extra decimals accepted",
    patch: (text) => text.replace(
      /  if \(fraction\.length > dec && \/\[1-9\]\/\.test\(fraction\.slice\(dec\)\)\) \{\r?\n    throw new Error\("the amount has more decimal digits than the token"\);\r?\n  \}/,
      "",
    ),
  },
  {
    name: "an unsafe numeric amount reaches conversion",
    file: "engine/evm/funding.js",
    wants: "a number above the exact range must be refused before it is parsed",
    expects: "unsafe number accepted",
    patch: (text) => text.replace(
      /  if \(typeof raw === "number" && Math\.abs\(raw\) > Number\.MAX_SAFE_INTEGER\) \{\r?\n    return \{ ok: false, code: "native-amount-unread", reason: "the quote's native amount is not a safe number" \};\r?\n  \}/,
      "",
    ),
  },
];

const main = () => {
  const baseline = guard();
  console.log(`THE GUARD BEFORE ANY PATCH: ${baseline.code === 0 ? "GREEN" : `RED (exit ${baseline.code})`}`);
  if (baseline.code !== 0) {
    console.log("a guard that is already red cannot show a bite: fix the check, then run this again");
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
      writeFileSync(file, before, "utf8");
    }

    const restored = sha256(file) === beforeSha;
    const reddened = verdict.code !== 0;
    const named = verdict.text.includes(item.expects);
    if (!reddened || !named || !restored) failed += 1;

    console.log(`  ${reddened && named && restored ? "ok  " : "FAIL"}  ${item.name} - ${item.wants}`);
    console.log(`          ${item.file}: sha256 ${beforeSha.slice(0, 16)}… patched, guard ran, restored to ${sha256(file).slice(0, 16)}… ${restored ? "identical, byte for byte" : "DIFFERENT - THE FILE WAS NOT RESTORED"}`);
    console.log(`          the guard ${reddened ? `came back RED (exit ${verdict.code})` : `did NOT redden (exit ${verdict.code})`}${named ? `, naming: ${item.expects}` : `, and DID NOT name: ${item.expects}`}`);
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
