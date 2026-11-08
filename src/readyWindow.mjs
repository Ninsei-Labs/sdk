// THE NODE'S READY WINDOW, READ ONCE.
//
// A maker advertises the range in which it will accept `readyBy` for one side: `readyMinSeconds` is the shortest
// horizon it can finish in, `readyMaxSeconds` the longest it will sign. The SDK used to keep its own 1200 s and
// 20-minute numbers, so a node configured differently and the client disagreed about when a sale still had time.
//
// The lead a depositor leaves the maker is derived, not guessed: the window's spare room above the minimum is
// `max - min`; the client waits until `min - (max - min)` remains. The default node window is 2400..3000 s, so
// the lead is 1800 s: the node's settlement margin, not the old 1200 s. A narrower window gives a shorter lead,
// never less than the time the required confirmations need.
import { SdkError } from "./errors.mjs";

const int = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};

/** Read and validate one `FirmWindow` from the signed features, or refuse by name. */
export function readReadyWindow(value, { side = null, field = "readyWindow" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SdkError("bad-input", { field, why: "missing" });
  }
  const min = int(value.readyMinSeconds);
  const max = int(value.readyMaxSeconds);
  if (min === null || max === null || min <= 0 || max < min) {
    throw new SdkError("bad-input", { field, why: "bounds" });
  }
  if (side !== null && value.side !== undefined && String(value.side) !== String(side)) {
    throw new SdkError("bad-input", { field, why: "side" });
  }
  return Object.freeze({
    market: value.market === undefined || value.market === null ? null : String(value.market),
    side: value.side === undefined || value.side === null ? null : String(value.side),
    xmrNetwork: value.xmrNetwork === undefined || value.xmrNetwork === null ? null : String(value.xmrNetwork),
    readyMinSeconds: min,
    readyMaxSeconds: max,
    settlementMinSeconds: int(value.settlementMinSeconds),
    settlementMaxSeconds: int(value.settlementMaxSeconds),
    quoteTtlSeconds: int(value.quoteTtlSeconds),
  });
}

/**
 * HOW LONG BEFORE `readyBy` THE DEPOSITOR MAY STILL REFUND.
 *
 * The maker's own settlement margin is not a wire field; the advertised window carries it implicitly. The node
 * publishes `[min, max]` where `max - min` is the headroom it keeps above the minimum, and that headroom is the
 * time the depositor must leave for the payout to settle before a refund. The default 2400..3000 window therefore
 * gives 600 s, not the retired 1200 s: the old reserve woke the helper while a payout could still be confirming.
 */
export function readyLeadSec(window) {
  const ready = readReadyWindow(window);
  const headroom = ready.readyMaxSeconds - ready.readyMinSeconds;
  return Math.max(0, headroom);
}

/** The node's own settlement margin: the latest point at which it can still pay before `readyBy`. */
export function readyLateSec(window) {
  const ready = readReadyWindow(window);
  const headroom = ready.readyMaxSeconds - ready.readyMinSeconds;
  return Math.max(0, ready.readyMinSeconds - headroom);
}

/** The longest wait a quote from this window can ask for, without inventing a second client-side deadline. */
export function readyWindowMs(window, marginSec = 300) {
  const ready = readReadyWindow(window);
  const margin = Number.isFinite(Number(marginSec)) && Number(marginSec) >= 0 ? Number(marginSec) : 300;
  return (ready.readyMaxSeconds + margin) * 1000;
}
