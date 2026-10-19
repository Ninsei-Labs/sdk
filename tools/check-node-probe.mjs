#!/usr/bin/env node
// IS THE NODE USABLE, AND WHAT DOES IT SAY ABOUT ITSELF.
//
// The sweep page ran its own preflight - a get_info request, a height check, a guess about the network. Every
// interface that withdraws needs the same answer; a preflight that disagrees with the wallet builder is a page that
// says "ready" and then fails to open a wallet. The answer must name WHY, because "unreachable" and "this node
// names an unknown network" are different problems for the person.
//
// WHAT IS PROVEN (a stand-in fetch; no network):
//   1) a good answer gives height, network, sync state, version and the round trip;
//   2) an unknown nettype is a refusal, not "probably stagenet";
//   3) a missing or fractional height is a refusal;
//   4) HTTP, non-JSON, an RPC error, an unreachable host and a timeout each get their own `why`;
//   5) no url / no fetch are refusals, and the function never throws.
//
// BREAKING RUN (mutates a COPY of the module in a temp directory):
//   A) accept an unknown nettype -> case 2 reddens.
//
// Run: node tools/check-node-probe.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeMoneroNode } from "../src/public/xmr.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "src", "probes.mjs");

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

const respond = (body, { status = 200, json = true } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { if (!json) throw new SyntaxError("not json"); return body; },
});
const getInfo = (result) => respond({ jsonrpc: "2.0", id: "0", result });
const GOOD = { height: 2_238_123, nettype: "stagenet", synchronized: true, version: "0.18.4.0", status: "OK" };

console.log("=== 1) A GOOD ANSWER ===");
{
  const r = await probeMoneroNode({ url: "http://node.invalid", fetchImpl: getInfo(GOOD) });
  if (r.ok && r.height === 2_238_123 && r.network === "stagenet") ok("height and network come back");
  else bad("good answer: " + JSON.stringify(r));
  if (r.synchronized === true && r.version === "0.18.4.0" && typeof r.ms === "number") ok("sync state, version and the round trip are named");
  else bad("details: " + JSON.stringify(r));
}
{
  const calls = [];
  await probeMoneroNode({ url: "http://node.invalid/", fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, async json() { return { result: GOOD }; } }; } });
  const call = calls[0] || {};
  if (call.url === "http://node.invalid/json_rpc" && /get_info/.test(call.init.body)) ok("one POST to /json_rpc with get_info (a trailing slash is trimmed)");
  else bad("request: " + JSON.stringify(call.url));
}

console.log("=== 2) WHAT THE NODE SAYS ABOUT ITSELF ===");
{
  const r = await probeMoneroNode({ url: "http://node.invalid", fetchImpl: getInfo({ ...GOOD, nettype: "devnet" }) });
  if (r.ok === false && r.why === "nettype") ok("an unknown nettype is a refusal (why: nettype)");
  else bad("unknown nettype: " + JSON.stringify(r));
}
for (const [name, result] of [["no height", { ...GOOD, height: undefined }], ["a fractional height", { ...GOOD, height: 1.5 }], ["a negative height", { ...GOOD, height: -1 }]]) {
  const r = await probeMoneroNode({ url: "http://node.invalid", fetchImpl: getInfo(result) });
  if (r.ok === false && r.why === "no-height") ok(name + " is a refusal (why: no-height)");
  else bad(name + ": " + JSON.stringify(r));
}

console.log("=== 3) EVERY FAILURE HAS ITS OWN NAME ===");
{
  const cases = [
    ["HTTP 502", respond({}, { status: 502 }), (r) => r.why === "http" && r.status === 502],
    ["not JSON", respond({}, { json: false }), (r) => r.why === "not-json"],
    ["an RPC error", respond({ error: { code: -32601, message: "Method not found" } }), (r) => r.why === "rpc" && r.rpc === -32601],
    ["an unreachable host", async () => { throw new TypeError("fetch failed"); }, (r) => r.why === "unreachable"],
    ["a timeout", async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, (r) => r.why === "timeout"],
  ];
  for (const [name, fetchImpl, want] of cases) {
    const r = await probeMoneroNode({ url: "http://node.invalid", fetchImpl });
    if (r.ok === false && want(r)) ok(name + " -> why: " + r.why);
    else bad(name + ": " + JSON.stringify(r));
  }
}
{
  for (const [name, options] of [["no url", { url: "" }], ["no fetch", { url: "http://node.invalid", fetchImpl: null }]]) {
    const r = await probeMoneroNode(options);
    if (r.ok === false && (r.why === "no-url" || r.why === "no-fetch")) ok(name + " -> why: " + r.why);
    else bad(name + ": " + JSON.stringify(r));
  }
}

function mutated(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "check-node-probe-"));
  const source = mutate(readFileSync(MODULE, "utf8").replace(/\r\n/g, "\n"));
  const rewritten = source.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) => `from "${pathToFileURL(join(dirname(MODULE), rel)).href}"`);
  const file = join(dir, "probes.mjs");
  writeFileSync(file, rewritten, "utf8");
  return { file, dir };
}
const importFresh = (p) => import(pathToFileURL(p).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 4) BREAKING RUN A: an unknown nettype is accepted -> case 2 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace("const network = networkFromNode(info);", 'const network = networkFromNode(info) || "stagenet";');
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  });
  try {
    const mod = await importFresh(file);
    const r = await mod.probeMoneroNode({ url: "http://node.invalid", fetchImpl: getInfo({ ...GOOD, nettype: "devnet" }) });
    if (r.ok === true) ok("breaking run A REDDENS: an unknown nettype became " + JSON.stringify(r.network));
    else bad("breaking run A does not redden: still refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "node probe: " + pass + " checks passed.");
if (fails.length) process.exit(1);
