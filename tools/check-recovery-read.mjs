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
const fixture = (amount, index = 0, r = R) => {
  const txPublicKey = G.multiply(r).toHex();
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
const TX = { 6: "a".repeat(64), 7: "e".repeat(64), 9: "b".repeat(64), 8: "d".repeat(64) };
const FUNDING_6 = fixture(100_000_000_000n);
const FUNDING_6_KEY = FUNDING_6.vout[0].target.tagged_key.key;
const FUNDING_9 = fixture(200_000_000_000n, 0, R + 1n);
const FUNDING_9_KEY = FUNDING_9.vout[0].target.tagged_key.key;
const SPENT_IMAGE = "ab".repeat(32);
const UNSPENT_IMAGE = "cd".repeat(32);
const POOL_CONFIRMS = "ff".repeat(32);
const POOL_CONFIRMS_TX = fixture(50_000_000_000n, 0, R + 2n);
const LATE = "12".repeat(32);
const LATE_TX = fixture(50_000_000_000n, 0, R + 3n);
const LATE_KEY = LATE_TX.vout[0].target.tagged_key.key;
const LATE_IMAGE = "ee".repeat(32);
const TXS = {
  6: { [TX[6]]: FUNDING_6 },
  7: { [TX[7]]: { version: 2, unlock_time: 0, extra: [], vin: [{ key: { k_image: SPENT_IMAGE } }], vout: [], rct_signatures: { type: 6, ecdhInfo: [], outPk: [] } } },
  9: { [TX[9]]: FUNDING_9 },
};

function daemon({ failAt: initialFailAt = null, shortAt = null, hashShift: initialHashShift = 0, nullConfirmations = false, poolHashes = [], poolTxs = {}, poolFails = false, topHeight: initialTopHeight = 11, spentStatuses = null } = {}) {
  const calls = [];
  let failAt = initialFailAt, hashShift = initialHashShift, topHeight = initialTopHeight, poolList = [...poolHashes];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const path = new URL(url).pathname;
    calls.push({ path, method: body.method, height: body.params && body.params.height });
    if (body.method === "get_info") return { ok: true, json: async () => ({ result: { height: topHeight, synchronized: true, nettype: "stagenet" } }) };
    if (body.method === "get_block") {
      const height = Number(body.params.height);
      if (failAt === height) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ result: { block_header: {
        height, hash: H(height + hashShift), prev_hash: H(height - 1 + hashShift), num_txes: TXS[height] ? 1 : 0,
      }, tx_hashes: TXS[height] ? Object.keys(TXS[height]) : [] } }) };
    }
    if (path.endsWith("/get_transaction_pool_hashes")) return poolFails ? { ok: false, status: 503 } : { ok: true, json: async () => ({ tx_hashes: poolList }) };
    if (path.endsWith("/is_key_image_spent")) {
      const images = body.key_images || [];
      return { ok: true, json: async () => ({ status: "OK", spent_status: images.map((image) =>
        spentStatuses && Object.prototype.hasOwnProperty.call(spentStatuses, image) ? spentStatuses[image] : (image === SPENT_IMAGE ? 1 : 0)) }) };
    }
    if (path.endsWith("/get_transactions")) {
      const hashes = body.txs_hashes || [];
      const height = Object.keys(TXS).find((h) => TXS[h][hashes[0]]);
      const inPool = height === undefined;
      const source = inPool ? poolTxs : TXS[height];
      if (!inPool && shortAt === Number(height)) return { ok: true, json: async () => ({ txs: [], txs_as_json: [] }) };
      return { ok: true, json: async () => ({
        txs: hashes.map((hash) => ({ tx_hash: hash, block_height: inPool ? null : Number(height), confirmations: inPool ? 0 : (nullConfirmations ? null : 3), in_pool: inPool })),
        txs_as_json: hashes.map((hash) => JSON.stringify(source[hash] || {})),
      }) };
    }
    return { ok: false, status: 404 };
  };
  return { fetch, calls, setFailAt: (value) => { failAt = value; }, setHashShift: (value) => { hashShift = value; }, setTopHeight: (value) => { topHeight = value; }, setPoolHashes: (value) => { poolList = [...value]; } };
}

