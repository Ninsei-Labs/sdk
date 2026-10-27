#!/usr/bin/env node
// THE RESTORE PASS: HEIGHT, RESCAN, BALANCE, AND THE ONE SECOND PASS FOR LOCKED COINS.
//
// WHY THIS IS A UNIT RUN. The pass was on the sweep page; it is now in the package, and the rule it encodes is a
// fact about wallet2 - coins restored from a key are locked for ten blocks, and their spent status is unknown
// until the wallet asks the chain. A wrong height or a missing second pass produces a zero balance on a wallet
// that holds money: it looks like an empty wallet, not like an error.
//
// WHAT IS PROVEN (a stand-in driver and a stand-in wallet; no node, no library):
//   1) the scan starts ten blocks below the named height, and never below zero;
//   2) the balance is reported as strings, the heights as numbers when the driver can read them;
//   3) coins that exist but are locked get exactly one more pass with a spent-status re-check;
//   4) `rescanWhenLocked: false` runs one pass, and a driver without `rescanSpent` does not crash;
//   5) a failing sync does not hide the balance - the remainder is the answer;
//   6) refusals carry codes: no wallet, no height, no driver, no rescan, a failing balance read.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory; the tree is never touched):
//   A) drop the `scanBack` subtraction -> the height assertion reddens;
//   B) drop the locked second pass -> the locked case reddens;
//   C) make the sync failure fatal -> the failing-sync case reddens.
//
// Run: node tools/check-restore.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { restoreWallet } from "../src/sweep-restore.mjs";
import { SdkError } from "../src/errors.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "src", "sweep-restore.mjs");

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

// THE STAND-IN: the driver surface the pass reads, and the wallet surface it calls. `locked` models coins that
// exist but are not spendable until the spent status is re-checked.
function standIn({ total = 0n, unlocked = 0n, unlockAfterRescan = null, syncThrows = false, balanceThrows = false,
  rescanSpent = true, rescanBlockchain = true, rescanThrows = false, heights = true, walletHeight = 2_232_400, nodeHeight = 2_232_400 } = {}) {
  const calls = { setRestoreHeight: [], rescanBlockchain: 0, rescanSpent: 0, sync: 0, getBalance: 0, unlocked: 0 };
  const driver = {
    async setRestoreHeight(h) { calls.setRestoreHeight.push(h); },
    async getBalance() { calls.getBalance += 1; if (balanceThrows) throw new Error("no balance"); return total; },
  };
  if (rescanBlockchain) driver.rescanBlockchain = async () => { calls.rescanBlockchain += 1; if (rescanThrows) throw new Error("failed to get hashes"); };
  if (rescanSpent) {
    driver.rescanSpent = async () => {
      calls.rescanSpent += 1;
      if (unlockAfterRescan !== null) unlocked = unlockAfterRescan;
    };
  }
  if (heights) {
    driver.getHeight = async () => walletHeight;
    driver.getDaemonHeight = async () => nodeHeight;
  }
  const wallet = {
    calls,
    driver: () => driver,
    async sync() { calls.sync += 1; if (syncThrows) throw new Error("failed to get hashes"); },
    async unlockedBalance() { calls.unlocked += 1; return unlocked; },
  };
  return wallet;
}

const outcome = async (request) => {
  try { return { kind: "ok", result: await restoreWallet(request) }; }
  catch (error) { return { kind: "error", error }; }
};
const codeOf = (o) => (o.kind === "error" ? (o.error && o.error.code) || null : null);

console.log("=== 1) HEIGHT AND THE FIRST PASS ===");
{
  const wallet = standIn({ total: 5_000_000_000_000n, unlocked: 5_000_000_000_000n });
  const o = await outcome({ wallet, fromHeight: 2_232_000 });
  if (o.kind !== "ok") bad("a plain restore refused: " + JSON.stringify(codeOf(o)));
  else {
    const r = o.result;
    if (r.scanHeight === 2_231_990) ok("the scan starts ten blocks below the named height (2231990)");
    else bad("scanHeight is " + r.scanHeight + ", expected 2231990");
    if (wallet.calls.setRestoreHeight.length === 1 && wallet.calls.setRestoreHeight[0] === 2_231_990) ok("setRestoreHeight got the scan height");
    else bad("setRestoreHeight calls: " + JSON.stringify(wallet.calls.setRestoreHeight));
    if (wallet.calls.rescanBlockchain === 1) ok("the wallet is rescanned: a height alone does not re-scan a restored wallet");
    else bad("rescanBlockchain was called " + wallet.calls.rescanBlockchain + " time(s)");
    if (r.total === "5000000000000" && r.unlocked === "5000000000000") ok("amounts are strings in atomic units");
    else bad("amounts: " + JSON.stringify({ total: r.total, unlocked: r.unlocked }));
    if (r.passes === 1 && r.lockedPass === false) ok("one pass, and the locked pass is named as not taken");
    else bad("passes/lockedPass: " + JSON.stringify({ passes: r.passes, lockedPass: r.lockedPass }));
    if (r.walletHeight === 2_232_400 && r.nodeHeight === 2_232_400) ok("heights come from the driver");
    else bad("heights: " + JSON.stringify({ walletHeight: r.walletHeight, nodeHeight: r.nodeHeight }));
    if (r.scanComplete === true && r.scanIncompleteReason === undefined) ok("a wallet at the node's height reports a complete scan");
    else bad("a complete scan was not named: " + JSON.stringify({ scanComplete: r.scanComplete, reason: r.scanIncompleteReason }));
    if (r.scanHeight === 0 || r.scanHeight > 0) ok("scan height is a number");
  }
}
{
  const wallet = standIn({ total: 1n, unlocked: 1n });
  const o = await outcome({ wallet, fromHeight: 3, scanBack: 10 });
  if (o.kind === "ok" && o.result.scanHeight === 0) ok("a height below scanBack clamps at zero, never negative");
  else bad("clamping failed: " + JSON.stringify(o.kind === "ok" ? o.result.scanHeight : codeOf(o)));
}

