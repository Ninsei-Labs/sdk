#!/usr/bin/env node
// EVERY SCRIPT THE CI NAMES MUST EXIST.
//
// WHY. `package.json` and `.github/workflows/*.yml` are edited in parallel by different changes, and the two lists
// drift: a workflow step ran `pnpm run check:daemon-address` while the script had been dropped from package.json.
// Nothing local noticed - the guard itself was green when run by hand - and the failure appeared only in CI, as
// ERR_PNPM_NO_SCRIPT, after a push.
//
// WHAT IS PROVEN: every `pnpm run <name>` in every workflow names a script that exists; and every `check:*`
// script is named by at least one workflow. The second rule closes the gap that let sale authentication, backup
// confirmation, the one-key view half, arrival consensus, order proof and the recovery paths run only in the
// release workflow: a guard that no PR runs is not a guard on a pull request. A workflow may also run `pnpm
// install`, `pnpm exec ...` or a package binary; those are not scripts and are not checked.
//
// BREAKING RUN (a COPY of package.json in a temp directory): drop a script the workflow names -> the case reddens.
//
// Run: node tools/check-ci-scripts.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

/** Every `pnpm run <name>` in the given workflow texts, as { where, name }. */
export function namedScripts(files) {
  const found = [];
  for (const [file, text] of Object.entries(files)) {
    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
      const match = /\bpnpm\s+run\s+([A-Za-z0-9:_-]+)/.exec(line);
      if (match) found.push({ where: file, name: match[1] });
    }
  }
  return found;
}

/** Every `check:*` script that no workflow names, sorted. */
export function unrunCheckScripts(scripts, files) {
  const named = new Set(namedScripts(files).map((n) => n.name));
  return Object.keys(scripts).filter((name) => name.startsWith("check:") && !named.has(name)).sort();
}

const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts || {};
const files = {};
for (const entry of readdirSync(WORKFLOWS)) {
  if (entry.endsWith(".yml") || entry.endsWith(".yaml")) files[".github/workflows/" + entry] = readFileSync(join(WORKFLOWS, entry), "utf8");
}

console.log("=== EVERY pnpm run IN CI NAMES A SCRIPT ===");
const named = namedScripts(files);
const missing = named.filter((n) => !(n.name in scripts));
if (named.length) ok(named.length + " workflow step(s) name a script across " + Object.keys(files).length + " workflow file(s)");
else bad("no `pnpm run` steps were found at all - the scanner is looking at nothing");
if (!missing.length) ok("every one of them exists in package.json");
else bad("missing from package.json: " + JSON.stringify(missing));

console.log("=== EVERY check:* SCRIPT IS RUN BY A WORKFLOW ===");
const unrun = unrunCheckScripts(scripts, files);
if (!unrun.length) ok("every check:* script has a workflow step");
else bad("check scripts no workflow runs: " + JSON.stringify(unrun));

console.log("=== BREAKING RUN: a dropped script reddens ===");
{
  const dir = mkdtempSync(join(tmpdir(), "check-ci-scripts-"));
  try {
    const target = named[named.length - 1];
    const copy = { ...scripts };
    delete copy[target.name];
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: copy }, null, 2), "utf8");
    const reread = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts;
    const wouldMiss = named.filter((n) => !(n.name in reread));
    if (wouldMiss.some((n) => n.name === target.name)) ok("breaking run REDDENS: dropping " + JSON.stringify(target.name) + " is caught");
    else bad("breaking run does not redden");

    // A guard can exist and still be unrun: remove the only workflow line that names a check script and require it.
    const unrunTarget = "check:recovery-open";
    const without = Object.fromEntries(Object.entries(files).map(([name, text]) => [
      name,
      text.replace(/^.*pnpm run check:recovery-open.*(?:\r?\n|$)/gm, ""),
    ]));
    const wouldMissUnrun = unrunCheckScripts(scripts, without);
    if (wouldMissUnrun.includes(unrunTarget)) ok("breaking run REDDENS: an unrun " + JSON.stringify(unrunTarget) + " is caught");
    else bad("breaking run does not catch an unrun check script");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "ci scripts: " + pass + " checks passed.");
if (fails.length) process.exit(1);
