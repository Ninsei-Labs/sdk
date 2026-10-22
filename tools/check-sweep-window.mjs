// THE WITHDRAWAL WINDOW (sdk#76, item 4): scan the blocks around the lock, not all history.
//
// The rule is only useful if the wallet is at the tip, `scanTxs` is the call that ran, and a rescan did NOT follow
// it (the measured failure: rescanBlockchain wipes the output scanTxs found). The empty-window fallback is checked
// too, because "not found" must not become "no funds".
//
// BREAKING RUNS: the window path is bypassed by a copy of the module in the same shape the other checks use.
import { restoreWallet, windowTxHashes } from "../src/sweep-restore.mjs";

const fake = ({ balance = 0n, scanTxs = true, scanFails = false } = {}) => {
  const calls = [];
  const driver = {
    async setRestoreHeight(height) { calls.push(["height", Number(height)]); },
    async getBalance() { return balance; },
    async getHeight() { return 1000; },
    async getDaemonHeight() { return 1000; },
    async rescanBlockchain() { calls.push(["rescan"]); },
  };
  if (scanFails) driver.scanTxs = async () => { calls.push(["scan-failed"]); throw new Error("Failed to get transaction from daemon"); };
  else if (scanTxs) driver.scanTxs = async (hashes) => { calls.push(["scan", hashes.length]); };
  return {
    calls,
    wallet: { async sync() {}, async unlockedBalance() { return balance; }, driver: () => driver },
  };
};

