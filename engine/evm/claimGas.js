// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/claimGas.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ГАЗ ЗАБОРА ПРИ ПРОДАЖЕ XMR (claim): ОДИН ИСТОЧНИК ПРАВДЫ ДЛЯ КЛИЕНТА И ДЛЯ НОДЫ (issue #127).
//
// СУТЬ. В обратном обмене человек отдаёт XMR и забирает ETH вызовом `claim` в сети расчёта. Своего ETH у
// него нет, поэтому газ на claim ПРИСЫЛАЕТ НОДА (issue #78, rfq/reverseGas.mjs). Но правила газа жили в
// ДВУХ местах: страница/SDK отправляли claim с пределом 250 000 и комиссией `2 x baseFee + 1 gwei`
// (движок сделки теперь в пакете: sdk/src/swap-flow.mjs; www/js/evm/session.js), а нода считала подарок как `eth_gasPrice x 120 000`
// (rfq/reverseGas.mjs). Числа расходились примерно в 100 раз, и человек с одним подарком claim отправить
// не мог: узел принимает транзакцию, только если на балансе есть `gasLimit x maxFeePerGas`, а подарка на
// это не хватало. Теперь оба числа считает ЭТОТ модуль.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ И ПОЧЕМУ ПОД www/js. Формула обязана быть ОДНА. Её читает и страница/SDK
// (движок живёт под www/js), и нода - rfq/reverseGas.mjs, а rfq уже импортирует из www/js (см.
// rfq/payoutFee.mjs, `../www/js/core/format.js`). Обратный импорт невозможен: боевой веб-корень - www/,
// каталог rfq/ браузеру не отдаётся. Поэтому единственный общий дом - www/js/evm/.
//
// ЧТО ЗДЕСЬ ОДНО. Предел газа claim, правило комиссии (2 x baseFee + чаевые) и РАЗМЕР ПОДАРКА - та же
// стоимость claim плюс ЯВНЫЙ ЗАПАС на рост базовой цены между выдачей билета и забором. Второго расчёта
// размера подарка нет ни у ноды, ни у прогонов: они зовут claimGasGiftWei отсюда.

// ПРЕДЕЛ ГАЗА CLAIM - ОДНО ЧИСЛО НА ОБЕИХ СТОРОНАХ. Это тот же предел, с которым нода подписывает свой
// claim в rfq/payout.mjs, и тот же, что отправляет страница/SDK (sdk/src/swap-flow.mjs). Число не
// выдумано: живой прогон меряет фактический gasUsed забора сверху (tools/live-gas-run.mjs).
export const CLAIM_GAS_LIMIT = 120_000n;

// ПОЛ ЧАЕВЫХ - ПОЛИТИКА СЕТИ, А НЕ КОНСТАНТА В КОДЕ ОТПРАВКИ. Раньше session.js ставил минимум 1 gwei
// ВСЕГДА. На сети с дешёвым газом (Arbitrum One: baseFee ~0.02 gwei) это раздувало maxFeePerGas примерно
// в 50 раз и поднимало ТРЕБУЕМЫЙ БАЛАНС пропорционально - то есть ломало ровно того, кому газ и
// предназначен. Для Arbitrum чаевые не нужны: пол 0. Сеть со своей политикой передаёт minTipWei
// аргументом (session.js берёт сеть из реестра, www/js/core/config.js).
export const CLAIM_TIP_FLOOR_WEI = 0n;

const toBig = (v) => {
  if (v === null || v === undefined || v === "") return null;
  try { return BigInt(typeof v === "bigint" ? v : String(v)); } catch { return null; }
};

// КОМИССИЯ ЗАБОРА (EIP-1559): `maxFeePerGas = 2 x baseFee + чаевые`. Удвоение базовой цены перекрывает её
// рост за время подтверждения СВОЕЙ транзакции; чаевые - это разница gasPrice - baseFee (её отдаёт любая
// цепь), не ниже пола сети. baseFee = 0 (сеть без EIP-1559) - полей комиссии нет вовсе, и это null, а не
// ноль: неизвестное обязано называться, а не выдаваться за измеренное.
export function claimMaxFeePerGasWei({ baseFeeWei, priorityFeeWei = 0n, minTipWei = CLAIM_TIP_FLOOR_WEI } = {}) {
  const base = toBig(baseFeeWei);
  if (base === null || base <= 0n) return null;
  const prio = toBig(priorityFeeWei);
  const floor = toBig(minTipWei);
  const floored = floor === null || floor < 0n ? 0n : floor;
  const tip = prio !== null && prio > floored ? prio : floored;
  return base * 2n + tip;
}

// СКОЛЬКО НУЖНО НА БАЛАНСЕ ДЛЯ CLAIM - это же правило приёма транзакции узлом: `gasLimit x maxFeePerGas`.
// Один из множителей не измерен - null (не «ноль газа»).
export function claimRequiredWei({ gasLimit = CLAIM_GAS_LIMIT, maxFeePerGasWei } = {}) {
  const limit = toBig(gasLimit);
  const maxFee = toBig(maxFeePerGasWei);
  if (limit === null || limit <= 0n || maxFee === null || maxFee <= 0n) return null;
  return limit * maxFee;
}

// ЗАПАС НА РОСТ БАЗОВОЙ ЦЕНЫ МЕЖДУ ВЫДАЧЕЙ БИЛЕТА И ЗАБОРОМ, в базисных пунктах (10 000 = +100%).
//
// ПОЧЕМУ ОН НУЖЕН И ПОЧЕМУ СТОЛЬКО. Стоимость claim считается на момент БИЛЕТА, а сам claim случается
// позже: билет живёт RFQ_ORDER_QUOTE_TTL_MS, по умолчанию 40 минут (rfq/config.mjs). Правило клиента
// (2 x baseFee) перекрывает рост цены ТОЛЬКО на время подтверждения своей транзакции, а не эти 40 минут.
// Подарок без запаса не проходит, если базовая цена хоть немного поднялась с момента билета - это и
// показал issue #127. +100% перекрывает УДВОЕНИЕ базовой цены за окно билета, то есть подарок остаётся
// достаточным, даже если цена газа к забору вырастет вдвое. Значение - настройка ноды
// (RFQ_REVERSE_GAS_RESERVE_BPS), а не догадка: её видно и можно переопределить без правки кода.
export const DEFAULT_GIFT_RESERVE_BPS = 10_000n;

// РАЗМЕР ПОДАРКА - ТА ЖЕ стоимость claim, что требует клиент, ПЛЮС запас. Это ЕДИНСТВЕННЫЙ расчёт размера
// подарка: нода (rfq/reverseGas.mjs, requiredGasWei) и живой прогон зовут ИМЕННО ЕГО, а не свою копию.
// base берётся у цепи на момент билета; priorityFeeWei - реальные чаевые сети (gasPrice - baseFee), если
// известны. Нечитаемая база - null, а не ноль.
export function claimGasGiftWei({ baseFeeWei, priorityFeeWei, minTipWei, gasLimit = CLAIM_GAS_LIMIT, reserveBps = DEFAULT_GIFT_RESERVE_BPS } = {}) {
  const maxFee = claimMaxFeePerGasWei({ baseFeeWei, priorityFeeWei, minTipWei });
  const need = claimRequiredWei({ gasLimit, maxFeePerGasWei: maxFee });
  if (need === null) return null;
  const bps = toBig(reserveBps);
  const step = bps === null || bps < 0n ? 0n : bps;
  return need + (need * step) / 10_000n;
}
