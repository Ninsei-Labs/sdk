// SECONDS AT THE CHAIN, MILLISECONDS EVERYWHERE ELSE - AND ONE CONVERSION BETWEEN THEM.
//
// WHAT WENT WRONG WITHOUT THIS RULE (a live log, not a theory). One line carried deadlines in different scales:
// ready_by = 1791828827 (seconds), t1 = 1791832427 (seconds), funded_at = 1791825228449 (milliseconds). The payout
// path read ready_by as it was and subtracted a margin in MILLISECONDS: "1791828827 - 1800000" is a moment around
// 1970, so the deadline looked long past at once and the check never asked the money-origin hook even once.
//
// THE RULE IS NOT "MILLISECONDS EVERYWHERE", because two values are outside our control and stay in seconds:
//   * the escrow deadlines readyBy/t1 travel in the SIGNED order terms as 32-bit words;
//   * EVM block time is whole seconds.
// So: seconds at the chain and in the signed terms; milliseconds for everything a program keeps, compares with its own
// clock or hands out over the wire.
//
// THE CONVERSION HAPPENS ONCE, at the boundary (`msFromOrderSeconds`), and it REFUSES a value that is already in
// milliseconds - otherwise the thousand would be multiplied a second time, in silence.
//
// THE SCALE IS DISTINGUISHABLE BY MAGNITUDE: in 2026 seconds are about 1.79e9 and milliseconds about 1.79e12. A value
// in the gap between the two thresholds has NO scale - guessing "probably seconds" is exactly how the defect passes.
export const SECONDS_SCALE_MAX = 1e11;
export const MS_SCALE_MIN = 1e12;
export const DEADLINE_SCALE = Object.freeze({ seconds: "seconds", milliseconds: "milliseconds", unknown: "unknown" });

/** THE SCALE OF A VALUE. Empty, zero, a non-number or a value between the thresholds: unknown. */
export function scaleOf(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n) || n <= 0) return DEADLINE_SCALE.unknown;
  if (n < SECONDS_SCALE_MAX) return DEADLINE_SCALE.seconds;
  if (n >= MS_SCALE_MIN) return DEADLINE_SCALE.milliseconds;
  return DEADLINE_SCALE.unknown;
}

export function isSecondsScale(value) { return scaleOf(value) === DEADLINE_SCALE.seconds; }
export function isMsScale(value) { return scaleOf(value) === DEADLINE_SCALE.milliseconds; }

/**
 * THE ONLY CONVERSION FROM THE SIGNED ORDER'S SECONDS TO MILLISECONDS.
 *
 * An empty value gives null: "no deadline named" stays unnamed rather than becoming zero. A value already in
 * milliseconds is REFUSED - this function is called at one boundary, and a second conversion is a silent thousand.
 */
export function msFromOrderSeconds(value, what = "the value") {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(what + " is not a positive number: " + JSON.stringify(value));
  const scale = scaleOf(n);
  if (scale === DEADLINE_SCALE.milliseconds) {
    throw new Error(what + " is already in milliseconds (" + n + "); the single conversion at the boundary would multiply the thousand a second time");
  }
  if (scale !== DEADLINE_SCALE.seconds) throw new Error(what + " is neither seconds nor milliseconds (" + n + ")");
  return n * 1000;
}

/** A WRITE GUARD: a value of the wrong scale stops the write instead of being stored. Returns true when it passes. */
export function assertMsScale(value, what = "the value") {
  if (scaleOf(value) !== DEADLINE_SCALE.milliseconds) {
    throw new Error(what + " is not in milliseconds: " + JSON.stringify(value) + " (scale " + scaleOf(value) + ")");
  }
  return true;
}
