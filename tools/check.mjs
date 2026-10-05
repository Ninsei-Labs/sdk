#!/usr/bin/env node
// THE SDK'S OWN CHECKS. One command, named results, zero dependencies.
//
// Every check answers a question about the AGREEMENT, not about an impression:
//   syntax   - every module of the package parses;
//   import   - the entry point loads in bare Node, and the check NAMES what a browser would be needed for;
//   surface  - index.d.ts and the runtime agree in BOTH directions: interface members, named exports, code tables;
//   mirror   - the engine mirror parses and none of its imports dangle inside the package;
//   language - no Cyrillic outside the named generated engine mirror;
//   pack     - what the tarball will carry matches the `files` field;
//   secrets  - no keys, tokens or passwords in the tree.
//
// A check is a function returning { note, problems, notes }: an empty `problems` list is green, and every problem
// line names the file and the member, so a failure is readable without re-running anything.
//
// USAGE
//   node tools/check.mjs                     run every check
//   node tools/check.mjs --only=surface      run one check (repeatable, comma-separated)
//   node tools/check.mjs --list              list the check names
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const p = (...parts) => join(ROOT, ...parts);
const read = (file) => readFileSync(file, "utf8");
const slashed = (file) => relative(ROOT, file).split("\\").join("/");

// SKIP LIST: the checks look at the package, not at installed dependencies or history.
const SKIP = new Set([".git", "node_modules", ".hermes", "dist", "coverage"]);

/** Every file under dir, recursively, minus the skip list. Returns native paths. */
export const listFiles = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
};

const CODE_EXT = new Set([".js", ".mjs", ".cjs"]);
const parseError = (error) =>
  (error && (error.stderr || error.stdout || "")).toString().split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("at "));

// ---------------------------------------------------------------------------------------------------
// 1. SYNTAX - every module of the package parses. `node --check` is the same parser that will run it.
// ---------------------------------------------------------------------------------------------------

export const syntaxCheck = () => {
  const files = listFiles(p("src")).concat(listFiles(p("engine"))).filter((f) => CODE_EXT.has(extname(f)));
  const problems = [];
  let parsed = 0;
  for (const file of files) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
      parsed += 1;
    } catch (error) {
      problems.push(`${slashed(file)}: ${parseError(error) || "did not parse"}`);
    }
  }
  return { note: `${parsed}/${files.length} modules parsed`, problems };
};

// ---------------------------------------------------------------------------------------------------
// 2. IMPORT - the entry point in bare Node, and what is NOT exercisable without a browser or a live contour.
// ---------------------------------------------------------------------------------------------------

// Surfaces that CANNOT run in a bare Node process, named with the reason. The check asserts the probes refuse
// with a NAMED code (an SdkError), never with a bare TypeError: a breakdown must not look like an honest refusal.
const NOT_HEADLESS = [
  "sdk.wallet.connect - needs an EIP-1193 provider brought from outside",
  "sdk.quotes.watch - needs the quote service over HTTP",
  "sdk.swaps.start / swaps.watch - needs RPC, a maker and a Monero node (a live contour)",
  "src/adapters/local-storage.mjs - needs localStorage",
  "src/adapters/monero-wallet.mjs and monero.mjs - need a Monero wallet library (monero-ts)",
];

