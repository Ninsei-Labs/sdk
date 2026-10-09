// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/sellWindow.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// XMR SELL WINDOW: ONE RULE FOR TWO SIDES, NOT TWO NUMBERS.
//
// WHY A SEPARATE MODULE. The XMR sell window (a person gives XMR, receives the network native coin) has two
// numbers, and they are of different nature:
//   * HARD - the readiness-mark deadline FROM THE CONTRACT. Past it nobody accepts the mark, and it goes into
//     the order BINDING (termsHash), so it does not change after the ticket is issued. The contract ALWAYS
//     gets the maximum: 10 Monero confirmations is about 1200 s, and it cannot be less than the contract
//     window, else there would be nothing to mark readiness with (the contract forbids the mark after readyBy,
//     and the XMR would be locked for both).
//   * SOFT - THE ON-SCREEN PROMISE: how long the provider holds the price while the person sends XMR.
//     The owner's and partner's "ten minutes".
// THE EXTENSION RULE IS ONE. While the pool does NOT show the FULL expected amount, the promise is extended to
// the contract maximum: the person may have sent, and needs the first block. Once the full amount is visible,
//
// WHY A FUNCTION, NOT TWO NUMBERS IN TWO PLACES. This rule is decided by the NODE (rfq/reverseArrival.mjs -
// the mark, the alarm, the early refund) and shown by the PAGE (www/js/core/swap.js - the on-screen countdown).
// A second edition would diverge from the first silently: the person would see one window while the node lived by
// another. The rfq -> www import direction is already accepted (precedent: rfq/reverseGas.mjs imports ../www/js/evm/claimGas.js).
export const SELL_WINDOW = {
  softSec: 600,     // "ten minutes": the provider's on-screen promise
  hardSec: 1200,    // contract window: 10 Monero confirmations, the maximum that goes into termsHash
};

const positiveSec = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

// HOW MANY SECONDS THE SELL WINDOW LASTS given the named pool state. poolSeen - the FULL expected amount is
// visible in the pool, and only it (not "something is visible" and not an underpayment: the swap would hang on
// someone else's penny - see poolCoverage in rfq/reverseArrival.mjs). The contract window is a CEILING: the soft
// promise cannot be longer than the contract window, else we would promise what the chain will not give.
export function sellWindowSec({ poolSeen, soft = SELL_WINDOW.softSec, hard = SELL_WINDOW.hardSec } = {}) {
  const s = positiveSec(soft, SELL_WINDOW.softSec);
  const h = positiveSec(hard, SELL_WINDOW.hardSec);
  const promised = Math.min(s, h);
  return poolSeen ? promised : h;
}
