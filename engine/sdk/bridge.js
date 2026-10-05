// GENERATED FILE - a byte-for-byte copy of the engine module www/js/sdk/bridge.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// СКЛЕЙНИК СТРАНИЦЫ С ЯДРОМ: ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ЭКРАНЫ ЗНАЮТ ПРО SDK (sdk/).
//
// ЗАЧЕМ ОН. Логика обмена живёт в ядре (sdk/, пакет @ninsei-labs/sdk), а страница должна делать только
// разметку, состояние экрана и тексты. Пока этого шва не было, каждый экран звал движок сам, и логика
// расползалась по двум местам (.hermes/docs/59-ui-on-sdk.md). Теперь экран зовёт СКЛЕЙНИК, а про ядро знает
// только он.
//
// ЧТО СКЛЕЙНИК ПОДСОВЫВАЕТ ЯДРУ - ровно те швы, которые ядро просит снаружи и само достать не может:
//   storage    - хранилище страницы: сделки и сессия читаются оттуда же, где их кладёт страница (core/store.js);
//   serverAuth - пропуск на наш сервис: подпись сообщения о входе умеет только кошелёк (evm/auth.js signIn),
//                ядро получает уже ГОТОВЫЙ пропуск;
//   evmCall    - чтение цепи КОШЕЛЬКОМ СТРАНИЦЫ: своего провайдера у ядра нет и быть не должно;
//   wallet     - адаптер кошелька страницы (sdk/src/adapters/evm-wallet.mjs): подпись возможна только в нём.
//
// ЧЕГО СКЛЕЙНИК НЕ ДЕЛАЕТ. Он не считает ни порогов, ни порядка шагов, ни адреса эскроу: имена методов и
// пути - только те, что ЕСТЬ в ядре, а решения остаются в ядре.
//
// ПРО ДОСТУПНОСТЬ ЯДРА СТРАНИЦЕ - ТЕПЕРЬ ОНО СОБРАНО, А НЕ ЖДЁТ СБОРКИ.
//   * sdk/src/primitives.mjs импортирует @noble/curves и @noble/hashes ГОЛЫМИ ИМЕНАМИ пакетов, поэтому
//     странице отдаётся не исходник sdk/, а СОБРАННЫЙ БАНДЛ (tools/build-sdk.mjs -> www/assets/vendors/sdk/
//     sdk-browser.js, тот же путь, что у крипто-бандла атомарного свопа). Бандл отдаёт ФАСАД ЦЕЛИКОМ:
//     createNinsei (config/wallet/quotes/preflight/swaps/actions/order/sweep/recovery/sim) плюс адаптеры
//     браузера (evmWallet, localStorageAdapter/memoryAdapter). Поэтому запуск сделки (swaps.start) и
//     котировки фасада странице ДОСТУПНЫ - отказ вида "фасад странице не отдаётся" больше не ожидается.
//   * Ссылка на бандл несёт ?v=<хеш> (tools/assetVersions.mjs, tools/stamp-assets.mjs): кеш пограничного
//     слоя сбрасывается сам после пересборки.
//
// ЗАПАСНОГО ПУТИ У ДЕЙСТВИЙ ОРДЕРА БОЛЬШЕ НЕТ, И ЭТО НЕ ПОТЕРЯ, А СЛЕДСТВИЕ ПЕРЕЕЗДА (#32, волна 3). Раньше
// www/js/core/swap-flow.js лежал на странице, и при недоступном бандле действия ордера шли им же - «одни и те
// же функции», как здесь и было написано. Теперь движок сделки - СОБСТВЕННЫЙ модуль пакета
// (sdk/src/swap-flow.mjs): второй копии на странице нет, значит и запасного пути быть не может. Бандл не
// загрузился (нет файла, старый кеш, сеть) - это НАЗВАННЫЙ отказ с причиной в консоли (sdkBundle ниже), а не
// молчание и не подмена.

import { chainById, DEFAULT_CHAIN, MONERO, allowedProvidersFor, knownFactoryCodesFor } from "../core/config.js";
import { storage as pageStorage } from "../core/store.js";
import { token as authToken, signIn } from "../evm/auth.js";
import * as evm from "../evm/index.js";
// УСЛОВИЯ ОРДЕРА ДЛЯ ЯДРА СОБИРАЮТСЯ ИЗ ДАННЫХ, А НЕ ИЗ ПРАВИЛ: окна берутся у политики финальности
// (core/finality.js), соль - генератором движка (evm/funding.js). Своих сроков и своих чисел здесь нет.
import { orderWindows } from "../core/finality.js";
import { newSecret } from "../evm/funding.js";
// ВЫЗОВЫ ОРДЕРА - ДЕЙСТВИЕ  И ЧТЕНИЕ - ОТ ЯДРА. Движок сделки переехал в пакет (#32, волна 3), и наружу
// склейник отдаёт ИМЕННО те же имена (markReadyOrder/claimOrder/refundOrder/orderStatus/orderDeadlines),
// поэтому экран меняет только источник, а не строку вызова - и стража, которая держит место вызова
// (tools/check-signing-guards.mjs, tools/check-arrival-depositor.mjs), видит прежний вызов.
// СПИСОК СДЕЛОК И ЕГО ОБСЛУЖИВАНИЕ (экран #/swaps). Состояния отдаёт ЯДРО: swaps.list - показ, swaps.sync -
// слияние с серверным списком, swaps.forget - уборка записи. Ядру для этого нужны только швы страницы
// (пропуск и хранилище), и оба уже подсунуты выше - своих правил слияния склейник не заводит.
//
// СЛЕЖЕНИЕ - МЕХАНИЗМ СТРАНИЦЫ, А НЕ ЯДРА: такт опроса живёт в app.js, поэтому фокус остаётся в
// core/swap.js, а экран только объявляет его склейнику.
import { setLiveFocus, dealSwapIds, serverRestoreHeightFor, STEP_LABELS,
  confirmReady as engineConfirmReady, refundEth as engineRefundEth, sweepNow as engineSweepNow,
  getSwap as engineGetSwap, saveSwap as engineSaveSwap } from "../core/swap.js";
