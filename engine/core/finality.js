// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/finality.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ЗРЕЛОСТЬ СОСТОЯНИЯ ПО СЕТЯМ: на каком уровне цепь признаёт запись окончательной.
//
// ЗАЧЕМ ОТДЕЛЬНАЯ ТАБЛИЦА. Сети отличаются и временем блока, и смыслом тегов. Замер 28.09.2026 по живым
// узлам (те самые адреса, что в настройках):
//   arbitrum          0.267 с/блок  safe отстаёт ≈12.6 мин  finalized ≈19.6 мин
//   arbitrum-sepolia  0.252 с/блок  safe ≈8.6 мин           finalized ≈14.9 мин
//   mainnet          12.060 с/блок  safe ≈11.8 мин          finalized ≈18.2 мин
//   base              2.000 с/блок  safe ≈0.4 мин           finalized ≈25.1 мин
//   bsc               0.450 с/блок  safe и finalized отстают на 0-1 блок
//   monad             0.302 с/блок  то же
//   hyperevm          0.984 с/блок  то же
// Отсюда два вывода, на которых стоит таблица:
//   1) одно значение на все сети неверно: на base safe стоит 25 секунд, на arbitrum - 13 минут;
//   2) на bsc, monad и hyperevm теги ФОРМАЛЬНЫ: они отвечают, но отставания нет, то есть "читать по
//      finalized" там выглядит защитой, а защиты не даёт. Пустышку опаснее отсутствия тега: отсутствие
//      видно, а пустышка молчит. Поэтому там - числовая глубина с НАЗВАННЫМ риском.
//
// ЭТА КОПИЯ - ДЛЯ СТРАНИЦЫ: она обслуживает все сети сразу, поэтому таблица нужна ей целиком.
// Такая же таблица живёт у служб (rfq/finality.mjs); совпадение копий проверяет страж tools/check-finality.mjs,
// потому что общего модуля у страницы и у служб быть не может.
//
// ОБЛАСТЬ ПРИМЕНЕНИЯ. Таблица отвечает на один вопрос: когда состояние EVM-стороны считается достаточно
// зрелым, чтобы принять по нему НЕОБРАТИМОЕ решение - отправить XMR. Показ состояния на странице живёт по
// latest и этой таблицей не ограничен.
export const FINALITY = {
  // ТЕГ ОСМЫСЛЕН: отставание измерено и названо.
  "arbitrum-sepolia": { mode: "tag", tag: "safe", costSec: 520, reason: "тег осмыслен: отставание ≈8.6 мин (замер)" },
  "arbitrum": { mode: "tag", tag: "safe", costSec: 760, reason: "тег осмыслен: отставание ≈12.6 мин (замер)" },
  "mainnet": { mode: "tag", tag: "safe", costSec: 710, reason: "тег осмыслен: отставание ≈11.8 мин (замер)" },
  "base": { mode: "tag", tag: "safe", costSec: 25, reason: "safe и осмыслен, и быстр: ≈25 с (замер)" },

  // ТЕГ ПУСТЫШКА: формально отвечает, отставания нет. Числовая глубина - с названной ценой риска.
  "bsc": { mode: "depth", depth: 15, costSec: 7, reason: "теги формальны (отставание 0-1 блок, замер): глубина ВЫБРАНА, а не измерена - риск назван" },
  "monad": { mode: "depth", depth: 12, costSec: 4, reason: "теги формальны (отставание 0-1 блок, замер): глубина выбрана" },
  "hyperevm": { mode: "depth", depth: 12, costSec: 12, reason: "теги формальны (отставание 0-1 блок, замер): глубина выбрана" },
};

// СЕТЬ НЕ ОПИСАНА - ГОВОРИМ ОБ ЭТОМ, А НЕ ПОДСТАВЛЯЕМ МОЛЧА. Глубина 12 - прежнее общее значение, и оно
// честнее пустого места: решение принимается, но цена риска названа как неизмеренная.
export const DEFAULT_FINALITY = {
  mode: "depth", depth: 12, costSec: 0,
  reason: "сеть не описана в таблице: берём общую глубину, риск не измерен",
};

export function finalityFor(network) {
  return FINALITY[network] || DEFAULT_FINALITY;
}

// Сколько эта сеть заставляет ждать перед необратимым решением - в секундах. Складывать с окнами сделки
// (readyBy, t1) обязан тот, кто эти окна назначает: окно, которое короче ожидания, убивает сделку.
export function finalityWaitSec(network) {
  return Number(finalityFor(network).costSec || 0);
}

// ЧТО СКАЗАТЬ ЧЕЛОВЕКУ. Строка для экрана: уровень и цена ожидания словами, без чисел-обманок.
export function finalityNote(network) {
  const f = finalityFor(network);
  if (f.mode === "tag") {
    const min = Math.max(1, Math.round(f.costSec / 60));
    return "ждём уровень " + f.tag + ": это ≈" + min + " мин";
  }
  return "ждём " + f.depth + " подтверждений: это ≈" + Math.max(1, Math.round(f.costSec)) + " с";
}

// ЗНАЧОК ПРОВАЙДЕРА ДЛЯ СПИСКА. Короткий: человек решает, кого выбрать, и цена ожидания - часть выбора.
// Свой замер важнее слов провайдера: если его уровень назван тегом, берём измеренную цену из таблицы.
export function finalityBadge(policy) {
  if (!policy) return "finality not stated";
  if (policy.mode === "tag") {
    const known = Object.values(FINALITY).find((f) => f.mode === "tag" && f.tag === policy.tag);
    const cost = Number(policy.costSec || (known && known.costSec) || 0);
    return cost >= 60 ? policy.tag + " · ≈" + Math.round(cost / 60) + " мин" : policy.tag + " · ≈" + Math.round(cost) + " с";
  }
  const d = Number(policy.depth || 0);
  const cost = Number(policy.costSec || d * (FINALITY[Object.keys(FINALITY)[0]] ? 0.3 : 0.3) || 0);
  return d + " блоков · ≈" + Math.max(1, Math.round(cost)) + " с";
}

// ОКНА ОРДЕРА ПО УРОВНЮ ПРОВАЙДЕРА. Окно короче ожидания убивает сделку: отметка готовности не успевает
// попасть в контракт, и сделка распадается. Поэтому окна считаются от цены ожидания, а не берутся числом.
// ЧИСЛА - РЕШЕНИЕ ВЛАДЕЛЬЦА (issue #88): при ПОКУПКЕ окно готовности 4 часа (человек должен успеть увидеть
// XMR и отметиться), а окно забора ПОСЛЕ readyBy - 1 час; формула ниже держит именно эту разницу: claim на час
// позже ready. При продаже сроки назначает нода (rfq/reverseOrder.mjs), там окно 1 час.
export function orderWindows(policy, base = { readyWindowSeconds: 14400, claimWindowSeconds: 3600 }) {
  const wait = Number((policy && policy.costSec) || 0);
  const ready = Math.max(base.readyWindowSeconds, wait + 900);         // запас на внос и на дорогу транзакции
  return { readyWindowSeconds: ready, claimWindowSeconds: Math.max(base.claimWindowSeconds, ready + 3600) };
}
