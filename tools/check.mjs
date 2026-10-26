#!/usr/bin/env node
// THE SDK'S OWN CHECKS. One command, named results, zero dependencies.
//
// Every check answers a question about the AGREEMENT, not about an impression:
//   syntax   - every module of the package parses;
//   import   - the entry point loads in bare Node, and the check NAMES what a browser would be needed for;
//   surface  - index.d.ts and the runtime agree in BOTH directions: interface members, named exports, code tables;
//   mirror   - the engine mirror parses and none of its imports dangle inside the package;
//   pack     - what the tarball will carry matches the `files` field;
//   secrets  - no keys, tokens or passwords in the tree.
//   cow      - the CoWSwap order EIP-712 golden vector (real on-chain orders), the async seam, a breaking run;
//   cow-refusal - unreachable, an unexpected shape and a timeout are NAMED refusals, never silence or null.
//
// A check is a function returning { note, problems, notes }: an empty `problems` list is green, and every problem
// line names the file and the member, so a failure is readable without re-running anything.
//
// USAGE
//   node tools/check.mjs                     run every check
//   node tools/check.mjs --only=surface      run one check (repeatable, comma-separated)
//   node tools/check.mjs --list              list the check names
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// AN INDEPENDENT KECCAK-256 FOR THE DECLINE CHECK (issue #40): the topic of the escrow's `Declined` event is
// pinned as a literal AND recomputed with THIS implementation, while the module under test computes it with
// @noble/hashes - two implementations agreeing is a cross-check, one agreeing with itself is not.
import keccakPkg from "keccak256";
// THE RECOVERY KEY CHECK (sdk#79): one key, its backup file, reservations and the on-chain search.
import { recoveryKeyCheck } from "./check-recovery-key.mjs";
import { sweepWindowCheck } from "./check-sweep-window.mjs";
import { sweepFromOrderCheck } from "./check-sweep-order.mjs";
import { sweepAdapterCheck } from "./check-sweep-adapter.mjs";
import { claimTipCheck } from "./check-claim-tip.mjs";
import { claimSenderCheck } from "./check-claim-sender.mjs";
import { quoteRankCheck } from "./check-quote-rank.mjs";
import { settlementProfilesCheck } from "./check-settlement-profiles.mjs";

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
// 5. PACK - what will ride in the tarball, against the `files` field.
// ---------------------------------------------------------------------------------------------------

// THE PACKER'S CONTAINER CHANGED SHAPE, SO THE READER READS BOTH - AND REFUSES ANY THIRD ONE BY NAME.
//
// `npm pack --dry-run --json` answers an ARRAY holding one entry up to npm 11, and an OBJECT KEYED BY PACKAGE NAME
// from npm 12. Measured on this machine, node 26.7.0's bundled npm 11.19.0 against the standalone npm 12.0.2: the
// same package, the same 104 files, the same sizes, the same shasum and integrity - only the container differs.
// Reading one container alone does not fail loudly: `entry.files` comes back `undefined`, the listing stands empty
// and the check reports a tarball carrying nothing - eight problems that do not exist, on a run that must be green.
// So the reader takes the ONE entry out of either container and hands the assertions below exactly the value they
// have always been given.
//
// ANY OTHER SHAPE IS A REFUSAL THAT NAMES ITSELF, never "no files". An empty answer, a container holding more than
// one entry and a container that is neither of the two are each a case where guessing would report an agreement
// that was never checked: the day the packer changes shape again, this reddens HERE with the shape written out,
// instead of passing as a tarball that carries nothing.
const shapeOfListing = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `an array of ${value.length} entries`;
  if (typeof value === "object") return `an object with ${Object.keys(value).length} key(s)`;
  return `a ${typeof value} (${JSON.stringify(value).slice(0, 60)})`;
};

/** The ONE entry the packer packed, out of whichever container it chose - or the reasons its answer cannot be read. */
export const packListing = (listing) => {
  const refuse = (reason) => ({ problems: [`the packer answered ${reason}`] });

  if (Array.isArray(listing)) {
    // npm 11: [ entry ]
    if (listing.length === 0) return refuse("an empty listing - an array of 0 entries. A tarball cannot be empty, and an empty answer is not agreement");
    if (listing.length > 1) return refuse(`an array of ${listing.length} entries - one package was packed, so this is not this package's answer`);
    return { entry: listing[0], problems: [] };
  }

  if (listing && typeof listing === "object") {
    // npm 12: { "package-name": entry }
    const names = Object.keys(listing);
    if (names.length === 0) return refuse("an object with no keys - an object keyed by package name has to name the package that was packed");
    if (names.length > 1) return refuse(`an object keyed by ${names.length} package names (${names.slice(0, 3).map((n) => JSON.stringify(n)).join(", ")}${names.length > 3 ? ", ..." : ""}) - one package was packed`);
    const entry = listing[names[0]];
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.files)) {
      return refuse(`${JSON.stringify(names[0])} without a \`files\` list (${entry === undefined ? "no entry at all" : `an entry that is ${shapeOfListing(entry)}`}) - an entry carrying no file list cannot be read`);
    }
    return { entry, problems: [] };
  }

  return refuse(`${shapeOfListing(listing)} - npm 11 answers an array of one entry and npm 12 an object keyed by the package name, and neither of those is this`);
};

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
  // THE CONTAINER IS READ, THE CONTENTS ARE NOT: whichever shape arrived, everything below sees the same entry.
  // A shape this reader does not know stops here, by name, instead of arriving as a tarball with no files.
  const answer = packListing(listing);
  if (answer.problems.length) return { note: "the packer's answer is not a listing this check can read", problems: answer.problems };
  const entry = answer.entry;
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
// 6. SECRETS - no keys, tokens or passwords. Matched by SHAPE, high-confidence patterns only.
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
// 7. COW - THE ASYNCHRONOUS ROUTE PROVIDER. A GOLDEN VECTOR (a real on-chain order), the seam's async gate and a
//    BREAKING RUN that shows the vector is load-bearing.
//
// WHY THESE ASSERTIONS ARE ABOUT AGREEMENT, NOT AN IMPRESSION. Every external fact (the order type, the domain, the
// markers, the UID layout) comes from CoW Protocol's own source; here it is RECOMPUTED with the repository's own
// keccak256/secp256k1 and compared. Two REAL settled orders are pinned: their EIP-712 digest, computed from the
// order fields alone, must equal the digest half of the on-chain UID the order book returns for them. That is the
// one check no amount of reasoning replaces - a wrong field, a wrong domain or a wrong type reddens it at once.
// ---------------------------------------------------------------------------------------------------

const COW_SRC = () => p("src", "legs", "cow-spec.mjs");
const loadFresh = (file) => import(pathToFileURL(file).href + "?v=" + Date.now());

// THE REAL ORDERS (fetched live from the CoW order book; the UID is what the book returns, the fields are the order
// the settlement signed). Source: GET https://api.cow.fi/mainnet/api/v1/orders/<uid>.
//   1) https://api.cow.fi/mainnet/api/v1/orders/0xff2e2e54d178997f173266817c1e9ed6fee1a1aae4b43971c53b543cffcc2969845c6f5599fbb25dbdd1b9b013daf85c03f3c63763e4bc4a
//   2) https://api.cow.fi/mainnet/api/v1/orders/0x84732fe35a973fcc2325e59c6f8a09cda9604b60ff67c0b2399268301ba048c2845c6f5599fbb25dbdd1b9b013daf85c03f3c63763e4bc92
const COW_VECTORS = [
  {
    uid: "0xff2e2e54d178997f173266817c1e9ed6fee1a1aae4b43971c53b543cffcc2969845c6f5599fbb25dbdd1b9b013daf85c03f3c63763e4bc4a",
    digest: "0xff2e2e54d178997f173266817c1e9ed6fee1a1aae4b43971c53b543cffcc2969",
    owner: "0x845c6f5599fbb25dbdd1b9b013daf85c03f3c637",
    chainId: 1,
    order: {
      sellToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      receiver: "0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7", sellAmount: "9999933530961133759600", buyAmount: "16145549636832",
      validTo: 1675934794, appData: "0x2b8694ed30082129598720860e8e972f07aa10d9b81cae16ca0e2cfb24743e24",
      feeAmount: "66469038866240400", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20",
    },
  },
  {
    uid: "0x84732fe35a973fcc2325e59c6f8a09cda9604b60ff67c0b2399268301ba048c2845c6f5599fbb25dbdd1b9b013daf85c03f3c63763e4bc92",
    digest: "0x84732fe35a973fcc2325e59c6f8a09cda9604b60ff67c0b2399268301ba048c2",
    owner: "0x845c6f5599fbb25dbdd1b9b013daf85c03f3c637",
    chainId: 1,
    order: {
      sellToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      receiver: "0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7", sellAmount: "9999927155859181783264", buyAmount: "16145360877874",
      validTo: 1675934866, appData: "0x2b8694ed30082129598720860e8e972f07aa10d9b81cae16ca0e2cfb24743e24",
      feeAmount: "72844140818216736", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20",
    },
  },
];

// A deterministic signature vector: the same private key always signs the same digest the same way (RFC 6979), so
// the fixed signature catches any change to the encoding, and the recovery pins the signer address.
const COW_TEST_KEY = "0x" + "11".repeat(32);
const COW_TEST_SIG = "0xa5d640c50694953643434964f4336db36ffb8fcd4968a85d795df2897f05f7a2297b23b529ec365d19e1dcb5b5e033d76e37cf2b6de50f89c19300158568c4161c";
const COW_TEST_ADDRESS = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";

