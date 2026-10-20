#!/usr/bin/env node
// THE WALLET FACTORY AND THE NETWORK A NODE NAMES.
//
// Two things used to live on the sweep page: `createWalletFull` with a byte-for-byte map from "stagenet" to the
// library's enum, and a private `networkFromNode`. A caller had to know the library to open a wallet, and "what a
// node may say" was one interface's knowledge.
//
// WHAT IS PROVEN (a stand-in library; no WASM, no node):
//   1) the network word is translated into the library's enum - the exact value, not the string;
//   2) the rest of the request reaches the library unchanged (node, password, height, keys);
//   3) the returned wallet is a wallet: `vm`, address, network, free remainder after `connect`;
//   4) refusals carry codes: no namespace, no `createWalletFull`, no network, no node;
//   5) `networkFromNode` maps the three known answers and returns null for anything else - a default would build a
//      wallet for a chain the node may not serve.
//
// BREAKING RUNS (each mutates a COPY of a module in a temp directory):
//   A) drop the enum translation (pass the string) -> case 1 reddens;
//   B) default an unknown nettype to "stagenet" -> the null case reddens.
//
// Run: node tools/check-wallet-factory.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSweep } from "../src/sweep.mjs";
import { networkFromNode } from "../src/public/xmr.mjs";
import { SdkError } from "../src/errors.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP = join(ROOT, "src", "sweep.mjs");
const NODE_NETWORK = join(ROOT, "engine", "monero", "nodeNetwork.js");
const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

// THE STAND-IN LIBRARY: the namespace the page imports (default export) with the two names this rule needs. It
// records each config so the guard can assert what the library actually received.
function library({ address = ADDRESS } = {}) {
  const seen = { configs: [], heights: [] };
  return {
    seen,
    MoneroNetworkType: { MAINNET: 0, STAGENET: 1, TESTNET: 2 },
    async createWalletFull(config) {
      seen.configs.push(config);
      return {
        async getAddress() { return address; },
        async setRestoreHeight(h) { seen.heights.push(h); },
        async getRestoreHeight() { return seen.heights[seen.heights.length - 1] ?? 0; },
        async getUnlockedBalance() { return 12n; },
        async sync() { seen.synced = (seen.synced || 0) + 1; },
        async close() { seen.closed = (seen.closed || 0) + 1; },
      };
    },
  };
}

const sweep = () => createSweep({ http: null, config: null });
const request = (moneroTs, over = {}) => ({
  moneroTs, network: "stagenet", serverUri: "http://node.invalid", keys: { seed: "unit seed" }, restoreHeight: 2_000_000, ...over,
});
const refused = async (fn) => {
  try { await fn(); return null; }
  catch (error) { return error; }
};
const fieldOf = (error) => (error && error.params && error.params.field) || null;

console.log("=== 1) THE NETWORK WORD BECOMES THE LIBRARY'S ENUM ===");
{
  const lib = library();
  const wallet = sweep().wallet(request(lib));
  await wallet.connect();
  const config = lib.seen.configs[0] || {};
  if (config.networkType === lib.MoneroNetworkType.STAGENET) ok("stagenet -> MoneroNetworkType.STAGENET (the value, not the string)");
  else bad("networkType: " + JSON.stringify(config.networkType));
  if (config.server && config.server.uri === "http://node.invalid") ok("the node reaches the library unchanged");
  else bad("server: " + JSON.stringify(config.server));
  if (config.restoreHeight === 2_000_000) ok("the restore height reaches the library");
  else bad("restoreHeight: " + JSON.stringify(config.restoreHeight));
  if (config.seed === "unit seed") ok("the keys reach the library unchanged");
  else bad("keys: " + JSON.stringify({ seed: config.seed }));
  if (wallet.vm === "monero" && wallet.chainId() === "stagenet") ok("the wallet names its vm and its network");
  else bad("wallet surface: " + JSON.stringify({ vm: wallet.vm, chainId: (() => { try { return wallet.chainId(); } catch { return null; } })() }));
  if (wallet.address() === ADDRESS) ok("the address is the library's own");
  else bad("address: " + wallet.address());
  if (String(await wallet.unlockedBalance()) === "12") ok("the free remainder comes through unchanged");
  else bad("unlockedBalance did not come through");
  await wallet.close();
}
{
  const lib = library();
  const wallet = sweep().wallet(request(lib, { network: "STAGENET" }));
  await wallet.connect();
  if (lib.seen.configs[0].networkType === lib.MoneroNetworkType.STAGENET) ok("the network word is case-insensitive (STAGENET -> the enum)");
  else bad("STAGENET -> " + JSON.stringify(lib.seen.configs[0].networkType));
}

