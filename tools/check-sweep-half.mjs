#!/usr/bin/env node
// A REVEALED HALF IS 32 BYTES. The escrow answers `revealedHalf()` with one ABI word; the withdrawal path used to keep only
// its last 20 bytes as if it were an address, so the key check could not match and every real withdrawal was refused.
//
// This guard calls the parser with the exact chain word, calls `sweep.plan` on a real recovery file and asserts the plan
// carries the whole word, and breaks the parser in a temporary copy to prove the case reddens.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSweep } from "../src/sweep.mjs";
import { revealedHalfWord } from "../src/sweep-half.mjs";
import * as engine from "../src/engine.mjs";
import { primitives } from "../src/primitives.mjs";

const WORD = "0x0234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpENBS4D4mEPcRq";
const PASSPHRASE = "a long enough passphrase";

const payload = engine.recoveryFile.buildPayload({
  swap: {
    id: "sweep-half", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
    createdAt: new Date(0).toISOString(), payToken: "USDC", payAmount: 1, xmrAmount: 0.5,
    escrow: { address: "0x00000000000000000000000000000000000000e5", termsHash: null },
  },
  swapWallet: {
    source: "unit", library: "monero-ts", network: "stagenet", address: ADDRESS,
    spendHalf: "0x" + "11".repeat(32), viewHalf: "0x" + "22".repeat(32),
    otherSpendPoint: "0x" + "33".repeat(32), otherViewPoint: "0x" + "44".repeat(32),
    otherViewHalf: "0x" + "55".repeat(32),
  },
  escrow: { address: "0x00000000000000000000000000000000000000e5" },
  receiveAddress: ADDRESS,
  restoreHeight: 2_206_635,
});
engine.recoveryFile.validatePayload(payload);
const contents = await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE);

const sweep = createSweep({
  http: { async json() { return []; } }, config: { route: (name) => name },
  call: async () => WORD,
});
const plan = await sweep.plan({ file: { contents }, passphrase: PASSPHRASE });
assert.equal(plan.revealedHalf, true);
assert.equal(plan.half, WORD, "the plan must carry all 32 bytes, not an address-sized tail");
assert.equal(revealedHalfWord(WORD), WORD);
assert.equal(revealedHalfWord("0x" + "0".repeat(64)), null, "a zero word is not a revealed half");
assert.equal(revealedHalfWord("0x1234"), null, "a short word is not a revealed half");

// A KNOWN HALF IS USED AS-IS: NO CHAIN CALL, NO ESCROW NAMED TO THE RPC. The site already has the half from
// HalfRevealed; the SDK must not require its internal selector/call shape just to feed the key check.
{
  let calls = 0;
  const known = "0x" + "aa".repeat(32);
  const local = createSweep({
    http: { async json() { return []; } }, config: { route: (name) => name },
    call: async () => { calls += 1; return WORD; },
  });
  const knownPlan = await local.plan({ file: { contents }, passphrase: PASSPHRASE, revealedHalf: known });
  assert.equal(calls, 0, "a supplied revealed half still made an escrow call");
  assert.equal(knownPlan.half, known);
  assert.equal(knownPlan.revealedHalf, true);
  await assert.rejects(
    () => local.plan({ file: { contents }, passphrase: PASSPHRASE, revealedHalf: "0x1234" }),
    (error) => error && error.code === "bad-input" && error.params && error.params.field === "revealedHalf",
    "a malformed supplied half was not refused by name",
  );
  assert.equal(calls, 0, "a malformed supplied half fell back to an escrow call");
}

