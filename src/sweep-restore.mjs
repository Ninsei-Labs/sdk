// RESTORING THE WITHDRAWAL WALLET: THE PASS BEFORE ANYTHING IS SIGNED.
//
// WHY THIS IS IN THE PACKAGE. The sweep page used to run this itself: set the restore height ten blocks below
// the one the file names, rescan, sync, read the balance, and - if the balance was non-zero while nothing was
// spendable - rescan the spent status and sync again. The second pass was not a guess: coins are locked for ten
// blocks after they arrive, and the spent status of outputs restored from a key is not known until the wallet
// asks the chain. Both are facts about wallet2, not about a page, and a node or a CLI needs the same pass.
//
// WHAT IS NOT HERE: creating the wallet, opening it and closing it. The wallet arrives as the same withdrawal
// adapter the signing step takes (`sync`, `unlockedBalance`, `driver`); who built it and where the WASM and the
// worker live is the caller's business.
//
// REFUSALS CARRY CODES. A missing method, a missing height and a library error all come out as `SdkError`; a
// low-level exception never escapes with `code: null`, because the interface has no phrase for it and a check
// cannot assert it.
import { SdkError } from "./errors.mjs";

// THE SECOND PASS IS BOUNDED: a wallet that reports a balance but no spendable coins twice is not helped by a
// third pass, and repeating it would only make an empty answer slower to arrive.
const PASSES = 2;
// HOW FAR BELOW THE NAMED HEIGHT THE SCAN STARTS. A gap in an arrival block is worth more than the ten blocks it
// costs: scanning from the exact height has already missed an arrival one block earlier.
const SCAN_BACK = 10;

const asAmount = (value, field) => {
  try {
    return BigInt(value);
  } catch {
    throw new SdkError("bad-input", { field });
  }
};

const driverOf = (wallet) => {
  if (!wallet || typeof wallet.driver !== "function") throw new SdkError("bad-input", { field: "wallet.driver" });
  const driver = wallet.driver();
  if (!driver || typeof driver !== "object") throw new SdkError("bad-input", { field: "wallet.driver" });
  const missing = ["setRestoreHeight", "getBalance"].filter((name) => typeof driver[name] !== "function");
  if (missing.length) throw new SdkError("bad-input", { field: "wallet.driver", missing });
  return driver;
};

// A WALLET STEP THAT FAILS IS A REFUSAL WITH A CODE, never raw library text. The surface is named so a reader can
// tell which call went wrong.
const step = async (surface, fn) => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError("wallet-rejected", { surface, why: String((error && error.message) || error) });
  }
};

const heightOf = async (driver, name) => {
  if (typeof driver[name] !== "function") return null;
  try {
    const value = await driver[name]();
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  } catch {
    // A missing height is not a refusal: the balance is the answer this pass exists for.
    return null;
  }
};

// AN INCOMPLETE SCAN IS A NAMED OUTCOME, NOT A ZERO BALANCE. The wallet library's sync is best-effort: a node
// that refuses block downloads leaves a wallet at height 0, and a caller that only reads `unlocked` shows "no
// XMR". The heights and the sync error decide the verdict here, so the page does not have to guess.
const scanCompleteness = async (driver, { syncError = null } = {}) => {
  const walletHeight = await heightOf(driver, "getHeight");
  const nodeHeight = await heightOf(driver, "getDaemonHeight");
  let reason = null;
  if (syncError) reason = "sync-failed";
  else if (walletHeight === null || nodeHeight === null) reason = "no-heights";
  else if (walletHeight < nodeHeight) reason = "behind-node";
  return { scanComplete: reason === null, ...(reason === null ? {} : { scanIncompleteReason: reason }), walletHeight, nodeHeight };
};