const request = (fetch, checkpoint = null, extra = {}) => ({ node: { url: "https://one.example", operator: "one" },
  address: ADDRESS, viewSecret: VIEW, spendPub: SPEND_PUB, fromHeight: 5, fetch, checkpoint, ...extra });
const memoryCheckpoint = () => { let saved = null; return { read: () => saved, save: (value) => { saved = structuredClone(value); }, discard: () => { saved = null; }, get value() { return saved; } }; };
const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (condition) console.log("  ok    " + message); else problems.push(message); };

// A CLOSED WINDOW STOPS AT ITS END. The read does not walk to the tip and does not ask the pool after the window.
{
  const d = daemon({ topHeight: 11, poolHashes: [LATE], nullConfirmations: true });
  const windowed = await readRecovery(request(d.fetch, null, { toHeight: 7 }));
  const heights = d.calls.filter((entry) => entry.method === "get_block").map((entry) => Number(entry.height));
  check(windowed.complete === true && windowed.toHeight === 7 && windowed.through && windowed.through.height === 7,
    "a closed window did not stop at its end");
  check(heights.length === 3 && heights[0] === 5 && heights[1] === 6 && heights[2] === 7,
    `a closed window walked beyond its end: ${heights.join(",")}`);
  check(!d.calls.some((entry) => entry.path.endsWith("/get_transaction_pool_hashes")),
    "a closed window read the pool after its end");
  check(windowed.transfers.length === 1 && windowed.transfers[0].height === 6,
    "a closed window did not return the transfer inside it");
  check(windowed.transfers[0].confirmations === 5,
    `a closed window counted confirmations from its own end: ${windowed.transfers[0].confirmations}`);
}

// A THROWING CALLER CALLBACK IS NOT A NODE FAILURE. It rejects the read and names the callback; it must not be
// returned as a daemon failure in `failed`.
{
  let progressError = null;
  try {
    await readRecovery(request(daemon().fetch, null, { onProgress: () => { throw new Error("ui bug"); } }));
  } catch (error) { progressError = error; }
  check(progressError && progressError.code === "bad-input" && progressError.params.field === "onProgress",
    "a throwing onProgress rejects the read as a caller error");
}
{
  let saveError = null;
  const badCheckpoint = { read: () => null, save: () => { throw new Error("store bug"); } };
  try {
    await readRecovery(request(daemon().fetch, badCheckpoint));
  } catch (error) { saveError = error; }
  check(saveError && saveError.code === "bad-input" && saveError.params.field === "checkpoint.save",
    "a throwing checkpoint.save rejects the read as a caller error");
}



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

// Key images from sweep.keyImages make a spend and the available remainder local.
{
  const spendCheckpoint = memoryCheckpoint();
  const spendRead = await readRecovery(request(daemon().fetch, spendCheckpoint, {
    keyImages: [{ keyImage: SPENT_IMAGE, outputKey: FUNDING_6_KEY }, { keyImage: UNSPENT_IMAGE, outputKey: FUNDING_9_KEY }],
  }));
  check(spendRead.complete === true && spendRead.spends.length === 1
    && spendRead.spends[0].keyImage === SPENT_IMAGE && spendRead.spends[0].height === 7,
    "a funding output's key image in a block input is reported as a spend");
  check(spendRead.availableAtomic === "200000000000", "the spent output is excluded from the available remainder");
  check(spendCheckpoint.value.spends.length === 1, "the spend is stored in the checkpoint");
}

