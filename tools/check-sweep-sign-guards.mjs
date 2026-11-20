// THE MONEY GUARDS BELONG TO SIGN, NOT TO THE PAGE.
//
// `sweep.restore` says whether a scan reached the node; `sweep.sign` must not sign without that fact.
// A split sweep is refused before relay. Both entry points check the destination with the same address module
// the rest of the SDK uses, and a full restore keeps working when the optional spent-status pass is unavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSweep } from "../src/sweep.mjs";
import { createSwaps } from "../src/swaps.mjs";
import * as engine from "../src/engine.mjs";

const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";
const MAINNET = "49HjJN4ZbLjDFqe3Mus7mPZBE6Q27cRGtPLfyuNejGdYZhvke36zj1xGq5kDCbSCXbc5TLTR7vygzVDYTcgFURLaLe4Gdds";
const PASSPHRASE = "sweep-sign-guard-pass";
const KEY_IMAGE = "aa".repeat(32);

async function planRequest() {
  const payload = engine.recoveryFile.buildPayload({
    swap: {
      id: "sweep-sign-guard", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
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
  return { file: { contents: await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE) }, passphrase: PASSPHRASE, to: ADDRESS, keyImages: [KEY_IMAGE] };
}

function wallet({ signed = [{ signed: true }], walletHeight = 200, nodeHeight = 200, balance = 5_000_000_000_000n, unlocked = 5_000_000_000_000n, rescanSpentFails = false, rescanSpentMissing = false, rescanFails = false } = {}) {
  const calls = { sweepUnlocked: 0, relay: 0, rescanSpent: 0 };
  const driver = {
    async setRestoreHeight() {},
    async rescanBlockchain() { if (rescanFails) throw new Error("rescan refused"); },
    async rescanSpent() { calls.rescanSpent += 1; if (rescanSpentFails) throw new Error("rescanSpent refused"); },
    async getBalance() { return balance; },
    async getHeight() { return walletHeight; },
    async getDaemonHeight() { return nodeHeight; },
  };
  if (rescanSpentMissing) delete driver.rescanSpent;
  return {
    calls, driver,
    async open() {}, async sync() {}, async unlockedBalance() { return unlocked; },
    async sweepUnlocked() { calls.sweepUnlocked += 1; return signed; },
    async relay() { calls.relay += 1; return ["tx-1"]; },
    async close() {},
    async fee() { return 30_000_000n; },
    driver: () => driver,
  };
}

async function restored(sweep, adapter, fromHeight = 100) {
  return await sweep.restore({ wallet: adapter, fromHeight });
}

test("checkAddress names the actual network in a wrong-network refusal", async () => {
  const result = await engine.xmrAddress.checkAddress(MAINNET, { expectNetwork: "stagenet" });
  assert.equal(result.ok, false);
  assert.equal(result.network, "mainnet");
});

test("sign without a complete restore refuses by name", async () => {
  const sweep = createSweep({});
  const adapter = wallet();
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter }), (error) => {
    assert.equal(error.code, "sweep-scan-incomplete");
    assert.equal(error.params.reason, "no-complete-scan");
    return true;
  });
  assert.equal(adapter.calls.sweepUnlocked, 0);
});

test("a complete restore on another adapter is not evidence for this wallet", async () => {
  const sweep = createSweep({});
  const scanned = wallet();
  const other = wallet();
  await restored(sweep, scanned);
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: other }), (error) => {
    assert.equal(error.code, "sweep-scan-incomplete");
    assert.equal(error.params.reason, "no-complete-scan");
    return true;
  });
  assert.equal(other.calls.sweepUnlocked, 0);
});

test("sign refuses a restore stopped behind the node", async () => {
  const sweep = createSweep({});
  const adapter = wallet({ walletHeight: 199, nodeHeight: 200 });
  const scan = await restored(sweep, adapter);
  assert.equal(scan.scanComplete, false);
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter }), (error) => {
    assert.equal(error.code, "sweep-scan-incomplete");
    assert.equal(error.params.reason, "behind-node");
    return true;
  });
  assert.equal(adapter.calls.sweepUnlocked, 0);
});

test("sign refuses a restore whose rescan failed", async () => {
  const sweep = createSweep({});
  const adapter = wallet({ rescanFails: true });
  const scan = await restored(sweep, adapter);
  assert.equal(scan.scanComplete, false);
  assert.equal(scan.scanIncompleteReason, "rescan-failed");
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter }), (error) => {
    assert.equal(error.code, "sweep-scan-incomplete");
    assert.equal(error.params.reason, "rescan-failed");
    return true;
  });
  assert.equal(adapter.calls.sweepUnlocked, 0);
});

test("a caller cannot turn a partial scan into a complete one", async () => {
  const sweep = createSweep({});
  const adapter = wallet({ walletHeight: 199, nodeHeight: 200 });
  const scan = await restored(sweep, adapter);
  scan.scanComplete = true;
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter }), (error) => {
    assert.equal(error.code, "sweep-scan-incomplete");
    assert.equal(error.params.reason, "behind-node");
    return true;
  });
  assert.equal(adapter.calls.sweepUnlocked, 0);
});

test("a driver without rescanSpent names the missing spent status on a locked balance", async () => {
  const sweep = createSweep({});
  const adapter = wallet({ balance: 5n, unlocked: 0n, rescanSpentMissing: true });
  const scan = await restored(sweep, adapter);
  assert.equal(scan.passes, 1);
  assert.equal(scan.lockedPass, true);
  assert.equal(scan.scanComplete, false);
  assert.equal(scan.scanIncompleteReason, "spent-status-unavailable");
});

test("an optional rescanSpent refusal continues the full scan and names the missing spent status", async () => {
  const sweep = createSweep({});
  const adapter = wallet({ balance: 5n, unlocked: 0n, rescanSpentFails: true });
  const scan = await restored(sweep, adapter);
  assert.equal(scan.total, "5");
  assert.equal(scan.unlocked, "0");
  assert.equal(scan.scanComplete, false);
  assert.equal(scan.scanIncompleteReason, "spent-status-unavailable");
});

test("sign refuses two signed transactions before relay", async () => {
  const sweep = createSweep({});
  const adapter = wallet({ signed: [{ signed: true }, { signed: true }] });
  await restored(sweep, adapter);
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter }), (error) => {
    assert.equal(error.code, "sweep-split");
    return true;
  });
  assert.equal(adapter.calls.relay, 0);
});

test("sign checks the destination network and checksum before signing", async () => {
  const sweep = createSweep({});
  const adapter = wallet();
  await restored(sweep, adapter);
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter, to: MAINNET }), (error) => {
    assert.equal(error.code, "wrong-chain");
    assert.equal(error.params.field, "to");
    return true;
  });
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter, to: ADDRESS.slice(0, -1) + "x" }), (error) => {
    assert.equal(error.code, "bad-input");
    assert.equal(error.params.field, "to");
    return true;
  });
  assert.equal(adapter.calls.sweepUnlocked, 0);
});

test("swaps.start checks receiveTo on the expected Monero network", async () => {
  const swaps = createSwaps({ xmrNetwork: "stagenet" });
  const wrongNetwork = await swaps.start({ receiveTo: MAINNET, recoveryKey: "test" }).catch((error) => error);
  assert.equal(wrongNetwork.code, "wrong-chain");
  assert.equal(wrongNetwork.params.field, "receiveTo");
  const badChecksum = await swaps.start({ receiveTo: ADDRESS.slice(0, -1) + "x", recoveryKey: "test" }).catch((error) => error);
  assert.equal(badChecksum.code, "bad-input");
  assert.equal(badChecksum.params.field, "receiveTo");
});
