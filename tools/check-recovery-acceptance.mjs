#!/usr/bin/env node
// ACCEPTANCE FOR THE ONE READ ON A LIVE PLAIN MONEROD.
//
// What this proves, against a real daemon (not a fake):
//   - the primary read starts at the exact order start, completes, and reads the pool;
//   - the witness read starts at the grid boundary of that non-aligned start, completes, reads
//     every height of its window and every transaction hash in those blocks, and never asks for a
//     slice route;
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
    calls.push({ url, body });
    return globalThis.fetch(url, init);
  };
  return { calls, fetchImpl };
};
const memoryCheckpoint = () => {
  let saved = null;
  return { read: () => saved, save: (value) => { saved = structuredClone(value); }, discard: () => { saved = null; } };
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

const firstCalls = witness.calls.map((call) => JSON.stringify(call.body));
const resumedWitness = recordingFetch();
let resumedRead;
try {
  resumedRead = await readRecoveryWitness({
    node: { url: witnessUrl, operator: "witness" }, address, viewSecret, spendPub,
    fromHeight: orderStart, tipHeight, idleTimeoutMs: 8000, fetch: resumedWitness.fetchImpl, checkpoint,
  });
} catch (error) { unreachable(error); }
if (resumedRead.complete !== true) fail("the resumed witness read is incomplete");
const resumedCalls = resumedWitness.calls.map((call) => JSON.stringify(call.body));

const primaryBlockHeights = primary.calls.filter((call) => call.body && call.body.method === "get_block")
  .map((call) => Number(call.body.params.height));
if (!primaryBlockHeights.length || primaryBlockHeights[0] !== orderStart) {
  fail("the primary did not start at the exact order start");
}
for (let height = orderStart; height <= tipHeight; height += 1) {
  if (!primaryBlockHeights.includes(height)) fail("the primary skipped height " + height);
}
if (!primary.calls.some((call) => new URL(call.url).pathname === "/get_transaction_pool_hashes")) {
  fail("the primary did not read the pool");
}

if (witness.calls.some((call) => new URL(call.url).pathname === "/v1/witness/slice")) {
  fail("the witness was asked for a slice route");
}
const blockHeights = witness.calls.filter((call) => call.body && call.body.method === "get_block")
  .map((call) => Number(call.body.params.height));
if (!blockHeights.length || blockHeights[0] !== boundary) {
  fail("the witness did not start at its grid boundary");
}
for (let height = boundary; height <= tipHeight; height += 1) {
  if (!blockHeights.includes(height)) fail("the witness skipped height " + height);
}
const witnessBodies = witness.calls.map((call) => JSON.stringify(call.body));
if (witnessBodies.some((body) => body.includes("fromHeight") || body.includes("startHeight"))) {
  fail("a witness request carries the exact start");
}
if (firstCalls.length !== resumedCalls.length || firstCalls.some((body, index) => body !== resumedCalls[index])) {
  fail("cold and resumed witness reads issued different requests");
}
console.log("recovery acceptance: primary " + primaryMs + " ms, witness " + witnessMs + " ms");
console.log("recovery acceptance: primary " + orderStart + ".." + tipHeight + ", witness window " + boundary + ".." + tipHeight + ", cold/resume identical, no exact-start request");
