// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/swap.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Ядро демки: состояние сделки во времени.
//
// Принцип: состояние НЕ хранится как «текущий шаг». Хранятся таймстемпы и события,
// а фаза выводится функцией derive() из sim-времени. Поэтому демо переживает
// перезагрузку страницы, а «закрыть вкладку и вернуться» работает по-настоящему.
//
// Модель соответствует litepaper §4.2 и §5.3:
//  - T0: дедлайн лока XMR мейкером. Не залочил - пользователь возвращает ETH (permissionless).
//  - ready: пользователь подтверждает, что увидел лок своим view-ключом.
//  - T1: дедлайн claim мейкера. Не сделал claim - пользователь возвращает ETH.
//  - Если пользователь не сделал ready - мейкер забирает XMR назад, пользователь возвращает ETH.
//  - Watchtower может вернуть деньги пользователю без его участия.

// DEMO НУЖЕН ЗДЕСЬ, И ЭТО НЕ МЕЛОЧЬ: ниже из него берётся умолчание режима цепи. Имя не было импортировано,
// поэтому ЛЮБАЯ сделка, заведённая без явного chainMode, падала с "DEMO is not defined" - а страница живой
// сделки передаёт режим явно, и поломка не была видна до первой проверки, которая заводит сделку без него.
import { TIMING, MONERO, SCENARIO_LABELS, DEFAULT_CHAIN, API, DEMO, chainById, SIGNING_GUARDS } from "./config.js";
// ОКНО ПРОДАЖИ XMR (issue #111) - ОДНО правило на ноду и страницу. Здесь оно только читается для отсчёта.
import { sellWindowSec, SELL_WINDOW } from "./sellWindow.js";
import { simElapsed, simWall, nowReal, rescaleStart } from "./clock.js";
import { loadState, saveState } from "./store.js";
import { shortId, randomHex } from "./format.js";
import * as chain from "../mock/chain.js";
import * as node from "../monero/node.js";
// Источник Monero-ноги: в режиме "app" подтверждения и поступления приходят от бэкенда,
// в режиме "mock" - от симулятора демки. Что именно уходит наружу (только адрес и view key),
// проверяется в tools/check-chain-source.mjs.
import { XMR_STATUS, explorerXmrTx, fetchSession, isLiveSource, openSession, pollInterval, xmrView } from "./chainSource.js";
import { watchOnlyShareFromWallet } from "../recovery/restore.js";

export const STEP_LABELS = [
  ["funded", "Funded on-chain"],
  ["maker_locking", "Maker locking XMR"],
  ["xmr_locked", "XMR locked"],
  ["ready", "Verified by you"],
  ["claimed", "Claimed by maker"],
  ["swept", "Sent to your address"],
];

export const TERMINAL = {
  success: { phase: "success", label: "XMR delivered" },
  refunded_eth: { phase: "refunded_eth", label: "ETH refunded" },
  xmr_returned: { phase: "xmr_returned", label: "Swap cancelled, funds returned" },
};

export function createSwap(input) {
  const s = loadState();
  const now = Date.now();
  const swap = {
    id: shortId(),
    side: input.side || "buy",
    scenario: input.scenario || "happy",
    speed: input.speed || 60,
    // ВИДА КОТИРОВКИ В ЗАПИСИ НЕТ. Прежнее поле mode ("floating"/"fixed") было выбором вида цены, а в
    // версии 4 второго вида не существует (док 41, §7): твёрдая котировка ровно одна - ордерная.
    network: input.network || DEFAULT_CHAIN,
    moneroNetwork: MONERO.networkType,
    realStart: now,
    simStartWall: now,
    createdAt: new Date(now).toISOString(),
    payToken: input.payToken,
    payAmount: Number(input.payAmount),
    xmrAmount: Number(input.xmrAmount),
    rate: Number(input.rate),
    fee: Number(input.fee),
    maker: { id: input.makerId, name: input.makerName, spread: input.makerSpread },
    dexSpread: input.dexSpread,
    gasUsd: input.gasUsd,
    receiveAddress: input.receiveAddress,
    quoteSignature: input.quoteSignature,
    swapWallet: input.swapWallet || null, // ключи одноразового Monero-кошелька
    timeline: {
      fundAtSim: 0,
      lockAtSim: input.scenario === "maker_no_lock" ? null : TIMING.makerLock,
      blockSim: MONERO.blockTimeSim,
      confTarget: MONERO.confirmTarget,
      t0Sim: TIMING.t0Refund,
    },
    // ТО ЖЕ УМОЛЧАНИЕ, ЧТО И В НАСТРОЙКАХ: "live" - настоящая высота цепи, "mock" - таймер песочницы.
  // Второй умолчал здесь значил бы, что сделка без явного режима считается по таймеру.
  chainMode: input.chainMode || DEMO.defaultChainMode, // mock | live (реальная высота Monero mainnet)
    // Источник Monero-ноги: "app" - настоящий бэкенд (см. core/chainSource.js), "mock" - симулятор.
    xmrSource: input.xmrSource || API.xmrSource,
    xmrSession: null, // последний опрос бэкенда: статус, сумма, подтверждения, txid
    xmrSessionError: null, // причина отказа бэкенда: показываем как состояние, а не как падение
    events: [],
    escrow: null,
    xmr: null,
    settlement: null,
    log: [],
  };

  // ДЕМОНСТРАЦИОННОЕ ФОНДИРОВАНИЕ ТОЛЬКО В ДЕМОНСТРАЦИИ. Здесь стоял безусловный вызов моковой ветки
  // (chain.fundEscrow), и он выполнялся В ТОМ ЧИСЛЕ на живом пути: запись получала ВЫДУМАННЫЙ адрес эскроу
  // и ВЫДУМАННЫЙ хеш транзакции, а живой поток потом с ними боролся. Снаружи это выглядело так: настоящий
  // ордер создан и оплачен, а экран прогресса, ссылка на обозреватель, файл восстановления и плательщик
  // смотрят на адрес, которого на цепи нет. На живом пути адрес и хеш обязан дать ТОЛЬКО живой поток.
  if (swap.chainMode !== "live") {
    const fund = chain.fundEscrow({ swapId: swap.id, ethAmountUsd: swap.payAmount, ethUsd: 3212.4 });
    swap.escrow = {
      address: fund.escrow,
      fundTx: fund.txHash,
      method: fund.method,
      fundedAtSim: 0,
      gasUsd: fund.gasUsd,
    };
    pushLog(swap, 0, "Escrow funded", `eth escrow ${fund.escrow}`);
  } else {
    // ЗАГОТОВКА ПОД ЖИВОЙ ОРДЕР - И БЕЗ ЕДИНОГО ВЫДУМАННОГО ЗНАЧЕНИЯ. Адрес и хеш появятся из живого
    // потока фондирования (confirm.js записывает их из ответа потока). Пустые поля здесь нужны не для
    // красоты: без объекта запись оставалась без места, куда живому пути писать, и адрес терялся молча.
    swap.escrow = { address: null, fundTx: null, method: null, fundedAtSim: 0, gasUsd: input.gasUsd ?? null };
  }

  s.swaps[swap.id] = swap;
  s.activeSwapId = swap.id;
  saveState(s);
  return swap;
}

