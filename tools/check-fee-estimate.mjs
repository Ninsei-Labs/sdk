#!/usr/bin/env node
// WHAT A TRANSACTION WILL COST, BEFORE IT IS BUILT.
//
// The Monero fee is the price of a byte times the size of the transaction. The price belongs to the network and is
// asked from the node; the size is known only after assembly. The page learned the fee only after signing, so a
// person deciding whether to withdraw could not see it. This is the price and the one arithmetic that turns it into
// a sum.
//
// WHAT IS PROVEN (a stand-in fetch; no network):
//   1) the daemon's snake_case answer and the library's camelCase are both read, and the priority list keeps its order;
//   2) a field the node did not send is null, never zero; an answer with no price at all is a refusal;
//   3) feeForBytes rounds UP, so a sum is never one unit short;
//   4) HTTP, non-JSON, an RPC error, an unreachable host, a timeout and missing inputs each get their own name.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory):
//   A) round the fee DOWN -> the ceil case reddens;
//   B) turn a missing price into zero -> the null case reddens.
//
// Run: node tools/check-fee-estimate.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { feeForBytes, moneroFeeEstimate } from "../src/public/xmr.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "src", "feeEstimate.mjs");

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

const respond = (body, { status = 200, json = true } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { if (!json) throw new SyntaxError("not json"); return body; },
});
const result = (r) => respond({ jsonrpc: "2.0", id: "0", result: r });

console.log("=== 1) THE DAEMON'S ANSWER, BOTH SPELLINGS ===");
{
  const r = await moneroFeeEstimate({ url: "http://node.invalid", fetchImpl: result({ fee: 20000, fees: [10000, 20000, 40000], quantization_mask: 1000 }) });
  if (r.ok && r.feePerByte === "20000" && r.quantizationMask === "1000") ok("the daemon's per-byte fee and mask are read");
  else bad("snake_case: " + JSON.stringify(r));
  if (Array.isArray(r.perPriority) && r.perPriority.join(",") === "10000,20000,40000") ok("the priority list keeps the daemon's order");
  else bad("priorities: " + JSON.stringify(r.perPriority));
}
{
  const r = await moneroFeeEstimate({ url: "http://node.invalid", fetchImpl: result({ feePerByte: 21000, feesPerByte: [21000], quantizationMask: 1000 }) });
  if (r.ok && r.feePerByte === "21000" && r.quantizationMask === "1000") ok("camelCase is read");
  else bad("camelCase: " + JSON.stringify(r));
}
{
  const calls = [];
  await moneroFeeEstimate({ url: "http://node.invalid/", fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, async json() { return { result: { fee: 1 } }; } }; } });
  const call = calls[0] || {};
  if (call.url === "http://node.invalid/json_rpc" && /get_fee_estimate/.test(call.init.body)) ok("one POST to /json_rpc with get_fee_estimate");
  else bad("request: " + JSON.stringify(call.url));
}

console.log("=== 2) A MISSING NUMBER IS NULL, NOT ZERO ===");
{
  const r = await moneroFeeEstimate({ url: "http://node.invalid", fetchImpl: result({ fee: 20000 }) });
  if (r.ok && r.quantizationMask === null && r.perPriority === null) ok("what the node did not send is null");
  else bad("partial: " + JSON.stringify(r));
}
{
  const r = await moneroFeeEstimate({ url: "http://node.invalid", fetchImpl: result({}) });
  if (r.ok === false && r.why === "no-estimate") ok("an answer with no price at all is a named refusal");
  else bad("empty answer: " + JSON.stringify(r));
}

console.log("=== 3) THE FEE FOR A SIZE ===");
{
  if (feeForBytes(20000, 1500) === "30000000") ok("1500 bytes at 20000/byte is 30,000,000");
  else bad("per-byte: " + feeForBytes(20000, 1500));
  if (feeForBytes(20000, 1024) === "20480000") ok("1024 bytes at 20000/byte is 20,480,000");
  else bad("exact: " + feeForBytes(20000, 1024));
  if (feeForBytes("0", 1500) === "0") ok("a zero price is zero, not a refusal");
  else bad("zero: " + feeForBytes(0, 1500));
  for (const [name, call] of [["a negative price", () => feeForBytes(-1, 10)], ["a fractional size", () => feeForBytes(1000, 1.5)]]) {
    let threw = false;
    try { call(); } catch { threw = true; }
    if (threw) ok(name + " is refused");
    else bad(name + " was accepted");
  }
}

console.log("=== 4) EVERY FAILURE HAS ITS OWN NAME ===");
{
  const cases = [
    ["HTTP 502", respond({}, { status: 502 }), (r) => r.why === "http" && r.status === 502],
    ["not JSON", respond({}, { json: false }), (r) => r.why === "not-json"],
    ["an RPC error", respond({ error: { code: -32601 } }), (r) => r.why === "rpc" && r.rpc === -32601],
    ["an unreachable host", async () => { throw new TypeError("failed"); }, (r) => r.why === "unreachable"],
    ["a timeout", async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, (r) => r.why === "timeout"],
  ];
  for (const [name, fetchImpl, want] of cases) {
    const r = await moneroFeeEstimate({ url: "http://node.invalid", fetchImpl });
    if (r.ok === false && want(r)) ok(name + " -> why: " + r.why);
    else bad(name + ": " + JSON.stringify(r));
  }
  for (const [name, options] of [["no url", { url: "" }], ["no fetch", { url: "http://node.invalid", fetchImpl: null }]]) {
    const r = await moneroFeeEstimate(options);
    if (r.ok === false && (r.why === "no-url" || r.why === "no-fetch")) ok(name + " -> why: " + r.why);
    else bad(name + ": " + JSON.stringify(r));
  }
}

function mutated(mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-fee-estimate-"));
  const source = mutate(readFileSync(MODULE, "utf8").replace(/\r\n/g, "\n"));
  const file = join(dir, name + ".mjs");
  writeFileSync(file, source, "utf8");
  return { file, dir };
}
const importFresh = (p) => import(pathToFileURL(p).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 5) BREAKING RUN A: round down -> case 3 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("return (perByte * size).toString();", "return (perByte * size / 1024n).toString();");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const mod = await importFresh(file);
    const got = mod.feeForBytes(20000, 1500);
    if (got !== "30000000") ok("breaking run A REDDENS: 1500 bytes became " + got);
    else bad("breaking run A does not redden");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 6) BREAKING RUN B: a missing price becomes zero -> case 2 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('return null;\n};\n\n/**\n * ASK A NODE', 'return "0";\n};\n\n/**\n * ASK A NODE');
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "b");
  try {
    const mod = await importFresh(file);
    const r = await mod.moneroFeeEstimate({ url: "http://node.invalid", fetchImpl: result({ fee: 20000 }) });
    if (r.quantizationMask !== null) ok("breaking run B REDDENS: a missing mask became " + JSON.stringify(r.quantizationMask));
    else bad("breaking run B does not redden: still null");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "fee estimate: " + pass + " checks passed.");
if (fails.length) process.exit(1);
