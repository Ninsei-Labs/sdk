#!/usr/bin/env node
// THE ARRIVAL GUARDS ARE LOAD-BEARING.
//
// The consensus check drives the real verifyArrival cases, but a case stays green if the guard it protects is
// removed and a later fallback returns the same shape. These two mutations are the deletion proofs: an unsynchronized
// witness must stop counting as absence, and a key that does not belong to the address must be refused before the
// network walk.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { addressFromKeys } from "../engine/monero/address.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const G = ed25519.Point.BASE;
const VIEW = 11n;
const SPEND = 13n;
const spendPub = G.multiply(SPEND).toHex();
const viewPub = G.multiply(VIEW).toHex();
const address = addressFromKeys({ network: "stagenet", kind: "primary", spendPub, viewPub }, { keccak256 });
const wrongSpend = G.multiply(SPEND + 1n).toHex();
const dir = mkdtempSync(join(tmpdir(), "sdk-arrival-teeth-"));

let pass = 0;
const problems = [];
const ok = (name) => { pass += 1; console.log("  ok    " + name); };
const bad = (name, why) => { problems.push(name + ": " + why); console.log("  FAIL  " + name + ": " + why); };

const fetchFor = ({ synchronized, tx = false, empty = false } = {}) => async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.method === "get_info") return { ok: true, json: async () => ({ result: { height: 121, synchronized } }) };
  if (body.method === "get_block") return { ok: true, json: async () => ({
    result: { block_header: { hash: "a".repeat(64) }, tx_hashes: tx ? ["b".repeat(64)] : [] },
  }) };
  if (body.method === "get_transactions") return { ok: true, json: async () => ({ txs: [], txs_as_json: [] }) };
  if (empty) throw new Error("unexpected call");
  return { ok: true, json: async () => ({ txs: [], txs_as_json: [] }) };
};

const request = (overrides = {}) => ({
  nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
  address, viewSecret: VIEW, spendPub, expectedAtomic: "1", minConfirmations: 1,
  fromHeight: 120, txid: null, fetch: fetchFor({ synchronized: false }), ...overrides,
});

async function mutatedLadder(from, to, name) {
  const source = readFileSync(join(ROOT, "src", "xmr-arrival.mjs"), "utf8").replace(/\r\n/g, "\n");
  const at = source.indexOf(from);
  if (at < 0) throw new Error("the mutation did not apply: " + from.slice(0, 70));
  const changed = source.slice(0, at) + to + source.slice(at + from.length);
  if (changed === source) throw new Error("the mutation changed nothing: " + from.slice(0, 70));
  const rewritten = changed.replace(/from\s+"(\.\/[^"]+)"/g,
    (whole, rel) => `from "${pathToFileURL(join(ROOT, "src", rel)).href}"`);
  const file = join(dir, name + ".mjs");
  writeFileSync(file, rewritten, "utf8");
  return import(pathToFileURL(file).href + "?v=" + name);
}

try {
  const real = await import(pathToFileURL(join(ROOT, "src", "xmr-arrival.mjs")).href);
  const pending = await real.verifyArrival(request());
  if (pending && pending.state === "pending" && pending.absent === false) ok("the shipped module does not call two stale witnesses absent");
  else bad("shipped unsynchronized verdict", JSON.stringify(pending));

  const noSyncCheck = await mutatedLadder("if (!info.synced) {", "if (false) {", "no-sync-check");
  const staleMutant = await noSyncCheck.verifyArrival(request());
  if (staleMutant && staleMutant.absent === true) ok("removing the sync check makes the stale pair absent (the guard is load-bearing)");
  else bad("sync-check mutation", JSON.stringify(staleMutant));

  let originalMismatch = null;
  try { await real.verifyArrival(request({ spendPub: wrongSpend, fetch: fetchFor({ synchronized: true }) })); }
  catch (error) { originalMismatch = error; }
  if (originalMismatch && originalMismatch.code === "xmr-address-mismatch") ok("the shipped module refuses a key from another address");
  else bad("original key binding", JSON.stringify(originalMismatch && (originalMismatch.code || originalMismatch.message)));

  const noSpendCheck = await mutatedLadder(
    "if (!addressKeys.spendPub || spendPub !== String(addressKeys.spendPub).toLowerCase()) {",
    "if (false) {", "no-spend-check");
  let mutantMismatch = null;
  try { await noSpendCheck.verifyArrival(request({ spendPub: wrongSpend, fetch: fetchFor({ synchronized: true }) })); }
  catch (error) { mutantMismatch = error; }
  if (!mutantMismatch || mutantMismatch.code !== "xmr-address-mismatch") {
    ok("removing the address binding stops refusing the wrong key (the guard is load-bearing)");
  } else bad("spend-check mutation", "it kept refusing");
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (problems.length) {
  console.log("FAILED: " + problems.length + " (passed " + pass + ")");
  process.exit(1);
}
console.log("arrival teeth: " + pass + " checks passed.");