// REVERSE-FLOW DEAL RECORD (issue #118, second half). The sell screen used to stop at the request, and there was
// nowhere to show a refund: a reverse deal had no record. It is created here - from exactly what the screen
// already has (the node ticket plus the computed halves) - and lands in the same store as the buy flow, so the
// deal card, the recovery file and the XMR sweep all work off it.
//
// WHAT THE REVERSE DEAL DOES DIFFERENTLY. On the buy flow the PAGE funds the escrow, and the counterparty's half
// is only learned after settlement. On the sell flow the PROVIDER funds the escrow, the page merely requests the
// order, and it computes ITS OWN halves (atomic/order-worker.js, newMakerMaterial). So fields are named by side:
// our half is `half`, and the DEPOSITOR's (provider's) point and view half are counterSpendPoint/counterView*.
// The page does not know the depositor's SPEND half and must not: the contract publishes it on settlement, and
// only then does the sweep of our own XMR open up (see refundHalfRevealed).
export function createReverseSwap(input = {}) {
  const s = loadState();
  const now = Date.now();
  const xmr = Number(input.xmrAmount);
  const swap = {
    id: shortId(),
    side: "reverse",
    scenario: "happy",
    speed: Number(input.speed) || 60,
    network: input.network || DEFAULT_CHAIN,
    moneroNetwork: MONERO.networkType,
    realStart: now,
    simStartWall: now,
    createdAt: new Date(now).toISOString(),
    // THE USER GIVES XMR AND RECEIVES THE NATIVE COIN: payToken is XMR, receiveAddress is their payout address
    // on the settlement chain.
    payToken: "XMR",
    payAmount: xmr,
    xmrAmount: xmr,
    rate: Number(input.rate) || 0,
    fee: Number(input.fee) || 0,
    maker: { id: input.providerId || null, name: input.providerName || null, spread: null },
    receiveAddress: input.claimer || null,
    quoteSignature: null,
    ticket: input.ticketId || null,
    timeline: { fundAtSim: 0, lockAtSim: 0, blockSim: MONERO.blockTimeSim, confTarget: MONERO.confirmTarget, t0Sim: TIMING.t0Refund },
    chainMode: input.chainMode || DEMO.defaultChainMode,
    xmrSource: input.xmrSource || API.xmrSource,
    xmrSession: null,
    xmrSessionError: null,
    events: [],
    // HALVES WALLET OF THE REVERSE ORDER: our own spend and view half plus the depositor's PUBLIC halves. The
    // recovery file builds the wallet from here (recovery/recoveryFile.js, buildPayload v3), and after the half
    // is revealed, so does the spend key. The counterparty's SPEND half is not here: the chain provides it
    // (refundHalfRevealed).
    escrow: {
      address: input.escrowAddress || null,
      moneroAddress: input.moneroAddress || null,
      half: input.ownSpendHalf || null,
      viewHalf: input.ownViewHalf || null,
      counterViewHalf: input.counterViewHalf || null,
      counterViewPoint: input.counterViewPoint || null,
      counterSpendPoint: input.counterSpendPoint || null,
      moneroNetwork: MONERO.networkType,
      birthHeight: input.escrowBirthHeight || null,
      readyBy: input.readyBy || null,
      t1: input.t1 || null,
      // The DEPOSITOR's REVEALED HALF appears when the chain publishes it on settlement. Until then there is
      // nothing to sweep with.
      counterHalf: null,
    },
    xmr: null,
    settlement: null,
    log: [],
  };
  s.swaps[swap.id] = swap;
  s.activeSwapId = swap.id;
  saveState(s);
  return swap;
}

function pushLog(swap, atSim, title, detail) {
  swap.log.push({ atSim, wall: simWall(swap, atSim), title, detail: detail || "" });
  // Дублируем в КОНСОЛЬ и это основной канал для разбора. Раньше журнал показывался только на странице,
  // где жил в состоянии экрана и исчезал при перерисовке - то есть ровно тогда, когда он нужнее всего.
  // В консоли история сохраняется, и её можно скопировать целиком.
  console.log(`[swap ${swap.id}] ${title}${detail ? " - " + detail : ""}`);
}

// Убрать сделку из состояния браузера. Только локально: на сервере запись остаётся, и файлы кошелька,
// которые им управляет бэкенд, тоже. Массово удалять их по маске нельзя - там кошельки настоящих свопов,
// поэтому серверная уборка делается отдельным скриптом осознанно (tools/cleanup-swaps.mjs).
// КОШЕЛОК ИЗ ПОЛОВИН ЗАПИСИ - ДЛЯ ФАЙЛА ВОССТАНОВЛЕНИЯ. Половины сохраняются в записи сделки в момент
// фондирования (escrow.half и соседние поля), и это единственный их дом: полного ключа траты не существует
// ни у одной стороны, а своя половина случайна - мнемоникой её не восстановить. Раньше выгрузка брала
// swapWallet (кошелёк прежней схемы), и файл получался версией 2 - по такому файлу свои XMR не забрать.
// Собираем ровно те поля, которых ждёт recoveryFile.js версии 3, и в одном месте, чтобы выгрузка и
// проверки не расходились.
export function halvesWalletOf(swap) {
  const e = (swap && swap.escrow) || {};
  if (!e.half || !e.viewHalf || !e.counterViewHalf || !e.moneroAddress) return null;
  return {
    source: "halves",
    library: "monero-js",
    network: e.moneroNetwork || MONERO.networkType,
    address: e.moneroAddress,
    subaddress: null,
    spendHalf: e.half,
    viewHalf: e.viewHalf,
    // THE COUNTERPARTY'S SPEND POINT CARRIES DIFFERENT NAMES PER FLOW: on the direct swap it is the claimer's
    // point (edPointClaimer); on the reverse swap it is the DEPOSITOR's point, which the contract publishes on
    // settlement (counterSpendPoint). One consumer (the recovery file and the sweep) must read both, or the
    // reverse order would end up without its own spend key.
    otherSpendPoint: e.counterSpendPoint || e.edPointClaimer || null,
    otherViewPoint: e.counterViewPoint || null,
    otherViewHalf: e.counterViewHalf,
  };
}

export function forgetSwap(id) {
  const s = loadState();
  if (!s.swaps[id]) return false;
  delete s.swaps[id];
  saveState(s);
  return true;
}

export function getSwap(id) {
  return loadState().swaps[id] || null;
}

export function allSwaps() {
  const s = loadState();
  return Object.values(s.swaps).sort((a, b) => (a.realStart < b.realStart ? 1 : -1));
}

// ---- СЛИЯНИЕ С СПИСКОМ СЕРВЕРА --------------------------------------------------------------------
//
// Зачем. Пока записи живут только в localStorage, список привязан к браузеру: очистили данные сайта или
// открыли с другого устройства - сделок не видно, хотя деньги в эскроу на месте. Серверный список это
// снимает.
//
// ПРАВИЛА СЛИЯНИЯ, и они намеренно осторожные:
//   1) локальная запись ВСЕГДА главнее: она знает больше (секрет, кошелёк, стадии). Серверная строка только
//      ДОБАВЛЯЕТ то, чего в этом браузере нет, и никогда не перезаписывает найденное;
//   2) запись, пришедшая с сервера, помечается source: "server" - чтобы человек и код видели, откуда она,
//      и чтобы на экране можно было честно сказать об этом;
//   3) из серверной строки берём только публичные поля. Секрета там нет и быть не может - значит, такая
//      сделка будет видна, но подписать забор средств из неё нельзя: секрет лежит в файле восстановления.
//      Это не недоделка, а следствие того, что секрет на сервер не уходит.
export function serverRowToSwap(row) {
  const escrow = String((row && row.escrow) || "").toLowerCase();
  return {
    id: String(row.id),
    network: row.network || null,
    chain: row.network || null,
    source: "server",
    status: "in_progress",
    escrow: {
      address: escrow,
      t0: row.t0 != null ? Number(row.t0) : null,
      t1: row.t1 != null ? Number(row.t1) : null,
      hashlock: row.hashlock || null,
      amountWei: row.amount != null ? String(row.amount) : null,
      fromServer: true,
    },
    log: [],
    events: [],
  };
}

// Добавить записи с сервера, которых нет локально. Возвращает число добавленных: вызывающий по нему решает,
// перерисовывать ли список, а не догадывается.
export function addServerSwaps(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const s = loadState();
  let added = 0;
  for (const row of rows) {
    if (!row || !row.id || !row.escrow) continue;
    if (s.swaps[row.id]) continue;                       // локальная запись главнее - не трогаем
    s.swaps[row.id] = serverRowToSwap(row);
    added += 1;
  }
  if (added) saveState(s);
  return added;
}

// Найти сделку по адресу эскроу: нужно, чтобы связать запись из списка сервера с настоящим ордером.

export function activeSwaps() {
  return allSwaps().filter((sw) => !sw.settlement);
}

// СОХРАНИТЬ СДЕЛКУ ПОСЛЕ ПРАВОК ИЗВНЕ. persist() был внутренним, и вызывающие модули (например
// confirm.js) правили поля записи - адрес эскроу, соль, сроки, секрет - и НЕ сохраняли её: правки жили в
// памяти и исчезали вместе с вкладкой, а экран прогресса читал из хранилища СТАРУЮ запись. Именно
// поэтому интерфейс показывал адрес, которого на цепи нет, даже когда фондирование прошло успешно.
export function saveSwap(swap) {
  return persist(swap);
}