console.log("=== 2) COINS EXIST BUT ARE LOCKED: ONE MORE PASS ===");
{
  const wallet = standIn({ total: 7_000_000_000_000n, unlocked: 0n, unlockAfterRescan: 7_000_000_000_000n });
  const o = await outcome({ wallet, fromHeight: 2_232_000 });
  if (o.kind !== "ok") bad("the locked case refused: " + JSON.stringify(codeOf(o)));
  else {
    const r = o.result;
    if (wallet.calls.rescanSpent === 1) ok("the spent status is re-checked exactly once");
    else bad("rescanSpent was called " + wallet.calls.rescanSpent + " time(s)");
    if (wallet.calls.sync === 2) ok("the wallet is synced twice: before and after the spent-status re-check");
    else bad("sync was called " + wallet.calls.sync + " time(s)");
    if (r.passes === 2 && r.lockedPass === true) ok("the second pass is named (passes 2, lockedPass true)");
    else bad("passes/lockedPass: " + JSON.stringify({ passes: r.passes, lockedPass: r.lockedPass }));
    if (r.unlocked === "7000000000000") ok("the spendable balance is read again after the re-check");
    else bad("unlocked after the second pass: " + r.unlocked);
  }
}
{
  const wallet = standIn({ total: 7_000_000_000_000n, unlocked: 0n, unlockAfterRescan: 7_000_000_000_000n });
  const o = await outcome({ wallet, fromHeight: 2_232_000, rescanWhenLocked: false });
  if (o.kind === "ok" && o.result.passes === 1 && wallet.calls.rescanSpent === 0) ok("rescanWhenLocked:false runs one pass and does not re-check spent status");
  else bad("rescanWhenLocked:false changed nothing: " + JSON.stringify({ passes: o.kind === "ok" ? o.result.passes : null, rescanSpent: wallet.calls.rescanSpent }));
}
{
  const wallet = standIn({ total: 7_000_000_000_000n, unlocked: 0n, rescanSpent: false });
  const o = await outcome({ wallet, fromHeight: 2_232_000 });
  if (o.kind === "ok" && o.result.passes === 1) ok("a driver without rescanSpent does not crash: one pass is reported");
  else bad("a driver without rescanSpent: " + JSON.stringify(o.kind === "ok" ? o.result : codeOf(o)));
}

console.log("=== 3) A FAILING SYNC DOES NOT HIDE THE BALANCE ===");
{
  const wallet = standIn({ total: 4_000_000_000_000n, unlocked: 4_000_000_000_000n, syncThrows: true });
  const o = await outcome({ wallet, fromHeight: 2_232_000 });
  if (o.kind === "ok" && o.result.unlocked === "4000000000000") ok("the remainder is reported although sync() threw");
  else bad("a failing sync hid the balance: " + JSON.stringify(o.kind === "ok" ? o.result : codeOf(o)));
  if (o.kind === "ok" && o.result.scanComplete === false && o.result.scanIncompleteReason === "sync-failed")
    ok("a failing sync is named as scan-incomplete, not reported as an empty wallet");
  else bad("a failing sync was not named: " + JSON.stringify(o.kind === "ok" ? { scanComplete: o.result.scanComplete, reason: o.result.scanIncompleteReason } : codeOf(o)));
}

console.log("=== 3a2) A FAILED RESCAN AT THE TIP IS NOT A COMPLETE SCAN ===");
{
  const wallet = standIn({ total: 5_000_000_000_000n, unlocked: 5_000_000_000_000n, rescanThrows: true });
  const o = await outcome({ wallet, fromHeight: 2_232_000 });
  if (o.kind === "ok" && o.result.scanComplete === false && o.result.scanIncompleteReason === "rescan-failed")
    ok("a failed rescan is named even with equal heights");
  else bad("failed rescan: " + JSON.stringify(o.kind === "ok" ? { complete: o.result.scanComplete, reason: o.result.scanIncompleteReason } : codeOf(o)));
}

