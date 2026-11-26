// A FUNDING RECORD MUST BE RECOVERABLE WITHOUT A HASH, AND AN AMBIGUOUS SEND MUST NOT BECOME A SECOND DEPOSIT.
//
// Run: node tools/check-funding-reconcile.mjs
import { createSwaps } from "../src/swaps.mjs";
import { createStore, memoryStorage } from "../engine/core/store.js";
import * as engine from "../src/engine.mjs";
import { ORDER_CREATED_TOPIC } from "../engine/evm/factory.js";

const factory = "0x" + "11".repeat(20);
const escrow = "0x" + "22".repeat(20);
const locker = "0x" + "33".repeat(20);
const claimer = "0x" + "44".repeat(20);
const txHash = "0x" + "aa".repeat(32);
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const statusAnswer = (funded = false) => "0x" + [funded ? 1 : 0, 0, 0, 0].map(word).join("");
const pad = (value) => "0x" + String(value).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
const log = (overrides = {}) => ({
  address: factory,
  topics: [ORDER_CREATED_TOPIC, pad(escrow), pad(locker), pad(claimer)],
  data: "0x" + "00".repeat(12 * 32),
  transactionHash: txHash,
  blockNumber: "0x2a",
  ...overrides,
});

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log("  ok    " + name); };
const bad = (name) => { failed += 1; console.log("  FAIL  " + name); };

function fixture({ status = statusAnswer(false), logs = [], receipt = null, nonce = null, escrowPatch = {} } = {}) {
  const store = createStore(memoryStorage());
  const swap = {
    id: "funding-reconcile-1",
    side: "buy",
    escrow: { address: escrow, factory, fundingPending: true, fundingReason: "not-sent",
      sendAttempted: true, sendNonce: 5, ...escrowPatch },
    order: { factory, locker },
    quote: { factory },
  };
  engine.swap.saveSwap(swap, store);
  const api = createSwaps({ store, mode: "live",
    call: async () => status,
    logs: async () => logs,
  });
  return { api, store, swap, wallet: nonce === null ? null
    : { nonce: async (_block, account) => { if (account !== locker) throw new Error("wrong nonce account"); return nonce; } } };
}

const check = async (name, body) => {
  try {
    const result = await body();
    if (result === true) ok(name);
    else bad(name + ": " + JSON.stringify(result));
  } catch (error) {
    bad(name + ": threw " + String(error && error.stack || error));
  }
};

await check("a funded escrow recovers a row even when the hash was never recorded", async () => {
  const { api, store } = fixture({ status: statusAnswer(true) });
  const result = await api.reconcileFunding({ id: "funding-reconcile-1" });
  const saved = engine.swap.getSwap("funding-reconcile-1", store);
  return result.state === "funded" && result.evidence === "escrow-status"
    && result.fundTx === null && saved && saved.escrow.funded === true
    && saved.escrow.fundingPending === false;
});

await check("OrderCreated recovers the transaction hash and block", async () => {
  const { api, store } = fixture({ logs: [log()] });
  const result = await api.reconcileFunding({ id: "funding-reconcile-1" });
  const saved = engine.swap.getSwap("funding-reconcile-1", store);
  return result.state === "funded" && result.evidence === "order-created"
    && result.fundTx === txHash && result.blockNumber === 42
    && saved && saved.escrow.fundTx === txHash && saved.escrow.funded === true;
});

await check("an empty chain with a send attempt stays unknown and never sends", async () => {
  const { api, store } = fixture();
  const result = await api.reconcileFunding({ id: "funding-reconcile-1" });
  const saved = engine.swap.getSwap("funding-reconcile-1", store);
  return result.state === "unknown" && result.reason === "hash-unrecorded"
    && result.fundTx === null && saved && saved.escrow.fundTx === undefined
    && saved.escrow.fundingPending === true;
});

await check("an unrecorded hash with a moved nonce reports the nonce evidence", async () => {
  const { api, wallet } = fixture({ nonce: 6 });
  const result = await api.reconcileFunding({ id: "funding-reconcile-1", wallet });
  return result.state === "unknown" && result.nonceBefore === 5 && result.nonceNow === 6
    && result.nonceMoved === true;
});

await check("an unchanged nonce is evidence, not permission to retry", async () => {
  const { api, wallet } = fixture({ nonce: 5 });
  const result = await api.reconcileFunding({ id: "funding-reconcile-1", wallet });
  return result.state === "unknown" && result.nonceMoved === false;
});

await check("a reverted receipt is not-funded when the escrow is empty", async () => {
  const { api } = fixture({ escrowPatch: { fundTx: txHash }, receipt: { status: "0x0", logs: [] } });
  const wallet = { receipt: async () => ({ status: "0x0", logs: [] }) };
  const result = await api.reconcileFunding({ id: "funding-reconcile-1", wallet });
  return result.state === "not-funded" && result.evidence === "receipt" && result.reason === "reverted";
});

await check("a record without a send attempt and without a hash is not-found", async () => {
  const { api } = fixture({ escrowPatch: { sendAttempted: false, fundingPending: false } });
  const result = await api.reconcileFunding({ id: "funding-reconcile-1" });
  return result.state === "not-found" && result.reason === "no-transaction-hash";
});

console.log(failed ? `FAILED: ${failed} funding reconcile checks` : `PASSED: ${passed} funding reconcile checks`);
process.exitCode = failed ? 1 : 0;