// THE BLOCK WINDOW AROUND THE LOCK. A full rescan of mainnet takes hours; the lock can only be in the blocks from
// the order's start to just after its t1. The caller may pass the hashes, or a node URL and the SDK asks for them.
export async function windowTxHashes({ nodeUrl, fromHeight, toHeight, fetchImpl = globalThis.fetch, sleep = defaultSleep, attempts = 3 } = {}) {
  let base = typeof nodeUrl === "string" ? nodeUrl.trim() : "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  const from = Number(fromHeight);
  const to = Number(toHeight);
  if (!base) throw new SdkError("bad-input", { field: "window.nodeUrl" });
  if (!Number.isSafeInteger(from) || from < 0) throw new SdkError("bad-input", { field: "window.fromHeight" });
  if (!Number.isSafeInteger(to) || to < from) throw new SdkError("bad-input", { field: "window.toHeight" });
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetchImpl" });
  const tries = Math.max(1, Math.min(5, Number(attempts) || 3));
  const hashes = [];
  for (let height = from; height <= to; height += 1) {
    let response = null;
    let last = null;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        response = await fetchImpl(base + "/json_rpc", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height } }),
          signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
        });
      } catch {
        // A TIMEOUT OR A BROKEN CONNECTION IS RETRIED, NOT THE END OF THE WINDOW. The node is rate-limited by the
        // same bursts the page sends; a withdrawal that stops on the first 429 or timeout is a refund waiting to
        // happen (the page's measured failure: 93 of 150 parallel reads answered 429).
        response = null;
        last = new SdkError("wallet-rejected", { surface: "window-blocks", height, why: "transport" });
        if (attempt < tries) { await sleep(backoffMs(attempt)); continue; }
        throw last;
      }
      if (response && response.ok === true) { last = null; break; }
      const status = response ? response.status : null;
      last = new SdkError("wallet-rejected", { surface: "window-blocks", height, status });
      // ONLY A RATE LIMIT AND A SERVER FAULT ARE WORTH ANOTHER READ. A 404 or a bad request will answer the same
      // way every time, and retrying it only makes the fallback slower.
      if ((status === 429 || (status !== null && status >= 500)) && attempt < tries) {
        await sleep(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }
      throw last;
    }
    if (!response || response.ok !== true) throw last || new SdkError("wallet-rejected", { surface: "window-blocks", height });
    let body = null;
    try { body = await response.json(); } catch { throw new SdkError("wallet-rejected", { surface: "window-blocks", height, why: "not-json" }); }
    if (!body || body.error || !body.result) throw new SdkError("wallet-rejected", { surface: "window-blocks", height, why: "rpc" });
    const result = body.result;
    let list = Array.isArray(result.tx_hashes) ? result.tx_hashes : null;
    if (!list && typeof result.json === "string") {
      try {
        const json = JSON.parse(result.json);
        list = Array.isArray(json.tx_hashes) ? json.tx_hashes : null;
      } catch { list = null; }
    }
    if (!list) throw new SdkError("wallet-rejected", { surface: "window-blocks", height, why: "no-tx-hashes" });
    hashes.push(...list.map(String));
  }
  return hashes;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt) => Math.min(4000, 250 * (2 ** Math.max(0, attempt - 1)));
function retryAfterMs(response) {
  try {
    const value = response && response.headers && typeof response.headers.get === "function"
      ? response.headers.get("retry-after") : null;
    if (value === null || value === undefined || value === "") return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5000, Math.floor(seconds * 1000));
    const date = Date.parse(String(value));
    if (Number.isFinite(date)) return Math.min(5000, Math.max(0, date - Date.now()));
  } catch { /* a bad header is not a reason to stop */ }
  return null;
}

/**
 * Restore the wallet from a height and report what it holds.
 *
 * @param {object} request
 * @param {object} request.wallet   the withdrawal adapter: `sync`, `unlockedBalance`, `driver`
 * @param {number} request.fromHeight the height the file names; the scan starts a little below it
 * @param {number} [request.scanBack] how far below, default 10
 * @param {boolean} [request.rescanWhenLocked] run the second pass, default true
 * @returns {Promise<{total: string, unlocked: string, scanHeight: number, walletHeight: number|null,
 *   nodeHeight: number|null, passes: number, lockedPass: boolean}>}
 */
