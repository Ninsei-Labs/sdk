// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/store.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Хранилище состояния демки.
//
// Зачем оно вообще: литпепер §5.1.7 - «вкладку можно закрыть, браузер восстановит состояние». Состояние сделки
// выводится из сохранённых таймстемпов и событий, поэтому вкладку действительно можно закрыть.
//
// ХРАНИЛИЩЕ ПРИХОДИТ СНАРУЖИ. Раньше здесь стоял `localStorage` прямо в коде, и это делало модуль непригодным
// ни в Node (проверки репозитория), ни в SDK (пакет обещает «без DOM»). Теперь хранилище - адаптер с тремя
// действиями (get/set/remove), а по умолчанию берётся localStorage, ЕСЛИ он есть в среде, иначе память
// процесса: молча не сохранять нельзя - сделка после перезагрузки потерялась бы.

import { APP, DEMO } from "./config.js";

const EMPTY = {
  version: 1,
  // payToken - выбранный актив оплаты. Хранится рядом с сетью: иначе форма при перезагрузке возвращала
  // нативный токен и выбор пользователя терялся.
  settings: { speed: DEMO.defaultSpeed, scenario: DEMO.defaultScenario, chainMode: DEMO.defaultChainMode, chain: DEMO.defaultChain, payToken: "" },
  wallet: { connected: false, address: null, balances: {} },
  swaps: {},
  activeSwapId: null,
};

// АДАПТЕР ПО УМОЛЧАНИЮ: web storage, если он есть, иначе память. Проверка среды - через typeof, а не
// try/catch вокруг обращения: обращение к несуществующему имени в Node - это ReferenceError, и ловить его
// как «нет хранилища» значит прятать опечатки.
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

/** Подменить хранилище. Проверяется форма, а не происхождение: годится и localStorage, и память, и SDK. */
export function setStorage(next) {
  const ok = next && typeof next.get === "function" && typeof next.set === "function" && typeof next.remove === "function";
  if (!ok) throw new Error("хранилище должно уметь get/set/remove");
  adapter = next;
  return adapter;
}

/** Что используется сейчас: это видно снаружи, и по этому признаку проверки отличают память от браузера. */
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

// BigInt В JSON НЕ СЕРИАЛИЗУЕТСЯ - а половины ключей это BigInt. JSON.stringify на них ПАДАЕТ
// ("Do not know how to serialize a BigInt", bigintSafe), и падение молчаливое на вид: запись сделки просто не сохраняется,
// файл восстановления не выпускается, а экран показывает адрес, которого на цепи нет.
// Приводим BigInt к шестнадцатеричной строке: это тот же смысл, но сериализуемый, и секрет не теряется.
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
