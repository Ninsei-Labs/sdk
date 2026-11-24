#!/usr/bin/env node
// THE PLAIN-MONEROD WITNESS READ. The witness must see the same whole windows whatever the exact start inside a
// window, must read every height and every transaction hash, and must not stop at the matching block. A short body
// is unknown, and a resume re-reads the whole window that contains the checkpoint.
// Run: node tools/check-recovery-witness.mjs
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { readRecovery, readRecoveryWitness } from "../src/xmr-arrival.mjs";
import { addressFromKeys } from "../engine/monero/address.js";
import {
  amountMaskCommitment, bytesToHex, derivedOutputKey, hashToScalar, hexToBytes, keyDerivation,
  scalarToBytesLE, varint,
} from "../engine/monero/scan.js";

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
const PAYOUT = "a".repeat(64), FILLER = "c".repeat(64);
const TXS = { 6: { [PAYOUT]: fixture(100_000_000_000n), [FILLER]: { version: 2, unlock_time: 0, extra: [], vout: [], rct_signatures: { type: 6, ecdhInfo: [], outPk: [] } } } };

function daemon({ failAt: initialFailAt = null, shortAt = null, hashShift: initialHashShift = 0, height = 11 } = {}) {
  const calls = [];
  let failAt = initialFailAt, hashShift = initialHashShift;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const path = new URL(url).pathname;
    calls.push({ path, method: body.method || null, height: body.params && body.params.height, hashes: body.txs_hashes || null });
    if (body.method === "get_info") return { ok: true, json: async () => ({ result: { height, synchronized: true, nettype: "stagenet" } }) };
    if (body.method === "get_block") {
      const height = Number(body.params.height);
      if (height === failAt) return { ok: false, status: 503 };
      const hashes = TXS[height] ? Object.keys(TXS[height]) : [];
      return { ok: true, json: async () => ({ result: { block_header: { height, hash: H(height + hashShift), prev_hash: H(height - 1 + hashShift), num_txes: hashes.length }, tx_hashes: hashes } }) };
    }
    if (path.endsWith("/get_transaction_pool_hashes")) return { ok: true, json: async () => ({ tx_hashes: [] }) };
    if (path.endsWith("/get_transactions")) {
      const hashes = body.txs_hashes || [];
      const height = Number(Object.keys(TXS).find((h) => TXS[h][hashes[0]]));
      if (height === shortAt) return { ok: true, json: async () => ({ txs: [], txs_as_json: [] }) };
      return { ok: true, json: async () => ({
        txs: hashes.map((hash) => ({ tx_hash: hash, block_height: height, confirmations: 3, in_pool: false })),
        txs_as_json: hashes.map((hash) => JSON.stringify(TXS[height][hash])),
      }) };
    }
    return { ok: false, status: 404 };
  };
  return { calls, fetch, setFailAt: (value) => { failAt = value; }, setHashShift: (value) => { hashShift = value; } };
}

const request = (fetch, checkpoint = null, extra = {}) => ({ node: { url: "https://witness.example", operator: "witness" },
  address: ADDRESS, viewSecret: VIEW, spendPub: SPEND_PUB, fromHeight: 5, tipHeight: 10, fetch, checkpoint, ...extra });
const memoryCheckpoint = () => { let saved = null; return { read: () => saved, save: (value) => { saved = structuredClone(value); }, discard: () => { saved = null; }, get value() { return saved; } }; };
const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (condition) console.log("  ok    " + message); else problems.push(message); };

const witness = daemon();
const cold = await readRecoveryWitness(request(witness.fetch));
check(cold.complete === true && cold.transfers.length === 1, "the whole fixed window is read and the transfer is returned");
const heights = witness.calls.filter((call) => call.method === "get_block").map((call) => call.height);
check(heights.join(",") === "0,1,2,3,4,5,6,7,8,9,10", "every height of the window is requested, including before the start");
check(heights.slice(heights.indexOf(6) + 1).join(",") === "7,8,9,10", "a matching transfer does not stop the window");
const txBatches = witness.calls.filter((call) => call.hashes);
check(txBatches.some((call) => call.hashes.includes(PAYOUT) && call.hashes.includes(FILLER)),
  "the transaction request carries every hash of the block, not only the payout");
check(witness.calls.every((call) => call.path !== "/v1/witness/slice"), "the plain daemon is never asked for a slice route");

{
  const closed = daemon();
  const verdict = await readRecoveryWitness(request(closed.fetch, null, { toHeight: 7 }));
  const requested = closed.calls.filter((call) => call.method === "get_block").map((call) => call.height);
  check(verdict.complete === true && verdict.toHeight === 7 && verdict.transfers.length === 1,
    "a closed witness window returns the transfer and completes");
  check(requested.join(",") === "0,1,2,3,4,5,6,7", `a closed witness window read past its end: ${requested.join(",")}`);
}

