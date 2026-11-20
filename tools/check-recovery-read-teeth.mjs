#!/usr/bin/env node
// THE PRIMARY READ MUST RESUME AFTER THE CHECKPOINT, NOT AT IT. If the `through + 1` boundary is changed to
// `through`, a resumed read re-scans the last block and returns the same transfer twice. This is a real answer
// change, so it is the load-bearing line tested here.
// Run: node tools/check-recovery-read-teeth.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { readRecovery } from "../src/xmr-arrival.mjs";
import { addressFromKeys } from "../engine/monero/address.js";
import {
  amountMaskCommitment, bytesToHex, derivedOutputKey, hashToScalar, hexToBytes, keyDerivation,
  scalarToBytesLE, varint,
} from "../engine/monero/scan.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(ROOT, "src/xmr-arrival.mjs");
const temp = mkdtempSync(join(tmpdir(), "sdk-recovery-read-"));
const mutantPath = join(temp, "xmr-arrival.mjs");
const source = readFileSync(sourcePath, "utf8");
const guard = "for (let height = through ? through.height + 1 : fromHeight; height <= top; height += 1) {";
const parentGuard = "if (previousHash && (!block.parent || normalizedHash(block.parent) !== previousHash)) throw new Error(\"reorg\");";
if (!source.includes(guard) || !source.includes(parentGuard)) throw new Error("the resume or parent guard moved; update this teeth check");
const mutantSource = source
  .replace('from "./errors.mjs"', `from "${pathToFileURL(join(ROOT, "src/errors.mjs")).href}"`)
  .replace('from "./engine.mjs"', `from "${pathToFileURL(join(ROOT, "src/engine.mjs")).href}"`)
  .replace('from "./witness-slice.mjs"', `from "${pathToFileURL(join(ROOT, "src/witness-slice.mjs")).href}"`)
  .replace(guard, "for (let height = through ? through.height + 0 : fromHeight; height <= top; height += 1) {")
  .replace(parentGuard, "if (false) throw new Error(\"reorg\");");
writeFileSync(mutantPath, mutantSource, "utf8");

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
const TX = { 6: "a".repeat(64), 9: "b".repeat(64) };
const TXS = { 6: { [TX[6]]: fixture(100_000_000_000n) }, 9: { [TX[9]]: fixture(200_000_000_000n) } };
const daemon = ({ failAt: initialFailAt = null } = {}) => {
  let failAt = initialFailAt;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info") return { ok: true, json: async () => ({ result: { height: 11, synchronized: true, nettype: "stagenet" } }) };
    if (body.method === "get_block") {
      const height = Number(body.params.height);
      if (height === failAt) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ result: { block_header: { height, hash: H(height), prev_hash: H(height - 1), num_txes: TXS[height] ? 1 : 0 }, tx_hashes: TXS[height] ? Object.keys(TXS[height]) : [] } }) };
    }
    if (new URL(url).pathname.endsWith("/get_transaction_pool_hashes")) return { ok: true, json: async () => ({ tx_hashes: [] }) };
    if (new URL(url).pathname.endsWith("/get_transactions")) {
      const hashes = body.txs_hashes || [];
      const height = Object.keys(TXS).find((h) => TXS[h][hashes[0]]);
      return { ok: true, json: async () => ({ txs: hashes.map((hash) => ({ tx_hash: hash, block_height: Number(height), confirmations: 3, in_pool: false })), txs_as_json: hashes.map((hash) => JSON.stringify(TXS[height][hash])) }) };
    }
    return { ok: false, status: 404 };
  };
  return { fetch, setFailAt: (value) => { failAt = value; } };
};
const request = (fetch, checkpoint) => ({ node: { url: "https://one.example", operator: "one" },
  address: ADDRESS, viewSecret: VIEW, spendPub: SPEND_PUB, fromHeight: 5, fetch, checkpoint });
const memoryCheckpoint = () => { let saved = null; return { read: () => saved, save: (value) => { saved = structuredClone(value); }, get value() { return saved; } }; };

// A real interrupted read gives a checkpoint with one transfer and `through` at block 7.
const firstDaemon = daemon({ failAt: 7 });
const checkpoint = memoryCheckpoint();
const first = await readRecovery(request(firstDaemon.fetch, checkpoint));
if (first.complete !== false || first.transfers.length !== 1) throw new Error("the setup read did not interrupt");
const savedCheckpoint = structuredClone(checkpoint.value);
firstDaemon.setFailAt(null);
const resumed = await readRecovery(request(firstDaemon.fetch, checkpoint));
if (resumed.complete !== true || resumed.transfers.length !== 2) throw new Error("the original resume is broken");

let mutant;
try {
  mutant = await import(pathToFileURL(mutantPath).href + "?v=" + process.pid);
  const mutantResume = await mutant.readRecovery(request(firstDaemon.fetch, memoryCheckpointFrom(savedCheckpoint)));
  if (!(mutantResume.complete === true && mutantResume.transfers.length > resumed.transfers.length)) {
    throw new Error("removing the +1 resume boundary did not change the answer: the check is not load-bearing");
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log("  ok    removing the resume boundary changes the answer");
console.log("recovery read teeth: the checkpoint boundary is load-bearing");

function memoryCheckpointFrom(value) {
  let saved = structuredClone(value);
  return { read: () => saved, save: (next) => { saved = structuredClone(next); } };
}
