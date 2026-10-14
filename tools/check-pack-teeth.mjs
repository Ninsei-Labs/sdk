#!/usr/bin/env node
// THE BREAKING RUN FOR THE `pack` CHECK'S LISTING READER: the packer's ANSWER is substituted, and the guard is run
// as its own process against each shape.
//
// WHY THE INPUT IS SUBSTITUTED AND NO FILE IS PATCHED: the reader's agreement is with what the npm on PATH prints,
// and the shape of that answer is not in this repository. A stub packer directory is therefore put FIRST on PATH
// for the duration of one run, so `npm pack --dry-run --json` is answered from a fixture and the REAL reader runs
// in the REAL check process. Nothing here re-implements the reading it is checking, and no repository file is
// written - so there is nothing to restore, which is the one difference from the other breaking runs in `tools/`.
//
// ONE CASE PER PROMISE THE READER MAKES:
//   a) npm 11's shape - an ARRAY of one entry - is still read, and reports EXACTLY what the real packer's answer
//      reports (this is the reading that existed before the change);
//   b) npm 12's shape - an OBJECT keyed by the package name - is read too, and reports THE SAME listing: the same
//      file count and the same sizes as the real packer, which is what the shape change took away;
//   c) a container that is neither (a bare string) is REFUSED, naming the shape it got;
//   d) an EMPTY listing (an array of 0 entries) is refused by name, not read as a tarball with no files;
//   e) an object with NO KEYS is refused by name;
//   f) an object keyed by TWO package names is refused by name - one package was packed;
//   g) an object whose single entry carries no `files` list is refused by name.
//
// EVERY REFUSAL IS ONE PROBLEM, NOT EIGHT: an unreadable shape must not be reported as the phantom problems a
// listing read as empty produces (measured before the change: with a container the reader did not know, the check
// printed eight problems that did not exist, and the run was red on a tarball that was correct).
//
// The baseline, against the real npm on PATH, must be GREEN: a red guard proves nothing about a bite.
//
// Run: node tools/check-pack-teeth.mjs
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const p = (...parts) => join(ROOT, ...parts);
const WINDOWS = process.platform === "win32";