// СТАВКА КОМИССИИ И СОСТОЯНИЕ ОРДЕРА - ЧТЕНИЕ ЦЕПИ КОШЕЛЬКОМ СТРАНИЦЫ: их берут справочник ("как это
// работает") и разбор recovery-файла. Страница получает их ОТСЮДА, а не из evm/* напрямую.
import { cachedFeeRate } from "../evm/fees.js";
// АДРЕС И ВЫСОТА MONERO - ОСОЗНАННЫЕ ЧТЕНИЯ СТРАНИЦЫ (экран хода): проверка формы адреса получателя и высота
// узла для высоты скана в файле восстановления. Логика адреса живёт в ядре (swaps.addressNetwork), здесь -
// запасной путь тем же модулем; высота узла - чтение ноды страницы, своего узла у ядра нет.
import { networkFromShape } from "../monero/address.js";
import { height as nodeHeightValue } from "../monero/node.js";

// АДРЕС ЯДРА СТРОКОЙ - СОБРАННЫЙ БАНДЛ ПОД www/ (tools/build-sdk.mjs): страница получает ядро ОДНИМ
// модулем, а не пачкой исходников sdk/. ?v=<хеш> проставляет tools/stamp-assets.mjs.
const SDK_BUNDLE = "/assets/vendors/sdk/sdk-browser.js?v=11f2239a";

// ОДНА ЗАГРУЗКА НА СТРАНИЦУ. Отказ - это состояние, а не поломка: он назван в консоли, и вызывающий решает.
let loading = null;
export async function sdkBundle() {
  if (!loading) {
    loading = (async () => {
      try { return await import(SDK_BUNDLE); }
      catch (error) {
        console.warn("[bridge] собранное ядро SDK странице не отдалось (" + ((error && error.message) || error) +
          "): действия идут прежним вызовом движка; см. www/js/sdk/bridge.js");
        return null;
      }
    })();
  }
  return loading;
}

// ПОВЕРХНОСТИ ИЗ БАНДЛА - ИМЕННО ТЕМИ ИМЕНАМИ, ЧТО ИХ ЗОВУТ НИЖЕ. Так экрану не нужно знать, что ядро
// пришло одним файлом, а не тремя: форма вызова не меняется.
export async function sdkCoreModules() {
  const mod = await sdkBundle();
  if (!mod) return null;
  return {
    actions: { createActions: mod.createActions },
    wallet: { evmWallet: mod.evmWallet },
    recovery: { createRecovery: mod.createRecovery },
  };
}

// ФАСАД ЯДРА (config/quotes/swaps/actions/recovery целиком) - ТОТ ЖЕ бандл, только нужен его createNinsei.
async function coreFacade() {
  const mod = await sdkBundle();
  return mod ? { factory: mod.createNinsei } : null;
}

function modeOf(chain) {
  return chain && chain.escrow && chain.escrow.mode === "live" ? "live" : "sim";
}

// НАСТРОЙКИ ЯДРА ИЗ СТРАНИЦЫ. Ни одно значение здесь не решает ничего ЗА ядро: это адрес сервиса, сеть,
// хранилище и швы, о которых ядро спрашивает снаружи.
function optionsFor(chain) {
  return {
    settlement: { chain: chain.id },
    xmrNetwork: MONERO.networkType,
    apiBase: "/api",
    assetsBase: "/",
    mode: modeOf(chain),
    // ХРАНИЛИЩЕ СТРАНИЦЫ СТАНОВИТСЯ ХРАНИЛИЩЕМ ЯДРА: записи сделок и сессия лежат в одном месте.
    storage: pageStorage(),
    // ПРОПУСК НА НАШ СЕРВИС: ядро только предъявляет его, добывает - кошелёк страницы.
    serverAuth: async () => {
      if (authToken()) return authToken();
      try { await signIn(); } catch { return null; }
      return authToken();
    },
    // ЧТЕНИЕ ЦЕПИ - КОШЕЛЬКОМ СТРАНИЦЫ (ядру нужен этот шов: своего провайдера у него нет).
    evmCall: (request) => evm.readContract(request),
    // КОД КОНТРАКТА - КОШЕЛЬКОМ СТРАНИЦЫ: нужен проверке кода фабрики (#103), extcodehash считается по нему.
    evmCode: (address) => evm.readCode({ address }),
    // НАШ СПИСОК ДОПУЩЕННЫХ - ПОЛИТИКА ИНТЕРФЕЙСА (#76/#77). Ядро само подтверждает у ЦЕПИ, чей ключ
    // подписал котировку (реестр мейкеров); этот список решает, с кем торгует СТРАНИЦА. Провайдер вне
    // списка не проходит кодом `quote-provider-not-allowed` - и отказ виден ДО подписи, потому что без
    // твёрдой котировки нет ни ставки комиссии, ни замка. Список берётся из реестра сетей
    // (core/config.js, allowedProvidersFor), а не выдумывается здесь; сеть без списка = политики нет.
    allowedProviders: allowedProvidersFor(chain),
    // СПИСОК ИЗВЕСТНЫХ СБОРОК ФАБРИКИ - ПОЛИТИКА ИНТЕРФЕЙСА (#103), рядом с allowedProviders. Фабрику ядро
    // берёт из записи реестра провайдера, а её КОД сверяет с этим списком (extcodehash). Пусто = политики
    // нет; тогда фабрика всё равно обязана совпасть с подписанной котировкой.
    knownFactoryCodes: knownFactoryCodesFor(chain),
  };
}