export async function restoreWallet(request = {}) {
  const wallet = request.wallet;
  if (!wallet || typeof wallet !== "object") throw new SdkError("bad-input", { field: "wallet" });
  const missing = ["sync", "unlockedBalance"].filter((name) => typeof wallet[name] !== "function");
  if (missing.length) throw new SdkError("bad-input", { field: "wallet", missing });

  const fromHeight = Number(request.fromHeight);
  if (!Number.isFinite(fromHeight) || fromHeight <= 0) throw new SdkError("bad-input", { field: "restoreHeight" });

  const scanBack = Number.isFinite(Number(request.scanBack)) && Number(request.scanBack) >= 0
    ? Math.floor(Number(request.scanBack))
    : SCAN_BACK;
  const scanHeight = Math.max(0, Math.floor(fromHeight) - scanBack);
  const driver = driverOf(wallet);

  // THE WINDOW PATH: set the wallet at the node tip, scan the lock's blocks, and only fall back to a full scan
  // when that window holds nothing. An empty window is "not found", not "no funds".
  const requestWindow = request.window && typeof request.window === "object" ? request.window : null;
  let windowReport = null;
  let windowTotal = 0n;
  let windowUnlocked = 0n;
  if (requestWindow) {
    const tipHeight = Number(requestWindow.tipHeight);
    if (!Number.isSafeInteger(tipHeight) || tipHeight <= 0) throw new SdkError("bad-input", { field: "window.tipHeight" });
    windowReport = { used: false, skipped: null, fallback: false, fromHeight, toHeight: Number(requestWindow.toHeight),
      blocks: Math.max(0, Number(requestWindow.toHeight) - fromHeight + 1), txs: 0 };
    let hashes = Array.isArray(requestWindow.txHashes) ? requestWindow.txHashes.map(String) : null;
    if (hashes === null) {
      try {
        hashes = await windowTxHashes({
          nodeUrl: requestWindow.nodeUrl, fromHeight, toHeight: requestWindow.toHeight, fetchImpl: request.fetchImpl,
        });
      } catch (e) {
        // A MALFORMED WINDOW IS NOT A BUSY NODE. A bad height or a missing URL is the caller's error and is
        // rethrown; only a read the node refused reaches the fallback.
        if (e && e.code === "bad-input") throw e;
        // THE WINDOW READ FAILED: FALL BACK TO THE FULL SCAN, NOT TO A REFUSAL. A 429 from a busy node, a timeout
        // or a 5xx is a fact about the node, not about the coins; the scan below can still find them. The reason is
        // carried on the report so the caller does not present this as a normal empty window.
        windowReport.fallback = true;
        windowReport.fallbackWhy = "window-read";
        windowReport.error = {
          code: e && e.code ? e.code : "wallet-rejected",
          surface: e && e.params && e.params.surface ? e.params.surface : "window-blocks",
          status: e && e.params && e.params.status !== undefined ? e.params.status : null,
          height: e && e.params && e.params.height !== undefined ? e.params.height : null,
          why: e && e.params && e.params.why ? e.params.why : null,
        };
        hashes = [];
      }
    }
    windowReport.txs = hashes.length;
    if (hashes.length && typeof driver.scanTxs === "function") {
      let windowSyncError = null;
      try {
        await step("setRestoreHeight", () => driver.setRestoreHeight(tipHeight));
        await step("scanTxs", () => driver.scanTxs(hashes));
        try { await wallet.sync(); } catch (error) { windowSyncError = error; }
        windowTotal = asAmount(await step("getBalance", () => driver.getBalance()), "balance");
        windowUnlocked = asAmount(await step("unlockedBalance", () => wallet.unlockedBalance()), "unlockedBalance");
        windowReport.used = true;
      } catch (e) {
        // A WINDOW THAT WAS READ BUT NOT APPLIED IS STILL A FAILED WINDOW. `scanTxs` and the balance read use the
        // wallet's own transport; a node that misses one route (`/gettransactions`) or a wallet that refuses the
        // scan must not end the withdrawal. The full scan below is the fallback, and the reason says which step.
        if (e && e.code === "bad-input") throw e;
        windowTotal = 0n;
        windowUnlocked = 0n;
        windowReport.fallback = true;
        windowReport.fallbackWhy = "window-scan";
        windowReport.error = {
          code: e && e.code ? e.code : "wallet-rejected",
          surface: e && e.params && e.params.surface ? e.params.surface : "scanTxs",
          status: null,
          height: null,
          why: e && e.params && e.params.why ? e.params.why : null,
        };
      }
      // THE KEY IMAGES OF THE WALLET, CHECKED AT THE NODE. `scanTxs` finds an output; whether the chain already
      // spent it is a separate fact, and the caller must not sign on a guess. A failed scan has no images to ask for.
      if (windowReport.used && requestWindow.nodeUrl && typeof driver.getKeyImages === "function") {
        try {
          const exported = await driver.getKeyImages();
          const images = Array.isArray(exported) ? exported
            : (exported && typeof exported.getKeyImages === "function" ? exported.getKeyImages() : []);
          const hexes = images.map((image) => typeof image === "string" ? image
            : (image && typeof image.getHex === "function" ? image.getHex() : image && image.hex)).filter(Boolean);
          if (hexes.length) {
            let base = String(requestWindow.nodeUrl);
            while (base.endsWith("/")) base = base.slice(0, -1);
            const response = await (request.fetchImpl || globalThis.fetch)(base + "/is_key_image_spent", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ key_images: hexes }),
              signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
            });
            const body = response && response.ok === true ? await response.json() : null;
            if (body && Array.isArray(body.spent_status)) {
              windowReport.spent = body.spent_status.filter((value) => value === true || value === 1).length;
              windowReport.keyImages = hexes.length;
            } else windowReport.spent = null;
          } else { windowReport.spent = null; windowReport.spentWhy = "no-key-images"; }
        } catch { windowReport.spent = null; windowReport.spentWhy = "check-failed"; }
      } else if (windowReport.used && requestWindow.nodeUrl) {
        windowReport.spent = null;
        windowReport.spentWhy = "no-key-images";
      }
      // A WINDOW WITH COINS IS THE ANSWER. A window with none falls through to the full scan unless the caller
      // explicitly turned the fallback off.
      if (windowReport.used && (windowTotal > 0n || windowUnlocked > 0n || requestWindow.fallback === false)) {
        const completeness = await scanCompleteness(driver, { syncError: windowSyncError });
        return {
          total: windowTotal.toString(), unlocked: windowUnlocked.toString(), scanHeight,
          ...completeness, passes: 1, lockedPass: false, window: windowReport,
        };
      }
    } else if (hashes.length) {
      windowReport.skipped = "no-scan-txs";
    }
  }

  // THE WINDOW DID NOT ANSWER: the full scan below is the fallback. Say so on the report, so the caller does not
  // have to infer it from `used: false` and a balance.
  if (windowReport) {
    windowReport.fallback = true;
    if (!windowReport.fallbackWhy) windowReport.fallbackWhy = "empty-window";
  }
  await step("setRestoreHeight", () => driver.setRestoreHeight(scanHeight));
  // A RESCAN IS REQUIRED, NOT OPTIONAL: without it the height only applies to a wallet that has not scanned yet,
  // and a wallet restored from a key has. A driver that cannot rescan is the caller's mistake, named here.
  if (typeof driver.rescanBlockchain !== "function") throw new SdkError("bad-input", { field: "wallet.driver.rescanBlockchain" });
  // A RESCAN IS BEST-EFFORT, LIKE THE SYNC BELOW. A wallet built from keys already carries the height it was opened
  // with, and a library that cannot rescan a chain (monero-ts against a regtest node answers "failed to get hashes")
  // would otherwise stop a withdrawal the sync can still serve. The balance below is the verdict, not the rescan.
  try { await step("rescanBlockchain", () => driver.rescanBlockchain()); } catch { /* the balance decides */ }

  // A FAILED SYNC IS BEST-EFFORT, exactly as in the signing step: what blocks a withdrawal is the spendable
  // remainder, and it is read below. The library throws low-level while scanning a chain it cannot read; that must
  // not pre-empt the verdict. The error is remembered and named in `scanIncompleteReason`.
  let syncError = null;
  try { await wallet.sync(); } catch (error) { syncError = error; }

  let total = asAmount(await step("getBalance", () => driver.getBalance()), "balance");
  let unlocked = asAmount(await step("unlockedBalance", () => wallet.unlockedBalance()), "unlockedBalance");
  let passes = 1;
  let lockedPass = false;

  // THE SECOND PASS: coins exist but none is spendable. The spent status is re-checked and the wallet is synced
  // again; the arrival may have been locked by time rather than lost.
  const rescanWhenLocked = request.rescanWhenLocked !== false;
  if (rescanWhenLocked && total > 0n && unlocked === 0n && typeof driver.rescanSpent === "function" && passes < PASSES) {
    lockedPass = true;
    await step("rescanSpent", () => driver.rescanSpent());
    try { await wallet.sync(); } catch (error) { syncError = error; }
    total = asAmount(await step("getBalance", () => driver.getBalance()), "balance");
    unlocked = asAmount(await step("unlockedBalance", () => wallet.unlockedBalance()), "unlockedBalance");
    passes += 1;
  }

  const completeness = await scanCompleteness(driver, { syncError });
  return {
    total: total.toString(),
    unlocked: unlocked.toString(),
    scanHeight,
    ...completeness,
    passes,
    // Whether the second pass RAN - not whether it helped. A reader must be able to tell "nothing was locked" from
    // "it was locked and stayed locked".
    lockedPass,
    window: windowReport,
  };
}
