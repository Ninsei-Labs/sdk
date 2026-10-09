// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/amounts.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Recalculating balances from the contract raw units into human-readable ones.
//
// A separate module, because this is money maths and it must be checked without a browser:
// getting decimals right is the most common EVM-wallet bug (USDT/USDC on BSC have 18, not 6),
// and the price of the error is a balance off by 10^12. The check runs in the test battery,
// so it runs both in CI and locally.

// BigInt (raw units) -> a decimal number.
//
// We divide as Number, not integer: the variant "raw * 1e6 / 10^dec" swallowed small values -
// 55000 wei at 18 decimals turned into exactly 0, and the demo showed an empty balance where
// there is money (caught by a check on specific numbers). Double precision is enough: 15-16
// significant digits against the 6 decimals the interface shows.
export function toHuman(raw, decimals) {
  return Number(raw) / 10 ** decimals;
}

// Trims trailing zeros from a decimal string: "12.180000" -> "12.18".
// A dot is mandatory: for "1000" the trailing zeros must not be touched.
export function trimTrailingZeros(text) {
  const s = String(text);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

// Amount for display and for the MAX button: truncation (not rounding) and at most 6 decimals.
//
// Why truncation: MAX must not insert an amount larger than the real balance - else the form
// rightly answers "Not enough ..." and the MAX button leads into a dead end. Rounding up did
// exactly that: 0.0399187 -> 0.039919 > balance.
// Why 6 decimals: human precision, and exactly what the balance hint shows.
// Returns a NUMBER (for comparisons); the string for the input field is given by amountInputValue below.
export function floorAmount(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const scaled = Math.floor(n * 10 ** decimals);
  if (scaled > 0) return scaled / 10 ** decimals;
  // Below 10^-decimals: this is dust. We return the value whole (18-digit precision) so that
  // MAX does not insert 0.0000001 instead of 0.000000123 - that is, does not drop the balance almost entirely.
  return Math.floor(n * 1e18) / 1e18;
}

// String for the input field and for the balance hint: the same function, so MAX
// inserts exactly the number the user sees.
//
// toFixed, not String(): String(1.23e-7) gives "1e-7", and the input field accepts only digits
// and a dot - "1e-7" would turn into "17" (caught by a check, not by a user).
export function amountInputValue(value, decimals = 6) {
  // Truncate first, then format: toFixed ROUNDS itself, and without truncation you got
  // 0.039919 - that is, more than the balance, and MAX hit "Not enough ...".
  const cut = floorAmount(value, decimals);
  if (!Number.isFinite(cut) || cut <= 0) return "0";
  // For dust we print all digits: else toFixed would round to the first non-zero digit.
  const d = cut >= 10 ** -decimals ? decimals : 18;
  return trimTrailingZeros(cut.toFixed(d));
}

// Case set for the check: [raw value, decimals, expected].
// 6 decimals - USDT/USDC on Ethereum, Arbitrum, Base; 18 - on BNB Chain and for native tokens.
// The expectations were verified by hand arithmetic: 1 unit at 18 decimals is 1e-18, so
// 55000 wei is 5.5e-14, not 0.000055 (the latter is 5.5e13 wei).
export const AMOUNT_CASES = [
  [12345678900n, 6, 12345.6789], // USDC, 6 decimals
  [108275582n, 6, 108.275582], // real balance, taken from Arbitrum
  [10n ** 18n, 18, 1], // 1 ETH
  [1500000000000000000n, 18, 1.5], // 1.5 ETH
  [55000000000000n, 18, 0.000055], // 0.000055 ETH - visible on screen, but the old rounding lied
  [55000n, 18, 5.5e-14], // dust: the old formula gave exactly 0 (a silent loss)
  [3120000000000000000000n, 18, 3120], // 3120 BNB
  [0n, 18, 0], // empty wallet
];

// Cases for balance display and MAX: [balance, expected string].
// The first is exactly what the user complained about: 0.03991877164758065 landed in the field whole.
export const MAX_CASES = [
  [0.03991877164758065, "0.039918"], // that very ETH: 6 digits, as in the hint
  [0.0399187, "0.039918"], // truncation down, not rounding up to 0.039919
  [12431.18, "12431.18"], // stable: no trailing zeros
  [3.4125, "3.4125"],
  [1, "1"],
  [0.000000123, "0.000000123"], // dust: neither zero nor the exponent "1e-7"
  [0, "0"],
];

export const TRIM_CASES = [
  ["12,431.180000", "12,431.18"],
  ["0.039918", "0.039918"],
  ["1.000000", "1"],
  ["1000", "1000"],
  ["0.000000", "0"],
];

// The input field accepts only digits and a dot (see oninput in swapForm.js). If a string does not
// satisfy this, the field silently turns it into another number - so we check that too.
const INPUT_PATTERN = /^[0-9]+(\.[0-9]+)?$/;

export function checkAmounts({ tolerance = 1e-9 } = {}) {
  const failures = [];

  for (const [raw, decimals, expected] of AMOUNT_CASES) {
    const got = toHuman(raw, decimals);
    if (!Number.isFinite(got) || Math.abs(got - expected) > tolerance) {
      failures.push(`${raw} at ${decimals} decimals -> ${got}, expected ${expected}`);
    }
  }

  for (const [balance, expected] of MAX_CASES) {
    const got = amountInputValue(balance);
    if (got !== expected) {
      failures.push(`MAX at balance ${balance} -> "${got}", expected "${expected}"`);
    }
    if (!INPUT_PATTERN.test(got)) {
      failures.push(`MAX at balance ${balance} gave "${got}" - the input field will distort that value`);
    }
    // The key property of MAX: the inserted amount is NOT larger than the balance.
    if (floorAmount(balance) > balance) {
      failures.push(`MAX at balance ${balance} inserted more than the balance: ${floorAmount(balance)}`);
    }
  }

  for (const [input, expected] of TRIM_CASES) {
    const got = trimTrailingZeros(input);
    if (got !== expected) failures.push(`balance display "${input}" -> "${got}", expected "${expected}"`);
  }

  return failures;
}
