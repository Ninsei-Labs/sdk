#!/usr/bin/env node
// OPT-IN LIVE SMOKE FOR THE PLAIN-DAEMON WITNESS READ.
//
// The deterministic witness check uses a fake daemon. This one proves the same fixed-window path against a real plain
// monerod: get_info, whole get_block heights and /get_transactions batches, with real progress and bytes.
//
// Run: RECOVERY_LIVE_NODE=http://127.0.0.1:38281 node tools/check-recovery-witness-live.mjs
import { readRecoveryWitness } from "../src/xmr-arrival.mjs";
import { fromSeed } from "../engine/monero/keys.js";
import { addressFromKeys } from "../engine/monero/address.js";
import { keccak256 } from "../src/primitives.mjs";

const url = process.env.RECOVERY_LIVE_NODE;
if (!url) {
  console.log("recovery witness live: skipped (set RECOVERY_LIVE_NODE)");
  process.exit(0);
}
const wallet = fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 9));
const network = process.env.RECOVERY_LIVE_NETWORK || "testnet";
const address = addressFromKeys({
  network,
  spendPub: Buffer.from(wallet.publicSpendKey).toString("hex"),
  viewPub: Buffer.from(wallet.publicViewKey).toString("hex"),
}, { keccak256 });
const info = await (await fetch(url.replace(/\/+$/, "") + "/json_rpc", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "live", method: "get_info" }),
})).json();
const height = Number(info.result && info.result.height);
if (!Number.isSafeInteger(height) || height < 6) throw new Error("the live node has no usable height");
const fromHeight = Math.max(0, height - 5);
const progress = [];
const result = await readRecoveryWitness({
  node: { url, operator: "live" }, address,
  viewSecret: Buffer.from(wallet.privateViewKey).toString("hex"),
  spendPub: Buffer.from(wallet.publicSpendKey).toString("hex"),
  network, fromHeight, tipHeight: height - 1, idleTimeoutMs: 8000,
  onProgress: (event) => progress.push(event),
});
if (result.complete !== true || result.transfers.length !== 0) {
  throw new Error("the live witness read did not complete cleanly: " + JSON.stringify(result.failed));
}
if (!progress.length || progress.at(-1).blocksVerified < 1 || progress.at(-1).bytes <= 0) {
  throw new Error("the live witness read did not report blocks and bytes");
}
console.log("recovery witness live: one real plain-monerod window is complete (" + progress.at(-1).blocksVerified + " blocks)");
