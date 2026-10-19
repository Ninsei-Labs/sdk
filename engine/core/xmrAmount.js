// XMR AMOUNTS AS TEXT: ATOMIC UNITS IN, A HUMAN NUMBER OUT (AND BACK).
//
// WHY NOT `Number`. One XMR is 10^12 atomic units (piconero). A JavaScript number is exact only up to 2^53, which
// is about 9007 XMR in piconero: a balance or a quote above it would be rounded in silence. The sweep page kept its
// own `ATOMIC_UNITS = 10^12n` and its own formatting; a second copy of this rule is exactly how a page shows
// 0.000000000001 and a node reports 0.
//
// THE FORMAT IS PLAIN DECIMAL, NO GROUPING: a value to be copied, compared or put into a field. The interface may
// group digits for reading, but the string this module returns must remain a number.
//
// DUST DOES NOT VANISH: 1 atomic unit formats as "0.000000000001", never as "0".
const DECIMALS = 12;
const SCALE = 10n ** BigInt(DECIMALS);

/** Atomic units (bigint | number | string) -> a decimal string. Throws on a value that is not a whole number. */
export function formatXmr(atomic, { trim = true } = {}) {
  let value;
  try {
    value = BigInt(atomic);
  } catch {
    throw new RangeError("formatXmr: expected whole atomic units");
  }
  // A fractional input (0.5) silently truncated by BigInt() would be a wrong amount, not a formatting choice.
  if (typeof atomic === "number" && !Number.isInteger(atomic)) throw new RangeError("formatXmr: expected whole atomic units");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(DECIMALS, "0");
  let text = trim ? fraction.replace(/0+$/, "") : fraction;
  const out = text ? `${whole}.${text}` : `${whole}`;
  return negative ? `-${out}` : out;
}

/**
 * A decimal amount typed by a person -> atomic units (bigint), or null when the text is not an amount.
 *
 * A comma without a dot is the decimal separator ("0,05"), as in the amount field. MORE THAN TWELVE DECIMALS IS
 * NOT ROUNDED AND NOT TRUNCATED: null. Rounding someone's amount is a wrong payment that looks successful;
 * refusing is a question the interface can ask again.
 */
export function parseXmr(text) {
  const raw = String(text == null ? "" : text).trim().replace(/\s+/g, "");
  if (!raw) return null;
  if (raw.includes(".") && raw.includes(",")) return null;
  const normalized = raw.replace(",", ".");
  if (!/^\d+(\.\d*)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const digits = fraction.replace(/0+$/, "");
  if (digits.length > DECIMALS) return null;
  return BigInt(whole) * SCALE + BigInt((digits || "0").padEnd(DECIMALS, "0"));
}
