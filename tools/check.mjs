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
// RUNNER
// ---------------------------------------------------------------------------------------------------

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