function persist(swap) {
  const s = loadState();
  s.swaps[swap.id] = swap;
  saveState(s);
  return swap;
}

function event(swap, type, atSim, extra = {}) {
  swap.events.push({ type, atSim, ...extra });
  return swap;
}

function findEvent(swap, type) {
  return swap.events.find((e) => e.type === type) || null;
}

// ---------------------------------------------------------------------------
// Действия пользователя
// ---------------------------------------------------------------------------

export function confirmReady(id) {
  const swap = getSwap(id);
  if (!swap || swap.settlement) return swap;
  const view = derive(swap);
  if (!view.can.ready) throw new Error("ready() недоступен в этой фазе");
  const atSim = simElapsed(swap);
  event(swap, "ready", atSim);
  pushLog(swap, atSim, "ready() called by you", "maker may now claim the ETH escrow");
  if (!findEvent(swap, "funded_note")) event(swap, "funded_note", 0);
  return persist(swap);
}

// THE COUNTERPARTY'S SPEND HALF - THE ONE PLACE THAT SHOWS WHETHER THERE IS ANYTHING TO ASSEMBLE. The Monero
// spend key is the sum of two halves, and the user holds their own; sweeping XMR back after a refund is possible
// exactly when the second half is ALREADY revealed. In the record it is stored as counterHalf (the engine sets it
// while the counterparty is a stand-in) or as revealedHalf (read from the chain after claim/refund, docs/36).
export function refundHalfRevealed(swap) {
  const e = (swap && swap.escrow) || {};
  return e.revealedHalf || e.counterHalf || null;
}

// XMR SWEEP. In the ordinary phase this happens after the other side reveals its half through settlement. A
// REVERSE-FLOW REFUND (issue #118, second half) is the SECOND case: the order was refunded, the user's coins
// stayed on the swap's one-time address, and the contract revealed the DEPOSITOR's half on refund. Then the same
// sweep takes our coins back, and the settlement is marked recovered: the money returned to the user rather
// than leaving through the swap.
export function sweepNow(id) {
  const swap = getSwap(id);
  if (!swap) return swap;
  // The deal already settled: no second sweep - EXCEPT a reverse-flow refund, which is how our own XMR are taken
  // back.
  if (swap.settlement && !(swap.settlement.kind === "refund_eth" && swap.side === "reverse")) return swap;
  const view = derive(swap);
  if (!view.can.sweep) throw new Error("sweep недоступен в этой фазе");
  const atSim = simElapsed(swap);
  const tx = chain.sweepXmr({ swapId: swap.id });
  swap.xmr = swap.xmr || {};
  swap.xmr.sweepTxid = tx.txid;
  const fromRefund = Boolean(swap.settlement && swap.settlement.kind === "refund_eth");
  swap.settlement = { kind: "success", phase: TERMINAL.success.phase, atSim, txid: tx.txid, by: "you",
    ...(fromRefund ? { recovered: true } : {}) };
  pushLog(swap, atSim, "XMR swept to your address", tx.txid);
  return persist(swap);
}

export function refundEth(id, by = "you") {
  const swap = getSwap(id);
  if (!swap || swap.settlement) return swap;
  const view = derive(swap);
  if (!view.can.refund) throw new Error("refund недоступен в этой фазе");
  const atSim = simElapsed(swap);
  const tx = chain.refundEscrow({ swapId: swap.id, by });
  swap.settlement = { kind: "refund_eth", phase: TERMINAL.refunded_eth.phase, atSim, txHash: tx.txHash, by };
  pushLog(swap, atSim, `ETH refunded to your wallet (${by})`, tx.txHash);
  return persist(swap);
}

// ---------------------------------------------------------------------------
// Вывод состояния
// ---------------------------------------------------------------------------

// Живая ли сеть сделки: escrow.mode = live в конфиге сети. Настройка сети - факт, одинаковый для старых и
// новых сделок, в отличие от поля chainMode внутри записи.
function isLiveNetwork(swap) {
  const conf = (chainById((swap && swap.network) || DEFAULT_CHAIN) || {}).escrow || {};
  return conf.mode === "live";
}

// СУММА НА АДРЕСЕ ПРОТИВ ОБЕЩАННОЙ КОТИРОВКОЙ. Отметка ready разрешает забирающему расчёт по своей половине -
// то есть отдаёт ему ETH - поэтому она делается не на "что-то пришло", а на ДОСТАТОЧНУЮ сумму. Допуск 1e-6 XMR
// покрывает округление показа, а не скидку. Неизвестная сумма - тоже отказ: незнание не разрешение.
const XMR_AMOUNT_EPS = 1e-6;
export function xmrAmountCheck(swap, xmr) {
  const expected = Number(swap && swap.xmrAmount);
  const hasExpected = Number.isFinite(expected) && expected > 0;
  // «УВИДЕННАЯ СУММА» - ЭТО ВСЁ, ЧТО ЛЕЖИТ НА АДРЕСЕ: и разблокированное, и запертое unlock_time. Иначе у
  // запертого поступления сумма показывалась бы «не увидена», хотя деньги на адресе есть. Что из неё можно
  // потратить - отдельный вопрос, и его решает статус (ready не включается, пока деньги заперты).
  const seenSource = xmr && xmr.arrived !== null && xmr.arrived !== undefined ? xmr.arrived : (xmr ? xmr.received : null);
  const seen = seenSource !== null && seenSource !== undefined && Number.isFinite(Number(seenSource))
    ? Number(seenSource) : null;
  if (!hasExpected) {
    return { ok: true, checked: false, expected: null, seen,
      why: "the record has no quoted XMR amount, so the arrived sum cannot be compared - this is named, not assumed" };
  }
  if (seen === null) {
    return { ok: false, checked: true, expected, seen: null,
      why: "the amount of XMR on the address is not known (" + expected + " XMR was quoted): ready stays closed until the sum is seen" };
  }
  // СВЕРКА ДВУСТОРОННЯЯ, И ЭТО ИСПРАВЛЕНИЕ issue #116. Прежде проверка была односторонней («пришло не
  // меньше») и оттого СЛЕПОЙ к переплате ноды: нода считала долг по сырому эталону без спреда и отдавала
  // 5,000 XMR там, где обещала 4,950 - приход был БОЛЬШЕ обещанного, и проверка молчала. Число, с которым
  // сверяем, - то же, что нода кладёт долгом в журнал (amount_xmr): оно идёт от той же ленты цен, что и
  // показанное человеку. Расхождение в ЛЮБУЮ сторону значит, что записанное и показанное - разные числа.
  if (seen + XMR_AMOUNT_EPS < expected) {
    return { ok: false, checked: true, expected, seen,
      why: "only " + seen + " XMR arrived, the quote promised " + expected + " XMR: ready is blocked - the escrow would pay out for less than agreed" };
  }
  if (seen > expected + XMR_AMOUNT_EPS) {
    return { ok: false, checked: true, expected, seen,
      why: seen + " XMR arrived, but the record promises " + expected + " XMR: the sum on the address does not match the quoted trade - ready is blocked until they agree (a node paying more than it quoted loses its spread)" };
  }
  return { ok: true, checked: true, expected, seen, why: null };
}

