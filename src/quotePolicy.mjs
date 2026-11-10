// THE ONE PLACE THE QUOTE LIFETIME, ITS START MARGIN AND THE CLIENT'S PREPARATION TIME ARE NAMED.
//
// A firm quote is signed with `validUntil`. On a buy (`ask`) the SDK refuses to show a quote unless enough life is
// left to finish the proof, the record and the lock; on a sell (`bid`) the node has already funded the escrow before
// it answers, so the client opens no wallet and the lock margin protects nothing there.
//
// A node that signs a shorter life than the start rule is refusing its own quotes before the wallet is opened. The
// node imports these values and may override the lifetime with its own setting; the SDK keeps the values here so the
// two cannot drift.
export const LOCK_START_MARGIN_SEC = 30;

// THE TIME THE CLIENT NEEDS BEFORE THE LOCK. The proof, the record and the chain reads each cost seconds on a
// desktop and several times longer on a phone without a JIT. The start margin alone covers only the next block; this
// allowance covers the SDK's own preparation, so a quote shown to a person still has time to be clicked.
export const START_PREP_SEC = 15;

/** The default firm quote lifetime, in seconds. A node may override it, but the default is this value. */
export const DEFAULT_ORDER_QUOTE_TTL_SEC = 60;

/**
 * THE QUOTE MUST HAVE ENOUGH LIFE LEFT WHEN IT ARRIVES.
 *
 * A buy is checked against the start margin plus the preparation allowance: the proof and the record work take
 * seconds, and refusing at the lock would show the person a confirmation that was never going to reach the wallet.
 * A sell is checked only against its own expiry: the node has already funded the escrow, so there is no local lock
 * to prepare and a short remaining life must not abandon that escrow.
 *
 * Returns `ok:false` for an unreadable clock too: an unknown lifetime is not a reason to show a quote. `confirmBySec`
 * is the last second at which a buy can still be started; the host may disable its button after it.
 */
export function quoteLifeVerdict({ validUntil, nowSec, side = "ask", marginSec = LOCK_START_MARGIN_SEC, prepSec = START_PREP_SEC } = {}) {
  const until = Number(validUntil);
  const now = Number(nowSec);
  const margin = Number(marginSec);
  const prepare = Number(prepSec);
  if (!Number.isSafeInteger(until) || !Number.isSafeInteger(now)) {
    return { ok: false, code: "quote-too-short", remainingSec: null, marginSec: null, prepSec: null, confirmBySec: null };
  }
  const remainingSec = until - now;
  const bid = side === "bid";
  if (bid) {
    const ok = remainingSec > 0;
    return { ok, code: ok ? null : "quote-too-short", remainingSec, marginSec: 0, prepSec: 0, confirmBySec: until };
  }
  if (!Number.isSafeInteger(margin) || !Number.isSafeInteger(prepare) || margin < 0 || prepare < 0) {
    return { ok: false, code: "quote-too-short", remainingSec, marginSec: null, prepSec: null, confirmBySec: null };
  }
  const requiredSec = margin + prepare;
  const ok = remainingSec > requiredSec;
  return {
    ok,
    code: ok ? null : "quote-too-short",
    remainingSec,
    marginSec: margin,
    prepSec: prepare,
    confirmBySec: until - requiredSec,
  };
}
