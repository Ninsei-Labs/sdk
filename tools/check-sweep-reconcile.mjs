#!/usr/bin/env node
// RECONCILE AFTER A LOST SESSION TOKEN. The node is asked two direct questions: does this signed hash exist,
// and has each verified input moved? No block range is walked; a partial, malformed or substituted answer is
// unknown and never authorises a resend.
import { createSweep } from "../src/sweep.mjs";

const TARGET = "a1".repeat(32);
const INPUT = "cd".repeat(32);
const OUTPUT_KEY = "ef".repeat(32);
const H = (height) => (height < 0 ? "00" : height.toString(16).padStart(2, "0")).repeat(32);

function daemon(mode = "absent") {
  const calls = [];
  let hashCalls = 0;
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push([path, init && init.headers ? init.headers["Content-Type"] : null]);
    const body = JSON.parse(init.body);
    if (path.endsWith("/json_rpc")) {
      if (mode === "header-fail") return { ok: false, status: 503 };
      const height = Number(body.params.height);
      return { ok: true, json: async () => ({ result: { block_header: { height, hash: H(height) }, status: "OK" } }) };
    }
    if (path.endsWith("/get_transactions")) {
      hashCalls += 1;
      if (mode === "tx-fail") return { ok: false, status: 503 };
      if (mode === "tx-status") return { ok: true, json: async () => ({ status: "Failed", txs: [], txs_as_json: [] }) };
      if (mode === "tx-malformed") return { ok: true, json: async () => ({ status: "OK" }) };
      if (mode === "tx-partial") {
        return { ok: true, json: async () => ({
          status: "OK",
          txs: [{ tx_hash: TARGET, block_height: 7, in_pool: false }],
          txs_as_json: [],
        }) };
      }
      if (mode === "tx-wrong") {
        return { ok: true, json: async () => ({
          status: "OK",
          txs: [{ tx_hash: "ff".repeat(32), block_height: 7, in_pool: false }],
          txs_as_json: ["{}"],
        }) };
      }
      if (mode === "present-untrusted") return { ok: true, json: async () => ({
        status: "OK", txs: [{ tx_hash: TARGET, block_height: 7 }], txs_as_json: ["{}"], untrusted: true }) };
      if (mode === "block" || mode === "pool" || (mode === "race" && hashCalls > 1)) {
        const pool = mode === "pool";
        return { ok: true, json: async () => ({
          status: "OK",
          txs: [{ tx_hash: body.txs_hashes[0], block_height: pool ? 18446744073709551615 : 7,
            confirmations: pool ? 0 : 3, in_pool: pool }],
          txs_as_json: ["{}"],
        }) };
      }
      // EXACT SHAPES RECORDED FROM A REAL, RESTRICTED MONEROD. A hash it does not know leaves both `txs` and
      // `txs_as_json` out and names the hash in `missed_tx`; an answer that names neither is not an absence.
      if (mode === "absent-real" || mode === "absent-real-spent" || (mode === "race" && hashCalls === 1)) {
        return { ok: true, json: async () => ({ status: "OK", missed_tx: [body.txs_hashes[0]], untrusted: false }) };
      }
      if (mode === "missed-other") return { ok: true, json: async () => ({ status: "OK", missed_tx: ["ff".repeat(32)] }) };
      if (mode === "missed-both") return { ok: true, json: async () => ({
        status: "OK",
        txs: [{ tx_hash: body.txs_hashes[0], block_height: 7 }],
        txs_as_json: ["{}"],
        missed_tx: [body.txs_hashes[0]],
      }) };
      if (mode === "untrusted") return { ok: true, json: async () => ({
        status: "OK", missed_tx: [body.txs_hashes[0]], untrusted: true }) };
      if (mode === "no-missed") return { ok: true, json: async () => ({ status: "OK", txs: [], txs_as_json: [] }) };
      return { ok: true, json: async () => ({ status: "OK", txs: [], txs_as_json: [], missed_tx: [body.txs_hashes[0]] }) };
    }
    if (path.endsWith("/is_key_image_spent")) {
      if (mode === "spent-fail") return { ok: false, status: 503 };
      if (mode === "spent-status") return { ok: true, json: async () => ({ status: "Failed", spent_status: [0] }) };
      if (mode === "spent-partial") return { ok: true, json: async () => ({ status: "OK", spent_status: [] }) };
      if (mode === "spent-weird") return { ok: true, json: async () => ({ status: "OK", spent_status: [3] }) };
      if (mode === "spent-untrusted") return { ok: true, json: async () => ({ status: "OK", spent_status: [0], untrusted: true }) };
      if (mode === "spent-busy") return { ok: true, json: async () => ({ status: "BUSY", spent_status: [0] }) };
      if (mode === "spent" || mode === "absent-real-spent") return { ok: true, json: async () => ({ status: "OK", spent_status: [1] }) };
      if (mode === "pool-spent") return { ok: true, json: async () => ({ status: "OK", spent_status: [2] }) };
      return { ok: true, json: async () => ({ status: "OK", spent_status: [0] }) };
    }
    return { ok: false, status: 404 };
  };
  return { fetch, calls, hashCalls: () => hashCalls };
}

const call = (mode, options = {}) => createSweep().reconcile({
  node: { url: "https://one.example", operator: "one" },
  txid: TARGET,
  keyImages: [{ keyImage: INPUT, outputKey: OUTPUT_KEY }],
  fetch: daemon(mode).fetch,
  ...options,
});

const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (condition) console.log("  ok    " + message); else problems.push(message); };

