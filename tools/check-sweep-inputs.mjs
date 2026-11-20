// SIGNED INPUTS ARE THE UNSPENT INPUTS, EXACTLY.
//
// The page used to parse the signed transaction itself and compare its key images with the unspent set it verified.
// That parser is format-sensitive; the SDK owns the comparison now. A missing or unreadable input set is a refusal,
// and `relay` checks the set again before the signed bytes leave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSweep } from "../src/sweep.mjs";
import * as engine from "../src/engine.mjs";

const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";
const IMAGE_A = "aa".repeat(32);
const IMAGE_B = "bb".repeat(32);
const PASSPHRASE = "sweep-inputs-pass";

async function planRequest(keyImages = [IMAGE_A]) {
  const payload = engine.recoveryFile.buildPayload({
    swap: {
      id: "sweep-inputs", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
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
  return {
    file: { contents: await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE) },
    passphrase: PASSPHRASE, to: ADDRESS, keyImages,
  };
}

const signedTx = (images) => ({
  getInputs: () => images.map((image) => ({ getKeyImage: () => ({ getHex: () => image }) })),
});

function wallet({ signed = signedTx([IMAGE_A]), walletHeight = 200, nodeHeight = 200 } = {}) {
  const calls = { sweepUnlocked: 0, relay: 0 };
  const driver = {
    async setRestoreHeight() {}, async rescanBlockchain() {},
    async getBalance() { return 5_000_000_000_000n; },
    async getHeight() { return walletHeight; }, async getDaemonHeight() { return nodeHeight; },
  };
  return {
    calls,
    async open() {}, async sync() {}, async unlockedBalance() { return 5_000_000_000_000n; },
    async sweepUnlocked() { calls.sweepUnlocked += 1; return signed; },
    async relay() { calls.relay += 1; return ["tx-1"]; },
    async close() {}, async fee() { return 30_000_000n; },
    driver: () => driver,
  };
}

async function restored(sweep, adapter) {
  return await sweep.restore({ wallet: adapter, fromHeight: 100 });
}

test("sign accepts the exact unspent key images", async () => {
  const sweep = createSweep({});
  const adapter = wallet();
  await restored(sweep, adapter);
  const result = await sweep.sign({ ...(await planRequest()), wallet: adapter });
  assert.equal(typeof result.token, "string");
  assert.equal(adapter.calls.sweepUnlocked, 1);
});

test("sign accepts key-image records from sweep.keyImages", async () => {
  const sweep = createSweep({});
  const adapter = wallet();
  await restored(sweep, adapter);
  const result = await sweep.sign({ ...(await planRequest([{ keyImage: IMAGE_A, outputKey: "cc".repeat(32) }])), wallet: adapter });
  assert.equal(typeof result.token, "string");
});

test("sign refuses a signed input set that differs from the verified set", async () => {
  const sweep = createSweep({});
  const adapter = wallet({ signed: signedTx([IMAGE_B]) });
  await restored(sweep, adapter);
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter }), (error) => {
    assert.equal(error.code, "sweep-inputs-changed");
    assert.equal(error.params.expected, 1);
    assert.equal(error.params.signed, 1);
    return true;
  });
  assert.equal(adapter.calls.relay, 0);
});

test("sign refuses when the signed transaction exposes no inputs", async () => {
  const sweep = createSweep({});
  const adapter = wallet({ signed: { signed: true } });
  await restored(sweep, adapter);
  await assert.rejects(sweep.sign({ ...(await planRequest()), wallet: adapter }), (error) => {
    assert.equal(error.code, "sweep-inputs-unknown");
    return true;
  });
  assert.equal(adapter.calls.relay, 0);
});

test("relay refuses when the fresh unspent set changed", async () => {
  const sweep = createSweep({});
  const adapter = wallet();
  await restored(sweep, adapter);
  const opened = await sweep.sign({ ...(await planRequest()), wallet: adapter });
  await assert.rejects(sweep.relay({ token: opened.token, keyImages: [IMAGE_B] }), (error) => {
    assert.equal(error.code, "sweep-inputs-changed");
    assert.equal(error.params.phase, "relay");
    return true;
  });
  assert.equal(adapter.calls.relay, 0);
  // The session is still usable after a refused relay check, and the same signed bytes may leave with the right set.
  const sent = await sweep.relay({ token: opened.token, keyImages: [IMAGE_A] });
  assert.deepEqual(sent.txids, ["tx-1"]);
  assert.equal(adapter.calls.relay, 1);
});
