#!/usr/bin/env node
// THE RESTORE HEIGHT: TWO SOURCES, ONE ORDER, AND A NAMED "NONE".
//
// The rule was on the sweep page (read the file, then ask the service by address). It is the package's now,
// because a node or a CLI needs the same answer. What is proven here, with a real file built by the engine and a
// stand-in service:
//   1) the service's height wins when its row knows one;
//   2) the file's height is the fallback - also when the service is unreachable, has no row, or answers a zero;
//   3) no height is `source: "none"` with a token naming why, never a refusal (the person can type one);
//   4) a package without a service does not pretend to ask (`appAsked: false`);
//   5) refusals carry codes: no file, no passphrase, a file that does not open.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory):
//   A) flip the precedence (file wins) -> the service-wins case reddens;
//   B) make an unreachable service throw -> the fallback case reddens;
//   C) drop the address filter -> the "row belongs to another address" case reddens.
//
// Run: node tools/check-restore-height.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRecovery } from "../src/recovery.mjs";
import * as engine from "../src/engine.mjs";
import { SdkError } from "../src/errors.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "src", "recovery.mjs");
const PASSPHRASE = "restore-height-test-pass";
const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

// A REAL FILE: the engine writes it, the facade opens it with the same code the page uses.
async function recoveryFile({ restoreHeight = 0 } = {}) {
  const payload = engine.recoveryFile.buildPayload({
    swap: {
      id: "restore-height", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
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
    restoreHeight,
  });
  engine.recoveryFile.validatePayload(payload);
  return await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE);
}

// THE SERVICE as the facade sees it: one path, one answer. `rows` is what it returns; `throws` models an
// unreachable host.
function service({ rows = [], throws = false } = {}) {
  const asked = { count: 0 };
  const http = {
    async json() {
      asked.count += 1;
      if (throws) throw new Error("no answer");
      return rows;
    },
  };
  const config = { route: (name) => "http://app.invalid/" + name };
  return { http, config, asked };
}

const call = async (recovery, request) => {
  try { return { kind: "ok", result: await recovery.restoreHeight(request) }; }
  catch (error) { return { kind: "error", error }; }
};

console.log("=== 1) THE SERVICE WINS, THE FILE IS THE FALLBACK ===");
{
  const contents = await recoveryFile({ restoreHeight: 2_100_000 });
  const s = service({ rows: [{ address: ADDRESS, restoreHeight: 2_206_635 }] });
  const o = await call(createRecovery(s), { file: { contents }, passphrase: PASSPHRASE });
  if (o.kind === "ok" && o.result.source === "app" && o.result.height === 2_206_635 && o.result.fileHeight === 2_100_000) {
    ok("the service's height wins (2206635), the file's is kept as fileHeight");
  } else bad("precedence: " + JSON.stringify(o.kind === "ok" ? o.result : o.error.code));
  if (o.kind === "ok" && o.result.appAsked === true && o.result.appProblem === null) ok("the service was asked, and no problem is named when a height was found");
  else bad("asked/problem: " + JSON.stringify(o.kind === "ok" ? { asked: o.result.appAsked, problem: o.result.appProblem } : null));
}
{
  const contents = await recoveryFile({ restoreHeight: 2_100_000 });
  const o = await call(createRecovery(service({ rows: [{ address: "other", restoreHeight: 2_206_635 }] })), { file: { contents }, passphrase: PASSPHRASE });
  if (o.kind === "ok" && o.result.source === "file" && o.result.height === 2_100_000) ok("a row for ANOTHER address is not used: the file's height stands");
  else bad("another address's row was used: " + JSON.stringify(o.kind === "ok" ? o.result : o.error.code));
}
{
  const contents = await recoveryFile({ restoreHeight: 2_100_000 });
  const o = await call(createRecovery(service({ throws: true })), { file: { contents }, passphrase: PASSPHRASE });
  if (o.kind === "ok" && o.result.source === "file" && o.result.height === 2_100_000) ok("an unreachable service is not a refusal: the file's height stands");
  else bad("an unreachable service broke the answer: " + JSON.stringify(o.kind === "ok" ? o.result : o.error.code));
}
{
  const contents = await recoveryFile({ restoreHeight: 2_100_000 });
  const o = await call(createRecovery(service({ rows: [{ address: ADDRESS, restoreHeight: 0 }] })), { file: { contents }, passphrase: PASSPHRASE });
  if (o.kind === "ok" && o.result.source === "file") ok("a zero in the service's row is not a height");
  else bad("a zero row was taken: " + JSON.stringify(o.kind === "ok" ? o.result : o.error.code));
}