export function derive(swap, now = nowReal()) {
  const sim = simElapsed(swap, now);
  const t = swap.timeline;
  const ev = (type) => findEvent(swap, type);
  const readyEv = ev("ready");

  // Слепок Monero-ноги: в мок-режиме считается по sim-времени, в live - читается из последнего
  // опроса бэкенда. Дальше движок работает одинаково и не знает, откуда данные.
  const live = isLiveSource(swap.xmrSource);
  const xmr = xmrView(swap, sim);
  // ПРИХОД - ЭТО ВСЁ, ЧТО ВИДНО НА АДРЕСЕ (arrived), а не только разблокированное: запертое unlock_time
  // пришло, но потратить его нельзя - это отдельное состояние, которое называется ниже и не пускает «готово».
  const arrived = Number(xmr.arrived !== undefined && xmr.arrived !== null ? xmr.arrived : (xmr.received || 0));
  const lockAt = live ? (arrived > 0 ? 0 : null) : t.lockAtSim; // null => мейкер не лочит (сценарий maker_no_lock)
  const conf = xmr.confirmations;
  const lockDone = live ? arrived > 0 : lockAt !== null && sim >= lockAt;

  const readyAt = readyEv ? readyEv.atSim : null;
  // СРОКИ ИЗ ЦЕПИ - В НАСТОЯЩЕМ ВРЕМЕНИ: readyBy и t1 проставляет контракт, и они не имеют отношения ни к
  // ускоренному времени демонстрации, ни к симулятору.
  const chainReadyByMs = swap.escrow && swap.escrow.readyBy ? Number(swap.escrow.readyBy) * 1000 : null;
  const chainT1Ms = swap.escrow && swap.escrow.t1 ? Number(swap.escrow.t1) * 1000 : null;
  // ОКНО ПРОДАЖИ XMR (issue #111). Отсчёт идёт ОТ КОНТРАКТНОГО readyBy (это проставляют не мы и не симулятор),
  // а не от TIMING.readyWindow: тот живёт в ускоренном времени демонстрации и на живой сделке показал бы
  // демо-время. Мягкое обещание (600 с) продлевается до контрактного (1200 с), пока в пуле нет ПОЛНОЙ суммы, -
  // тем же правилом, что у ноды (sellWindowSec). Право на действие это НЕ меняет: отметку контракт принимает
  // до readyBy, а окно здесь - обещание на экране.
  const sellSeen = Number(xmr.arrived !== undefined && xmr.arrived !== null ? xmr.arrived : (xmr.received || 0)) > 0;
  const sellWindow = (() => {
    if (swap.side !== "reverse" || chainReadyByMs === null) return null;
    const startMs = chainReadyByMs - SELL_WINDOW.hardSec * 1000;      // начало окна = readyBy минус контрактный максимум
    const softAtMs = startMs + SELL_WINDOW.softSec * 1000;
    const windowSec = sellWindowSec({ poolSeen: sellSeen, soft: SELL_WINDOW.softSec, hard: SELL_WINDOW.hardSec });
    const extended = !sellSeen && nowReal() >= softAtMs;             // обещание продлено до контрактного окна
    const atMs = extended ? startMs + windowSec * 1000 : softAtMs;   // до продления счёт идёт до мягкого обещания
    return { startMs, atMs, leftMs: atMs - nowReal(), seen: sellSeen, extended,
      softSec: SELL_WINDOW.softSec, hardSec: SELL_WINDOW.hardSec, windowSec };
  })();
  const claimAt = readyAt !== null && swap.scenario !== "maker_stall" ? readyAt + TIMING.makerClaim : null;
  const sweptAt = claimAt !== null ? claimAt + TIMING.sweep : null;

  const readyDeadline = lockAt !== null ? lockAt + TIMING.readyWindow : null;
  const makerReclaimAt = readyDeadline !== null ? readyDeadline + TIMING.makerReclaim : null;
  const t1At = readyAt !== null ? readyAt + TIMING.t1Refund : null;

  // Сценарий «пользователь не подтвердил»: мейкер забирает XMR назад.
  const xmrReclaimed = readyAt === null && makerReclaimAt !== null && sim >= makerReclaimAt;

  // Доступные действия/дедлайны
  const can = { ready: false, sweep: false, refund: false };
  let phase = "xmr_locked";
  let phaseLabel = "Waiting";
  let refundAfterSim = null;
  let note = null;

  if (swap.settlement) {
    phase = swap.settlement.phase;
    phaseLabel = Object.values(TERMINAL).find((x) => x.phase === swap.settlement.phase)?.label || "Settled";
    // SWEEPING OUR OWN XMR AFTER A REFUND (issue #118, second half). On the reverse flow a refund leaves the
    // user's coins on the swap's one-time address: the claimer's ETH came back, and nobody moved the XMR. They can
    // only be taken by assembling the spend key from OUR half and the OTHER half that the chain revealed on
    // settlement. While the revealed half is missing we do NOT grant the right - can.sweep stays false precisely
    // so that the button cannot appear without a working action. The "arrived / expected" numbers are already
    // handed to the screen below (xmrAmount): only the right to sweep is decided here.
    if (swap.settlement.kind === "refund_eth" && swap.side === "reverse") {
      const revealed = refundHalfRevealed(swap);
      const stillOnAddress = arrived > 0;
      can.sweep = Boolean(revealed && stillOnAddress && halvesWalletOf(swap));
      // THE REASON IS NAMED, NOT HIDDEN: the screen must say what is missing, not merely omit the button.
      note = can.sweep
        ? "The refund published the provider's half, so your XMR can be swept back from the swap's one-time address to your own wallet."
        : (!stillOnAddress
          ? "The refund is done, but no XMR is on the swap's one-time address: there is nothing of yours to sweep back."
          : "The refund is done and your XMR is on the swap's one-time address, but the provider's half of the spend key is not published yet: sweeping needs both halves, so the button waits for the chain.");
    }
  } else if (live && readyAt === null && chainReadyByMs !== null && nowReal() >= chainReadyByMs
             && (chainT1Ms === null || nowReal() < chainT1Ms)) {
    // БЫЛА МЁРТВАЯ ЗОНА - СТАЛА ОТКРЫТАЯ ДВЕРЬ (решение 30.09.2026). Отметку внёсший уже не поставит, забор
    // без неё контракт запрещает, значит окно забора НЕ ОТКРЫЛОСЬ ВООБЩЕ - и возврат разрешён сразу после
    // readyBy (условие контракта: `block.timestamp < readyBy || (block.timestamp < t1 && ready)`). Он же
    // публикует половину внёсшего, поэтому мейкер забирает свои XMR, не дожидаясь t1. Это и есть ответ на
    // мёртвую зону: раньше деньги и половина ждали t1, а Monero-нога была недоступна обеим сторонам.
    phase = "dead_zone";
    phaseLabel = "Ready deadline passed - the refund is open";
    can.ready = false;
    can.refund = true;
    can.refundByAnyone = true;
    note = "The ready() deadline has passed without your confirmation, so the maker cannot claim - and the " +
      "refund is open NOW, not at T1. It returns your ETH and publishes your half, so the maker can reclaim " +
      "the XMR from Monero right away. " +
      (chainT1Ms !== null ? "T1 closes the order for good: " + new Date(chainT1Ms).toISOString() + "." : "");
  } else if (live && readyAt === null) {
    // Live-режим: состояния Monero-ноги приходят от бэкенда. Симулированные таймауты EVM-ноги
    // (T0/T1, watchtower) здесь намеренно НЕ показываем: контракта ещё нет, и кнопка «вернуть ETH»
    // была бы обманом. Пометка «EVM-нога - симуляция» висит в UI отдельно (derive().simulated).
    if (xmr.status === XMR_STATUS.LOCKED) {
      // ДЕНЬГИ НА АДРЕСЕ ЕСТЬ, НО ЗАПЕРТЫ unlock_time. Это НАЗВАННОЕ состояние, а не «ждём приход»: иначе
      // экран молчал бы, а сумма выглядела бы нулевой. Отметка готовности здесь невозможна - забор ETH под
      // запертые XMR отдал бы мейкеру ETH за деньги, которыми нельзя заплатить (issue #84).
      phase = "xmr_unlock_pending";
      phaseLabel = "XMR is on your address but locked on-chain";
      can.ready = false;
      const u = xmr.lockedUntil || {};
      const untilText = u.untilHeight !== null && u.untilHeight !== undefined
        ? "block " + u.untilHeight
        : (u.untilTime !== null && u.untilTime !== undefined
          ? new Date(Number(u.untilTime) * 1000).toISOString() + " UTC"
          : "a time the sender set");
      note = "The sender set the transaction's unlock_time: " + (xmr.locked || 0) +
        " XMR is on your address but cannot be spent until " + untilText +
        ". Ready stays closed until then - confirming now would let the maker take the ETH behind locked XMR.";
    } else if (!xmr.received) {
      phase = "maker_locking";
      phaseLabel = "Waiting for XMR to arrive";
      note = xmr.error
        ? "Backend unavailable: " + xmr.error
        : "The backend watches your swap address with the view key only - it cannot spend your XMR.";
    } else if (xmr.status === XMR_STATUS.READY) {
      phase = "xmr_locked";
      phaseLabel = "XMR received and confirmed (" + conf + "/" + t.confTarget + ")";
      // СУММА ПРОВЕРЯЕТСЯ ВМЕСТЕ С ГОТОВНОСТЬЮ. Бэкенд видит XMR по ключу просмотра и называет сумму, а
      // котировка обещала своё число: расхождение означает, что отметка отдала бы ETH дешевле договора.
      const paid = xmrAmountCheck(swap, xmr);
      can.ready = paid.ok;
      can.readyAmount = paid;
      note = paid.ok
        ? "Confirm that you see the XMR on your address (ready)."
        : paid.why;
    } else if (xmr.status === XMR_STATUS.SWEPT) {
      phase = "success";
      phaseLabel = "XMR delivered";
    } else {
      phase = "xmr_locked";
      phaseLabel = "XMR received, waiting for confirmations (" + conf + "/" + t.confTarget + ")";
      note = "About " + Math.max(1, Math.round(((t.confTarget - conf) * t.blockSim) / 60000)) + " min left of confirmations.";
    }
  } else if (lockAt === null) {
    // Мейкер не залочил XMR. После T0 пользователь может вернуть ETH сам.
    if (sim >= t.t0Sim) {
      phase = "refund_available";
      phaseLabel = "Maker did not lock XMR";
      refundAfterSim = t.t0Sim;
      can.refund = true;
      note = "The maker never locked XMR. You can take your ETH back from the escrow - no permission needed.";
    } else {
      phase = "maker_locking";
      phaseLabel = "Waiting for the maker to lock XMR";
      note = "If the maker does not lock XMR by T0, you get a refund button.";
    }
  } else if (!lockDone) {
    phase = "maker_locking";
    phaseLabel = "Maker is locking XMR";
  } else if (xmrReclaimed) {
    phase = "refund_available";
    phaseLabel = "XMR returned to the maker";
    refundAfterSim = makerReclaimAt;
    can.refund = true;
    note = "You did not confirm (ready) in time, so the maker took the XMR back. Your ETH is still in escrow - refund it.";
  } else if (readyAt === null) {
    phase = "xmr_locked";
    phaseLabel = conf < t.confTarget ? `Waiting for Monero confirmations (${conf}/${t.confTarget})` : "XMR locked and verified - waiting for you";
    can.ready = live ? xmr.status === XMR_STATUS.READY : conf >= t.confTarget;
    refundAfterSim = readyDeadline;
    note = conf < t.confTarget
      ? `About ${Math.max(1, Math.round(((t.confTarget - conf) * t.blockSim) / 60000))} min left of confirmations. You can close this tab.`
      : "Confirm that you see the lock with your view key (ready). Until you do, the maker keeps the XMR.";
  } else if (claimAt !== null && sim < claimAt) {
    phase = "ready_wait_claim";
    phaseLabel = "Waiting for the maker to claim ETH";
    note = "The maker claims the escrow and reveals the secret; your swap wallet uses it to sweep the XMR.";
  } else if (claimAt !== null && sim >= claimAt && sweptAt !== null && sim >= sweptAt) {
    phase = "success";
    phaseLabel = "XMR delivered";
    can.sweep = true;
  } else if (claimAt !== null) {
    phase = "claimed";
    phaseLabel = "Secret revealed - sweeping XMR";
    can.sweep = true;
  } else {
    // maker_stall: ready сделано, но claim не происходит
    phase = "refund_available";
    phaseLabel = "Maker did not claim in time";
    refundAfterSim = t1At;
    // ПРАВО НА ВОЗВРАТ ОПРЕДЕЛЯЕТ КОНТРАКТ, И ПРАВИЛО ЗАВИСИТ ОТ ВОЗРАСТА ОРДЕРА - так и надо, это не
    // ветвление ради ветвления. Новые ордера создаются с ОДНОЙ границей t1: до неё возврата нет ни у кого,
    // с неё - у кого угодно (решение 2026-09-16, док 26). У ордеров, созданных раньше, в записи лежит t0,
    // и у них правило прежнее: с t0 вернуть вправе только locker, с t1 - кто угодно. Роли и сроки в старых
    // ордерах неизменяемы, поэтому никакой миграции нет - они доживают свой срок по прежним правилам.
    // Сравнивать надо с настоящим временем и по срокам из записи, а не по времени симулятора (оно ускорено).
    const escrowT0 = swap.escrow && swap.escrow.t0 ? swap.escrow.t0 * 1000 : null;   // есть только у старых
    const chainT1 = swap.escrow && swap.escrow.t1 ? swap.escrow.t1 * 1000 : null;
    const realNow = nowReal();
    if (chainT1 !== null) {
      if (escrowT0 !== null) {
        can.refund = realNow >= escrowT0;                   // старый ордер: с t0, и только сам locker
        can.refundByAnyone = realNow >= chainT1;            // с t1 - кто угодно
      } else {
        // НОВЫЙ ОРДЕР: ГРАНИЦ ДВЕ, И ЭТО РЕШЕНИЕ 30.09.2026. С t1 - как было, возврат открыт всем. Но если
        // отметки `ready` нет, окно забора не открылось вовсе, и возврат открыт сразу после readyBy: иначе
        // мёртвая зона держала бы деньги и половину до t1. Отметку берём из ЗАПИСИ (`readyAt`) - её ставит сам
        // пользователь, и в этой ветке она пуста. Если запись потеряна, а на цепи отметка есть, контракт
        // откажет: честный отказ вместо обещания, которого мы не исполнили бы.
        const chainReadyBy = swap.escrow && swap.escrow.readyBy ? Number(swap.escrow.readyBy) * 1000 : null;
        const earlyRefund = chainReadyBy !== null && realNow >= chainReadyBy && readyAt === null;
        can.refund = realNow >= chainT1 || earlyRefund;
        can.refundByAnyone = can.refund;                    // и с t1 возврат открыт всем одновременно
        if (earlyRefund && realNow < chainT1) refundAfterSim = null;   // возврат уже открыт: отсчёта нет
      }
    } else if (!isLiveNetwork(swap)) {
      can.refund = sim >= t1At;                             // демо-сделка: как раньше, по симулятору
    } else {
      can.refund = false;                                   // живая сделка без прочитанных сроков: не обещаем
    }
    // ЧТО МОЖНО СДЕЛАТЬ СЕЙЧАС - БЕЗ ОБЕЩАНИЙ, КОТОРЫХ МЫ НЕ ИСПОЛНИМ. Сторож сейчас ручной вызов, а не
    // служба: он НЕ вернёт средства сам по себе. Поэтому говорим не "will be refunded automatically", а что
    // право появилось у кого угодно, включая сторожа, и кнопка по-прежнему работает.
    note = can.refund
      ? (can.refundByAnyone
        ? "The claim deadline passed: the refund is open to anyone who can present the half of the depositor - " +
          "that half is YOURS (it is in your recovery file), and the watchtower does not have it. " +
          "Press Refund my ETH, or restore the file if you have lost this tab."
        : "The maker missed the claim deadline. You can take your ETH back from the escrow yourself.")
      : (escrowT0 !== null
        ? "This order predates the one-deadline rule: you could refund from T0, and from T1 anyone can."
        : "Waiting for T1: before it the ETH can only be claimed with the secret. From T1 the claim closes and the refund opens - and it always pays you, never the caller.");
  }

  // Шаги для степпера
  const confDone = conf >= t.confTarget;
  const claimed = claimAt !== null && sim >= claimAt;
  const steps = [
    { key: "funded", done: true, atSim: 0 },
    { key: "maker_locking", done: lockDone, active: !lockDone && !swap.settlement && lockAt !== null, failed: lockAt === null && sim >= t.t0Sim, atSim: lockAt },
    { key: "xmr_locked", done: confDone && !xmrReclaimed, active: lockDone && !confDone, atSim: lockAt },
    { key: "ready", done: readyAt !== null, active: confDone && readyAt === null && !xmrReclaimed, atSim: readyAt },
    { key: "claimed", done: claimed, active: readyAt !== null && !claimed, atSim: claimAt },
    { key: "swept", done: !!swap.settlement && swap.settlement.kind === "success", active: claimed && !swap.settlement, atSim: swappedAtOrNull(swap) },
  ];

  return {
    swap,
    sim,
    simWallTime: simWall(swap, sim),
    phase,
    phaseLabel,
    note,
    conf,
    confTarget: t.confTarget,
    confProgress: t.confTarget ? conf / t.confTarget : 0,
    // СРОКИ ДЛЯ ПОКАЗА БЕРУТСЯ ИЗ ТОГО ЖЕ ИСТОЧНИКА, ЧТО И ПРАВО НА ВОЗВРАТ - ИЗ ЗАПИСИ О СДЕЛКЕ.
    // Здесь стояло simWall(swap, t.t0Sim): это время ДЕМО-СИМУЛЯТОРА (ускоренного в 60 раз), к живой сделке
    // отношения не имеющее. Из-за этого получалось противоречие на одном экране: can.refund считался по
    // НАСТОЯЩЕМУ сроку из escrow (и говорил "ещё нельзя"), а таймер кнопки и строка "T0 (refund if no XMR
    // lock)" показывали симулированный (и говорили "available now" и "in 00:00").
    // Два показателя одного и того же события обязаны считаться из одной величины: иначе экран противоречит
    // сам себе, и человек не знает, какому сроку верить.
    // Для ЖИВОЙ сделки сроки контрактные (те же, что у can.refund выше), для демонстрационной - из симулятора.
    deadlines: {
      // t0 ЕСТЬ ТОЛЬКО У СТАРЫХ ОРДЕРОВ. У новых граница одна, и для живой сделки без t0 честнее показать
      // ничего (null), чем выдуманное число: строка T0 на экране по этому признаку и не рисуется.
      // В демонстрационном режиме срок берётся из симулятора - там своё время, и оно осознанно ускорено.
      t0: swap.escrow && swap.escrow.t0 ? swap.escrow.t0 * 1000 : (swap.escrow ? null : simWall(swap, t.t0Sim)),
      t0Sim: t.t0Sim,
      lockAtSim: lockAt,
      readyBy: readyDeadline !== null ? simWall(swap, readyDeadline) : null,
      readyBySim: readyDeadline,
      t1: swap.escrow && swap.escrow.t1 ? swap.escrow.t1 * 1000 : (t1At !== null ? simWall(swap, t1At) : null),
      t1Sim: t1At,
      refundAfterSim,
      refundAfterWall: refundAfterSim !== null ? simWall(swap, refundAfterSim) : null,
    },
    refundLeftSim: refundAfterSim !== null ? refundAfterSim - sim : null,
    // Данные Monero-ноги для экрана: статус, адрес, txid и ссылка в обозревателе.
    xmr: {
      live: xmr.live,
      source: swap.xmrSource,
      status: xmr.status,
      received: xmr.received,
      // Запертое unlock_time и всё, что видно на адресе: экран показывает причину и границу.
      locked: xmr.locked || 0,
      lockedUntil: xmr.lockedUntil || null,
      arrived: Number(xmr.arrived !== undefined && xmr.arrived !== null ? xmr.arrived : (xmr.received || 0)),
      confirmations: xmr.confirmations,
      confTarget: xmr.confTarget,
      txids: xmr.txids,
      address: xmr.address,
      explorer: explorerXmrTx(xmr.txids[0], (swap.xmrSession && swap.xmrSession.network) || "stagenet"),
      error: xmr.error,
      sweepTxid: xmr.sweepTxid,
    },
    // Что сейчас настоящее, а что симуляция. UI обязан показывать это, а не угадывать.
    // EVM-нога симулирована тогда и только тогда, когда сеть сделки не переведена в live. Раньше здесь стояло
    // жёсткое true, и на ЖИВОЙ сделке с настоящим эскроу экран писал "EVM leg ... is still simulated" - то есть
    // врал, хотя ордер существовал в контракте. Признак берём из настроек сети, а не из поля в сделке: поле
    // проставляется при создании, и у сделок, заведённых раньше, там осталось "mock".
    simulated: { evm: !isLiveNetwork(swap), xmr: !xmr.live },
    can,
    // СКОЛЬКО ЖДАТЬ ДО ГРАНИЦЫ ОТМЕТКИ и не подошла ли она: граница есть, отметки нет. Предупреждение за
    // SIGNING_GUARDS.minReadyLeadSec секунд до неё - потому что после границы не работает НИ ОДНА кнопка.
    readyDeadline: {
      atMs: chainReadyByMs,
      soonMs: chainReadyByMs !== null && readyAt === null ? chainReadyByMs - nowReal() : null,
      soon: chainReadyByMs !== null && readyAt === null
        && chainReadyByMs - nowReal() > 0
        && chainReadyByMs - nowReal() <= Number(SIGNING_GUARDS.readyLeadWarnSec || 0) * 1000,
    },
    // ОБЕ СУММЫ НАРУЖУ: обещанная котировкой и увиденная на адресе. Экран обязан показать обе, а не одну.
    xmrAmount: { expected: (() => { const e = Number(swap.xmrAmount); return Number.isFinite(e) && e > 0 ? e : null; })(),
                 seen: xmr.received !== null && xmr.received !== undefined ? Number(xmr.received) : null },
    steps,
    // ОКНО ПРОДАЖИ: адрес уже в xmr.address, здесь - отсчёт и его границы (issue #111). null у прямого потока.
    sellWindow,
    terminal: swap.settlement,
    xmrReclaimed,
  };
}

