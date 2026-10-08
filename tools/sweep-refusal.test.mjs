#!/usr/bin/env node
// THE WITHDRAWAL CORE: AN EMPTY REMAINDER IS A NAMED REFUSAL, NOT A RAW WALLET ERROR. UNIT RUN.
//
// WHY THIS RUNS WITHOUT A BROWSER AND WITHOUT A CONTOUR. The live withdrawal-page run on the CI contour (a regtest
// node) went red: the wallet was EMPTY, and an empty remainder had to stop the withdrawal with the code
// `insufficient-funds` - instead the low-level monero-ts error `failed to get hashes` came out WITHOUT A CODE
// (`code: null`). The cause was in the core: it called `wallet.sync()` BEFORE reading the remainder, so a failing
// sync (a node whose chain the wallet cannot scan) escaped ahead of the funds verdict.
//
// WHAT IS PROVEN (a fake wallet; the recovery file is built by the engine itself):
//   1) a ZERO remainder refuses with the code `insufficient-funds` while input selection (`sweepUnlocked`) is never
//      touched - and input selection is exactly what fails low-level on an empty wallet;
//   2) a NON-ZERO remainder reaches SIGNING (`sweepUnlocked` is called and the core hands back a session token);
//   3) a low-level library failure comes out WITH a code from the dictionary, never as `code: null`.
//
// BREAKING RUNS (both mutate a COPY of the module in a temp directory; the working tree is never touched):
//   A) cut the remainder check -> the refusal stops being `insufficient-funds` and the run reddens;
//   B) cut the low-level wrapper -> `code: null` + `failed to get hashes` comes out - the exact CI symptom - and
//      the run reddens.
//
// Run: node tools/sweep-refusal.test.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSweep } from "../src/sweep.mjs";
import * as engine from "../src/engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP_MJS = join(ROOT, "src", "sweep.mjs");
const PASSPHRASE = "sweep-refusal-test-pass";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

// THE STAND-IN WITHDRAWAL WALLET: the adapter's surface (open/sync/unlockedBalance/sweepUnlocked/relay/close), but
// instead of the library - the FACTS this run needs: how much is free and what input selection does. `sync` fails
// low-level, the way monero-ts did on the regtest contour.
function fakeWallet({ unlocked = 0n, syncThrows = true, sweepThrows = false, unlockedThrows = false } = {}) {
  const calls = { open: 0, sync: 0, unlockedBalance: 0, sweepUnlocked: 0, relay: 0, close: 0 };
  return {
    calls,
    async open() { calls.open += 1; },
    async sync() { calls.sync += 1; if (syncThrows) throw new Error("failed to get hashes"); },
    async unlockedBalance() { calls.unlockedBalance += 1; if (unlockedThrows) throw new Error("failed to get hashes"); return unlocked; },
    async sweepUnlocked() { calls.sweepUnlocked += 1; if (sweepThrows) throw new Error("failed to get hashes"); return { signed: true }; },
    async relay() { calls.relay += 1; return []; },
    async close() { calls.close += 1; },
  };
}

// A REAL PLAN: the recovery file is built by the engine itself (buildPayload + createRecoveryFile), so decryption
// and the composition check are part of the run. Nothing goes to the network - the app path is a stand-in.
async function planRequest() {
  const address = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";
  const payload = engine.recoveryFile.buildPayload({
    swap: {
      id: "sweep-refusal", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
      createdAt: new Date(0).toISOString(), payToken: "USDC", payAmount: 1, xmrAmount: 0.5,
      escrow: { address: "0x00000000000000000000000000000000000000e5", termsHash: null },
    },
    swapWallet: {
      source: "unit", library: "monero-ts", network: "stagenet", address,
      spendHalf: "0x" + "11".repeat(32), viewHalf: "0x" + "22".repeat(32),
      otherSpendPoint: "0x" + "33".repeat(32), otherViewPoint: "0x" + "44".repeat(32),
      otherViewHalf: "0x" + "55".repeat(32),
    },
    escrow: { address: "0x00000000000000000000000000000000000000e5" },
    receiveAddress: address,
    restoreHeight: 2_206_635,
  });
  engine.recoveryFile.validatePayload(payload);
  const contents = await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE);
  return { file: { contents }, passphrase: PASSPHRASE, to: address };
}

