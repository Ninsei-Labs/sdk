// THE WITHDRAWAL RELAY: A LOST ANSWER IS AN UNKNOWN OUTCOME, NOT A LOST SIGNATURE.
//
// `sweep.sign` holds the signed transactions under a session token. `sweep.relay` sends them. If the wallet
// throws or returns no transaction id, the core cannot know whether the transfer left. The session must stay
// open, the answer must be `sweep-relay-unknown`, and the same token must not relay the signed set a second time.
//
// The wallet is a stand-in; the recovery file is built by the engine itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSweep } from "../src/sweep.mjs";
import * as engine from "../src/engine.mjs";

const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";
const PASSPHRASE = "sweep-relay-test-pass";

async function planRequest() {
  const payload = engine.recoveryFile.buildPayload({
    swap: {
      id: "sweep-relay", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
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
  return { file: { contents: await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE) }, passphrase: PASSPHRASE, to: ADDRESS };
}

const http = { async json(url, options) {
  if (options === undefined) return [{ address: ADDRESS, restoreHeight: 2_206_635 }];
  return { ok: true, revealed: true, half: "0x" + "ab".repeat(32) };
} };
const config = { route: (name) => "http://app.invalid/" + name };

function wallet({ relay } = {}) {
  const calls = { open: 0, sync: 0, unlockedBalance: 0, sweepUnlocked: 0, relay: 0, close: 0 };
  const driver = {
    async setRestoreHeight() {}, async rescanBlockchain() {},
    async getBalance() { return 5_000_000_000_000n; },
    async getHeight() { return 100; }, async getDaemonHeight() { return 100; },
  };
  return {
    calls, driver,
    async open() { calls.open += 1; },
    async sync() { calls.sync += 1; },
    async unlockedBalance() { calls.unlockedBalance += 1; return 5_000_000_000_000n; },
    async sweepUnlocked() { calls.sweepUnlocked += 1; return [{ signed: true }]; },
    async fee() { return 30_000_000n; },
    async relay(signed) { calls.relay += 1; return relay ? await relay(signed) : ["tx-1"]; },
    async close() { calls.close += 1; },
    driver: () => driver,
  };
}

async function opened(sweep, adapter) {
  await sweep.restore({ wallet: adapter, fromHeight: 100 });
  return await sweep.sign({ ...(await planRequest()), wallet: adapter });
}

test("a relay answer is reported as sent and closes the session", async () => {
  const adapter = wallet();
  const sweep = createSweep({ http, config });
  const openedResult = await opened(sweep, adapter);
  const result = await sweep.relay({ token: openedResult.token });
  assert.equal(result.outcome, "sent");
  assert.deepEqual(result.txids, ["tx-1"]);
  assert.equal(adapter.calls.relay, 1);
  assert.equal(adapter.calls.close, 1);
});

test("a lost answer keeps the session and reports unknown", async () => {
  const adapter = wallet({ relay: async () => { throw new Error("answer lost"); } });
  const sweep = createSweep({ http, config });
  const openedResult = await opened(sweep, adapter);

  await assert.rejects(sweep.relay({ token: openedResult.token }), (error) => {
    assert.equal(error.code, "sweep-relay-unknown");
    assert.equal(error.params.token, openedResult.token);
    assert.equal(error.params.outcome, "unknown");
    return true;
  });
  assert.equal(adapter.calls.relay, 1);
  assert.equal(adapter.calls.close, 1);

  // The same token must not send the signed set a second time.
  await assert.rejects(sweep.relay({ token: openedResult.token }), (error) => {
    assert.equal(error.code, "sweep-relay-unknown");
    assert.equal(error.params.why, "already-attempted");
    return true;
  });
  assert.equal(adapter.calls.relay, 1);
});

test("an answer without a transaction id is unknown, not sent", async () => {
  const adapter = wallet({ relay: async () => [] });
  const sweep = createSweep({ http, config });
  const openedResult = await opened(sweep, adapter);
  await assert.rejects(sweep.relay({ token: openedResult.token }), (error) => {
    assert.equal(error.code, "sweep-relay-unknown");
    assert.equal(error.params.why, "answer-txid");
    return true;
  });
  assert.equal(adapter.calls.relay, 1);
  assert.equal(adapter.calls.close, 1);
});
