#!/usr/bin/env node
// EVERY SCRIPT THE CI NAMES MUST EXIST.
//
// WHY. `package.json` and `.github/workflows/*.yml` are edited in parallel by different changes, and the two lists
// drift: a workflow step ran `pnpm run check:daemon-address` while the script had been dropped from package.json.
// Nothing local noticed - the guard itself was green when run by hand - and the failure appeared only in CI, as
// ERR_PNPM_NO_SCRIPT, after a push.
//
// WHAT IS PROVEN: every `pnpm run <name>` in every workflow names a script that exists; and every `check:*`
// script is named by a workflow, or is in the `CHECKS` registry and so runs under `pnpm run check` / `coverage`. The second rule closes the gap that let sale authentication, backup
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
const CHECK_SOURCE = join(ROOT, "tools", "check.mjs");

/** The names in the `CHECKS` registry. A full `check` or `coverage` run executes every one of them. */
function registryCheckNames() {
  const source = readFileSync(CHECK_SOURCE, "utf8");
  const begin = source.indexOf("const CHECKS = {");
  const end = source.indexOf("};", begin);
  if (begin < 0 || end < 0) return [];
  return [...source.slice(begin, end).matchAll(/^\s*(?:"([^"]+)"|([a-z][a-z0-9-]*))\s*:/gm)]
    .map((m) => m[1] || m[2]);
}

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
  const names = namedScripts(files).map((n) => n.name);
  const named = new Set(names);
  // `pnpm run check` and `pnpm run coverage` run the whole registry, so a named step for every registry key is
  // not needed. External `check:*` scripts still need their own workflow step.
  if (names.includes("check") || names.includes("coverage")) {
    for (const key of registryCheckNames()) named.add("check:" + key);
  }
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
    const unrunTarget = "check:live-contract";
    const without = Object.fromEntries(Object.entries(files).map(([name, text]) => [
      name,
      text.replace(/^.*pnpm run check:live-contract.*(?:\r?\n|$)/gm, ""),
    ]));
    const wouldMissUnrun = unrunCheckScripts(scripts, without);
    if (wouldMissUnrun.includes(unrunTarget)) ok("breaking run REDDENS: an unrun " + JSON.stringify(unrunTarget) + " is caught");
    else bad("breaking run does not catch an unrun check script");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// EVERY PULL REQUEST WORKFLOW MUST HAVE THE DRAFT GATE. A new workflow that listens to pull_request but omits the
// draft flag spends runner minutes on every intermediate push, which is the whole point of the rule. The gate is
// two text facts: the ready_for_review activity type and the draft condition on at least one job.
export function draftGateMisses(files) {
  return Object.entries(files)
    .filter(([, text]) => /^\s{2}pull_request:/m.test(text.replace(/\r\n/g, "\n")))
    .filter(([, text]) => !/ready_for_review/.test(text) || !/github\.event\.pull_request\.draft == false/.test(text))
    .map(([name]) => name);
}

console.log("=== EVERY PULL REQUEST WORKFLOW HAS THE DRAFT GATE ===");
const prWorkflows = Object.keys(files).filter((name) => /^\s{2}pull_request:/m.test(files[name].replace(/\r\n/g, "\n")));
const ungated = draftGateMisses(files);
if (prWorkflows.length) ok(prWorkflows.length + " pull request workflow(s) are scanned");
else bad("no pull request workflow was found - the scanner is looking at nothing");
if (!ungated.length) ok("every pull request workflow names ready_for_review and tests the draft flag");
else bad("pull request workflows without the draft gate: " + JSON.stringify(ungated));

console.log("=== BREAKING RUN: a removed draft condition reddens ===");
{
  const [name, text] = Object.entries(files).find(([, body]) => (body.match(/github\.event\.pull_request\.draft == false/g) || []).length === 1) || [];
  const broken = name
    ? { ...files, [name]: text.replace(/^\s*if:.*draft == false.*(?:\r?\n|$)/m, "") }
    : files;
  if (name && draftGateMisses(broken).includes(name)) ok("breaking run REDDENS: a workflow without the draft condition is caught");
  else bad("breaking run does not catch a missing draft condition");
}

// FOUNDRY IS A PINNED RELEASE, NOT AN INSTALLER THAT RESOLVES `latest`. The toolchain action runs foundryup, whose
// installer asks GitHub for the latest foundryup; one 504 there stopped every SDK job. The build downloads one
// release asset and checks its published SHA-256, so the version and the bytes are both named in the tree.
export function foundryInstallerMisses(files) {
  return Object.entries(files)
    .filter(([, text]) => {
      const body = text.replace(/\r\n/g, "\n");
      const lines = body.split("\n").filter((line) => !line.trimStart().startsWith("#"));
      return lines.some((line) => /foundry-rs\/foundry-toolchain/.test(line) || /\bfoundryup\b/.test(line));
    })
    .map(([name]) => name);
}

export function foundryPinMisses(files) {
  const text = (files[".github/workflows/ci.yml"] || "").replace(/\r\n/g, "\n");
  const misses = [];
  if (!/FOUNDRY_VERSION:\s*v\d+\.\d+\.\d+/.test(text)) misses.push("version");
  if (!/FOUNDRY_SHA256:\s*[0-9a-f]{64}/.test(text)) misses.push("sha256");
  if (!/foundry_\$\{FOUNDRY_VERSION\}_linux_amd64\.tar\.gz/.test(text)) misses.push("asset");
  return misses;
}

console.log("=== FOUNDRY IS A PINNED RELEASE, NOT AN INSTALLER ===");
const installers = foundryInstallerMisses(files);
if (!installers.length) ok("no workflow runs foundryup or the foundry-toolchain action");
else bad("workflows that resolve Foundry at run time: " + JSON.stringify(installers));
const missingPins = foundryPinMisses(files);
if (!missingPins.length) ok("the SDK workflow names the Foundry version, asset and SHA-256");
else bad("the SDK workflow is missing the Foundry pin: " + JSON.stringify(missingPins));

console.log("=== BREAKING RUN: a Foundry installer or an unpinned release reddens ===");
{
  const brokenInstaller = { ...files, ".github/workflows/ci.yml": (files[".github/workflows/ci.yml"] || "") + "\n      - uses: foundry-rs/foundry-toolchain@v1\n" };
  if (foundryInstallerMisses(brokenInstaller).length) ok("breaking run REDDENS: a foundryup installer is caught");
  else bad("breaking run does not catch a Foundry installer");
  const brokenPin = { ...files, ".github/workflows/ci.yml": (files[".github/workflows/ci.yml"] || "").replace(/FOUNDRY_SHA256:.*\r?\n/, "") };
  if (foundryPinMisses(brokenPin).includes("sha256")) ok("breaking run REDDENS: a missing Foundry SHA-256 is caught");
  else bad("breaking run does not catch a missing Foundry SHA-256");
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "ci scripts: " + pass + " checks passed.");
if (fails.length) process.exit(1);