const sameWindow = daemon();
const inside = await readRecoveryWitness(request(sameWindow.fetch, null, { fromHeight: 6 }));
check(inside.complete === true && inside.transfers.length === 1, "a start inside the same window is read from the same window");
check(JSON.stringify(sameWindow.calls) === JSON.stringify(witness.calls),
  "two start heights inside one window produce the identical request sequence");

for (const [start, tip, expected] of [
  [19, 19, Array.from({ length: 20 }, (_, i) => i)],
  [20, 20, [20]],
  [21, 21, [20, 21]],
]) {
  const table = daemon({ height: tip + 1 });
  await readRecoveryWitness(request(table.fetch, null, { fromHeight: start, tipHeight: tip }));
  const requested = table.calls.filter((call) => call.method === "get_block").map((call) => call.height);
  check(requested.join(",") === expected.join(","), "the grid boundary is exact at height " + start);
}

const interrupted = daemon({ failAt: 8 });
const checkpoint = memoryCheckpoint();
const first = await readRecoveryWitness(request(interrupted.fetch, checkpoint));
check(first.complete === false && first.through && first.through.height === 7 && first.transfers.length === 1,
  "an interrupted witness read keeps the complete prefix");
interrupted.setFailAt(null);
const resumed = await readRecoveryWitness(request(interrupted.fetch, checkpoint));
check(checkpoint.value && checkpoint.value.kind === "witness" && checkpoint.value.grid === 20,
  "the witness checkpoint is marked as a grid record");
check(resumed.complete === true && resumed.transfers.length === 1, "the resumed witness read completes without duplicates");
{
  const firstBlock = daemon({ failAt: 8 });
  const firstBlockCheckpoint = memoryCheckpoint();
  await readRecoveryWitness(request(firstBlock.fetch, firstBlockCheckpoint));
  firstBlock.setFailAt(0);
  const kept = await readRecoveryWitness(request(firstBlock.fetch, firstBlockCheckpoint));
  check(kept.complete === false && kept.through && kept.through.height === 7 && kept.transfers.length === 1
    && kept.checkpoint !== null, "a resume whose first window block fails keeps the checkpoint prefix");
}
const resumedHeights = interrupted.calls.filter((call) => call.method === "get_block").map((call) => call.height);
check(resumedHeights.slice(-11).join(",") === "0,1,2,3,4,5,6,7,8,9,10",
  "the resume re-reads the whole window that contains the checkpoint");

const short = await readRecoveryWitness(request(daemon({ shortAt: 6 }).fetch));
check(short.complete === false && short.failed.length === 1, "a short transaction body makes the witness answer incomplete");

{
  const reorg = daemon({ failAt: 8 });
  const reorgCheckpoint = memoryCheckpoint();
  await readRecoveryWitness(request(reorg.fetch, reorgCheckpoint));
  reorg.setFailAt(null);
  reorg.setHashShift(100);
  const replayed = await readRecoveryWitness(request(reorg.fetch, reorgCheckpoint));
  check(replayed.complete === true && replayed.transfers.length === 1,
    "a reorganisation replays the whole window and returns the same transfer");
}

// A checkpoint from the other reader is not trusted; each read starts from its own boundary.
{
  const primary = daemon();
  const primaryCheckpoint = memoryCheckpoint();
  await readRecovery(request(primary.fetch, primaryCheckpoint));
  const witnessWithPrimary = daemon();
  const witnessVerdict = await readRecoveryWitness(request(witnessWithPrimary.fetch, primaryCheckpoint));
  check(witnessVerdict.complete === true
    && witnessWithPrimary.calls.filter((call) => call.method === "get_block").map((call) => call.height).join(",") === "0,1,2,3,4,5,6,7,8,9,10",
    "a primary checkpoint is ignored by the witness and starts at its grid boundary");
}
{
  const witnessOnly = daemon();
  const witnessCheckpoint = memoryCheckpoint();
  await readRecoveryWitness(request(witnessOnly.fetch, witnessCheckpoint));
  const primaryAgain = daemon();
  const primaryVerdict = await readRecovery(request(primaryAgain.fetch, witnessCheckpoint));
  check(primaryVerdict.complete === true
    && primaryAgain.calls.filter((call) => call.method === "get_block").map((call) => call.height).join(",") === "5,6,7,8,9,10",
    "a witness checkpoint is ignored by the primary read and starts at fromHeight");
}

const behind = await readRecoveryWitness(request(daemon().fetch, null, { tipHeight: 12 }));
check(behind.complete === false && behind.failed.some((failure) => failure.why === "witness-behind"),
  "a witness below the primary top is incomplete");

if (problems.length) {
  console.error("recovery witness: FAILED (" + problems.length + ")");
  for (const problem of problems) console.error("  FAIL  " + problem);
  process.exit(1);
}
console.log("recovery witness: " + checks + " checks passed");
