#!/usr/bin/env node
// THE WINDOW START MUST COME FROM THE GRID, NOT FROM THE ORDER'S EXACT START. Replacing the grid start with
// `fromHeight` makes two starts inside one window issue different requests; the original must keep them equal.
// Run: node tools/check-recovery-witness-teeth.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { readRecoveryWitness } from "../src/xmr-arrival.mjs";
import { addressFromKeys } from "../engine/monero/address.js";
import {
  amountMaskCommitment, bytesToHex, derivedOutputKey, hashToScalar, hexToBytes, keyDerivation,
  scalarToBytesLE, varint,
} from "../engine/monero/scan.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(ROOT, "src/xmr-arrival.mjs");
const temp = mkdtempSync(join(tmpdir(), "sdk-recovery-witness-"));
const mutantPath = join(temp, "xmr-arrival.mjs");
const source = readFileSync(sourcePath, "utf8");
const guard = "const start = witnessSliceStart(window);";
if (!source.includes(guard)) throw new Error("the witness window start moved; update this teeth check");
const mutantSource = source
  .replace('from "./errors.mjs"', `from "${pathToFileURL(join(ROOT, "src/errors.mjs")).href}"`)
  .replace('from "./engine.mjs"', `from "${pathToFileURL(join(ROOT, "src/engine.mjs")).href}"`)
  .replace('from "./witness-slice.mjs"', `from "${pathToFileURL(join(ROOT, "src/witness-slice.mjs")).href}"`)
  .replace(guard, "const start = fromHeight;");
writeFileSync(mutantPath, mutantSource, "utf8");
const slicePath = join(ROOT, "src/witness-slice.mjs");
const sliceSource = readFileSync(slicePath, "utf8");
const sliceGuard = "return Math.floor(value / WITNESS_SLICE_BLOCKS);";
if (!sliceSource.includes(sliceGuard)) throw new Error("the slice index moved; update this teeth check");
const sliceMutantPath = join(temp, "witness-slice.mjs");
writeFileSync(sliceMutantPath, sliceSource
  .replace('from "./errors.mjs"', `from "${pathToFileURL(join(ROOT, "src/errors.mjs")).href}"`)
  .replace(sliceGuard, "return Math.floor((value - 1) / WITNESS_SLICE_BLOCKS);"), "utf8");
const boundaryMutantPath = join(temp, "xmr-arrival-boundary.mjs");
const boundaryMutantSource = source
  .replace('from "./errors.mjs"', `from "${pathToFileURL(join(ROOT, "src/errors.mjs")).href}"`)
  .replace('from "./engine.mjs"', `from "${pathToFileURL(join(ROOT, "src/engine.mjs")).href}"`)
  .replace('from "./witness-slice.mjs"', `from "${pathToFileURL(sliceMutantPath).href}"`);
writeFileSync(boundaryMutantPath, boundaryMutantSource, "utf8");

const G = ed25519.Point.BASE;
const VIEW = 11n, SPEND = 13n, R = 17n;
const SPEND_PUB = G.multiply(SPEND).toHex();
const VIEW_PUB = G.multiply(VIEW).toHex();
const ADDRESS = addressFromKeys({ network: "stagenet", kind: "primary", spendPub: SPEND_PUB, viewPub: VIEW_PUB }, { keccak256 });
const le8 = (value) => { const out = new Uint8Array(8); let v = BigInt(value); for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; } return out; };
const xor = (bytes, factor) => bytes.map((byte, i) => byte ^ (factor[i] || 0));
const factorOf = (label, scalarLE) => {
  const name = new TextEncoder().encode(label);
  const buf = new Uint8Array(name.length + scalarLE.length);
  buf.set(name); buf.set(scalarLE, name.length);
  return keccak256(buf);
};
const fixture = (amount) => {
  const txPublicKey = G.multiply(R).toHex();
  const derivation = keyDerivation(txPublicKey, VIEW);
  const scalarLE = scalarToBytesLE(hashToScalar(derivation, varint(0)));
  const amountCipher = xor(Array.from(le8(amount)), factorOf("amount", scalarLE));
  const mask = hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
  return { version: 2, unlock_time: 0, extra: [1, ...hexToBytes(txPublicKey)],
    vout: [{ amount: 0, target: { tagged_key: { key: derivedOutputKey(derivation, 0, SPEND_PUB), view_tag: "00" } } }],
    rct_signatures: { type: 6, ecdhInfo: [{ amount: bytesToHex(Uint8Array.from(amountCipher)) }], outPk: [amountMaskCommitment(amount, mask)] } };
};
const H = (height) => (height < 0 ? "00" : height.toString(16).padStart(2, "0")).repeat(32);
const TX = { 6: { ["a".repeat(64)]: fixture(100_000_000_000n) } };
const daemon = ({ height = 11 } = {}) => {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method || null, height: body.params && body.params.height });
    if (body.method === "get_info") return { ok: true, json: async () => ({ result: { height, synchronized: true, nettype: "stagenet" } }) };
    if (body.method === "get_block") {
      const height = Number(body.params.height);
      const hashes = TX[height] ? Object.keys(TX[height]) : [];
      return { ok: true, json: async () => ({ result: { block_header: { height, hash: H(height), prev_hash: H(height - 1), num_txes: hashes.length }, tx_hashes: hashes } }) };
    }
    if (new URL(url).pathname.endsWith("/get_transactions")) {
      const hashes = body.txs_hashes || [];
      return { ok: true, json: async () => ({ txs: hashes.map((hash) => ({ tx_hash: hash, block_height: 6, confirmations: 3, in_pool: false })), txs_as_json: hashes.map((hash) => JSON.stringify(TX[6][hash])) }) };
    }
    return { ok: false, status: 404 };
  };
  return { calls, fetch };
};
const request = (fetch, fromHeight) => ({ node: { url: "https://witness.example", operator: "witness" },
  address: ADDRESS, viewSecret: VIEW, spendPub: SPEND_PUB, fromHeight, tipHeight: 10, fetch });
const heights = (calls) => calls.filter((call) => call.method === "get_block").map((call) => call.height).join(",");

const a = daemon(), b = daemon();
await readRecoveryWitness(request(a.fetch, 5));
await readRecoveryWitness(request(b.fetch, 6));
if (heights(a.calls) !== heights(b.calls)) throw new Error("the original already leaks the exact start");

let mutant;
try {
  mutant = await import(pathToFileURL(mutantPath).href + "?v=" + process.pid);
  const c = daemon(), d = daemon();
  await mutant.readRecoveryWitness(request(c.fetch, 5));
  await mutant.readRecoveryWitness(request(d.fetch, 6));
  if (heights(c.calls) === heights(d.calls)) {
    throw new Error("replacing the grid start with the exact start did not change the requests: the check is not load-bearing");
  }
} finally {
  // Keep the temp directory until both mutants have run.
}
console.log("  ok    replacing the grid start with the exact start changes the requests");

{
  const e = daemon({ height: 21 });
  const mutantBoundary = await import(pathToFileURL(boundaryMutantPath).href + "?v=" + process.pid);
  await mutantBoundary.readRecoveryWitness({ ...request(e.fetch, 20), tipHeight: 20 });
  const requested = e.calls.filter((call) => call.method === "get_block").map((call) => call.height).join(",");
  if (requested !== "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19") {
    throw new Error("moving the grid boundary by one did not change the start for height 20");
  }
  console.log("  ok    moving the grid boundary by one changes the start for height 20");
}
rmSync(temp, { recursive: true, force: true });
console.log("recovery witness teeth: the grid boundary is load-bearing");
