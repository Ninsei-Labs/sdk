#!/usr/bin/env node
// EVERY SIGNED FIELD MUST BE IN THE DIGEST, AND A MISSING ONE MUST BE NAMED.
//
// A field can be present in `ORDER_QUOTE_FIELDS`, appear in the type string and still be dropped from the struct
// hash by a loop that skips it; the signature then does not cover it. This check mutates exactly one field at a
// time: every mutation must change the digest, and deleting it must put its name in `quoteMissingFields`.
//
// Run: node tools/check-quote-binding.mjs
import { ORDER_QUOTE_FIELDS, quoteDigest, quoteMissingFields } from "../src/quoteEip712Spec.mjs";
import { keccak256, secp256k1 } from "../src/primitives.mjs";

const crypto = { secp256k1, keccak256 };
const now = 1_800_000_000;
const base = {
  provider: "0x" + "11".repeat(20), quoteKey: "0x" + "12".repeat(20),
  registry: "0x" + "13".repeat(20), cashier: "0x" + "14".repeat(20),
  locker: "0x" + "15".repeat(20), claimer: "0x" + "16".repeat(20),
  amount: "1000000000000000000", readyBy: String(now + 3600), t1: String(now + 7200),
  salt: "0x" + "17".repeat(32), commitHalfClaimer: "0x" + "18".repeat(32),
  edPointClaimer: "0x" + "19".repeat(32), chainId: "421614", feeBps: "0", fee: "0",
  feeRecipient: "0x" + "1a".repeat(20), validUntil: String(now + 600), nonce: "1",
  xmrAmount: "1000000000000", claimTip: "0", factory: "0x" + "1b".repeat(20),
  signature: "0x" + "1c".repeat(65),
};

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

const digestOf = (quote) => "0x" + Buffer.from(quoteDigest({ crypto, quote })).toString("hex");
const changed = (name, type, value) => {
  if (type === "address") return "0x" + (name === "provider" ? "ee" : "dd").repeat(20);
  if (type === "bytes32") return "0x" + "ee".repeat(32);
  if (type === "uint64") return String(BigInt(value) + 1n);
  return String(BigInt(value) + 1n);
};

let original;
try { original = digestOf(base); } catch (error) { bad("the base quote does not digest: " + String(error.message || error)); }

if (original) {
  console.log("=== 1) EVERY FIELD CHANGES THE DIGEST ===");
  for (const [name, type] of ORDER_QUOTE_FIELDS) {
    const next = { ...base, [name]: changed(name, type, base[name]) };
    if (next[name] === base[name]) { bad("the mutation for " + name + " did not change the value"); continue; }
    try {
      const got = digestOf(next);
      if (got !== original) ok(name + " changes the digest");
      else bad(name + " does NOT change the digest");
    } catch (error) {
      bad(name + " made the digest unusable: " + String(error.message || error));
    }
  }

  console.log("=== 2) EVERY FIELD IS NAMED WHEN ABSENT ===");
  for (const [name] of ORDER_QUOTE_FIELDS) {
    const next = { ...base };
    delete next[name];
    const missing = quoteMissingFields(next);
    if (missing.includes(name)) ok(name + " is named when missing");
    else bad(name + " is absent but not named: " + JSON.stringify(missing));
  }

  console.log("=== 3) THE SIGNATURE IS NOT PART OF THE DIGEST ===");
  const signed = digestOf({ ...base, signature: "0x" + "ff".repeat(65) });
  if (signed === original) ok("changing the signature bytes does not change the signed digest");
  else bad("the signature bytes entered the digest");
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "quote binding: " + pass + " checks passed.");
if (fails.length) process.exit(1);
