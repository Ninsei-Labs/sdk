// THE WITHDRAWAL WINDOW (sdk#76, item 4): scan the blocks around the lock, not all history.
//
// The rule is only useful if the wallet is at the tip, `scanTxs` is the call that ran, and a rescan did NOT follow
// it (the measured failure: rescanBlockchain wipes the output scanTxs found). The empty-window fallback is checked
// too, because "not found" must not become "no funds".
//
// BREAKING RUNS: the window path is bypassed by a copy of the module in the same shape the other checks use.
import { restoreWallet, windowTxHashes } from "../src/sweep-restore.mjs";

const fake = ({ balance = 0n, scanTxs = true } = {}) => {
  const calls = [];
  const driver = {
    async setRestoreHeight(height) { calls.push(["height", Number(height)]); },
    async getBalance() { return balance; },
    async getHeight() { return 1000; },
    async getDaemonHeight() { return 1000; },
    async rescanBlockchain() { calls.push(["rescan"]); },
  };
  if (scanTxs) driver.scanTxs = async (hashes) => { calls.push(["scan", hashes.length]); };
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
  check(found.calls.some((call) => call[0] === "scan" && call[1] === 2), "scanTxs did not receive both hashes");
  check(found.calls.some((call) => call[0] === "height" && call[1] === 900), "the wallet was not set at the tip");
  check(!found.calls.some((call) => call[0] === "rescan"), "a rescan followed scanTxs and would wipe the result");
  notes.push("a window with coins uses scanTxs and skips the rescan");

  const empty = fake({ balance: 0n });
  const fallback = await restoreWallet({ wallet: empty.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 900 } });
  check(fallback.total === "0" && empty.calls.some((call) => call[0] === "rescan"), "an empty window did not fall back to the full scan");
  check(empty.calls.some((call) => call[0] === "height" && call[1] === 90), "the full scan did not start below the order height");
  notes.push("an empty window falls back to the full scan");

  const noScan = fake({ balance: 5n, scanTxs: false });
  const skipped = await restoreWallet({ wallet: noScan.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 900 } });
  check(skipped.window && skipped.window.skipped === "no-scan-txs", "a wallet without scanTxs did not name the skip");
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

  return { note: "the withdrawal window scans only the lock and falls back on an empty one", problems, notes };
};
