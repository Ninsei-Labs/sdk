#!/usr/bin/env node
// A RANGE THAT COULD NOT BE READ IS NOT A COMPLETE ZERO (sdk#113, item 15).
//
// scanRange used to catch every block error, log it, and return a smaller sum with no marker. A BUSY transaction
// answer was worse: it looked like an empty block. The answer now names the missing heights.
import { scanRange } from "../engine/monero/scan.js";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const reply = (body) => ({ ok: true, json: async () => body });

function rpc({ failAt = null, busy = false, partial = false } = {}) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    if (url.endsWith("/json_rpc")) {
      const height = Number(request.params && request.params.height);
      if (height === failAt) return { ok: false, json: async () => ({ error: { message: "block busy" } }) };
      return reply({ result: { json: JSON.stringify({ tx_hashes: height === 100 ? ["aa", "bb"] : [] }) } });
    }
    if (url.endsWith("/get_transactions")) {
      if (busy) return reply({ status: "BUSY", txs: [], txs_as_json: [] });
      const hashes = request.txs_hashes || [];
      const kept = partial ? hashes.slice(0, 1) : hashes;
      return reply({
        txs: kept.map((hash) => ({ tx_hash: hash, block_height: 100 })),
        txs_as_json: kept.map(() => JSON.stringify({ extra: [], vout: [] })),
      });
    }
    throw new Error("unexpected route " + url);
  };
}

const run = (options) => scanRange({
  daemonUrl: "https://node.example", fromHeight: 99, toHeight: 101, watched: [], fetchImpl: rpc(options),
});

console.log("=== 1) A FULLY READ RANGE IS COMPLETE ===");
{
  const result = await run({});
  if (result.complete === true && result.missingHeights.length === 0) ok("a readable range is complete");
  else bad("readable range -> " + JSON.stringify({ complete: result.complete, missing: result.missingHeights }));
}

console.log("=== 2) AN UNREADABLE BLOCK IS NAMED ===");
{
  const result = await run({ failAt: 101 });
  if (result.complete === false && result.missingHeights.includes(101) && result.incompleteReason === "blocks-unreadable") {
    ok("a failed block is missingHeights 101, not a complete zero");
  } else bad("failed block -> " + JSON.stringify({ complete: result.complete, missing: result.missingHeights, reason: result.incompleteReason }));
}

console.log("=== 3) A BUSY TRANSACTION ANSWER IS NOT AN EMPTY BLOCK ===");
{
  const result = await run({ busy: true });
  if (result.complete === false && result.missingHeights.includes(100)) ok("BUSY marks block 100 missing");
  else bad("BUSY -> " + JSON.stringify({ complete: result.complete, missing: result.missingHeights }));
}

console.log("=== 4) A PARTIAL TRANSACTION ANSWER IS NAMED ===");
{
  const result = await run({ partial: true });
  if (result.complete === false && result.missingHeights.includes(100)) ok("a missing transaction marks its block missing");
  else bad("partial -> " + JSON.stringify({ complete: result.complete, missing: result.missingHeights }));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "scan range: " + pass + " checks passed.");
if (fails.length) process.exit(1);