function swappedAtOrNull(swap) {
  return swap.settlement && swap.settlement.kind === "success" ? swap.settlement.atSim : null;
}

// ---------------------------------------------------------------------------
// Тикер: завершает сделки, которые должны завершиться без пользователя
// (авто-sweep и watchtower), и рассылает подписчикам изменения.
// ---------------------------------------------------------------------------

let timer = null;
const listeners = new Set();
const notified = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error(e); }
  }
}

// --- live-режим: сессия свопа на бэкенде -----------------------------------------------
//
// Опрос идёт без ожидания: тикер экрана не должен ждать сеть, иначе при недоступном бэкенде демка
// начнёт тормозить. Результат кладём в сам своп (xmrSession / xmrSessionError), а derive() читает
// его как обычное состояние - она остаётся чистой функцией.
const liveInFlight = new Set();

function applyLive(id, patch) {
  const s = loadState();
  if (!s.swaps[id]) return;
  Object.assign(s.swaps[id], patch);
  saveState(s);
}

// Время последней ПОПЫТКИ обращения к бэкенду по каждому свопу. Именно попытки, а не успеха: ограничение
// частоты должно работать и когда запрос падает.
const liveLastTry = new Map();


// КЛЮЧ СДЕЛКИ: СТРАНИЦА И ПРИЛОЖЕНИЕ НАЗЫВАЮТ ЕЁ ПО-РАЗНОМУ. У страницы свой id (живёт в браузере), у
// приложения - свой (localtest-...): id задаёт приложение, когда заводит запись наблюдения. Состояние XMR
// страница спрашивала по СВОЕМУ id, приложение такого не знает и отвечает отказом. Снаружи это выглядит
// так: XMR пришли, подтверждений десяток, а экран сделки показывает прежнее состояние, кнопка отметки
// готовности не открывается - и окно сделки закрывается впустую (проверено живым прогоном).
// СВЯЗЫВАЕМ ПО АДРЕСУ MONERO: страница и так сообщает его приложению при заведении наблюдения, значит по
// нему и находит свою запись, а дальше спрашивает состояние по её id. Правок в приложении не требуется.
// ВСЕ ЗАПИСИ ОДНОЙ СДЕЛКИ В БРАУЗЕРЕ. Их две (обмен и эскроу), и следить нужно за сделкой, а не за той записью,
// на которую случайно попал экран: у записи эскроу нет суммы ожидания XMR, поэтому её сессия не заводится, и
// состояние до экрана не доходит. Связь - общий адрес Monero, он один на сделку.
export function dealSwapIds(swap) {
  const ids = new Set([String((swap && swap.id) || "")].filter(Boolean));
  const w0 = (() => { try { return halvesWalletOf(swap) || {}; } catch { return {}; } })();
  const address = w0.address || (swap && swap.escrow && swap.escrow.moneroAddress) || null;
  if (!address) return [...ids];
  for (const other of Object.values((loadState() || {}).swaps || {})) {
    if (!other || !other.id) continue;
    const w = (() => { try { return halvesWalletOf(other) || {}; } catch { return {}; } })();
    if (w.address === address) ids.add(String(other.id));
  }
  return [...ids];
}

