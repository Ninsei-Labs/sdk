// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/auth.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ВХОД ПО ПОДПИСИ КОШЕЛЬКА И СПИСОК СДЕЛОК НА СЕРВЕРЕ.
//
// Зачем. Пока записи о сделках живут только в localStorage, "мой список" привязан к браузеру: очистили
// данные сайта, открыли с другого устройства - список пуст, хотя деньги в эскроу на месте. Серверный
// список снимает это ограничение, а привязка к адресу кошелька не даёт видеть чужое.
//
// ПОДПИСЬ, А НЕ ПРОСТО ПОДКЛЮЧЕНИЕ. Подключение кошелька - только канал связи. Доказательство владения
// адресом даёт лишь подпись сообщения, и подписывать приходится КАЖДЫЙ РАЗ заново: пропуск живёт в
// sessionStorage, то есть умирает вместе с вкладкой. Так решено сознательно: безопасность важнее удобства.
//
// ЧТО УХОДИТ НА СЕРВЕР И ЧТО НЕТ. Уходят только публичные поля: адрес эскроу, суммы, сроки, hashlock,
// сеть, id сделки. СЕКРЕТ НЕ УХОДИТ НИКОГДА: он даёт право на деньги и остаётся в файле восстановления.
// Сервер не сможет распорядиться средствами, даже если захочет, - у него нет ни ключей, ни секрета.
//
// ОТКАЗ СЕРВЕРА НЕ ЛОМАЕТ СДЕЛКУ. Синхронизация - удобство, а не условие: если она не удалась, сделка
// продолжается на локальной записи, и об этом честно сказано в консоли. Хуже было бы наоборот.
import { signMessage, address, isConnected } from "./session.js";

const TOKEN_KEY = "arrakis.auth.token";
const ADDR_KEY = "arrakis.auth.address";

// Пропуск и адрес держим в sessionStorage: он переживает перезагрузку страницы, но исчезает вместе с
// вкладкой - ровно то поведение, которое выбрано ("пока открыт браузер валидно").
// СЕССИОННОЕ ХРАНИЛИЩЕ - СНАРУЖИ, как и хранилище состояния (www/js/core/store.js). В браузере это
// sessionStorage, в проверках и в SDK - память: модуль обязан грузиться без DOM.
const sessionAdapters = () => {
  const store = typeof globalThis !== "undefined" ? globalThis.sessionStorage : undefined;
  if (!store || typeof store.getItem !== "function") return null;
  return {
    get: (key) => store.getItem(key),
    set: (key, value) => store.setItem(key, String(value)),
    remove: (key) => store.removeItem(key),
  };
};
const memoryStore = () => {
  const map = new Map();
  return { get: (key) => (map.has(key) ? map.get(key) : null), set: (key, value) => map.set(key, String(value)), remove: (key) => map.delete(key) };
};
let sessionStore = sessionAdapters() || memoryStore();

/** Подменить сессионное хранилище: годится и sessionStorage, и память, и адаптер SDK. */
export function setSessionStore(next) {
  const ok = next && typeof next.get === "function" && typeof next.set === "function" && typeof next.remove === "function";
  if (!ok) throw new Error("сессионное хранилище должно уметь get/set/remove");
  sessionStore = next;
  return sessionStore;
}
export const sessionStoreInUse = () => sessionStore;

function readSession(key) { try { return sessionStore.get(key); } catch { return null; } }
function writeSession(key, value) { try { value == null ? sessionStore.remove(key) : sessionStore.set(key, value); } catch { /* тишина намеренно: недоступное хранилище не должно ломать вход */ } }

export function token() { return readSession(TOKEN_KEY); }
export function authedAddress() { return readSession(ADDR_KEY); }
export function forgetSession() { writeSession(TOKEN_KEY, null); writeSession(ADDR_KEY, null); }

async function api(path, init = {}) {
  const res = await fetch(path, init);
  let body = null;
  try { body = await res.json(); } catch { /* не JSON - ниже вернём как есть */ }
  return { status: res.status, body };
}

