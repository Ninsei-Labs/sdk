// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/node.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Живой Monero-нод: единственная реальная внешняя зависимость демки.
//
// Адрес ноды - константа MONERO.node в www/js/core/config.js: наш прокси
// https://xmr.arrakisswap.trade (конфиг .hermes/deploy/arrakis-xmr-rpc.conf).
// Никаких параметров и переопределений у демки нет: адрес один и виден в коде.
// Используем ноду для двух честных вещей:
//   1) статус сети в шапке: реальная высота, nettype, доступность нода;
//   2) режим "live chain": подтверждения Monero считаются по реальному росту высоты,
//      а не по таймеру (медленно - блок ~2 минуты, зато по-настоящему).
//
// Балансы, outputs и ключи через этот RPC не запрашиваются: для этого нужен кошелёк
// (wallet2 в WASM + view-ключ), это следующий шаг, а не то, что делает демка.

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
      body: JSON.stringify({ jsonrpc: "2.0", id: "arrakis-demo", method, params }),
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

// Высота сети на момент вызова (из кеша, если он свежий).
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

// Опрос раз в 30 секунд, пока страница открыта: шапка показывает живую высоту.
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
