// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/sellWindow.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ОКНО ПРОДАЖИ XMR (issue #111): ОДНО ПРАВИЛО НА ДВЕ СТОРОНЫ, А НЕ ДВА ЧИСЛА.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. У окна продажи XMR (человек отдаёт XMR, получает натив сети) два числа, и они
// разной природы:
//   * ЖЁСТКОЕ (hard) - срок отметки готовности ИЗ КОНТРАКТА. Позже него отметку не примет никто, и он входит
//     в ПРИВЯЗКУ ордера (termsHash), поэтому после выдачи билета не меняется. В контракт ВСЕГДА идёт максимум:
//     10 подтверждений Monero - это примерно 1200 с, и меньше контрактного окна быть не может, иначе отметить
//     готовность было бы нечем (отметку контракт после readyBy запрещает, XMR заперлись бы для обоих).
//   * МЯГКОЕ (soft) - ОБЕЩАНИЕ НА ЭКРАНЕ: сколько провайдер держит цену, пока человек отправляет XMR.
//     "Десять минут" владельца и партнёра.
// ПРАВИЛО ПРОДЛЕНИЯ ОДНО. Пока в пуле НЕ видно ПОЛНОЙ ожидаемой суммы, обещание продлевается до контрактного
// максимума: человек мог отправить, и ему нужен первый блок. Как только полная сумма видна в пуле, окно
// мягкое - обещание сдержано, и продлевать нечего.
//
// ПОЧЕМУ ФУНКЦИЯ, А НЕ ДВА ЧИСЛА В ДВУХ МЕСТАХ. Это правило решает НОДА (rfq/reverseArrival.mjs - отметка,
// тревога, ранний возврат) и показывает СТРАНИЦА (www/js/core/swap.js - отсчёт на экране). Вторая редакция
// разошлась бы с первой молча: человек видел бы одно окно, а нода жила бы по другому. Направление импорта
// rfq -> www в проекте уже принято (образец: rfq/reverseGas.mjs импортирует ../www/js/evm/claimGas.js).
export const SELL_WINDOW = {
  softSec: 600,     // "десять минут": обещание провайдера на экране
  hardSec: 1200,    // контрактное окно: 10 подтверждений Monero, максимум, попадающий в termsHash
};

const positiveSec = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

// СКОЛЬКО СЕКУНД ИДЁТ ОКНО ПРОДАЖИ при названном состоянии пула. poolSeen - в пуле видна ПОЛНАЯ ожидаемая
// сумма, и только она (не "что-то видно" и не недоплата: сделка повисла бы на чужой копейке - см. poolCoverage
// в rfq/reverseArrival.mjs). Контрактное окно - ПОТОЛОК: мягкое обещание не может быть длиннее контрактного,
// иначе мы обещали бы то, чего цепь не даст.
export function sellWindowSec({ poolSeen, soft = SELL_WINDOW.softSec, hard = SELL_WINDOW.hardSec } = {}) {
  const s = positiveSec(soft, SELL_WINDOW.softSec);
  const h = positiveSec(hard, SELL_WINDOW.hardSec);
  const promised = Math.min(s, h);
  return poolSeen ? promised : h;
}
