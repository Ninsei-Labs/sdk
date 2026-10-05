// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/chainSource.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Источник данных о Monero-ноге свопа: симулятор демки или настоящий бэкенд (app/).
//
// Почему отдельный модуль, а не строчки в core/swap.js: у свопа две ноги, и готовность у них разная.
//
//   EVM-нога (escrow, claim, refund) - СИМУЛЯЦИЯ: контракта ещё нет (этап 5). Каждый её ответ
//   помечен mock: true, и это не косметика, а то, что обязан показать UI.
//
//   Monero-нога (пришёл ли XMR на адрес свопа и сколько у него подтверждений) - может быть
//   НАСТОЯЩЕЙ: бэкенд app/ заводит watch-only кошелёк по адресу и view key и следит за
//   поступлениями (см. app/README.md). Ключ траты при этом остаётся в браузере.
//
// Поэтому источник выбирается именно для Monero-ноги: 'mock' (как в демо: sim-время, без сети)
// либо 'app' (HTTP к бэкенду). За источником идёт и сеть: у бэкенда на сервере поднят
// stagenet-кошелёк, а мок-режим демки исторически mainnet (см. XMR_NETWORKS в config.js).
//
// ГРАНИЦА, ЗАКРЕПЛЁННАЯ КОДОМ: в бэкенд уходит только адрес и view key, и тело запроса
// собирается заново по белому списку полей - так в него физически не может уехать ни ключ траты,
// ни seed, даже если кто-то добавит их в share. Проверяется tools/check-chain-source.mjs.

import { API, XMR_NETWORKS, MONERO } from "./config.js";
import { confirmations as mockConfirmations } from "../mock/chain.js";

// Статусы бэкенда (app/store.mjs) - те же строки, что отдаёт API.
export const XMR_STATUS = {
  AWAITING: "awaiting_funding", // на адрес ещё ничего не пришло (или пришло меньше ожидаемого)
  FUNDED: "funded", // пришло, подтверждений меньше цели
  // ДЕНЬГИ НА АДРЕСЕ ЕСТЬ, НО ЗАПЕРТЫ unlock_time (issue #84): это НЕ приход, и «готово» в этом состоянии не
  // включается. Отдельный статус, а не молчание и не ноль: бэкенд (app/watcher.mjs) называет его сам.
  LOCKED: "xmr_locked",
  READY: "ready", // подтверждений достаточно: пользователь может подтверждать
  SWEPT: "swept", // XMR выведены пользователем
  CLOSED: "closed", // своп закрыт (отмена или возврат)
};

// Поля, которые вообще разрешено отправлять бэкенду при заведении свопа.
export const ALLOWED_SESSION_FIELDS = ["swapId", "network", "address", "viewKey", "expectedAmountXmr", "restoreHeight", "chain"];

export function isLiveSource(source = API.xmrSource) {
  return source === "app";
}

// Сеть Monero, которую обязан использовать адрес свопа при данном источнике.
export function xmrNetworkForSource(source = API.xmrSource) {
  return XMR_NETWORKS[isLiveSource(source) ? "app" : "mock"];
}

export function xmrSourceLabel(source = API.xmrSource) {
  return isLiveSource(source) ? "backend app/ (stagenet)" : "demo simulator";
}

// ---------------------------------------------------------------------------
// HTTP к бэкенду
//
// Базу можно переопределить. В браузере это не нужно: "/api" - относительный путь того же
// origin, и CSP ("connect-src self") его покрывает. Переопределение существует для Node-тестов
// и для случая, когда фронт отдают не с боевого хоста (в обоих случаях относительный URL не парсится).
let apiBaseOverride = null;
export function setApiBase(base) {
  apiBaseOverride = base ? String(base).replace(/[/]$/, "") : null;
}

// Настройки опроса, которые можно переопределить: нужно тестам (там интервал в миллисекундах,
// а не в секундах) и настройке экрана. Значения по умолчанию - из config.js.
let pollMsOverride = null;
export function setApiOptions({ pollMs } = {}) {
  if (Number.isFinite(Number(pollMs)) && Number(pollMs) > 0) pollMsOverride = Number(pollMs);
  return { pollMs: pollMsOverride || "default" };
}
export function pollInterval() {
  return pollMsOverride || API.pollMs;
}
// ---------------------------------------------------------------------------