const serverIdByAddress = new Map();

// ФАКТЫ СДЕЛКИ ИЩЕМ ПО ВСЕМ ЕЁ ЗАПИСЯМ В БРАУЗЕРЕ. Об одной сделке страница держит ДВЕ записи: одну завёл
// обмен (адрес Monero, сумма ожидания XMR), другую - эскроу (половины, адрес эскроу). Экран, открытый по
// записи эскроу, не знал суммы ожидания, сессия не заводилась вовсе, и кнопка готовности не включалась -
// при том что приложение готовность уже отдавало. Записи связаны ОБЩИМ адресом Monero: он один на сделку.
function dealFactsFor(swap) {
  const w0 = (() => { try { return halvesWalletOf(swap) || {}; } catch { return {}; } })();
  let address = w0.address || (swap && swap.escrow && swap.escrow.moneroAddress) || (swap && swap.xmrSession && swap.xmrSession.address) || null;
  let amountXmr = Number(swap && swap.xmrAmount) > 0 ? Number(swap.xmrAmount) : null;
  let source = "своя запись";
  if (address && amountXmr === null) {
    for (const other of Object.values((loadState() || {}).swaps || {})) {
      if (!other || other === swap) continue;
      const w = (() => { try { return halvesWalletOf(other) || {}; } catch { return {}; } })();
      if (!w.address || w.address !== address) continue;
      if (Number(other.xmrAmount) > 0) { amountXmr = Number(other.xmrAmount); source = "другая запись той же сделки (" + String(other.id || "?") + ")"; break; }
    }
  }
  if (!address) {
    for (const other of Object.values((loadState() || {}).swaps || {})) {
      const w = (() => { try { return halvesWalletOf(other) || {}; } catch { return {}; } })();
      if (w.address && Number(other.xmrAmount) > 0) { address = w.address; amountXmr = amountXmr || Number(other.xmrAmount); source = "другая запись той же сделки"; break; }
    }
  }
  return { address, amountXmr, source };
}

