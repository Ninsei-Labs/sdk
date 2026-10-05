// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/gasReserve.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ЗАПАС ГАЗА ПОКУПАТЕЛЯ НА ДЕЙСТВИЯ ОРДЕРА (issue #97, часть B): ОТМЕТКА ГОТОВНОСТИ И ВОЗМОЖНЫЙ ВОЗВРАТ.
//
// СУТЬ. В прямом обмене человек вносит средства в эскроу, а после прихода XMR сам зовёт markReady (когда XMR
// подтверждены) либо refund (когда сделка не состоялась). Оба вызова стоят газа в НАТИВНОЙ монете сети, и у
// человека, пришедшего из USDC, своего натива нет. Поэтому ДО котировки решается, СКОЛЬКО НАТИВА ОСТАВИТЬ под
// эти два вызова; решение показывается и в ETH, и в долларах, а строкой входит в разбивку цены.
//
// ПОЧЕМУ ЧИСТЫЕ ФУНКЦИИ. Решение стоит денег и обязано проверяться без сети (tools/check-buy-gas-reserve.mjs)
// и считаться ОДНИМ И ТЕМ ЖЕ кодом на экране и в прогоне. Сеть касается только чтения цены газа - его
// подставляет вызывающий (www/js/evm/prices.js кладёт gasPriceWei в живые цены, экран передаёт его сюда).
//
// ЧИСЛА НЕ ВЫДУМАНЫ. Пределы газа - те же, с которыми НАШ ЖЕ код отправляет обе транзакции
// (движок сделки теперь в пакете: sdk/src/swap-flow.mjs - markReadyOrder - gas 120000, refundOrder - gas 250000). Проверка
// tools/check-buy-gas-reserve.mjs сверяет обе константы со строками того файла, поэтому правка одного места
// без другого краснит прогон - ровно так же, как это сделано для газа забора в rfq/reverseGas.mjs.
//
// ПОЧЕМУ ЗАПАС ФИКСИРУЕТСЯ ДО КОТИРОВКИ. `amount` ордера входит в ПОДПИСАННУЮ котировку, и решение о запасе
// меняет итоговую сумму взноса; значит оно принимается ДО запроса котировки и дальше не пересчитывается.
// Экран кладёт готовый план в состояние формы (www/js/ui/views/swapForm.js), а экран подписи пользуется тем
// же зафиксированным планом - второй пересчёт разошёлся бы с первым.

// ПРЕДЕЛЫ ГАЗА - ИЗ НАШЕГО ЖЕ КОДА. Строки-источники: sdk/src/swap-flow.mjs (gas: 120_000n у отметки и
// gas: 250_000n у возврата). Заниженный предел - это отказ уже после раскрытия половины; неиспользованный
// газ в лимите не списывается, поэтому запас берётся с запасом.
export const ORDER_READY_GAS_LIMIT = 120_000n;   // markReady - sdk/src/swap-flow.mjs markReadyOrder
export const ORDER_REFUND_GAS_LIMIT = 250_000n;  // refund   - sdk/src/swap-flow.mjs refundOrder
export const ORDER_GAS_LIMIT = ORDER_READY_GAS_LIMIT + ORDER_REFUND_GAS_LIMIT;

const toBig = (v) => {
  if (v === null || v === undefined || v === "") return null;
  try { return BigInt(typeof v === "bigint" ? v : String(v)); } catch { return null; }
};

// СКОЛЬКО ВЕЙ НУЖНО НА ОБА ВЫЗОВА. Цену газа даёт цепь, пределы - наши. Ноль цены и нечитаемое число
// означают «не измерено», и это НЕ ноль газа: неизвестное требование обязано называться, а не выдаваться за
// ноль (то же правило, что у газа забора: rfq/reverseGas.mjs).
export function orderGasReserveWei({ gasPriceWei, readyGasLimit = ORDER_READY_GAS_LIMIT, refundGasLimit = ORDER_REFUND_GAS_LIMIT } = {}) {
  const gp = toBig(gasPriceWei);
  if (gp === null || gp <= 0n) return null;
  const ready = toBig(readyGasLimit);
  const refund = toBig(refundGasLimit);
  if (ready === null || refund === null || ready <= 0n || refund <= 0n) return null;
  return gp * (ready + refund);
}

// ПОКАЗ В ОБЕИХ ВЕЛИЧИНАХ. У человека, пришедшего из USDC, нет чувства масштаба ETH, поэтому запас показан и
// в ETH, и в долларах. Доллар - оценка по живому курсу натива; нет курса - нет и оценки (null), а не выдумка.
export function gasReserveDisplay({ reserveWei, nativeUsd, decimals = 18 } = {}) {
  const w = toBig(reserveWei);
  if (w === null || w <= 0n) return null;
  const native = Number(w) / 10 ** decimals;
  const usd = Number.isFinite(Number(nativeUsd)) && Number(nativeUsd) > 0 ? native * Number(nativeUsd) : null;
  return { native, usd };
}

// РЕШЕНИЕ ПО ГАЛОЧКЕ. Галочка НУЖНА, только когда своего натива НЕ ХВАТАЕТ на оба вызова; при достатке ETH
// она не показывается вовсе - человек платит своим газом, и просить у него нечего. Нечитаемый баланс натива -
// отдельное состояние: запас предлагаем (лучше предложить, чем промолчать о нехватке), и это названо полем.
export function gasReserveChoice({ nativeBalanceWei, reserveWei } = {}) {
  const need = toBig(reserveWei);
  if (need === null || need <= 0n) return { measured: false, enough: null, show: false, balanceUnread: false };
  const have = toBig(nativeBalanceWei);
  if (have === null) return { measured: true, enough: false, show: true, balanceUnread: true };
  return { measured: true, enough: have >= need, show: have < need, balanceUnread: false };
}

// ПОЛНОЕ РЕШЕНИЕ ОДНИМ ОБЪЕКТОМ - именно оно фиксируется в состоянии формы до котировки. Все числовые поля -
// строки либо null: так план переживает запись и чтение, и BigInt не превращается в «[object BigInt]».
export function orderGasReservePlan({ gasPriceWei = null, nativeBalanceWei = null, nativeUsd = null, decimals = 18 } = {}) {
  const reserveWei = orderGasReserveWei({ gasPriceWei });
  const display = reserveWei === null ? null : gasReserveDisplay({ reserveWei, nativeUsd, decimals });
  const choice = gasReserveChoice({ nativeBalanceWei, reserveWei });
  return {
    measured: reserveWei !== null,
    gasPriceWei: gasPriceWei === null || gasPriceWei === undefined ? null : String(gasPriceWei),
    reserveWei: reserveWei === null ? null : reserveWei.toString(),
    native: display ? display.native : null,
    usd: display ? display.usd : null,
    enough: choice.enough,
    show: choice.show,
    balanceUnread: Boolean(choice.balanceUnread),
  };
}
