#!/usr/bin/env node
// THE ARRIVAL GUARDS ARE LOAD-BEARING.
//
// The consensus check drives the real verifyArrival cases, but a case stays green if the guard it protects is
// removed and a later fallback returns the same shape. These mutations are the deletion proofs: an unsynchronized
// witness must stop counting as absence, a key that does not belong to the address must be refused before the
// network walk, and a silent witness must not agree that the money is absent.
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

function isHost(url, host) {
  try { return new URL(url).hostname === host; } catch { return false; }
}

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

// A SHADOW FIXTURE WITH TWO WITNESSES AT DIFFERENT TOPS. The exact nodes and W reach block 120; X reaches block 139.
// Nothing was paid, so the highest-top rule is what decides whether W's shorter walk counts as evidence.
const shadowTopFetch = async (url, init) => {
  const body = JSON.parse(String(init.body || "{}"));
  if (String(url).endsWith("/v1/witness/slice")) {
    const top = isHost(url, "x.example") ? 139 : 120;
    const from = Number(body.slice) * Number(body.grid);
    const to = Math.min(from + Number(body.grid) - 1, top);
    const blocks = Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => {
      const height = from + i;
      return { height, hash: String(height).padStart(64, "0"), txids: [] };
    });
    return { ok: true, status: 200, json: async () => ({ version: 1, network: "stagenet", grid: 20,
      slice: body.slice, from, to, complete: to === from + Number(body.grid) - 1, blocks,
      tip: to === from + Number(body.grid) - 1 ? null : { height: to, hash: blocks[blocks.length - 1].hash } }) };
  }
  if (body.method === "get_info") {
    const height = isHost(url, "x.example") ? 140 : 121;
    return { ok: true, status: 200, json: async () => ({ result: { height, synchronized: true, status: "OK", nettype: "stagenet" } }) };
  }
  if (body.method === "get_block") {
    return { ok: true, status: 200, json: async () => ({ result: { block_header: { hash: "a".repeat(64) }, tx_hashes: [] } }) };
  }
  return { ok: true, status: 200, json: async () => ({ txs: [], txs_as_json: [] }) };
};

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
    "if (!bound.ok) {", "if (false) {", "no-spend-check");
  let mutantMismatch = null;
  try { await noSpendCheck.verifyArrival(request({ spendPub: wrongSpend, fetch: fetchFor({ synchronized: true }) })); }
  catch (error) { mutantMismatch = error; }
  if (!mutantMismatch || mutantMismatch.code !== "xmr-address-mismatch") {
    ok("removing the address binding stops refusing the wrong key (the guard is load-bearing)");
  } else bad("spend-check mutation", "it kept refusing");

  // THE SHADOW'S ABSENCE RULE HAS ITS OWN DELETION PROOF. A witness that never answered is not evidence that
  // the money is absent; removing the completed/failed condition must make the comparison claim agreement.
  const absentFetch = async (url, init) => {
    if (isHost(url, "missing.example")) return { ok: false, status: 404, json: async () => ({}) };
    return fetchFor({ synchronized: true })(url, init);
  };
  const shadowRequest = {
    ...request({ fetch: absentFetch }),
    witnessNodes: [{ url: "https://missing.example", operator: "W", protocol: "witness-v1" }],
  };
  const absentShadow = await real.verifyArrivalShadow(shadowRequest);
  if (absentShadow.exact && absentShadow.exact.absent === true
    && absentShadow.witness.completed === false && absentShadow.agrees === false
    && absentShadow.problems.includes("witness:not-completed")) {
    ok("a silent witness does not agree that the money is absent");
  } else bad("shadow absence guard", JSON.stringify({
    exact: absentShadow.exact && absentShadow.exact.absent,
    completed: absentShadow.witness.completed,
    agrees: absentShadow.agrees,
    problems: absentShadow.problems,
  }));

  const shadowTopRequest = {
    ...request({ fetch: shadowTopFetch }),
    witnessNodes: [
      { url: "https://w.example", operator: "W", protocol: "witness-v1" },
      { url: "https://x.example", operator: "X", protocol: "witness-v1" },
    ],
  };
  const topAware = await real.verifyArrivalShadow(shadowTopRequest);
  if (topAware.exact && topAware.exact.absent === true
    && topAware.witness.completed === true && topAware.witness.quorum.ok === false
    && topAware.agrees === false) {
    ok("the shorter witness does not complete against the highest top");
  } else bad("highest-top guard", JSON.stringify({ quorum: topAware.witness.quorum,
    checked: topAware.witness.checked, agrees: topAware.agrees, problems: topAware.problems }));

  const topMutant = await mutatedLadder(
    "const targetTop = highestTop === null ? top : Math.max(top, highestTop);",
    "const targetTop = top;", "highest-top");
  const mutantTop = await topMutant.verifyArrivalShadow(shadowTopRequest);
  if (mutantTop.agrees === false && mutantTop.witness.quorum.ok === false) {
    ok("removing the common target alone still leaves the served-tip target refusing agreement");
  } else bad("highest-top mutation", JSON.stringify({ quorum: mutantTop.witness.quorum,
    agrees: mutantTop.agrees, problems: mutantTop.problems }));

  const noWitnessEvidence = await mutatedLadder(
    "if (witness.completed && witness.failed.length === 0 && witness.quorum.ok && !witnessDisagreements.length) agrees = true;",
    "if (true) agrees = true;", "no-witness-evidence");
  const mutantShadow = await noWitnessEvidence.verifyArrivalShadow(shadowRequest);
  if (mutantShadow.agrees === true) {
    ok("removing the completed/failed condition makes a silent witness agree (the guard is load-bearing)");
  } else bad("shadow absence mutation", JSON.stringify(mutantShadow));
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (problems.length) {
  console.log("FAILED: " + problems.length + " (passed " + pass + ")");
  process.exit(1);
}
console.log("arrival teeth: " + pass + " checks passed.");
