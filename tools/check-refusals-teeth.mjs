#!/usr/bin/env node
// THE BREAKING RUN FOR THE `refusals` CHECK: patch the files the guard reads, watch it come back RED with a NAMED
// reason, put every file back byte for byte, and prove the bytes came back (sha256 compared before and after).
//
// ONE CASE PER PROMISE THE GUARD MAKES:
//   a) the refusal tables and `RouteRefusalCode` agree in BOTH directions;
//   b) the union is USED - a declaration outside its own names it (a union nobody names constrains nothing);
//   c) every table the package ships is declared `readonly RouteRefusalCode[]`, by NAME;
//   d) that declaration does not lose a table it must carry;
//   e) the `*Gate` verdict vocabulary stays OUT of the tables and out of the union.
//
// A CASE MAY TOUCH TWO FILES. (e) is the reason the shape allows it: a gate token put into a table ALONE would
// redden (a) instead, so the case patches the table AND the union together and the guard must still catch it - that
// is the one hole equality alone cannot see.
//
// The guard is run as its own process, before and after: the baseline must be GREEN (a red guard proves nothing
// about a bite), every case must turn it RED and NAME its own reason, and the run after the last restore must be
// GREEN again.
//
// Run: node tools/check-refusals-teeth.mjs
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
    const stdout = execFileSync(process.execPath, [p("tools", "check.mjs"), "--only=refusals"], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

/** The line separator the checkout uses, so an inserted line does not mix endings into the file. */
const eol = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

// EACH `patch` MUST ACTUALLY CHANGE THE TEXT - a patch that found nothing proves nothing, and the case fails with
// that said out loud rather than passing quietly.
const CASES = [
  {
    name: "a route refusal code leaves the union",
    wants: "b) the tables and the type answer to each other in both directions",
    edits: [{ file: "index.d.ts", patch: (text) => text.replace(/^[ \t]*\| "cow-unreachable"\r?\n/m, "") }],
    expects: ["refused by a provider but not declared in RouteRefusalCode: cow-unreachable"],
  },
  {
    name: "no declaration names the union any more",
    wants: "b) a union nobody names is a comment, not a type",
    edits: [{ file: "index.d.ts", patch: (text) => (text.includes(": readonly RouteRefusalCode[];")
      ? text.split(": readonly RouteRefusalCode[];").join(": readonly string[];")
      : text) }],
    expects: ["never uses it", "RouteRefusalTables declares COW_REFUSAL_CODES without the route refusal type"],
  },
  {
    name: "one table is declared without the refusal type",
    wants: "c) a table declared as a plain readonly string[] is a named problem",
    edits: [{ file: "index.d.ts", patch: (text) => text.replace(
      "readonly COW_REFUSAL_CODES: readonly RouteRefusalCode[];",
      "readonly COW_REFUSAL_CODES: readonly string[];",
    ) }],
    expects: ["RouteRefusalTables declares COW_REFUSAL_CODES without the route refusal type"],
  },
  {
    name: "the declared tables lose one of the four",
    wants: "d) a table that ships with no declared type is named, not skipped",
    edits: [{ file: "index.d.ts", patch: (text) => text.replace(/^[ \t]*readonly COW_REFUSAL_CODES:[^\r\n]*\r?\n/m, "") }],
    expects: ["RouteRefusalTables does not declare COW_REFUSAL_CODES"],
  },
  {
    name: "a *Gate verdict token is folded into the refusals",
    wants: "e) a gate verdict is not a refusal, and equality alone cannot see this",
    edits: [
      { file: "src/legs/cow.mjs", patch: (text) => text.replace(
        "export const COW_REFUSAL_CODES = [",
        `export const COW_REFUSAL_CODES = [${eol(text)}  "cow-no-order",`,
      ) },
      { file: "index.d.ts", patch: (text) => text.replace(
        `  | "broken";`,
        `  | "cow-no-order"${eol(text)}  | "broken";`,
      ) },
    ],
    expects: ["a refusal table names \"cow-no-order\"", "RouteRefusalCode declares \"cow-no-order\""],
  },
];

const main = () => {
  const baseline = guard();
  console.log(`THE GUARD BEFORE ANY PATCH: ${baseline.code === 0 ? "GREEN" : `RED (exit ${baseline.code})`}`);
  if (baseline.code !== 0) {
    console.log("a guard that is already red cannot show a bite: fix the check, then run this again");
    for (const line of baseline.text.split("\n").filter((l) => l.includes("FAIL") || l.trim().startsWith('"') || l.trim().startsWith("a refusal") || l.trim().startsWith("index.d.ts"))) {
      console.log(`          ${line.trim()}`);
    }
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const item of CASES) {
    const before = item.edits.map((edit) => {
      const file = p(...edit.file.split("/"));
      return { file, sha: sha256(file), text: read(file) };
    });
    const patched = before.map((held, index) => item.edits[index].patch(held.text));
    const missed = patched.findIndex((text, index) => text === before[index].text);
    if (missed >= 0) {
      console.log(`  FAIL  ${item.name}`);
      console.log(`          the patch did not apply (${item.edits[missed].file}: the anchor is gone), so nothing was proven`);
      failed += 1;
      continue;
    }

    before.forEach((held, index) => writeFileSync(held.file, patched[index], "utf8"));
    let verdict;
    try {
      verdict = guard();
    } finally {
      // EVERY FILE GOES BACK WHATEVER THE GUARD DID, including when it threw.
      before.forEach((held) => writeFileSync(held.file, held.text, "utf8"));
    }

    const restored = before.every((held) => sha256(held.file) === held.sha);
    const reddened = verdict.code !== 0;
    const named = item.expects.every((fragment) => verdict.text.includes(fragment));
    if (!reddened || !named || !restored) failed += 1;

    console.log(`  ${reddened && named && restored ? "ok  " : "FAIL"}  ${item.name} - ${item.wants}`);
    for (const held of before) {
      const after = sha256(held.file);
      console.log(`          ${held.file.slice(ROOT.length + 1).split("\\").join("/")}: sha256 ${held.sha.slice(0, 16)}... patched, guard ran, restored to ${after.slice(0, 16)}... ${after === held.sha ? "identical, byte for byte" : "DIFFERENT - THE FILE WAS NOT RESTORED"}`);
    }
    console.log(`          the guard ${reddened ? `came back RED (exit ${verdict.code})` : `did NOT redden (exit ${verdict.code})`}${named ? `, naming: ${item.expects.join(" | ")}` : `, and DID NOT name: ${item.expects.filter((f) => !verdict.text.includes(f)).join(" | ")}`}`);
    if (!named || !reddened) {
      for (const line of verdict.text.split("\n").filter((l) => l.includes("FAIL") || l.trim().startsWith("a refusal") || l.trim().startsWith("index.d.ts") || l.trim().startsWith("RouteRefusalCode"))) {
        console.log(`          it said: ${line.trim()}`);
      }
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