// A withdrawal in the fresh pool is a spend even when the block height did not move.
{
  const poolSpend = "ef".repeat(32);
  const poolRead = await readRecovery(request(daemon({
    poolHashes: [poolSpend],
    poolTxs: { [poolSpend]: { version: 2, unlock_time: 0, extra: [], vin: [{ key: { k_image: UNSPENT_IMAGE } }], vout: [], rct_signatures: { type: 6, ecdhInfo: [], outPk: [] } } },
  }).fetch, null, {
    keyImages: [{ keyImage: SPENT_IMAGE, outputKey: FUNDING_6_KEY }, { keyImage: UNSPENT_IMAGE, outputKey: FUNDING_9_KEY }],
  }));
  check(poolRead.spends.some((spend) => spend.keyImage === UNSPENT_IMAGE && spend.pool === true),
    "a pool input is reported as a pool spend");
  check(poolRead.availableAtomic === "0", "a pool spend is excluded from the available remainder");
}

// A failed pool read is unknown about the mempool, never an empty pool.
{
  const poolFailed = await readRecovery(request(daemon({ poolFails: true }).fetch));
  check(poolFailed.complete === false && poolFailed.failed.some((failure) => failure.why === "pool-read"),
    "a failed pool read makes the answer incomplete");
}

// A pool transfer must not be persisted: after it confirms, the resume must return it once, not twice.
{
  const poolDaemon = daemon({ topHeight: 8, poolHashes: [POOL_CONFIRMS], poolTxs: { [POOL_CONFIRMS]: POOL_CONFIRMS_TX } });
  const poolCheckpoint = memoryCheckpoint();
  const poolFirst = await readRecovery(request(poolDaemon.fetch, poolCheckpoint));
  check(poolFirst.transfers.some((transfer) => transfer.txid === POOL_CONFIRMS && transfer.pool === true),
    "a pool transfer is returned before its block");
  check(poolCheckpoint.value.transfers.every((transfer) => transfer.pool !== true),
    "the pool transfer is not stored in the checkpoint");
  TXS[8] = { [POOL_CONFIRMS]: POOL_CONFIRMS_TX };
  poolDaemon.setTopHeight(11);
  poolDaemon.setPoolHashes([]);
  const poolResumed = await readRecovery(request(poolDaemon.fetch, poolCheckpoint));
  delete TXS[8];
  check(poolResumed.transfers.filter((transfer) => transfer.txid === POOL_CONFIRMS).length === 1,
    "a pool transfer that confirms after the checkpoint is returned once");
}

// A transfer that arrives after a withdrawal is found by the next read; the spent output stays out of the
// available remainder.
{
  const lateDaemon = daemon({ topHeight: 10 });
  const lateCheckpoint = memoryCheckpoint();
  const before = await readRecovery(request(lateDaemon.fetch, lateCheckpoint, {
    keyImages: [{ keyImage: SPENT_IMAGE, outputKey: FUNDING_6_KEY }, { keyImage: UNSPENT_IMAGE, outputKey: FUNDING_9_KEY }],
  }));
  check(before.complete === true && before.availableAtomic === "200000000000",
    "the withdrawal leaves only the unspent funding output available");
  TXS[10] = { [LATE]: LATE_TX };
  lateDaemon.setTopHeight(11);
  const after = await readRecovery(request(lateDaemon.fetch, lateCheckpoint, {
    keyImages: [{ keyImage: SPENT_IMAGE, outputKey: FUNDING_6_KEY }, { keyImage: UNSPENT_IMAGE, outputKey: FUNDING_9_KEY },
      { keyImage: LATE_IMAGE, outputKey: LATE_KEY }],
  }));
  delete TXS[10];
  check(after.complete === true && after.transfers.some((transfer) => transfer.txid === LATE),
    "a transfer that arrives after the withdrawal is found by the next read");
  check(after.availableAtomic === "250000000000",
    "the late transfer is available while the withdrawn output stays excluded (" + after.availableAtomic + ")");
}

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

