// THE ONE PLACE THE QUOTE LIFETIME AND ITS START MARGIN ARE NAMED.
//
// A firm quote is signed with `validUntil`, and the SDK refuses to start a swap when less than the start margin is left.
// A node that signs a shorter life than that margin is refusing its own quotes before the wallet is opened. The node
// imports this default and may override it with its own setting; the SDK keeps the value here so the two cannot drift.
export const LOCK_START_MARGIN_SEC = 30;

/** The default firm quote lifetime, in seconds. A node may override it, but the default is this value. */
export const DEFAULT_ORDER_QUOTE_TTL_SEC = 60;

/**
 * THE QUOTE MUST STILL HAVE ITS START MARGIN WHEN IT ARRIVES. The lock check runs seconds later, after the proof and
 * the record work; a quote that is already at the margin is refused here, before the caller shows a confirmation.
 * Returns `ok:false` for an unreadable clock too: an unknown lifetime is not a reason to show a quote.
 */
export function quoteLifeVerdict({ validUntil, nowSec, marginSec = LOCK_START_MARGIN_SEC } = {}) {
  const until = Number(validUntil);
  const now = Number(nowSec);
  const margin = Number(marginSec);
  if (!Number.isSafeInteger(until) || !Number.isSafeInteger(now) || !Number.isSafeInteger(margin) || margin < 0) {
    return { ok: false, code: "quote-too-short", remainingSec: null, marginSec: Number.isSafeInteger(margin) ? margin : null };
  }
  const remainingSec = until - now;
  return { ok: remainingSec > margin, code: remainingSec > margin ? null : "quote-too-short", remainingSec, marginSec: margin };
}
