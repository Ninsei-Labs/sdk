// NEUTRAL HELPERS that the entries above and their consumers share: a decimal amount typed as text, in units.
//
// One function today. It is a separate entry because it belongs to neither the XMR side nor the EVM side, and a
// consumer forced to import it from either would learn a false lesson about where it lives.

export { parseAmount } from "../../engine/core/format.js";

// XMR AMOUNTS IN ATOMIC UNITS: 12 decimals, bigint, no rounding. `formatXmr` for display and for a field,
// `parseXmr` for what a person typed.
export { formatXmr, parseXmr } from "../../engine/core/xmrAmount.js";
