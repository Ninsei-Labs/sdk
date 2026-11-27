// THE WITHDRAWAL WINDOW: scan the blocks around the lock, not all history.
//
// The rule is only useful if the wallet is at the tip, `scanTxs` is the call that ran, and a rescan did NOT follow
// it (the measured failure: rescanBlockchain wipes the output scanTxs found). The empty-window fallback is checked
// too, because "not found" must not become "no funds".
//
// BREAKING RUNS: the window path is bypassed by a copy of the module in the same shape the other checks use.
import { restoreWallet, windowTxHashes } from "../src/sweep-restore.mjs";
import { createSweep } from "../src/sweep.mjs";
import { createNinsei } from "../src/index.mjs";

const fake = ({ balance = 0n, scanTxs = true, scanFails = false, outputs = null, images = null, rescanSpent = null } = {}) => {
  const calls = [];
  let unlocked = balance;
  const driver = {
    async setRestoreHeight(height) { calls.push(["height", Number(height)]); },
    async getBalance() { return balance; },
    async getHeight() { return 1000; },
    async getDaemonHeight() { return 1000; },
    async rescanBlockchain() { calls.push(["rescan"]); },
  };
  if (rescanSpent !== null) driver.rescanSpent = async () => { calls.push(["rescan-spent"]); unlocked = rescanSpent; };
  if (scanFails) driver.scanTxs = async () => { calls.push(["scan-failed"]); throw new Error("Failed to get transaction from daemon"); };
  else if (scanTxs) driver.scanTxs = async (hashes) => { calls.push(["scan", hashes.length]); };
  if (outputs) driver.getOutputs = async () => outputs;
  if (images) {
    driver.exportKeyImages = async (all) => { calls.push(["export", all]); return { all, getKeyImages: () => images }; };
    driver.getKeyImages = async () => images;
  }
  return {
    calls,
    wallet: { async sync() {}, async unlockedBalance() { return unlocked; }, driver: () => driver },
  };
};
const output = (key, amount) => ({
  getKeyImage: () => ({ getHex: () => key }),
  getAmount: () => BigInt(amount),
});
const image = (key) => ({ getHex: () => key });

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
  check(one.scanComplete === false && one.scanIncompleteReason === "spent-status-unavailable",
    `a window without spent status reported ${JSON.stringify({ complete: one.scanComplete, reason: one.scanIncompleteReason })}`);
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

  const withImages = fake({ balance: 5n, outputs: [output("aa", 2n), output("bb", 3n)],
    images: [image("aa"), image("bb")] });
  const nodeCalls = [];
  const spent = await restoreWallet({ wallet: withImages.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example", trustedNode: true },
    fetchImpl: async (url, options) => { nodeCalls.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => ({ status: "OK", spent_status: [0, 1] }) }; },
  });
  check(spent.window && spent.window.spent === 1 && spent.window.keyImages === 2,
    `the spent check reported ${JSON.stringify(spent.window)}`);
  check(nodeCalls.length === 1 && nodeCalls[0][0].endsWith("/is_key_image_spent"), "the key images were not checked at the node");
  check(spent.scanComplete === true && spent.scanIncompleteReason === undefined,
    `a window with spent status was reported incomplete: ${JSON.stringify({ complete: spent.scanComplete, reason: spent.scanIncompleteReason })}`);
  check(spent.unlocked === "2" && spent.total === "2",
    `the spent output stayed in the window balance: ${JSON.stringify({ total: spent.total, unlocked: spent.unlocked })}`);
  check(withImages.calls.some(([name, all]) => name === "export" && all === true),
    "the window did not ask the wallet for all key images");
  notes.push("an explicitly trusted node may receive key images for the spent check");

  // A WINDOW WITH A MIX OF SPENT AND UNSPENT OUTPUTS. The unspent part stays spendable; the spent amount is not
  // reported as a balance. Pool spends are pending: they leave the spendable remainder but do not erase the total.
  {
    const mixed = fake({ balance: 5n, outputs: [output("aa", 2n), output("bb", 3n)], images: [image("aa"), image("bb")] });
    const result = await restoreWallet({ wallet: mixed.wallet, fromHeight: 100,
      window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example", trustedNode: true },
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: "OK", untrusted: false, spent_status: [1, 0] }) }),
    });
    check(result.unlocked === "3" && result.total === "3",
      `a partially spent window kept the spent amount: ${JSON.stringify({ total: result.total, unlocked: result.unlocked })}`);
    check(result.scanComplete === true && result.window && result.window.spent === 1,
      `a partially spent window is complete with one spent output: ${JSON.stringify(result.window)}`);
  }
  {
    const all = fake({ balance: 5n, outputs: [output("aa", 2n), output("bb", 3n)], images: [image("aa"), image("bb")] });
    const result = await restoreWallet({ wallet: all.wallet, fromHeight: 100,
      window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example", trustedNode: true },
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: "OK", untrusted: false, spent_status: [1, 1] }) }),
    });
    check(result.unlocked === "0" && result.total === "0" && result.scanComplete === true,
      `a fully spent window still reported spendable coins: ${JSON.stringify({ total: result.total, unlocked: result.unlocked, window: result.window })}`);
  }
  {
    // THE WALLET IS TOLD ABOUT THE SPEND AS WELL. Signing reads the wallet's own unlocked balance, so `restore`
    // must run the wallet's spent rescan when it exists and keep the lower remainder.
    const updated = fake({ balance: 5n, outputs: [output("aa", 2n), output("bb", 3n)],
      images: [image("aa"), image("bb")], rescanSpent: 3n });
    const result = await restoreWallet({ wallet: updated.wallet, fromHeight: 100,
      window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example", trustedNode: true },
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: "OK", untrusted: false, spent_status: [1, 0] }) }),
    });
    check(result.unlocked === "3" && updated.calls.some(([name]) => name === "rescan-spent"),
      `the wallet was not told about the spent output: ${JSON.stringify({ unlocked: result.unlocked, calls: updated.calls })}`);
  }
  {
    const pool = fake({ balance: 5n, outputs: [output("aa", 2n), output("bb", 3n)], images: [image("aa"), image("bb")] });
    const result = await restoreWallet({ wallet: pool.wallet, fromHeight: 100,
      window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example", trustedNode: true },
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: "OK", untrusted: false, spent_status: [2, 0] }) }),
    });
    check(result.unlocked === "3" && result.total === "5" && result.window && result.window.pending === 1,
      `a pool spend was not kept pending: ${JSON.stringify({ total: result.total, unlocked: result.unlocked, window: result.window })}`);
  }
  {
    // THE WALLET EXPORTS FEWER IMAGES THAN IT HAS OUTPUTS. That answer cannot cover the window and must not be
    // reported as a complete scan.
    const short = fake({ balance: 5n, outputs: [output("aa", 2n), output("bb", 3n)], images: [image("aa")] });
    const result = await restoreWallet({ wallet: short.wallet, fromHeight: 100,
      window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example", trustedNode: true },
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: "OK", untrusted: false, spent_status: [1] }) }),
    });
    check(result.scanComplete === false && result.window && result.window.spentWhy === "key-images-short",
      `a short key-image list was reported complete: ${JSON.stringify(result.window)}`);
  }
  for (const [name, body] of [
    ["an untrusted status", { status: "OK", untrusted: true, spent_status: [1, 0] }],
    ["a busy status", { status: "BUSY", spent_status: [1, 0] }],
    ["an answer without status", { spent_status: [1, 0] }],
  ]) {
    const wallet = fake({ balance: 5n, outputs: [output("aa", 2n), output("bb", 3n)], images: [image("aa"), image("bb")] });
    const result = await restoreWallet({ wallet: wallet.wallet, fromHeight: 100,
      window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example", trustedNode: true },
      fetchImpl: async () => ({ ok: true, json: async () => body }),
    });
    check(result.scanComplete === false && result.window && result.window.spent === null,
      `${name} was treated as a complete spent answer: ${JSON.stringify(result.window)}`);
  }
  {
    // WITHOUT OUTPUT AMOUNTS THE SPENT AMOUNT CANNOT BE REMOVED FROM THE BALANCE. An untrusted balance is safer
    // than a complete scan that counts a spent output as spendable.
    const noOutputs = fake({ balance: 5n, images: [image("aa"), image("bb")] });
    const result = await restoreWallet({ wallet: noOutputs.wallet, fromHeight: 100,
      window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example", trustedNode: true },
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: "OK", spent_status: [1, 0] }) }),
    });
    check(result.scanComplete === false && result.window && result.window.spentWhy === "outputs-unavailable",
      `a window without output amounts was reported complete: ${JSON.stringify(result.window)}`);
  }

  // A BLOCK THAT LANDS AFTER THE WINDOW'S SYNC IS NOT A GAP. The window is the scope, and the trusted node's
  // spent answer covers it; the wallet height may legitimately be below the node's when the return arrives.
  const behind = fake({ balance: 5n, outputs: [output("aa", 2n), output("bb", 3n)], images: [image("aa"), image("bb")] });
  behind.wallet.driver().getHeight = async () => 995;
  behind.wallet.driver().getDaemonHeight = async () => 1000;
  const ahead = await restoreWallet({ wallet: behind.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 1000, nodeUrl: "https://node.example", trustedNode: true },
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "OK", spent_status: [0, 0] }) }),
  });
  check(ahead.scanComplete === true && ahead.scanIncompleteReason === undefined,
    `a window behind a landed block was reported incomplete: ${JSON.stringify({ complete: ahead.scanComplete, reason: ahead.scanIncompleteReason })}`);

  // THE UNREADABLE ANSWER STILL REFUSES, even when the heights alone would have looked complete.
  const unreadable = fake({ balance: 5n });
  unreadable.wallet.driver().getHeight = async () => 995;
  unreadable.wallet.driver().getDaemonHeight = async () => 1000;
  unreadable.wallet.driver().getKeyImages = async () => [{ getHex: () => "aa" }, { getHex: () => "bb" }];
  const noAnswer = await restoreWallet({ wallet: unreadable.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 1000, nodeUrl: "https://node.example", trustedNode: true },
    fetchImpl: async () => ({ ok: true, json: async () => ({ spent_status: [0] }) }),
  });
  check(noAnswer.scanComplete === false && noAnswer.scanIncompleteReason === "spent-status-unavailable",
    `an unreadable trusted answer was not refused: ${JSON.stringify({ complete: noAnswer.scanComplete, reason: noAnswer.scanIncompleteReason })}`);
  notes.push("a window behind a landed block is complete only with a valid trusted spent answer");

  // KEY IMAGES ARE LINKABLE. Without an explicit trusted-node opt-in the SDK must not send them at all, even when
  // the wallet exposes them and the caller supplied a node URL; the missing spent check is named, not guessed.
  const untrusted = fake({ balance: 5n });
  let untrustedCalls = 0;
  untrusted.wallet.driver().getKeyImages = async () => [{ getHex: () => "aa" }];
  const withheld = await restoreWallet({ wallet: untrusted.wallet, fromHeight: 100,
    window: { txHashes: ["a"], toHeight: 110, tipHeight: 900, nodeUrl: "https://node.example" },
    fetchImpl: async () => { untrustedCalls += 1; return { ok: true, json: async () => ({ spent_status: [1] }) }; },
  });
  check(untrustedCalls === 0, "key images were sent to a node that was not declared trusted");
  check(withheld.window && withheld.window.spent === null && withheld.window.spentWhy === "untrusted-node",
    `an untrusted node reported ${JSON.stringify(withheld.window)}`);
  check(withheld.scanComplete === false && withheld.scanIncompleteReason === "spent-status-unavailable",
    `an untrusted window reported ${JSON.stringify({ complete: withheld.scanComplete, reason: withheld.scanIncompleteReason })}`);
  notes.push("key images stay in the wallet unless the node is explicitly trusted");

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

  // THE INSTANCE TRANSPORT REACHES THE RESTORE WINDOW. A Tor/proxy caller passes `fetch` once to the facade; a
  // restore that used the global fetch would show the user's IP to the node and bypass the proxy.
  {
    const instanceCalls = [];
    const instance = createSweep({ fetchImpl: async (url) => {
      instanceCalls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ result: { tx_hashes: [] } }) };
    } });
    const instanceWallet = fake({ balance: 0n });
    const restored = await instance.restore({ wallet: instanceWallet.wallet, fromHeight: 100,
      window: { nodeUrl: "http://127.0.0.1:9", toHeight: 110, tipHeight: 900 } });
    check(restored && restored.total === "0", "the instance-fetch restore did not report its balance");
    check(instanceCalls.length === 11, `the instance fetch did not read the window: ${instanceCalls.length} calls`);
    let badFetch = null;
    try {
      await instance.restore({ wallet: instanceWallet.wallet, fromHeight: 100, fetchImpl: "not-a-function",
        window: { nodeUrl: "http://127.0.0.1:9", toHeight: 110, tipHeight: 900 } });
    } catch (error) { badFetch = error; }
    check(badFetch && badFetch.code === "bad-input" && badFetch.params && badFetch.params.field === "fetchImpl",
      "a non-function per-call fetch was silently replaced: " + JSON.stringify(badFetch && badFetch.code));
    notes.push("the facade's fetch is used by restore instead of the global fetch");
  }

  // THE SAME TRANSPORT RULE THROUGH THE PUBLIC FACADE, NOT ONLY THE SWEEP CONSTRUCTOR. `createNinsei({ fetch })`
  // must carry its transport into `sweep.restore`, and a per-call `fetchImpl` must still win.
  {
    const facadeCalls = [];
    const perCallCalls = [];
    const client = createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet",
      fetch: async (url) => {
        facadeCalls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ result: { tx_hashes: [] } }) };
      } });
    const facadeWallet = fake({ balance: 0n });
    const facadeRestored = await client.sweep.restore({ wallet: facadeWallet.wallet, fromHeight: 100,
      window: { nodeUrl: "http://127.0.0.1:9", toHeight: 110, tipHeight: 900 } });
    check(facadeRestored && facadeRestored.total === "0", "the facade restore did not report its balance");
    check(facadeCalls.length === 11, `the facade fetch did not read the window: ${facadeCalls.length} calls`);
    const perCallRestored = await client.sweep.restore({ wallet: facadeWallet.wallet, fromHeight: 100,
      window: { nodeUrl: "http://127.0.0.1:9", toHeight: 110, tipHeight: 900 },
      fetchImpl: async (url) => {
        perCallCalls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ result: { tx_hashes: [] } }) };
      } });
    check(perCallRestored && perCallRestored.total === "0" && perCallCalls.length === 11,
      `a per-call fetch did not win through the facade: ${JSON.stringify({ perCallCalls: perCallCalls.length })}`);
    notes.push("the facade's fetch reaches sweep.restore and a per-call fetch still wins");
  }

  return { note: "the withdrawal window scans only the lock and falls back on an empty or unreadable one", problems, notes };
};