export const cowCheck = async () => {
  const problems = [];
  const notes = [];
  const legs = await loadFresh(p("src", "legs", "cow.mjs"));
  const spec = await loadFresh(COW_SRC());
  const shape = await loadFresh(p("src", "legs", "shape.mjs"));
  const evm = await loadFresh(p("src", "legs", "evm.mjs"));
  const { keccak256 } = await import(pathToFileURL(p("src", "primitives.mjs")).href);
  const toHex = (bytes) => { let out = "0x"; for (const b of bytes) out += b.toString(16).padStart(2, "0"); return out; };

  // (a) THE TYPE AND ITS HASH AGAINST COW PROTOCOL'S OWN CONSTANT. A typo in the field list would change the digest
  // and make every order unusable - so the recomputed hash must equal GPv2Order.TYPE_HASH.
  const recomputedTypeHash = toHex(keccak256(spec.COW_ORDER_TYPE));
  if (recomputedTypeHash !== spec.COW_ORDER_TYPE_HASH) {
    problems.push(`the order type does not hash to GPv2Order.TYPE_HASH: computed ${recomputedTypeHash}, constant ${spec.COW_ORDER_TYPE_HASH}`);
  } else {
    notes.push(`the order type hashes to GPv2Order.TYPE_HASH ${spec.COW_ORDER_TYPE_HASH}`);
  }
  // The kind/balance markers must equal the contract's constants (keccak256 of the marker strings).
  if (spec.cowKindMarker("sell") !== "0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775") {
    problems.push("the sell marker is not keccak256(\"sell\") as GPv2Order.KIND_SELL declares");
  }
  if (spec.cowBalanceMarker("erc20") !== "0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9") {
    problems.push("the erc20 balance marker is not keccak256(\"erc20\") as GPv2Order.BALANCE_ERC20 declares");
  }

  // (b) THE GOLDEN VECTORS: real orders, digest from fields alone, against the UID the order book returns.
  for (const v of COW_VECTORS) {
    let digest;
    try {
      digest = spec.cowOrderDigestHex({ order: v.order, chainId: v.chainId });
    } catch (error) {
      problems.push(`vector ${v.uid.slice(0, 10)}: the digest did not compute (${error && error.message})`);
      continue;
    }
    if (digest !== v.digest) problems.push(`vector ${v.uid.slice(0, 10)}: the digest is ${digest}, expected ${v.digest}`);
    else notes.push(`vector ${v.uid.slice(0, 10)}: the digest matches the on-chain UID`);
    let uid;
    try {
      uid = spec.cowOrderUid({ digest, owner: v.owner, validTo: v.order.validTo });
    } catch (error) {
      problems.push(`vector ${v.uid.slice(0, 10)}: the UID did not assemble (${error && error.message})`);
      continue;
    }
    if (uid !== v.uid) problems.push(`vector ${v.uid.slice(0, 10)}: the UID is ${uid}, expected ${v.uid}`);
    else notes.push(`vector ${v.uid.slice(0, 10)}: digest ++ owner ++ validTo rebuilds the full UID`);
  }

  // (c) THE SIGNATURE VECTOR: the fixed signature and the recovered signer.
  const v0 = COW_VECTORS[0];
  const digest0 = spec.cowOrderDigest({ order: v0.order, chainId: v0.chainId });
  const signature = spec.signCowOrderDigest({ digest: digest0, privateKey: COW_TEST_KEY });
  if (signature !== COW_TEST_SIG) problems.push(`the signature over the golden digest is ${signature}, expected ${COW_TEST_SIG}`);
  else notes.push("the signature over the golden digest is the fixed vector");
  const signer = spec.recoverCowOrderSigner({ digest: digest0, signature });
  if (signer !== COW_TEST_ADDRESS) problems.push(`the signature recovers ${signer}, expected ${COW_TEST_ADDRESS}`);
  else notes.push(`the signature recovers the signer ${COW_TEST_ADDRESS}`);

  // (d) THE SEAM: the async gate refuses by NAME, and the registered provider is complete.
  if (!evm.routeProviders().includes("cowswap")) problems.push("the registry does not carry the cowswap provider");
  const okCow = evm.requireAsyncProvider("cowswap");
  if (!okCow.ok) problems.push(`requireAsyncProvider("cowswap") refused: ${JSON.stringify(okCow)}`);
  if (evm.requireAsyncProvider("declared").reason !== "provider-not-asynchronous") problems.push("a synchronous provider was not refused by requireAsyncProvider with provider-not-asynchronous");
  if (evm.requireSyncProvider("cowswap").reason !== "provider-not-synchronous") problems.push("the async provider was not refused by requireSyncProvider with provider-not-synchronous");
  if (evm.requireAsyncProvider("no-such").reason !== "provider-unknown") problems.push("an unknown provider was not refused with provider-unknown");
  // An async provider that does NOT name what ends execution is refused by name, not treated as synchronous.
  const incomplete = shape.providerShapeVerdict({ id: "stub", kind: "stub", shape: shape.ASYNC });
  if (incomplete.ok || incomplete.reason !== "provider-incomplete") problems.push(`an async provider without settled was not refused with provider-incomplete: ${JSON.stringify(incomplete)}`);
  else notes.push("an async provider without settled is refused with provider-incomplete");

  // (e) THE BREAKING RUN: change one field's type in the order type and the golden digest MUST stop matching. This
  // is the proof the golden vector is load-bearing - a copy of the spec is mutated in a temp dir, the working tree
  // is never touched.
  {
    const dir = mkdtempSync(join(tmpdir(), "cow-breaking-"));
    try {
      const source = readFileSync(COW_SRC(), "utf8").replace(/\r\n/g, "\n");
      const before = source;
      // Roll the fix back: the two amount fields swap places. The field ORDER is the protocol (EIP-712), so a valid
      // digest is still produced - it is simply a DIFFERENT one, which is exactly what "the vector is load-bearing"
      // means. (A type change would instead make the encoder throw - also a redden, but a less instructive one.)
      const mutated = source.replace(
        '  ["sellAmount", "uint256"],\n  ["buyAmount", "uint256"],\n',
        '  ["buyAmount", "uint256"],\n  ["sellAmount", "uint256"],\n');
      if (mutated === before) throw new Error("the breaking-run mutation did not apply: the amount field lines were not found");
      const rewritten = mutated.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) =>
        `from "${pathToFileURL(resolve(dirname(COW_SRC()), rel)).href}"`);
      const file = join(dir, "cow-spec.mjs");
      writeFileSync(file, rewritten, "utf8");
      const broken = await loadFresh(file);
      let brokenDigest = null;
      try { brokenDigest = broken.cowOrderDigestHex({ order: v0.order, chainId: v0.chainId }); } catch { brokenDigest = null; }
      if (brokenDigest === v0.digest || brokenDigest === null) problems.push(`BREAKING RUN did not redden as expected: the digest is ${String(brokenDigest)}`);
      else notes.push(`breaking run REDDENS: reordering the amount fields moves the digest off the golden value (${String(brokenDigest).slice(0, 12)}…)`);
      const brokenTypeHash = (() => { try { return toHex(keccak256(broken.COW_ORDER_TYPE)); } catch { return null; } })();
      if (brokenTypeHash === spec.COW_ORDER_TYPE_HASH) problems.push("BREAKING RUN did not redden the type hash either");
      else notes.push("breaking run also moves the recomputed type hash off GPv2Order.TYPE_HASH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  notes.push("golden vectors are REAL settled CoW mainnet orders (see the two api.cow.fi URLs in the source)");
  return { note: `${COW_VECTORS.length} real-order vectors, 1 signature vector, the async seam`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 8. COW REFUSALS - UNREACHABLE, AN UNEXPECTED SHAPE AND A TIMEOUT ARE NAMED, NEVER SILENCE OR null.
//    A stand-in transport (no network) drives the provider down each failure path.
// ---------------------------------------------------------------------------------------------------

export const cowRefusalCheck = async () => {
  const problems = [];
  const notes = [];
  const cow = await loadFresh(p("src", "legs", "cow.mjs"));
  const UID = "0x" + "cd".repeat(56);
  const response = (status, body) => ({ ok: status < 400, status, json: async () => (typeof body === "function" ? body() : body) });
  const named = (label, result, code) => {
    if (!result || typeof result !== "object") { problems.push(`${label}: the result is not a refusal value (${JSON.stringify(result)})`); return; }
    if (result.ok === true) { problems.push(`${label}: expected a refusal, got ok:true (${JSON.stringify(result).slice(0, 120)})`); return; }
    if (typeof result.code !== "string" || !cow.COW_REFUSAL_CODES.includes(result.code)) { problems.push(`${label}: the refusal code is not named (${JSON.stringify(result.code)})`); return; }
    if (code && result.code !== code) { problems.push(`${label}: expected code ${code}, got ${result.code}`); return; }
    notes.push(`${label}: refused with ${result.code}`);
  };

  const order = { sellToken: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", buyToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", receiver: "0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7", sellAmount: "1", buyAmount: "1", validTo: 1675934794, appData: "0x" + "00".repeat(32), feeAmount: "0", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20" };
  const sig = "0x" + "ab".repeat(65);

  // (1) unreachable: the transport throws (connection or timeout) - not an exception escaping to the caller.
  const throwing = async () => { throw new TypeError("network down"); };
  named("submit: unreachable", await cow.submitCowOrder({ order, signature: sig, owner: "0x" + "11".repeat(20), chainId: 1, fetchImpl: throwing }), "cow-unreachable");
  named("status: unreachable", await cow.cowOrderStatus({ uid: UID, chainId: 1, fetchImpl: throwing }), "cow-unreachable");
  named("settled: unreachable", await cow.cowSettled({ uid: UID, chainId: 1 }, { fetchImpl: throwing, now: () => 0, sleep: async () => {} }), "cow-unreachable");

  // (2) an unexpected shape: 200 with a body that is not an order (no status).
  const weird = async () => response(200, { not: "an order" });
  named("status: unexpected shape", await cow.cowOrderStatus({ uid: UID, chainId: 1, fetchImpl: weird }), "cow-bad-response");
  named("settled: unexpected shape", await cow.cowSettled({ uid: UID, chainId: 1 }, { fetchImpl: weird, now: () => 0, sleep: async () => {} }), "cow-bad-response");
  const unknownStatus = async () => response(200, { status: "teleported" });
  named("status: unknown status word", await cow.cowOrderStatus({ uid: UID, chainId: 1, fetchImpl: unknownStatus }), "cow-bad-response");

  // (3) not settled in time: the order stays open and the clock passes the timeout.
  let t = 0;
  const open = async () => response(200, { status: "open" });
  named("settled: timeout", await cow.cowSettled({ uid: UID, chainId: 1 }, { fetchImpl: open, now: () => (t += 1000), sleep: async () => {}, pollMs: 1000, timeoutMs: 3000 }), "cow-not-settled");

  // (4) an unknown network and a bounded 404: also named.
  named("status: unknown network", await cow.cowOrderStatus({ uid: UID, chainId: 421614, fetchImpl: open }), "cow-unknown-network");
  const notFound = async () => response(404, {});
  named("status: 404", await cow.cowOrderStatus({ uid: UID, chainId: 1, fetchImpl: notFound }), "cow-order-unknown");
  const refused = async () => response(400, { errorType: "InvalidOrder" });
  named("submit: refused by the book", await cow.submitCowOrder({ order, signature: sig, owner: "0x" + "11".repeat(20), chainId: 1, fetchImpl: refused }), "cow-refused");

  // (5) AND THE OTHER WAY: a final status is NOT a refusal - it is the outcome (settled / dead).
  const fulfilled = async () => response(200, { status: "fulfilled" });
  const done = await cow.cowSettled({ uid: UID, chainId: 1 }, { fetchImpl: fulfilled, now: () => 0, sleep: async () => {} });
  if (!(done.ok === true && done.done === true && done.settled === true && done.status === "fulfilled")) problems.push(`settled: a fulfilled order did not end as settled (${JSON.stringify(done)})`);
  else notes.push("settled: a fulfilled order ends as done + settled with status fulfilled");
  const cancelled = async () => response(200, { status: "cancelled" });
  const dead = await cow.cowSettled({ uid: UID, chainId: 1 }, { fetchImpl: cancelled, now: () => 0, sleep: async () => {} });
  if (!(dead.ok === true && dead.done === true && dead.settled === false && dead.status === "cancelled")) problems.push(`settled: a cancelled order did not end as done + not-settled (${JSON.stringify(dead)})`);
  else notes.push("settled: a cancelled order ends as done + not-settled");

  return { note: `${cow.COW_REFUSAL_CODES.length} named refusals, exit paths covered`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 9. KYBER - THE SECOND ASYNCHRONOUS ROUTE PROVIDER (KyberSwap Limit Order). A golden vector from a REAL Maker
//    order, the EIP-712 type against the contract's own type-hash, and a BREAKING RUN that shows the vector is
//    load-bearing.
//
// WHY THESE ASSERTIONS ARE ABOUT AGREEMENT, NOT AN IMPRESSION. The order type, the domain and the field order come
// from KyberSwap's own sources (the DSLOProtocol/DSOrderMixin contract and the order book's sign-message response);
// here they are RECOMPUTED with the repository's own keccak256/secp256k1 and compared. One REAL order returned by
// KyberSwap's Taker API is pinned: the EIP-712 digest recomputed from its fields alone must be a digest over which
// the order's OWN signature recovers its maker address. That is the anchor no amount of reasoning replaces.
// ---------------------------------------------------------------------------------------------------

const KYBER_SDK_SPEC = () => p("src", "legs", "kyber-spec.mjs");

// THE REAL ORDER (KyberSwap Limit Order Taker API example, order id 22444 on Polygon; docs.kyberswap.com, "Taker
// API" / "Get Orders By Token Pair"): the fields are the order the Maker signed, and `signature` is that Maker's own
// 65-byte signature as the order book returns it. Source:
//   https://docs.kyberswap.com/developer-guide/limit-order-api/api-reference/taker-api
// The order book ALSO returns an `orderHash` field for this order; recomputing the EIP-712 digest from the same
// fields and domain did NOT reproduce that value, so it is deliberately NOT used as an anchor (the order's own
// signature IS used). The contract's hashOrder() is this digest (DSOrderMixin, verified source).
const KYBER_VECTOR = {
  chainId: 137,
  contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C",
  digest: "0x72d3f161df21eaa3c27e3c818828791e9b5874af18902641f41a59318ebc6f6e",
  maker: "0x2bfc3a4ef52fe6cd2c5236da08005c59eafb43a7",
  signature: "0x27c31b3a272e79db13b5e75fddff71b070346cf3a3e5d619ceb766fed82d80e32f3e565c1b741f4a2d0cc44132b18551322f2657a274a2782022bdac7fecd2d21b",
  order: {
    salt: "23992172604416598893041149026939778295",
    makerAsset: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    takerAsset: "0x1c954e8fe737f99f68fa1ccda3e51ebdb291948c",
    maker: "0x2bfc3a4ef52fe6cd2c5236da08005c59eafb43a7",
    receiver: "0x2bfc3a4ef52fe6cd2c5236da08005c59eafb43a7",
    allowedSender: "0x2bfc3a4ef52fe6cd2c5236da08005c59eafb43a7",
    makingAmount: "10000", takingAmount: "20000000000000000",
    feeConfig: "73529011378642731556159749336395186902652258478889",
    makerAssetData: "", takerAssetData: "",
    getMakerAmount: "f4a215c3000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000470de4df820000",
    getTakerAmount: "296637bf000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000470de4df820000",
    predicate: "961d5b1e000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000cab2fa2eeab7065b45cbcf6e3936dde2506b4f6c000000000000000000000000cab2fa2eeab7065b45cbcf6e3936dde2506b4f6c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000044cf6fc6e30000000000000000000000002bfc3a4ef52fe6cd2c5236da08005c59eafb43a7000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002463592c2b000000000000000000000000000000000000000000000000000000006530d1dd00000000000000000000000000000000000000000000000000000000",
    interaction: "",
  },
};

// A deterministic signature vector: the same private key always signs the same digest the same way (RFC 6979), so a
// fixed signature catches any change to the encoding. THIS SIGNATURE IS SELF-GENERATED BY THIS REPOSITORY'S SIGNER
// over the golden digest - it is NOT an external signature; only the vector above carries a real one.
const KYBER_TEST_KEY = "0x" + "11".repeat(32);
const KYBER_TEST_SIG = "0xbe662112931d96d9590574e12977d9aa5cee5e90b5a727672d551fb1d95236285ab81d3de0d54451ebf6556111eb585d736a9752d94740b54b08cc3262f2db111b";
const KYBER_TEST_ADDRESS = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";

export const kyberCheck = async () => {
  const problems = [];
  const notes = [];
  const routes = await loadFresh(p("src", "legs", "kyber.mjs"));
  const spec = await loadFresh(KYBER_SDK_SPEC());
  const evm = await loadFresh(p("src", "legs", "evm.mjs"));
  const { keccak256 } = await import(pathToFileURL(p("src", "primitives.mjs")).href);
  const toHex = (bytes) => { let out = "0x"; for (const b of bytes) out += b.toString(16).padStart(2, "0"); return out; };

  // (a) THE TYPES AGAINST KYBERSWAP'S OWN CONSTANTS. A typo in the field list would change the digest and make every
  // order unusable - so the recomputed hashes must equal the contract's LIMIT_ORDER_TYPEHASH / DS_LIMIT_ORDER_TYPEHASH.
  const orderTypeHash = toHex(keccak256(spec.KYBER_ORDER_TYPE));
  if (orderTypeHash !== spec.KYBER_ORDER_TYPE_HASH) {
    problems.push(`the order type does not hash to DSOrderMixin.LIMIT_ORDER_TYPEHASH: computed ${orderTypeHash}, constant ${spec.KYBER_ORDER_TYPE_HASH}`);
  } else {
    notes.push(`the order type hashes to DSOrderMixin.LIMIT_ORDER_TYPEHASH ${spec.KYBER_ORDER_TYPE_HASH}`);
  }
  const dsTypeHash = toHex(keccak256(spec.KYBER_DS_ORDER_TYPE));
  if (dsTypeHash !== spec.KYBER_DS_ORDER_TYPE_HASH) {
    problems.push(`the DSOrder type does not hash to DSOrderMixin.DS_LIMIT_ORDER_TYPEHASH: computed ${dsTypeHash}, constant ${spec.KYBER_DS_ORDER_TYPE_HASH}`);
  } else {
    notes.push(`the operator co-signature type hashes to DSOrderMixin.DS_LIMIT_ORDER_TYPEHASH ${spec.KYBER_DS_ORDER_TYPE_HASH}`);
  }

  // (b) THE GOLDEN VECTOR: a real order, its digest from fields alone, and its OWN signature recovering the maker.
  const vector = KYBER_VECTOR;
  let digest;
  try {
    digest = spec.kyberOrderDigestHex({ order: vector.order, chainId: vector.chainId, contract: vector.contract });
  } catch (error) {
    problems.push(`the golden digest did not compute (${error && error.message})`);
    digest = null;
  }
  if (digest !== null && digest !== vector.digest) problems.push(`the golden digest is ${digest}, expected ${vector.digest}`);
  else if (digest !== null) notes.push(`the golden digest matches (real order id 22444, chainId ${vector.chainId})`);
  const recoveredReal = digest === null ? null : spec.recoverKyberOrderSigner({ digest: spec.kyberOrderDigest({ order: vector.order, chainId: vector.chainId, contract: vector.contract }), signature: vector.signature });
  if (recoveredReal !== vector.maker) problems.push(`the real order's signature recovers ${recoveredReal}, expected the maker ${vector.maker}`);
  else notes.push(`the real order's own signature recovers its maker ${vector.maker} - the digest is anchored to KyberSwap's API`);
  const missingVector = spec.kyberOrderMissingFields(vector.order);
  if (missingVector.length) problems.push(`the golden order is missing fields: ${missingVector.join(", ")}`);

  // (c) THE SELF-GENERATED SIGNATURE VECTOR (this repository's signer over the golden digest).
  const digestBytes = spec.kyberOrderDigest({ order: vector.order, chainId: vector.chainId, contract: vector.contract });
  const selfSig = spec.signKyberOrderDigest({ digest: digestBytes, privateKey: KYBER_TEST_KEY });
  if (selfSig !== KYBER_TEST_SIG) problems.push(`the self-generated signature over the golden digest is ${selfSig}, expected ${KYBER_TEST_SIG}`);
  else notes.push("the self-generated signature over the golden digest is the fixed vector (this repository's signer)");
  const recoveredSelf = spec.recoverKyberOrderSigner({ digest: digestBytes, signature: selfSig });
  if (recoveredSelf !== KYBER_TEST_ADDRESS) problems.push(`the self-generated signature recovers ${recoveredSelf}, expected ${KYBER_TEST_ADDRESS}`);
  else notes.push(`the self-generated signature recovers ${KYBER_TEST_ADDRESS}`);

  // (d) THE SEAM: the registered provider is the second async one and is complete.
  if (!evm.routeProviders().includes("kyberswap")) problems.push("the registry does not carry the kyberswap provider");
  const okKyber = evm.requireAsyncProvider("kyberswap");
  if (!okKyber.ok) problems.push(`requireAsyncProvider("kyberswap") refused: ${JSON.stringify(okKyber)}`);
  else notes.push("the registry carries the kyberswap provider and it is complete (async + settled)");

  // (e) THE BREAKING RUN: swap the two amount fields in a copy of the spec and the golden digest MUST stop matching.
  // The field ORDER is the protocol (EIP-712), so a valid digest is still produced - a DIFFERENT one, which is
  // exactly what "the vector is load-bearing" means. A copy is mutated in a temp dir; the working tree is untouched.
  {
    const dir = mkdtempSync(join(tmpdir(), "kyber-breaking-"));
    try {
      const source = readFileSync(KYBER_SDK_SPEC(), "utf8").replace(/\r\n/g, "\n");
      const before = source;
      const mutated = source.replace(
        '  ["makingAmount", "uint256"],\n  ["takingAmount", "uint256"],\n',
        '  ["takingAmount", "uint256"],\n  ["makingAmount", "uint256"],\n');
      if (mutated === before) throw new Error("the breaking-run mutation did not apply: the amount field lines were not found");
      const rewritten = mutated.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) =>
        `from "${pathToFileURL(resolve(dirname(KYBER_SDK_SPEC()), rel)).href}"`);
      const file = join(dir, "kyber-spec.mjs");
      writeFileSync(file, rewritten, "utf8");
      const broken = await loadFresh(file);
      let brokenDigest = null;
      try { brokenDigest = broken.kyberOrderDigestHex({ order: vector.order, chainId: vector.chainId, contract: vector.contract }); } catch { brokenDigest = null; }
      if (brokenDigest === vector.digest || brokenDigest === null) problems.push(`BREAKING RUN did not redden as expected: the digest is ${String(brokenDigest)}`);
      else notes.push(`breaking run REDDENS: reordering the amount fields moves the digest off the golden value (${String(brokenDigest).slice(0, 12)}…)`);
      const brokenTypeHash = (() => { try { return toHex(keccak256(broken.KYBER_ORDER_TYPE)); } catch { return null; } })();
      if (brokenTypeHash === spec.KYBER_ORDER_TYPE_HASH) problems.push("BREAKING RUN did not redden the type hash either");
      else notes.push("breaking run also moves the recomputed type hash off DSOrderMixin.LIMIT_ORDER_TYPEHASH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  notes.push("the golden vector is a REAL Maker order from KyberSwap's Taker API (see the docs.kyberswap.com URL in the source); its signature is real, the self-generated one is this repository's");
  return { note: `1 real-order vector, 1 self-generated signature vector, the async seam`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 10. KYBER REFUSALS - UNREACHABLE, AN UNEXPECTED SHAPE, AN UNKNOWN NETWORK, A REFUSAL FROM THE BOOK AND A TIMEOUT
//     ARE NAMED, NEVER SILENCE OR null. A stand-in transport (no network) drives the provider down each failure path.
// ---------------------------------------------------------------------------------------------------

export const kyberRefusalCheck = async () => {
  const problems = [];
  const notes = [];
  const kyber = await loadFresh(p("src", "legs", "kyber.mjs"));
  const MAKER = "0x" + "11".repeat(20);
  const response = (status, body) => ({ ok: status < 400, status, json: async () => (typeof body === "function" ? body() : body) });
  const named = (label, result, code) => {
    if (!result || typeof result !== "object") { problems.push(`${label}: the result is not a refusal value (${JSON.stringify(result)})`); return; }
    if (result.ok === true) { problems.push(`${label}: expected a refusal, got ok:true (${JSON.stringify(result).slice(0, 120)})`); return; }
    if (typeof result.code !== "string" || !kyber.KYBER_REFUSAL_CODES.includes(result.code)) { problems.push(`${label}: the refusal code is not named (${JSON.stringify(result.code)})`); return; }
    if (code && result.code !== code) { problems.push(`${label}: expected code ${code}, got ${result.code}`); return; }
    notes.push(`${label}: refused with ${result.code}`);
  };
  const params = { chainId: "137", maker: MAKER, makerAsset: "0x" + "22".repeat(20), takerAsset: "0x" + "33".repeat(20), receiver: MAKER, makingAmount: "1", takingAmount: "1", expiredAt: 2000000000 };
  const sig = "0x" + "ab".repeat(65);
  const signMessageBody = (over = {}) => ({ code: 0, message: "ok", data: { types: {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }],
    Order: [
      { name: "salt", type: "uint256" }, { name: "makerAsset", type: "address" }, { name: "takerAsset", type: "address" },
      { name: "maker", type: "address" }, { name: "receiver", type: "address" }, { name: "allowedSender", type: "address" },
      { name: "makingAmount", type: "uint256" }, { name: "takingAmount", type: "uint256" }, { name: "feeConfig", type: "uint256" },
      { name: "makerAssetData", type: "bytes" }, { name: "takerAssetData", type: "bytes" }, { name: "getMakerAmount", type: "bytes" },
      { name: "getTakerAmount", type: "bytes" }, { name: "predicate", type: "bytes" }, { name: "interaction", type: "bytes" },
    ] }, domain: { name: ["Kyber", "DSLO", "Protocol"].join(" "), version: "1", chainId: 137, verifyingContract: kyber.kyberContractFor(137) },
    primaryType: "Order", message: { salt: "5", makerAsset: "0x" + "22".repeat(20), takerAsset: "0x" + "33".repeat(20), maker: MAKER, receiver: MAKER, allowedSender: "0x" + "00".repeat(20), makingAmount: "1", takingAmount: "1", feeConfig: "1", makerAssetData: "0x", takerAssetData: "0x", getMakerAmount: "0x", getTakerAmount: "0x", predicate: "0x", interaction: "0x" }, ...over } });

  // (1) unreachable: the transport throws (connection or timeout) - not an exception escaping to the caller.
  const throwing = async () => { throw new TypeError("network down"); };
  named("unsigned: unreachable", await kyber.kyberUnsignedOrder({ params, chainId: 137, fetchImpl: throwing }), "kyber-unreachable");
  named("submit: unreachable", await kyber.kyberSubmitOrder({ params, salt: "5", signature: sig, chainId: 137, fetchImpl: throwing }), "kyber-unreachable");
  named("status: unreachable", await kyber.kyberOrderStatus({ id: 1, chainId: 137, maker: MAKER, fetchImpl: throwing }), "kyber-unreachable");
  named("settled: unreachable", await kyber.kyberSettled({ id: 1, chainId: 137, maker: MAKER }, { fetchImpl: throwing, now: () => 0, sleep: async () => {} }), "kyber-unreachable");

  // (2) an unexpected shape: a body that is not the shape we know (domain for another contract; orders not an array).
  named("unsigned: wrong domain", await kyber.kyberUnsignedOrder({ params, chainId: 137, fetchImpl: async () => response(200, signMessageBody({ domain: { name: "x", version: "1", chainId: 1, verifyingContract: "0x" + "00".repeat(20) } })) }), "kyber-bad-response");
  named("unsigned: empty data", await kyber.kyberUnsignedOrder({ params, chainId: 137, fetchImpl: async () => response(200, { code: 0, message: "ok", data: {} }) }), "kyber-bad-response");
  named("status: orders not an array", await kyber.kyberOrderStatus({ id: 1, chainId: 137, maker: MAKER, fetchImpl: async () => response(200, { code: 0, message: "ok", data: { orders: "nope" } }) }), "kyber-bad-response");
  named("status: unknown status word", await kyber.kyberOrderStatus({ id: 7, chainId: 137, maker: MAKER, fetchImpl: async () => response(200, { code: 0, message: "ok", data: { orders: [{ id: 7, status: "teleported" }] } }) }), "kyber-bad-response");

  // (3) not settled in time: the order stays active (open) and the clock passes the timeout.
  let t = 0;
  const active = async () => response(200, { code: 0, message: "ok", data: { orders: [{ id: 9, status: "open" }] } });
  named("settled: timeout", await kyber.kyberSettled({ id: 9, chainId: 137, maker: MAKER }, { fetchImpl: active, now: () => (t += 1000), sleep: async () => {}, pollMs: 1000, timeoutMs: 3000 }), "kyber-not-settled");

  // (4) an unknown network, a bounded refusal from the book, and an unknown order - also named.
  named("status: unknown network", await kyber.kyberOrderStatus({ id: 1, chainId: 421614, maker: MAKER, fetchImpl: active }), "kyber-unknown-network");
  named("submit: refused by the book", await kyber.kyberSubmitOrder({ params, salt: "5", signature: sig, chainId: 137, fetchImpl: async () => response(400, { code: 4004, message: "native" }) }), "kyber-refused");
  named("status: unknown order", await kyber.kyberOrderStatus({ id: 999, chainId: 137, maker: MAKER, fetchImpl: async () => response(200, { code: 0, message: "ok", data: { orders: [] } }) }), "kyber-order-unknown");

  // (5) AND THE OTHER WAY: a final status is NOT a refusal - it is the outcome (settled / dead).
  const filled = async () => response(200, { code: 0, message: "ok", data: { orders: [{ id: 12, status: "filled" }] } });
  const done = await kyber.kyberSettled({ id: 12, chainId: 137, maker: MAKER }, { fetchImpl: filled, now: () => 0, sleep: async () => {} });
  if (!(done.ok === true && done.done === true && done.settled === true && done.status === "filled")) problems.push(`settled: a filled order did not end as settled (${JSON.stringify(done)})`);
  else notes.push("settled: a filled order ends as done + settled with status filled");
  const dead = await kyber.kyberSettled({ id: 13, chainId: 137, maker: MAKER }, { fetchImpl: async (u, i) => (String(u).includes("status=active") ? response(200, { code: 0, message: "ok", data: { orders: [] } }) : response(200, { code: 0, message: "ok", data: { orders: [{ id: 13, status: "cancelled" }] } })), now: () => 0, sleep: async () => {} });
  if (!(dead.ok === true && dead.done === true && dead.settled === false && dead.status === "cancelled")) problems.push(`settled: a cancelled order did not end as done + not-settled (${JSON.stringify(dead)})`);
  else notes.push("settled: a cancelled order ends as done + not-settled with status cancelled");

  return { note: `${kyber.KYBER_REFUSAL_CODES.length} named refusals, exit paths covered`, problems, notes };
};



// ---------------------------------------------------------------------------------------------------
// 11. COMPOSE - WHAT EACH PROVIDER SETTLES, AND THAT A WRAPPED PROVIDER CANNOT CARRY A NATIVE NEED ALONE.
//
// WHY THIS IS ABOUT AGREEMENT. The escrow is funded with NATIVE coin, so a provider that settles the WRAPPED native
// (KyberSwap Limit Order) can never be the last mile: it is the LIQUIDITY leg of a composition, and reaching native
// is a second order on a native-capable provider (CoWSwap). The capability is DATA (`provider.settles`), not a
// property of the name. This check pins the two values, asserts the native-carrier verdict, and REDDENS a copy whose
// wrapped provider claims native - so the verdict is load-bearing, not decorative.
// ---------------------------------------------------------------------------------------------------

export const composeCheck = async () => {
  const problems = [];
  const notes = [];
  const evm = await loadFresh(p("src", "legs", "evm.mjs"));
  const cow = await loadFresh(p("src", "legs", "cow.mjs"));
  const kyber = await loadFresh(p("src", "legs", "kyber.mjs"));
  const uniswapx = await loadFresh(p("src", "legs", "uniswapx.mjs"));
  const uniswapRelay = await loadFresh(p("src", "legs", "uniswaprelay.mjs"));

  // (a) THE TWO CAPABILITIES ARE DECLARED, AND THEY DIFFER.
  if (cow.cowProvider.settles !== evm.SETTLES.NATIVE) problems.push(`cowswap settles ${String(cow.cowProvider.settles)}, expected ${evm.SETTLES.NATIVE}`);
  else notes.push(`cowswap settles ${evm.SETTLES.NATIVE} (it can buy native directly)`);
  if (kyber.kyberProvider.settles !== evm.SETTLES.WRAPPED) problems.push(`kyberswap settles ${String(kyber.kyberProvider.settles)}, expected ${evm.SETTLES.WRAPPED}`);
  else notes.push(`kyberswap settles ${evm.SETTLES.WRAPPED} (ERC20-only order book: liquidity leg, not a native leg)`);
  if (uniswapx.uniswapxProvider.settles !== evm.SETTLES.NATIVE) problems.push(`uniswapx settles ${String(uniswapx.uniswapxProvider.settles)}, expected ${evm.SETTLES.NATIVE}`);
  else notes.push(`uniswapx settles ${evm.SETTLES.NATIVE} (an output may be the native sentinel)`);
  if (uniswapRelay.uniswapRelayProvider.settles !== evm.SETTLES.NATIVE) problems.push(`uniswaprelay settles ${String(uniswapRelay.uniswapRelayProvider.settles)}, expected ${evm.SETTLES.NATIVE}`);
  else notes.push(`uniswaprelay settles ${evm.SETTLES.NATIVE} (the relayed swap unwraps to native)`);

  // (b) WHO CARRIES A NATIVE NEED ALL THE WAY.
  const cowCarry = evm.carriesNativeVerdict(cow.cowProvider);
  if (cowCarry.ok !== true) problems.push(`cowswap does not carry a native need: ${JSON.stringify(cowCarry)}`);
  else notes.push("cowswap carries a native need all the way (ok: true)");
  const kyberCarry = evm.carriesNativeVerdict(kyber.kyberProvider);
  if (kyberCarry.ok !== false || kyberCarry.reason !== "settles-wrapped") problems.push(`kyberswap should refuse a native need with settles-wrapped, got ${JSON.stringify(kyberCarry)}`);
  else notes.push("kyberswap refuses a native need by name (settles-wrapped) - never the sole provider for native");
  const uniswapxCarry = evm.carriesNativeVerdict(uniswapx.uniswapxProvider);
  if (uniswapxCarry.ok !== true) problems.push(`uniswapx does not carry a native need: ${JSON.stringify(uniswapxCarry)}`);
  else notes.push("uniswapx carries a native need all the way (ok: true) - it is eligible as the native leg of a composition");
  const relayCarry = evm.carriesNativeVerdict(uniswapRelay.uniswapRelayProvider);
  if (relayCarry.ok !== true) problems.push(`uniswaprelay does not carry a native need: ${JSON.stringify(relayCarry)}`);
  else notes.push("uniswaprelay carries a native need all the way (ok: true) - the fourth provider is eligible as the native leg of a composition");
  const unstated = evm.carriesNativeVerdict({ id: "mystery", shape: evm.ASYNC, settled() {} });
  if (unstated.ok !== false || unstated.reason !== "settles-unstated") problems.push(`a provider that does not say what it settles should refuse with settles-unstated, got ${JSON.stringify(unstated)}`);
  else notes.push("a provider that does not declare its settling is refused by name (settles-unstated), never assumed native");

  // (c) THE ASYNC SEAM IS UNTOUCHED: all four are complete async providers.
  for (const id of ["cowswap", "kyberswap", "uniswapx", "uniswaprelay"]) {
    if (!evm.requireAsyncProvider(id).ok) problems.push(`requireAsyncProvider(${id}) refused after the capability was declared`);
  }
  if (evm.routeProviders().length !== 5) problems.push(`the registry should carry five routes (declared + four providers), it carries ${evm.routeProviders().length}`);

  // (d) THE BREAKING RUN: a copy whose wrapped provider claims native MUST stop refusing a native need. The copy is
  // mutated in a temp dir; the working tree is untouched.
  {
    const dir = mkdtempSync(join(tmpdir(), "compose-breaking-"));
    try {
      const src = p("src", "legs", "kyber.mjs");
      const source = readFileSync(src, "utf8");
      const mutated = source.replace('settles: "wrapped",', 'settles: "native",');
      if (mutated === source) throw new Error("the breaking-run mutation did not apply: settles: \"wrapped\" was not found");
      // RELATIVE IMPORTS BECOME ABSOLUTE: the copy lives in a temp dir, so "./shape.mjs" would not resolve there.
      const rewritten = mutated.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) =>
        `from "${pathToFileURL(resolve(dirname(src), rel)).href}"`);
      const file = join(dir, "kyber.mjs");
      writeFileSync(file, rewritten, "utf8");
      const broken = await loadFresh(file);
      const brokenCarry = evm.carriesNativeVerdict(broken.kyberProvider);
      if (brokenCarry.ok !== true) problems.push(`BREAKING RUN did not redden as expected: claiming native still refused (${JSON.stringify(brokenCarry)})`);
      else notes.push("breaking run REDDENS: a wrapped provider claiming native would pass as a native leg - the verdict is load-bearing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // (e) THE BREAKING RUN FOR THE THIRD PROVIDER: a copy whose native provider claims wrapped MUST stop being
  // eligible as a native leg. The copy is mutated in a temp dir; the working tree is untouched.
  {
    const dir = mkdtempSync(join(tmpdir(), "compose-uniswapx-breaking-"));
    try {
      const src = p("src", "legs", "uniswapx.mjs");
      const source = readFileSync(src, "utf8");
      const mutated = source.replace('settles: "native",', 'settles: "wrapped",');
      if (mutated === source) throw new Error("the breaking-run mutation did not apply: settles: \"native\" was not found");
      const rewritten = mutated.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) =>
        `from "${pathToFileURL(resolve(dirname(src), rel)).href}"`);
      const file = join(dir, "uniswapx.mjs");
      writeFileSync(file, rewritten, "utf8");
      const broken = await loadFresh(file);
      const brokenCarry = evm.carriesNativeVerdict(broken.uniswapxProvider);
      if (brokenCarry.ok !== false || brokenCarry.reason !== "settles-wrapped") problems.push(`BREAKING RUN did not redden as expected: claiming wrapped still carried a native need (${JSON.stringify(brokenCarry)})`);
      else notes.push("breaking run REDDENS: a native provider claiming wrapped would lose its native eligibility - the declaration is load-bearing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // (f) THE BREAKING RUN FOR THE FOURTH PROVIDER: a copy whose native relay provider claims wrapped MUST stop being
  // eligible as a native leg. The copy is mutated in a temp dir; the working tree is untouched.
  {
    const dir = mkdtempSync(join(tmpdir(), "compose-uniswaprelay-breaking-"));
    try {
      const src = p("src", "legs", "uniswaprelay.mjs");
      const source = readFileSync(src, "utf8");
      const mutated = source.replace('settles: "native",', 'settles: "wrapped",');
      if (mutated === source) throw new Error("the breaking-run mutation did not apply: settles: \"native\" was not found");
      const rewritten = mutated.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) =>
        `from "${pathToFileURL(resolve(dirname(src), rel)).href}"`);
      const file = join(dir, "uniswaprelay.mjs");
      writeFileSync(file, rewritten, "utf8");
      const broken = await loadFresh(file);
      const brokenCarry = evm.carriesNativeVerdict(broken.uniswapRelayProvider);
      if (brokenCarry.ok !== false || brokenCarry.reason !== "settles-wrapped") problems.push(`BREAKING RUN did not redden as expected: the relay provider claiming wrapped still carried a native need (${JSON.stringify(brokenCarry)})`);
      else notes.push("breaking run REDDENS: the relay provider claiming wrapped loses its native eligibility - the fourth declaration is load-bearing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  return { note: `capabilities declared and the native-carrier verdict holds (${evm.routeProviders().length} routes)`, problems, notes };
};


// ---------------------------------------------------------------------------------------------------
// 12. UNISWAPX - THE THIRD ASYNCHRONOUS ROUTE PROVIDER, THE ONE THAT CAN DELIVER NATIVE ETH. A golden vector from
//     a REAL mainnet Dutch_V2 order, the EIP-712 type against the reactor's own type-hash, the NATIVE sentinel, and
//     a BREAKING RUN that shows the vector is load-bearing.
//
// WHY THESE ASSERTIONS ARE ABOUT AGREEMENT, NOT AN IMPRESSION. The order type, the Permit2 domain, the witness
// typehash (which includes the sub-type definitions - see the spec header) and the NATIVE sentinel all come from
// Uniswap's own sources; here they are RECOMPUTED with the repository's own keccak256/secp256k1 and compared. One
// REAL order the UniswapX order API serves is pinned: the order hash recomputed from its fields alone must equal the
// orderHash the API reports, and the order's OWN signature over the recomputed Permit2 digest must recover its
// swapper. That is the anchor no amount of reasoning replaces.
// ---------------------------------------------------------------------------------------------------

const UNISWAPX_SDK_SPEC = () => p("src", "legs", "uniswapx-spec.mjs");

// THE REAL ORDER (fetched live from the UniswapX order service; the fields are the order the swapper signed, the
// signature is the swapper's own). Source: GET https://api.uniswap.org/v2/orders?chainId=1&orderType=Dutch_V2
//   (type Dutch_V2, orderStatus filled, swapper 0xA7fb5F39eea6BCc2309f6A3C3Cc9954dE5914415).
const UNISWAPX_VECTOR = {
  chainId: 1,
  orderHash: "0x76d2d19315fbf50d2be93985f82bf84e1aab460e9da3e74c7faaff62984de7b3",
  digest: "0xdee763b7288f9a556c48797baf0df9ce6175cf62535ec88ad93bd92a4c05b37a",
  swapper: "0xA7fb5F39eea6BCc2309f6A3C3Cc9954dE5914415",
  signature: "0x387f7ca1b2ae3a7147c54a24670204bfbbe46ff3776417b01737a94cccb293e3541e30a30137834de86012cee6416178917baeafcd2da1ff3faa02ec7cdbb06f1b",
  order: {
    reactor: "0x00000011F84B9aa48e5f8aA8B9897600006289Be",
    swapper: "0xA7fb5F39eea6BCc2309f6A3C3Cc9954dE5914415",
    nonce: "67671623772721360974440381964468983840772806707480559648299766986261008225807",
    deadline: 1791625986,
    additionalValidationContract: "0x0000000000000000000000000000000000000000",
    additionalValidationData: "0x",
    cosigner: "0x4449Cd34d1eb1FEDCF02A1Be3834FfDe8E6A6180",
    baseInputToken: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    baseInputStartAmount: "414534182228591181824",
    baseInputEndAmount: "414534182228591181824",
    baseOutputs: [{
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      startAmount: "3087782687", endAmount: "3072343774",
      recipient: "0xA7fb5F39eea6BCc2309f6A3C3Cc9954dE5914415",
    }],
  },
};

// A deterministic signature vector: the same private key always signs the same digest the same way (RFC 6979), so a
// fixed signature catches any change to the encoding. THIS SIGNATURE IS SELF-GENERATED BY THIS REPOSITORY'S SIGNER
// over the golden digest - it is NOT an external signature; only the vector above carries a real one.
const UNISWAPX_TEST_KEY = "0x" + "11".repeat(32);
const UNISWAPX_TEST_SIG = "0x02ea7cdfaa0c7f9cde94e8d9ad9cdbee2c660dadcedc0758da7b51718e052fbd6eb833a15123b887846327d007c0b2f6a4fa00dff81e9fcb17d4b56bb76d5b6b1b";
const UNISWAPX_TEST_ADDRESS = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";

export const uniswapxCheck = async () => {
  const problems = [];
  const notes = [];
  const routes = await loadFresh(p("src", "legs", "uniswapx.mjs"));
  const spec = await loadFresh(UNISWAPX_SDK_SPEC());
  const evm = await loadFresh(p("src", "legs", "evm.mjs"));
  const { keccak256 } = await import(pathToFileURL(p("src", "primitives.mjs")).href);
  const toHex = (bytes) => { let out = "0x"; for (const b of bytes) out += b.toString(16).padStart(2, "0"); return out; };

  // (a) THE ORDER TYPE AGAINST THE REACTOR'S OWN CONSTANT. The reactor's ORDER_TYPE_HASH is keccak256 of the order
  // type ++ DutchOutput ++ OrderInfo. A typo in the field list would move the hash and sign orders no reactor takes.
  const recomputed = toHex(keccak256(spec.UNISWAPX_HASHED_ORDER_TYPE));
  if (recomputed !== spec.UNISWAPX_ORDER_TYPE_HASH) {
    problems.push(`the order type does not hash to V2DutchOrderLib.ORDER_TYPE_HASH: computed ${recomputed}, constant ${spec.UNISWAPX_ORDER_TYPE_HASH}`);
  } else {
    notes.push(`the order type hashes to V2DutchOrderLib.ORDER_TYPE_HASH ${spec.UNISWAPX_ORDER_TYPE_HASH}`);
  }

  // (b) THE GOLDEN VECTOR: a real order, its hash from fields alone, and its OWN signature recovering the swapper.
  const vector = UNISWAPX_VECTOR;
  let orderHash;
  try { orderHash = spec.uniswapxOrderHashHex(vector.order); }
  catch (error) { problems.push(`the golden order hash did not compute (${error && error.message})`); orderHash = null; }
  if (orderHash !== null && orderHash !== vector.orderHash) problems.push(`the golden order hash is ${String(orderHash)}, expected ${vector.orderHash}`);
  else if (orderHash !== null) notes.push(`the golden order hash matches the UniswapX API (real Dutch_V2 order, chainId ${vector.chainId})`);
  let digest;
  try { digest = spec.uniswapxOrderDigestHex({ order: vector.order, chainId: vector.chainId }); }
  catch (error) { problems.push(`the golden permit digest did not compute (${error && error.message})`); digest = null; }
  if (digest !== null && digest !== vector.digest) problems.push(`the golden permit digest is ${String(digest)}, expected ${vector.digest}`);
  const recoveredReal = digest === null ? null : spec.recoverUniswapxOrderSigner({ digest: spec.uniswapxOrderDigest({ order: vector.order, chainId: vector.chainId }), signature: vector.signature });
  if (recoveredReal !== vector.swapper.toLowerCase()) problems.push(`the real order's signature recovers ${recoveredReal}, expected the swapper ${vector.swapper}`);
  else notes.push(`the real order's own signature recovers its swapper ${vector.swapper} - the Permit2 digest is anchored to UniswapX`);
  const missingVector = spec.uniswapxOrderMissingFields(vector.order);
  if (missingVector.length) problems.push(`the golden order is missing fields: ${missingVector.join(", ")}`);

  // (c) THE SELF-GENERATED SIGNATURE VECTOR (this repository's signer over the golden digest).
  const digestBytes = spec.uniswapxOrderDigest({ order: vector.order, chainId: vector.chainId });
  const selfSig = spec.signUniswapxOrderDigest({ digest: digestBytes, privateKey: UNISWAPX_TEST_KEY });
  if (selfSig !== UNISWAPX_TEST_SIG) problems.push(`the self-generated signature over the golden digest is ${selfSig}, expected ${UNISWAPX_TEST_SIG}`);
  else notes.push("the self-generated signature over the golden digest is the fixed vector (this repository's signer)");
  const recoveredSelf = spec.recoverUniswapxOrderSigner({ digest: digestBytes, signature: selfSig });
  if (recoveredSelf !== UNISWAPX_TEST_ADDRESS) problems.push(`the self-generated signature recovers ${recoveredSelf}, expected ${UNISWAPX_TEST_ADDRESS}`);
  else notes.push(`the self-generated signature recovers ${UNISWAPX_TEST_ADDRESS}`);

  // (d) THE NATIVE OUTPUT MECHANISM: address(0) is the native sentinel, and an order whose output token is it is
  // built and marked nativeOutput - this is what lets the provider carry a route all the way to native ETH.
  if (spec.UNISWAPX_NATIVE !== "0x0000000000000000000000000000000000000000") problems.push(`the native sentinel is ${spec.UNISWAPX_NATIVE}, expected address zero`);
  const nativePlan = routes.uniswapxPlan({
    chainId: 1, swapper: vector.swapper, sellToken: vector.order.baseInputToken, sellAmountWei: "1000000",
    buyToken: spec.UNISWAPX_NATIVE, buyAmountWei: "500000000000000", deadline: 1800000000, nonce: "1",
  });
  if (nativePlan.ok !== true || nativePlan.nativeOutput !== true) problems.push(`an order whose output is the native sentinel was not built as a native route (${JSON.stringify(nativePlan).slice(0, 140)})`);
  else notes.push("an order whose output token is address(0) is built and marked nativeOutput - native ETH as the output");

  // (e) THE SEAM: the registered provider is the third async one and is complete.
  if (!evm.routeProviders().includes("uniswapx")) problems.push("the registry does not carry the uniswapx provider");
  const okUx = evm.requireAsyncProvider("uniswapx");
  if (!okUx.ok) problems.push(`requireAsyncProvider("uniswapx") refused: ${JSON.stringify(okUx)}`);
  else notes.push("the registry carries the uniswapx provider and it is complete (async + settled)");

  // (f) THE BREAKING RUN: swap the two base-input amount fields in a copy of the spec and the golden order hash MUST
  // stop matching. The field ORDER is the protocol (EIP-712), so a valid hash is still produced - a DIFFERENT one,
  // which is exactly what "the vector is load-bearing" means. A copy is mutated in a temp dir; the tree is untouched.
  {
    const dir = mkdtempSync(join(tmpdir(), "uniswapx-breaking-"));
    try {
      const source = readFileSync(UNISWAPX_SDK_SPEC(), "utf8").replace(/\r\n/g, "\n");
      const before = source;
      const mutated = source.replace(
        '  ["baseInputStartAmount", "uint256"],\n  ["baseInputEndAmount", "uint256"],\n',
        '  ["baseInputEndAmount", "uint256"],\n  ["baseInputStartAmount", "uint256"],\n');
      if (mutated === before) throw new Error("the breaking-run mutation did not apply: the base-input amount field lines were not found");
      const rewritten = mutated.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) =>
        `from "${pathToFileURL(resolve(dirname(UNISWAPX_SDK_SPEC()), rel)).href}"`);
      const file = join(dir, "uniswapx-spec.mjs");
      writeFileSync(file, rewritten, "utf8");
      const broken = await loadFresh(file);
      let brokenHash = null;
      try { brokenHash = broken.uniswapxOrderHashHex(vector.order); } catch { brokenHash = null; }
      if (brokenHash === vector.orderHash || brokenHash === null) problems.push(`BREAKING RUN did not redden as expected: the order hash is ${String(brokenHash)}`);
      else notes.push(`breaking run REDDENS: reordering the base-input amount fields moves the order hash off the golden value (${String(brokenHash).slice(0, 12)}…)`);
      const brokenTypeHash = (() => { try { return toHex(keccak256(broken.UNISWAPX_HASHED_ORDER_TYPE)); } catch { return null; } })();
      if (brokenTypeHash === spec.UNISWAPX_ORDER_TYPE_HASH) problems.push("BREAKING RUN did not redden the type hash either");
      else notes.push("breaking run also moves the recomputed type hash off V2DutchOrderLib.ORDER_TYPE_HASH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  notes.push("the golden vector is a REAL Dutch_V2 order served by the UniswapX order API (see the URL in the source); its signature is real, the self-generated one is this repository's");
  return { note: `1 real-order vector, 1 self-generated signature vector, the native sentinel, the async seam`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 13. UNISWAPX REFUSALS - UNREACHABLE, AN UNEXPECTED SHAPE, AN UNKNOWN NETWORK, A REFUSAL, A MISSING SUBMITTER AND
//     A TIMEOUT ARE NAMED, NEVER SILENCE OR null. A stand-in transport (no network) drives the provider down each
//     failure path. PUBLISHING GOES TO OUR SUBMITTER: the package holds no key and no host, so a configured submitter
//     publishes WITHOUT a key at all, and a missing one is refused by name.
// ---------------------------------------------------------------------------------------------------

export const uniswapxRefusalCheck = async () => {
  const problems = [];
  const notes = [];
  const ux = await loadFresh(p("src", "legs", "uniswapx.mjs"));
  const SWAPPER = "0x" + "11".repeat(20);
  const HASH = "0x" + "ab".repeat(32);
  const response = (status, body) => ({ ok: status < 400, status, json: async () => (typeof body === "function" ? body() : body) });
  const named = (label, result, code) => {
    if (!result || typeof result !== "object") { problems.push(`${label}: the result is not a refusal value (${JSON.stringify(result)})`); return; }
    if (result.ok === true) { problems.push(`${label}: expected a refusal, got ok:true (${JSON.stringify(result).slice(0, 120)})`); return; }
    if (typeof result.code !== "string" || !ux.UNISWAPX_REFUSAL_CODES.includes(result.code)) { problems.push(`${label}: the refusal code is not named (${JSON.stringify(result.code)})`); return; }
    if (code && result.code !== code) { problems.push(`${label}: expected code ${code}, got ${result.code}`); return; }
    notes.push(`${label}: refused with ${result.code}`);
  };
  const planRequest = { chainId: 1, swapper: SWAPPER, sellToken: "0x" + "22".repeat(20), sellAmountWei: "1000000", buyToken: "0x" + "33".repeat(20), buyAmountWei: "500000", deadline: 1800000000, nonce: "1" };
  const sig = "0x" + "ab".repeat(65);
  const ordersBody = (over = {}) => ({ orders: [{ orderHash: HASH, orderStatus: "open", ...over }] });

  // (1) unreachable: the transport throws (connection or timeout) - not an exception escaping to the caller.
  const throwing = async () => { throw new TypeError("network down"); };
  named("submit: unreachable", await ux.submitUniswapxOrder({ quote: {}, signature: sig, submitter: "http://stand-in.test/order", fetchImpl: throwing }), "uniswapx-unreachable");
  named("status: unreachable", await ux.uniswapxOrderStatus({ orderHash: HASH, chainId: 1, fetchImpl: throwing }), "uniswapx-unreachable");
  named("settled: unreachable", await ux.uniswapxSettled({ orderHash: HASH, chainId: 1 }, { fetchImpl: throwing, now: () => 0, sleep: async () => {} }), "uniswapx-unreachable");

  // (2) an unexpected shape: a body that is not the shape we know (orders not an array; an unknown status word; a
  // submit answer with no orderId).
  named("status: orders not an array", await ux.uniswapxOrderStatus({ orderHash: HASH, chainId: 1, fetchImpl: async () => response(200, { orders: "nope" }) }), "uniswapx-bad-response");
  named("status: unknown status word", await ux.uniswapxOrderStatus({ orderHash: HASH, chainId: 1, fetchImpl: async () => response(200, ordersBody({ orderStatus: "teleported" })) }), "uniswapx-bad-response");
  named("submit: no orderId", await ux.submitUniswapxOrder({ quote: {}, signature: sig, submitter: "http://stand-in.test/order", fetchImpl: async () => response(201, { requestId: "r", orderStatus: "open" }) }), "uniswapx-bad-response");
  named("settled: unknown status word", await ux.uniswapxSettled({ orderHash: HASH, chainId: 1 }, { fetchImpl: async () => response(200, ordersBody({ orderStatus: "wat" })), now: () => 0, sleep: async () => {} }), "uniswapx-bad-response");

  // (3) not settled in time: the order stays open and the clock passes the timeout.
  let t = 0;
  const open = async () => response(200, ordersBody({ orderStatus: "open" }));
  named("settled: timeout", await ux.uniswapxSettled({ orderHash: HASH, chainId: 1 }, { fetchImpl: open, now: () => (t += 1000), sleep: async () => {}, pollMs: 1000, timeoutMs: 3000 }), "uniswapx-not-settled");

  // (4) THE ONE WAY PUBLISHING IS BLOCKED HERE, NAMED: no submitter configured. A published UniswapX order is a
  // gasless order on the Uniswap Trading API, which needs a key - and the key lives in OUR submitter, never in this
  // package. So a caller either names a submitter (and no key is needed in the package) or gets a named refusal.
  named("plan: unknown network", ux.uniswapxPlan({ ...planRequest, chainId: 5 }), "uniswapx-unknown-network");
  named("plan: incomplete order", ux.uniswapxPlan({ chainId: 1 }), "uniswapx-bad-order");
  named("status: unknown network", await ux.uniswapxOrderStatus({ orderHash: HASH, chainId: 5, fetchImpl: open }), "uniswapx-unknown-network");
  named("submit: no submitter", await ux.submitUniswapxOrder({ quote: {}, signature: sig, fetchImpl: open }), "uniswapx-no-submitter");
  named("submit: bad signature", await ux.submitUniswapxOrder({ quote: {}, signature: "0x00", submitter: "http://stand-in.test/order", fetchImpl: open }), "uniswapx-bad-order");
  // A CONFIGURED SUBMITTER PUBLISHES WITH NO KEY: this is the whole point of the step - our proxy holds the key.
  const submitsOk = async () => response(200, { orderId: HASH, orderStatus: "open" });
  const published = await ux.submitUniswapxOrder({ quote: {}, signature: sig, submitter: "http://stand-in.test/order", fetchImpl: submitsOk });
  if (!(published.ok === true && published.orderId === HASH && published.orderStatus === "open")) problems.push(`submit: a configured submitter did not publish without a key (${JSON.stringify(published)})`);
  else notes.push("submit: a configured submitter publishes WITHOUT any key (our proxy holds it, the package does not)");
  // THE PACKAGE CARRIES NO HARDCODED HOST: the submitter is the caller's, never a constant in the module.
  if (typeof ux.UNISWAPX_TRADING_API !== "undefined") problems.push("the provider still exports a hardcoded Uniswap Trading API host (UNISWAPX_TRADING_API)");
  else notes.push("the provider carries NO hardcoded Uniswap Trading API host: the submitter comes from the caller");
  named("sign: no wallet", await ux.uniswapxSignOrder({ typedData: { a: 1 } }), "uniswapx-sign-failed");

  // (5) a bounded refusal from the service, and an unknown order - also named.
  named("submit: refused by the service", await ux.submitUniswapxOrder({ quote: {}, signature: sig, submitter: "http://stand-in.test/order", fetchImpl: async () => response(401, { detail: "bad key" }) }), "uniswapx-refused");
  named("status: refused by the service", await ux.uniswapxOrderStatus({ orderHash: HASH, chainId: 1, fetchImpl: async () => response(500, {}) }), "uniswapx-refused");
  named("status: unknown order", await ux.uniswapxOrderStatus({ orderHash: HASH, chainId: 1, fetchImpl: async () => response(200, { orders: [] }) }), "uniswapx-order-unknown");

  // (6) AND THE OTHER WAY: a final status is NOT a refusal - it is the outcome (settled / dead).
  const filled = async () => response(200, ordersBody({ orderStatus: "filled" }));
  const done = await ux.uniswapxSettled({ orderHash: HASH, chainId: 1 }, { fetchImpl: filled, now: () => 0, sleep: async () => {} });
  if (!(done.ok === true && done.done === true && done.settled === true && done.status === "filled")) problems.push(`settled: a filled order did not end as settled (${JSON.stringify(done)})`);
  else notes.push("settled: a filled order ends as done + settled with status filled");
  const expired = async () => response(200, ordersBody({ orderStatus: "expired" }));
  const dead = await ux.uniswapxSettled({ orderHash: HASH, chainId: 1 }, { fetchImpl: expired, now: () => 0, sleep: async () => {} });
  if (!(dead.ok === true && dead.done === true && dead.settled === false && dead.status === "expired")) problems.push(`settled: an expired order did not end as done + not-settled (${JSON.stringify(dead)})`);
  else notes.push("settled: an expired order ends as done + not-settled with status expired");

  return { note: `${ux.UNISWAPX_REFUSAL_CODES.length} named refusals, exit paths covered`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 14. UNISWAP RELAY - THE FOURTH ASYNCHRONOUS ROUTE PROVIDER, THE KEY-FREE ONE. A golden vector for the relay order
//     (the EIP-712 type hashes against the reactor's own constants, the order hash and the Permit2 batch-witness
//     digest), the UniversalRouter calldata against Uniswap's OWN generated fixture, and a BREAKING RUN that shows
//     the vector is load-bearing.
//
// WHY THESE ASSERTIONS ARE ABOUT AGREEMENT, NOT AN IMPRESSION. The RelayOrder type, the fee/input/info sub-types and
// the batch-witness permit all come from Uniswap's own sources (Uniswap/relayer and Uniswap/uniswapx-sdk) and are
// RECOMPUTED here with the repository's own keccak256/secp256k1. The order's digest has NO external signature to
// anchor it (there is no live relay order service), so the DIGEST IS PINNED AS A DEV-TIME VALUE produced by an
// INDEPENDENT Keccak-256 (not @noble), and the SIGNATURE is SELF-GENERATED BY THIS REPOSITORY'S OWN SIGNER over
// that digest - it is NOT an external signature. The UniversalRouter calldata IS anchored outside: it must equal the
// fixture Uniswap's own relayer repository generates for a token -> native relayed swap.
// ---------------------------------------------------------------------------------------------------

const UNISWAPRELAY_SDK_SPEC = () => p("src", "legs", "uniswaprelay-spec.mjs");

// THE UNIVERSALROUTER CALLDATA FOR "DAI -> native", EXACTLY as Uniswap/relayer's own integration tests generated it
// with the universal-router-sdk (payerIsRouter: true). Source: Uniswap/relayer,
// test/foundry-tests/interop.json, key _UNISWAP_V3_DAI_ETH (produced by test/integration-tests/RelayOrderReactor.test.ts
// "basic v3 swap to native, DAI -> ETH").
const UNISWAPRELAY_CALLDATA_VECTOR = "0x24856bc3000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000002000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000056bc75e2d6310000000000000000000000000000000000000000000000000000000b78088a89f723100000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b6b175474e89094c44da98b954eedeac495271d0f000bb8c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000040000000000000000000000000342079f0e9da82bb28a27a6edc814a336602038300000000000000000000000000000000000000000000000000b78088a89f7231";
const UNISWAPRELAY_CALLDATA_INPUTS = {
  tokenIn: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  fee: 3000,
  amountInWei: "100000000000000000000",
  amountOutMinimumWei: "51651245170979377",
  recipient: "0x342079F0E9Da82bb28A27a6Edc814A3366020383",
};

// THE DEV-TIME GOLDEN VALUES for one fixed relay order. They were produced by an INDEPENDENT Keccak-256 (a
// standalone implementation, not @noble), and the signature is this repository's own signer; the check recomputes
// every one of them with the repository's primitives and demands they agree.
const UNISWAPRELAY_VECTOR = {
  chainId: 1,
  orderTypeHash: "0x356a26e7c5955b7b24a8bff954c96c53622e6a8471513bb66b69bc7069243ff0",
  permitTypeHash: "0x918f75c8e25ec281e8dc3255229111f447dc1c210102666cc63cd9da2dee620c",
  orderHash: "0xf31302c2171de3c6764d645f886203c2a7c2e70da36b074da2355a16a19eded9",
  domainSeparator: "0x866a5aba21966af95d6c7ab78eb2b2fc913915c28be3b9aa07cc04ff903e3f28",
  digest: "0x22981cae00e1ec10bd3221d3c861dfec1002281838189a3872d562aa485792a6",
  selfSignature: "0x1f7c8e9d36a69c085a45c4cdb64e2749d1289440d57765cd5ea6c3b3f86b0b6d0f1071c1362f2805fa11f1d14348ad0d3c749facee91c62b3ea2db95e9e713ab1b",
  selfAddress: "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
  order: {
    info: { reactor: "0x0000000000A4e21E2597DCac987455c48b12edBF", swapper: "0x342079F0E9Da82bb28A27a6Edc814A3366020383", nonce: "100", deadline: "1791625986" },
    input: { token: "0x6B175474E89094C44Da98b954EedeAC495271d0F", amount: "100000000000000000000", recipient: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD" },
    fee: { token: "0x6B175474E89094C44Da98b954EedeAC495271d0F", startAmount: "900000000000000000", endAmount: "1000000000000000000", startTime: "1791624986", endTime: "1791625986" },
    universalRouterCalldata: UNISWAPRELAY_CALLDATA_VECTOR,
  },
};

const UNISWAPRELAY_TEST_KEY = "0x" + "11".repeat(32);

export const uniswapRelayCheck = async () => {
  const problems = [];
  const notes = [];
  const relay = await loadFresh(p("src", "legs", "uniswaprelay.mjs"));
  const spec = await loadFresh(UNISWAPRELAY_SDK_SPEC());
  const evm = await loadFresh(p("src", "legs", "evm.mjs"));
  const { keccak256 } = await import(pathToFileURL(p("src", "primitives.mjs")).href);
  const toHex = (bytes) => { let out = "0x"; for (const b of bytes) out += b.toString(16).padStart(2, "0"); return out; };

  // (a) THE ORDER TYPE AGAINST THE REACTOR'S OWN CONSTANT. RelayOrderLib.FULL_RELAY_ORDER_TYPEHASH is keccak256 of
  // the order type ++ FeeEscalator ++ Input ++ RelayOrderInfo. A typo in the field list would move the hash and sign
  // orders no reactor accepts.
  const recomputedOrderTypeHash = toHex(keccak256(spec.UNISWAPRELAY_HASHED_ORDER_TYPE));
  if (recomputedOrderTypeHash !== spec.UNISWAPRELAY_ORDER_TYPE_HASH) problems.push(`the order type does not hash to the pinned RelayOrderLib type hash: computed ${recomputedOrderTypeHash}, constant ${spec.UNISWAPRELAY_ORDER_TYPE_HASH}`);
  if (recomputedOrderTypeHash !== UNISWAPRELAY_VECTOR.orderTypeHash) problems.push(`the order type hash is ${recomputedOrderTypeHash}, expected the golden ${UNISWAPRELAY_VECTOR.orderTypeHash}`);
  else notes.push(`the order type hashes to the golden FULL_RELAY_ORDER_TYPEHASH ${UNISWAPRELAY_VECTOR.orderTypeHash}`);
  const recomputedPermitTypeHash = toHex(keccak256(spec.UNISWAPRELAY_PERMIT_TYPE));
  if (recomputedPermitTypeHash !== spec.UNISWAPRELAY_PERMIT_TYPE_HASH) problems.push(`the permit type does not hash to the pinned value: computed ${recomputedPermitTypeHash}, constant ${spec.UNISWAPRELAY_PERMIT_TYPE_HASH}`);
  if (recomputedPermitTypeHash !== UNISWAPRELAY_VECTOR.permitTypeHash) problems.push(`the permit type hash is ${recomputedPermitTypeHash}, expected the golden ${UNISWAPRELAY_VECTOR.permitTypeHash}`);
  else notes.push(`the Permit2 batch-witness type string hashes to the golden ${UNISWAPRELAY_VECTOR.permitTypeHash}`);

  // (b) THE GOLDEN ORDER HASH, DOMAIN AND DIGEST, RECOMPUTED FROM THE ORDER'S FIELDS ALONE.
  const vector = UNISWAPRELAY_VECTOR;
  const missingVector = spec.uniswapRelayOrderMissingFields(vector.order);
  if (missingVector.length) problems.push(`the golden order is missing fields: ${missingVector.join(", ")}`);
  let orderHash = null;
  try { orderHash = spec.uniswapRelayOrderHashHex(vector.order); } catch (error) { problems.push(`the golden order hash did not compute (${error && error.message})`); }
  if (orderHash !== null && orderHash !== vector.orderHash) problems.push(`the golden order hash is ${String(orderHash)}, expected ${vector.orderHash}`);
  else if (orderHash !== null) notes.push(`the golden order hash is ${vector.orderHash} (recomputed from the fields alone)`);
  let digest = null;
  try { digest = spec.uniswapRelayOrderDigestHex({ order: vector.order, chainId: vector.chainId }); } catch (error) { problems.push(`the golden permit digest did not compute (${error && error.message})`); }
  if (digest !== null && digest !== vector.digest) problems.push(`the golden permit digest is ${String(digest)}, expected ${vector.digest}`);
  else if (digest !== null) notes.push(`the golden Permit2 batch-witness digest is ${vector.digest}`);
  const domainSeparator = toHex(spec.uniswapRelayDomainSeparator({ chainId: vector.chainId }));
  if (domainSeparator !== vector.domainSeparator) problems.push(`the Permit2 domain separator is ${domainSeparator}, expected ${vector.domainSeparator}`);
  else notes.push(`the Permit2 domain separator (chainId ${vector.chainId}) is the golden ${vector.domainSeparator}`);

  // (c) THE SELF-GENERATED SIGNATURE (this repository's signer over the golden digest) - NOT an external signature.
  const digestBytes = spec.uniswapRelayOrderDigest({ order: vector.order, chainId: vector.chainId });
  const selfSig = spec.signUniswapRelayOrderDigest({ digest: digestBytes, privateKey: UNISWAPRELAY_TEST_KEY });
  if (selfSig !== vector.selfSignature) problems.push(`the self-generated signature over the golden digest is ${selfSig}, expected ${vector.selfSignature}`);
  else notes.push("the self-generated signature over the golden digest is the fixed vector (this repository's signer)");
  const recoveredSelf = spec.recoverUniswapRelayOrderSigner({ digest: digestBytes, signature: selfSig });
  if (recoveredSelf !== vector.selfAddress) problems.push(`the self-generated signature recovers ${recoveredSelf}, expected ${vector.selfAddress}`);
  else notes.push(`the self-generated signature recovers ${vector.selfAddress}`);

  // (d) THE UNIVERSALROUTER CALLDATA AGAINST UNISWAP'S OWN FIXTURE, byte for byte, and read back to what it means.
  const rebuilt = spec.uniswapRelayRouterCalldata({
    tokenIn: UNISWAPRELAY_CALLDATA_INPUTS.tokenIn, weth: UNISWAPRELAY_CALLDATA_INPUTS.weth,
    fee: UNISWAPRELAY_CALLDATA_INPUTS.fee, amountInWei: UNISWAPRELAY_CALLDATA_INPUTS.amountInWei,
    amountOutMinimumWei: UNISWAPRELAY_CALLDATA_INPUTS.amountOutMinimumWei, recipient: UNISWAPRELAY_CALLDATA_INPUTS.recipient,
  });
  if (rebuilt.toLowerCase() !== UNISWAPRELAY_CALLDATA_VECTOR.toLowerCase()) problems.push(`the token -> native calldata does not equal Uniswap's own _UNISWAP_V3_DAI_ETH fixture (rebuilt ${rebuilt.slice(0, 20)}..., fixture ${UNISWAPRELAY_CALLDATA_VECTOR.slice(0, 20)}...)`);
  else notes.push("the token -> native UniversalRouter calldata equals Uniswap/relayer's own _UNISWAP_V3_DAI_ETH fixture, byte for byte");
  const back = spec.uniswapRelayRouterDecode(rebuilt);
  if (!back) problems.push("the built calldata does not decode back as V3_SWAP_EXACT_IN + UNWRAP_WETH");
  else {
    if (back.commands !== "0x000c") problems.push(`the decoded commands are ${back.commands}, expected 0x000c (V3_SWAP_EXACT_IN, UNWRAP_WETH)`);
    if (back.swap.recipient.toLowerCase() !== spec.UNISWAPRELAY_ADDRESS_THIS.toLowerCase()) problems.push(`the swap recipient is ${back.swap.recipient}, expected ADDRESS_THIS (the router pays from its own balance)`);
    if (back.swap.payerIsUser !== false) problems.push("the swap pays as the user, but a relayed swap must pay from the router's own balance (payerIsUser false)");
    const decodedPath = spec.uniswapRelayDecodePath(back.swap.path);
    if (!decodedPath || decodedPath.tokens[0].toLowerCase() !== UNISWAPRELAY_CALLDATA_INPUTS.tokenIn.toLowerCase() || decodedPath.tokens[1].toLowerCase() !== UNISWAPRELAY_CALLDATA_INPUTS.weth.toLowerCase() || decodedPath.fees[0] !== UNISWAPRELAY_CALLDATA_INPUTS.fee) problems.push(`the decoded path is not tokenIn -> weth at the declared fee (${JSON.stringify(decodedPath)})`);
    if (back.unwrap.recipient.toLowerCase() !== UNISWAPRELAY_CALLDATA_INPUTS.recipient.toLowerCase()) problems.push(`the native recipient is ${back.unwrap.recipient}, expected ${UNISWAPRELAY_CALLDATA_INPUTS.recipient}`);
    if (back.unwrap.amountMinimumWei !== BigInt(UNISWAPRELAY_CALLDATA_INPUTS.amountOutMinimumWei)) problems.push("the unwrap minimum does not carry the swap's amountOutMinimum");
    if (back.swap.amountOutMinimumWei === 0n) problems.push("the swap amountOutMinimum is zero: the order would not protect the person's output");
    if (!problems.length) notes.push("the decoded calldata is V3_SWAP_EXACT_IN(ADDRESS_THIS, payerIsUser false) + UNWRAP_WETH to the recipient at the swap minimum");
  }

  // (e) THE SEAM: the registered provider is the fourth async one and is complete.
  if (!evm.routeProviders().includes("uniswaprelay")) problems.push("the registry does not carry the uniswaprelay provider");
  const okRelay = evm.requireAsyncProvider("uniswaprelay");
  if (!okRelay.ok) problems.push(`requireAsyncProvider("uniswaprelay") refused: ${JSON.stringify(okRelay)}`);
  else notes.push("the registry carries the uniswaprelay provider and it is complete (async + settled)");
  if (relay.uniswapRelayReactorFor(1) !== "0x0000000000A4e21E2597DCac987455c48b12edBF") problems.push(`the reactor for chainId 1 is ${relay.uniswapRelayReactorFor(1)}, expected the README's mainnet reactor`);
  if (relay.uniswapRelayReactorFor(42161) !== null) problems.push("the reactor for Arbitrum (42161) is not null, but Uniswap declares no relay reactor there");

  // (f) THE BREAKING RUN: swap two of the relay order's INPUT fields in a copy of the spec and the golden order hash
  // MUST stop matching (the field ORDER is the protocol). The copy is mutated in a temp dir; the tree is untouched.
  {
    const dir = mkdtempSync(join(tmpdir(), "uniswaprelay-breaking-"));
    try {
      const source = readFileSync(UNISWAPRELAY_SDK_SPEC(), "utf8").replace(/\r\n/g, "\n");
      const before = source;
      const mutated = source.replace(
        '  ["amount", "uint256"],\n  ["recipient", "address"],\n',
        '  ["recipient", "address"],\n  ["amount", "uint256"],\n');
      if (mutated === before) throw new Error("the breaking-run mutation did not apply: the input field lines were not found");
      const rewritten = mutated.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) =>
        `from "${pathToFileURL(resolve(dirname(UNISWAPRELAY_SDK_SPEC()), rel)).href}"`);
      const file = join(dir, "uniswaprelay-spec.mjs");
      writeFileSync(file, rewritten, "utf8");
      const broken = await loadFresh(file);
      let brokenHash = null;
      try { brokenHash = broken.uniswapRelayOrderHashHex(vector.order); } catch { brokenHash = null; }
      if (brokenHash === vector.orderHash || brokenHash === null) problems.push(`BREAKING RUN did not redden as expected: the order hash is ${String(brokenHash)}`);
      else notes.push(`breaking run REDDENS: reordering the input fields moves the order hash off the golden value (${String(brokenHash).slice(0, 12)}...)`);
      const brokenTypeHash = (() => { try { return toHex(keccak256(broken.UNISWAPRELAY_HASHED_ORDER_TYPE)); } catch { return null; } })();
      if (brokenTypeHash === spec.UNISWAPRELAY_ORDER_TYPE_HASH) problems.push("BREAKING RUN did not redden the type hash either");
      else notes.push("breaking run also moves the recomputed type hash off the golden FULL_RELAY_ORDER_TYPEHASH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  notes.push("the digest and signature vectors are DEV-TIME (independent Keccak-256 + this repository's signer); the calldata vector is Uniswap's own fixture from Uniswap/relayer test/foundry-tests/interop.json");
  return { note: `1 golden digest vector (dev-time), 1 self-generated signature, Uniswap's own calldata fixture, 1 breaking run`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 15. UNISWAP RELAY REFUSALS - UNKNOWN NETWORK, A BAD ORDER, NO WALLET, THE UNDOCUMENTED DISCOVERY PATH, AN
//     UNREACHABLE CHAIN, A SHAPE WE DO NOT KNOW, A TIMEOUT AND AN EXPIRED ORDER ARE NAMED, NEVER SILENCE OR null.
//     Stand-in transports (no network, no chain) drive the provider down each failure path.
// ---------------------------------------------------------------------------------------------------

export const uniswapRelayRefusalCheck = async () => {
  const problems = [];
  const notes = [];
  const relay = await loadFresh(p("src", "legs", "uniswaprelay.mjs"));
  const SWAPPER = "0x" + "11".repeat(20);
  const TOKEN = "0x" + "22".repeat(20);
  const WETH = "0x" + "33".repeat(20);
  const HASH = "0x" + "ab".repeat(32);
  const named = (label, result, code) => {
    if (!result || typeof result !== "object") { problems.push(`${label}: the result is not a refusal value (${JSON.stringify(result)})`); return; }
    if (result.ok === true) { problems.push(`${label}: expected a refusal, got ok:true (${JSON.stringify(result).slice(0, 120)})`); return; }
    if (typeof result.code !== "string" || !relay.UNISWAPRELAY_REFUSAL_CODES.includes(result.code)) { problems.push(`${label}: the refusal code is not named (${JSON.stringify(result.code)})`); return; }
    if (code && result.code !== code) { problems.push(`${label}: expected code ${code}, got ${result.code}`); return; }
    notes.push(`${label}: refused with ${result.code}`);
  };
  const now = () => 1_000_000;
  const noSleep = async () => {};
  const sig = "0x" + "ab".repeat(65);
  const orderReq = () => ({
    chainId: 1, swapper: SWAPPER, sellToken: TOKEN, wrappedToken: WETH, fee: 3000,
    sellAmountWei: "1000000", buyAmountWei: "500000", feeToken: TOKEN, feeEndAmountWei: "1000",
    deadline: 1800000000, recipient: SWAPPER,
  });

  // (1) THE PLAN: an unknown network and an incomplete order are named, and a valid request builds a native order.
  named("plan: unknown network", relay.uniswapRelayPlan({ ...orderReq(), chainId: 42161 }), "uniswap-relay-unknown-network");
  named("plan: incomplete order", relay.uniswapRelayPlan({ chainId: 1 }), "uniswap-relay-bad-order");
  const plan = relay.uniswapRelayPlan(orderReq());
  if (plan.ok !== true || plan.nativeOutput !== true || typeof plan.calldata !== "string" || !plan.calldata.startsWith("0x24856bc3")) problems.push(`plan: a valid request did not build a native route (${JSON.stringify(plan).slice(0, 160)})`);
  else notes.push("plan: a valid request builds a native route carrying the UniversalRouter calldata");

  // (2) THE SUBMIT STEP: the discovery path is UNDOCUMENTED, so it refuses BY NAME - and never invents a URL.
  named("submit: unknown network", relay.uniswapRelaySubmit({ chainId: 42161, order: plan.order, signature: sig }), "uniswap-relay-unknown-network");
  named("submit: bad signature", relay.uniswapRelaySubmit({ chainId: 1, order: plan.order, signature: "0x00" }), "uniswap-relay-bad-order");
  const noDiscovery = relay.uniswapRelaySubmit({ chainId: 1, order: plan.order, signature: sig });
  named("submit: the discovery path", noDiscovery, "uniswap-relay-no-discovery");
  if (noDiscovery.ok === false && noDiscovery.params && noDiscovery.params.documentedSubmissionEndpoint !== null) problems.push("submit: the no-discovery refusal invented an endpoint");
  else if (noDiscovery.ok === false) notes.push("submit: the no-discovery refusal names NO endpoint (nothing fabricated)");

  // (3) SIGNING: a wallet that will not sign is named.
  named("sign: no wallet", await relay.uniswapRelaySignOrder({ typedData: { a: 1 } }), "uniswap-relay-sign-failed");

  // (4) READING THE CHAIN. An unknown network, an unreachable driver, a logs answer that is not an array, and a log
  // whose topics are not this event are all named; a matching Relay event IS settled, empty logs are open/expired.
  const throwing = async () => { throw new TypeError("rpc down"); };
  named("status: unknown network", await relay.uniswapRelayStatus({ orderHash: HASH, chainId: 42161, driver: { request: throwing } }), "uniswap-relay-unknown-network");
  named("status: unreachable", await relay.uniswapRelayStatus({ orderHash: HASH, chainId: 1, driver: { request: throwing } }), "uniswap-relay-unreachable");
  named("status: no driver", await relay.uniswapRelayStatus({ orderHash: HASH, chainId: 1 }), "uniswap-relay-unreachable");
  named("status: logs not an array", await relay.uniswapRelayStatus({ orderHash: HASH, chainId: 1, getLogs: async () => "nope" }), "uniswap-relay-bad-response");
  named("status: a log that is not ours", await relay.uniswapRelayStatus({ orderHash: HASH, chainId: 1, getLogs: async () => ([{ topics: ["0x" + "00".repeat(32), HASH] }]) }), "uniswap-relay-bad-response");
  const filled = await relay.uniswapRelayStatus({ orderHash: HASH, chainId: 1, getLogs: async () => ([{ topics: [relay.UNISWAPRELAY_EVENT_TOPIC0, HASH, "0x" + "11".repeat(32), "0x" + "22".repeat(32)] }]) });
  if (!(filled.ok === true && filled.status === "filled")) problems.push(`status: a matching Relay event did not read as filled (${JSON.stringify(filled)})`);
  else notes.push("status: a matching Relay event reads as filled (the real on-chain effect)");
  const open = await relay.uniswapRelayStatus({ orderHash: HASH, chainId: 1, getLogs: async () => ([]), deadline: 2_000_000, nowSec: 1_000_000 });
  if (!(open.ok === true && open.status === "open")) problems.push(`status: no event before the deadline did not read as open (${JSON.stringify(open)})`);
  else notes.push("status: no event before the deadline reads as open");
  const expired = await relay.uniswapRelayStatus({ orderHash: HASH, chainId: 1, getLogs: async () => ([]), deadline: 900_000, nowSec: 1_000_000 });
  if (!(expired.ok === true && expired.status === "expired")) problems.push(`status: a passed deadline did not read as expired (${JSON.stringify(expired)})`);
  else notes.push("status: a passed deadline with no event reads as expired");

  // (5) WHAT ENDS EXECUTION. A filled order ends settled; an expired one ends not-settled; an order that never fills
  // times out by name; an unreachable chain is a refusal.
  named("settled: unreachable", await relay.uniswapRelaySettled({ orderHash: HASH, chainId: 1 }, { getLogs: throwing, now, sleep: noSleep }), "uniswap-relay-unreachable");
  const t = { v: 0 };
  named("settled: timeout (stays open)", await relay.uniswapRelaySettled({ orderHash: HASH, chainId: 1, deadline: 2_000_000 }, { getLogs: async () => ([]), now: () => (t.v += 1000), sleep: noSleep, pollMs: 1000, timeoutMs: 3000, nowSec: 1_000_000 }), "uniswap-relay-not-settled");
  const done = await relay.uniswapRelaySettled({ orderHash: HASH, chainId: 1 }, { getLogs: async () => ([{ topics: [relay.UNISWAPRELAY_EVENT_TOPIC0, HASH] }]), now, sleep: noSleep });
  if (!(done.ok === true && done.done === true && done.settled === true && done.status === "filled")) problems.push(`settled: a filled order did not end as settled (${JSON.stringify(done)})`);
  else notes.push("settled: a filled order ends as done + settled with status filled");
  const dead = await relay.uniswapRelaySettled({ orderHash: HASH, chainId: 1, deadline: 900_000 }, { getLogs: async () => ([]), now, sleep: noSleep, nowSec: 1_000_000 });
  if (!(dead.ok === true && dead.done === true && dead.settled === false && dead.status === "expired")) problems.push(`settled: an expired order did not end as done + not-settled (${JSON.stringify(dead)})`);
  else notes.push("settled: an expired order ends as done + not-settled with status expired");

  // (6) THE GUARD IS ON THIS PROVIDER TOO: no order blocks, and a native input is refused the allowance check by the
  // same shared guard the other providers use.
  const blocked = relay.uniswapRelayGate({});
  if (blocked.blocked !== true) problems.push(`gate: no order did not block (${JSON.stringify(blocked)})`);
  else notes.push("gate: no order blocks (uniswap-relay-no-order)");

  return { note: `${relay.UNISWAPRELAY_REFUSAL_CODES.length} named refusals, exit paths covered`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// RUNNER
// ---------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------
// 16. ENTRIES - every subpath this package declares points at a file that loads and exports what it promises.
// ---------------------------------------------------------------------------------------------------

/** What each declared subpath must export. The list is the contract with a consumer that is not the browser. */
export const ENTRY_SYMBOLS = {
  "./xmr": {
    file: ["src", "public", "xmr.mjs"],
    symbols: ["PREFIX_BY_NETWORK", "addressForNetwork", "addressFromKeys", "addressPayload", "checkAddress",
      "decodeMoneroBase58", "encodeMoneroBase58", "formatCheck", "isStagenetShaped", "networkFromShape",
      "prefixFor", "createHalves", "createDleq2", "SELL_WINDOW", "sellWindowSec", "scalarFromMoneroHex",
      "spendKeysFromRevealedHalf"],
  },
  "./order": {
    file: ["src", "public", "order.mjs"],
    symbols: ["ORDER_CONTEXT_VERSION", "orderContextString", "halfCommitmentHex", "EIP712_DOMAIN_TYPE",
      "ORDER_QUOTE_DOMAIN_NAME", "ORDER_QUOTE_DOMAIN_VERSION", "ORDER_QUOTE_FIELDS", "ORDER_QUOTE_TYPE",
      "ORDER_QUOTE_VERSION", "quoteDigest", "quoteDomainSeparator", "quoteMissingFields", "quoteStructHash",
      "recoverQuoteKey", "signQuoteDigest"],
  },
  "./evm": {
    file: ["src", "public", "evm.mjs"],
    symbols: ["FACTORY_METHODS", "FACTORY_READS", "ORDER_CREATED_TOPIC", "QUOTE_FIELDS", "encodePredict",
      "encodeCreateOrderAndFund", "encodeFactoryRead",
      "decodeImplementationCodeHash", "verifyFactoryImplementationOnChain", "CLAIM_GAS_LIMIT",
      "CLAIM_TIP_FLOOR_WEI", "DEFAULT_GIFT_RESERVE_BPS", "claimGasGiftWei", "claimMaxFeePerGasWei",
      "claimRequiredWei"],
  },
  "./core": {
    file: ["src", "public", "core.mjs"],
    symbols: ["parseAmount"],
  },
  "./recovery": {
    file: ["src", "public", "recovery.mjs"],
    symbols: ["ENVELOPE_VERSION", "FILE_MAGIC", "PAYLOAD_VERSION", "buildPayload", "createRecoveryFile",
      "decryptFile", "encryptPayload", "envelopeAad", "recoveryFileName", "scanStartHeight", "validatePayload"],
  },
};

export const entriesCheck = async () => {
  const pkg = JSON.parse(read(p("package.json")));
  const declared = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : {};
  const problems = [];
  const notes = [];

  for (const [entry, spec] of Object.entries(ENTRY_SYMBOLS)) {
    const target = declared[entry];
    if (!target) {
      problems.push(`package.json declares no "${entry}" export, but its symbols are promised`);
      continue;
    }
    const file = target.import || target.default;
    if (typeof file !== "string") {
      problems.push(`"${entry}" declares neither "import" nor "default"`);
      continue;
    }
    if (!existsSync(p(...file.replace(/^\.\//, "").split("/")))) {
      problems.push(`"${entry}" points at ${file}, which is not in the package`);
      continue;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(p(...file.replace(/^\.\//, "").split("/"))).href + "?v=" + Date.now());
    } catch (error) {
      problems.push(`"${entry}" did not load: ${error && error.message}`);
      continue;
    }
    const missing = spec.symbols.filter((name) => !(name in mod));
    if (missing.length) problems.push(`"${entry}" does not export ${missing.join(", ")}`);
    else notes.push(`"${entry}": ${spec.symbols.length} symbols, all present`);
  }

  return { note: `${Object.keys(ENTRY_SYMBOLS).length} subpath entries load and export what they promise`, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 18. TYPES - every published subpath carries declarations, and they declare exactly what its barrel
//     re-exports. A subpath WITHOUT a `types` target is invisible to a TypeScript consumer: it resolves to
//     nothing at all, which is how the entry a node needs ends up as `any` in someone's editor.
//
// NO COMPILER IS AVAILABLE HERE. This package has three runtime dependencies, no devDependencies and no
// TypeScript, so "parses" is a STRUCTURAL read of the declarations - balanced blocks, every `export` naming a
// declaration, no name twice - the instrument the `surface` check already applies to index.d.ts. A real
// compiler run belongs to the consumer's project, not to a zero-dependency battery.
// ---------------------------------------------------------------------------------------------------

/**
 * Subpaths left WITHOUT declarations ON PURPOSE, each with its reason. This table is the whole exemption: a
 * subpath that carries an import/default target and carries no `types` is a problem unless it is named here, so
 * a new entry cannot slip in untyped.
 */
export const NO_TYPES = {
  "./adapters": "re-exports the environment adapters the interface wires in itself (a wallet over EIP-1193, a storage, a Monero wallet library) - the entry surface a node needs is src/public/**, and declarations for the adapters are a separate piece of work",
};

/** The NAMED re-exports of a barrel, plus what cannot be enumerated: a star re-export and a default export. */
export const barrelExports = (source) => {
  const text = stripComments(source);
  const names = new Set();
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/\s+as\s+/, " ").split(/\s+/).pop();
      if (name) names.add(name);
    }
  }
  for (const m of text.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return {
    names,
    stars: [...text.matchAll(/\bexport\s*\*\s*(?:as\s+\w+\s*)?from/g)].length,
    defaults: [...text.matchAll(/\bexport\s+default\b/g)].length,
  };
};

/** The structural read of one declarations file. Every problem names the file and, where there is one, the line. */
export const dtsProblems = (dts, label) => {
  const problems = [];
  // COMMENTS AND STRING LITERALS OUT FIRST: a brace inside either is not a block, and index.d.ts carries both
  // in its doc comments.
  const code = stripComments(dts).replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const [open, close, what] of [["{", "}", "braces"], ["[", "]", "brackets"], ["(", ")", "parentheses"]]) {
    const opened = (code.match(new RegExp("\\" + open, "g")) || []).length;
    const closed = (code.match(new RegExp("\\" + close, "g")) || []).length;
    if (opened !== closed) problems.push(`${label}: ${what} do not balance (${opened} "${open}" against ${closed} "${close}")`);
  }
  if (!declaredValueExports(code).size) problems.push(`${label}: declares no value`);
  const counts = new Map();
  for (const m of code.matchAll(/^export\s+(?:declare\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  for (const [name, times] of counts) if (times > 1) problems.push(`${label}: ${name} is declared ${times} times`);
  // EVERY DECLARATION IS NAMED, AND OF A FORM THIS CONTRACT USES. A statement that lost its name, its terminator
  // or its `declare` reads here as an `export` followed by something else.
  for (const [index, line] of code.split("\n").entries()) {
    const m = /^export\s+(\S+)/.exec(line);
    if (m && !["declare", "type", "interface"].includes(m[1])) {
      problems.push(`${label}:${index + 1}: "export ${m[1]}" is not a declaration form (declare, type or interface expected)`);
    }
  }
  return problems;
};

// A DECLARATION FILE MUST PARSE, NOT ONLY READ AS TEXT. The textual rules above cannot see a comment opener that
// is missing, and a broken `index.d.ts` is invisible to every consumer. Node's own TypeScript parser is used on a
// temporary `.ts` copy, so the check has no dependency and no build step.
const declarationParseProblem = (file, label) => {
  const dir = mkdtempSync(join(tmpdir(), "sdk-types-parse-"));
  const copy = join(dir, "declarations.ts");
  try {
    writeFileSync(copy, readFileSync(file));
    execFileSync(process.execPath, ["--experimental-strip-types", copy], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (error) {
    const text = String((error && (error.stderr || error.message)) || error);
    const line = text.split("\n").find((x) => /SyntaxError|Error:/.test(x)) || text.split("\n")[0];
    return `${label}: does not parse: ${line.trim()}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const typesCheck = () => {
  const pkg = JSON.parse(read(p("package.json")));
  const declaredExports = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : {};
  const problems = [];
  const notes = [];
  let typed = 0;
  let symbols = 0;

  for (const [subpath, entry] of Object.entries(declaredExports)) {
    const object = entry && typeof entry === "object" ? entry : null;
    const target = typeof entry === "string" ? entry : object ? object.import || object.default : null;
    if (typeof target !== "string") {
      notes.push(`"${subpath}": neither "import" nor "default" - there is no module to type`);
      continue;
    }

    // (a) THE TYPES TARGET IS DECLARED. An exempt subpath is NAMED as exempt, never skipped in silence.
    const types = object ? object.types : null;
    if (typeof types !== "string") {
      if (NO_TYPES[subpath]) notes.push(`"${subpath}": no types ON PURPOSE - ${NO_TYPES[subpath]}`);
      else problems.push(`"${subpath}" points at ${target} and declares no "types": a TypeScript consumer gets no declarations for this subpath`);
      continue;
    }
    typed += 1;

    // (b) THE DECLARED FILE EXISTS AND READS AS DECLARATIONS.
    const typesFile = p(...types.replace(/^\.\//, "").split("/"));
    const barrelFile = p(...target.replace(/^\.\//, "").split("/"));
    if (!existsSync(typesFile)) {
      problems.push(`"${subpath}": the declared types file ${types} is not in the package`);
      continue;
    }
    const dts = read(typesFile);
    for (const problem of dtsProblems(dts, types)) problems.push(problem);
    const parseProblem = declarationParseProblem(typesFile, types);
    if (parseProblem) problems.push(parseProblem);
    if (!existsSync(barrelFile)) {
      problems.push(`"${subpath}": points at ${target}, which is not in the package, so ${types} cannot be compared with it`);
      continue;
    }

    // (c) EVERY SYMBOL THE BARREL RE-EXPORTS IS DECLARED, AND NOTHING ELSE. Both ways, as the `surface` check
    // reads the root: a declaration the runtime does not carry is the same lie as a missing one.
    const barrel = barrelExports(read(barrelFile));
    if (!barrel.names.size) problems.push(`${target}: re-exports no named symbol`);
    for (const [what, count] of [["a star re-export", barrel.stars], ["a default export", barrel.defaults]]) {
      if (count) problems.push(`${target}: carries ${count === 1 ? what : count + " of them"}, which cannot be enumerated - name the symbols explicitly so ${types} can be compared with them`);
    }
    const declaredValues = declaredValueExports(stripComments(dts));
    const missing = [...barrel.names].filter((name) => !declaredValues.has(name)).sort();
    const extra = [...declaredValues].filter((name) => !barrel.names.has(name)).sort();
    if (missing.length) problems.push(`${types}: the barrel ${target} re-exports ${missing.join(", ")}, which the declarations omit`);
    if (extra.length) problems.push(`${types}: declares ${extra.join(", ")}, which the barrel ${target} does not re-export`);
    symbols += barrel.names.size;
    if (!missing.length && !extra.length && barrel.names.size) notes.push(`"${subpath}": ${barrel.names.size} symbols, all declared in ${types}`);
  }

  const exempt = Object.keys(NO_TYPES).filter((subpath) => subpath in declaredExports);
  if (exempt.length) notes.push(`${exempt.length} subpath deliberately without types, by name: ${exempt.join(", ")}`);
  return {
    note: `${typed}/${Object.keys(declaredExports).length} subpaths declare types, ${symbols} symbols declared`,
    problems,
    notes,
  };
};


// ---------------------------------------------------------------------------------------------------
// 17. VERSION - the constant a peer reads equals the version the package is published under.
// ---------------------------------------------------------------------------------------------------

export const versionCheck = async () => {
  const pkg = JSON.parse(read(p("package.json")));
  const problems = [];
  const source = read(p("src", "version.mjs"));
  // BAKED, NOT FETCHED: the constant must be in the code, and must not turn into a runtime read of package.json.
  if (/from\s+["'][^"']*package\.json["']/.test(source) || /require\(\s*["'][^"']*package\.json["']/.test(source)) {
    problems.push("src/version.mjs reads package.json at runtime: in a browser that is a fetch of a file that need not be served beside the bundle - the version must be baked in");
  }
  let mod;
  try {
    mod = await import(pathToFileURL(p("src", "version.mjs")).href + "?v=" + Date.now());
  } catch (error) {
    return { note: "src/version.mjs did not load", problems: [`src/version.mjs: ${error && error.message}`] };
  }
  if (!/^\d+\.\d+\.\d+/.test(String(mod.SDK_VERSION))) {
    problems.push(`SDK_VERSION is not a version: ${JSON.stringify(mod.SDK_VERSION)}`);
  } else if (mod.SDK_VERSION !== pkg.version) {
    problems.push(`SDK_VERSION says "${mod.SDK_VERSION}" while package.json says "${pkg.version}" - run npm run sync:version`);
  }
  const root = read(p("src", "index.mjs"));
  if (!/SDK_VERSION/.test(root)) problems.push("src/index.mjs does not re-export SDK_VERSION, so a client cannot read it from the entry point");
  if (!/declare const SDK_VERSION/.test(read(p("index.d.ts")))) problems.push("index.d.ts does not declare SDK_VERSION");
  return { note: `SDK_VERSION "${mod.SDK_VERSION}" is baked in and equals package.json`, problems, notes: [] };
};

// ---------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------
// 14. REFUSALS - every code a route provider refuses with is DECLARED as a type, no extra one is, the union
//     the tables answer to is USED by a declaration instead of standing beside them as a comment, and the
//     `*Gate` verdict vocabulary is held OUT of both.
// ---------------------------------------------------------------------------------------------------

/** The four tables a provider names its own refusals in. The type must say exactly the same. */
export const REFUSAL_TABLES = {
  cow: ["src", "legs", "cow.mjs"],
  kyber: ["src", "legs", "kyber.mjs"],
  uniswapx: ["src", "legs", "uniswapx.mjs"],
  "uniswap-relay": ["src", "legs", "uniswaprelay.mjs"],
};

/** The codes inside one provider's `*_REFUSAL_CODES` table. */
export const refusalCodesOf = (source) => {
  const block = /[A-Z_]*REFUSAL_CODES\s*=\s*\[([\s\S]*?)\]/.exec(source);
  if (!block) return null;
  // ONLY CODE-SHAPED NAMES: a provider's table carries comments too, and a quoted phrase in a comment is not a
  // code. A code here is a family-prefixed kebab name, or the shared `broken`.
  return new Set([...block[1].matchAll(/"((?:cow|kyber|uniswapx|uniswap-relay)-[a-z][a-z0-9-]*|broken)"/g)].map((m) => m[1]));
};

/** The NAME that provider's module gives its refusal table (`COW_REFUSAL_CODES` and its three siblings). */
export const refusalTableNameOf = (source) => {
  const name = /([A-Z_]*REFUSAL_CODES)\s*=\s*\[/.exec(source);
  return name ? name[1] : null;
};

/**
 * THE `*Gate` VOCABULARY - A GATE VERDICT'S `reason`, DELIBERATELY NOT A ROUTE REFUSAL.
 *
 * `cowGate` and its three siblings answer `{ ok: false, blocked: true, reason: "cow-no-order", checks: [] }` while
 * there is no order to check yet: that word says "do not sign THIS", while a refusal code says "the provider
 * answered, and this is why it would not". Two vocabularies, two audiences - so this check holds them APART in both
 * directions: every token below must still be in its provider's own source (the note below cannot go stale in
 * silence), and no token below may appear in a refusal table or in `RouteRefusalCode`.
 */
export const GATE_REASONS = {
  cow: ["cow-no-order"],
  kyber: ["kyber-no-order"],
  uniswapx: ["uniswapx-no-order"],
  "uniswap-relay": ["uniswap-relay-no-order"],
};

export const refusalsCheck = () => {
  const problems = [];
  const notes = [];
  const named = new Set();
  const sizes = [];
  const tables = [];
  for (const [family, parts] of Object.entries(REFUSAL_TABLES)) {
    const source = read(p(...parts));
    const codes = refusalCodesOf(source);
    if (!codes) { problems.push(`${parts.join("/")}: no REFUSAL_CODES table found`); continue; }
    const name = refusalTableNameOf(source);
    if (name) tables.push({ family, parts, name });
    else problems.push(`${parts.join("/")}: the refusal table has no name`);
    sizes.push(`${family} ${codes.size}`);
    for (const code of codes) named.add(code);
  }
  const dts = read(p("index.d.ts"));
  const union = /export type RouteRefusalCode =([\s\S]*?);/.exec(dts);
  if (!union) return { note: "index.d.ts declares no RouteRefusalCode", problems: ["index.d.ts: RouteRefusalCode is missing"], notes };
  const declared = new Set([...union[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const missing = [...named].filter((c) => !declared.has(c)).sort();
  const extra = [...declared].filter((c) => !named.has(c)).sort();
  if (missing.length) problems.push(`refused by a provider but not declared in RouteRefusalCode: ${missing.join(", ")}`);
  if (extra.length) problems.push(`RouteRefusalCode declares codes no provider refuses with: ${extra.join(", ")}`);

  // THE UNION MUST BE LOAD-BEARING, NOT DECORATIVE. A type nobody names is a comment: an interface that meets these
  // refusals has to be able to switch on `code`, so at least one declaration must NAME the union OUTSIDE its own
  // declaration. The comments are stripped first - a mention in prose is not a use, and the check must not be
  // satisfiable by a sentence.
  const code = stripComments(dts);
  const references = (code.match(/\bRouteRefusalCode\b/g) || []).length - 1;
  if (references < 1) {
    problems.push("index.d.ts declares RouteRefusalCode but never uses it: no declaration types a refusal `code` with it, so the union constrains nothing and an interface switching on it is no better off than switching on a bare string");
  }

  // THE TABLES' DECLARED TYPE. Every shipped table is declared as `readonly RouteRefusalCode[]`, BY NAME, and the
  // declaration names exactly the tables the package ships - no fewer (a table that ships with no declared type) and
  // no more (a declaration for a table nobody has). The table's own module cannot make this statement in a way this
  // repository can hold: there is no compiler here (see the `types` check), so this check holds both halves.
  const tableBlock = (() => {
    const at = code.indexOf("export interface RouteRefusalTables {");
    if (at < 0) return null;
    const end = code.indexOf("}", at);
    return end < 0 ? code.slice(at) : code.slice(at, end);
  })();
  if (!tableBlock) {
    problems.push("index.d.ts does not declare RouteRefusalTables: the four tables ship with the package (src/legs/**, `files` in package.json) and nothing says what TYPE they are, so the union stands beside them as a comment");
  } else {
    const typed = new Set();
    for (const m of tableBlock.matchAll(/readonly\s+([A-Z_][A-Z0-9_]*)\s*:\s*readonly\s+RouteRefusalCode\s*\[\s*\]\s*;/g)) typed.add(m[1]);
    for (const table of tables) {
      const mentioned = (tableBlock.match(/\b[A-Z_][A-Z0-9_]*REFUSAL_CODES\b/g) || []).includes(table.name);
      if (!mentioned) problems.push(`index.d.ts RouteRefusalTables does not declare ${table.name}, the table ${table.parts.join("/")} refuses with: the table ships with no declared type, so the union does not reach it`);
      else if (!typed.has(table.name)) problems.push(`index.d.ts RouteRefusalTables declares ${table.name} without the route refusal type: it must be \`readonly RouteRefusalCode[]\`, otherwise the table and the union can drift apart and the declaration keeps saying nothing`);
    }
    for (const name of typed) {
      if (!tables.some((table) => table.name === name)) problems.push(`index.d.ts RouteRefusalTables declares ${name}, which is not a table the package ships (src/legs/**)`);
    }
  }

  // THE `*Gate` VOCABULARY STAYS OUT. Folding one of its tokens into a table AND into the union would leave the
  // equality above green while the union quietly started to claim a word that is not a refusal - so both directions
  // of the note below are checked, not written.
  const gateTokens = [];
  for (const [family, tokens] of Object.entries(GATE_REASONS)) {
    const parts = REFUSAL_TABLES[family];
    const source = read(p(...parts));
    for (const token of tokens) {
      gateTokens.push(token);
      if (!source.includes(`"${token}"`)) problems.push(`${parts.join("/")}: the gate verdict reason "${token}" is gone from this provider: the separate vocabulary the note below names has moved, so the note is out of date`);
      if (named.has(token)) problems.push(`a refusal table names "${token}", which is a gate VERDICT ("no order to check yet - do not sign"), not a code a provider refuses with: the *Gate vocabulary must stay out of the refusals`);
      if (declared.has(token)) problems.push(`RouteRefusalCode declares "${token}", which a gate verdict names rather than a provider: the union does not cover the *Gate vocabulary and must not start to`);
    }
  }
  notes.push(`the *Gate reason vocabulary (${gateTokens.join(", ")}) is deliberately separate from this union: a gate verdict says "no order to check yet - do not sign", while a route refusal says "the provider answered, and this is why it would not", so those tokens are in NEITHER the refusal tables NOR RouteRefusalCode, and nobody should read the union as covering them`);

  const agree = !missing.length && !extra.length;
  return problems.length
    ? { note: agree ? "RouteRefusalCode is declared but does not reach the tables as a type" : "the refusal tables and RouteRefusalCode disagree", problems, notes }
    : { note: `${declared.size} route refusal codes declared (${sizes.join(", ")}), tables and type agree, the type is used ${references} time(s) outside its own declaration, the four tables are declared \`readonly RouteRefusalCode[]\``, problems, notes };
};

// ---------------------------------------------------------------------------------------------------
// 15. DECLINE - THE MAKER'S REFUSAL IS A STATE OF ITS OWN (issue #40): it is told apart from an ordinary
//     refund by the ESCROW'S `Declined` EVENT or by the NODE'S `declined` + `compliance` STATUS, either
//     source stops the wait for XMR AT ONCE, no recovery file and no manual refund are offered for an order
//     with nothing to recover, and NO reason, category or provider travels with it.
// ---------------------------------------------------------------------------------------------------

/**
 * THE ADDRESSES OF THIS CHECK ARE MADE UP, as everywhere in this repository: a repeated byte, nothing that
 * exists. No key, wallet or contract of anybody's is named here.
 */
export const DECLINE_ESCROW = "0x" + "e5".repeat(20);
export const DECLINE_OTHER = "0x" + "d4".repeat(20);

/**
 * THE EVENT'S TOPIC, PINNED AS A LITERAL AND CROSS-CHECKED AGAINST AN INDEPENDENT HASH. The literal pins the
 * event's NAME AND ARGUMENTS (`Declined(address)`): if either drifts, the topic moves and this fails rather than
 * silently asking the chain for an event the contract never emits. The hash is recomputed with the `keccak256`
 * PACKAGE - a different implementation from the one the module itself uses (@noble/hashes) - so the two agree by
 * computation and not by the module simply agreeing with itself.
 */
const DECLINED_TOPIC0_PINNED = "0x8ec308f26d5905485eab9f8aae0b20ed896f8a33c64301a62e29318be049deb9";
const independentTopic0 = (signature) => "0x" + keccakPkg(Buffer.from(signature, "utf8")).toString("hex");

/** A log as a node answers it: an emitter, its topics and its data. */
const logFrom = (address, topic0) => ({ address, topics: [topic0], data: "0x" });

/** A NORMAL REFUND'S ON-CHAIN FOOTPRINT: `HalfRevealed` and NOT `Declined` - the control the guard is read against. */
const HALF_REVEALED_TOPIC0 = "0x" + "aa".repeat(32);

/**
 * THE KEYS A DECLINE MUST NOT CARRY, ANYWHERE IN ITS ANSWER. The node returns `{ status: "declined", code:
 * "compliance" }` and NOTHING ELSE, on purpose: no reason, no category, no provider. A key that would let an
 * interface say why (rather than only that) is exactly what this refuses.
 */
const DECLINE_FORBIDDEN_KEYS = ["reason", "why", "category", "provider", "detail", "message", "cause", "refusedBy", "explain"];
const keysDeep = (value, out = [], depth = 0) => {
  if (depth > 4 || !value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) { out.push(key.toLowerCase()); keysDeep(item, out, depth + 1); }
  return out;
};

/** A swap record for the decline to be read on: a LIVE order with an escrow and a funding height, nothing invented. */
const declineRecord = (engine, { escrow = DECLINE_ESCROW, birthHeight = 12 } = {}) => {
  const swap = engine.swap.createSwap({
    side: "buy", chainMode: "live", network: "local-anvil",
    payToken: "eth", payAmount: 0.01, xmrAmount: 0.5, rate: 2_000, fee: 0.1,
    makerId: "check-maker", makerName: "check-maker", receiveAddress: "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq",
  });
  swap.escrow = { ...(swap.escrow || {}), address: escrow, birthHeight };
  engine.swap.saveSwap(swap);
  return swap;
};

/** The swaps facade over a stand-in service: `answers` is the queue of watch bodies, one per poll. */
const declineFacade = (mod, { answers, logs = null }) => {
  const seen = { polls: 0 };
  const http = {
    tryJson: async () => {
      seen.polls += 1;
      const body = answers.length > 1 ? answers.shift() : answers[0];
      return { ok: true, status: 200, body };
    },
  };
  const config = { apiBase: "http://service.invalid", route: (name, params) => "http://service.invalid/" + name + (params && params.id ? "/" + params.id : ""),
    limits: { watchPollMs: 1, watchTimeoutMs: 25 } };
  return { swaps: mod.createSwaps({ http, config, logs }), seen };
};

export const declineCheck = async () => {
  const problems = [];
  const notes = [];
  const k = async (relative) => import(pathToFileURL(p(...relative.split("/"))).href);
  const [engine, decline, flow, swapsMod] = await Promise.all([
    k("src/engine.mjs"), k("src/decline.mjs"), k("src/swap-flow.mjs"), k("src/swaps.mjs"),
  ]);
  const at = 1_700_000_000_000;
  // A WATCH THAT THROWS WHERE A DECLINE IS DUE IS A PROBLEM OF ITS OWN, AND IT IS NAMED AS ONE: the branch must
  // RETURN the state rather than run on into a refusal. Catching it here is what keeps a broken branch from
  // crashing the whole check with a stack trace that names nothing - the breaking runs would have nothing to read.
  const watchOutcome = async (label, run) => {
    try { return await run(); }
    catch (error) {
      problems.push(`${label} refused with ${JSON.stringify((error && error.code) || null)} instead of reporting the decline`);
      return null;
    }
  };

  // (a) THE EVENT'S IDENTITY. A literal topic, the module's own topic and an independently computed one must be
  // one value; otherwise the chain would be asked for an event nobody emits.
  const independent = independentTopic0(decline.DECLINE_EVENT_SIGNATURE());
  if (decline.DECLINED_TOPIC0.toLowerCase() !== DECLINED_TOPIC0_PINNED) {
    problems.push(`src/decline.mjs: the Declined topic is ${decline.DECLINED_TOPIC0}, the contract's event topic is ${DECLINED_TOPIC0_PINNED}`);
  }
  if (decline.DECLINE_EVENT_SIGNATURE() !== "Declined(address)") {
    problems.push(`src/decline.mjs: the event signature reads "${decline.DECLINE_EVENT_SIGNATURE()}", not "Declined(address)"`);
  }
  if (independent.toLowerCase() !== DECLINED_TOPIC0_PINNED) {
    problems.push(`the Declined topic is not keccak256("Declined(address)") as computed independently: ${independent}`);
  }
  if (DECLINED_TOPIC0_PINNED !== independentTopic0(decline.DECLINE_EVENT_SIGNATURE())) {
    problems.push("the pinned Declined topic does not match the independently hashed event signature");
  }
  if (!decline.DECLINE_FIELDS.includes("terminal") || !decline.DECLINE_FIELDS.includes("code")) {
    problems.push("src/decline.mjs: DECLINE_FIELDS does not carry the state and the node's code");
  }
  notes.push(`the Declined event's topic is ${DECLINED_TOPIC0_PINNED} - a literal, the module's own hash and keccak256("Declined(address)") from another implementation, all three equal`);

  // (b) SOURCE 1 - THE ESCROW'S `Declined` EVENT, through the real read (`orderDecline`).
  const calls = [];
  const logReader = (request) => { calls.push(request); return Promise.resolve([logFrom(DECLINE_ESCROW, decline.DECLINED_TOPIC0)]); };
  const fromEvent = await flow.orderDecline(DECLINE_ESCROW, { logs: logReader, fromBlock: 12, at });
  if (!(fromEvent.declined === true && fromEvent.terminal === "declined" && fromEvent.source === "event" && fromEvent.code === "compliance")) {
    problems.push(`a decline was not read from the escrow's Declined event: ${JSON.stringify(fromEvent)}`);
  }
  if (calls.length !== 1 || calls[0].address !== DECLINE_ESCROW
      || !Array.isArray(calls[0].topics) || String(calls[0].topics[0]).toLowerCase() !== DECLINED_TOPIC0_PINNED
      || calls[0].fromBlock !== "0xc" || calls[0].toBlock !== "latest") {
    problems.push(`the escrow's event was read with the wrong filter: ${JSON.stringify(calls)}`);
  }

  // (c) THE CONTROL THAT MAKES (b) MEAN SOMETHING: an ORDINARY REFUND'S footprint - a `HalfRevealed` log, and a
  // `Declined` log from ANOTHER escrow - must NOT be read as a decline.
  const refundFootprint = await flow.orderDecline(DECLINE_ESCROW, { logs: () => Promise.resolve([
    logFrom(DECLINE_ESCROW, HALF_REVEALED_TOPIC0), logFrom(DECLINE_OTHER, decline.DECLINED_TOPIC0),
  ]) });
  if (refundFootprint.declined !== false || refundFootprint.checked !== true) {
    problems.push(`a refunded escrow was read as a decline (or as unread): ${JSON.stringify(refundFootprint)}`);
  }
  // And an answer that is not a list of logs is a REFUSAL, never "no decline".
  let notAList = null;
  try { await flow.orderDecline(DECLINE_ESCROW, { logs: () => Promise.resolve("nope") }); }
  catch (error) { notAList = error; }
  if (!(notAList && notAList.code === "bad-input")) {
    problems.push(`an answer that is not a list of logs did not refuse with bad-input: ${JSON.stringify({ code: (notAList && notAList.code) || null })}`);
  }

  // (d) THE SERVICE'S `declined` STATUS IS NOT A DECISION. The backend is retired: a wire word may notify, but it
  // must not write a settlement or stop a wait as a decline. The body carries no `receivedXmr`, so the watch refuses
  // it as an unreadable answer - and leaves the record alone.
  const declinedRecord = declineRecord(engine);
  const wire = declineFacade(swapsMod, { answers: [{ status: "declined", code: "compliance", id: "w" }], logs: () => Promise.resolve([]) });
  let wireRefusal = null;
  try { await wire.swaps.watch({ id: declinedRecord.id, escrow: DECLINE_ESCROW, pollMs: 1, timeoutMs: 25 }); }
  catch (error) { wireRefusal = error; }
  if (!(wireRefusal && typeof wireRefusal.code === "string" && wireRefusal.code)) {
    problems.push(`the service's declined status was not refused as an unreadable answer: ${JSON.stringify({ code: (wireRefusal && wireRefusal.code) || null })}`);
  }
  if (engine.swap.getSwap(declinedRecord.id).settlement) {
    problems.push("the service's declined status was written into the record as a settlement");
  }

  // (d2) SOURCE 1 AT THE WATCH LEVEL TOO - the escrow's event stops the wait even when the service says nothing.
  const eventRecord = declineRecord(engine, { escrow: DECLINE_ESCROW });
  const chainOnly = declineFacade(swapsMod, {
    answers: [{ status: "awaiting_funding", receivedXmr: 0, id: "w2" }],
    logs: () => Promise.resolve([logFrom(DECLINE_ESCROW, decline.DECLINED_TOPIC0)]),
  });
  const chainOutcome = await watchOutcome("the watch on the escrow's Declined event",
    () => chainOnly.swaps.watch({ id: eventRecord.id, escrow: DECLINE_ESCROW, pollMs: 1, timeoutMs: 25 }));
  if (!(chainOutcome && chainOutcome.declined === true && chainOutcome.source === "event")) {
    problems.push(`the escrow's Declined event did not stop the wait: ${JSON.stringify(chainOutcome)}`);
  }

  // (e) THE CONTROLS THAT KEEP (d) HONEST. A swap that simply has no XMR yet must STILL time out (the decline does
  // not end every wait), a bare `declined` WITHOUT the node's code must not count, and the locked-funds state must
  // keep its own refusal.
  const plainRecord = declineRecord(engine);
  const plain = declineFacade(swapsMod, { answers: [{ status: "awaiting_funding", receivedXmr: 0, id: "w3" }], logs: () => Promise.resolve([]) });
  let plainRefusal = null;
  try { await plain.swaps.watch({ id: plainRecord.id, escrow: DECLINE_ESCROW, pollMs: 1, timeoutMs: 20 }); }
  catch (error) { plainRefusal = error; }
  if (!(plainRefusal && plainRefusal.code === "xmr-timeout")) {
    problems.push(`an ordinary wait did not end as xmr-timeout: ${JSON.stringify({ code: (plainRefusal && plainRefusal.code) || null })}`);
  }
  if (plain.seen.polls < 2) {
    problems.push(`an ordinary wait stopped after ${plain.seen.polls} poll(s): the decline branch is not conditional`);
  }
  // A SERVICE THAT SAW MONEY DOES NOT DECLARE READINESS. The old path marked the escrow ready on receivedXmr > 0,
  // ignoring the expected amount and confirmations. The observation is now returned with `seen: false` and the
  // next step `verify`; only the client's own two-node check can produce an arrival.
  const observedRecord = declineRecord(engine);
  const observed = declineFacade(swapsMod, { answers: [{ status: "awaiting_funding", receivedXmr: 1, expectedAmountXmr: 10, confirmations: 0, id: "w-observed" }], logs: () => Promise.resolve([]) });
  let observedOutcome = null;
  try { observedOutcome = await observed.swaps.watch({ id: observedRecord.id, escrow: DECLINE_ESCROW, pollMs: 1, timeoutMs: 20 }); }
  catch (error) { observedOutcome = error; }
  if (!(observedOutcome && observedOutcome.seen === false && observedOutcome.next === "verify"
        && observedOutcome.observed && observedOutcome.observed.receivedXmr === 1)) {
    problems.push(`a service observation became readiness: ${JSON.stringify(observedOutcome && (observedOutcome.code || observedOutcome))}`);
  }
  // A BARE `declined` WITHOUT THE NODE'S CODE IS NOT THE STATE THE NODE NAMES: it is an answer that is not a watch
  // response at all (no `receivedXmr` in it), so the watch names THAT and no decline is written down.
  const bareRecord = declineRecord(engine);
  const bare = declineFacade(swapsMod, { answers: [{ status: "declined", id: "w4" }], logs: () => Promise.resolve([]) });
  let bareRefusal = null;
  try { await bare.swaps.watch({ id: bareRecord.id, escrow: DECLINE_ESCROW, pollMs: 1, timeoutMs: 20 }); }
  catch (error) { bareRefusal = error; }
  if (!(bareRefusal && typeof bareRefusal.code === "string" && bareRefusal.code)) {
    problems.push(`a status of "declined" WITHOUT the code "compliance" was not refused with a code: ${JSON.stringify({ code: (bareRefusal && bareRefusal.code) || null })}`);
  }
  if (engine.swap.getSwap(bareRecord.id).settlement) {
    problems.push("a status of \"declined\" WITHOUT the code \"compliance\" was written into the record as a decline");
  }
  const lockedRecord = declineRecord(engine);
  const locked = declineFacade(swapsMod, {
    answers: [{ status: "xmr_locked", receivedXmr: 0, lockedXmr: 1, lockedUntil: { untilHeight: 9 }, id: "w5" }],
    logs: () => Promise.resolve([]),
  });
  let lockedRefusal = null;
  try { await locked.swaps.watch({ id: lockedRecord.id, escrow: DECLINE_ESCROW, pollMs: 1, timeoutMs: 20 }); }
  catch (error) { lockedRefusal = error; }
  if (!(lockedRefusal && lockedRefusal.code === "xmr-locked")) {
    problems.push(`funds barred by unlock_time stopped being xmr-locked: ${JSON.stringify({ code: (lockedRefusal && lockedRefusal.code) || null })}`);
  }

  // (f) THE STATE, ONCE SEEN, IS WRITTEN INTO THE RECORD: every surface that reads the record reports the decline
  // without asking the chain again - and the app can no longer offer a manual refund for an order that is over.
  const stored = await swapsMod.toState(engine.swap.getSwap(eventRecord.id));
  if (stored.terminal !== "declined") {
    problems.push(`the record of a declined swap does not report the state: ${JSON.stringify({ terminal: stored.terminal })}`);
  }
  if (!(stored.settled === true && stored.actions.markReady === false && stored.actions.sweep === false && stored.actions.refund === false)) {
    problems.push(`a declined swap still offers an action or is not settled: ${JSON.stringify(stored.actions)} / settled=${stored.settled}`);
  }
  const settledRecord = engine.swap.getSwap(eventRecord.id);
  if (!(settledRecord.settlement && settledRecord.settlement.kind === "declined")) {
    problems.push("the decline was not written into the swap record as its settlement");
  }
  // AND A LATER WATCH RETURNS IT AT ONCE, WITHOUT POLLING AT ALL (a page reload).
  const afterReload = declineFacade(swapsMod, { answers: [{ status: "awaiting_funding", receivedXmr: 0, id: "w6" }], logs: () => Promise.resolve([]) });
  const reloadOutcome = await watchOutcome("the watch after a reload",
    () => afterReload.swaps.watch({ id: eventRecord.id, escrow: DECLINE_ESCROW, pollMs: 1, timeoutMs: 25 }));
  if (!(reloadOutcome && reloadOutcome.declined === true && reloadOutcome.source === "record" && afterReload.seen.polls === 0)) {
    problems.push(`a reloaded watch did not return the recorded decline at once: ${JSON.stringify(reloadOutcome)} / polls=${afterReload.seen.polls}`);
  }

  // (g) THE CONTROL FOR (f): AN ORDINARY REFUND IS NOT A DECLINE, and neither is a live swap. A record settled by
  // the engine's own refund must keep the refund's OWN state - the exact code `refunded_eth`, not merely something
  // that is not a decline: this control used to accept any other value, and the fallback `closed` (what every
  // refund was reported as while the terminal map was keyed by a kind nothing writes) passed it. A decline never
  // rewrites the state, and a swap with no settlement keeps `terminal: null`: the decline branch is specific, not
  // "anything that is closed".
  const refunded = declineRecord(engine);
  refunded.settlement = { kind: "refund_eth", phase: "refunded_eth", atSim: 0, txHash: "0x" + "bb".repeat(32), by: "you" };
  engine.swap.saveSwap(refunded);
  const refundedState = await swapsMod.toState(engine.swap.getSwap(refunded.id));
  if (refundedState.terminal !== "refunded_eth") {
    problems.push(`a refunded swap was reported as ${JSON.stringify(refundedState.terminal)} instead of the refund's own state "refunded_eth" (settled=${refundedState.settled}), so the app is shown the wrong end state`);
  }
  if (engine.swap.getSwap(refunded.id).settlement.kind !== "refund_eth") {
    problems.push("the settlement of an ordinary refund was rewritten");
  }
  const live = declineRecord(engine);
  const liveState = await swapsMod.toState(engine.swap.getSwap(live.id));
  if (liveState.terminal !== null || liveState.settled !== false) {
    problems.push(`a live swap was given a terminal state: ${JSON.stringify({ terminal: liveState.terminal, settled: liveState.settled })}`);
  }

  // (h) WHAT THE APP IS TOLD, AND WHAT IT IS DELIBERATELY NOT TOLD. Exactly the declared fields, no key anywhere
  // that would carry a reason, a category or a provider, and the node's code unchanged.
  const verdicts = { fromEvent, fromChain: chainOutcome, fromRecord: reloadOutcome };
  for (const [label, verdict] of Object.entries(verdicts)) {
    if (!verdict || typeof verdict !== "object") continue;      // already named above as "refused instead"
    const forbidden = keysDeep(verdict).filter((key) => DECLINE_FORBIDDEN_KEYS.includes(key));
    if (forbidden.length) problems.push(`the ${label} answer carries ${forbidden.join(", ")}: the node names no reason, category or provider, and neither may the SDK`);
    if (verdict.code !== "compliance") problems.push(`the ${label} answer carries the code ${JSON.stringify(verdict.code)} instead of the node's own compliance`);
  }
  const declared = [...decline.DECLINE_FIELDS].sort().join(",");
  const reported = Object.keys(fromEvent).sort().join(",");
  if (declared !== reported) {
    problems.push(`the decline is reported with the fields [${reported}], not with the declared set [${declared}]`);
  }
  const watchDeclared = ["address", "at", "chain", "code", "declined", "escrow", "id", "seen", "source", "terminal", "waitedMs"].sort().join(",");
  const watchShape = chainOutcome ? Object.keys(chainOutcome).sort().join(",") : "";
  if (watchShape !== watchDeclared) {
    problems.push(`the watch reports a decline with the fields [${watchShape}], not with the declared set [${watchDeclared}]`);
  }
  notes.push("the decline carries the state, the node's own `compliance` and WHERE it was seen - and no reason, category or provider, at any depth");
  notes.push("an ordinary refund (a HalfRevealed footprint, or a record settled as refund_eth) is NOT a decline and keeps the refund's own state `refunded_eth`, a bare `declined` without its code is not one either, and a wait with no decline still ends as xmr-timeout");

  const green = problems.length === 0;
  return {
    note: green
      ? "the escrow's Declined event is the only decline source, the wait stops at once, the state is written down, no action and no reason offered"
      : "the maker's decline is not handled as its own state",
    problems,
    notes,
  };
};

// ---------------------------------------------------------------------------------------------------
// 19. TERMINAL - THE STATE THE APP IS TOLD WHEN A SWAP ENDS. The map in src/swaps.mjs must be keyed by the kinds
//     the engine really writes and by nothing else, and a REFUND DRIVEN TO THE END must be reported as
//     `refunded_eth` - not as the fallback `closed`.
//
// WHY THE MAP IS READ FROM THE SOURCE. There is no runtime handle on it, and it is deliberately NOT exported:
// exporting it would change the package's surface (index.d.ts, the README and the surface check all hang off the
// named exports). So the keys come from the module's own text, while the KINDS come from the modules that WRITE a
// settlement - the engine's (engine/core/swap.js) and ours (src/decline.mjs) - and the behaviour is not taken on
// trust: a refund is driven to the end and the state the app is told is read back through the SDK's own surfaces.
//
// AND THE DECLARED TERMINALS ARE HELD TO THE WRITERS TOO. The map is not the whole vocabulary a swap can end in: the
// ENGINE declares its own table (`export const TERMINAL`, engine/core/swap.js) and the CONTRACT declares the union
// (`TerminalCode`, index.d.ts) - and `declined` is declared by this package (src/codes.mjs). A terminal declared in
// one of those places that NO writer can produce is dead: no run can reach it, so nothing holds it to account and a
// reader takes the declaration for coverage. That is exactly why `xmr_returned` could sit in the engine's table and
// in the type for as long as it did - this comparison looked only at the MAP, and the dead entry was never in it.
// Both are read here now, and a declared-but-unwritten terminal is RED with the declaration it came from named.
//
// AND THE OTHER SITUATION THE MAKER'S ABSENCE CREATES IS HELD TO ITS PHASE. The maker taking the XMR back does not
// END a swap, so it must NOT answer to a terminal: it is a phase of its own of a LIVE swap, reached here through
// the simulator until the engine itself reports it.
// ---------------------------------------------------------------------------------------------------

/**
 * The settlement assignments in a module: how many there are, the kinds written as literals and the kinds written
 * through a name (a constant this check has to resolve, rather than guess).
 */
const settlementKindsWritten = (file) => {
  const found = { writes: 0, literals: new Set(), names: new Set() };
  for (const m of read(file).matchAll(/\.settlement\s*=\s*\{([\s\S]{0,300}?)\}/g)) {
    found.writes += 1;
    const kind = /(?:^|[\s{,])kind\s*:\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/.exec(m[1]);
    if (!kind) continue;
    if (kind[1] !== undefined) found.literals.add(kind[1]);
    else found.names.add(kind[2]);
  }
  return found;
};

/**
 * `const TERMINAL = { ... }` of a module as entries: the key (and whether it is written as a name), the value (and
 * whether it is a literal). A key or a value written as a name is resolved by the caller - the map is the only
 * place that knows which constant it means.
 */
const terminalMapEntries = (file) => {
  const text = read(file).replace(/\r\n/g, "\n");
  const start = text.indexOf("const TERMINAL = {");
  if (start < 0) return null;
  const body = text.slice(text.indexOf("{", start) + 1, text.indexOf("};", start));
  const entries = [];
  for (const m of body.matchAll(/(?:^|[\s,{])(?:\[([A-Za-z_$][\w$]*)\]|([A-Za-z_$][\w$]*))\s*:\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/g)) {
    entries.push({ key: m[1] !== undefined ? m[1] : m[2], keyIsName: m[1] !== undefined,
      value: m[3] !== undefined ? m[3] : m[4], valueIsLiteral: m[3] !== undefined });
  }
  return entries;
};

/**
 * THE CODES A `const TERMINAL = { ... }` TABLE DECLARES: its TOP-LEVEL keys - the entries whose VALUE is the
 * `{ phase, label }` object. Pointed at the engine's table, `terminalMapEntries` above would return the INNER
 * phase/label pairs and miss the codes the table is actually keyed by, which is the whole point of reading it.
 */
const terminalTableCodes = (file) => {
  const text = read(file).replace(/\r\n/g, "\n");
  const start = text.indexOf("const TERMINAL = {");
  if (start < 0) return null;
  const end = text.indexOf("};", start);
  if (end < 0) return null;
  const body = stripComments(text.slice(text.indexOf("{", start) + 1, end));
  const codes = [];
  for (const m of body.matchAll(/(?:^|[\s,{])(?:\[([A-Za-z_$][\w$]*)\]|([A-Za-z_$][\w$]*))\s*:\s*\{/g)) {
    codes.push({ key: m[1] !== undefined ? m[1] : m[2], keyIsName: m[1] !== undefined });
  }
  return codes;
};

export const terminalCheck = async () => {
  const problems = [];
  const notes = [];
  const k = async (relative) => import(pathToFileURL(p(...relative.split("/"))).href);
  const [engine, decline, codes, indexMod] = await Promise.all([
    k("src/engine.mjs"), k("src/decline.mjs"), k("src/codes.mjs"), k("src/index.mjs"),
  ]);

  // (a) THE COMPARISON, BOTH WAYS. The kinds are taken from the modules that WRITE a settlement; the keys from the
  // map itself. A kind without a key is the defect this check exists for; a key without a writer is the other half
  // of it - a mapping nothing can reach, which no run can hold to account and a reader takes for coverage.
  const engineKinds = settlementKindsWritten(p("engine", "core", "swap.js"));
  const sdkKinds = { writes: 0, literals: new Set(), names: new Set() };
  for (const file of listFiles(p("src")).filter((f) => CODE_EXT.has(extname(f)))) {
    const found = settlementKindsWritten(file);
    sdkKinds.writes += found.writes;
    for (const value of found.literals) sdkKinds.literals.add(value);
    for (const value of found.names) sdkKinds.names.add(value);
  }
  const resolveName = (name) => (name in decline ? decline[name] : null);
  if (engineKinds.writes === 0) {
    problems.push("no settlement is written in engine/core/swap.js, so the comparison below would be vacuous: the engine's kinds cannot be read");
  }
  // THE TWO WRITERS ARE KEPT APART: a kind the ENGINE writes and a kind THIS PACKAGE writes are reported as such,
  // so a red run says which side moved rather than only that the sets differ.
  const engineEmitted = new Set(engineKinds.literals);
  const sdkEmitted = new Set(sdkKinds.literals);
  const resolveInto = (into, names) => {
    for (const name of names) {
      const value = resolveName(name);
      if (typeof value !== "string" || !value) {
        problems.push(`a settlement kind is written through the name \`${name}\`, which this check cannot resolve to a kind: name it here, or the comparison below is only as good as the names it understands`);
        continue;
      }
      into.add(value);
    }
  };
  resolveInto(engineEmitted, engineKinds.names);
  resolveInto(sdkEmitted, sdkKinds.names);
  const emitted = new Set([...engineEmitted, ...sdkEmitted]);

  const entries = terminalMapEntries(p("src", "swaps.mjs"));
  if (!entries) {
    problems.push("src/swaps.mjs: the terminal map could not be read (no `const TERMINAL = { ... }`), so the kinds and the keys cannot be compared");
    return { note: "the terminal-state map could not be read", problems, notes };
  }
  const keys = new Set();
  for (const entry of entries) {
    const key = entry.keyIsName ? resolveName(entry.key) : entry.key;
    if (typeof key !== "string" || !key) {
      problems.push(`the terminal map's key \`${entry.key}\` does not resolve to a kind: the key must be the kind the engine writes`);
      continue;
    }
    keys.add(key);
  }
  for (const [who, kinds] of [["the engine", engineEmitted], ["this package", sdkEmitted]]) {
    for (const kind of kinds) {
      if (!keys.has(kind)) {
        problems.push(`${who} writes the settlement kind "${kind}" and the terminal map has no key for it: an order settled that way is reported to the app as the fallback "closed" instead of its own state`);
      }
    }
  }
  for (const key of keys) {
    if (!emitted.has(key)) {
      problems.push(`the terminal map has the key "${key}" and no code path writes that kind: a mapping nothing can reach is a mapping no run can be held to`);
    }
  }

  // (b) THE CODES. Every value of the map is a code the CONTRACT declares, and the refund's own mapping is PINNED:
  // a map that is merely consistent with itself would let the refund be reported as any other declared code.
  const declaredCodes = new Set(codes.TERMINAL_CODES);
  const codeOf = (entry) => (entry.valueIsLiteral ? entry.value : resolveName(entry.value));
  for (const entry of entries) {
    const code = codeOf(entry);
    if (typeof code !== "string" || !code) {
      problems.push(`the terminal map's entry for \`${entry.key}\` does not resolve to a code`);
      continue;
    }
    if (!declaredCodes.has(code)) {
      problems.push(`the terminal map sends \`${entry.key}\` to "${code}", which is not a declared TerminalCode (${codes.TERMINAL_CODES.join(", ")})`);
    }
  }
  const refundEntry = entries.find((entry) => (entry.keyIsName ? resolveName(entry.key) : entry.key) === "refund_eth");
  const refundCode = refundEntry ? codeOf(refundEntry) : null;
  if (refundCode !== "refunded_eth") {
    problems.push(`the map sends the refund's kind "refund_eth" to ${JSON.stringify(refundCode === undefined ? null : refundCode)}, not to the refund's own state "refunded_eth"`);
  }

  // (c) THE REFUND, DRIVEN TO THE END - AND THE STATE THE APP IS TOLD. The record is the engine's own (createSwap:
  // a sandbox deal on the mock chain, funded by the mock escrow), the clock is the demo's own
  // (simElapsed = (now - realStart) * speed), the refund goes through the SDK's OWN surface (`swaps.refundEth`,
  // the one the demonstration screen calls) and the state is read the way the app reads it: `swaps.get`/`list`.
  const sdk = indexMod.createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet", mode: "sim" });
  const created = [];
  const sandboxRecord = (scenario) => {
    const swap = engine.swap.createSwap({ side: "buy", scenario, chainMode: "mock", xmrSource: "mock",
      network: "arbitrum-sepolia", payToken: "eth", payAmount: 0.01, xmrAmount: 0.5, rate: 2_000, fee: 0.1,
      makerId: "check-maker", makerName: "check-maker",
      receiveAddress: "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq" });
    engine.swap.saveSwap(swap);
    created.push(swap.id);
    return swap;
  };
  // THE CLOCK OF THE DEMO: `simElapsed(swap) = (Date.now() - realStart) * speed`, so moving `realStart` back is how
  // the sandbox is taken forward - the same lever the demonstration screen's speed control pulls.
  const sandboxAt = (id, simMs) => {
    const swap = engine.swap.getSwap(id);
    swap.realStart = Date.now() - simMs / swap.speed;
    engine.swap.saveSwap(swap);
    return engine.swap.getSwap(id);
  };
  const watchState = async (who, id) => {
    const state = await sdk.swaps.get(id);
    if (!state) { problems.push(`${who}: the record is not in the SDK's own list`); return null; }
    if (state.terminal !== "refunded_eth") problems.push(`${who} reports ${JSON.stringify(state.terminal)}, not "refunded_eth"`);
    if (state.settled !== true) problems.push(`${who} is not reported as settled (${JSON.stringify(state.settled)})`);
    if (state.phase !== "refunded_eth") problems.push(`${who} carries the phase ${JSON.stringify(state.phase)}, not the engine's own "refunded_eth"`);
    const record = engine.swap.getSwap(id);
    const kind = record && record.settlement ? record.settlement.kind : null;
    if (kind !== "refund_eth") problems.push(`${who}: the engine's record does not carry the kind "refund_eth" (it carries ${JSON.stringify(kind)}), so this run would not be about a refund at all`);
    return state;
  };

  // (c1) THE PERSON'S OWN REFUND, taken at the moment the engine opens it: the maker did not lock the XMR by the
  // funding deadline, so the refund is available and the depositor takes his ETH back himself.
  const own = sandboxRecord("maker_no_lock");
  sandboxAt(own.id, 20 * 60_000);
  const beforeRefund = engine.swap.derive(engine.swap.getSwap(own.id));
  if (beforeRefund.can.refund !== true) {
    problems.push(`the refund was not open at the funding deadline (can.refund=${JSON.stringify(beforeRefund.can.refund)}), so the drive below would prove nothing`);
  }
  await sdk.swaps.refundEth(own.id, "you");
  const ownState = await watchState("a refund the depositor made himself", own.id);
  const listed = (await sdk.swaps.list()).filter((state) => state.id === own.id);
  if (!listed.length || listed[0].terminal !== "refunded_eth") {
    problems.push(`the SDK's list reports a refunded order as ${JSON.stringify(listed.length ? listed[0].terminal : null)}, and it must agree with \`get\``);
  }

  // (c2) THE WATCHTOWER'S REFUND, with nobody acting: the deadline passes and the ticker refunds the ETH itself.
  // THIS IS THE SECOND WRITER OF THE SAME KIND - the reason the map needs one key for the refund and not two.
  const tower = sandboxRecord("maker_no_lock");
  sandboxAt(tower.id, 40 * 60_000);
  engine.swap.tick();
  const towerRecord = engine.swap.getSwap(tower.id);
  const towerBy = towerRecord && towerRecord.settlement ? towerRecord.settlement.by : null;
  if (towerBy !== "watchtower") {
    problems.push(`the ticker did not refund the order whose deadline has passed (by=${JSON.stringify(towerBy)}), so the refund's second writer was not exercised`);
  }
  const towerState = await watchState("the watchtower's refund", tower.id);

  // (c3) THE OTHER SITUATION THE MAKER'S ABSENCE CREATES - AND IT IS NOT A TERMINAL. The depositor did not place the
  // ready mark in time, so the maker took the XMR back - and the ETH is STILL in the escrow. The situation has a
  // machine-readable identity of its own: an interface branches on `state.phase` (the code `xmr_reclaimed`) instead
  // of comparing a label, and it is told apart by that CODE from the maker who never locked the XMR, which used to
  // answer to the same name (`refund_available`) with a different label. It is a LIVE state: nothing is settled,
  // `terminal` stays null, and the one thing left to do is take the ETH back.
  const reclaimOf = (id) => {
    // THE SIMULATOR IS STEPPED FORWARD UNTIL THE ENGINE ITSELF REPORTS THE RECLAIM - the same lever the
    // demonstration screen's speed control pulls. The engine's timing constants are not copied here: the bound
    // FAILS LOUDLY (the phase below is then not exercised) if the engine ever stops reporting the reclaim.
    for (const simMs of [2_000_000, 4_000_000, 5_000_000, 6_000_000, 10_000_000, 20_000_000]) {
      sandboxAt(id, simMs);
      if (engine.swap.derive(engine.swap.getSwap(id)).xmrReclaimed === true) return simMs;
    }
    return null;
  };
  const reclaimed = sandboxRecord("happy");
  const reclaimAtSim = reclaimOf(reclaimed.id);
  if (reclaimAtSim === null) {
    problems.push("the maker's reclaim was never reached (the engine reports xmrReclaimed at no step of the simulator): the phase below was not exercised");
  }
  const reclaimState = await sdk.swaps.get(reclaimed.id);
  if (!reclaimState) {
    problems.push("the maker's reclaim: the record is not in the SDK's own list");
  } else {
    if (reclaimState.phase !== "xmr_reclaimed") {
      problems.push(`the maker's reclaim is reported as the phase ${JSON.stringify(reclaimState.phase)}, not the code "xmr_reclaimed": the maker taking the XMR back is a situation of its own, and an interface must branch on a code, not on a label`);
    }
    if (reclaimState.terminal !== null || reclaimState.settled !== false) {
      problems.push(`the maker's reclaim was reported as an END state (terminal=${JSON.stringify(reclaimState.terminal)}, settled=${JSON.stringify(reclaimState.settled)}): the depositor's ETH is still in the escrow, so the swap is live and ends later as \`refunded_eth\``);
    }
    if (!reclaimState.actions || reclaimState.actions.refund !== true) {
      problems.push(`the maker's reclaim offers no refund (actions.refund=${JSON.stringify(reclaimState.actions && reclaimState.actions.refund)}): taking the ETH back is the one thing left to do`);
    }
  }
  // THE OTHER SITUATION THAT OPENS A REFUND, SIDE BY SIDE WITH IT: the maker who never locked the XMR. It keeps the
  // phase `refund_available`, and the two must NOT share a phase - a code two situations share is a code an
  // interface cannot branch on.
  const neverLocked = sandboxRecord("maker_no_lock");
  sandboxAt(neverLocked.id, 25 * 60_000);
  const neverLockedState = await sdk.swaps.get(neverLocked.id);
  if (!neverLockedState || neverLockedState.phase !== "refund_available") {
    problems.push(`the maker who never locked the XMR is reported as the phase ${JSON.stringify(neverLockedState && neverLockedState.phase)}, not "refund_available"`);
  }
  if (reclaimState && neverLockedState && reclaimState.phase === neverLockedState.phase) {
    problems.push(`the maker's reclaim and the maker who never locked share the phase ${JSON.stringify(reclaimState.phase)}: two situations must not answer to one code`);
  }

  // (d) THE CONTROLS THAT KEEP (c) HONEST. A kind the map does not know must still come out as the fallback (the
  // fallback is not dead), no kind the engine can write may be reported AS that fallback, and a swap that has not
  // settled must keep `terminal: null` - the map describes settlements, not "anything that is over".
  const unknown = sandboxRecord("happy");
  unknown.settlement = { kind: "check-made-up-kind", phase: "check-made-up-kind" };
  engine.swap.saveSwap(unknown);
  const unknownState = await sdk.swaps.get(unknown.id);
  const fallback = unknownState ? unknownState.terminal : null;
  if (!declaredCodes.has(fallback)) {
    problems.push(`an unknown settlement kind is reported as ${JSON.stringify(fallback)}, which is not a declared TerminalCode`);
  }
  for (const kind of emitted) {
    const probe = sandboxRecord("happy");
    probe.settlement = { kind, phase: kind };
    engine.swap.saveSwap(probe);
    const state = await sdk.swaps.get(probe.id);
    const terminal = state ? state.terminal : null;
    if (terminal === fallback) {
      problems.push(`a settlement of the kind "${kind}" is reported as the fallback ${JSON.stringify(fallback)}: a state the engine can settle is thrown away for one the map does not carry`);
    }
    if (!declaredCodes.has(terminal)) {
      problems.push(`a settlement of the kind "${kind}" is reported as ${JSON.stringify(terminal)}, which is not a declared TerminalCode`);
    }
  }
  const live = sandboxRecord("happy");
  const liveState = await sdk.swaps.get(live.id);
  if (!liveState || liveState.terminal !== null || liveState.settled !== false) {
    problems.push(`a swap with no settlement was given a terminal state (${JSON.stringify({ terminal: liveState && liveState.terminal, settled: liveState && liveState.settled })})`);
  }

  // (e) THE DECLARED TERMINALS AGAINST THE WRITERS - THE DIRECTION THE MAP ALONE CANNOT SEE. Every code the ENGINE's
  // terminal table and the CONTRACT's `TerminalCode` union declare must be one a writer can really produce: either a
  // kind that is actually written settles as it (through the map above), or it is the fallback an unknown kind comes
  // out as (a code the map deliberately does not key). A declared terminal with NEITHER is DEAD - declared in the
  // engine's table or in the type, reachable from nowhere - and the declaration it came from is NAMED, so a red run
  // says which one is promising a state nothing can reach.
  const engineDeclared = terminalTableCodes(p("engine", "core", "swap.js"));
  if (!engineDeclared) {
    problems.push("engine/core/swap.js: no `const TERMINAL = { ... }` could be read, so a terminal declared there with no writer cannot be named");
  }
  const typeDeclared = unionMembers(read(p("index.d.ts")), "TerminalCode");
  if (typeDeclared === null) {
    problems.push("index.d.ts: no type TerminalCode, so the declared terminal codes cannot be read");
  }
  const declaredTerminals = new Map();
  const declare = (code, where) => {
    if (!declaredTerminals.has(code)) declaredTerminals.set(code, new Set());
    declaredTerminals.get(code).add(where);
  };
  for (const entry of engineDeclared || []) {
    const code = entry.keyIsName ? resolveName(entry.key) : entry.key;
    if (typeof code !== "string" || !code) {
      problems.push(`engine/core/swap.js: the terminal table's key \`${entry.key}\` does not resolve to a code`);
      continue;
    }
    declare(code, "engine/core/swap.js TERMINAL");
  }
  for (const code of typeDeclared || []) declare(code, "index.d.ts TerminalCode");
  // WHAT THE WRITERS ACTUALLY SETTLE AS: a map key with no writer (reported above) proves nothing here.
  const settledAs = new Set();
  for (const entry of entries) {
    const kind = entry.keyIsName ? resolveName(entry.key) : entry.key;
    const code = codeOf(entry);
    if (emitted.has(kind) && typeof code === "string" && code) settledAs.add(code);
  }
  for (const [code, where] of declaredTerminals) {
    if (settledAs.has(code)) continue;   // a written kind settles as this code
    if (code === fallback) continue;      // the unknown-kind fallback: reachable, and asserted declared above
    problems.push(`the terminal "${code}" is DECLARED (${[...where].join(", ")}) and NO WRITER can produce it: no settlement kind maps to it and it is not the fallback "${fallback}", so no run can reach it - a declared state a reader takes for coverage`);
  }

  // THIS CHECK LEAVES THE STORE AS IT FOUND IT: the records it drove are forgotten, so a later check that reads the
  // list is not reading this one's sandbox deals.
  for (const id of created) engine.swap.forgetSwap(id);
  const left = (await sdk.swaps.list()).filter((state) => created.includes(state.id)).length;
  if (left) problems.push(`${left} sandbox record(s) of this check were left in the store`);

  const emittedList = [...emitted].sort().join(", ");
  notes.push(`the kinds the engine and this package write: ${emittedList} - every one of them has a key in the map, and the map has no key without a writer`);
  notes.push(`both writers of the refund's kind were driven to the end: the depositor's own refund reports ${JSON.stringify(ownState && ownState.terminal)} and the watchtower's ${JSON.stringify(towerState && towerState.terminal)}`);
  notes.push(`an unknown kind still comes out as the declared fallback ${JSON.stringify(fallback)}, and a swap with no settlement keeps \`terminal: null\` - \`closed\` is the fallback rather than a key`);
  notes.push(`the maker's reclaim is the LIVE phase "xmr_reclaimed" (reached at ${reclaimAtSim} ms of the simulator), told apart by that code from "refund_available" (the maker who never locked), with \`terminal: null\` - the ETH is still in the escrow and the swap ends later as \`refunded_eth\``);
  notes.push(`every terminal declared by the engine's TERMINAL table (${(engineDeclared || []).map((e) => (e.keyIsName ? resolveName(e.key) : e.key)).join(", ")}) and by the TerminalCode union (${[...(typeDeclared || [])].join(", ")}) is reachable: a written kind settles as it, or it is the fallback`);
  return { note: `${emitted.size} settlement kind(s) against ${keys.size} map key(s), ${declaredTerminals.size} declared terminal(s) each reachable, a refund driven to the end by both of its writers and the maker's reclaim driven to its own phase`, problems, notes };
};


// THE PROVIDER ENTRY, DRIVEN RATHER THAN COUNTED. The surface and types checks prove the names exist and are
// declared; this one proves the three rules a consumer leans on: the provider code follows the ADDRESS and is
// stable, the public key path follows the private one, and a settings file is found and read the way the node
// reads it. It also proves the bound quote helpers refuse a quote that cannot be verified.
const providerCheck = async () => {
  const problems = [];
  const notes = [];
  const provider = await import(pathToFileURL(p("src/public/provider.mjs")).href);
  const order = await import(pathToFileURL(p("src/public/order.mjs")).href);

  const addressA = "0x" + "11".repeat(20);
  const addressB = "0x" + "22".repeat(20);
  const codeA = provider.providerCode(addressA);
  if (!provider.PROVIDER_CODE_RE.test(codeA)) problems.push(`providerCode returned ${codeA}, which does not match PROVIDER_CODE_RE`);
  if (provider.providerCode(addressA) !== codeA) problems.push("providerCode is not stable for the same address");
  if (provider.providerCode(addressB) === codeA) problems.push("providerCode is the same for two different addresses");
  notes.push(`providerCode is the address's own name: ${codeA}`);

  const keyPath = provider.publicKeyPath("C:/keys/provider.key");
  if (keyPath !== "C:/keys/provider.pub") problems.push(`publicKeyPath returned ${keyPath} for provider.key`);
  const bare = provider.publicKeyPath("C:/keys/provider");
  if (bare !== "C:/keys/provider.pub") problems.push(`publicKeyPath returned ${bare} for a path without .key`);

  const dir = mkdtempSync(join(tmpdir(), "sdk-provider-"));
  try {
    writeFileSync(join(dir, "rfq.env"), "ALPHA=1\nBETA=two words\n", "utf8");
    const found = provider.findEnvFile(dir);
    if (found !== join(dir, "rfq.env")) problems.push(`findEnvFile returned ${found}, expected the settings file in the directory`);
    const values = provider.readEnvFile(join(dir, "rfq.env"));
    if (values.ALPHA !== "1" || values.BETA !== "two words") problems.push(`readEnvFile returned ${JSON.stringify(values)}`);
    const target = {};
    provider.applyEnvFile(join(dir, "rfq.env"), target);
    if (target.ALPHA !== "1" || target.BETA !== "two words") problems.push(`applyEnvFile set ${JSON.stringify(target)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  notes.push("a settings file is found, read and applied by the same rules");

  const missing = order.orderQuoteMissingFields({});
  if (!Array.isArray(missing) || missing.length === 0) problems.push("orderQuoteMissingFields({}) is empty: an unverifiable quote would pass");
  let recovered = "not run";
  try {
    recovered = order.recoverOrderQuoteKey({ signature: "0x" + "00".repeat(65) });
  } catch {
    recovered = null;
  }
  if (typeof recovered === "string" && recovered.length) problems.push(`recoverOrderQuoteKey returned ${recovered} for an empty quote`);
  notes.push("bound quote verification names what is missing and recovers nothing from an empty quote");

  return { note: "provider code, key path, settings file and bound quote verification all behave", problems, notes };
};

const runScriptCheck = (tool, label) => {
  const problems = [];
  try {
    const out = execFileSync(process.execPath, [p("tools", tool)], { encoding: "utf8" });
    const passed = (out.match(/^  ok    /gm) || []).length;
    return { note: `${label}: ${passed} checks passed`, problems, notes: [] };
  } catch (error) {
    const text = String((error && (error.stdout || error.message)) || error);
    for (const line of text.split("\n")) if (/FAIL|FAILED/.test(line)) problems.push(line.trim());
    return { note: `${label} failed`, problems, notes: [] };
  }
};

const saleAuthCheck = () => runScriptCheck("check-sale-auth.mjs", "sale auth");
const backupConfirmationCheck = () => runScriptCheck("check-backup-confirmation.mjs", "backup confirmation");
const keyViewCheck = () => runScriptCheck("check-key-view.mjs", "key view");
const arrivalConsensusCheck = () => runScriptCheck("check-arrival-consensus.mjs", "arrival consensus");
const arrivalRealCheck = () => runScriptCheck("check-arrival-real.mjs", "real arrival");
const orderProofCheck = () => runScriptCheck("check-order-proof.mjs", "order proof");
const fundingReceiptCheck = () => runScriptCheck("check-funding-receipt.mjs", "funding receipt");
const storageCheck = () => runScriptCheck("check-storage.mjs", "storage");
const scanRangeCheck = () => runScriptCheck("check-scan-range.mjs", "scan range");
const recoveryOpenCheck = () => runScriptCheck("check-recovery-open.mjs", "recovery open");
const contractVectorsCheck = () => runScriptCheck("check-contract-vectors.mjs", "contract vectors");
const atomicFlowCheck = () => runScriptCheck("check-atomic-flow.mjs", "atomic flow");
const CHECKS = {
  syntax: syntaxCheck,
  import: importCheck,
  surface: surfaceCheck,
  mirror: mirrorCheck,
  pack: packCheck,
  secrets: secretsCheck,
  cow: cowCheck,
  "cow-refusal": cowRefusalCheck,
  kyber: kyberCheck,
  "kyber-refusal": kyberRefusalCheck,
  uniswapx: uniswapxCheck,
  "uniswapx-refusal": uniswapxRefusalCheck,
  "uniswap-relay": uniswapRelayCheck,
  "uniswap-relay-refusal": uniswapRelayRefusalCheck,
  compose: composeCheck,
  entries: entriesCheck,
  types: typesCheck,
  version: versionCheck,
  refusals: refusalsCheck,
  decline: declineCheck,
  terminal: terminalCheck,
  provider: providerCheck,
  "recovery-key": recoveryKeyCheck,
  "sale-auth": saleAuthCheck,
  "backup-confirmation": backupConfirmationCheck,
  "key-view": keyViewCheck,
  "arrival-consensus": arrivalConsensusCheck,
  "arrival-real": arrivalRealCheck,
  "order-proof": orderProofCheck,
  "sweep-window": sweepWindowCheck,
  "sweep-order": sweepFromOrderCheck,
  "sweep-adapter": sweepAdapterCheck,
  "claim-tip": claimTipCheck,
  "claim-sender": claimSenderCheck,
  "quote-rank": quoteRankCheck,
  "settlement-profiles": settlementProfilesCheck,
  "funding-receipt": fundingReceiptCheck,
  storage: storageCheck,
  "scan-range": scanRangeCheck,
  "recovery-open": recoveryOpenCheck,
  "contract-vectors": contractVectorsCheck,
  "atomic-flow": atomicFlowCheck,
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
