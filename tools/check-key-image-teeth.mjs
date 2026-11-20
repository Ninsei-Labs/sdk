#!/usr/bin/env node
// A KEY IMAGE MUST BELONG TO ITS OUTPUT. Removing the `x*G == outputKey` binding must change the answer: the
// original refuses a derivation for another output, while the mutant returns an image that no node can match.
// Run: node tools/check-key-image-teeth.mjs
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ED_ORDER, hashToScalar, hexToBytes, varint } from "../engine/monero/scan.js";
import { keyImageFromOutput } from "../engine/monero/keyImage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(ROOT, "engine/monero/keyImage.js");
const mutantPath = join(ROOT, "engine/monero/.key-image-mutant-" + process.pid + ".mjs");
const source = readFileSync(sourcePath, "utf8");
const guard = "if (x === 0n || output.toHex().toLowerCase() !== ed25519.Point.BASE.multiply(x).toHex().toLowerCase()) {";
if (!source.includes(guard)) throw new Error("the key-image guard moved; update this teeth check");
const mutantSource = source.replace(guard, "if (x === 0n) {");
writeFileSync(mutantPath, mutantSource, "utf8");

const spend = 0x123456789abcdefn;
const derivation = "ab".repeat(32);
const wrongIndex = 4;
const scalar = hashToScalar(hexToBytes(derivation), varint(wrongIndex));
const x = (scalar + spend) % ED_ORDER;
const outputKey = ed25519.Point.BASE.multiply(x).toHex();
const privateSpendKey = BigInt(spend).toString(16).padStart(64, "0").match(/../g).reverse().join("");
const request = { outputKey, derivation, index: wrongIndex + 1, privateSpendKey };

let originalRefused = false;
try { keyImageFromOutput(request); } catch { originalRefused = true; }
if (!originalRefused) throw new Error("the original accepted an output for another index");
let mutantReturned = false;
try {
  const mutant = await import(pathToFileURL(mutantPath).href + "?v=" + process.pid);
  mutantReturned = typeof mutant.keyImageFromOutput(request) === "string";
} finally {
  rmSync(mutantPath, { force: true });
}
if (!mutantReturned) throw new Error("removing the output binding did not change the answer: the check is not load-bearing");
console.log("  ok    removing the output binding changes the answer");
console.log("key image teeth: the binding is load-bearing");