// Один запрос к API. НИКОГДА не бросает: упавшая сеть - это состояние экрана, а не падение демки,
// и пользователь должен увидеть причину, а не пустую страницу.
async function api(path, { method = "GET", body, base, timeoutMs = API.timeoutMs, fetchImpl } = {}) {
  const target = base || apiBaseOverride || API.base;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, status: 0, error: "нет fetch: бэкенд недоступен" };
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(target + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined,
    });
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* не JSON - причину увидим из текста */
    }
    if (!res.ok) {
      const base_ = (json && (json.error || json.detail)) || text.slice(0, 200) || `HTTP ${res.status}`;
      const extra = json && Array.isArray(json.problems) ? ": " + json.problems.join("; ") : "";
      return { ok: false, status: res.status, error: `${base_}${extra}` };
    }
    return { ok: true, status: res.status, json };
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: aborted ? `бэкенд не ответил за ${timeoutMs} мс` : "бэкенд недоступен: " + ((e && e.message) || e),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Ответ бэкенда -> слепок для экрана и движка состояний.
export function normalizeSession(json) {
  const j = json || {};
  return {
    id: j.id || null,
    status: j.status || XMR_STATUS.AWAITING,
    network: j.network || null,
    address: j.address || null,
    expectedAmountXmr: j.expectedAmountXmr ?? null,
    receivedXmr: j.receivedXmr ?? "0",
    receivedAtomic: j.receivedAtomic ?? "0",
    // ЗАПЕРТОЕ unlock_time: сумма и граница ({code,untilHeight,untilTime}) - отдельно от прихода.
    lockedXmr: j.lockedXmr ?? "0",
    lockedAtomic: j.lockedAtomic ?? "0",
    lockedUntil: j.lockedUntil || null,
    confirmations: Number(j.confirmations) || 0,
    fundingTxids: Array.isArray(j.fundingTxids) ? j.fundingTxids : [],
    nodeHeightAtSeen: j.nodeHeightAtSeen ?? null,
    sweepTxid: j.sweepTxid || null,
    updatedAt: j.updatedAt || null,
    at: Date.now(),
  };
}

// Заведение свопа на бэкенде. share - то, что возвращает watchOnlyShareFromWallet()
// (recovery/restore.js): адрес + приватный view key. Ключ траты остаётся в браузере.
// Одна и та же ли цель у свопа: сумма, валюта и сеть. Нужно, чтобы клик по Swap не заводил новый своп
// на тот же адрес, если человек ничего не менял. Чистая функция - проверяется тестом без сети.
export function sameSwapTarget(a, b) {
  if (!a || !b) return false;
  return String(a.payAmount) === String(b.payAmount) &&
    a.payToken === b.payToken &&
    a.chain === b.chain;
}

export async function openSession({ swapId, share, expectedAmountXmr, chain, restoreHeight }, opts = {}) {
  const src = share || {};
  const address = src.address || null;
  const viewKey = src.viewKey || src.privateViewKey || null;
  if (!address || !viewKey) {
    return { ok: false, status: 0, error: "в watch-only share нет address/viewKey - нечего отправлять бэкенду" };
  }
  // СУММА ОЖИДАНИЯ ОБЯЗАТЕЛЬНА и должна быть числом. Раньше здесь стояло «не число - значит поля не будет»,
  // и своп заводился БЕЗ суммы: сторож принимал за достаточное любое поступление, то есть недоплата
  // выглядела как исполненная сделка. Живой своп так и остался с пустым полем. Теперь это отказ с
  // объяснением: не завести наблюдение лучше, чем завести его без возможности проверить деньги.
  const amountXmr = Number(expectedAmountXmr);
  if (!Number.isFinite(amountXmr) || amountXmr <= 0) {
    const where = (new Error("caller").stack || "").split("\n").slice(1, 4).map((x) => x.trim().split("/").pop()).join(" <- ");
    console.warn("[chainSource] нет суммы ожидания, вызов из: " + where);
    return { ok: false, status: 0, error: "сумма ожидания XMR неизвестна (" + String(expectedAmountXmr) + "): без неё наблюдение не заводится" };
  }
  const wanted = {
    swapId: swapId || src.swapId || null,
    network: src.network || xmrNetworkForSource(),
    address,
    viewKey,
    expectedAmountXmr: amountXmr,
    restoreHeight: Number.isFinite(Number(restoreHeight)) && Number(restoreHeight) > 0 ? Number(restoreHeight) : Number(src.restoreHeight) || undefined,
    chain: chain || undefined,
  };
  // Тело собираем заново по белому списку: что не в списке - в запрос не попадёт никогда.
  const body = {};
  for (const field of ALLOWED_SESSION_FIELDS) {
    if (wanted[field] !== undefined && wanted[field] !== null) body[field] = wanted[field];
  }
  const res = await api("/swaps", { method: "POST", body, ...opts });
  if (!res.ok) return res;
  return { ok: true, status: res.status, created: res.json?.created !== false, session: normalizeSession(res.json) };
}

export async function fetchSession(swapId, opts = {}) {
  const res = await api(`/swaps/${encodeURIComponent(swapId)}`, opts);
  if (!res.ok) return res;
  return { ok: true, status: res.status, session: normalizeSession(res.json) };
}

