// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/format.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Formatting of numbers, time and addresses.

const nf = (min, max) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

export function amount(v, dp = 2) {
  const n = Number(v);
  if (!isFinite(n)) return "-";
  const max = Math.min(dp, 6);
  // DUST DOES NOT VANISH. Before, printing was hard-wired to "six digits", and an amount below 0.000001 showed as
  // 0.000000 - a non-zero value looked like zero. For money this is the worst kind of display: the person
  // sees zero where they actually have something. Extra digits are added only when the print zeroed a
  // non-zero value, and never more than 18 (the wei precision limit).
  if (n !== 0 && Math.abs(n) < Math.pow(10, -max)) {
    const need = Math.min(18, Math.max(max + 1, -Math.floor(Math.log10(Math.abs(n)))));
    return nf(need, need).format(n).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  return nf(max, max).format(n);
}


export function usd(v) {
  const n = Number(v);
  if (!isFinite(n)) return "-";
  return "$" + nf(0, Math.abs(n) < 100 ? 2 : 0).format(n);
}

export function pct(v, dp = 2) {
  return (Number(v) * 100).toFixed(dp) + "%";
}

export function compact(v) {
  const n = Number(v);
  if (!isFinite(n)) return "-";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

export function shortHash(h, head = 6, tail = 4) {
  if (!h) return "-";
  const s = String(h);
  if (s.length <= head + tail + 2) return s;
  return s.slice(0, head) + "..." + s.slice(-tail);
}

// sim-time -> the demo's wall clock (UTC, as in the litepaper mockups)
export function clockTime(ms) {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function clockTimeShort(ms) {
  return clockTime(ms).slice(0, 5);
}

// Duration in seconds -> "12m 30s"
export function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function countdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function dateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a);
}

// Bytes (Uint8Array/Buffer) -> hex string without the 0x prefix.
export function toHex(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// PARSING AN AMOUNT ENTERED BY A PERSON.
//
// WHY A SEPARATE FUNCTION, NOT A replace RIGHT IN THE FIELD. The amount fields had
// `e.target.value.replace(/[^0-9.]/g, "")`: everything but digits and a dot was ERASED. The European comma
// ("0,05" - the way half the world writes) turned into "005", that is 5 - an error by A HUNDREDFOLD, and spotting
// it in the interface is nearly impossible: the field shows "005", the quote is computed for five, the person pays
// a hundred times more. A comma without a dot is a decimal separator; a comma when a dot is present is a
// thousands separator; the Monero wallets do the same.
//
// Returns a CANONICAL string (digits and at most one dot). It is exactly what is shown in the field and exactly
// what the rest of the code parses - so "what is written" and "what is computed" cannot diverge.
export function normalizeAmountInput(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/[^0-9.,]/g, "");
  if (s.includes(".")) {
    // A dot is present - commas separate thousands ("1,234.5" -> "1234.5").
    s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    // A single comma without a dot is the decimal separator ("0,05" -> "0.05"). Everything AFTER the second
    // comma is dropped: guessing that "1,2,3" meant 123 would, on a typo, inflate the payment a hundredfold.
    const i = s.indexOf(",");
    const rest = s.slice(i + 1);
    const cut = rest.indexOf(",");
    s = s.slice(0, i) + "." + (cut < 0 ? rest : rest.slice(0, cut));
  }
  // A second dot is also a typo, and the tail after it is dropped, not glued to the number ("1.2.3" -> "1.2").
  const dot = s.indexOf(".");
  if (dot >= 0) {
    const rest = s.slice(dot + 1);
    const cut = rest.indexOf(".");
    s = s.slice(0, dot + 1) + (cut < 0 ? rest : rest.slice(0, cut));
  }
  s = s.replace(/^0+(?=\d)/, "");                     // "005" -> "5", but "0.5" is left alone
  if (!/[0-9]/.test(s)) return "";
  return s;
}

/** Number from a human-entered value, or null if there is no number. No "guessing": empty means empty. */
export function parseAmount(raw) {
  const s = normalizeAmountInput(raw);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function shortId() {
  // 16 hex chars (8 bytes = 2^64). Before it was 4 chars (randomHex(2)): with 100 000 swaps a collision is
  // practically inevitable - 68.8% at 8 chars and 100% at 4 - and the id is a key in the state and the name of
  // the recovery file, so a collision would mean losing a record that backs funds.
  // IMPORTANT: already-created swaps keep short ids. They must not be renamed: the id lives in the recovery
  // file, in links and in the state - they would fall out of sync.
  return randomHex(8);
}

// QUICK CHECK OF A Monero ADDRESS SHAPE: base58, length 95 (plain) / 106 (integrated), network prefix.
//
// WHAT THIS FUNCTION DOES NOT DO: IT DOES NOT VERIFY THE CHECKSUM. Any typo inside the address passes here
// unnoticed. It used to be named isValidMoneroAddress - and that name was a trap: a function called
// "address check" that lets a typo through ends up on the money path sooner or later.
//
// THE REAL CHECK IS checkAddress() from ../monero/address.js: format + base58 decode + keccak256 checksum
// + network match. The form calls that one. This one only screens out obvious garbage before the heavy decode.
export function looksLikeMoneroAddress(addr) {
  const a = String(addr || "").trim();
  if (![95, 106].includes(a.length)) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return false;
  return ["4", "5", "7", "8", "9", "A", "B"].includes(a[0]);
}

