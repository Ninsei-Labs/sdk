// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/unlock.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// ВРЕМЯ РАЗБЛОКИРОВКИ ВЫХОДА (unlock_time). ОДНО ПРАВИЛО НА ВСЕХ, КТО РЕШАЕТ «ПРИХОД ЕСТЬ».
//
// У транзакции Monero есть поле unlock_time. Ноль - «выход открыт обычным порядком». Ненулевое значение
// ЗАПРЕЩАЕТ тратить выход до указанной границы, и граница бывает двух видов:
//   * меньше 500 000 000 - это ВЫСОТА блока (CRYPTONOTE_MAX_BLOCK_NUMBER в исходниках Monero);
//   * 500 000 000 и больше - это ВРЕМЯ (unix-секунды).
// Пока граница не пройдена, деньги ЛЕЖАТ на адресе, но потратить их нельзя: это НЕ приход, которым можно
// закрыть сделку. Мейкер, отправивший верную сумму с unlock_time на пять лет вперёд, получал ETH по отметке
// «готово», а XMR оставались запертыми (issue #84).
//
// ПОЧЕМУ ЗДЕСЬ, ПОД www/js. Это ЕДИНСТВЕННЫЙ источник правила. Его читает бэкенд-индексер
// (app/indexer.mjs -> ../www/js/monero/scan.js) и ЯДРО SDK - через ШТАТНОЕ ЗЕРКАЛО ДВИЖКА:
// sdk/engine/monero/unlock.js, собирается tools/build-sdk-engine.mjs и сверяется побайтно сторожем
// tools/check-sdk-engine.mjs. Вторая копия означала бы вторую правду о деньгах, поэтому копии нет:
// зеркало обязано совпасть с этим файлом до байта, и расхождение ловит проверка, а не человек.
export const UNLOCK_TIME_BLOCK_MAX = 500_000_000;

// Состояние выхода по его unlock_time. Возврат - НАЗВАННЫЙ результат, а не булево: интерфейс должен
// объяснить человеку, ДО ЧЕГО именно заперты деньги (высоты или даты), а на каком языке это сказать - дело
// словаря интерфейса, а не ядра.
export function unlockStateOf(unlockTime, { height = null, nowSec = null } = {}) {
  const u = Number(unlockTime) || 0;
  if (u <= 0) return { code: "unlocked", locked: false, untilHeight: null, untilTime: null };
  if (u >= UNLOCK_TIME_BLOCK_MAX) {
    const now = nowSec === null || nowSec === undefined ? Math.floor(Date.now() / 1000) : Number(nowSec);
    const open = Number.isFinite(now) && now >= u;
    return { code: open ? "unlocked" : "locked_time", locked: !open, untilHeight: null, untilTime: u };
  }
  const h = height === null || height === undefined ? null : Number(height);
  const open = h !== null && Number.isFinite(h) && h >= u;
  return { code: open ? "unlocked" : "locked_height", locked: !open, untilHeight: u, untilTime: null };
}

// Насколько «поздняя» граница: из двух запертых переводов в состоянии записи оставляем ту, что открывается
// позже, - иначе по одному из них показали бы «скоро откроется», когда второй держит деньги дальше.
export function laterBoundary(state) {
  if (!state) return -1;
  if (state.untilTime !== null && state.untilTime !== undefined) return Number(state.untilTime);
  if (state.untilHeight !== null && state.untilHeight !== undefined) return Number(state.untilHeight);
  return -1;
}
