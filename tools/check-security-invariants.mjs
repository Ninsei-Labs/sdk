#!/usr/bin/env node
// THE MAP MUST STAY HONEST: every invariant names existing files and existing check scripts, every critical file
// is named by at least one invariant, and no invariant is a sentence with no executable evidence.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY_INVARIANTS, SECURITY_CRITICAL_FILES } from "./security-invariants.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];
const seen = new Set();
const covered = new Set();

for (const invariant of SECURITY_INVARIANTS) {
  if (!invariant || typeof invariant.id !== "string" || !invariant.id) { problems.push("an invariant has no id"); continue; }
  if (seen.has(invariant.id)) problems.push(`${invariant.id}: duplicate id`);
  seen.add(invariant.id);
  if (typeof invariant.statement !== "string" || invariant.statement.length < 20) problems.push(`${invariant.id}: statement is missing or too short`);
  if (!Array.isArray(invariant.files) || !invariant.files.length) problems.push(`${invariant.id}: names no files`);
  if (!Array.isArray(invariant.checks) || !invariant.checks.length) problems.push(`${invariant.id}: names no checks`);
  for (const file of invariant.files || []) {
    if (!existsSync(join(ROOT, file))) problems.push(`${invariant.id}: missing file ${file}`);
    covered.add(file);
  }
  console.log("  ok    " + invariant.id + " has " + (invariant.checks || []).length + " check(s)");
  for (const check of invariant.checks || []) {
    if (!existsSync(join(ROOT, check))) problems.push(`${invariant.id}: missing check ${check}`);
    else {
      const text = readFileSync(join(ROOT, check), "utf8");
      if (!/^(?:#!|\/\/)/.test(text)) problems.push(`${invariant.id}: ${check} is not a script`);
    }
  }
}

for (const file of SECURITY_CRITICAL_FILES) {
  if (!existsSync(join(ROOT, file))) problems.push(`critical file does not exist: ${file}`);
  if (!covered.has(file)) problems.push(`critical file has no invariant: ${file}`);
}

notes.push(`${SECURITY_INVARIANTS.length} invariants, ${SECURITY_CRITICAL_FILES.length} critical files`);
if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log(`security invariants: FAILED (${problems.length})`);
  process.exit(1);
}
console.log("security invariants: " + notes[0]);