/** The guard's verdict: its exit code and everything it printed, red or green. */
const guard = (pathValue) => {
  try {
    const stdout = execFileSync(process.execPath, [p("tools", "check.mjs"), "--only=pack"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: pathValue ? { ...process.env, PATH: pathValue } : process.env,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

/** What the run said about the pack check: the `ok` line's note, or the empty string when it was red. */
const noteOf = (text) => {
  const line = text.split("\n").find((l) => l.includes("ok") && l.includes("pack  - "));
  return line ? line.slice(line.indexOf("pack  - ") + "pack  - ".length).trim() : "";
};

// THE TRUTH THE FIXTURES ARE RE-SHAPED FROM: what the real packer on this PATH answers right now, in whichever
// container it uses. Only the fixtures are built from it - every verdict below comes from the guard.
const raw = JSON.parse(execSync("npm pack --dry-run --json", { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString());
const truth = Array.isArray(raw) ? raw[0] : Object.values(raw)[0];
const shapeHere = Array.isArray(raw) ? "npm 11's - an array of one entry" : "npm 12's - an object keyed by the package name";

const dirs = [];
/** A stub packer answering `listing`, put in front of PATH for one run. */
const stubPack = (listing) => {
  const dir = mkdtempSync(join(tmpdir(), "pack-teeth-"));
  dirs.push(dir);
  const fixture = join(dir, "listing.json");
  writeFileSync(fixture, JSON.stringify(listing), "utf8");
  // BOTH NAMES: the guard's own shell is cmd.exe on Windows - which resolves `npm.cmd` - and /bin/sh elsewhere.
  const slashed = fixture.split("\\").join("/");
  const sh = join(dir, "npm");
  writeFileSync(sh, `#!/bin/sh\ncat "${slashed}"\n`, "utf8");
  if (!WINDOWS) chmodSync(sh, 0o755);
  writeFileSync(join(dir, "npm.cmd"), `@echo off\r\ntype "${fixture}"\r\n`, "utf8");
  return `${dir}${delimiter}${process.env.PATH}`;
};

const CASES = [
  {
    name: "npm 11's shape is still read - an array of one entry",
    wants: "a) the reading that existed before the change is untouched",
    listing: () => [truth],
    green: true,
  },
  {
    name: "npm 12's shape is read - an object keyed by the package name",
    wants: "b) the new container yields the SAME listing as the real packer",
    listing: () => ({ [truth.name]: truth }),
    green: true,
  },
  {
    name: "a container that is neither - a bare string",
    wants: "c) a third shape is refused by name",
    listing: () => truth.filename,
    expects: "the packer answered a string",
  },
  {
    name: "an empty listing",
    wants: "d) an empty answer is not agreement",
    listing: () => [],
    expects: "the packer answered an empty listing",
  },
  {
    name: "an object with no keys",
    wants: "e) keyed by package name means it has to name one",
    listing: () => ({}),
    expects: "the packer answered an object with no keys",
  },
  {
    name: "an object keyed by two package names",
    wants: "f) two entries for one packed package is not this package's answer",
    listing: () => ({ [truth.name]: truth, "another-package": truth }),
    expects: "keyed by 2 package names",
  },
  {
    name: "an object whose single entry carries no `files` list",
    wants: "g) an entry that cannot be read is not an empty tarball",
    listing: () => ({ [truth.name]: { id: truth.id, version: truth.version } }),
    expects: "without a `files` list",
  },
];

const main = () => {
  console.log(`THE PACKER ON THIS PATH ANSWERS WITH: ${shapeHere}, carrying ${truth.files.length} files`);

  const baseline = guard();
  console.log(`THE GUARD BEFORE ANY STUB: ${baseline.code === 0 ? `GREEN - ${noteOf(baseline.text)}` : `RED (exit ${baseline.code})`}`);
  if (baseline.code !== 0) {
    console.log("a guard that is already red cannot show a bite: fix the check, then run this again");
    for (const line of baseline.text.split("\n").filter((l) => l.includes("FAIL") || l.includes("the tarball") || l.includes("packer"))) console.log(`          ${line.trim()}`);
    process.exitCode = 1;
    return;
  }
  const baselineNote = noteOf(baseline.text);

  let failed = 0;
  for (const item of CASES) {
    const verdict = guard(stubPack(item.listing()));
    if (item.green) {
      const same = noteOf(verdict.text) === baselineNote;
      const ok = verdict.code === 0 && same;
      if (!ok) failed += 1;
      console.log(`  ${ok ? "ok  " : "FAIL"}  ${item.name} - ${item.wants}`);
      console.log(`          the stub packer answered, the guard said: ${verdict.code === 0 ? `"${noteOf(verdict.text) || verdict.text.trim()}"` : `RED (exit ${verdict.code})`} ${same ? "- the same listing the real packer reports" : `- NOT the same listing (the real packer reports "${baselineNote}")`}`);
      continue;
    }

    const reddened = verdict.code !== 0;
    const named = verdict.text.includes(item.expects);
    const single = verdict.text.includes("1 problem(s)");
    if (!reddened || !named || !single) failed += 1;
    console.log(`  ${reddened && named && single ? "ok  " : "FAIL"}  ${item.name} - ${item.wants}`);
    console.log(`          the stub packer answered, the guard ${reddened ? `came back RED (exit ${verdict.code})` : `did NOT redden (exit ${verdict.code})`}${named ? `, naming: ${item.expects}` : `, and DID NOT name: ${item.expects}`}${single ? ", one named problem instead of eight phantom ones" : " - and it did not report exactly one problem"}`);
    if (!named || !single) {
      for (const line of verdict.text.split("\n").filter((l) => l.includes("FAIL") || l.includes("packer") || l.includes("tarball"))) console.log(`          it said: ${line.trim()}`);
    }
  }

  const after = guard();
  console.log(`THE GUARD AFTER THE STUBS: ${after.code === 0 ? `GREEN - ${noteOf(after.text)}` : `RED (exit ${after.code}) - a stub was left behind`}`);
  if (after.code !== 0) failed += 1;
  console.log(failed
    ? `FAILED: ${failed} of ${CASES.length + 1} steps`
    : `PASSED: ${CASES.filter((c) => c.green).length} shapes read (npm 11's array and npm 12's object, the same listing both ways), ${CASES.filter((c) => !c.green).length} unreadable shapes refused, each RED and each naming its own reason in one problem`);
  process.exitCode = failed ? 1 : 0;
};

try {
  main();
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