// ЭКЗЕМПЛЯР ЯДРА НА СЕТЬ: фасад держит хранилище и подписки, второй экземпляр на ту же сеть завёл бы второй
// опрос. Недоступен - null, и вызывающий сам называет отказ.
const instances = new Map();
async function instanceFor(chainSlug) {
  const facade = await coreFacade();
  if (!facade) return null;
  const chain = chainById(chainSlug || DEFAULT_CHAIN);
  if (!instances.has(chain.id)) instances.set(chain.id, facade.factory(optionsFor(chain)));
  return { chain, sdk: instances.get(chain.id) };
}

// КОШЕЛОК СТРАНИЦЫ ДЛЯ ЯДРА: адаптер поверх ЕГО провайдера. Берётся В МОМЕНТ действия: провайдер
// появляется вместе с подключением, а не при загрузке страницы.
function walletFor(mods) {
  const provider = typeof evm.currentProvider === "function" ? evm.currentProvider() : null;
  if (!provider) return null;
  return mods.wallet.evmWallet(provider);
}

// --- ДЕЙСТВИЯ ОРДЕРА -----------------------------------------------------------------------------
// ИМЕНА И ФОРМА ЗАПРОСА - ТЕ ЖЕ, ЧТО У ПРЕЖНИХ ВЫЗОВОВ ЭКРАНА. Экран передаёт ожидания ордера (expect) и
// ничего не пересчитывает: ядро сверяет слоты с цепью ПЕРЕД подписью и без ожиданий не подписывает.
// Кошелёк - тот же, что подписывает страница; сеть ядру здесь не нужна (чтение и отправка идут тем же
// провайдером, что и раньше).
export async function markReadyOrder({ escrow, expect } = {}) {
  const mods = await sdkCoreModules();
  const wallet = mods ? walletFor(mods) : null;
  // ЯДРО И КОШЕЛЁК - ОБЯЗАТЕЛЬНЫ: запасного пути (движок на странице) больше нет. Отказ назван, а не молчание.
  if (!mods || !wallet) throw new Error("[bridge] отметку готовности подписать нечем: " + (mods ? "кошелёк не подключён" : "ядро SDK странице не отдалось"));
  return await mods.actions.createActions({ call: (r) => evm.readContract(r) })
    .markReady({ escrow, expect }, wallet);
}

export async function claimOrder({ escrow, halfClaimer, expect } = {}) {
  const mods = await sdkCoreModules();
  const wallet = mods ? walletFor(mods) : null;
  if (!mods || !wallet) throw new Error("[bridge] забор подписать нечем: " + (mods ? "кошелёк не подключён" : "ядро SDK странице не отдалось"));
  return await mods.actions.createActions({ call: (r) => evm.readContract(r) })
    .claim({ escrow, halfClaimer, expect }, wallet);
}

export async function refundOrder({ escrow, halfLocker } = {}) {
  const mods = await sdkCoreModules();
  const wallet = mods ? walletFor(mods) : null;
  if (!mods || !wallet) throw new Error("[bridge] возврат подписать нечем: " + (mods ? "кошелёк не подключён" : "ядро SDK странице не отдалось"));
  // ОЖИДАНИЙ ЗДЕСЬ НЕТ НАМЕРЕННО: экран возврата их не передавал, и дописать их значило бы включить сверку
  // слотов там, где её не было, - то есть изменить поведение возврата.
  return await mods.actions.createActions({ call: (r) => evm.readContract(r) })
    .refund({ escrow, halfLocker }, wallet);
}

// --- АВТОМАТИЧЕСКИЙ РАННИЙ ВОЗВРАТ (issue #88) ------------------------------------------------------
// РЕШЕНИЕ ОСТАЁТСЯ В ЯДРЕ. Экран лишь передаёт запись сделки, ожидания ордера и сеть; саму проверку прихода
// (две ноды разных операторов на одном блоке) и решение "пора вернуть" делает ядро - swaps.refundIfXmrMissing.
// Ноды-свидетели берутся из настроек ТОГО ЖЕ ядра (config.nodesFor), а не выдумываются здесь: список живёт
// одной правдой на сеть. Кошелёк - тот же адаптер страницы, что подписывает прочие действия ордера.
export async function sdkAutoRefund(request) {
  const ctx = await instanceFor(request && request.chain);
  if (!ctx) return null;
  const req = { ...(request || {}) };
  if (!req.nodes && ctx.sdk.config && typeof ctx.sdk.config.nodesFor === "function") {
    req.nodes = ctx.sdk.config.nodesFor(req.xmrNetwork || MONERO.networkType);
  }
  if (!req.wallet) {
    const mods = await sdkCoreModules();
    const wallet = mods ? walletFor(mods) : null;
    if (wallet) req.wallet = wallet;
  }
  return ctx.sdk.swaps.refundIfXmrMissing(req);
}