console.log("=== 2) REFUSALS CARRY CODES ===");
{
  const cases = [
    ["no namespace", () => sweep().wallet(request(undefined)), "moneroTs"],
    ["no createWalletFull", () => sweep().wallet(request({ MoneroNetworkType: {} })), "moneroTs.createWalletFull"],
    ["unknown network", () => sweep().wallet(request(library(), { network: "devnet" })), "network"],
    ["no node", () => sweep().wallet(request(library(), { serverUri: "" })), "serverUri"],
  ];
  for (const [name, fn, field] of cases) {
    const error = await refused(async () => fn());
    const named = error instanceof SdkError && error.code === "bad-input" && fieldOf(error) === field;
    if (named) ok(name + " -> bad-input, field " + field);
    else bad(name + " -> " + JSON.stringify(error ? { code: error.code, field: fieldOf(error) } : null));
  }
}

console.log("=== 3) THE NETWORK A NODE NAMES ===");
{
  const cases = [
    [{ nettype: "mainnet" }, "mainnet"],
    [{ nettype: "stagenet" }, "stagenet"],
    [{ nettype: "testnet" }, "testnet"],
    [{ nettype: "fakechain" }, "fakechain"],
    [{ nettype: " MainNet " }, "mainnet"],
    [{ nettype: "devnet" }, null],
    [{ nettype: "" }, null],
    [{}, null],
    [null, null],
  ];
  const wrong = cases.filter(([info, want]) => networkFromNode(info) !== want);
  if (!wrong.length) ok("four known answers map, everything else is null (" + cases.length + " cases)");
  else bad("networkFromNode: " + JSON.stringify(wrong.map(([info]) => [info, networkFromNode(info)])));
}

function mutated(sourcePath, mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-wallet-factory-"));
  const source = mutate(readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n"));
  const rewritten = source.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) => `from "${pathToFileURL(join(dirname(sourcePath), rel)).href}"`);
  const file = join(dir, name + ".mjs");
  writeFileSync(file, rewritten, "utf8");
  return { file, dir };
}
const importFresh = (file) => import(pathToFileURL(file).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 4) BREAKING RUN A: the string goes to the library -> case 1 reddens ===");
{
  const { file, dir } = mutated(SWEEP, (src) => {
    const before = src;
    src = src.replace("createWallet: (config) => moneroTs.createWalletFull({ ...config, networkType: enumValue }),",
      "createWallet: (config) => moneroTs.createWalletFull(config),");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "sweep");
  try {
    const mod = await importFresh(file);
    const lib = library();
    let config = null;
    try {
      const wallet = mod.createSweep({ http: null, config: null }).wallet(request(lib));
      await wallet.connect();
      config = lib.seen.configs[0];
    } catch { /* below */ }
    if (!config || config.networkType !== lib.MoneroNetworkType.STAGENET) ok("breaking run A REDDENS: the library received " + JSON.stringify(config && config.networkType));
    else bad("breaking run A does not redden: the enum still arrived");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 5) BREAKING RUN B: an unknown nettype defaults -> the null case reddens ===");
{
  const { file, dir } = mutated(NODE_NETWORK, (src) => {
    const before = src;
    src = src.replace("return KNOWN.has(type) ? type : null;", 'return KNOWN.has(type) ? type : "stagenet";');
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "nodeNetwork");
  try {
    const mod = await importFresh(file);
    const got = mod.networkFromNode({ nettype: "devnet" });
    if (got !== null) ok("breaking run B REDDENS: an unknown nettype became " + JSON.stringify(got));
    else bad("breaking run B does not redden: an unknown nettype is still null");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "wallet factory: " + pass + " checks passed.");
if (fails.length) process.exit(1);