function facade(mod) {
  const http = {
    json: async (url, options) => (options === undefined ? [] : { ok: true, revealed: true, half: "0x" + "ab".repeat(32) }),
  };
  const config = { route: (name) => "http://app.invalid/" + name };
  return mod.createSweep({ http, config });
}

async function signOutcome(mod, wallet) {
  const request = await planRequest();
  try {
    return { kind: "signed", result: await facade(mod).sign({ ...request, connectWallet: async () => wallet }) };
  } catch (error) {
    return { kind: "error", error };
  }
}

// A COPY OF THE MODULE WITH A MUTATION, in a temp directory. Relative imports are rewritten to the absolute
// addresses of the REAL modules, so the copy is exactly the same code with one place cut out.
function mutatedModule(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "sweep-refusal-"));
  // LINE ENDINGS ARE NORMALISED BEFORE MUTATING. The patterns below are written with a plain "\n", so on a
  // Windows checkout (CRLF) every one of them would silently fail to apply and the breaking run would report
  // "the mutation did not apply" instead of proving anything. The copy lives in a temp directory and is written
  // back with LF, so the same patterns apply on a Windows checkout and on the CI checkout alike; the loud
  // "did not apply" guard below is kept on purpose.
  const source = mutate(readFileSync(SWEEP_MJS, "utf8").replace(/\r\n/g, "\n"));
  const rewritten = source.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) =>
    `from "${pathToFileURL(join(dirname(SWEEP_MJS), rel)).href}"`);
  const file = join(dir, "sweep.mjs");
  writeFileSync(file, rewritten, "utf8");
  return { file, dir };
}

const importFresh = (file) => import(pathToFileURL(file).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 1) ZERO REMAINDER: refused with the code insufficient-funds, input selection untouched ===");
{
  const wallet = fakeWallet({ unlocked: 0n, syncThrows: true, sweepThrows: true });
  const outcome = await signOutcome({ createSweep }, wallet);
  if (outcome.kind !== "error") bad("a zero remainder did not refuse: " + JSON.stringify(outcome.result));
  else {
    const error = outcome.error;
    console.log("        code: " + String(error && error.code));
    if (error && error.code === "insufficient-funds") ok("a zero remainder is refused with the code insufficient-funds");
    else bad("expected insufficient-funds, got: " + JSON.stringify({ code: (error && error.code) || null, message: String(error && error.message) }));
    if (wallet.calls.sweepUnlocked === 0) ok("input selection (sweepUnlocked) is never touched: the refusal comes BEFORE signing");
    else bad("input selection was called " + wallet.calls.sweepUnlocked + " time(s) - the refusal came too late");
    if (wallet.calls.sync === 1) ok("the failing sync() does not escape: the remainder decides, not the scan");
    else bad("sync() was called " + wallet.calls.sync + " time(s) - exactly one pass was expected");
    if (wallet.calls.close === 1) ok("the wallet is closed after the refusal (it is not left open)");
    else bad("the wallet was not closed after the refusal (close called " + wallet.calls.close + " time(s))");
  }
}

console.log("=== 2) NON-ZERO REMAINDER: the run REACHES SIGNING ===");
{
  const wallet = fakeWallet({ unlocked: 100_000_000_000n, syncThrows: false, sweepThrows: false });
  const outcome = await signOutcome({ createSweep }, wallet);
  if (outcome.kind === "signed" && outcome.result && typeof outcome.result.token === "string") {
    ok("a non-zero remainder reaches signing: token " + outcome.result.token + ", amount " + outcome.result.amount);
    if (wallet.calls.sweepUnlocked === 1) ok("signing happened exactly once (sweepUnlocked called)");
    else bad("sweepUnlocked was called " + wallet.calls.sweepUnlocked + " time(s) instead of once");
  } else {
    bad("a non-zero remainder did not reach signing: " + JSON.stringify({ kind: outcome.kind, code: (outcome.error && outcome.error.code) || null }));
  }
}