// АДРЕС СДЕЛКИ БЕРЁМ ОТОВСЮДУ, ГДЕ ОН МОЖЕТ ЛЕЖАТЬ. Сделка в браузере и запись наблюдения в приложении - это
// РАЗНЫЕ записи об одной сделке (страница заводит свою на эскроу, приложение - на наблюдение за адресом),
// поэтому у записи страницы адрес есть не всегда: у записи эскроу он лежит в половинах, а не в поле
// escrow.moneroAddress. Живой прогон из-за этого опрашивал мёртвый id, получал 404 и оставлял кнопку
// готовности выключенной. Вынесено отдельно, чтобы этим же адресом пользовался поиск высоты у сервера.
function dealMoneroAddress(swap) {
  const fromHalves = (() => { try { return (halvesWalletOf(swap) || {}).address || null; } catch { return null; } })();
  return (swap && swap.escrow && swap.escrow.moneroAddress)
    || (swap && swap.xmrSession && swap.xmrSession.address)
    || (swap && swap.swapWallet && swap.swapWallet.address)
    || fromHalves
    || null;
}

// ВЫСОТА СКАНА, КОТОРУЮ ЗНАЕТ ПРИЛОЖЕНИЕ. Нужна файлам СТАРЫХ сделок: в их записи нет birthHeight (поле
// появилось позже), а высоту при регистрации наблюдения приложение разрешило само и хранит. Источник наш,
// поэтому от чужой ноды Monero не зависит. Сервер молчит - возвращаем null, и вызывающий остаётся на
// прежнем поведении: высота берётся из других источников или файл честно предупреждает о её отсутствии.
export async function serverRestoreHeightFor(swap, { attempts = 3, pauseMs = 1200 } = {}) {
  const addr = dealMoneroAddress(swap);
  if (!addr) return null;
  // НЕ ОДНА ПОПЫТКА. Строка наблюдения появляется у приложения в тот же миг, что и эскроу, и файл может
  // быть выпущен на волосок раньше: тогда запасной источник молчит, а в файл ложится null - и высоту взять
  // больше негде, файл уже у владельца. Несколько коротких попыток закрывают этот зазор, а не превращают
  // его в пустое поле; цена - доли секунды в редком случае, когда строки нет вовсе.
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch("/api/swaps", { headers: { accept: "application/json" } });
      if (r.ok) {
        const j = await r.json();
        const rows = Array.isArray(j) ? j : (j.swaps || []);
        const row = rows.find((x) => String((x && x.address) || "") === String(addr));
        const h = Number(row && row.restoreHeight);
        if (Number.isFinite(h) && h > 0) return h;
      }
    } catch {
      /* попробуем ещё раз: сервис мог быть занят первым обращением */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return null;
}

