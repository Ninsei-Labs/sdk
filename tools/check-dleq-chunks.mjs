#!/usr/bin/env node
// THE PROOF AND THE VERIFIER KEEP THE PAGE ALIVE.
//
// The chunked entry points must be the same proof, not a weaker parallel path: a chunked proof has to verify
// synchronously, and a chunked verdict has to agree with the synchronous one. The yield count is the evidence
// that the arithmetic really gives the event loop a turn instead of merely calling a progress callback.
import { ed25519, secp256k1, keccak256, sha3_512, randomBytes } from "../src/primitives.mjs";
import { createDleq2 } from "../engine/atomic/dleq2.js";
import { createOrderBuilder } from "../engine/atomic/order.js";
import { contextOf, orderStepChunked } from "../src/order.mjs";

const dleq = createDleq2({ ed25519, secp256k1, keccak256, sha3_512, randomBytes });
const orderBuilder = createOrderBuilder({ ed25519, secp256k1, keccak256, sha3_512, randomBytes });
const X = 12345678901234567890n;
const now = Math.floor(Date.now() / 1000);
const ORDER = {
  chainId: 421614, factory: "0x" + "11".repeat(20), locker: "0x" + "22".repeat(20),
  claimer: "0x" + "33".repeat(20), amount: "1000000000000000000",
  readyBy: now + 7200, t1: now + 14400, salt: "0x" + "44".repeat(32),
};
const CONTEXT = contextOf(ORDER);
let proof = null;
let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };

console.log("=== 1) A CHUNKED PROOF IS THE SAME PROOF ===");
{
  let turns = 0;
  let prepares = 0;
  let lastBit = 0;
  proof = await dleq.proveChunked(X, CONTEXT, {
    chunkBits: 4,
    prepareChunkBits: 8,
    yieldTo: async () => { turns += 1; await new Promise((resolve) => setTimeout(resolve, 0)); },
    onPrepare: () => { prepares += 1; },
    onBit: (bit, total) => { if (bit === total) lastBit = bit; },
  });
  if (proof.proofs.length === dleq.BITS && proof.pokA && proof.pokB && lastBit === dleq.BITS) {
    ok("the chunked proof has every bit, both knowledge proofs and a final progress value");
  } else bad("chunked proof shape: " + JSON.stringify({ bits: proof.proofs.length, lastBit, pokA: !!proof.pokA, pokB: !!proof.pokB }));
  if (turns >= 20 && prepares >= dleq.BITS) {
    ok("preparation and proof actually yield to the event loop");
  } else bad("yield evidence: turns=" + turns + " prepares=" + prepares);
  const sync = dleq.verify(proof, CONTEXT);
  if (sync.ok === true) ok("the synchronous verifier accepts the chunked proof");
  else bad("synchronous verify refused the chunked proof: " + JSON.stringify(sync));
  let chunkedTurns = 0;
  let finalProgress = 0;
  const chunked = await dleq.verifyChunked(proof, CONTEXT, {
    yieldTo: async () => { chunkedTurns += 1; await new Promise((resolve) => setTimeout(resolve, 0)); },
    onProgress: (step) => { if (step && step.phase === "verify") finalProgress = step.done; },
  });
  if (chunked.ok === true && chunkedTurns >= 20 && finalProgress === dleq.BITS) {
    ok("the chunked verifier accepts the same proof and yields to the event loop");
  } else bad("chunked verify: " + JSON.stringify({ chunked, chunkedTurns, finalProgress }));

  const broken = JSON.parse(JSON.stringify(proof));
  broken.proofs[0].sig.eA = "0x" + "00".repeat(32);
  const syncBroken = dleq.verify(broken, CONTEXT);
  const chunkedBroken = await dleq.verifyChunked(broken, CONTEXT, { yieldTo: async () => {} });
  if (syncBroken.ok === false && chunkedBroken.ok === false) {
    ok("a tampered proof is refused by both verifier paths");
  } else bad("tampered proof: " + JSON.stringify({ syncBroken, chunkedBroken }));
}

console.log("=== 2) THE CHUNKED ORDER STEP USES THE SAME PROOF ===");
{
  const half = X;
  const pub = orderBuilder.halves.publicHalves(half);
  const viewHalf = X + 7n;
  const viewPub = orderBuilder.halves.publicHalves(viewHalf).ed;
  const enc = orderBuilder.enc.recipientKeyPair();
  const side = { half, pub, viewHalf, viewPub, enc, proof, standIn: false };
  const counterparty = {
    proof, edPointClaimer: pub.ed, viewHalfClaimer: viewHalf,
    commitHalfClaimer: orderBuilder.halfCommitment(half),
  };
  let turns = 0;
  try {
    const step = await orderStepChunked({
      order: ORDER, side, counterparty, network: "stagenet",
      options: { yieldTo: async () => { turns += 1; await new Promise((resolve) => setTimeout(resolve, 0)); } },
    });
    if (step.wallet.address && step.wallet.commitHalfLocker && step.side.half === half
      && step.counterparty.commitHalfClaimer === counterparty.commitHalfClaimer && turns >= 20) {
      ok("the chunked order step verifies the same proof, builds the address and yields");
    } else bad("chunked order step: " + JSON.stringify({ address: !!step.wallet.address, turns }));
  } catch (error) {
    bad("chunked order step failed: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "dleq chunks: " + pass + " checks passed.");
if (fails.length) process.exit(1);