console.log("=== 3) A LOW-LEVEL LIBRARY ERROR COMES OUT WITH A CODE, NOT null ===");
{
  const wallet = fakeWallet({ unlocked: 0n, syncThrows: false, unlockedThrows: true });
  const outcome = await signOutcome({ createSweep }, wallet);
  if (outcome.kind !== "error") bad("a raw balance-read error did not refuse: " + JSON.stringify(outcome.result));
  else {
    const error = outcome.error;
    console.log("        code: " + String(error && error.code) + "; why: " + String((error.params && error.params.why) || ""));
    if (typeof error.code === "string" && error.code) ok("a raw library error comes out WITH the code " + error.code + " (not null)");
    else bad("a raw error came out WITHOUT a code: " + JSON.stringify({ code: (error && error.code) || null, message: String(error && error.message) }));
    if (String((error.params && error.params.why) || "").includes("failed to get hashes")) ok("the library's own reason is kept as a detail");
    else bad("the library's reason was lost: " + JSON.stringify(error.params));
  }
}

console.log("=== 4) BREAKING RUN A: cut the remainder check -> the refusal stops being named ===");
{
  const { file, dir } = mutatedModule((src) => {
    const before = src;
    src = src.replace(
      '        if (unlocked <= 0n) throw new SdkError("insufficient-funds", { unlocked: unlocked.toString() });\n',
      '        // BREAKING RUN A: the remainder check is cut.\n');
    if (src === before) throw new Error("mutation A did not apply: the remainder-check line was not found");
    return src;
  });
  try {
    const mod = await importFresh(file);
    const wallet = fakeWallet({ unlocked: 0n, syncThrows: true, sweepThrows: true });
    const outcome = await signOutcome(mod, wallet);
    const code = outcome.kind === "error" ? (outcome.error && outcome.error.code) || null : null;
    console.log("        without the remainder check the refusal is: " + JSON.stringify({ code, sweepUnlocked: wallet.calls.sweepUnlocked }));
    if (code === "insufficient-funds") bad("breaking run A does NOT redden: the refusal is still insufficient-funds");
    else ok("breaking run A REDDENS: the remainder check is load-bearing (the code became " + JSON.stringify(code) + ")");
    if (wallet.calls.sweepUnlocked >= 1) ok("without the check the run reaches input selection - which is what fails on an empty wallet");
    else bad("without the check input selection was not even called - the mutation does not reproduce CI");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("=== 5) BREAKING RUN B: cut the wrapper -> code: null + failed to get hashes comes out ===");
{
  const { file, dir } = mutatedModule((src) => {
    const before = src;
    src = src.replace(
      '    if (error instanceof SdkError) throw error;\n    throw new SdkError("wallet-rejected", { surface, why: String((error && error.message) || error) });\n',
      '    throw error;\n');
    if (src === before) throw new Error("mutation B did not apply: the low-level wrapper was not found");
    return src;
  });
  try {
    const mod = await importFresh(file);
    const wallet = fakeWallet({ unlocked: 0n, syncThrows: false, unlockedThrows: true });
    const outcome = await signOutcome(mod, wallet);
    const code = outcome.kind === "error" ? (outcome.error && outcome.error.code) || null : null;
    const message = outcome.kind === "error" ? String((outcome.error && outcome.error.message) || "") : "";
    console.log("        without the wrapper: " + JSON.stringify({ code, message }));
    if (code === null && /failed to get hashes/.test(message)) ok("breaking run B REDDENS AND REPRODUCES CI: code: null + \"" + message + "\"");
    else bad("breaking run B did not reproduce the CI symptom (expected code: null + failed to get hashes): " + JSON.stringify({ code, message }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "withdrawal core on an empty wallet: " + pass + " checks passed.");
if (fails.length) process.exit(1);
