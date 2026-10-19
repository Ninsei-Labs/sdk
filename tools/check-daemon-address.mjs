#!/usr/bin/env node
// WHERE A MONERO NODE MAY LIVE - ONE POLICY FOR THE NODE AND FOR THE PAGE.
//
// An open http:// connection to a machine across the network shows anyone on the path the addresses, the amounts and
// the transfer ids. The node refuses that on mainnet; the sweep page, which lets an operator type their own node
// address, accepts it today. Two answers to one question is how one of them ends up allowing what the other forbids.
//
// WHAT IS PROVEN:
//   1) https is accepted anywhere, loopback or remote;
//   2) http on loopback is accepted, and refused when the exception is switched off;
//   3) http to a remote host is refused on mainnet, accepted on stagenet and testnet;
//   4) an unknown network is judged as mainnet, not guessed safe;
//   5) an empty value is "nothing to judge", a non-URL and a foreign scheme are named refusals;
//   6) the setting form: 0/false/no/off switches off, a typo does not.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory):
//   A) accept plain http on every network -> case 3 reddens;
//   B) treat loopback as remote -> case 2 reddens.
//
// Run: node tools/check-daemon-address.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DAEMON_CODES, judgeDaemonAddress, plainLoopbackAllowed } from "../src/public/xmr.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(ROOT, "engine", "monero", "daemonAddress.js");

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const judge = (url, options) => judgeDaemonAddress(url, options);

console.log("=== 1) https IS ACCEPTED ANYWHERE ===");
{
  for (const url of ["https://node.example:18081", "https://127.0.0.1:18081"]) {
    const r = judge(url, { network: "mainnet" });
    if (r.ok && r.scheme === "https") ok(url + " accepted");
    else bad(url + " -> " + JSON.stringify(r));
  }
}

console.log("=== 2) http ON LOOPBACK ===");
{
  const r = judge("http://127.0.0.1:38081");
  if (r.ok && r.loopback && !r.plainHttpAccepted) ok("loopback http accepted, not reported as a remote plain-http accept");
  else bad("loopback: " + JSON.stringify(r));
  for (const host of ["localhost", "[::1]"]) {
    const v = judge("http://" + host + ":38081");
    if (v.ok && v.loopback) ok(host + " counts as loopback");
    else bad(host + ": " + JSON.stringify(v));
  }
  const refused = judge("http://127.0.0.1:38081", { allowPlainLoopback: false });
  if (!refused.ok && refused.code === DAEMON_CODES.notHttps) ok("the loopback exception switched off refuses loopback");
  else bad("switched off: " + JSON.stringify(refused));
}

console.log("=== 3) http TO A REMOTE HOST ===");
{
  const mainnet = judge("http://node.example:18081", { network: "mainnet" });
  if (!mainnet.ok && mainnet.code === DAEMON_CODES.notHttps) ok("mainnet refuses (daemon-not-https)");
  else bad("mainnet: " + JSON.stringify(mainnet));
  for (const network of ["stagenet", "testnet"]) {
    const r = judge("http://node.example:18081", { network });
    if (r.ok && r.plainHttpAccepted) ok(network + " accepts and says so (plainHttpAccepted)");
    else bad(network + ": " + JSON.stringify(r));
  }
  const unknown = judge("http://node.example:18081", { network: "devnet" });
  if (!unknown.ok && unknown.network === "devnet") ok("an unknown network is judged as mainnet");
  else bad("devnet: " + JSON.stringify(unknown));
}

console.log("=== 4) REFUSALS AND THE EMPTY VALUE ===");
{
  const empty = judge("");
  if (empty.ok && empty.configured === false) ok("an empty value is nothing to judge, not a refusal");
  else bad("empty: " + JSON.stringify(empty));
  const noScheme = judge("node.example:18081");
  if (!noScheme.ok && noScheme.code === DAEMON_CODES.unreadable) ok("a non-URL is named (daemon-address-unreadable)");
  else bad("non-url: " + JSON.stringify(noScheme));
  const ftp = judge("ftp://node.example");
  if (!ftp.ok && ftp.code === DAEMON_CODES.schemeUnknown) ok("a foreign scheme is named (daemon-scheme-unknown)");
  else bad("ftp: " + JSON.stringify(ftp));
}

console.log("=== 5) THE SETTING FORM ===");
{
  const cases = [[undefined, true], ["", true], ["1", true], ["yes", true], ["maybe", true], ["0", false], ["false", false], ["NO", false], ["off", false]];
  const wrong = cases.filter(([raw, want]) => plainLoopbackAllowed(raw) !== want);
  if (!wrong.length) ok("0/false/no/off switch off, anything else leaves it on (" + cases.length + " cases)");
  else bad("setting form: " + JSON.stringify(wrong));
}

function mutated(mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-daemon-address-"));
  const source = mutate(readFileSync(MODULE, "utf8").replace(/\r\n/g, "\n"));
  const file = join(dir, name + ".mjs");
  writeFileSync(file, source, "utf8");
  return { file, dir };
}
const importFresh = (p) => import(pathToFileURL(p).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 6) BREAKING RUN A: plain http accepted everywhere -> case 3 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('if (DAEMON_PLAIN_HTTP_NETWORKS.includes(net)) {', "if (true) {");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const mod = await importFresh(file);
    const r = mod.judgeDaemonAddress("http://node.example:18081", { network: "mainnet" });
    if (r.ok) ok("breaking run A REDDENS: mainnet plain http accepted");
    else bad("breaking run A does not redden");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 7) BREAKING RUN B: loopback treated as remote -> case 2 reddens ===");
{
  const { file, dir } = mutated((src) => {
    const before = src;
    src = src.replace('return LOOPBACK_HOSTS.has(String(host || "").toLowerCase());', "return false;");
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "b");
  try {
    const mod = await importFresh(file);
    const r = mod.judgeDaemonAddress("http://127.0.0.1:38081", { network: "mainnet" });
    if (!r.ok) ok("breaking run B REDDENS: loopback http refused on mainnet");
    else bad("breaking run B does not redden");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "daemon address: " + pass + " checks passed.");
if (fails.length) process.exit(1);
