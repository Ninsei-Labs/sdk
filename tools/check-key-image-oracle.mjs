#!/usr/bin/env node
// TWO-WAY DIFFERENTIAL CHECK AGAINST THE RUST MONERO ORACLE.
//
// The committed fixture (`key-image-rust-vectors.json`) is one direction: Rust produced the output key and image,
// the SDK verifies them. This script runs the other direction as well: the SDK produces the keys and images, the
// Rust binary recomputes them. Both directions are needed — a fixture only catches drift in the verifier.
//
// The oracle is `test/key-image-oracle/rust`, built on `monero-ed25519` (a separate constant-time Elligator 2
// implementation), not a copy of the SDK module. It is a development check and is not part of the runtime package.
//
// Run: cargo build --release --manifest-path test/key-image-oracle/rust/Cargo.toml
//      node tools/check-key-image-oracle.mjs
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ED_ORDER, hashToScalar, varint } from "../engine/monero/scan.js";
import { keyImageFromOutput, keyImageFromSpendKey } from "../engine/monero/keyImage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.KEY_IMAGE_ORACLE,
  join(ROOT, "test/key-image-oracle/rust/target/release/key-image-oracle"),
  join(ROOT, "test/key-image-oracle/rust/target/release/key-image-oracle.exe"),
].filter(Boolean);
const binary = candidates.find((path) => existsSync(path));
if (!binary) {
  console.log("key image oracle: skipped (build test/key-image-oracle/rust first)");
  process.exit(0);
}

const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (!condition) problems.push(message); };
const le32 = (value) => BigInt(value).toString(16).padStart(64, "0").match(/../g).reverse().join("");
const scalarOf = (label) => {
  let value = hashToScalar(new TextEncoder().encode(label));
  return value === 0n ? 1n : value;
};
const run = (requests) => {
  const result = spawnSync(binary, [], { input: JSON.stringify({ requests }), encoding: "utf8" });
  if (result.status !== 0) throw new Error("oracle failed: " + (result.stderr || result.error));
  const body = JSON.parse(result.stdout);
  if (!Array.isArray(body.results)) throw new Error("oracle returned no results");
  return body.results;
};

// The Rust op is `biased_hash_to_ec` (keccak + Elligator 2 + cofactor), not the raw fromfe-only
// `hash_to_point`; these are Monero's own biased_hash_to_ec vectors, so the naming and the implementation
// are checked together.
const moneroVectors = JSON.parse(readFileSync(join(ROOT, "tools/fixtures/key-image-vectors.json"), "utf8"));
const hashResults = run(moneroVectors.biased_hash_to_ec.map((row) => ({ op: "biased_hash_to_ec", input: row[1] })));
for (const [i, result] of hashResults.entries()) {
  check(result.ok === true, `oracle refused biased_hash_to_ec ${i}: ${result.error || ""}`);
  check(result.output === moneroVectors.biased_hash_to_ec[i][2], `Rust biased_hash_to_ec disagrees on ${i}`);
}

// SDK -> Rust. The spend scalar is the only input Rust gets; it must reconstruct the same image.
const sdkRequests = [];
const sdkExpected = [];
for (let i = 1; i <= 32; i += 1) {
  const spend = scalarOf("sdk-key-image-" + i);
  const outputKey = ed25519.Point.BASE.multiply(spend).toHex();
  const keyImage = keyImageFromSpendKey({ outputKey, privateSpendKey: le32(spend) });
  sdkRequests.push({ op: "key_image", output_key: outputKey, private_spend_key: le32(spend) });
  sdkExpected.push({ outputKey, keyImage });
}
const fromRust = run(sdkRequests);
for (const [i, result] of fromRust.entries()) {
  check(result.ok === true, `oracle refused SDK vector ${i}: ${result.error || ""}`);
  check(result.key_image === sdkExpected[i].keyImage, `Rust disagrees with SDK on image ${i}`);
}

// Rust -> SDK. The committed fixture covers this statically; this also checks the live binary and the derivation
// path, where the output key is not a bare scalar multiple supplied by the caller.
const seedRequests = Array.from({ length: 32 }, (_, i) => ({ op: "generate", seed: (i + 1).toString(16).padStart(2, "0").repeat(32) }));
for (const [i, result] of run(seedRequests).entries()) {
  check(result.ok === true, `oracle refused generated vector ${i}: ${result.error || ""}`);
  if (result.ok !== true) continue;
  const got = keyImageFromSpendKey({ outputKey: result.output_key, privateSpendKey: result.scalar });
  check(got === result.key_image, `SDK disagrees with Rust generated image ${i}`);
}

const deriveRequests = [];
const deriveExpected = [];
for (let i = 1; i <= 16; i += 1) {
  const derivation = new Uint8Array(32).fill(i);
  const index = i * 7;
  const spend = scalarOf("sdk-derivation-" + i);
  const x = (hashToScalar(derivation, varint(index)) + spend) % ED_ORDER;
  const outputKey = ed25519.Point.BASE.multiply(x).toHex();
  const keyImage = keyImageFromOutput({ outputKey, derivation: Buffer.from(derivation).toString("hex"), index, privateSpendKey: le32(spend) });
  deriveRequests.push({ op: "derive_key_image", derivation: Buffer.from(derivation).toString("hex"), index, private_spend_key: le32(spend) });
  deriveExpected.push({ outputKey, keyImage });
}
for (const [i, result] of run(deriveRequests).entries()) {
  check(result.ok === true, `oracle refused derivation ${i}: ${result.error || ""}`);
  check(result.output_key === deriveExpected[i].outputKey, `Rust derived a different output key ${i}`);
  check(result.key_image === deriveExpected[i].keyImage, `Rust derived a different image ${i}`);
}

if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log("key image oracle: FAILED (" + problems.length + ")");
  process.exit(1);
}
console.log("key image oracle: both directions agree (" + checks + " checks)");
