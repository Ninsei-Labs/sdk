// Synthetic responses in monerod's documented domain: 0 unspent, 1 spent in a block, 2 spent in the pool.
// https://www.getmonero.org/resources/developer-guides/daemon-rpc.html#is_key_image_spent
import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreWallet } from "../src/sweep-restore.mjs";

const images = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
const cases = [
  ["unspent", [0, 0, 0], 0], ["block spend", [0, 1, 0], 1],
  ["pool spend", [0, 1, 2], 2],
  ...[[0, 1], [0, 1, 2, 0], [0, 1, 3], [0, 1, true], [0, 1, null], [0, 1, "1"]]
    .map((values) => ["unknown " + JSON.stringify(values), values, null]),
];
for (const [name, spent_status, expected] of cases) test(name, async () => {
  const requests = [];
  const driver = { async setRestoreHeight() {}, async getBalance() { return 5n; }, async getHeight() { return 1000; },
    async getDaemonHeight() { return 1000; }, async scanTxs() {}, async getKeyImages() { return images.map((key) => ({ getHex: () => key })); } };
  const wallet = { driver: () => driver, async sync() {}, async unlockedBalance() { return 5n; } };
  const result = await restoreWallet({ wallet, fromHeight: 100,
    window: { txHashes: ["dd".repeat(32)], toHeight: 110, tipHeight: 1000, nodeUrl: "https://node.example", trustedNode: true },
    fetchImpl: async (url, init) => { requests.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({ spent_status }) }; },
  });
  assert.deepEqual(requests, [["https://node.example/is_key_image_spent", { key_images: images }]]);
  assert.equal(result.window.keyImages, 3);
  assert.equal(result.window.spent, expected, "all three statuses must be known before reporting a spent count");
  assert.equal(result.scanComplete, expected !== null);
  if (expected === null) assert.equal(result.scanIncompleteReason, "spent-status-unavailable");
});
