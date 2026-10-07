// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/fees.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Комиссия ArrakisSwap: ЧАСТЬ ПОДПИСАННОЙ КОТИРОВКИ (OrderQuote v7), а не настройка контракта.
//
// ГДЕ ЖИВЁТ СТАВКА. Раньше её и получателя назначала ФАБРИКА (или роутер) в неизменяемых полях, и клиент
// спрашивал их у цепи (feeBps()/feeRecipient()/feeFor()). Теперь этих функций у контракта НЕТ: роутер удалён
// (решение #76), а ставка, величина и получатель комиссии входят в ПОДПИСАННЫЙ набор условий ордера. Значит
// источник правды ОДИН - котировка, и второго места быть не должно:
//   * в настройках страницы ставки НЕТ; копия разошлась бы с подписанным набором;
//   * у фабрики спрашивать нечего - она ничего о комиссии не знает;
//   * величина в wei посчитана по формуле `amount * feeBps / 10000` (округление ВНИЗ) и здесь сверяется с
//     этой же формулой ЗЕРКАЛОМ: расхождение обязано остановить подпись, а не превратиться в отказ эскроу
//     (WrongAmount/BadFee) уже после неё.
//
// КТО ПЛАТИТ. Комиссию платит ПОЛЬЗОВАТЕЛЬ ИНТЕРФЕЙСА. Направление видно из ролей котировки: провайдер
// забирает ETH - покупка (комиссия СВЕРХУ взноса), провайдер вносит ETH - продажа (комиссия ВЫЧЕТОМ из
// выплаты, `amount - fee`). Провайдер не назван ни там, ни там - понять нечего, отказ.
//
// ОДНА ЕДИНИЦА ВРЕМЕНИ. Время в проекте - СЕКУНДЫ (сроки ордера, срок годности котировки, block.timestamp):
// пересчёт между шкалами и был единственным местом, где ошибка на тысячу проходит молча.

// Потолок ставки, зашитый в контракте (NinseiEscrow.MAX_FEE_BPS = 200 = 2%). Нужен здесь, чтобы отличить
// осмысленную ставку от испорченной: читать мусор как ставку и считать по нему комиссию нельзя.
export const MAX_FEE_BPS = 200;

// ЗЕРКАЛО ФОРМУЛЫ КОНТРАКТА. Одно место на всю страницу: вторая копия разошлась бы с первой ровно там,
// где это дороже всего - на величине, которую требует эскроу.
export function feeWeiFor(amountWei, feeBps) {
  const amount = BigInt(amountWei === null || amountWei === undefined || amountWei === "" ? 0 : amountWei);
  const bps = BigInt(Number(feeBps) || 0);
  if (amount < 0n || bps < 0n) throw new Error("комиссия: отрицательная сумма или ставка");
  return (amount * bps) / 10000n;   // ВНИЗ, как в Solidity: amount * feeBps / 10000
}

const sameAddr = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const zeroAddr = (a) => !a || /^0x0{40}$/i.test(String(a));

// ПАМЯТЬ О ПОСЛЕДНЕЙ ПОДПИСАННОЙ КОТИРОВКЕ. Ставка становится известна ТОЛЬКО с котировкой; до неё её нет,
// и показывать вместо неё ноль или число из конфига значило бы врать. Проверки подставляют свои значения
// через resetFeeCache + feeTermsFromQuote.
let lastTerms = null;

// СБРОС ПАМЯТИ. Нужен проверкам и любому повтору после смены котировки.
export function resetFeeCache() {
  lastTerms = null;
}

// КОМИССИЯ ИЗ КОТИРОВКИ. Возвращает ставку, величину (сверенную зеркалом), получателя и направление; при
// ненулевой ставке без получателя - отказ (комиссия сгорела бы). Результат кладётся в память для экрана.
export function feeTermsFromQuote(quote) {
  if (!quote || typeof quote !== "object") throw new Error("нет подписанной котировки: комиссию и адрес реестра взять неоткуда");
  const amount = BigInt(String(quote.amount));
  const bps = Number(quote.feeBps === undefined || quote.feeBps === null ? 0 : quote.feeBps);
  if (!Number.isFinite(bps) || bps < 0 || bps > MAX_FEE_BPS) throw new Error("ставка комиссии вне потолка: " + quote.feeBps);
  const fee = feeWeiFor(amount, bps);
  if (BigInt(String(quote.fee === undefined || quote.fee === null ? 0 : quote.fee)) !== fee) {
    throw new Error("подписанная комиссия " + quote.fee + " расходится с формулой amount * rate (" + fee + ") - подпись не начата");
  }
  if (bps !== 0 && zeroAddr(quote.feeRecipient)) throw new Error("при ненулевой ставке получатель комиссии обязан быть назван");
  const providerIsLocker = sameAddr(quote.locker, quote.provider);
  const providerIsClaimer = sameAddr(quote.claimer, quote.provider);
  if (providerIsLocker === providerIsClaimer) throw new Error("не понять, кто платит комиссию: провайдер не назван ни вносившим, ни забирающим");
  const feeOnTop = providerIsClaimer;   // провайдер забирает ETH -> покупка -> комиссия сверху взноса
  const terms = { bps, feeWei: fee, totalWei: feeOnTop ? amount + fee : amount, recipient: quote.feeRecipient || null, feeOnTop, legacy: false };
  lastTerms = terms;
  return terms;
}

// СИНХРОННЫЙ ДОСТУП К ПРОЧИТАННОМУ. Пусто - значит "ещё не читали либо не смогли": это НЕ ноль, и
// вызывающий обязан закрыть подпись, а не посчитать комиссию нулевой.
export function cachedFeeTerms() {
  return lastTerms;
}

// СТАВКА ДЛЯ ПОКАЗА. Единственное место, откуда страница берёт число для строки разбивки цены. Ответа нет -
// null, и экран говорит, что ставка ещё неизвестна.
export function cachedFeeRate() {
  if (!lastTerms || !Number.isFinite(Number(lastTerms.bps))) return null;
  return Number(lastTerms.bps) / 10000;
}

// РАНЬШЕ ЭТА ФУНКЦИЯ ЧИТАЛА СТАВКУ У ЦЕПИ. Теперь читать не у чего: ставка - в подписанной котировке, и
// приходит она вместе с нею (feeTermsFromQuote). Функция оставлена ради вызывающих экранов: до котировки она
// честно возвращает то, что уже известно (обычно null - "ставка неизвестна"), и ничего не выдумывает.
export async function ensureFeeTerms() {
  return lastTerms;
}
