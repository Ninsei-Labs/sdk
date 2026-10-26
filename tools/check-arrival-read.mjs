#!/usr/bin/env node
// READING AN XMR ARRIVAL WITHOUT A WALLET.
//
// A node that pays XMR holds one half of the view key, so it cannot open a wallet on the address it pays to - and it
// still has to know what the address is, whether its key matches, and whether the coin is locked. The sweep page
// needs the same answers when it checks a recovery file. Both carried their own copies; a second copy of the
// unlock_time rule is the expensive kind: money at the address that cannot be spent yet reads as an arrival.
//
// WHAT IS PROVEN (real primitives, no wallet, no network):
//   1) an address decodes to its network and its two public keys, and re-encoding those keys gives the same address
//      back - decoding and encoding cannot drift apart;
//   2) a scalar is little-endian hex, low byte first, and the byte order is asserted on a known value;
//   3) a view key matches its address, another key does not, and an address with no view key answers null;
//   4) unlock_time: zero is unlocked; a height opens only at or above the boundary; 500000000 itself is a TIME;
//      an unknown height does not open a height lock.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory):
//   A) write the scalar high byte first -> case 2 reddens;
//   B) treat 500000000 as a height -> case 4 reddens;
//   C) answer "matches" unconditionally -> case 3 reddens.
//
// Run: node tools/check-arrival-read.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { addressFromKeys, createHalves, decodeAddressKeys, scalarToLeHex, unlockStateOf, viewKeyMatchesAddress, UNLOCK_TIME_BLOCK_MAX } from "../src/public/xmr.mjs";
import { ed25519, secp256k1, keccak256 } from "../src/primitives.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "engine", "monero", "arrivalRead.js");
const UNLOCK_MODULE = join(ROOT, "engine", "monero", "unlock.js");
const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) ok(name + " -> " + JSON.stringify(want));
  else bad(name + " -> " + JSON.stringify(got) + ", expected " + JSON.stringify(want));
};

console.log("=== 1) AN ADDRESS -> NETWORK AND KEYS ===");
{
  const keys = decodeAddressKeys(ADDRESS);
  if (keys.network === "stagenet") ok("the network is read from the package's prefix table");
  else bad("network: " + JSON.stringify(keys.network));
  if (/^[0-9a-f]{64}$/.test(keys.spendPub) && /^[0-9a-f]{64}$/.test(keys.viewPub)) ok("both public keys are 32 bytes of hex");
  else bad("keys: " + JSON.stringify({ spend: keys.spendPub.length, view: keys.viewPub.length }));
  const rebuilt = addressFromKeys({ network: keys.network, kind: "primary", spendPub: keys.spendPub, viewPub: keys.viewPub }, { keccak256 });
  if (rebuilt === ADDRESS) ok("re-encoding the decoded keys gives the same address back");
  else bad("round trip: " + rebuilt);
}
{
  let threw = false;
  try { decodeAddressKeys("not-an-address"); } catch { threw = true; }
  if (threw) ok("a non-address is refused, not guessed");
  else bad("a non-address was accepted");
}

console.log("=== 2) THE SCALAR FORM ===");
eq("1 -> 01 followed by zeros (low byte first)", scalarToLeHex(1), "01" + "00".repeat(31));
eq("256 -> 00 01", scalarToLeHex(256).slice(0, 4), "0001");
eq("a hex scalar is accepted", scalarToLeHex("0xff"), "ff" + "00".repeat(31));
{
  let threw = false;
  try { scalarToLeHex(-1); } catch { threw = true; }
  if (threw) ok("a negative scalar is refused");
  else bad("a negative scalar was accepted");
}

console.log("=== 3) THE VIEW KEY ===");
{
  const halves = createHalves({ ed25519, secp256k1, keccak256, randomBytes: (n) => new Uint8Array(randomBytes(n)) });
  const half = halves.halfFromSeed(new Uint8Array(32).fill(7), "arrival-read-binding");
  const pub = halves.publicHalves(half).ed;
  eq("the key that built the point matches", viewKeyMatchesAddress(half, pub, halves), true);
  const other = halves.halfFromSeed(new Uint8Array(32).fill(8), "arrival-read-binding");
  eq("another key does not match", viewKeyMatchesAddress(other, pub, halves), false);
  eq("no expected key -> null", viewKeyMatchesAddress(half, "", halves), null);
}