// THE SAME KEYS FROM THE CHAIN AND FROM A HALF THE CALLER ALREADY HOLDS. Build a payload whose points really
// match the scalar under test, so the SDK's (s_a + s_b)*G check passes rather than being bypassed.
{
  const halves = engine.halves.createHalves(primitives);
  const other = 456n;
  const scalar = (value) => "0x" + value.toString(16).padStart(64, "0");
  const otherHalf = scalar(other);
  const otherPoint = halves.publicHalves(other).ed;
  const knownPayload = engine.recoveryFile.buildPayload({
    swap: {
      id: "sweep-known-half", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
      createdAt: new Date(0).toISOString(), payToken: "USDC", payAmount: 1, xmrAmount: 0.5,
      escrow: { address: "0x00000000000000000000000000000000000000e5", termsHash: null },
    },
    swapWallet: {
      source: "unit", library: "monero-ts", network: "stagenet", address: ADDRESS,
      spendHalf: scalar(123n), viewHalf: scalar(789n),
      otherSpendPoint: otherPoint, otherViewPoint: "0x" + "44".repeat(32), otherViewHalf: scalar(321n),
      escrowAddress: "0x00000000000000000000000000000000000000e5",
    },
    escrow: { address: "0x00000000000000000000000000000000000000e5" },
    receiveAddress: ADDRESS,
    restoreHeight: 2_206_635,
  });
  engine.recoveryFile.validatePayload(knownPayload);
  const knownContents = await engine.recoveryFile.createRecoveryFile(knownPayload, PASSPHRASE);
  const chainSweep = createSweep({
    http: { async json() { return []; } }, config: { route: (name) => name },
    call: async () => otherHalf,
  });
  const chainKeys = await chainSweep.keys({ file: { contents: knownContents }, passphrase: PASSPHRASE });
  let calls = 0;
  const localSweep = createSweep({
    http: { async json() { return []; } }, config: { route: (name) => name },
    call: async () => { calls += 1; return otherHalf; },
  });
  const knownKeys = await localSweep.keys({
    file: { contents: knownContents }, passphrase: PASSPHRASE, revealedHalf: otherHalf,
  });
  assert.equal(calls, 0, "keys with a known half made an escrow call");
  assert.deepEqual(knownKeys, chainKeys, "the keys differ between the chain half and the supplied half");

  const wrongHalf = "0x" + (other + 1n).toString(16).padStart(64, "0");
  await assert.rejects(
    () => localSweep.keys({ file: { contents: knownContents }, passphrase: PASSPHRASE, revealedHalf: wrongHalf }),
    (error) => error && error.code === "bad-input" && error.params && error.params.step === "verify",
    "a half from another order was not refused with step verify",
  );
}


// BREAKING RUN: the old truncation, in a copy with no imports.
const dir = mkdtempSync(join(tmpdir(), "sdk-sweep-half-"));
const broken = join(dir, "sweep-half.mjs");
writeFileSync(broken, readFileSync(join(process.cwd(), "src/sweep-half.mjs"), "utf8")
  .replace('return "0x" + hex;', 'return "0x" + hex.slice(24);'));
const mutated = await import(pathToFileURL(broken).href + "?run=" + Date.now());
assert.notEqual(mutated.revealedHalfWord(WORD), WORD, "the old 20-byte truncation must redden this guard");

// A HALF PLUS THE SECP256K1 ORDER IS THE SAME HALF ON THE CURVE THE CONTRACT USES. The escrow accepts h + n in
// claim/refund; the sweep must reduce the word before adding it to our own half.
{
  const halves = engine.halves.createHalves(primitives);
  const own = 123n;
  const other = 456n;
  const request = {
    halves, ownSpendHalf: own, ownViewHalf: 789n,
    otherSpendPoint: halves.publicHalves(other).ed, otherViewHalf: 999n,
    revealedHalf: other,
  };
  const real = engine.halvesSweep.spendKeysFromRevealedHalf(request);
  const alias = engine.halvesSweep.spendKeysFromRevealedHalf({ ...request, revealedHalf: other + halves.SECP_ORDER });
  assert.equal(alias.privateSpendKey, real.privateSpendKey, "the contract's accepted alias h + n must rebuild the same spend key");
  assert.equal(alias.privateViewKey, real.privateViewKey, "the alias changed the view key");
}

console.log("  ok    plan/keys use a supplied revealed half without an escrow call");
console.log("  ok    keys match the chain half; a wrong half is refused at verify");
console.log("sweep-half: passed (full word, zero/short refused, plan uses the full word, known half, breaking run red)");
