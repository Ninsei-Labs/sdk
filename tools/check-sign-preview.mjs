#!/usr/bin/env node
// WHAT THE WITHDRAWAL COSTS, BEFORE IT LEAVES.
//
// `sign` moves the whole free remainder, so the fee is not extra money on top - it comes out of the remainder and
// the recipient receives the rest. The answer used to name only the remainder, which reads as "this is what will
// arrive". A wallet that cannot report a fee must say nothing (`null`), never 0: a zero is a claim the package
// cannot support.
//
// WHAT IS PROVEN (a stand-in wallet; the recovery file is built by the engine):
//   1) a reported fee comes back as a string, and `receive` is the remainder minus the fee;
//   2) a wallet without `fee` gives null/null - not zero;
//   3) a fee that is not a non-negative integer string, or a throwing fee, is unknown (null), not trusted;
//   4) a fee that claims more than the remainder gives `receive: null`, not a negative number.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory):
//   A) default an unknown fee to "0" -> case 2 reddens;
//   B) drop the "fee >= remainder" guard -> case 4 reddens.
//
// Run: node tools/check-sign-preview.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSweep } from "../src/sweep.mjs";
import * as engine from "../src/engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SWEEP = join(ROOT, "src", "sweep.mjs");
const PASSPHRASE = "sign-preview-test-pass";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";

// A REAL FILE. The revealed half is served by a stand-in app; nothing goes to the network.
async function planRequest() {
  const payload = engine.recoveryFile.buildPayload({
    swap: {
      id: "sign-preview", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
      createdAt: new Date(0).toISOString(), payToken: "USDC", payAmount: 1, xmrAmount: 0.5,
      escrow: { address: "0x00000000000000000000000000000000000000e5", termsHash: null },
    },
    swapWallet: {
      source: "unit", library: "monero-ts", network: "stagenet", address: ADDRESS,
      spendHalf: "0x" + "11".repeat(32), viewHalf: "0x" + "22".repeat(32),
      otherSpendPoint: "0x" + "33".repeat(32), otherViewPoint: "0x" + "44".repeat(32),
      otherViewHalf: "0x" + "55".repeat(32),
    },
    escrow: { address: "0x00000000000000000000000000000000000000e5" },
    receiveAddress: ADDRESS,
    restoreHeight: 2_206_635,
  });
  engine.recoveryFile.validatePayload(payload);
  const contents = await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE);
  return { file: { contents }, passphrase: PASSPHRASE, to: ADDRESS };
}

const http = {
  async json(url, options) {
    if (options === undefined) return [{ address: ADDRESS, restoreHeight: 2_206_635 }];
    return { ok: true, revealed: true, half: "0x" + "ab".repeat(32) };
  },
};
const config = { route: (name) => "http://app.invalid/" + name };
const facade = (mod = { createSweep }) => mod.createSweep({ http, config });

// THE STAND-IN WALLET: the withdrawal surface the signing step takes. `feeKind` decides what it reports.
function wallet({ unlocked = 5_000_000_000_000n, feeKind = "number", fee = 30_000_000n } = {}) {
  const base = {
    async open() {},
    async sync() {},
    async unlockedBalance() { return unlocked; },
    async sweepUnlocked() { return { signed: true }; },
    async relay() { return ["tx"]; },
    async close() {},
  };
  if (feeKind === "none") return base;
  if (feeKind === "throws") return { ...base, async fee() { throw new Error("no fee"); } };
  if (feeKind === "garbage") return { ...base, async fee() { return "12 piconero"; } };
  if (feeKind === "null") return { ...base, async fee() { return null; } };
  return { ...base, async fee() { return fee; } };
}

const sign = async (mod, w) => {
  const request = await planRequest();
  try { return { kind: "ok", result: await facade(mod).sign({ ...request, connectWallet: async () => w }) }; }
  catch (error) { return { kind: "error", error }; }
};

console.log("=== 1) A REPORTED FEE: the recipient receives the remainder minus the fee ===");
{
  const o = await sign({ createSweep }, wallet({ fee: 30_000_000n }));
  if (o.kind !== "ok") bad("sign refused: " + JSON.stringify((o.error && o.error.code) || null));
  else {
    const r = o.result;
    if (r.fee === "30000000") ok("the fee is a string in atomic units");
    else bad("fee: " + JSON.stringify(r.fee));
    if (r.amount === "5000000000000") ok("amount is still the free remainder");
    else bad("amount: " + JSON.stringify(r.amount));
    if (r.receive === "4999970000000") ok("receive = remainder - fee (4999970000000)");
    else bad("receive: " + JSON.stringify(r.receive));
  }
}

console.log("=== 2) A WALLET THAT CANNOT REPORT A FEE: null, never zero ===");
{
  for (const [name, kind] of [["no fee method", "none"], ["fee throws", "throws"], ["fee is garbage", "garbage"], ["fee is null", "null"]]) {
    const o = await sign({ createSweep }, wallet({ feeKind: kind }));
    if (o.kind !== "ok") { bad(name + ": sign refused"); continue; }
    if (o.result.fee === null && o.result.receive === null) ok(name + " -> fee null, receive null");
    else bad(name + " -> " + JSON.stringify({ fee: o.result.fee, receive: o.result.receive }));
  }
}

console.log("=== 3) A FEE LARGER THAN THE REMAINDER: no negative receive ===");
{
  const o = await sign({ createSweep }, wallet({ unlocked: 10n, fee: 100n }));
  if (o.kind === "ok" && o.result.fee === "100" && o.result.receive === null) ok("a fee above the remainder gives receive: null");
  else bad("fee above remainder: " + JSON.stringify(o.kind === "ok" ? { fee: o.result.fee, receive: o.result.receive } : o.error.code));
}

function mutated(mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-sign-preview-"));
  const source = mutate(readFileSync(SWEEP, "utf8").replace(/\r\n/g, "\n"));
  const rewritten = source.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) => `from "${pathToFileURL(join(dirname(SWEEP), rel)).href}"`);
  const file = join(dir, name + ".mjs");
  writeFileSync(file, rewritten, "utf8");
  return { file, dir };
}
const importFresh = (file) => import(pathToFileURL(file).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 4) BREAKING RUN A: an unknown fee becomes \"0\" -> case 2 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('if (!wallet || typeof wallet.fee !== "function") return null;', 'if (!wallet || typeof wallet.fee !== "function") return "0";');
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const mod = await importFresh(file);
    const o = await sign(mod, wallet({ feeKind: "none" }));
    if (o.kind === "ok" && o.result.fee !== null) ok("breaking run A REDDENS: an unknown fee became " + JSON.stringify(o.result.fee));
    else bad("breaking run A does not redden: the fee is still null");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 5) BREAKING RUN B: no guard on a huge fee -> case 3 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("receive: feeValue === null || feeValue >= unlocked ? null : (unlocked - feeValue).toString(),",
      "receive: feeValue === null ? null : (unlocked - feeValue).toString(),");
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "b");
  try {
    const mod = await importFresh(file);
    const o = await sign(mod, wallet({ unlocked: 10n, fee: 100n }));
    if (o.kind === "ok" && o.result.receive !== null) ok("breaking run B REDDENS: receive became " + JSON.stringify(o.result.receive));
    else bad("breaking run B does not redden: receive is still null");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "sign preview: " + pass + " checks passed.");
if (fails.length) process.exit(1);
