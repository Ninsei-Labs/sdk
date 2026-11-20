#!/usr/bin/env node
// KEY IMAGES WITHOUT A WALLET, AGAINST MONERO'S OWN VECTORS.
//
// The vectors are copied from monero-project/monero `tests/crypto/tests.txt` (master) and cover
// `hash_to_point`, `biased_hash_to_ec` and `generate_key_image`. They are an independent oracle: the expected
// bytes come from Monero's C++ implementation, not from this module.
//
// The facade cases build an output from a known spend scalar, so the whole route `sweep.keyImages` -> output
// binding -> key image is exercised, including the refusals that must not return a partial answer.
//
// Run: node tools/check-key-image.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import moneroTs from "monero-ts";
import { addressFromKeys } from "../engine/monero/address.js";
import { createSweep } from "../src/sweep.mjs";
import { keccak256 } from "../src/primitives.mjs";
import { ED_ORDER, hashToScalar, hexToBytes, varint } from "../engine/monero/scan.js";
import { biasedHashToEc, hashToPoint, keyImageFromOutput, keyImageFromSpendKey } from "../engine/monero/keyImage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(readFileSync(join(ROOT, "tools/fixtures/key-image-vectors.json"), "utf8"));
const rustVectors = JSON.parse(readFileSync(join(ROOT, "tools/fixtures/key-image-rust-vectors.json"), "utf8"));
const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (!condition) problems.push(message); };
const le32 = (value) => BigInt(value).toString(16).padStart(64, "0").match(/../g).reverse().join("");
const errorCode = (error) => error && error.code ? error.code : null;

for (const row of vectors.hash_to_point) {
  check(hashToPoint(row[1]) === row[2], `hash_to_point ${row[1]} -> ${hashToPoint(row[1])}, want ${row[2]}`);
}
for (const row of vectors.biased_hash_to_ec) {
  check(biasedHashToEc(row[1]) === row[2], `biased_hash_to_ec ${row[1]} -> ${biasedHashToEc(row[1])}, want ${row[2]}`);
}
for (const row of vectors.generate_key_image) {
  const got = keyImageFromSpendKey({ outputKey: row[1], privateSpendKey: row[2] });
  check(got === row[3], `generate_key_image ${row[1]} -> ${got}, want ${row[3]}`);
}
for (const row of rustVectors.vectors) {
  const got = keyImageFromSpendKey({ outputKey: row.outputKey, privateSpendKey: row.privateSpendKey });
  check(got === row.keyImage, `Rust oracle ${row.outputKey} -> ${got}, want ${row.keyImage}`);
}
console.log("  ok    " + vectors.hash_to_point.length + " Monero hash_to_point vectors");
console.log("  ok    " + vectors.biased_hash_to_ec.length + " Monero biased_hash_to_ec vectors");
console.log("  ok    " + vectors.generate_key_image.length + " Monero generate_key_image vectors");
console.log("  ok    " + rustVectors.vectors.length + " independently generated Rust vectors");

// A synthetic output whose spend scalar is known. The output key is x*G; the arrival carries the derivation and
// index, exactly as `findOurOutputs` returns them.
const spend = 0x123456789abcdefn;
const derivation = "ab".repeat(32);
const index = 3;
const scalar = hashToScalar(hexToBytes(derivation), varint(index));
const x = (scalar + spend) % ED_ORDER;
const outputKey = ed25519.Point.BASE.multiply(x).toHex();
const expectedImage = keyImageFromSpendKey({ outputKey, privateSpendKey: le32(x) });
const view = 7n;
const spendPub = ed25519.Point.BASE.multiply(spend).toHex();
const address = addressFromKeys({ network: "stagenet", spendPub, viewPub: ed25519.Point.BASE.multiply(view).toHex() }, { keccak256 });
const keys = { privateSpendKey: le32(spend), privateViewKey: le32(view), address };
const output = { index, key: outputKey, amountAtomic: "1000000000000", amountVerified: true, derivation };

// THE SAME KEY MATERIAL THROUGH monero-ts. This is the reference byte order for the keys the sweep page
// receives: a little-endian scalar read the other way opens a different address and finds nothing.
const reference = await moneroTs.createWalletKeys({
  networkType: moneroTs.MoneroNetworkType.STAGENET,
  privateSpendKey: keys.privateSpendKey, privateViewKey: keys.privateViewKey, primaryAddress: address,
});
check(await reference.getAddress(0, 0) === address, "monero-ts opens the same address from the sweep keys");
check(await reference.getPrivateSpendKey() === keys.privateSpendKey, "monero-ts returns the same spend key");
await reference.close();
await moneroTs.shutdown();
console.log("  ok    monero-ts opens the same address from the sweep keys");

const sweep = createSweep();
const images = await sweep.keyImages({ keys, arrival: { outputs: [output] } });
check(images.length === 1 && images[0].outputKey === outputKey && images[0].keyImage === expectedImage,
  "sweep.keyImages returns the image for the verified output");
check(images[0].amountAtomic === "1000000000000", "sweep.keyImages keeps the verified amount");

// MULTIPLE OUTPUTS KEEP THEIR ARRIVAL ORDER. A funding transaction can pay the address in several outputs; a
// second image computed for the same one would hide a missing output.
const secondScalar = (hashToScalar(hexToBytes(derivation), varint(1)) + spend) % ED_ORDER;
const secondKey = ed25519.Point.BASE.multiply(secondScalar).toHex();
const secondImage = keyImageFromSpendKey({ outputKey: secondKey, privateSpendKey: le32(secondScalar) });
const pair = await sweep.keyImages({ keys, arrival: { outputs: [output, { ...output, index: 1, key: secondKey }] } });
check(pair.length === 2 && pair[0].keyImage === expectedImage && pair[1].keyImage === secondImage,
  "sweep.keyImages keeps every verified output in arrival order");

const refuse = async (request, why) => {
  try {
    await sweep.keyImages(request);
    return null;
  } catch (error) {
    return errorCode(error) === "bad-input" ? error : { code: errorCode(error), why };
  }
};

check((await refuse({ keys, arrival: { outputs: [{ ...output, amountVerified: false }] } }))?.params?.why === "unverified",
  "an unverified output is refused instead of producing a guessed image");
check((await refuse({ keys, arrival: { outputs: [{ ...output, derivation: undefined }] } }))?.params?.why === "derivation",
  "a missing derivation is refused");
check((await refuse({ keys, arrival: { outputs: [output, output] } }))?.params?.why === "duplicate",
  "a duplicate output is refused");
check((await refuse({ keys, arrival: { outputs: [] } }))?.params?.field === "arrival.outputs",
  "an empty arrival is refused");
check((await refuse({ keys: { privateSpendKey: le32(spend + 1n) }, arrival: { outputs: [output] } }))?.params?.why === "key-image",
  "a spend key from another address is refused");

for (const [label, call] of [
  ["wrong index", () => keyImageFromOutput({ outputKey, derivation, index: index + 1, privateSpendKey: le32(spend) })],
  ["wrong spend key", () => keyImageFromOutput({ outputKey, derivation, index, privateSpendKey: le32(spend + 1n) })],
  ["mutated output key", () => keyImageFromSpendKey({ outputKey: outputKey.slice(0, -1) + (outputKey.endsWith("0") ? "1" : "0"), privateSpendKey: le32(spend) })],
]) {
  let refused = false;
  try { call(); } catch { refused = true; }
  check(refused, `${label} is refused`);
}

if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log("key image: FAILED (" + problems.length + ")");
  process.exit(1);
}
console.log("key image: " + checks + " checks passed");
