#!/usr/bin/env node
// THE PRIMARY RECOVERY READ: CHECKPOINT, PROGRESS, RESUME AND THE INCOMPLETE ANSWER.
//
// A fake daemon is the only way to interrupt at every boundary and to move a block hash. The live-node smoke lives
// in the nightly job; this check is deterministic.
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { readRecovery } from "../src/xmr-arrival.mjs";
import { addressFromKeys } from "../engine/monero/address.js";
import {
  amountMaskCommitment, bytesToHex, derivedOutputKey, hashToScalar, hexToBytes, keyDerivation,
  scalarToBytesLE, varint,
} from "../engine/monero/scan.js";

const G = ed25519.Point.BASE;
const VIEW = 11n;
const SPEND = 13n;
const R = 17n;
const SPEND_PUB = G.multiply(SPEND).toHex();
const VIEW_PUB = G.multiply(VIEW).toHex();
const ADDRESS = addressFromKeys({ network: "stagenet", kind: "primary", spendPub: SPEND_PUB, viewPub: VIEW_PUB }, { keccak256 });
const le8 = (value) => { const out = new Uint8Array(8); let v = BigInt(value); for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; } return out; };
const xor = (bytes, factor) => bytes.map((byte, i) => byte ^ (factor[i] || 0));
const factor = (label, scalarLE) => {
  const name = new TextEncoder().encode(label);
  const buf = new Uint8Array(name.length + scalarLE.length);
  buf.set(name); buf.set(scalarLE, name.length);
  return keccak256(buf);
};
const fixture = (amount, index = 0) => {
  const txPublicKey = G.multiply(R).toHex();
  const derivation = keyDerivation(txPublicKey, VIEW);
  const scalarLE = scalarToBytesLE(hashToScalar(derivation, varint(index)));
  const amountCipher = xor(Array.from(le8(amount)), factor("amount", scalarLE));
  const mask = hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
  const outPk = amountMaskCommitment(amount, mask);
  const key = derivedOutputKey(derivation, index, SPEND_PUB);
  return { version: 2, unlock_time: 0, extra: [1, ...hexToBytes(txPublicKey)],
    vout: [{ amount: 0, target: { tagged_key: { key, view_tag: "00" } } }],
    rct_signatures: { type: 6, ecdhInfo: [{ amount: bytesToHex(Uint8Array.from(amountCipher)) }], outPk: [outPk] } };
};
const H = (height) => (height < 0 ? "00" : height.toString(16).padStart(2, "0")).repeat(32);
const TX = { 6: "a".repeat(64), 9: "b".repeat(64) };
const TXS = { 6: { [TX[6]]: fixture(100_000_000_000n) }, 9: { [TX[9]]: fixture(200_000_000_000n) } };

function daemon({ failAt: initialFailAt = null, shortAt = null, hashShift: initialHashShift = 0, nullConfirmations = false } = {}) {
  const calls = [];
  let failAt = initialFailAt, hashShift = initialHashShift;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const path = new URL(url).pathname;
    calls.push({ path, method: body.method, height: body.params && body.params.height });
    if (body.method === "get_info") return { ok: true, json: async () => ({ result: { height: 11, synchronized: true, nettype: "stagenet" } }) };
    if (body.method === "get_block") {
      const height = Number(body.params.height);
      if (failAt === height) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ result: { block_header: {
        height, hash: H(height + hashShift), prev_hash: H(height - 1 + hashShift), num_txes: TXS[height] ? 1 : 0,
      }, tx_hashes: TXS[height] ? Object.keys(TXS[height]) : [] } }) };
    }
    if (path.endsWith("/get_transactions")) {
      const hashes = body.txs_hashes || [];
      const height = Object.keys(TXS).find((h) => TXS[h][hashes[0]]);
      if (shortAt === Number(height)) return { ok: true, json: async () => ({ txs: [], txs_as_json: [] }) };
      return { ok: true, json: async () => ({
        txs: hashes.map((hash) => ({ tx_hash: hash, block_height: Number(height), confirmations: nullConfirmations ? null : 3, in_pool: false })),
        txs_as_json: hashes.map((hash) => JSON.stringify(TXS[height][hash] || {})),
      }) };
    }
    return { ok: false, status: 404 };
  };
  return { fetch, calls, setFailAt: (value) => { failAt = value; }, setHashShift: (value) => { hashShift = value; } };
}

const request = (fetch, checkpoint = null, extra = {}) => ({ node: { url: "https://one.example", operator: "one" },
  address: ADDRESS, viewSecret: VIEW, spendPub: SPEND_PUB, fromHeight: 5, fetch, checkpoint, ...extra });
const memoryCheckpoint = () => { let saved = null; return { read: () => saved, save: (value) => { saved = structuredClone(value); }, discard: () => { saved = null; }, get value() { return saved; } }; };
const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (condition) console.log("  ok    " + message); else problems.push(message); };

const coldDaemon = daemon();
const coldCheckpoint = memoryCheckpoint();
const progress = [];
const cold = await readRecovery(request(coldDaemon.fetch, coldCheckpoint, { onProgress: (event) => progress.push(event) }));
check(cold.complete === true, "a full read is complete");
check(cold.transfers.length === 2, "every matching transfer is returned");
check(cold.transfers.map((t) => t.amountAtomic).sort().join(",") === "100000000000,200000000000", "the transfer amounts are correct");
check(cold.through && cold.through.height === 10 && cold.through.hash === H(10), "the checkpoint ends at the verified head");
check(coldCheckpoint.value && coldCheckpoint.value.through.height === 10, "the caller checkpoint is saved");
check(progress.length >= 7 && progress.at(-1).blocksVerified === 6 && progress.at(-1).blocksTotal === 6,
  "progress reports every block and the total");
