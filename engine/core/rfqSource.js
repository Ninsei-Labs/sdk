// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/rfqSource.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ЖИВЫЕ ИНДИКАТИВНЫЕ КОТИРОВКИ ОТ НАШЕГО ПРОВАЙДЕРА - ЧЕРЕЗ ЯДРО SDK.
//
// ПОЧЕМУ ЧЕРЕЗ ЯДРО, А НЕ СВОИМ ЗАПРОСОМ. Раньше этот модуль САМ ходил в /api/rate и САМ разбирал книгу:
// правила чтения (ноль = "направления нет", просрочка по СОБСТВЕННОЙ метке котировки, строка, противоречащая
// себе) жили здесь, а рядом - в ядре (sdk/src/quotes.mjs). Две редакции одних правил расходятся молча
// (док 41/54), поэтому книга теперь берётся у ЯДРА: опрос - quotes.watch, снимок - quotes.snapshot, а
// ПЕРЕВОД ФОРМЫ делает склейник (www/js/sdk/bridge.js). Здесь не осталось НИ ОДНОГО правила отбора: что
// предложение, что отказ, что лучший - решает ядро. Молчание или отказ ядра даёт ПУСТУЮ книгу: прежняя
// (движковая) книга на экран не подставляется.
//
// ЧТО ЗНАЧИТ ЭТА ФОРМА СНИМКА (полный текст формы - .hermes/docs/41-quote-protocol-v4.md; действующие
// правила приёма - .hermes/docs/54-quote-protocol-v5.md), если коротко:
//   - СТУПЕНЕЙ НЕТ. min/max/step/ttlMs описывают ДИАПАЗОН целиком, а цена одна на весь диапазон: объём либо
//     попадает в диапазон провайдера, либо он за него не берётся;
//   - ВИД КОТИРОВКИ ОДИН. quoteKind (live/fixed) ушёл: твёрдая котировка ровно одна - ордерная;
//   - rate: 0 ЗНАЧИТ "НАПРАВЛЕНИЕ ОТКЛЮЧЕНО" и рядом стоит why. Это ЕДИНСТВЕННЫЙ сигнал отсутствия
//     предложения, поэтому ноль НИКОГДА не становится ценой и НИКОГДА не делится;
//   - СЕТЬ - ЧАСТЬ ЛИЧНОСТИ РЫНКА: assetNetwork/currencyNetwork сверяются со своей сетью (quoteNetworksFit);
//   - seq (номер запроса) и at (метка времени) едут вместе с котировкой: по ним читается свежесть;
//   - ОБЪЁМ МЕРЯЕТСЯ В ЕДИНИЦАХ ASSET ПАРЫ (первого элемента): у XMR/<токен> это XMR, у <токен>/XMR - токен.
import { API, DEFAULT_CHAIN } from "./config.js";

// КОТИРОВКА ПОД КОНКРЕТНЫЙ ОРДЕР (orderQuote). Запрос идёт ЧЕРЕЗ НАШ БЭКЕНД, а не напрямую в ноду
// провайдера: прямой запрос потребовал бы от ноды заголовков CORS, то есть открытой наружу ноды. Наш
// бэкенд маршрутизирует запрос и заодно проверяет подпись провайдера по списку разрешённых ключей
// (док 21, D5.1; док 22, версия 4). Тело котировки бэкенд не хранит и не логирует.
export async function requestOrderQuote({ providerId, order }) {
  if (!providerId) throw new Error("не выбран провайдер: запрашивать котировку под ордер не у кого");
  // ПУТЬ БЕЗ ВТОРОГО "api": apiBase() уже возвращает "/api", и лишний префикс давал /api/api/order-quote -
  // 404 на каждом запросе. Снаружи это выглядело как «котировка под ордер не запрашивается вовсе», хотя
  // запрос уходил и получал отказ: сбивало с толку и разбор, и поиск причины.
  const res = await fetch(apiBase() + "/order-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId, order }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body || body.ok !== true || !body.quote) {
    const why = (body && (body.error || body.why)) || ("HTTP " + res.status);
    throw new Error("провайдер не дал котировку под ордер: " + why);
  }
  // ПОДПИСЬ ПРОВЕРЯЕТ БЭКЕНД, НО РЕЗУЛЬТАТ ПРИХОДИТ ПОЛЕМ, А НЕ МОЛЧАНИЕМ. Непроверенная подпись -
  // это не «наверное всё хорошо»: котировка под ордер несёт обязательство по ключам, и принимать её без
  // подтверждения нельзя. Отсутствие флага тоже считаем непроверенной: обещать больше, чем сделано, нельзя.
  if (body.signatureVerified !== true) {
    throw new Error("подпись провайдера не подтверждена: " + String(body.signatureWhy || "бэкенд не проверил"));
  }
  return body.quote;
}

