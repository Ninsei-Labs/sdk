// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/gasReserve.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// THE BUYER GAS RESERVE FOR ORDER ACTIONS: THE READINESS MARK AND A POSSIBLE REFUND.
//
// THE POINT. In a direct swap the person deposits into the escrow, and after the XMR arrives calls markReady itself
// (when the XMR is confirmed) or refund (when the swap did not happen). Both calls cost gas in the network
// NATIVE coin, and a person coming from USDC has no native of their own. So BEFORE the quote it is decided HOW MUCH
// NATIVE to leave for those two calls; the decision is shown both in ETH and in dollars, and enters the price breakdown as a line.
//
// WHY PURE FUNCTIONS. The decision costs money and must be checked without a network
// and computed by THE SAME code on screen and in the run. Only reading the gas price touches the network - the
// caller supplies it (www/js/evm/prices.js puts gasPriceWei into the live prices, the screen passes it here).
//
// THE NUMBERS ARE NOT INVENTED. The gas limits are the same ones OUR OWN code sends both transactions with
// (the swap engine is now in the package: sdk/src/swap-flow.mjs - markReadyOrder - gas 120000, refundOrder - gas
// 250000). The check compares both constants against the lines of that file, so
// editing one place without the other reddens the run - exactly as done for the claim gas in rfq/reverseGas.mjs.
//
// WHY THE RESERVE IS FIXED BEFORE THE QUOTE. The order `amount` is part of the SIGNED quote, and the reserve
// decision changes the final deposit amount; so it is made BEFORE the quote request and not recomputed afterwards.
// The screen puts the ready plan into the form state (www/js/ui/views/swapForm.js), and the signing screen uses the
// same fixed plan - a second recomputation would diverge from the first.

// THE GAS LIMITS ARE FROM OUR OWN CODE. Source lines: sdk/src/swap-flow.mjs (gas: 120_000n at the mark and
// gas: 250_000n at the refund). A limit set too low is a refusal already after the half is revealed; unused
// gas in the limit is not charged, so the reserve is taken with a margin.
export const ORDER_READY_GAS_LIMIT = 120_000n;   // markReady - sdk/src/swap-flow.mjs markReadyOrder
export const ORDER_REFUND_GAS_LIMIT = 250_000n;  // refund   - sdk/src/swap-flow.mjs refundOrder
export const ORDER_GAS_LIMIT = ORDER_READY_GAS_LIMIT + ORDER_REFUND_GAS_LIMIT;

const toBig = (v) => {
  if (v === null || v === undefined || v === "") return null;
  try { return BigInt(typeof v === "bigint" ? v : String(v)); } catch { return null; }
};

// HOW MANY WEI IS NEEDED FOR BOTH CALLS. The gas price comes from the chain, the limits are ours. A zero price
// and an unreadable number mean "not measured", and this is NOT zero gas: an unknown requirement must be named,
// not passed off as zero (the same rule as for the claim gas: rfq/reverseGas.mjs).
export function orderGasReserveWei({ gasPriceWei, readyGasLimit = ORDER_READY_GAS_LIMIT, refundGasLimit = ORDER_REFUND_GAS_LIMIT } = {}) {
  const gp = toBig(gasPriceWei);
  if (gp === null || gp <= 0n) return null;
  const ready = toBig(readyGasLimit);
  const refund = toBig(refundGasLimit);
  if (ready === null || refund === null || ready <= 0n || refund <= 0n) return null;
  return gp * (ready + refund);
}

// DISPLAY IN BOTH UNITS. A person coming from USDC has no sense of ETH scale, so the reserve is shown both
// in ETH and in dollars. The dollar is an estimate at the live native rate; no rate - no estimate (null), not a made-up one.
export function gasReserveDisplay({ reserveWei, nativeUsd, decimals = 18 } = {}) {
  const w = toBig(reserveWei);
  if (w === null || w <= 0n) return null;
  const native = Number(w) / 10 ** decimals;
  const usd = Number.isFinite(Number(nativeUsd)) && Number(nativeUsd) > 0 ? native * Number(nativeUsd) : null;
  return { native, usd };
}

// DECISION BY THE CHECKBOX. The checkbox is NEEDED only when one own native is NOT ENOUGH for both calls; with enough
// ETH it is not shown at all - the person pays with their own gas, and there is nothing to ask of them. An unreadable
// native balance is a separate state: we offer the reserve (better to offer than stay silent about the shortfall), and this is named by a field.
export function gasReserveChoice({ nativeBalanceWei, reserveWei } = {}) {
  const need = toBig(reserveWei);
  if (need === null || need <= 0n) return { measured: false, enough: null, show: false, balanceUnread: false };
  const have = toBig(nativeBalanceWei);
  if (have === null) return { measured: true, enough: false, show: true, balanceUnread: true };
  return { measured: true, enough: have >= need, show: have < need, balanceUnread: false };
}

// THE WHOLE DECISION IN ONE OBJECT - exactly what is fixed in the form state before the quote. All numeric fields
// are strings or null: so the plan survives writing and reading, and BigInt does not become "[object BigInt]".
export function orderGasReservePlan({ gasPriceWei = null, nativeBalanceWei = null, nativeUsd = null, decimals = 18 } = {}) {
  const reserveWei = orderGasReserveWei({ gasPriceWei });
  const display = reserveWei === null ? null : gasReserveDisplay({ reserveWei, nativeUsd, decimals });
  const choice = gasReserveChoice({ nativeBalanceWei, reserveWei });
  return {
    measured: reserveWei !== null,
    gasPriceWei: gasPriceWei === null || gasPriceWei === undefined ? null : String(gasPriceWei),
    reserveWei: reserveWei === null ? null : reserveWei.toString(),
    native: display ? display.native : null,
    usd: display ? display.usd : null,
    enough: choice.enough,
    show: choice.show,
    balanceUnread: Boolean(choice.balanceUnread),
  };
}
