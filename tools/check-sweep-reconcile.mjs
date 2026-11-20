#!/usr/bin/env node
// RECONCILE AFTER A LOST SESSION TOKEN. The fake daemon is the only way to put the signed hash in a block, in the
// pool, in neither, and to break the walk at a named height without a live chain.
import { createSweep } from "../src/sweep.mjs";
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { addressFromKeys } from "../engine/monero/address.js";

const G = ed25519.Point.BASE;
const VIEW = 11n;
const SPEND = 13n;
const SPEND_PUB = G.multiply(SPEND).toHex();
const VIEW_PUB = G.multiply(VIEW).toHex();
const ADDRESS = addressFromKeys({ network: "stagenet", kind: "primary", spendPub: SPEND_PUB, viewPub: VIEW_PUB }, { keccak256 });
const H = (height) => (height < 0 ? "00" : height.toString(16).padStart(2, "0")).repeat(32);
const TARGET = "a1".repeat(32);
const SPEND_TX = "b2".repeat(32);
const INPUT = "cd".repeat(32);
const OUTPUT_KEY = "ef".repeat(32);
const TARGET_TX = { version: 2, unlock_time: 0, extra: [], vin: [], vout: [], rct_signatures: { type: 6, ecdhInfo: [], outPk: [] } };
const SPENT_TX = { version: 2, unlock_time: 0, extra: [], vin: [{ key: { k_image: INPUT } }], vout: [], rct_signatures: { type: 6, ecdhInfo: [], outPk: [] } };

function daemon(mode = "absent") {
  const calls = [];
  const blockTxs = mode === "block" || mode === "present" ? { [TARGET]: TARGET_TX }
    : mode === "spent" ? { [SPEND_TX]: SPENT_TX } : {};
  const poolHashes = mode === "pool" ? [TARGET] : [];
  const poolTxs = mode === "pool" ? { [TARGET]: TARGET_TX } : {};
  const allTxs = { ...blockTxs, ...poolTxs };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    if (body.method === "get_info") {
      return { ok: true, json: async () => ({ result: { height: 12, synchronized: true, nettype: "stagenet" } }) };
    }
    if (body.method === "get_block") {
      const height = Number(body.params.height);
      if (mode === "fail" && height === 9) return { ok: false, status: 503 };
      const hashes = Object.entries(blockTxs).filter(() => height === 7).map(([id]) => id);
      return { ok: true, json: async () => ({ result: {
        block_header: { height, hash: H(height), prev_hash: H(height - 1), num_txes: hashes.length },
        tx_hashes: hashes,
      } }) };
    }
    if (String(url).endsWith("/get_transaction_pool_hashes")) {
      if (mode === "pool-fail") return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ tx_hashes: poolHashes }) };
    }
    if (String(url).endsWith("/get_transactions")) {
      const hashes = body.txs_hashes || [];
      return { ok: true, json: async () => ({
        txs: hashes.map((hash) => ({ tx_hash: hash, block_height: poolHashes.includes(hash) ? null : 7, confirmations: poolHashes.includes(hash) ? 0 : 3, in_pool: poolHashes.includes(hash) })),
        txs_as_json: hashes.map((hash) => JSON.stringify(allTxs[hash] || {})),
      }) };
    }
    return { ok: false, status: 404 };
  };
  return { fetch, calls };
}

const call = (mode, txid = TARGET, keyImages = [{ keyImage: INPUT, outputKey: OUTPUT_KEY }]) => createSweep().reconcile({
  node: { url: "https://one.example", operator: "one" },
  address: ADDRESS,
  viewSecret: VIEW,
  spendPub: SPEND_PUB,
  fromHeight: 5,
  txid,
  keyImages,
  fetch: daemon(mode).fetch,
});

const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (condition) console.log("  ok    " + message); else problems.push(message); };

{
  const result = await call("block");
  check(result.outcome === "present" && result.resend === false && result.height === 7 && result.blockHash === H(7),
    "a hash in a block is present and never resent");
}
{
  const result = await call("pool");
  check(result.outcome === "present" && result.resend === false && result.pool === true,
    "a hash in the pool is present and never resent");
}
{
  const result = await call("absent");
  check(result.outcome === "absent" && result.resend === true && result.complete === true && result.height === null,
    "an absent hash with unspent inputs permits the same bytes");
}
{
  const result = await call("spent");
  check(result.outcome === "inputs-spent" && result.resend === false,
    "an absent hash with a spent input never resends");
}
{
  const result = await call("fail");
  check(result.outcome === "unknown" && result.resend === false && result.complete === false
    && result.failed.some((failure) => failure.height === 9),
    "a broken walk keeps the bytes and signs nothing");
}
{
  const result = await call("pool-fail");
  check(result.outcome === "unknown" && result.resend === false,
    "a broken pool read keeps the bytes and signs nothing");
}
{
  let error = null;
  try { await call("absent", "not-a-hash"); } catch (caught) { error = caught; }
  check(error && error.code === "bad-input" && error.params && error.params.field === "txid",
    "a malformed saved hash is refused before any read");
}

if (problems.length) {
  console.error("FAILED:");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
console.log(`PASSED: ${checks} reconcile checks`);