// ПРОВЕРКА КОТИРОВКИ ПОД ОРДЕР - то, ради чего она вообще запрашивается. Проверяющий код тот же, что и
// у своей стороны: доказательство в контексте ордера, и доказанная точка ed25519 обязана совпасть с той,
// которую мы отдадим в контракт. Второе без первого бессмысленно, первое без второго не защищает.
export function checkOrderQuoteShape(quote) {
  // ПОЛОВИНА ПРОСМОТРА В СПИСКЕ ОБЯЗАТЕЛЬНЫХ: без неё по котировке не собрать адрес Monero (док 21, D14.3).
  const missing = ["providerId", "amount", "claimer", "edPointClaimer", "commitHalfClaimer", "viewHalfClaimer", "proof", "context", "expiresAt"]
    .filter((f) => quote[f] === undefined || quote[f] === null || quote[f] === "");
  if (missing.length) throw new Error("в котировке под ордер не хватает полей: " + missing.join(", "));
  // ЕДИНСТВЕННЫЙ ТВЁРДЫЙ ВИД - ОРДЕРНЫЙ. В версии 4 второго вида (fixed) в продукте нет, поэтому проверка
  // не "какой это вид", а "это вообще котировка под ордер или нет": рассылочная котировка сюда не годится.
  if (quote.quoteKind !== "orderQuote") throw new Error("пришла не котировка под ордер, а " + String(quote.quoteKind));
  if (Number(quote.expiresAt) <= Date.now()) throw new Error("котировка под ордер просрочена");
}

let baseOverride = null;
const apiBase = () => baseOverride || API.base;

// ЧТО СПРАШИВАЕМ У ЯДРА. Сторона и РАЗМЕР - в единицах ASSET пары (см. формулировку выше); сеть и токен
// нужны ядру, чтобы выбрать СВОЙ экземпляр (у каждой сети свой опрос). Своих чисел здесь не появляется:
// размер приходит от экрана, который выровнял его по сетке провайдера.
let query = { size: 1, side: "buy", chain: DEFAULT_CHAIN, token: null };
export function setRfqQuery(next) {
  if (!next) return;
  if (next.side === "buy" || next.side === "sell") query.side = next.side;
  // ВИДА КОТИРОВКИ В ЗАПРОСЕ БОЛЬШЕ НЕТ: второго вида не существует, и поле mode ушло вместе с ним.
  if (next.size !== null && next.size !== undefined && Number(next.size) > 0) query.size = Number(next.size);
  else query.size = 1;                 // сумма не введена - спрашиваем единицу ASSET, а не "ничего"
  if (typeof next.chain === "string" && next.chain) query.chain = next.chain;
  if (typeof next.token === "string" && next.token) query.token = next.token;
}

// Текущий запрос: экрану нужно знать, под какой объём и сторону спрашивали - иначе он не отличит "провайдер
// молчит" от "провайдер не берётся за такой объём".
export function rfqQuery() {
  return { ...query };
}

// СНИМОК, КОТОРЫЙ ЧИТАЮТ ЭКРАНЫ. Форма та же, что была: { ok, error, data, at }. В data - references
// (справочный курс) и best, а предложения и отказы отдаёт rfqOffers(). Ядро не опрошено ни разу или
// отказало - данных нет, и это видно по ok. Прежние числа как "живые" не подставляются.
const snapshot = { ok: false, error: null, data: null, at: 0, fetching: false };
export function rfqSnapshot() {
  return snapshot;
}

// Пара, которую пользователь ВИДИТ: он покупает XMR, значит смотрит на пары XMR/<актив>; продаёт - на обратные.
export function pairFacingUser(side = query.side, asset = "ETH") {
  return side === "sell" ? asset.toUpperCase() + "/XMR" : "XMR/" + asset.toUpperCase();
}

// СТОРОНЫ ПАРЫ ЧИТАЮТСЯ ПО МЕСТУ (док 41, §1): первый элемент - ASSET (в нём же меряется объём), второй -
// CURRENCY (то, чем платят). Отдельные функции, потому что это правило конвенции, а не разбор строки:
// "XMR/ETH" значит "сколько ETH за 1 XMR" и ничего другого.
export function pairAsset(pair) {
  return String(pair || "").split("/")[0].toUpperCase();
}
export function pairCurrency(pair) {
  return String(pair || "").split("/")[1] ? String(pair).split("/")[1].toUpperCase() : "";
}

// ПРЕДЛОЖЕНИЯ И ОТКАЗЫ - ИЗ СНИМКА ЯДРА, БЕЗ ВТОРОГО ОТБОРА. Ядро уже разделило строки книги на
// предложения и отказы (sdk/src/quotes.mjs, readBook: ноль/противоречие/просрочка) и назвало лучшего.
// Здесь они ТОЛЬКО переносятся: своего отсева, своей сортировки и своих порогов не появляется. Пустой
// снимок - пустая книга; прежняя книга на экране не остаётся.
export function rfqOffers() {
  const data = snapshot.ok && snapshot.data ? snapshot.data : null;
  if (!data) return { offers: [], refused: [], seq: null, at: null };
  return {
    offers: data.offers || [],
    refused: data.refused || [],
    seq: data.seq === undefined ? null : data.seq,
    at: data.at === undefined ? null : data.at,
  };
}

