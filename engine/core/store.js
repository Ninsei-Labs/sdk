// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/store.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Demo state storage.
//
// Why it exists at all: litepaper §5.1.7 - "the tab can be closed, the browser will restore the state". The swap
// state is derived from saved timestamps and events, so the tab really can be closed.
//
// STORAGE COMES FROM OUTSIDE. Before, `localStorage` stood right in the code, and that made the module unusable
// both in Node (the repository checks) and in the SDK (the package promises "no DOM"). Now storage is an adapter
// with three actions (get/set/remove), and by default localStorage is taken IF it exists in the environment,
// otherwise process memory: silently not saving is not allowed - the swap would be lost after a reload.

import { APP, DEMO } from "./config.js";

const EMPTY = {
  version: 1,
  // payToken - the chosen payment asset. Stored next to the network: otherwise the form on reload returned
  // the native token and the user's choice was lost.
  settings: { speed: DEMO.defaultSpeed, scenario: DEMO.defaultScenario, chainMode: DEMO.defaultChainMode, chain: DEMO.defaultChain, payToken: "" },
  wallet: { connected: false, address: null, balances: {} },
  swaps: {},
  activeSwapId: null,
};

// DEFAULT ADAPTER: web storage, if present, otherwise memory. The environment is probed via typeof, not
// try/catch around an access: accessing a non-existent name in Node is a ReferenceError, and catching it
// as "no storage" would hide typos.
export function memoryStorage(map = new Map()) {
  return {
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => map.set(key, String(value)),
    remove: (key) => map.delete(key),
  };
}

const webStorage = (name) => {
  const store = typeof globalThis !== "undefined" ? globalThis[name] : undefined;
  if (!store || typeof store.getItem !== "function") return null;
  return {
    get: (key) => store.getItem(key),
    set: (key, value) => store.setItem(key, String(value)),
    remove: (key) => store.removeItem(key),
  };
};

let adapter = webStorage("localStorage") || memoryStorage();

/** Swap the storage. The shape is checked, not the origin: localStorage, memory and the SDK all qualify. */
export function setStorage(next) {
  const ok = next && typeof next.get === "function" && typeof next.set === "function" && typeof next.remove === "function";
  if (!ok) throw new Error("storage must support get/set/remove");
  adapter = next;
  return adapter;
}

/** What is used right now: this is visible from outside, and by this the checks tell memory from a browser. */
export const storage = () => adapter;

export function loadState() {
  try {
    const raw = adapter.get(APP.storageKey);
    if (!raw) return structuredClone(EMPTY);
    const parsed = JSON.parse(raw);
    return { ...structuredClone(EMPTY), ...parsed, settings: { ...EMPTY.settings, ...(parsed.settings || {}) } };
  } catch {
    return structuredClone(EMPTY);
  }
}

// BigInt IS NOT SERIALISED IN JSON - and the key halves are BigInt. JSON.stringify FAILS on them
// ("Do not know how to serialize a BigInt", bigintSafe), and the failure looks silent: the swap record is
// simply not saved, the recovery file is not issued, and the screen shows an address that is not on chain.
// We turn BigInt into a hex string: the same meaning, but serialisable, and the secret is not lost.
const bigintSafe = (key, value) => (typeof value === "bigint" ? "0x" + value.toString(16) : value);
export function saveState(state) {
  try {
    adapter.set(APP.storageKey, JSON.stringify(state, bigintSafe));
  } catch (e) {
    console.warn("state save failed", e);
  }
  return state;
}

export function update(mutator) {
  const s = loadState();
  const out = mutator(s) || s;
  saveState(out);
  return out;
}

export function reset() {
  adapter.remove(APP.storageKey);
}

export function exportState() {
  return JSON.stringify(loadState(), bigintSafe, 2);
}