// Вход: получаем одноразовое число, подписываем сообщение КОТОРОЕ ДАЛ СЕРВЕР (не своё: иначе расхождение
// в одном символе давало бы "подпись не сходится" без объяснения) и обмениваем подпись на пропуск.
export async function signIn() {
  if (!isConnected()) throw new Error("сначала подключите кошелёк");
  const nonce = await api("/api/auth/nonce");
  if (nonce.status !== 200 || !nonce.body || !nonce.body.message) {
    throw new Error("сервер не выдал сообщение для подписи (ответ " + nonce.status + ")");
  }
  const signature = await signMessage(nonce.body.message);
  const verified = await api("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: nonce.body.nonce, address: address(), signature }),
  });
  if (verified.status !== 200 || !verified.body || !verified.body.token) {
    const why = verified.body && verified.body.error ? verified.body.error : "ответ " + verified.status;
    throw new Error("вход не принят: " + why);
  }
  writeSession(TOKEN_KEY, verified.body.token);
  writeSession(ADDR_KEY, verified.body.address);
  return verified.body.address;
}

// Запрос с пропуском. При 401 пропуск мог истечь или сервер перезапуститься - пробуем один раз войти
// заново, и только если и это не вышло, честно возвращаем отказ: молчаливое повторение подписи
// раздражало бы кошелёк запросами без причины.
async function authed(path, init = {}, retry = true) {
  const t = token();
  const headers = { ...(init.headers || {}) };
  if (t) headers.authorization = "Bearer " + t;
  const r = await api(path, { ...init, headers });
  if (r.status === 401 && retry && isConnected()) {
    forgetSession();
    try { await signIn(); } catch (e) { return r; }
    return authed(path, init, false);
  }
  return r;
}

// Отправить запись о сделке. Возвращает { ok, reason }: отказ не исключение, а факт, о котором вызывающий
// решает сам - сделка из-за него прерываться не должна.
export async function saveServerSwap(swap, network) {
  const escrow = swap && swap.escrow && swap.escrow.address;
  if (!escrow) return { ok: false, reason: "в записи нет адреса эскроу" };
  if (!isConnected()) return { ok: false, reason: "кошелёк не подключён" };
  try {
    if (!token() || authedAddress() !== String(address()).toLowerCase()) { forgetSession(); await signIn(); }
    const r = await authed("/api/evm-swaps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: swap.id, network: network || swap.network || swap.chain, escrow,
        // ССЫЛКА НА КОТИРОВКУ. По ней сервер и нода провайдера понимают, ЧЕЙ это ордер: без неё адрес эскроу
        // остаётся ноде неизвестным, и забрать ETH она не сможет. Отсутствие поля не ошибка: старые записи
        // и сделки без провайдера отправляются как есть.
        quoteId: swap.orderQuoteId || null,
        providerId: swap.providerId || null,
        hashlock: (swap.escrow && swap.escrow.hashlock) || swap.hashlock || null,
        amount: (swap.escrow && swap.escrow.amountWei) || swap.amountWei || null,
        t0: swap.escrow && swap.escrow.t0 != null ? swap.escrow.t0 : null,
        t1: swap.escrow && swap.escrow.t1 != null ? swap.escrow.t1 : null,
      }),
    });
    if (r.status === 201 || r.status === 200) {
      // СЕРВЕР ОТВЕЧАЕТ И ПРО ПРИВЯЗКУ КОТИРОВКИ. Без неё нода провайдера не заберёт ETH: её половина
      // осталась бы невостребованной. Отказ привязки сделку не прерывает, но и молчать о нём нельзя -
      // поэтому он уезжает вызывающему, а тот говорит в консоль.
      return { ok: true, orderBinding: (r.body && r.body.orderBinding) || null };
    }
    const why = r.body && r.body.error ? r.body.error : "ответ " + r.status;
    return { ok: false, reason: why };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// Список сделок с сервера. Пустой результат и отказ - разные вещи, и вызывающий видит разницу.
export async function loadServerSwaps() {
  if (!isConnected()) return { ok: false, reason: "кошелёк не подключён", swaps: [] };
  try {
    if (!token()) await signIn();
    const r = await authed("/api/evm-swaps");
    if (r.status !== 200 || !r.body) return { ok: false, reason: "ответ " + r.status, swaps: [] };
    return { ok: true, swaps: r.body.swaps || [] };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), swaps: [] };
  }
}