// --- РАЗБОР RECOVERY-ФАЙЛА -----------------------------------------------------------------------
// Модуль разбора браузеру отдаётся, поэтому это настоящий путь ядра, а не запасной.
export async function sdkOpenRecovery(file, passphrase) {
  const mods = await sdkCoreModules();
  if (!mods) return null;
  return await mods.recovery.createRecovery().open(file, passphrase);
}

// --- ПОВЕРХНОСТИ ФАСАДА (котировки, состояние сделок, запуск сделки) -------------------------------
// Ядро собрано странице бандлом, поэтому эти вызовы идут через НАСТОЯЩИЙ фасад. null они отвечают только
// если сам бандл не загрузился - и тогда причина названа в консоли, а не спрятана.

export async function sdkWatchQuotes(request, onSnapshot) {
  const ctx = await instanceFor(request && request.chain);
  if (!ctx) return null;
  return ctx.sdk.quotes.watch(request, onSnapshot);
}

export async function sdkQuotesSnapshot(chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.quotes.snapshot() : null;
}

// --- ИНДИКАТИВНАЯ КНИГА КОТИРОВОК НА ЯДРЕ ---------------------------------------------------------
// КНИГА (предложения и отказы) ПРИХОДИТ ОТ ЯДРА: quotes.watch подписывается на опрос ядра, quotes.snapshot
// отдаёт последний снимок без ожидания. Склейник здесь делает ровно ОДНУ работу - ПЕРЕВОД ФОРМЫ: имена
// полей снимка ядра приводятся к тем, которые уже рисует экран. Ни одного правила отбора или приоритета
// здесь нет: что предложение, что отказ, что лучший - решает ядро (sdk/src/quotes.mjs, readBook). Ядро
// молчит или отказало - книга пуста, и прежняя (движковая) книга не подставляется: её больше нет.
//
// ПОДПИСКА ОДНА. Ядро опрашивает на время подписки; второй слушатель был бы вторым опросом, поэтому
// прежняя подписка снимается ПЕРЕД новой. Последний снимок переносится через переподписку: читающий видит
// прежнюю книгу, пока не придёт свежая, - а не пустоту на каждом такте.
let bookStop = null;       // отписка от текущей подписки ядра
let bookKey = null;        // под какой запрос (сеть|сторона|токен|размер) эта подписка поставлена
let bookCore = null;       // последний снимок ЯДРА (не перевода): перевод делается на чтение
let bookResume = null;     // ожидающий первого такта после подписки
// ШОВ-ПОДСТАНОВКА (sdkBookUse): поверхность котировок ядра, принесённая снаружи. Нужна проверкам, которые
// идут БЕЗ браузера: самого ядра в бандле там нет, а книгу проверить надо. В бою не задаётся.
let bookQuotes = null;

// ЯДРО ДЛЯ ПРОВЕРОК БЕЗ БРАУЗЕРА: кладём поверхность котировок (watch/snapshot) и работаем с ней.
export function sdkBookUse(quotesApi) {
  bookQuotes = quotesApi || null;
  bookCore = null;
  bookKey = null;
  bookResume = null;
  if (bookStop) { try { bookStop(); } catch { /* уже снята */ } }
  bookStop = null;
}

// ПЕРЕВОД СТРОКИ ЯДРА В СТРОКУ ЭКРАНА. Только имена: значения переносятся как есть. Возраст считается
// ЗДЕСЬ (от собственной метки котировки): ядро посчитало его на своём такте, а показ спрашивает свежесть
// сейчас - иначе срок жизни котировки «омолаживался» бы на такт опроса.
function bookRow(o) {
  const at = Number.isFinite(Number(o.at)) ? Number(o.at) : null;
  return {
    providerId: o.providerId, displayName: o.displayName, pair: o.pair,
    asset: o.asset, currency: o.currency,
    assetNetwork: o.assetNetwork, currencyNetwork: o.currencyNetwork, networkStated: o.networkStated === true,
    rateQuote: o.rateQuote, rate: o.rate,
    min: o.min, max: o.max, step: o.step, ttlMs: o.ttlMs,
    at, ageMs: at === null ? null : Math.max(0, Date.now() - at),
    seq: o.seq, why: o.why, signature: o.signature, keyId: o.keyId, finality: o.finality,
    networksDerived: o.networksDerived === true, networksUnnamed: o.networksUnnamed === true,
  };
}

// ВИД ОТКАЗА, КОТОРЫМ ЭКРАН НАЗЫВАЕТ ПРИЧИНУ. Код ядра `disabled` экран зовёт `off`; имена прочих кодов
// совпадают, и переименовывать их незачем.
const REFUSAL_KIND = { disabled: "off" };
function bookRefusal(r) {
  return { ...bookRow(r), code: r.code, kind: REFUSAL_KIND[r.code] || r.code, why: r.why };
}

