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

// BREAKING RUN: the old truncation, in a copy with no imports.
const dir = mkdtempSync(join(tmpdir(), "sdk-sweep-half-"));
const broken = join(dir, "sweep-half.mjs");
writeFileSync(broken, readFileSync(join(process.cwd(), "src/sweep-half.mjs"), "utf8")
  .replace('return "0x" + hex;', 'return "0x" + hex.slice(24);'));
const mutated = await import(pathToFileURL(broken).href + "?run=" + Date.now());
assert.notEqual(mutated.revealedHalfWord(WORD), WORD, "the old 20-byte truncation must redden this guard");

console.log("sweep-half: passed (full word, zero/short refused, plan uses the full word, breaking run red)");
