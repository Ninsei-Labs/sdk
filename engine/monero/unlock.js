// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/unlock.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// OUTPUT UNLOCK TIME (unlock_time). ONE RULE FOR EVERYONE WHO DECIDES "ARRIVAL IS THERE".
//
// A Monero transaction has an unlock_time field. Zero - "the output is open in the normal order". A non-zero
// value FORBIDS spending the output until the given boundary, and the boundary is of two kinds:
//   * less than 500 000 000 - this is a BLOCK HEIGHT (CRYPTONOTE_MAX_BLOCK_NUMBER in the Monero sources);
//   * 500 000 000 and more - this is a TIME (unix seconds).
// Until the boundary has passed, the money LIES at the address but cannot be spent: this is NOT an arrival
// that can close the swap. A maker who sent the correct amount with unlock_time five years ahead received ETH
// on the "done" mark, while the XMR stayed locked.
//
// WHY THE ONE SOURCE LIVES HERE. The rule is read by the backend indexer through the scan module and by the
// SDK core through the engine mirror. A second copy would mean a second truth about money, so there is no copy:
// the mirror must match this file to the byte, and a divergence between them is caught mechanically, not by a human.
export const UNLOCK_TIME_BLOCK_MAX = 500_000_000;

// Output state by its unlock_time. The return is a NAMED result, not a boolean: the interface must
// explain to the person UP TO WHAT exactly the money is locked (heights or dates), and in what language to
// say it is the business of the interface dictionary, not of the core.
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

// How "late" the boundary is: of two locked transfers in the record state we keep the one that opens
// later - otherwise one of them would show "opening soon" while the second holds the money longer.
export function laterBoundary(state) {
  if (!state) return -1;
  if (state.untilTime !== null && state.untilTime !== undefined) return Number(state.untilTime);
  if (state.untilHeight !== null && state.untilHeight !== undefined) return Number(state.untilHeight);
  return -1;
}
