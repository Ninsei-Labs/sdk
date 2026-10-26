#!/usr/bin/env node
// CONTRACT VECTORS ARE AN INDEPENDENT ORACLE.
//
// The suite used to derive expected values with the same functions it checked. That is how `moneroFeeEstimate` stayed
// green while every real estimate was absent or 1024 times too low: the fixture and the arithmetic shared one wrong
// assumption. These values come from Foundry `cast`, not from the SDK's curve or hash code:
//
//   half commitment = keccak256(uncompressed secp256k1 point of the half)
//   event topic     = keccak256("OrderCreated(address,address,address,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint64,uint64,bytes32,address,address,address)")
//   selectors       = cast sig for the full quote tuple
//
// Run: node tools/check-contract-vectors.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { halfCommitmentHex } from "../engine/atomic/orderHalfCommit.js";
import { FACTORY_METHODS, ORDER_CREATED_TOPIC } from "../engine/evm/factory.js";
import { keccak256, secp256k1 } from "../src/primitives.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "tools", "fixtures", "contract-vectors.json"), "utf8"));

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const norm = (v) => String(v).toLowerCase().replace(/^0x/, "");

console.log("=== 1) HALF COMMITMENTS COME FROM THE CONTRACT'S POINT, NOT FROM A HASH OF THE NUMBER ===");
for (const vector of FIXTURE.halfCommitments) {
  const got = halfCommitmentHex(BigInt(vector.half), secp256k1, keccak256);
  if (norm(got) === norm(vector.commit)) ok("half " + vector.half.slice(0, 12) + "... -> " + got);
  else bad("half " + vector.half + ": got " + got + ", cast says " + vector.commit);
}

console.log("=== 2) THE EVENT TOPIC IS THE CONTRACT'S EVENT ===");
if (norm(ORDER_CREATED_TOPIC) === norm(FIXTURE.orderCreatedTopic)) ok("OrderCreated topic matches cast keccak");
else bad("OrderCreated topic: got " + ORDER_CREATED_TOPIC + ", cast says " + FIXTURE.orderCreatedTopic);

console.log("=== 3) THE FACTORY SELECTORS ARE THE CONTRACT'S FUNCTIONS ===");
for (const [name, expected] of Object.entries(FIXTURE.factoryMethods)) {
  if (norm(FACTORY_METHODS[name]) === norm(expected)) ok(name + " matches cast sig");
  else bad(name + ": got " + FACTORY_METHODS[name] + ", cast says " + expected);
}

console.log("=== 4) A COPY THAT HASHES THE NUMBER INSTEAD OF THE POINT REDDENS ===");
{
  const dir = mkdtempSync(join(tmpdir(), "ninsei-contract-vectors-"));
  const copy = join(dir, "orderHalfCommit.mjs");
  try {
    const source = readFileSync(join(ROOT, "engine", "atomic", "orderHalfCommit.js"), "utf8");
    const mutated = source.replace(
      "const raw = secp256k1.Point.BASE.multiply(value).toBytes(false);",
      "const raw = Uint8Array.from([...new TextEncoder().encode(value.toString())]);",
    );
    if (mutated === source) throw new Error("the mutation anchor was not found");
    writeFileSync(copy, mutated);
    const broken = await import(pathToFileURL(copy).href + "?run=" + Date.now());
    const first = FIXTURE.halfCommitments[0];
    const got = broken.halfCommitmentHex(BigInt(first.half), secp256k1, keccak256);
    if (norm(got) !== norm(first.commit)) ok("the wrong commitment formula is caught: " + got);
    else bad("the wrong formula still passed");
  } catch (error) {
    bad("breaking run failed: " + String((error && error.message) || error));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "contract vectors: " + pass + " checks passed.");
if (fails.length) process.exit(1);