// СНИМОК ЯДРА -> СНИМОК ЭКРАНА. Форма та же, что была у экрана: ok/error/data/at, а в data - references
// (справочный курс) и best. Отказ связи не превращается в прежние числа: ok снимается, и экран показывает
// честное состояние. Молчание ядра (снимка нет) - тоже пустая книга, а не прежняя.
function bookOf(core) {
  if (!core) return { ok: false, error: null, data: null, at: 0, fetching: false };
  const offers = (Array.isArray(core.offers) ? core.offers : []).map(bookRow);
  const refused = (Array.isArray(core.refused) ? core.refused : []).map(bookRefusal);
  const stamps = offers.map((o) => o.at).filter((v) => Number.isFinite(v));
  return {
    ok: !core.error,
    error: core.error ? String(core.error.code || "unknown") : null,
    at: core.at,
    fetching: false,
    data: {
      offers, refused, quotes: offers,
      // ЛУЧШЕЕ, КАК ЕГО НАЗВАЛ СЕРВИС: по нему экран подтверждает свою метку «лучшее» по паре и провайдеру.
      best: core.best || null,
      seq: core.seq === undefined ? null : core.seq,
      references: Array.isArray(core.references) ? core.references : [],
      at: stamps.length ? Math.max(...stamps) : null,
    },
  };
}

// ЗАПРОС КНИГИ У ЯДРА. Подписка ОДНА и переигрывается только когда СМЕНИЛСЯ ЗАПРОС: пока размер и сторона
// те же, ядро опрашивает книгу своим тактом, и второго опроса не заводится. Когда запрос сменился,
// вызывающий ждёт первый такт и получает СВЕЖИЙ снимок, а не прежний. Ядро не поднялось - пусто (и это
// называет причина в консоли).
export async function sdkBook({ chain, direction, token, size } = {}) {
  let quotes = bookQuotes;
  let instance = "injected";        // у подстановки (шва) сети нет: её экземпляр один
  if (!quotes) {
    const ctx = await instanceFor(chain);
    if (!ctx) {
      if (bookStop) { try { bookStop(); } catch { /* уже снята */ } bookStop = null; }
      bookKey = null;
      bookResume = null;
      bookCore = null;
      return null;
    }
    quotes = ctx.sdk.quotes;
    instance = ctx.chain.id;       // книги разных сетей смешивать нельзя: сеть - часть ключа
  }
  const dir = direction === "sell" ? "sell" : "buy";
  const key = instance + "|" + dir + "|" + String(token || "") + "|" + String(size === undefined || size === null ? "" : size);
  // ТОТ ЖЕ ЗАПРОС - ОПРОС УЖЕ ИДЁТ: возвращаем последний снимок, второй подписки не заводим. Иначе каждый
  // такт экрана сбрасывал бы состояние ядра и на мгновение отдавал бы пустую книгу читающему её напрямую.
  if (bookStop && bookKey === key) return bookCore;
  if (bookStop) { try { bookStop(); } catch { /* уже снята */ } bookStop = null; }
  bookKey = key;
  bookResume = null;
  const wait = new Promise((resolve) => { bookResume = resolve; });
  try {
    bookStop = quotes.watch({ direction: dir, token, size }, (snap) => {
      bookCore = snap;
      if (bookResume) { const resume = bookResume; bookResume = null; resume(); }
    });
  } catch (error) {
    bookResume = null;
    bookCore = null;
    console.warn("[bridge] книга котировок ядру не отдалась (" + ((error && error.message) || error) +
      "): предложений не будет; см. www/js/sdk/bridge.js");
    return null;
  }
  await wait;
  return bookCore;
}

// ПОСЛЕДНИЙ СНИМОК БЕЗ ОЖИДАНИЯ - в форме экрана. Ядро не опрошено ни разу - пусто (и это честно).
export function sdkBookSnapshot() {
  return bookOf(bookCore);
}

export async function sdkListSwaps(chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.list() : null;
}

export async function sdkGetSwap(id, chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.get(id) : null;
}

// УСЛОВИЯ ОРДЕРА - ДАННЫЕ ДЛЯ ЯДРА, А НЕ ЕГО ПРАВИЛА.
// Ядро требует эти восемь полей СНАРУЖИ (sdk/index.d.ts, StartRequest.order) и без них отказывает: к ним
// привязаны и доказательство DLEQ, и подпись твёрдой котировки (atomic/orderContext.js, FIELDS). Здесь они не
// выводятся заново, а берутся из того же, чем пользовалась страница: сеть и фабрика - из реестра сетей,
// вносит - подключённый кошелёк, сумма - из котировки, окна - из политики финальности провайдера
// (core/finality.js, orderWindows), соль - генератором движка (evm/funding.js, newSecret). Своих окон и
// своих чисел здесь не появляется: правило о минимальных окнах живёт в core/finality.js и core/preSignGuards.js.
export function sdkOrderTerms({ chain, amountWei, finality = null, salt = null, asset = "XMR" } = {}) {
  const windows = orderWindows(finality);
  const nowSec = Math.floor(Date.now() / 1000);
  const escrow = (chain && chain.escrow) || {};
  // КАССА КОМИССИИ - ЧАСТЬ УСЛОВИЙ ОРДЕРА (#103), как и фабрика: приходит из реестра сетей, а не из
  // контракта. Без неё ордер не собрать: условие обязательное и входит в termsHash.
  if (!escrow.cashier) throw new Error("в этой сети не задана касса комиссии (escrow.cashier) - ордер собрать нечем");
  return {
    chainId: chain.chainId,
    factory: escrow.address,
    cashier: escrow.cashier,
    locker: evm.address(),
    amount: String(amountWei),
    // ЧТО ЧЕЛОВЕК ПОЛУЧАЕТ. В канонический контекст ордера поле не входит (это следствие пары и сети), но
    // провайдер его ждёт - по нему он понимает, что выплата в XMR, и кладёт в свою запись котировки.
    // Значение приходит данными от экрана; умолчание - XMR (экран покупки XMR за нативную монету).
    asset: String(asset || "XMR"),
    readyBy: String(nowSec + windows.readyWindowSeconds),
    t1: String(nowSec + windows.claimWindowSeconds),
    salt: salt || newSecret(),
  };
}

