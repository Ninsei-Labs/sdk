#!/usr/bin/env node
// ACCEPTANCE FOR THE ONE READ ON A LIVE PLAIN MONEROD.
//
// What this proves, against a real daemon (not a fake):
//   - the primary read starts at the exact order start, completes, and reads the pool;
//   - the witness read starts at the grid boundary of that non-aligned start, completes, reads
//     every height of its window and, when the window contains transactions, every transaction
//     hash in those blocks; it never asks for a slice route;
//   - the witness requests do not carry the exact start as a separate parameter;
//   - a cold witness read and a resume of the same window issue the same request sequence.
//
// It does not prove a browser exchange with a third-party operator; that recorded run stays the manual
// acceptance step. Set RECOVERY_LIVE_PRIMARY and RECOVERY_LIVE_WITNESS to two plain monerod URLs.
//
// Run:
//   RECOVERY_LIVE_PRIMARY=http://127.0.0.1:38281 \
//   RECOVERY_LIVE_WITNESS=http://127.0.0.1:38281 \
//   node tools/check-recovery-acceptance.mjs
import { readRecovery, readRecoveryWitness } from "../src/xmr-arrival.mjs";
import { fromSeed } from "../engine/monero/keys.js";
import { addressFromKeys } from "../engine/monero/address.js";
import { keccak256 } from "../src/primitives.mjs";
import { WITNESS_SLICE_BLOCKS } from "../src/witness-slice.mjs";

const primaryUrl = process.env.RECOVERY_LIVE_PRIMARY;
const witnessUrl = process.env.RECOVERY_LIVE_WITNESS;
if (!primaryUrl || !witnessUrl) {
  console.log("recovery acceptance: skipped (set RECOVERY_LIVE_PRIMARY and RECOVERY_LIVE_WITNESS)");
  process.exit(0);
}
const GRID = WITNESS_SLICE_BLOCKS;
const fail = (message) => { console.error("recovery acceptance: FAILED - " + message); process.exit(1); };
const unreachable = (error) => {
  console.error("recovery acceptance: UNREACHABLE - " + (error && error.message ? error.message : error));
  process.exit(2);
};
const recordingFetch = () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    let body = null;
    try { body = JSON.parse(init.body); } catch { body = null; }
    const response = await globalThis.fetch(url, init);
    let payload = null;
    try { payload = await response.clone().json(); } catch { payload = null; }
    calls.push({ method: (init && init.method) || "GET", url: String(url), body, payload });
    return response;
  };
  return { calls, fetchImpl };
};
const memoryCheckpoint = () => {
  let saved = null;
  const counts = { reads: 0, saves: 0 };
  return {
    counts,
    read: () => { counts.reads += 1; return saved; },
    save: (value) => { counts.saves += 1; saved = structuredClone(value); },
    discard: () => { saved = null; },
    get value() { return saved; },
  };
};
const requestRecord = (call) => JSON.stringify({ method: call.method, url: call.url, body: call.body });
const absoluteHeights = (calls) => calls.filter((call) => call.body && call.body.method === "get_block")
  .map((call) => Number(call.body.params.height));
const noExactStart = (calls, label) => {
  const allowed = new Set(["/json_rpc", "/get_transactions"]);
  for (const call of calls) {
    const parsed = new URL(call.url);
    if (!allowed.has(parsed.pathname)) fail(label + " used an unexpected endpoint " + parsed.pathname);
    if (parsed.search) fail(label + " carries a query string");
    const text = JSON.stringify(call.body || {});
    if (/fromHeight|startHeight|start_height|orderStart/i.test(text)) {
      fail(label + " carries the exact start");
    }
  }
};
const infoOf = async (url) => {
  const response = await fetch(url.replace(/\/+$/, "") + "/json_rpc", {
    method: "POST", headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "accept", method: "get_info" }),
  });
  if (!response.ok) throw new Error("get_info answered HTTP " + response.status);
  const payload = await response.json();
  return payload.result;
};

const wallet = fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 21));
const address = process.env.RECOVERY_ACCEPTANCE_ADDRESS || addressFromKeys({
  network: process.env.RECOVERY_LIVE_NETWORK || "testnet",
  spendPub: Buffer.from(wallet.publicSpendKey).toString("hex"),
  viewPub: Buffer.from(wallet.publicViewKey).toString("hex"),
}, { keccak256 });
const viewSecret = process.env.RECOVERY_ACCEPTANCE_VIEW || Buffer.from(wallet.privateViewKey).toString("hex");
const spendPub = process.env.RECOVERY_ACCEPTANCE_SPEND || Buffer.from(wallet.publicSpendKey).toString("hex");
let primaryInfo, witnessInfo;
try {
  primaryInfo = await infoOf(primaryUrl);
  witnessInfo = await infoOf(witnessUrl);
} catch (error) { unreachable(error); }
const tipHeight = Math.min(Number(primaryInfo.height), Number(witnessInfo.height)) - 1;
const boundary = Math.floor(tipHeight / GRID) * GRID;
if (!Number.isSafeInteger(tipHeight) || tipHeight <= boundary) {
  unreachable("the stand has no non-aligned block inside a grid window");
}
const orderStart = Math.min(boundary + 3, tipHeight);
const primary = recordingFetch();
const primaryStarted = Date.now();
let primaryRead;
try {
  primaryRead = await readRecovery({
    node: { url: primaryUrl, operator: "primary" }, address, viewSecret, spendPub,
    fromHeight: orderStart, idleTimeoutMs: 8000, fetch: primary.fetchImpl,
  });
} catch (error) { unreachable(error); }
const primaryMs = Date.now() - primaryStarted;
if (primaryRead.complete !== true) fail("the primary read is incomplete");