console.log("=== 3b) A WALLET BEHIND THE NODE IS NOT A ZERO BALANCE ===");
{
  const wallet = standIn({ total: 0n, unlocked: 0n, walletHeight: 2_232_400, nodeHeight: 2_232_405 });
  const o = await outcome({ wallet, fromHeight: 2_232_000 });
  if (o.kind === "ok" && o.result.scanComplete === false && o.result.scanIncompleteReason === "behind-node")
    ok("a wallet five blocks behind the node is named behind-node");
  else bad("a wallet behind the node was reported complete: " + JSON.stringify(o.kind === "ok" ? { scanComplete: o.result.scanComplete, reason: o.result.scanIncompleteReason } : codeOf(o)));
}

console.log("=== 4) REFUSALS CARRY CODES ===");
{
  const cases = [
    ["no wallet", { fromHeight: 1 }, "wallet"],
    ["no height", { wallet: standIn(), fromHeight: 0 }, "restoreHeight"],
    ["height is not a number", { wallet: standIn(), fromHeight: "abc" }, "restoreHeight"],
    ["no driver method", { wallet: { sync: async () => {}, unlockedBalance: async () => 0n, driver: () => ({ setRestoreHeight: async () => {} }) }, fromHeight: 1 }, "wallet.driver"],
    ["no rescan", { wallet: { sync: async () => {}, unlockedBalance: async () => 0n, driver: () => ({ setRestoreHeight: async () => {}, getBalance: async () => 0n }) }, fromHeight: 1 }, "wallet.driver.rescanBlockchain"],
  ];
  for (const [name, request, field] of cases) {
    const o = await outcome(request);
    const c = codeOf(o);
    const named = o.kind === "error" && o.error instanceof SdkError && String((o.error.params && o.error.params.field) || "") === field;
    if (c === "bad-input" && named) ok(name + " -> bad-input, field " + field);
    else bad(name + " -> " + JSON.stringify({ code: c, params: o.kind === "error" ? o.error.params : null }));
  }
  const wallet = standIn({ balanceThrows: true });
  const o = await outcome({ wallet, fromHeight: 1 });
  const c = codeOf(o);
  if (c === "wallet-rejected" && String((o.error.params && o.error.params.surface) || "") === "getBalance") ok("a failing balance read -> wallet-rejected, surface getBalance");
  else bad("a failing balance read -> " + JSON.stringify({ code: c, params: o.kind === "error" ? o.error.params : null }));
}

// A COPY OF THE MODULE WITH ONE PLACE CUT OUT. Relative imports are rewritten to the real files, and line endings
// are normalised first so the patterns apply on a CRLF checkout too.
function mutated(mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-restore-"));
  const source = mutate(readFileSync(MODULE, "utf8").replace(/\r\n/g, "\n"));
  const rewritten = source.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) => `from "${pathToFileURL(join(dirname(MODULE), rel)).href}"`);
  const file = join(dir, name + ".mjs");
  writeFileSync(file, rewritten, "utf8");
  return { file, dir };
}
const importFresh = (file) => import(pathToFileURL(file).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 5) BREAKING RUN A: no scan-back -> the height assertion reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("const scanHeight = Math.max(0, Math.floor(fromHeight) - scanBack);", "const scanHeight = Math.max(0, Math.floor(fromHeight));");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const mod = await importFresh(file);
    const wallet = standIn({ total: 1n, unlocked: 1n });
    let scanHeight = null;
    try { scanHeight = (await mod.restoreWallet({ wallet, fromHeight: 2_232_000 })).scanHeight; } catch { /* reported below */ }
    if (scanHeight !== 2_231_990) ok("breaking run A REDDENS: without the scan-back the height is " + scanHeight);
    else bad("breaking run A does not redden: the height is still 2231990");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 6) BREAKING RUN B: no second pass -> the locked case reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("if (rescanWhenLocked && total > 0n && unlocked === 0n", "if (false && rescanWhenLocked && total > 0n && unlocked === 0n");
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "b");
  try {
    const mod = await importFresh(file);
    const wallet = standIn({ total: 7_000_000_000_000n, unlocked: 0n, unlockAfterRescan: 7_000_000_000_000n });
    let r = null;
    try { r = await mod.restoreWallet({ wallet, fromHeight: 2_232_000 }); } catch { /* reported below */ }
    if (!r || r.passes !== 2 || wallet.calls.rescanSpent !== 1) ok("breaking run B REDDENS: the second pass is load-bearing");
    else bad("breaking run B does not redden: passes " + r.passes + ", rescanSpent " + wallet.calls.rescanSpent);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 7) BREAKING RUN C: a fatal sync -> the balance case reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('try { await wallet.sync(); } catch (error) { syncError = error; }', 'await wallet.sync();');
    if (src === before) throw new Error("mutation C did not apply");
    return src;
  }, "c");
  try {
    const mod = await importFresh(file);
    const wallet = standIn({ total: 4_000_000_000_000n, unlocked: 4_000_000_000_000n, syncThrows: true });
    let result = null, error = null;
    try { result = await mod.restoreWallet({ wallet, fromHeight: 2_232_000 }); } catch (e) { error = e; }
    if (!result && error) ok("breaking run C REDDENS: a failing sync pre-empts the balance (code " + (error.code || "null") + ")");
    else bad("breaking run C does not redden: the balance was still reported");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "restore pass: " + pass + " checks passed.");
if (fails.length) process.exit(1);