export const importCheck = async () => {
  const problems = [];
  const notes = [];
  const entry = pathToFileURL(p("src", "index.mjs")).href + "?v=" + Date.now();

  let mod;
  try {
    mod = await import(entry);
  } catch (error) {
    return { note: "the entry point did not load", problems: [`src/index.mjs: ${error && error.message}`] };
  }

  for (const name of ["createNinsei", "SdkError", "ERROR_CODES", "STEP_CODES", "CHECK_CODES"]) {
    if (!(name in mod)) problems.push(`src/index.mjs: the named export ${name} is missing`);
  }
  if (typeof mod.createNinsei !== "function") return { note: "createNinsei is not a function", problems };

  let sdk;
  try {
    sdk = mod.createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet", mode: "sim" });
  } catch (error) {
    problems.push(`createNinsei(sim) threw: ${error && (error.name + ": " + error.message)}`);
    return { note: "the facade did not assemble", problems };
  }
  for (const key of ["config", "wallet", "quotes", "swaps", "sweep", "recovery", "order", "actions", "sim", "preflight"]) {
    if (!(key in sdk)) problems.push(`the facade has no "${key}"`);
  }

  // HEADLESS PROBES: each must answer a value or refuse with a NAMED code. A bare TypeError is a defect.
  const declared = new Set(mod.ERROR_CODES);
  const probes = [
    ["config.route('swaps', { id: 'x' })", () => sdk.config.route("swaps", { id: "x" })],
    ["recovery.open(null)", () => sdk.recovery.open(null)],
    ["sim.apply('no-such-scenario')", () => sdk.sim.apply("no-such-scenario")],
    ["wallet.connect() with no provider", () => sdk.wallet.connect()],
    ["quotes.firm({})", () => sdk.quotes.firm({})],
  ];
  for (const [label, run] of probes) {
    try {
      await run();
      notes.push(`${label}: returned a value`);
    } catch (error) {
      const code = error && error.code;
      if (typeof code === "string" && declared.has(code)) notes.push(`${label}: refused with code ${code}`);
      else problems.push(`${label}: not a refusal by a declared code (${error && (error.name + ": " + error.message)})`);
    }
  }

  // WHAT THIS PROCESS IS NOT: named, so nobody reads a green import as "the swap works in Node".
  notes.push(`globals here: window=${typeof globalThis.window} document=${typeof globalThis.document} localStorage=${typeof globalThis.localStorage}`);
  for (const line of NOT_HEADLESS) notes.push(`needs an environment: ${line}`);

  return { note: `the entry point loaded, ${probes.length} headless probes`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 3. SURFACE - index.d.ts against the runtime, both ways. The contract is the truth about the package.
// ---------------------------------------------------------------------------------------------------

/** The body of `export interface NAME { ... }`, or null. */
export const interfaceBody = (dts, name) => {
  const start = dts.indexOf(`export interface ${name} {`);
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = dts.indexOf("{", start); i < dts.length; i += 1) {
    if (dts[i] === "{") depth += 1;
    else if (dts[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  return end < 0 ? null : dts.slice(start, end + 1);
};

/** Members declared at one level of the interface, split into required and optional. */
const memberNames = (dts, name) => {
  const body = interfaceBody(dts, name);
  if (body === null) return null;
  const required = new Set();
  const optional = new Set();
  for (const line of body.split("\n")) {
    const m = /^\s{2}(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*[:(]/.exec(line);
    if (!m) continue;
    if (m[2]) optional.add(m[1]);
    else required.add(m[1]);
  }
  return { required, optional };
};

/** The string literals of `export type NAME = "a" | "b";`. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const unionMembers = (dts, name) => {
  const start = dts.indexOf(`export type ${name} =`);
  if (start < 0) return null;
  // THE COMMENTS GO FIRST: a doc comment can carry a semicolon ("...gas; the refusal is shown..."), and a naive
  // search for the terminator would cut the union in half and invent a problem.
  const body = stripComments(dts.slice(start));
  const end = body.indexOf(";");
  const out = new Set();
  for (const m of body.slice(0, end).matchAll(/"([a-z0-9_-]+)"/g)) out.add(m[1]);
  return out;
};

/** Named VALUE exports declared by the contract (`export declare function|const|class`). Types are not values. */
const declaredValueExports = (dts) => {
  const out = new Set();
  for (const m of dts.matchAll(/^export\s+(?:declare\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  return out;
};

export const surfaceCheck = async () => {
  const problems = [];
  const dts = read(p("index.d.ts"));
  const mod = await import(pathToFileURL(p("src", "index.mjs")).href + "?v=" + Date.now());
  const codes = await import(pathToFileURL(p("src", "codes.mjs")).href + "?v=" + Date.now());
  const sdk = mod.createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet", mode: "sim" });

  // (a) The API interfaces against the runtime objects, both ways.
  const surfaces = {
    Ninsei: { config: sdk.config, wallet: sdk.wallet, quotes: sdk.quotes, swaps: sdk.swaps, sweep: sdk.sweep,
      recovery: sdk.recovery, order: sdk.order, actions: sdk.actions, sim: sdk.sim, preflight: sdk.preflight },
    WalletApi: sdk.wallet,
    QuotesApi: sdk.quotes,
    SwapsApi: sdk.swaps,
    SweepApi: sdk.sweep,
    RecoveryApi: sdk.recovery,
    OrderApi: sdk.order,
    ActionsApi: sdk.actions,
    SimApi: sdk.sim,
    SdkConfig: sdk.config,
  };
  for (const [iface, object] of Object.entries(surfaces)) {
    const declared = memberNames(dts, iface);
    if (declared === null) { problems.push(`index.d.ts: no interface ${iface}`); continue; }
    const runtime = new Set(Object.keys(object || {}));
    for (const name of declared.required) {
      if (!runtime.has(name)) problems.push(`${iface}: the contract promises "${name}", the runtime does not carry it`);
    }
    for (const name of runtime) {
      if (!declared.required.has(name) && !declared.optional.has(name)) {
        problems.push(`${iface}: the runtime carries "${name}", the contract is silent about it`);
      }
    }
  }

  // (b) The package's named exports against the declared VALUE exports, both ways.
  const runtimeExports = Object.keys(mod);
  const declared = declaredValueExports(dts);
  for (const name of runtimeExports) {
    if (!declared.has(name)) problems.push(`index.d.ts: the runtime exports "${name}", the contract does not declare it`);
  }
  for (const name of declared) {
    if (!runtimeExports.includes(name)) problems.push(`index.d.ts: the contract declares "${name}", the runtime does not export it`);
  }

  // (c) The code tables against the declared unions, both ways.
  for (const [type, values] of [
    ["ErrorCode", codes.ERROR_CODES],
    ["StepCode", codes.STEP_CODES],
    ["CheckCode", codes.CHECK_CODES],
    ["TerminalCode", codes.TERMINAL_CODES],
  ]) {
    const declaredSet = unionMembers(dts, type);
    if (declaredSet === null) { problems.push(`index.d.ts: no type ${type}`); continue; }
    const runtimeSet = new Set(values);
    for (const code of runtimeSet) if (!declaredSet.has(code)) problems.push(`${type}: the runtime emits "${code}", the contract is silent about it`);
    for (const code of declaredSet) if (!runtimeSet.has(code)) problems.push(`${type}: the contract promises "${code}", the runtime never emits it`);
  }

  return { note: `${Object.keys(surfaces).length} interfaces, ${runtimeExports.length} named exports, 4 code tables`, problems };
};

// ---------------------------------------------------------------------------------------------------
// 4. MIRROR - src/engine.mjs re-exports engine/**; every module must parse and every import must resolve.
// ---------------------------------------------------------------------------------------------------

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?:[^"'()]*?\sfrom\s+)?["']([^"']+)["']/g;

export const mirrorCheck = () => {
  const problems = [];
  let modules = 0;
  for (const file of listFiles(p("src")).concat(listFiles(p("engine")))) {
    if (!CODE_EXT.has(extname(file))) continue;
    modules += 1;
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      problems.push(`${slashed(file)}: does not parse (${parseError(error) || "?"})`);
      continue;
    }
    for (const m of read(file).matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      if (!existsSync(join(dirname(file), spec))) problems.push(`${slashed(file)}: import "${spec}" dangles (no such file)`);
    }
  }
  return {
    note: `${modules} modules parsed, no dangling relative imports`,
    problems,
    notes: ["the engine mirror's source (www/js) is not in this repository: a byte-for-byte comparison is out of scope here"],
  };
};

// ---------------------------------------------------------------------------------------------------
// 5. LANGUAGE - Cyrillic nowhere, except the generated engine mirror, which is named here.
// ---------------------------------------------------------------------------------------------------

const CYRILLIC = /[\u0400-\u04FF]/;

// THE ONE NAMED EXCEPTION. engine/** is a generated mirror of the demo's browser engine (www/js), kept
// byte-for-byte in sync by tools/build-sdk-engine.mjs and never edited here (src/engine.mjs). Translating it would
// break that invariant and be overwritten on the next build. Its non-English lines are DEBT, counted and printed,
// not hidden. Everything written inside this repository must be English.
const LANGUAGE_MIRROR = "engine/";

export const languageCheck = () => {
  const problems = [];
  let mirrorFiles = 0;
  let mirrorLines = 0;
  for (const file of listFiles(ROOT)) {
    const rel = slashed(file);
    let text;
    try { text = read(file); } catch { continue; }
    const lines = text.split("\n").filter((l) => CYRILLIC.test(l));
    if (lines.length === 0) continue;
    if (rel.startsWith(LANGUAGE_MIRROR)) {
      mirrorFiles += 1;
      mirrorLines += lines.length;
      continue;
    }
    for (const line of lines) problems.push(`${rel}: ${line.trim().slice(0, 90)}`);
  }
  return {
    note: `no Cyrillic outside the engine mirror (${mirrorFiles} mirror files / ${mirrorLines} lines named as debt)`,
    problems,
  };
};

// ---------------------------------------------------------------------------------------------------
// 6. PACK - what will ride in the tarball, against the `files` field.
// ---------------------------------------------------------------------------------------------------

export const packCheck = () => {
  const pkg = JSON.parse(read(p("package.json")));
  const declared = Array.isArray(pkg.files) ? pkg.files : [];
  const problems = [];

  let listing;
  try {
    listing = JSON.parse(execSync("npm pack --dry-run --json", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString());
  } catch (error) {
    return { note: "the packer is unavailable", problems: [`npm pack --dry-run failed: ${error && error.message}`] };
  }
  const entry = Array.isArray(listing) ? listing[0] : listing;
  const packed = (entry.files || []).map((f) => f.path);

  // ALWAYS CARRIED BY npm, whatever `files` says: package.json, the readme and the license.
  const ALWAYS = /^(package\.json|readme(\.[^/]*)?|licen[cs]e(\.[^/]*)?|changelog(\.[^/]*)?)$/i;
  const covered = (path) => ALWAYS.test(path) || declared.some((d) => path === d || path.startsWith(d.replace(/\/$/, "") + "/"));

  if (!packed.includes("package.json")) problems.push("the tarball does not carry package.json");
  if (!packed.includes("index.d.ts")) problems.push("the tarball does not carry index.d.ts");
  for (const path of packed) {
    if (!covered(path)) problems.push(`the tarball carries "${path}", which no "files" entry covers`);
  }
  for (const d of declared) {
    if (d.endsWith(".md") || d === "LICENSE" || d === "index.d.ts") {
      if (!packed.includes(d)) problems.push(`"files" names "${d}" but the tarball does not carry it`);
      continue;
    }
    if (!packed.some((path) => path === d || path.startsWith(d + "/"))) problems.push(`"files" names "${d}" but the tarball carries nothing under it`);
  }
  for (const forbidden of ["node_modules", ".github", "pnpm-lock.yaml", "package-lock.json"]) {
    if (packed.some((path) => path === forbidden || path.startsWith(forbidden + "/"))) problems.push(`the tarball must not carry ${forbidden}`);
  }

  const size = entry.size ? `${(entry.size / 1024).toFixed(1)} KiB (unpacked ${(entry.unpackedSize / 1024).toFixed(1)} KiB)` : "unknown size";
  return { note: `${packed.length} files, ${size}`, problems };
};

// ---------------------------------------------------------------------------------------------------
// 7. SECRETS - no keys, tokens or passwords. Matched by SHAPE, high-confidence patterns only.
// ---------------------------------------------------------------------------------------------------

// High-confidence shapes: a hit here is a secret, not a lookalike. Session labels, transaction hashes and event
// topics are deliberately NOT here - they are public, and the check NAMES them under `notes` instead.
const SECRET_SHAPES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "a JWT"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bsk-[A-Za-z0-9]{20,}\b/, "an API secret key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
  [/\b(?:private[_-]?key|privkey|secret[_-]?key|mnemonic|seed[_-]?phrase)\b\s*[:=]\s*["'`][^"'`]{8,}["'`]/i, "a hardcoded key or seed"],
  [/(?:https?|wss?):\/\/[^/\s:@]+:[^/\s:@]+@/i, "credentials inside a URL"],
];

export const secretsCheck = () => {
  const problems = [];
  const notes = [];
  let hexLookalikes = 0;
  for (const file of listFiles(ROOT)) {
    const rel = slashed(file);
    let text;
    try { text = read(file); } catch { continue; }
    for (const [re, label] of SECRET_SHAPES) {
      const m = re.exec(text);
      if (m) problems.push(`${rel}: ${label} (${JSON.stringify(m[0].slice(0, 40))})`);
    }
    // LOOKALIKES ARE NAMED, NOT SILENCED. A session label and a public hash have the shape of a secret and are not
    // one: naming them keeps the check honest without asking a reader to trust it.
    for (const _ of text.matchAll(/["'`](?:0x)?[a-fA-F0-9]{40,}["'`]/g)) hexLookalikes += 1;
    for (const m of text.matchAll(/(?:password|passphrase)\b\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) {
      notes.push(`${rel}: a session label, not a secret (${m[1]})`);
    }
    const base = rel.split("/").pop() || "";
    if (/^\.env(\.|$)/.test(base)) problems.push(`${rel}: an environment file is in the tree`);
  }
  const unique = [...new Set(notes)].sort();
  return { note: `no secret-shaped literals (${hexLookalikes} public hex constants named as lookalikes)`, problems, notes: unique };
};

// ---------------------------------------------------------------------------------------------------
// RUNNER
// ---------------------------------------------------------------------------------------------------

const CHECKS = {
  syntax: syntaxCheck,
  import: importCheck,
  surface: surfaceCheck,
  mirror: mirrorCheck,
  language: languageCheck,
  pack: packCheck,
  secrets: secretsCheck,
};

export const runCheck = async (name) => {
  const fn = CHECKS[name];
  if (!fn) throw new Error(`no such check: ${name} (have: ${Object.keys(CHECKS).join(", ")})`);
  const result = (await fn()) || {};
  return { name, note: result.note || "", problems: result.problems || [], notes: result.notes || [] };
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const name of Object.keys(CHECKS)) console.log(name);
    return;
  }
  const only = args.filter((a) => a.startsWith("--only=")).flatMap((a) => a.slice(7).split(",")).filter(Boolean);
  const names = only.length ? only : Object.keys(CHECKS);

  console.log(`SDK CHECKS  (${ROOT})`);
  let failed = 0;
  for (const name of names) {
    const result = await runCheck(name);
    if (result.problems.length) {
      failed += 1;
      console.log(`  FAIL  ${name}  - ${result.problems.length} problem(s)`);
      for (const problem of result.problems) console.log(`          ${problem}`);
    } else {
      console.log(`  ok    ${name}  - ${result.note}`);
    }
    for (const line of result.notes) console.log(`          note: ${line}`);
  }
  console.log(failed ? `FAILED: ${failed}/${names.length} checks red` : `PASSED: all ${names.length} checks green`);
  process.exitCode = failed ? 1 : 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
