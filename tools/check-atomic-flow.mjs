#!/usr/bin/env node
// THE ORDER FLOW ITSELF, NOT ONLY ITS CALldata.
//
// `runAtomicOrder` is the sequence the page runs: build our side, ask/verify the counterparty, compute both
// commitments, assemble the joint address, then fund once. There was no check that CALLED it: every guard tested a
// piece below it. The deps seam exists for exactly this, so the worker and the funding call are stand-ins; what is
// tested is the sequence and the values passed across its boundaries.
//
// Run: node tools/check-atomic-flow.mjs
import { runAtomicOrder } from "../src/swap-flow.mjs";

const ZERO = "0x" + "00".repeat(32);
const LOCKER = "0x" + "11".repeat(20);
const CLAIMER = "0x" + "22".repeat(20);

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

function worker({ reject = false } = {}) {
  let sides = 0;
  return {
    buildSide() {
      sides += 1;
      const half = sides === 1 ? 1n : 2n;
      return {
        half, pub: { ed: "0x" + half.toString(16).padStart(64, "0") }, viewHalf: half + 10n,
        viewPub: "0x" + (half + 10n).toString(16).padStart(64, "0"),
        enc: { pub: "0x" + (half + 20n).toString(16).padStart(64, "0") },
        proof: { XA: "0x" + half.toString(16).padStart(64, "0"), XB: "0x" + half.toString(16).padStart(64, "0") },
        standIn: true,
      };
    },
    async verifyCounterparty() { return reject ? { ok: false, reason: "synthetic refusal" } : { ok: true }; },
    async halfCommitment(half) { return { commitment: "0x" + (half === 1n ? "aa" : "bb").repeat(32) }; },
    async jointAddress() { return { address: "synthetic-monero-address", spendPub: "0x" + "cc".repeat(32), viewPub: "0x" + "dd".repeat(32) }; },
    stop() {},
  };
}

function funding() {
  return async (request) => ({
    escrow: "0x" + "ee".repeat(20), createHash: "0x" + "ff".repeat(32), salt: request.salt,
    feeWei: 0n, feeTotalWei: 0n, feeBps: 0,
  });
}

console.log("=== 1) THE FULL SEQUENCE FUNDS ONCE WITH THE BOUND VALUES ===");
{
  const calls = [];
  const result = await runAtomicOrder({
    chainSlug: "arbitrum-sepolia", locker: LOCKER, claimer: CLAIMER, amountWei: 10n ** 18n, amountLabel: "1 ETH",
    deps: {
      createOrderWorker: () => worker(),
      fundOrderLive: async (request) => { calls.push(request); return funding()(request); },
    },
  }).catch((error) => error);
  if (result && result.escrow === "0x" + "ee".repeat(20) && calls.length === 1) ok("the sequence reaches funding once and returns the escrow");
  else bad("sequence: " + JSON.stringify(result && (result.code || result)));
  const request = calls[0] || {};
  if (Number(request.t1) > Number(request.readyBy) && request.salt && request.commitHalfLocker === "0x" + "aa".repeat(32)
    && request.commitHalfClaimer === "0x" + "bb".repeat(32) && request.edViewPointLocker) {
    ok("t1 is after readyBy, the salt is carried, and both commitments and the view point are passed");
  } else bad("funding request: " + JSON.stringify(request));
  if (result && result.standIn === true && result.counterHalf === 2n && result.moneroAddress === "synthetic-monero-address") {
    ok("the stand-in is marked, its half is returned, and the joint address is assembled");
  } else bad("stand-in result: " + JSON.stringify(result));
}

console.log("=== 2) A REFUSED COUNTERPARTY DOES NOT REACH FUNDING ===");
{
  let funded = 0;
  const result = await runAtomicOrder({
    chainSlug: "arbitrum-sepolia", locker: LOCKER, claimer: CLAIMER, amountWei: 10n ** 18n, amountLabel: "1 ETH",
    deps: {
      createOrderWorker: () => worker({ reject: true }),
      fundOrderLive: async () => { funded += 1; return {}; },
    },
  }).catch((error) => error);
  if (result && result.code === "quote-refused" && result.params && result.params.step === "proof" && funded === 0) {
    ok("a refused proof returns quote-refused and sends no funding transaction");
  } else bad("refused proof: " + JSON.stringify({ code: result && result.code, params: result && result.params, funded }));
}

console.log("=== 3) A MISSING CLAIMER IS NAMED BEFORE ANY WORK ===");
{
  const result = await runAtomicOrder({
    chainSlug: "arbitrum-sepolia", locker: LOCKER, amountWei: 10n ** 18n,
    deps: { createOrderWorker: () => worker(), fundOrderLive: async () => ({}) },
  }).catch((error) => error);
  if (result && result.code === "bad-input" && result.params && result.params.field === "claimer") ok("a missing claimer -> bad-input, field claimer");
  else bad("missing claimer: " + JSON.stringify(result && (result.code || result)));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "atomic flow: " + pass + " checks passed.");
if (fails.length) process.exit(1);