check(coldDaemon.calls.filter((c) => c.method === "get_block").map((c) => c.height).join(",") === "5,6,7,8,9,10",
  "the primary node is read in order");

// A failure at block 8 leaves a checkpoint at 7; the retry reads only 8..10 and produces the same answer.
const interruptedDaemon = daemon({ failAt: 8 });
const interruptedCheckpoint = memoryCheckpoint();
const first = await readRecovery(request(interruptedDaemon.fetch, interruptedCheckpoint));
check(first.complete === false && first.through.height === 7, "an interrupted read keeps the last complete prefix");
check(first.transfers.length === 1, "the prefix exports the transfer it already found");
interruptedDaemon.setFailAt(null);
const retryCalls = [];
const retryFetch = async (url, init) => { retryCalls.push(JSON.parse(init.body).params?.height); return interruptedDaemon.fetch(url, init); };
const resumed = await readRecovery(request(retryFetch, interruptedCheckpoint));
check(resumed.complete === true && resumed.transfers.length === 2, "the retry completes the same range");
check(!retryCalls.includes(5) && !retryCalls.includes(6) && retryCalls.includes(8) && retryCalls.includes(9) && retryCalls.includes(10), "the retry resumes after the checkpoint");

// Every block boundary is resumable, not only the one used above.
for (const failAt of [5, 6, 7, 8, 9, 10]) {
  const boundary = daemon({ failAt });
  const boundaryCheckpoint = memoryCheckpoint();
  const first = await readRecovery(request(boundary.fetch, boundaryCheckpoint));
  check(first.complete === false, `a failure at block ${failAt} leaves the read incomplete`);
  boundary.setFailAt(null);
  const resumedAtBoundary = await readRecovery(request(boundary.fetch, boundaryCheckpoint));
  check(resumedAtBoundary.complete === true && resumedAtBoundary.transfers.length === 2,
    `resume after block ${failAt} returns the full set`);
}

// A resume whose anchor fetch fails keeps the last complete prefix instead of throwing it away.
{
  const anchorDaemon = daemon({ failAt: 8 });
  const anchorCheckpoint = memoryCheckpoint();
  await readRecovery(request(anchorDaemon.fetch, anchorCheckpoint));
  anchorDaemon.setFailAt(7);
  const kept = await readRecovery(request(anchorDaemon.fetch, anchorCheckpoint));
  check(kept.complete === false && kept.transfers.length === 1 && kept.through && kept.through.height === 7
    && kept.checkpoint !== null, "a failed anchor fetch keeps the verified prefix");
}

// A moved anchor is not trusted. The read discards it and starts at fromHeight again.
const reorgDaemon = daemon();
const reorgCheckpoint = memoryCheckpoint();
reorgCheckpoint.save(structuredClone(coldCheckpoint.value));
reorgDaemon.setHashShift(100);
const reorgCalls = [];
const reorgFetch = async (url, init) => { reorgCalls.push(JSON.parse(init.body).params?.height); return reorgDaemon.fetch(url, init); };
const reorged = await readRecovery(request(reorgFetch, reorgCheckpoint));
check(reorged.complete === true && reorged.transfers.length === 2, "a moved anchor is replayed from the start");
check(reorgCalls.includes(5), "the replay starts at fromHeight");
check(reorgCheckpoint.value.through.hash === H(110), "the checkpoint is replaced with the new anchor");

// A digest that does not describe its own contents is not trusted either.
const badCheckpoint = memoryCheckpoint();
badCheckpoint.save({ ...structuredClone(coldCheckpoint.value), digest: "0".repeat(64) });
const badDaemon = daemon();
const badRead = await readRecovery(request(badDaemon.fetch, badCheckpoint));
check(badRead.complete === true && badDaemon.calls.some((c) => c.method === "get_block" && c.height === 5),
  "a bad digest forces a replay");

// A missing confirmation count is not a mined transfer with zero confirmations.
{
  const nullRead = await readRecovery(request(daemon({ nullConfirmations: true }).fetch));
  check(nullRead.complete === true && nullRead.transfers.length === 2
    && nullRead.transfers.map((transfer) => transfer.confirmations).sort((a, b) => a - b).join(",") === "2,5",
    "a null confirmation count falls back to the block position, not zero");
}

// A short transaction body is unknown, never an empty range.
const short = await readRecovery(request(daemon({ shortAt: 6 }).fetch));
check(short.complete === false && short.transfers.length === 0, "a short transaction body makes the read incomplete");

// A request that stops advancing is bounded by the idle timeout; a long walk is not bounded by a total timer.
{
  const base = daemon();
  const stalled = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info") return base.fetch(url, init);
    if (body.method === "get_block") {
      return new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error("test-timeout"), { name: "AbortError" })), 200);
        init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
      });
    }
    return base.fetch(url, init);
  };
  const result = await readRecovery(request(stalled, null, { idleTimeoutMs: 20 }));
  check(result.complete === false && result.failed.some((failure) => failure.code === "timeout"),
    "a stalled request times out without a total-walk bound");
}

// An already-cancelled caller does not read the chain.
const controller = new AbortController(); controller.abort();
const cancelled = await readRecovery(request(daemon().fetch, null, { signal: controller.signal }));
check(cancelled.complete === false && cancelled.transfers.length === 0, "a cancelled read is unknown, not empty");

if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log("recovery read: FAILED (" + problems.length + ")");
  process.exit(1);
}
console.log("recovery read: " + checks + " checks passed");