// ТВЁРДАЯ КОТИРОВКА ПОД ОРДЕР - ДО ПОДПИСИ. Экран показывает ставку и получателя комиссии РАНЬШЕ, чем
// человек подпишет (пункт 7 из #76), а ТУ ЖЕ САМУЮ котировку отдаёт в запуск сделки (sdkStartSwap,
// поле orderQuote): подписывается ровно то, что показано, и второго запроса к ноде не делается.
//
// ПОЧЕМУ ЭТО МЕСТО, А НЕ ЭКРАН. Условия ордера (сеть, фабрика, вносивший, сумма, окна, соль) собираются
// ОДНИМ местом - sdkOrderTerms; экран не должен собирать их второй редакцией. Здесь они собираются, по ним
// запрашивается твёрдая котировка тем же путём ядра, и наружу уходят оба: `order` и `quote`.
export async function sdkOrderQuote({ chain, providerId, amountWei, finality = null, salt = null, asset = "XMR" } = {}) {
  const ctx = await instanceFor(chain);
  if (!ctx) return null;
  const order = sdkOrderTerms({ chain: ctx.chain, amountWei, finality, salt, asset });
  const quote = await ctx.sdk.quotes.firm({ providerId, order });
  return { order, quote };
}

// ЗАПУСК СДЕЛКИ ЯДРОМ ЦЕЛИКОМ. Порядок шагов, сторона ордера, сроки в контракт, адрес эскроу ИЗ КВИТАНЦИИ,
// отметка у нас и наблюдение за XMR - всё это держит ядро (sdk/src/swaps.mjs, swaps.start). Экран отдаёт
// только данные: котировку, куда получить, пароль, кошелёк и обработчик подтверждения файла. Своей стороны
// ордера, своих адресов и своих транзакций страница здесь не собирает.
export async function sdkStartSwap(request) {
  const ctx = await instanceFor(request && request.chain);
  if (!ctx) return null;
  const req = { ...(request || {}) };
  // КОШЕЛОК ДЛЯ ЗАМКА - АДАПТЕР КОШЕЛЬКА СТРАНИЦЫ, ЕСЛИ ВЫЗЫВАЮЩИЙ ЕГО НЕ ПРИНЁС. Подпись возможна только
  // в кошелёк-провайдере страницы, а своего провайдера у ядра нет: ядро получает готовый адаптер (send/receipt).
  if (!req.wallet) {
    const mods = await sdkCoreModules();
    const wallet = mods ? walletFor(mods) : null;
    if (wallet) req.wallet = wallet;
  }
  // КОШЕЛОК СТРАНИЦЫ ОТДАЁТСЯ ЯДРУ И КАК ЕГО КОШЕЛЁК: стражи сети (preflight) спрашивают сеть У КОШЕЛЬКА
  // ЯДРА, а не у того, что передан на замок, - иначе запуск отказывает кодом network { wallet-unknown }
  // (так делает и живой прогон из Node: sdk.wallet.use(...); await sdk.wallet.connect()). Подпись от этого
  // не меняется: и подключение, и отправка идут через тот же провайдер страницы.
  if (req.wallet) {
    try { ctx.sdk.wallet.use(req.wallet); await ctx.sdk.wallet.connect({ chainId: ctx.chain.chainId }); }
    catch { /* кошелёк не поднялся - отказ назовёт само ядро (network/wallet-unknown), тишины нет */ }
  }
  // Условий ордера нет - собираем их из данных (см. sdkOrderTerms). Контракт StartRequest допускает и
  // готовые: тогда вызывающий приносит свою сторону ордера со своими точками (инъекция записи).
  if (!req.order) {
    req.order = sdkOrderTerms({ chain: ctx.chain, amountWei: req.amountWei, finality: req.finality,
      salt: req.salt, asset: req.receiveAsset });
  }
  // ТВЁРДАЯ КОТИРОВКА ПОД ЭТОТ ОРДЕР - И ОНА ЖЕ УХОДИТ В ЗАМОК. Экран, показавший комиссию ДО подписи,
  // приносит котировку ГОТОВОЙ (sdkOrderQuote) - тогда второй раз к ноде не идём и подписывается ровно то,
  // что человек видел. Если не принёс, запрашиваем здесь тем же путём ядра (config.route("orderQuote")).
  //
  // ЗАЧЕМ ЭТО ОТДЕЛЬНОЕ ПОЛЕ. Замок берёт котировку НЕ из req.quote: req.quote - индикативная котировка
  // книги для стражей (свежесть, сроки), а фабрике нужен ПОДПИСАННЫЙ НАБОР (комиссия, реестр, провайдер).
  // Ядро читает его как `request.orderQuote` (sdk/src/swaps.mjs). Пока мост его не клал, запуск доходил до
  // внесения и падал там: "нужна подписанная котировка: фабрика принимает котировку, а не голые условия ордера".
  if (!req.orderQuote && req.providerId) {
    req.orderQuote = await ctx.sdk.quotes.firm({ providerId: req.providerId, order: req.order });
  }
  if (req.orderQuote) {
    // ЗАБИРАЮЩЕГО НАЗЫВАЕТ ПРОВАЙДЕР, и он входит в контекст ордера: без него доказательство не сойдётся
    // (ядро так и откажет - context mismatch). Здесь только переносим его значение в условия.
    if (req.orderQuote.claimer) req.order = { ...req.order, claimer: req.orderQuote.claimer };
    // ID КОТИРОВКИ ПОД ОРДЕР УХОДИТ В ЗАПИСЬ СДЕЛКИ: по нему наш сервис связывает эскроу с записью ноды
    // провайдера, и только после этого нода может забрать ETH. Экран это делал сам (swap.orderQuoteId) -
    // значит данные остаются теми же, и терять их при переводе нельзя.
    if (req.orderQuote.id) req.quote = { ...(req.quote || {}), id: req.orderQuote.id };
    // СТОРОНА КОНТРАГЕНТА - ЭТА ЖЕ КОТИРОВКА: в ней половина, точка и доказательство провайдера, и её же
    // проверяет ядро (order.acceptCounterparty). Своей стороны контрагента мост не выдумывает.
    if (!req.counterparty) req.counterparty = req.orderQuote;
  }
  // СРОКИ ОРДЕРА УХОДЯТ И В КОТИРОВКУ: стражи сроков (preflight -> deadlineVerdict) читают readyBy/t1 ИЗ
  // КОТИРОВКИ, а не из условий. Значения ТЕ ЖЕ, что ушли в order - второго счёта и второго мнения не
  // появляется; иначе ядро честно отказывает кодом deadline { kind: "deadlines-unstated" }.
  req.quote = { ...(req.quote || {}), readyBy: Number(req.order.readyBy), t1: Number(req.order.t1) };
  return ctx.sdk.swaps.start(req);
}

