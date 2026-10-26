#!/usr/bin/env node
// THE DLEQ PROOF MUST BE BOUND TO THE COMMITMENT THE CONTRACT WILL COMPARE.
//
// A proof says "XA and XB stand for one scalar". It does NOT say that XA is the point behind the quote's
// `commitHalfClaimer`. Without the second check a counterparty can prove one half, put another half's commitment
// in the quote, and the escrow rejects the claim after the other side has paid.
//
// Run: node tools/check-order-proof.mjs
import { randomBytes } from "node:crypto";
import { ed25519, secp256k1, keccak256, sha3_512 } from "../src/primitives.mjs";
import { createOrderBuilder } from "../engine/atomic/order.js";
import { contextOf, orderStep } from "../src/order.mjs";

const builder = createOrderBuilder({
  ed25519, secp256k1, keccak256, sha3_512,
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
});
const CONTEXT = "ninsei-order-v3|arrival-proof-check|1";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

console.log("=== 1) A PROOF WITH ITS OWN COMMITMENT PASSES ===");
const side = builder.newSide(CONTEXT, true);
const commit = builder.halfCommitment(side.half);
{
  const verdict = builder.verifySide({
    proof: side.proof,
    pub: { ed: side.pub.ed },
    commitHalfClaimer: commit,
  }, CONTEXT);
  if (verdict.ok === true) ok("the proven point and its commitment agree");
  else bad("the honest side was refused: " + JSON.stringify(verdict));
}

console.log("=== 2) A COMMITMENT FROM ANOTHER HALF IS REFUSED ===");
{
  const other = builder.newSide(CONTEXT, true);
  const wrong = builder.halfCommitment(other.half);
  const verdict = builder.verifySide({
    proof: side.proof,
    pub: { ed: side.pub.ed },
    commitHalfClaimer: wrong,
  }, CONTEXT);
  if (verdict.ok === false) ok("the substituted commitment is refused");
  else bad("a substituted commitment passed");
  if (/commitHalfClaimer/.test(String(verdict.reason))) ok("the refusal names the commitment");
  else bad("the refusal does not name the commitment: " + verdict.reason);
}

console.log("=== 3) A MISSING COMMITMENT IS REFUSED ===");
{
  const verdict = builder.verifySide({
    proof: side.proof,
    pub: { ed: side.pub.ed },
  }, CONTEXT);
  if (verdict.ok === false) ok("a side without a commitment is refused");
  else bad("a side without a commitment passed");
}

console.log("=== 4) THE ORDER STEP ASKS THE SAME BINDING BEFORE FUNDING ===");
{
  const now = Math.floor(Date.now() / 1000);
  const order = { chainId: 421614, factory: "0x" + "11".repeat(20), locker: "0x" + "22".repeat(20),
    claimer: "0x" + "33".repeat(20), amount: "1000000000000000000", readyBy: now + 7200, t1: now + 14400,
    salt: "0x" + "44".repeat(32) };
  const context = contextOf(order);
  const own = builder.newSide(context, true);
  const other = builder.newSide(context, true);
  const counterparty = { proof: other.proof, edPointClaimer: other.pub.ed, viewHalfClaimer: other.viewHalf,
    viewPoint: other.viewPub, commitHalfClaimer: builder.halfCommitment(other.half) };
  const run = (label, change) => {
    try {
      const step = orderStep({ order, side: own, counterparty: { ...counterparty, ...change }, network: "stagenet" });
      return { ok: true, step };
    } catch (error) {
      return { ok: false, code: error && error.code, params: error && error.params };
    }
  };
  const good = run("control", {});
  if (good.ok && good.step.wallet.commitHalfClaimer === counterparty.commitHalfClaimer) {
    ok("the order step accepts the proven half and carries its commitment");
  } else bad("order step control: " + JSON.stringify(good.ok ? good.step.wallet : good));

  const wrongCommit = run("commit", { commitHalfClaimer: builder.halfCommitment(other.half + 1n) });
  if (!wrongCommit.ok && wrongCommit.code === "quote-refused" && wrongCommit.params && wrongCommit.params.step === "proof") {
    ok("a commitment from another half is refused by the order step");
  } else bad("order step accepts a foreign commitment: " + JSON.stringify(wrongCommit));

  const wrongPoint = run("point", { edPointClaimer: builder.pointOf(other.half + 1n) });
  if (!wrongPoint.ok && wrongPoint.code === "quote-refused") ok("a point from another half is refused by the order step");
  else bad("order step accepts a foreign point: " + JSON.stringify(wrongPoint));

  const missing = run("missing", { commitHalfClaimer: undefined });
  if (!missing.ok && missing.code === "bad-input" && missing.params && Array.isArray(missing.params.missing)
    && missing.params.missing.includes("commitHalfClaimer")) {
    ok("a missing commitment is named before funding");
  } else bad("order step with no commitment: " + JSON.stringify(missing));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "order proof: " + pass + " checks passed.");
if (fails.length) process.exit(1);
