#!/usr/bin/env node
// A RECOVERY FILE OPENS FROM ITS TEXT. `restoreFromFile` takes the parsed envelope, while the interface hands the
// SDK a string or `{ contents }`; passing the text through made every valid file fail as `stage: "restore"`.
//
// Run: node tools/check-recovery-open.mjs
import { createRecovery } from "../src/recovery.mjs";
import * as engine from "../src/engine.mjs";
import { primitives } from "../src/primitives.mjs";
import { swapAddressFromHalves } from "../engine/monero/swapKeys.js";
import { addressFromKeys } from "../engine/monero/address.js";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const PASSPHRASE = "recovery-open-test-pass";
const hex = (n) => "0x" + n.toString(16).padStart(64, "0");

// A REAL v3 FILE, built from halves whose joint address is checked by the same engine code the page uses.
const halves = engine.halves.createHalves(primitives);
const ownSpend = 11n;
const ownView = 22n;
const otherSpend = 33n;
const otherView = 44n;
const otherSpendPoint = halves.publicHalves(otherSpend).ed;
const otherViewPoint = halves.publicHalves(otherView).ed;
const built = swapAddressFromHalves({
  halves, addressFromKeys, deps: { keccak256: primitives.keccak256 },
  ownSpendHalf: ownSpend, ownViewHalf: ownView, otherSpendPoint, otherViewPoint, network: "stagenet",
});
const payload = engine.recoveryFile.buildPayload({
  swap: {
    id: "recovery-open", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
    createdAt: new Date(0).toISOString(), payToken: "USDC", payAmount: 1, xmrAmount: 0.5,
    escrow: { address: "0x00000000000000000000000000000000000000e5", termsHash: null },
  },
  swapWallet: {
    source: "unit", library: "monero-ts", network: "stagenet", address: built.address,
    spendHalf: hex(ownSpend), viewHalf: hex(ownView),
    otherSpendPoint, otherViewPoint, otherViewHalf: hex(otherView),
  },
  escrow: { address: "0x00000000000000000000000000000000000000e5" },
  receiveAddress: built.address,
  restoreHeight: 2_206_635,
});
engine.recoveryFile.validatePayload(payload);
const contents = await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE);
const recovery = createRecovery();

console.log("=== 1) A VALID FILE OPENS FROM TEXT AND FROM { contents } ===");
for (const [label, input] of [["text", contents], ["{ contents }", { contents }]]) {
  try {
    const opened = await recovery.open(input, PASSPHRASE);
    if (opened.address === built.address && opened.swapId === "recovery-open" && opened.spendable === false) {
      ok(`${label}: the address and swapId are read, and the halves wallet is not spendable`);
    } else bad(`${label}: ` + JSON.stringify(opened));
  } catch (error) {
    bad(`${label} refused: ` + error.code + " " + JSON.stringify(error.params || {}));
  }
}

console.log("=== 2) A FILE THAT IS NOT JSON NAMES THE PARSE STAGE ===");
{
  try {
    await recovery.open("{not json", PASSPHRASE);
    bad("a broken envelope was accepted");
  } catch (error) {
    if (error.code === "recovery-failed" && error.params && error.params.stage === "parse") ok("broken text -> recovery-failed, stage parse");
    else bad("broken text -> " + error.code + " " + JSON.stringify(error.params || {}));
  }
}

console.log("=== 3) A WRONG PASSPHRASE NAMES THE RESTORE STAGE ===");
{
  try {
    await recovery.open(contents, "a different passphrase");
    bad("a wrong passphrase opened the file");
  } catch (error) {
    if (error.code === "recovery-failed" && error.params && error.params.stage === "restore") ok("wrong passphrase -> recovery-failed, stage restore");
    else bad("wrong passphrase -> " + error.code + " " + JSON.stringify(error.params || {}));
  }
}

console.log("=== 4) NO FILE IS BAD INPUT ===");
try {
  await recovery.open(null, PASSPHRASE);
  bad("a missing file was accepted");
} catch (error) {
  if (error.code === "bad-input" && error.params && error.params.field === "file") ok("missing file -> bad-input, field file");
  else bad("missing file -> " + error.code + " " + JSON.stringify(error.params || {}));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "recovery open: " + pass + " checks passed.");
if (fails.length) process.exit(1);