async function resolveServerSwapId(swap) {
  const addr = dealMoneroAddress(swap);
  if (!addr) return null;
  if (serverIdByAddress.has(addr)) return serverIdByAddress.get(addr);
  try {
    const r = await fetch("/api/swaps", { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.swaps || []);
    const row = rows.find((x) => String((x && x.address) || "") === String(addr));
    if (!row || !row.id) return null;
    serverIdByAddress.set(addr, String(row.id));
    return String(row.id);
  } catch {
    return null;   // сервер молчит - остаёмся на прежнем поведении, экран не ждёт сеть
  }
}

function refreshLiveSession(id) {
  if (liveInFlight.has(id)) return;
  // Не чаще одного раза в pollMs на своп, НЕЗАВИСИМО от того, сохранилась ли сессия. Раньше ограничение
  // стояло только в ветке "сессия уже есть": если запрос падал (429 от прокси, 502 от таймаута), сессия
  // не сохранялась, ограничение не применялось - и тик повторял запрос каждые 5 секунд по КАЖДОМУ свопу.
  // При накопившихся восьми свопах это давало поток 429: приложение боролось само с собой.
  const now = Date.now();
  const lastTry = liveLastTry.get(id) || 0;
  if (now - lastTry < pollInterval()) return;
  liveLastTry.set(id, now);
  liveInFlight.add(id);
  (async () => {
    try {
      const fresh = loadState().swaps[id];
      if (!fresh || fresh.settlement) return;
      if (!fresh.xmrSession) {
        // Кошелёк свопа создан в браузере; наружу уходят только адрес и view key (см. chainSource).
        // СУММА ОЖИДАНИЯ ОБЯЗАТЕЛЬНА. Без неё сессию не заводим вовсе: кошелёк тот же, что у экрана
        // подтверждения, поэтому адрес уже под наблюдением. Иначе на тот же адрес появлялась бы вторая
        // правда об одной сделке, а запись без суммы пропускала бы недоплату. Как только сумма появится,
        // следующий тик заведёт сессию сам.
        const facts = dealFactsFor(fresh);
        const amountXmr = facts.amountXmr;
        if (!Number.isFinite(amountXmr) || amountXmr <= 0) {
          pushLog(fresh, simElapsed(fresh), "Backend session not opened yet: amount of XMR is unknown", String((fresh && fresh.xmrAmount) ?? "нет"));
          return;
        }
        if (facts.source !== "своя запись") {
          pushLog(fresh, simElapsed(fresh), "Amount of XMR taken from the deal's other record", facts.source + ", " + String(amountXmr));
        }
        const share = watchOnlyShareFromWallet({ swapId: fresh.id, wallet: fresh.swapWallet });
        const opened = await openSession({
          swapId: fresh.id,
          share,
          expectedAmountXmr: amountXmr,
          chain: fresh.network,
        });
        if (opened.ok) {
          applyLive(id, { xmrSession: opened.session, xmrSessionError: null });
          const s2 = loadState();
          if (s2.swaps[id]) {
            pushLog(s2.swaps[id], simElapsed(s2.swaps[id]), "Backend session opened (watch-only: address + view key)", opened.session.address || "");
            saveState(s2);
          }
        } else {
          applyLive(id, { xmrSessionError: opened.error });
        }
      } else if (Date.now() - (fresh.xmrSession.at || 0) >= pollInterval()) {
        // СПРАШИВАЕМ ПО ID ПРИЛОЖЕНИЯ, а не по своему: см. resolveServerSwapId. Если запись не нашлась, НЕ
        // спрашиваем по своему id - приложение ответит 404, и экран будет молча ждать вечно. Вместо этого
        // заводим наблюдение заново: приложение само связывает его по адресу с уже существующей записью и
        // возвращает её же, а не вторую правду об одной сделке.
        const serverId = await resolveServerSwapId(fresh);
        const polled = await fetchSession(serverId || id);
        if (polled.ok) {
          applyLive(id, { xmrSession: polled.session, xmrSessionError: null });
        } else if (!serverId) {
          const share = watchOnlyShareFromWallet({ swapId: fresh.id, wallet: fresh.swapWallet });
          const again = await openSession({
            swapId: fresh.id, share, expectedAmountXmr: Number(fresh.xmrAmount), chain: fresh.network,
          });
          if (again.ok) {
            applyLive(id, { xmrSession: again.session, xmrSessionError: null });
            const s3 = loadState();
            if (s3.swaps[id]) { pushLog(s3.swaps[id], simElapsed(s3.swaps[id]), "Backend record re-linked by the Monero address", again.session.address || ""); saveState(s3); }
          } else {
            applyLive(id, { xmrSessionError: again.error });
          }
        } else {
          applyLive(id, { xmrSessionError: polled.error });
        }
      }
    } catch (e) {
      applyLive(id, { xmrSessionError: "сессия не открылась: " + e.message });
    } finally {
      liveInFlight.delete(id);
    }
  })();
}

// Сделки, которые сейчас открыты на экране. Ядро опрашивает бэкенд ТОЛЬКО по ним.
//
// Зачем: раньше tick опрашивал все незавершённые сделки без разбора. После нескольких нажатий кнопки
// подписи их накопилось восемь, и приложение само заваливало прокси запросами - приходил 429. При этом
// на главной странице нечего отслеживать вообще: там ещё нет сделки.
//
// Пустой набор (по умолчанию) означает "не опрашивать ничего". Экраны, которым слежение нужно, сообщают
// свой набор сами: список сделок - все незавершённые, экран сделки - одну.
let liveFocusIds = new Set();

export function setLiveFocus(ids) {
  liveFocusIds = new Set(Array.isArray(ids) ? ids.map(String) : []);
  return liveFocusIds.size;
}

export function tick() {
  const s = loadState();
  let changed = false;

  for (const swap of Object.values(s.swaps)) {
    if (swap.settlement) continue;

    // Live-режим: сессия на бэкенде. Заводим при первом тике после создания свопа и дальше
    // опрашиваем не чаще API.pollMs. Не await: экран не должен ждать сеть.
    // Опрашиваем только то, что открыто на экране.
    if (isLiveSource(swap.xmrSource) && liveFocusIds.has(String(swap.id))) refreshLiveSession(swap.id);

    const view = derive(swap);

    // мейкер лочит XMR на совместном одноразовом адресе (кроме сценария maker_no_lock)
    if (!isLiveSource(swap.xmrSource) && !swap.xmr && view.deadlines.lockAtSim !== null && view.sim >= view.deadlines.lockAtSim) {
      const lock = chain.lockXmr({ swapId: swap.id, xmrAmount: swap.xmrAmount });
      swap.xmr = { ...lock, reclaimed: false, sweepTxid: null };

      // В режиме live фиксируем реальную высоту нода на момент лока: по ней считаются
      // подтверждения (блок Monero ~2 минуты, поэтому сделка идёт по-настоящему ~20 минут).
      if (swap.chainMode === "live") {
        const snap = node.snapshot();
        swap.xmr.lockHeight = snap ? snap.height : null;
        if (!swap.xmr.lockHeight) {
          node.getInfo({ force: true }).then((info) => {
            if (info && !swap.settlement) {
              const s2 = loadState();
              if (s2.swaps[swap.id]) {
                s2.swaps[swap.id].xmr.lockHeight = info.height;
                saveState(s2);
              }
            }
          });
        }
      }

      pushLog(swap, view.sim, "Maker locked XMR on the shared address", lock.txid);
      const key = swap.id + ":lock";
      if (!notified.has(key)) { notified.add(key); notify(swap.xmrAmount.toFixed(4) + " XMR locked; view key verified", "ok"); }
      changed = true;
    }

    // Live-режим: первый замеченный приход XMR превращаем в запись swap.xmr с НАСТОЯЩИМ txid,
    // чтобы остальной код (логи, шаги, экраны) работал с ним так же, как с моковым локом.
    if (isLiveSource(swap.xmrSource) && !swap.xmr && view.xmr && view.xmr.received > 0) {
      swap.xmr = {
        mock: false,
        txid: view.xmr.txids[0] || null,
        address: view.xmr.address,
        amount: view.xmr.received,
        confirmations: view.xmr.confirmations,
        status: view.xmr.status,
        explorer: view.xmr.explorer,
        reclaimed: false,
        sweepTxid: null,
      };
      pushLog(swap, view.sim, "XMR received (backend, " + ((swap.xmrSession && swap.xmrSession.network) || "stagenet") + ")", swap.xmr.txid || "");
      const key = swap.id + ":xmr-in";
      if (!notified.has(key)) {
        notified.add(key);
        notify(view.xmr.received.toFixed(6) + " XMR received; confirmations " + view.xmr.confirmations + "/" + view.xmr.confTarget, "ok");
      }
      changed = true;
    }

    // Live-режим: факт вывода подтверждает страница sweep (watch-only кошелёк исходящие переводы
    // видеть не может), поэтому финальное состояние берём из статуса сессии, а хеш - не выдумываем.
    if (isLiveSource(swap.xmrSource) && swap.xmrSession && swap.xmrSession.status === XMR_STATUS.SWEPT && !swap.settlement) {
      const atSim = view.sim;
      swap.settlement = {
        kind: "success",
        phase: TERMINAL.success.phase,
        atSim,
        txid: swap.xmrSession.sweepTxid || null,
        by: "your sweep wallet",
      };
      pushLog(swap, atSim, "XMR swept by you (backend reported)", swap.settlement.txid || "");
      const key = swap.id + ":success";
      if (!notified.has(key)) {
        notified.add(key);
        notify("Swap " + swap.id + " complete: XMR is on your address", "ok");
      }
      changed = true;
      continue;
    }

    // happy path: после claim пользовательский кошелёк сам сметает XMR (litepaper §4.2)
    if (!isLiveSource(swap.xmrSource) && view.can.sweep && view.phase === "success") {
      const atSim = view.sim;
      swap.xmr.sweepTxid = chain.sweepXmr({ swapId: swap.id }).txid;
      swap.settlement = { kind: "success", phase: TERMINAL.success.phase, atSim, txid: swap.xmr.sweepTxid, by: "your swap wallet" };
      pushLog(swap, atSim, "XMR swept to your address", swap.xmr.sweepTxid);
      const key = swap.id + ":success";
      if (!notified.has(key)) { notified.add(key); notify("Swap " + swap.id + " complete: XMR is on your address", "ok"); }
      changed = true;
      continue;
    }

    // watchtower: если пользователь ушёл, а деньги можно вернуть - возвращает он
    if (!isLiveSource(swap.xmrSource) && view.can.refund && view.refundLeftSim !== null && view.refundLeftSim <= -TIMING.watchtowerGrace) {
      const atSim = view.sim;
      const tx = chain.refundEscrow({ swapId: swap.id, by: "watchtower" });
      swap.settlement = { kind: "refund_eth", phase: TERMINAL.refunded_eth.phase, atSim, txHash: tx.txHash, by: "watchtower" };
      pushLog(swap, atSim, "Watchtower refunded your ETH", tx.txHash);
      const key = swap.id + ":refund";
      if (!notified.has(key)) { notified.add(key); notify("Watchtower refunded the ETH escrow of swap " + swap.id, "bad"); }
      changed = true;
      continue;
    }

    // сценарий «пользователь не подтвердил»: мейкер забирает XMR
    if (!isLiveSource(swap.xmrSource) && swap.xmr && view.xmrReclaimed && !swap.xmr.reclaimed) {
      swap.xmr.reclaimed = true;
      pushLog(swap, view.sim, "Maker reclaimed the XMR", swap.xmr.txid);
      const key = swap.id + ":reclaim";
      if (!notified.has(key)) { notified.add(key); notify("Maker took the XMR back: no ready() call in time", "bad"); }
      changed = true;
    }
  }

  if (changed) {
    saveState(s);
  }
}

const notifier = { fn: null };
export function onNotify(fn) {
  notifier.fn = fn;
}
function notify(msg, kind) {
  if (notifier.fn) notifier.fn(msg, kind);
}

export function startTicker(intervalMs = 400) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    try { tick(); } catch (e) { console.error(e); }
    emit(); // экран перерисовывается каждый тик: подтверждения и таймеры идут живьём
  }, intervalMs);
}