export const sweepWindowCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  const found = fake({ balance: 5n });
  const one = await restoreWallet({ wallet: found.wallet, fromHeight: 100,
    window: { txHashes: ["a", "b"], toHeight: 110, tipHeight: 900 } });
  check(one.total === "5" && one.unlocked === "5", `the window balance is ${one.total}/${one.unlocked}`);
  check(one.window && one.window.used === true, "the window was not marked as used");
  check(one.window && one.window.fallback === false, "a used window was marked as a fallback");
  check(found.calls.some((call) => call[0] === "scan" && call[1] === 2), "scanTxs did not receive both hashes");
  check(found.calls.some((call) => call[0] === "height" && call[1] === 900), "the wallet was not set at the tip");
  check(!found.calls.some((call) => call[0] === "rescan"), "a rescan followed scanTxs and would wipe the result");
  notes.push("a window with coins uses scanTxs and skips the rescan");

  const empty = fake({ balance: 0n });
  const fallback = await restoreWallet({ wallet: empty.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 900 } });
  check(fallback.total === "0" && empty.calls.some((call) => call[0] === "rescan"), "an empty window did not fall back to the full scan");
  check(fallback.window && fallback.window.fallback === true, "an empty window did not report the fallback");
  check(empty.calls.some((call) => call[0] === "height" && call[1] === 90), "the full scan did not start below the order height");
  notes.push("an empty window falls back to the full scan");

  const withImages = fake({ balance: 5n });
  const nodeCalls = [];
  withImages.wallet.driver().getKeyImages = async () => [{ getHex: () => "aa" }, { getHex: () => "bb" }];
  const spent = await restoreWallet({ wallet: withImages.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example" },
    fetchImpl: async (url, options) => { nodeCalls.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ spent_status: [false, true] }) }; },
  });
  check(spent.window && spent.window.spent === 1 && spent.window.keyImages === 2,
    `the spent check reported ${JSON.stringify(spent.window)}`);
  check(nodeCalls.length === 1 && nodeCalls[0][0].endsWith("/is_key_image_spent"), "the key images were not checked at the node");

  const noScan = fake({ balance: 5n, scanTxs: false });
  const skipped = await restoreWallet({ wallet: noScan.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 900 } });
  check(skipped.window && skipped.window.skipped === "no-scan-txs", "a wallet without scanTxs did not name the skip");
  check(skipped.window && skipped.window.fallback === true, "a skipped window did not report the fallback");
  check(skipped.total === "5", "the fallback did not read the balance");
  notes.push("a wallet without scanTxs falls back and names it");

  const fetched = await windowTxHashes({
    nodeUrl: "https://node.example", fromHeight: 10, toHeight: 12,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ result: { tx_hashes: ["h" + body.params.height] } }) };
    },
  });
  check(JSON.stringify(fetched) === JSON.stringify(["h10", "h11", "h12"]), `windowTxHashes returned ${JSON.stringify(fetched)}`);
  notes.push("the SDK can collect the window's tx hashes from a node");

  // A 429 IS RETRIED BEFORE THE WINDOW IS ABANDONED. The node's own burst limit answers 429 while the page is
  // still healthy; one refusal used to end a withdrawal.
  let rateCalls = 0;
  const slept = [];
  const afterRetry = await windowTxHashes({
    nodeUrl: "https://node.example", fromHeight: 10, toHeight: 10,
    sleep: async (ms) => { slept.push(ms); },
    fetchImpl: async () => {
      rateCalls += 1;
      if (rateCalls === 1) return { ok: false, status: 429, headers: { get: () => "0" } };
      return { ok: true, json: async () => ({ result: { tx_hashes: ["after-429"] } }) };
    },
  });
  check(JSON.stringify(afterRetry) === JSON.stringify(["after-429"]), "a 429 was not retried into a success");
  check(rateCalls === 2, `a 429 was read ${rateCalls} times instead of twice`);
  check(slept.length === 1 && slept[0] === 0, "Retry-After was not honoured");

  // EXHAUSTED RETRIES ARE A WINDOW REFUSAL, AND restoreWallet TURNS IT INTO THE FULL-SCAN FALLBACK.
  let failed = null;
  try {
    await windowTxHashes({
      nodeUrl: "https://node.example", fromHeight: 10, toHeight: 10, attempts: 2,
      sleep: async () => {},
      fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => "0" } }),
    });
  } catch (e) { failed = e; }
  check(failed && failed.code === "wallet-rejected" && failed.params && failed.params.status === 429, "an exhausted 429 was not a wallet-rejected refusal");

  const readFailed = fake({ balance: 7n });
  const fallbackOnRead = await restoreWallet({
    wallet: readFailed.wallet, fromHeight: 100,
    window: { nodeUrl: "https://node.example", toHeight: 110, tipHeight: 900, fallback: false },
    fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => "0" } }),
  });
  check(fallbackOnRead.total === "7", "a failed window read did not reach the full scan");
  check(fallbackOnRead.window && fallbackOnRead.window.fallback === true, "a failed window read did not report the fallback");
  check(fallbackOnRead.window && fallbackOnRead.window.fallbackWhy === "window-read", "a failed window read did not name the reason");
  check(fallbackOnRead.window && fallbackOnRead.window.error && fallbackOnRead.window.error.status === 429, "the window report lost the node status");
  check(readFailed.calls.some((call) => call[0] === "rescan"), "the full scan did not run after the failed window");
  notes.push("a failed window read falls back to the full scan and keeps the node status");

  // A WINDOW THAT WAS READ BUT COULD NOT BE APPLIED IS ALSO A FAILED WINDOW. `scanTxs` talks to the node's
  // `/gettransactions`; a proxy that misses that route must cost time, not the withdrawal.
  const scanFailed = fake({ balance: 9n, scanFails: true });
  const afterScanFailure = await restoreWallet({
    wallet: scanFailed.wallet, fromHeight: 100,
    window: { txHashes: ["a", "b"], toHeight: 110, tipHeight: 900 },
  });
  check(afterScanFailure.total === "9", `a failed scan did not reach the full scan: ${afterScanFailure.total}`);
  check(afterScanFailure.window && afterScanFailure.window.fallback === true, "a failed scan did not report the fallback");
  check(afterScanFailure.window && afterScanFailure.window.fallbackWhy === "window-scan", "a failed scan did not name the step");
  check(afterScanFailure.window && afterScanFailure.window.error && afterScanFailure.window.error.surface === "scanTxs",
    "a failed scan lost the surface");
  check(scanFailed.calls.some((call) => call[0] === "rescan"), "the full scan did not run after the failed scan");
  notes.push("a failed scanTxs falls back to the full scan and names the step");

  return { note: "the withdrawal window scans only the lock and falls back on an empty or unreadable one", problems, notes };
};
