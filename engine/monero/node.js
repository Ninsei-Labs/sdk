// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/node.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// The live Monero node: the only real external dependency of the demo.
//
// The node address is the MONERO.node constant in www/js/core/config.js - the proxy
// address is supplied at deploy time (see the deploy config for the Monero RPC proxy).
// The demo has no parameters or overrides: the address is one and visible in the code.
// We use the node for two honest things:
//   1) network status in the header: real height, nettype, node availability;
//   2) "live chain" mode: Monero confirmations are counted from real height growth,
//      not from a timer (slow - a block is ~2 minutes, but real).
//
// Balances, outputs and keys are NOT queried through this RPC: that needs a wallet
// (wallet2 in WASM + view key), which is the next step, not what the demo does.

import { MONERO } from "../core/config.js";

const RPC = MONERO.node;
const TIMEOUT_MS = 8000;
const CACHE_MS = 15_000;

let cache = { at: 0, data: null, error: null };
let inflight = null;

async function rpc(method, params = {}, path = "/json_rpc") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RPC + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "ninsei-demo", method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "RPC error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

export function snapshot() {
  return cache.data;
}

export function lastError() {
  return cache.error;
}

// Network height at call time (from cache, if fresh).
export async function height() {
  const info = await getInfo();
  return info ? info.height : null;
}

export async function getInfo({ force = false } = {}) {
  const fresh = cache.data && Date.now() - cache.at < CACHE_MS;
  if (fresh && !force) return cache.data;
  if (inflight) return inflight;

  inflight = rpc("get_info")
    .then((info) => {
      cache = { at: Date.now(), data: normalize(info), error: null };
      return cache.data;
    })
    .catch((e) => {
      cache = { at: Date.now(), data: null, error: e.message };
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function normalize(info) {
  return {
    height: info.height,
    nettype: info.nettype || (info.mainnet ? "mainnet" : info.stagenet ? "stagenet" : "testnet"),
    offline: !!info.offline,
    busySyncing: !!info.busy_syncing,
    version: info.version,
    target: info.target,
    txPoolSize: info.tx_pool_size,
    outgoing: info.outgoing_connections_count,
    incoming: info.incoming_connections_count,
    databaseSizeGb: info.database_size ? Math.round(info.database_size / 1024 ** 3) : null,
    fetchedAt: Date.now(),
  };
}

// Poll every 30 seconds while the page is open: the header shows the live height.
let poller = null;
export function startPolling(onUpdate, intervalMs = 30_000) {
  if (poller) clearInterval(poller);
  const tick = async () => {
    const info = await getInfo({ force: true });
    if (onUpdate) onUpdate(info, lastError());
  };
  tick();
  poller = setInterval(tick, intervalMs);
  return () => clearInterval(poller);
}

export const nodeUrl = RPC;
