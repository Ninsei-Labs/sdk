// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/clock.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Sim-часы демки.
//
// Идея: реальное время сжимается множителем speed. speed=60 означает, что одна
// реальная секунда равна одной sim-минуте. Все тайминги сделки живут в sim-времени,
// поэтому демку можно показывать быстро, а на speed=1 она идёт в реальном темпе
// (20-40 минут на сделку, как в литпепере).
//
// swap.realStart  - Date.now() в момент создания сделки
// swap.simStartWall - настенное время демки в этот же момент (для отображения UTC)
// simElapsed(swap) = (Date.now() - realStart) * speed

export function nowReal() {
  return Date.now();
}

export function simElapsed(swap, now = nowReal()) {
  return Math.max(0, (now - swap.realStart) * swap.speed);
}

// Настенное время демки в момент, когда прошло simMs sim-времени с начала сделки.
export function simWall(swap, simMs) {
  return swap.simStartWall + simMs;
}



// Пересчёт базовой точки при смене скорости: sim-прогресс сохраняется,
// дальше сделка идёт с новой скоростью.
export function rescaleStart(swap, newSpeed, now = nowReal()) {
  const elapsed = simElapsed(swap, now);
  swap.speed = newSpeed;
  swap.realStart = now - elapsed / newSpeed;
  return swap;
}