// НАБЛЮДЕНИЕ ЗА ПРИХОДОМ XMR - ТОТ ЖЕ ШАГ ЯДРА, ЧТО И У ЗАПУСКА (GET /api/swaps/{id}). Отдельная функция
// нужна экранам состояния: они ждут приход, а не начинают сделку. Ожидания ордера и кошелёк передаёт
// вызывающий - без них ядро не подписывает отметку готовности, а лишь называет её следующий шаг.
export async function sdkWatchSwap(request) {
  const ctx = await instanceFor(request && request.chain);
  if (!ctx) return null;
  return ctx.sdk.swaps.watch(request);
}

// --- СПИСОК СДЕЛОК ОТ ЯДРА (экран #/swaps) ---------------------------------------------------------
// ЧТЕНИЕ, СЛИЯНИЕ И УБОРКА ИДУТ ЧЕРЕЗ ЯДРО, А НЕ ЧЕРЕЗ ДВИЖОК НА ЭКРАНЕ. sdkListSwaps выше отдаёт
// состояния сделок (swaps.list); ниже - серверный список (swaps.sync: путь и правило слияния живут в ядре)
// и уборка записи (swaps.forget: она убирает запись только здесь, на сервере и в контракте всё остаётся).
// Ядро не поднялось - null, и причину называет консоль (см. sdkBundle), а не молчание.
export async function sdkSyncSwaps(chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.sync() : null;
}

export async function sdkForgetSwap(id, chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.forget(id) : null;
}

// СЛЕЖЕНИЕ И ЧТЕНИЯ СТРАНИЦЫ - ЧЕРЕЗ ТОТ ЖЕ ШОВ, ПОД ПРЕЖНИМИ ИМЕНАМИ. Экран объявляет фокус опроса и
// читает ставку комиссии (справочник) ЗДЕСЬ, а не из core/ и evm/ напрямую. Имена оставлены ДОСЛОВНО теми
// же, что были у движка (тот же приём, что у markReadyOrder/claimOrder/refundOrder выше): экран меняет
// ИСТОЧНИК импорта, а не строку вызова. Состояние ордера (orderStatus/orderDeadlines) объявлено функциями
// выше - это те же чтения, но теперь правила чтения живут в пакете, а не в www/js/core/swap-flow.js.
export { setLiveFocus, cachedFeeRate, dealSwapIds, serverRestoreHeightFor, STEP_LABELS };

// СОСТОЯНИЕ ОРДЕРА И ЕГО СРОКИ - ЧТЕНИЕ ЦЕПИ КОШЕЛЬКОМ СТРАНИЦЫ, НО ЧЕРЕЗ ЯДРО (#32, волна 3). Сами правила
// чтения (status()/t1()/termsHash()/readyBy() и разбор ответов) переехали в пакет (sdk/src/swap-flow.mjs,
// фасад order.status/order.deadlines). Склейник отдаёт их экрану ПОД ПРЕЖНИМИ ИМЕНАМИ, а кошелёк-читатель
// подсовывает ядру тот же, что и у действий ордера (optionsFor -> evmCall), поэтому читает тот же кошелёк,
// что и подпишет. Ядро не загрузилось - НАЗВАННЫЙ отказ, а не молчание и не пустое состояние.
export async function orderStatus(escrow) {
  const ctx = await instanceFor(undefined);
  if (!ctx) throw new Error("[bridge] состояние ордера не прочитать: ядро SDK странице не отдалось");
  return ctx.sdk.order.status(escrow);
}

