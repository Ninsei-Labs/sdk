#!/usr/bin/env node
// OPT-IN LIVE SMOKE FOR THE PRIMARY RECOVERY READ.
//
// The deterministic checkpoint/reorg/stall tests use a fake daemon. This one proves that the same code speaks to a
// real plain monerod: one get_info, a real range and real progress events. It uses a throwaway address, so it does
// not depend on a particular swap; the recorded real-exchange acceptance is a later, separate layer.
//
// Run: RECOVERY_LIVE_NODE=http://127.0.0.1:38281 node tools/check-recovery-read-live.mjs
import { readRecovery } from "../src/xmr-arrival.mjs";
import { fromSeed } from "../engine/monero/keys.js";
import { addressFromKeys } from "../engine/monero/address.js";
import { keccak256 } from "../src/primitives.mjs";

const url = process.env.RECOVERY_LIVE_NODE;
if (!url) {
  console.log("recovery live: skipped (set RECOVERY_LIVE_NODE)");
  process.exit(0);
}
const wallet = fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 9));
const address = addressFromKeys({
  network: process.env.RECOVERY_LIVE_NETWORK || "testnet",
  spendPub: Buffer.from(wallet.publicSpendKey).toString("hex"),
  viewPub: Buffer.from(wallet.publicViewKey).toString("hex"),
}, { keccak256 });
const info = await (await fetch(url.replace(/\/+$/, "") + "/json_rpc", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "live", method: "get_info" }),
})).json();
const tip = Number(info.result && info.result.height);
if (!Number.isSafeInteger(tip) || tip < 2) throw new Error("the live node has no usable height");
const progress = [];
const result = await readRecovery({
  node: { url, operator: "live" }, address,
  viewSecret: Buffer.from(wallet.privateViewKey).toString("hex"),
  spendPub: Buffer.from(wallet.publicSpendKey).toString("hex"),
  fromHeight: Math.max(0, tip - 2), idleTimeoutMs: 8000,
  onProgress: (event) => progress.push(event),
});
if (result.complete !== true || result.transfers.length !== 0) {
  throw new Error("the live primary read did not complete cleanly: " + JSON.stringify(result.failed));
}
if (!progress.length || progress.at(-1).blocksVerified < 1 || progress.at(-1).bytes <= 0) {
  throw new Error("the live primary read did not report blocks and bytes");
}
console.log("recovery live: one real plain-monerod read is complete (" + progress.at(-1).blocksVerified + " blocks)");