// СВЕРКА СЕТИ КОТИРОВКИ СО СВОЕЙ (док 41, §3). Сеть - часть личности рынка, а не украшение: arbitrum и
// arbitrum-sepolia - это ОДНО СЛОВО ДЛЯ РАЗНЫХ ДЕНЕГ, и кошелёк между ними монеты не переводит. Сторона,
// где стоит XMR, обязана говорить на языке Monero, вторая - на языке реестра сетей EVM (его id).
// Возвращаем вердикт, а не throw: отказ одной котировки не закрывает рынок (см. market.js).
export function quoteNetworksFit(quote, { monero, evm }) {
  const xmrOnAsset = quote.asset === "XMR";
  const xmrOnCurrency = quote.currency === "XMR";
  if (!xmrOnAsset && !xmrOnCurrency) return { ok: false, stated: quote.networkStated, why: "pair " + quote.pair + " has no XMR on either side" };
  const moneroNet = xmrOnAsset ? quote.assetNetwork : quote.currencyNetwork;
  const evmNet = xmrOnAsset ? quote.currencyNetwork : quote.assetNetwork;
  const moneroSide = xmrOnAsset ? "assetNetwork" : "currencyNetwork";
  const evmSide = xmrOnAsset ? "currencyNetwork" : "assetNetwork";
  if (moneroNet && moneroNet !== monero) {
    return { ok: false, stated: true, why: quote.pair + ": " + moneroSide + " is " + moneroNet + ", but this page pays XMR on " + monero };
  }
  if (evmNet && evmNet !== evm) {
    return { ok: false, stated: true, why: quote.pair + ": " + evmSide + " is " + evmNet + ", but this page settles on " + evm };
  }
  // НЕ НАЗВАНА - НЕ ЗНАЧИТ "НАША". Сверять нечего, и это надо сказать вслух (в лог), но отказом за это не
  // закрываем рынок: правило §3 ловит СЕТЬ, НАЗВАННУЮ НЕВЕРНО, а не поле, которого котировка ещё не несёт.
  return { ok: true, stated: quote.networkStated, moneroNet: moneroNet || null, evmNet: evmNet || null, why: null };
}

// ОПРОС ИДЁТ ЧЕРЕЗ ЯДРО. Склейник (www/js/sdk/bridge.js) отдаёт ядру то, что нужно ему снаружи (сеть, размер,
// направление), и возвращает ПЕРЕВЕДЁННЫЙ снимок. Ядро грузится ДИНАМИЧЕСКИ: этот модуль читают и без
// браузера (проверки рынка), и тогда книга просто не запрашивается - динамический импорт в Node не тянет
// страничные модули. Отказ загрузки ядра - ЭТО ОТКАЗ, а не повод взять книгу где-то ещё.
export async function refreshRfq() {
  if (snapshot.fetching) return snapshot;
  snapshot.fetching = true;
  try {
    const bridge = await import("../sdk/bridge.js");
    await bridge.sdkBook({ chain: query.chain, direction: query.side, token: query.token, size: query.size });
    const next = bridge.sdkBookSnapshot();
    snapshot.ok = next.ok;
    snapshot.error = next.error;
    snapshot.data = next.data;
    snapshot.at = next.at || Date.now();
  } catch (error) {
    // ОТКАЗ НЕ ПОДМЕНЯЕМ ПРОШЛЫМИ ЧИСЛАМИ: показать устаревшую цену как живую - хуже, чем сказать, что
    // связи нет. Данных не остаётся вовсе: книги, которую можно было бы показать, больше нет.
    snapshot.ok = false;
    snapshot.error = String((error && error.message) || error);
    snapshot.data = null;
    snapshot.at = Date.now();
  } finally {
    snapshot.fetching = false;
  }
  return snapshot;
}

let timer = null;

// ОПРАШИВАЕМ ВСЕГДА, как и раньше. Опрос здесь не для того, чтобы "поймать новую цену": он подтверждает,
// что провайдер на месте. Сам опрос держит ЯДРО (на время подписки), а этот такт заставляет книгу
// обновляться вместе с экраном. Молчание ноды видно как отсутствие свежей метки, а не как "цена та же".
export function startRfqPolling(chain = null, ms = API.pollMs) {
  if (typeof chain === "string" && chain) query.chain = chain;
  if (timer) return;
  refreshRfq();
  timer = setInterval(() => refreshRfq(), ms);
}