export async function orderDeadlines(escrow) {
  const ctx = await instanceFor(undefined);
  if (!ctx) throw new Error("[bridge] сроки ордера не прочитать: ядро SDK странице не отдалось");
  return ctx.sdk.order.deadlines(escrow);
}

// ВЫСОТА УЗЛА MONERO - ЧТЕНИЕ СТРАНИЦЫ. Своего нода у ядра нет (все чтения цепи идут через адаптер кошелька
// страницы), поэтому высота для высоты скана берётся здесь, а не выдумывается. Имя сохранено (nodeHeight).
export async function nodeHeight() { return nodeHeightValue(); }

// --- СОСТОЯНИЕ И ДЕЙСТВИЯ ДЕМОНСТРАЦИОННОЙ СДЕЛКИ (экран хода, progress.js) -------------------------
// СОСТОЯНИЕ ОТДАЁТ ЯДРО: swaps.progress собирает снимок сделки (запись + вывод состояния + кошелёк из половин).
// Прежней движковой дороги у экрана НЕТ (в отличие от действий ордера выше): ядро не поднялось - null, и экран
// честно говорит, что состояния нет. Так же устроен и экран списка (sdkListSwaps).
export async function sdkProgress(id, chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.progress(id) : null;
}

// ДЕЙСТВИЯ И ЗАПИСЬ ДЕМОНСТРАЦИОННОЙ СДЕЛКИ - через ядро, с прежним вызовом движка как запасным путём: это ТЕ ЖЕ
// функции (sdk/src/swaps.mjs зовёт engine.swap.*). Имена - ядра (swaps.confirmReady/refundEth/sweepNow/
// setDestination), а не строки вызова экрана.
export async function sdkConfirmReady(id) {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.confirmReady(id);
  return engineConfirmReady(id);
}

export async function sdkRefundEth(id, by = "you") {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.refundEth(id, by);
  return engineRefundEth(id, by);
}

export async function sdkSweepNow(id) {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.sweepNow(id);
  return engineSweepNow(id);
}

export async function sdkSetDestination(id, address) {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.setDestination(id, address);
  const swap = engineGetSwap(id);
  if (!swap) return null;
  swap.receiveAddress = address;
  return engineSaveSwap(swap);
}

// СЕТЬ АДРЕСА MONERO - ПОВЕРХНОСТЬ ЯДРА (оно владеет форматом адреса): склейник только отдаёт её экрану.
// Запасной путь - тот же модуль, что зеркалит ядро (www/js/monero/address.js): второй таблицы префиксов нет.
export async function sdkAddressNetwork(address) {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.addressNetwork(address);
  try { return networkFromShape(address); } catch { return null; }
}

// --- ВИТРИНА И МЕХАНИЗМЫ СТРАНИЦЫ: ФОРМА, ПОДПИСЬ, ПРОДАЖА, ОСНОВАНИЕ -------------------------------
// ЗДЕСЬ ЖИВЁТ ТО, ЧТО ЭКРАНЫ БРАЛИ У ДВИЖКА НАПРЯМУЮ, а теперь берут ТЕМ ЖЕ ШВОМ - под теми же именами.
// Это ОСОЗНАННО оставшееся и названное, а не забытое:
//   * evm, swapCore, moneroNode - механизмы СТРАНИЦЫ: кошелёк (подпись возможна только в его провайдере),
//     свод сделок и такт опроса, чтения и опрос узла Monero (своего узла у ядра нет);
//   * цены, комиссии, газ и DEX-нога формы - ВИТРИНА: числа читаются у цепи модулями движка, а экран
//     получает их швом, а не второй дорогой в движок;
//   * networkFromShape/networkLabel - форма адреса Monero и её название: тот же модуль формата, что
//     зеркалит ядро (второй таблицы префиксов нет);
//   * createOrderWorker - воркер половин атомарного свопа: криптография живёт в одном месте и зовётся
//     воркером, чтобы главный поток не замирал;
//   * createSwap/createReverseSwap/activeSwaps - ЗАПИСЬ демонстрационной и обратной сделки (запись ведёт
//     движок; ядро отдаёт её СОСТОЯНИЕ через swaps.list/swaps.progress).
// ИМЯ БЕРЁТСЯ ИЗ ДВИЖКА ЗДЕСЬ ЖЕ (импортом) И ОТДАЁТСЯ НАРУЖУ (экспортом) - один шов, одна копия. Ни
// одного нового правила здесь нет: экран меняет источник импорта, а не строку вызова.
import { networkLabel, probeMode } from "../monero/wallet.js";
import { amountInputValue } from "../evm/amounts.js";
import { refreshChainPrices, priceLabel } from "../evm/prices.js";
import { orderGasReservePlan } from "../evm/gasReserve.js";
import { quoteDexOut, dexLegVerdict } from "../evm/dex.js";
import { toWei } from "../evm/funding.js";
import { cachedFeeTerms, feeWeiFor, ensureFeeTerms } from "../evm/fees.js";
import { createOrderWorker } from "../atomic/order-client.js";
import { activeSwaps, createSwap, createReverseSwap } from "../core/swap.js";

export { evm, networkFromShape };
export * as swapCore from "../core/swap.js";
export * as moneroNode from "../monero/node.js";
export { networkLabel, probeMode, amountInputValue, refreshChainPrices, priceLabel, orderGasReservePlan, quoteDexOut, dexLegVerdict, toWei, cachedFeeTerms, feeWeiFor, ensureFeeTerms, createOrderWorker, activeSwaps, createSwap, createReverseSwap };

