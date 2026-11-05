#!/usr/bin/env node
// THE ESCROW READ DECODERS REFUSE A BODY THAT IS NOT EXACTLY THE ABI WORD(S).
//
// A mismatch used to surface later as "expected X, got 0xzz..." or, worse, as a comparison miss. The decoder is
// the boundary: non-hex, an uppercase `0X` prefix, a short answer or extra words are named errors here.
import { decodeBytes32, decodeStatus, decodeUint64 } from "../engine/evm/escrow.js";
import { decodeAddress, decodeImplementationCodeHash } from "../engine/evm/factory.js";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
const bytes32 = "0x" + "11".repeat(32);
const status = "0x" + [1, 0, 0, 0].map((v) => BigInt(v).toString(16).padStart(64, "0")).join("");

console.log("=== 1) EXACT ANSWERS DECODE ===");
{
  if (decodeBytes32(bytes32) === bytes32) ok("a 32-byte word decodes");
  else bad("decodeBytes32 changed its input");
  const decoded = decodeStatus(status);
  if (decoded.isFunded === true && decoded.isClaimed === false && decoded.balance === 0n) ok("four status words decode");
  else bad("decodeStatus: " + JSON.stringify(decoded));
  if (decodeUint64("0x" + word("2a")) === 42) ok("a uint64 word decodes");
  else bad("decodeUint64 changed its input");
  const addressWord = "0x" + "00".repeat(12) + "11".repeat(20);
  if (decodeAddress(addressWord) === "0x" + "11".repeat(20)) ok("a predict() address word decodes");
  else bad("decodeAddress: " + decodeAddress(addressWord));
  if (decodeImplementationCodeHash(bytes32) === bytes32) ok("an implementationCodeHash word decodes");
  else bad("decodeImplementationCodeHash changed its input");
}

console.log("=== 2) MALFORMED ANSWERS ARE REFUSED AT THE DECODER ===");
for (const [label, call] of [
  ["non-hex bytes32", () => decodeBytes32("0x" + "zz".repeat(32))],
  ["uppercase 0X prefix", () => decodeBytes32("0X" + "11".repeat(32))],
  ["short bytes32", () => decodeBytes32("0x" + "11".repeat(31))],
  ["non-string bytes32", () => decodeBytes32({ toString: null })],
  ["non-hex status", () => decodeStatus("0x" + "zz".repeat(128))],
  ["short status", () => decodeStatus(status.slice(0, -2))],
  ["extra status words", () => decodeStatus(status + "00".repeat(32))],
  ["uppercase 0X status", () => decodeStatus("0X" + status.slice(2))],
  ["non-hex uint64", () => decodeUint64("0x" + "zz".repeat(32))],
  ["uppercase 0X predict", () => decodeAddress("0X" + "11".repeat(32))],
  ["short predict", () => decodeAddress("0x" + "11".repeat(31))],
  ["extra predict words", () => decodeAddress("0x" + "11".repeat(33))],
  ["non-hex code hash", () => decodeImplementationCodeHash("0x" + "zz".repeat(32))],
  ["uppercase 0X code hash", () => decodeImplementationCodeHash("0X" + "11".repeat(32))],
]) {
  let refused = false;
  try { call(); } catch (error) { refused = error instanceof Error && !/^0x/i.test(String(error.message)); }
  if (refused) ok(label + " is refused");
  else bad(label + " was accepted or threw an unhelpful value");
}

if (fails.length) {
  console.log("FAILED: " + fails.length + " problem(s)");
  process.exit(1);
}
console.log("evm decoders: " + pass + " checks passed.");