// Сообщить бэкенду, что XMR выведены: хеш настоящего перевода (со страницы sweep).
// Нужно потому, что watch-only кошелёк исходящие переводы видеть не может в принципе.
export async function reportSwept(swapId, txid, opts = {}) {
  const res = await api(`/swaps/${encodeURIComponent(swapId)}/swept`, { method: "POST", body: { txid }, ...opts });
  return res.ok ? { ok: true, status: res.status, session: normalizeSession(res.json) } : res;
}

// Закрыть своп (отмена или возврат на стороне бэкенда): наблюдение прекращается.
export async function closeSession(swapId, reason = "cancelled", opts = {}) {
  const res = await api(`/swaps/${encodeURIComponent(swapId)}/closed`, { method: "POST", body: { reason }, ...opts });
  return res.ok ? { ok: true, status: res.status, session: normalizeSession(res.json) } : res;
}

// Состояние бэкенда: доступен ли он и видит ли кошелёк. Нужно экрану, чтобы показать «бэкенд
// недоступен» до того, как пользователь отправит деньги, а не после.
export async function health(opts = {}) {
  const res = await api("/health", opts);
  return res.ok ? { ok: true, ...res.json } : res;
}

// ---------------------------------------------------------------------------
// Слепок Monero-ноги для движка состояний
// ---------------------------------------------------------------------------

// Мок-режим: подтверждения по sim-времени, ровно как в демке было до сих пор.
export function mockView(swap, simElapsedMs) {
  const confTarget = (swap.timeline && swap.timeline.confTarget) || MONERO.confirmTarget;
  const lockAt = swap.timeline ? swap.timeline.lockAtSim : 0;
  const locked = lockAt !== null && simElapsedMs >= lockAt;
  const confirmations = mockConfirmations(swap, simElapsedMs);
  const status = !locked ? XMR_STATUS.AWAITING : confirmations >= confTarget ? XMR_STATUS.READY : XMR_STATUS.FUNDED;
  const received = locked ? swap.xmrAmount : 0;
  return {
    live: false,
    status,
    received,
    // В демо-симуляторе запирания unlock_time нет: приход и разблокированное - одно и то же.
    unlocked: received,
    locked: 0,
    lockedUntil: null,
    arrived: received,
    confirmations,
    confTarget,
    txids: swap.xmr && swap.xmr.txid ? [swap.xmr.txid] : [],
    address: (swap.xmr && swap.xmr.address) || null,
    sweepTxid: (swap.xmr && swap.xmr.sweepTxid) || null,
    error: null,
  };
}

// Живой режим: берём последний опрос бэкенда. Его кладёт тикер (swap.js), а derive() остаётся
// чистой функцией - она читает состояние, а не ходит в сеть.
export function liveView(swap) {
  const confTarget = (swap.timeline && swap.timeline.confTarget) || MONERO.confirmTarget;
  const s = swap.xmrSession;
  if (!s) {
    return {
      live: true,
      status: swap.xmrSessionError ? "error" : "opening",
      received: 0,
      unlocked: 0,
      locked: 0,
      lockedUntil: null,
      arrived: 0,
      confirmations: 0,
      confTarget,
      txids: [],
      address: (swap.swapWallet && swap.swapWallet.address) || null,
      sweepTxid: null,
      error: swap.xmrSessionError || null,
    };
  }
  return {
    live: true,
    status: swap.xmrSessionError ? "error" : s.status,
    // ПРИХОД И РАЗБЛОКИРОВАННОЕ - РАЗНЫЕ ФАКТЫ. received - то, что можно потратить (receivedXmr),
    // locked - запертое unlock_time, arrived - всё, что видно на адресе. Состояние называет бэкенд.
    received: Number(s.receivedXmr) || 0,
    unlocked: Number(s.receivedXmr) || 0,
    locked: Number(s.lockedXmr) || 0,
    lockedUntil: s.lockedUntil || null,
    arrived: (Number(s.receivedXmr) || 0) + (Number(s.lockedXmr) || 0),
    confirmations: s.confirmations,
    confTarget,
    txids: s.fundingTxids,
    address: s.address || (swap.swapWallet && swap.swapWallet.address) || null,
    sweepTxid: s.sweepTxid,
    error: swap.xmrSessionError || null,
  };
}

export function xmrView(swap, simElapsedMs) {
  return isLiveSource(swap && swap.xmrSource) ? liveView(swap) : mockView(swap, simElapsedMs);
}

// Ссылка на перевод в обозревателе. В live-режиме это stagenet: подписывать её как настоящие
// деньги нельзя, поэтому сеть берём из самой сессии, а не из догадки.
export function explorerXmrTx(txid, network = "stagenet") {
  if (!txid) return null;
  const prefix = network === "mainnet" ? "" : network + ".";
  return `https://${prefix}xmrchain.net/tx/${txid}`;
}