const witness = recordingFetch();
const witnessStarted = Date.now();
const checkpoint = memoryCheckpoint();
let witnessRead;
try {
  witnessRead = await readRecoveryWitness({
    node: { url: witnessUrl, operator: "witness" }, address, viewSecret, spendPub,
    fromHeight: orderStart, tipHeight, idleTimeoutMs: 8000, fetch: witness.fetchImpl, checkpoint,
  });
} catch (error) { unreachable(error); }
const witnessMs = Date.now() - witnessStarted;
if (witnessRead.complete !== true) fail("the witness read is incomplete");

const resumedWitness = recordingFetch();
let resumedRead;
try {
  resumedRead = await readRecoveryWitness({
    node: { url: witnessUrl, operator: "witness" }, address, viewSecret, spendPub,
    fromHeight: orderStart, tipHeight, idleTimeoutMs: 8000, fetch: resumedWitness.fetchImpl, checkpoint,
  });
} catch (error) { unreachable(error); }
if (resumedRead.complete !== true) fail("the resumed witness read is incomplete");

const primaryTop = primaryRead.through && Number(primaryRead.through.height);
if (!Number.isSafeInteger(primaryTop) || primaryTop < orderStart) fail("the primary read has no completed span");
const expectedPrimaryHeights = [];
for (let height = orderStart; height <= primaryTop; height += 1) expectedPrimaryHeights.push(height);
const primaryBlockHeights = absoluteHeights(primary.calls);
if (JSON.stringify(primaryBlockHeights) !== JSON.stringify(expectedPrimaryHeights)) {
  fail("the primary did not request the exact range in order (expected " + expectedPrimaryHeights.join(",") + "; got " + primaryBlockHeights.join(",") + ")");
}
if (!primary.calls.some((call) => new URL(call.url).pathname === "/get_transaction_pool_hashes")) {
  fail("the primary did not read the pool");
}

noExactStart(witness.calls, "cold witness");
noExactStart(resumedWitness.calls, "resumed witness");
const expectedWitnessHeights = [];
for (let height = boundary; height <= tipHeight; height += 1) expectedWitnessHeights.push(height);
const blockHeights = absoluteHeights(witness.calls);
if (JSON.stringify(blockHeights) !== JSON.stringify(expectedWitnessHeights)) {
  fail("the witness did not request the exact window in order");
}
if (JSON.stringify(absoluteHeights(resumedWitness.calls)) !== JSON.stringify(expectedWitnessHeights)) {
  fail("the resumed witness did not request the exact window in order");
}

const blockTxs = new Set();
for (const call of witness.calls) {
  const result = call.payload && call.payload.result;
  const hashes = (result && (Array.isArray(result.tx_hashes) ? result.tx_hashes
    : (result.json && Array.isArray(result.json.tx_hashes) ? result.json.tx_hashes : []))) || [];
  for (const hash of hashes) blockTxs.add(hash);
}
if (blockTxs.size) {
  const requested = new Set();
  for (const call of witness.calls) {
    if (!call.body || !Array.isArray(call.body.txs_hashes)) continue;
    for (const hash of call.body.txs_hashes) requested.add(hash);
  }
  if (requested.size !== blockTxs.size || [...blockTxs].some((hash) => !requested.has(hash))) {
    fail("the witness did not request every transaction hash of the window");
  }
  console.log("recovery acceptance: checked " + blockTxs.size + " transaction hashes");
} else {
  console.log("recovery acceptance: the window has no transactions; hash coverage is vacuous");
}

const firstCalls = witness.calls.map(requestRecord);
const resumedCalls = resumedWitness.calls.map(requestRecord);
if (firstCalls.length !== resumedCalls.length || firstCalls.some((record, index) => record !== resumedCalls[index])) {
  fail("cold and resumed witness reads issued different requests");
}
if (checkpoint.counts.reads < 1 || checkpoint.counts.saves < 1 || !checkpoint.value
  || checkpoint.value.kind !== "witness" || checkpoint.value.grid !== GRID) {
  fail("the resumed read did not take a witness checkpoint");
}
console.log("recovery acceptance: primary " + primaryMs + " ms, witness " + witnessMs + " ms");
console.log("recovery acceptance: primary " + orderStart + ".." + primaryTop + ", witness window " + boundary + ".." + tipHeight + ", cold/resume records identical, no exact-start parameter");