{
  const node = daemon("block");
  const result = await createSweep().reconcile({
    node: { url: "https://one.example", operator: "one" },
    txid: TARGET,
    keyImages: [{ keyImage: INPUT, outputKey: OUTPUT_KEY }],
    fetch: node.fetch,
  });
  check(result.outcome === "present" && result.resend === false && result.height === 7 && result.complete === true,
    "a hash in a block is present and never resent");
  check(result.blockHash === H(7), `a present hash must keep its block hash: ${result.blockHash}`);
  check(node.calls.some(([path]) => path.endsWith("/get_transactions")),
    "a present hash is read by hash");
  check(node.calls.some(([path]) => path.endsWith("/json_rpc")),
    "a present hash reads its block header");
  check(!node.calls.some(([path]) => path.endsWith("/get_block") || path.endsWith("/get_info")),
    "reconcile does not read blocks or the chain tip");
}
{
  const result = await call("pool");
  check(result.outcome === "present" && result.resend === false && result.pool === true,
    "a hash in the pool is present and never resent");
}
{
  const node = daemon("absent");
  const result = await createSweep().reconcile({
    node: { url: "https://one.example", operator: "one" },
    txid: TARGET,
    keyImages: [{ keyImage: INPUT, outputKey: OUTPUT_KEY }],
    fromHeight: 20,
    fetch: node.fetch,
  });
  check(result.outcome === "absent" && result.resend === true && result.complete === true && result.height === null,
    "an absent hash with unspent inputs permits the same bytes, without a start height");
  check(node.calls.some(([path, type]) => path.endsWith("/is_key_image_spent") && type === "application/json"),
    "the spent check uses the JSON endpoint");
}
{
  // THE REAL RESTRICTED-NODE SHAPE: no `txs` or `txs_as_json`, and the requested hash named in `missed_tx`.
  const result = await call("absent-real");
  check(result.outcome === "absent" && result.resend === true && result.complete === true,
    "a real missed_tx answer with an omitted empty list is an absent hash");
}
{
  const result = await call("absent-real-spent");
  check(result.outcome === "inputs-spent" && result.resend === false && result.pool === false,
    "a real missed_tx answer with a spent input is inputs-spent");
}
{
  for (const mode of ["missed-other", "missed-both", "untrusted", "no-missed", "present-untrusted", "spent-untrusted", "spent-busy"]) {
    const result = await call(mode);
    check(result.outcome === "unknown" && result.resend === false && result.complete === false,
      `${mode} must be unknown and must never resend`);
  }
}
{
  // THE PERSON'S OWN TRANSACTION LANDS BETWEEN THE TWO ANSWERS. The hash answer is followed by the spent answer;
  // a transaction found on the second hash read is present, not inputs-spent.
  const node = daemon("race");
  const result = await createSweep().reconcile({
    node: { url: "https://one.example", operator: "one" },
    txid: TARGET,
    keyImages: [{ keyImage: INPUT, outputKey: OUTPUT_KEY }],
    fetch: node.fetch,
  });
  check(result.outcome === "present" && result.resend === false, "a transaction landing after the spent answer is present");
  check(node.hashCalls() === 2, `the hash is read again after the spent answer: ${node.hashCalls()} reads`);
}
{
  const result = await call("spent");
  check(result.outcome === "inputs-spent" && result.resend === false && result.pool === false,
    "an absent hash with a spent input never resends");
}
{
  const result = await call("pool-spent");
  check(result.outcome === "inputs-spent" && result.resend === false && result.pool === true,
    "a pool spend is named as a pool input and never resends");
}
{
  const result = await call("tx-fail");
  check(result.outcome === "unknown" && result.resend === false && result.complete === false
    && result.failed.some((failure) => failure.status === 503),
    "an unreadable transaction answer keeps the bytes and signs nothing");
}
{
  const result = await call("tx-malformed");
  check(result.outcome === "unknown" && result.resend === false,
    "a malformed transaction answer keeps the bytes and signs nothing");
}
{
  const result = await call("tx-status");
  check(result.outcome === "unknown" && result.resend === false
    && result.failed.some((failure) => failure.why === "rpc-status"),
    "a transaction answer with a failed status is unknown, never an absence");
}
{
  const result = await call("tx-partial");
  check(result.outcome === "unknown" && result.resend === false,
    "a partial transaction answer is unknown, never an absence");
}
{
  const result = await call("tx-wrong");
  check(result.outcome === "unknown" && result.resend === false,
    "a substituted transaction hash is unknown, never a presence");
}
{
  const result = await call("spent-fail");
  check(result.outcome === "unknown" && result.resend === false && result.complete === false
    && result.failed.some((failure) => failure.status === 503),
    "an unreadable spent status keeps the bytes and signs nothing");
}
{
  const result = await call("spent-partial");
  check(result.outcome === "unknown" && result.resend === false,
    "a short spent-status list is unknown, never unspent");
}
{
  const result = await call("spent-status");
  check(result.outcome === "unknown" && result.resend === false
    && result.failed.some((failure) => failure.why === "rpc-status"),
    "a spent answer with a failed status is unknown, never unspent");
}
{
  const result = await call("spent-weird");
  check(result.outcome === "unknown" && result.resend === false,
    "an unknown spent status is unknown, never unspent");
}
{
  let error = null;
  try { await call("absent", { txid: "not-a-hash" }); } catch (caught) { error = caught; }
  check(error && error.code === "bad-input" && error.params && error.params.field === "txid",
    "a malformed saved hash is refused before any read");
}
{
  let error = null;
  try { await call("absent", { keyImages: [] }); } catch (caught) { error = caught; }
  check(error && error.code === "bad-input" && error.params && error.params.field === "keyImages",
    "an empty key-image list is refused before any read");
}

if (problems.length) {
  console.error("FAILED:");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
console.log(`PASSED: ${checks} reconcile checks`);
