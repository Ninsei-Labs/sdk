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

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "order proof: " + pass + " checks passed.");
if (fails.length) process.exit(1);
