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

  await step("setRestoreHeight", () => driver.setRestoreHeight(scanHeight));
  // A RESCAN IS REQUIRED, NOT OPTIONAL: without it the height only applies to a wallet that has not scanned yet,
  // and a wallet restored from a key has. A driver that cannot rescan is the caller's mistake, named here.
  if (typeof driver.rescanBlockchain !== "function") throw new SdkError("bad-input", { field: "wallet.driver.rescanBlockchain" });
  await step("rescanBlockchain", () => driver.rescanBlockchain());

  // A FAILED SYNC IS BEST-EFFORT, exactly as in the signing step: what blocks a withdrawal is the spendable
  // remainder, and it is read below. The library throws low-level while scanning a chain it cannot read; that must
  // not pre-empt the verdict.
  try { await wallet.sync(); } catch { /* the remainder decides */ }

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
    try { await wallet.sync(); } catch { /* as above */ }
    total = asAmount(await step("getBalance", () => driver.getBalance()), "balance");
    unlocked = asAmount(await step("unlockedBalance", () => wallet.unlockedBalance()), "unlockedBalance");
    passes += 1;
  }

  return {
    total: total.toString(),
    unlocked: unlocked.toString(),
    scanHeight,
    walletHeight: await heightOf(driver, "getHeight"),
    nodeHeight: await heightOf(driver, "getDaemonHeight"),
    passes,
    // Whether the second pass RAN - not whether it helped. A reader must be able to tell "nothing was locked" from
    // "it was locked and stayed locked".
    lockedPass,
  };
}