console.log("=== 4) unlock_time ===");
{
  eq("zero is unlocked", unlockStateOf(0), { code: "unlocked", locked: false, untilHeight: null, untilTime: null });
  eq("a height not reached stays locked", unlockStateOf(100, { height: 99 }), { code: "locked_height", locked: true, untilHeight: 100, untilTime: null });
  eq("a height reached opens", unlockStateOf(100, { height: 100 }), { code: "unlocked", locked: false, untilHeight: 100, untilTime: null });
  eq("no height does not open a height lock", unlockStateOf(100, { height: null }), { code: "locked_height", locked: true, untilHeight: 100, untilTime: null });
  const time = 1_800_000_000;
  eq("a time in the future is locked", unlockStateOf(time, { nowSec: time - 10 }), { code: "locked_time", locked: true, untilHeight: null, untilTime: time });
  eq("a time passed opens", unlockStateOf(time, { nowSec: time + 10 }), { code: "unlocked", locked: false, untilHeight: null, untilTime: time });
  eq("the boundary itself is a TIME, not a height", unlockStateOf(UNLOCK_TIME_BLOCK_MAX, { height: 999_999_999, nowSec: 0 }).code, "locked_time");
}

function mutatedFrom(modulePath, mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-arrival-read-"));
  const source = mutate(readFileSync(modulePath, "utf8").replace(/\r\n/g, "\n"));
  const rewritten = source.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) => `from "${pathToFileURL(join(dirname(modulePath), rel)).href}"`);
  const file = join(dir, name + ".mjs");
  writeFileSync(file, rewritten, "utf8");
  return { file, dir };
}
const mutated = (mutate, name) => mutatedFrom(MODULE, mutate, name);
const importFresh = (p) => import(pathToFileURL(p).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 5) BREAKING RUN A: high byte first -> case 2 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("for (let i = 0; i < size; i++) { out[i] = Number(rest & 0xffn); rest >>= 8n; }",
      "for (let i = 0; i < size; i++) { out[size - 1 - i] = Number(rest & 0xffn); rest >>= 8n; }");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const mod = await importFresh(file);
    const got = mod.scalarToLeHex(1);
    if (got !== "01" + "00".repeat(31)) ok("breaking run A REDDENS: 1 became " + JSON.stringify(got.slice(0, 6)) + "...");
    else bad("breaking run A does not redden");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 6) BREAKING RUN B: the boundary treated as a height -> case 4 reddens ===");
{
  const { file, dir } = mutatedFrom(UNLOCK_MODULE, (src) => {
    const before = src;
    src = src.replace("if (u >= UNLOCK_TIME_BLOCK_MAX) {", "if (u > UNLOCK_TIME_BLOCK_MAX) {");
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "b");
  try {
    const mod = await importFresh(file);
    const got = mod.unlockStateOf(mod.UNLOCK_TIME_BLOCK_MAX, { height: 999_999_999, nowSec: 0 });
    if (got.code !== "locked_time") ok("breaking run B REDDENS: the boundary became " + JSON.stringify(got.code));
    else bad("breaking run B does not redden: still a time");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 7) BREAKING RUN C: matches unconditionally -> case 3 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("return got === want;", "return true;");
    if (src === before) throw new Error("mutation C did not apply");
    return src;
  }, "c");
  try {
    const mod = await importFresh(file);
    const halves = createHalves({ ed25519, secp256k1, keccak256, randomBytes: (n) => new Uint8Array(randomBytes(n)) });
    const one = halves.halfFromSeed(new Uint8Array(32).fill(7), "arrival-read-binding");
    const two = halves.halfFromSeed(new Uint8Array(32).fill(8), "arrival-read-binding");
    const got = mod.viewKeyMatchesAddress(two, halves.publicHalves(one).ed, halves);
    if (got !== false) ok("breaking run C REDDENS: another key reported " + JSON.stringify(got));
    else bad("breaking run C does not redden");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "arrival read: " + pass + " checks passed.");
if (fails.length) process.exit(1);