// A RESUME AT A LATER TIP RECOMPUTES CONFIRMATIONS; A DIFFERENT KEY-IMAGE SET REPLAYS FROM THE START.
{
  const d = daemon({ topHeight: 11, nullConfirmations: true });
  const c = memoryCheckpoint();
  const firstRead = await readRecovery(request(d.fetch, c));
  d.setTopHeight(21);
  const later = await readRecovery(request(d.fetch, c));
  const transfer = later.transfers.find((entry) => entry.height === 6);
  check(firstRead.complete && later.complete && transfer && transfer.confirmations === 15,
    `a resumed read kept the old confirmation count: ${transfer && transfer.confirmations}`);
  const images = [{ keyImage: SPENT_IMAGE, outputKey: FUNDING_6_KEY }];
  const withImages = memoryCheckpoint();
  await readRecovery(request(d.fetch, withImages));
  const before = d.calls.filter((entry) => entry.method === "get_block").map((entry) => Number(entry.height));
  const changed = await readRecovery(request(d.fetch, withImages, { keyImages: images }));
  const after = d.calls.filter((entry) => entry.method === "get_block").map((entry) => Number(entry.height)).slice(before.length);
  check(changed.complete === true && after.includes(5) && after.includes(20),
    "a different key-image set reused a checkpoint written without it");
}

// THE TRUSTED NODE'S SPENT ANSWER MAKES THE WINDOW TOTALS. A partly spent window is not "withdrawn"; an unreadable
// answer is unknown, never "unspent".
{
  const keyImages = [{ keyImage: SPENT_IMAGE, outputKey: FUNDING_6_KEY }, { keyImage: UNSPENT_IMAGE, outputKey: FUNDING_9_KEY }];
  const partial = await readRecovery(request(daemon().fetch, null, { keyImages }));
  check(partial.receivedAtomic === "300000000000" && partial.spentAtomic === "100000000000"
    && partial.unspentAtomic === "200000000000" && partial.withdrawalState === "partly-withdrawn",
    "a partly spent window did not report its spent and unspent amounts");
  const allSpent = await readRecovery(request(daemon({ spentStatuses: { [SPENT_IMAGE]: 1, [UNSPENT_IMAGE]: 1 } }).fetch,
    null, { keyImages }));
  check(allSpent.withdrawalState === "withdrawn" && allSpent.unspentAtomic === "0",
    "a fully spent window was not withdrawn");
  const broken = await readRecovery(request(daemon({ spentStatuses: { [SPENT_IMAGE]: 9, [UNSPENT_IMAGE]: 0 } }).fetch,
    null, { keyImages }));
  check(broken.complete === false && broken.withdrawalState === "unknown" && broken.receivedAtomic === null
    && broken.failed.some((failure) => failure.why === "spent-status"),
    "an unreadable spent answer was accepted as unspent");
}

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

// A fake clock makes the per-request abort controllable: an advancing read never trips a total bound, while a
// stalled request is aborted by its own idle signal.
{
  const originalTimeout = AbortSignal.timeout;
  const pending = [];
  AbortSignal.timeout = (ms) => {
    const controller = new AbortController();
    pending.push({ ms, controller });
    return controller.signal;
  };
  try {
    const advancing = await readRecovery(request(daemon().fetch));
    check(advancing.complete === true && pending.length > 0,
      "a fake clock lets an advancing read finish without a total-walk bound");
    const base = daemon();
    const stalled = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method !== "get_block") return base.fetch(url, init);
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("idle-timeout"), { name: "AbortError" }));
        }, { once: true });
      });
    };
    const reading = readRecovery(request(stalled, null, { idleTimeoutMs: 20 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.at(-1).controller.abort();
    const stalledRead = await reading;
    check(stalledRead.complete === false && stalledRead.failed.some((failure) => failure.code === "timeout"),
      "the fake clock aborts only the stalled request");
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
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