console.log("=== 2) NO HEIGHT IS A NAMED STATE ===");
{
  const contents = await recoveryFile({ restoreHeight: 0 });
  const o = await call(createRecovery(service({ throws: true })), { file: { contents }, passphrase: PASSPHRASE });
  if (o.kind === "ok" && o.result.source === "none" && o.result.height === 0 && o.result.appProblem === "unreachable") {
    ok("no height, service unreachable -> source none, appProblem unreachable");
  } else bad("unreachable, no height: " + JSON.stringify(o.kind === "ok" ? o.result : o.error.code));
}
{
  const contents = await recoveryFile({ restoreHeight: 0 });
  const o = await call(createRecovery(service({ rows: [] })), { file: { contents }, passphrase: PASSPHRASE });
  if (o.kind === "ok" && o.result.source === "none" && o.result.appProblem === "no-row") ok("no height, no row -> source none, appProblem no-row");
  else bad("no row, no height: " + JSON.stringify(o.kind === "ok" ? o.result : o.error.code));
}
{
  const contents = await recoveryFile({ restoreHeight: 0 });
  const o = await call(createRecovery(), { file: { contents }, passphrase: PASSPHRASE });
  if (o.kind === "ok" && o.result.appAsked === false && o.result.source === "none" && o.result.appProblem === "no-height") {
    ok("a package without a service does not pretend to ask (appAsked false)");
  } else bad("no service: " + JSON.stringify(o.kind === "ok" ? o.result : o.error.code));
}

console.log("=== 3) REFUSALS CARRY CODES ===");
{
  const contents = await recoveryFile({ restoreHeight: 1 });
  const cases = [
    ["no file", { passphrase: PASSPHRASE }, "file"],
    ["no passphrase", { file: { contents } }, "passphrase"],
  ];
  for (const [name, request, field] of cases) {
    const o = await call(createRecovery(), request);
    const named = o.kind === "error" && o.error instanceof SdkError && o.error.code === "bad-input" &&
      String((o.error.params && o.error.params.field) || "") === field;
    if (named) ok(name + " -> bad-input, field " + field);
    else bad(name + " -> " + JSON.stringify(o.kind === "error" ? { code: o.error.code, params: o.error.params } : null));
  }
  const o = await call(createRecovery(), { file: { contents }, passphrase: "wrong-passphrase-12" });
  if (o.kind === "error" && o.error.code === "recovery-failed" && String((o.error.params && o.error.params.stage) || "") === "restore") {
    ok("a file that does not open -> recovery-failed, stage restore");
  } else bad("a wrong passphrase -> " + JSON.stringify(o.kind === "error" ? { code: o.error.code, params: o.error.params } : null));
}

// A COPY WITH ONE PLACE CUT, relative imports rewritten, line endings normalised first.
function mutated(mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-restore-height-"));
  const source = mutate(readFileSync(MODULE, "utf8").replace(/\r\n/g, "\n"));
  const rewritten = source.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) => `from "${pathToFileURL(join(dirname(MODULE), rel)).href}"`);
  const file = join(dir, name + ".mjs");
  writeFileSync(file, rewritten, "utf8");
  return { file, dir };
}
const importFresh = (file) => import(pathToFileURL(file).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 4) BREAKING RUN A: file wins -> the service-wins case reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('const height = appHeight > 0 ? appHeight : fileHeight;', 'const height = fileHeight > 0 ? fileHeight : appHeight;');
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const mod = await importFresh(file);
    const contents = await recoveryFile({ restoreHeight: 2_100_000 });
    let r = null;
    try { r = await mod.createRecovery(service({ rows: [{ address: ADDRESS, restoreHeight: 2_206_635 }] })).restoreHeight({ file: { contents }, passphrase: PASSPHRASE }); } catch { /* below */ }
    if (!r || r.height !== 2_206_635) ok("breaking run A REDDENS: with the flipped order the height is " + (r && r.height));
    else bad("breaking run A does not redden: the height is still the service's");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 5) BREAKING RUN B: an unreachable service throws -> the fallback case reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('        } catch {\n          appProblem = "unreachable";\n        }', '        } catch (e) {\n          throw e;\n        }');
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "b");
  try {
    const mod = await importFresh(file);
    const contents = await recoveryFile({ restoreHeight: 2_100_000 });
    let failed = false;
    try { await mod.createRecovery(service({ throws: true })).restoreHeight({ file: { contents }, passphrase: PASSPHRASE }); }
    catch { failed = true; }
    if (failed) ok("breaking run B REDDENS: an unreachable service becomes a refusal");
    else bad("breaking run B does not redden: the fallback still answered");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 6) BREAKING RUN C: no address filter -> another address's row is used ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('const row = rows.find((x) => String((x && x.address) || "") === String(address)) || null;',
      'const row = rows.find(() => true) || null;');
    if (src === before) throw new Error("mutation C did not apply");
    return src;
  }, "c");
  try {
    const mod = await importFresh(file);
    const contents = await recoveryFile({ restoreHeight: 2_100_000 });
    let r = null;
    try { r = await mod.createRecovery(service({ rows: [{ address: "other", restoreHeight: 2_206_635 }] })).restoreHeight({ file: { contents }, passphrase: PASSPHRASE }); } catch { /* below */ }
    if (!r || r.source === "app") ok("breaking run C REDDENS: another address's row is taken (source " + (r && r.source) + ")");
    else bad("breaking run C does not redden: the row was still filtered");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "restore height: " + pass + " checks passed.");
if (fails.length) process.exit(1);
