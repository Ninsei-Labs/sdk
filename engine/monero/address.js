// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/address.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Monero address checks and assembly: format + real checksum + network prefixes.
// A detail easy to get wrong: Monero has its OWN base58 - block-based (8 bytes -> 11 chars, the remainder last).
// It is NOT compatible with bitcoin-base58, where a leading '1' means a zero byte; here a block is a NUMBER and
// '1' can be just a digit. So bs58 does not fit and base58 is implemented numerically below.
// Without the checksum a typo in the payout address looks valid, and in an atomic swap that means lost money.
// Network prefixes (official): mainnet 18 plain, 19 with payment id, 42 subaddress.
// The vendored monero-js knows ONLY mainnet, so we have our own encoder: the library gives public keys, we build the string.

const BLOCK_CHARS = 11;

// encoded bytes -> chars (from the vendored base58 table)
const CHARS_BY_BYTES = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 7, 6: 9, 7: 10, 8: 11 };
const BYTES_BY_CHARS = { 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8 };

const PREFIXES = {
  18: { network: "mainnet", kind: "primary" },
  19: { network: "mainnet", kind: "integrated" },
  42: { network: "mainnet", kind: "subaddress" },
  24: { network: "stagenet", kind: "primary" },
  25: { network: "stagenet", kind: "integrated" },
  36: { network: "stagenet", kind: "subaddress" },
  53: { network: "testnet", kind: "primary" },
  54: { network: "testnet", kind: "integrated" },
  63: { network: "testnet", kind: "subaddress" },
};

// reverse table: network + kind -> prefix byte (for address assembly)
export const PREFIX_BY_NETWORK = {
  mainnet: { primary: 18, integrated: 19, subaddress: 42 },
  stagenet: { primary: 24, integrated: 25, subaddress: 36 },
  testnet: { primary: 53, integrated: 54, subaddress: 63 },
};

export function prefixFor(network, kind = "primary") {
  const byKind = PREFIX_BY_NETWORK[network];
  if (!byKind) throw new Error("Unknown network: " + network);
  const prefix = byKind[kind];
  if (prefix === undefined) throw new Error("Unknown address kind: " + kind);
  return prefix;
}

// Synchronous format check (for the UI before the library loads).
export function formatCheck(addr) {
  const a = String(addr || "").trim();
  if (![95, 106].includes(a.length)) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return false;
  // the first letter is set by the network prefix: 4/8 mainnet, 5/7 stagenet, 9/A/B testnet
  return ["4", "5", "7", "8", "9", "A", "B"].includes(a[0]);
}

// The first letter follows directly from the prefix: 4/8 mainnet, 5/7 stagenet, 9/A/B testnet
export function networkFromShape(addr) {
  const a = String(addr || "").trim();
  if (!formatCheck(a)) return null;
  if (a[0] === "4" || a[0] === "8") return "mainnet";
  if (a[0] === "5" || a[0] === "7") return "stagenet";
  if (["9", "A", "B"].includes(a[0])) return "testnet";
  return null;
}

export function isStagenetShaped(addr) {
  return networkFromShape(addr) === "stagenet";
}

let lib = null;
let libFailed = false;

async function loadLib() {
  if (lib) return lib;
  if (libFailed) return null;
  try {
    const mod = await import("../../assets/vendors/monero/monero-js-browser.js?v=05c682ea");
    lib = mod.default || mod;
    return lib;
  } catch {
    libFailed = true;
    return null;
  }
}

// The Monero-base58 alphabet (same as Bitcoin, different encoding rules).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_VALUES = (() => {
  const m = new Map();
  [...B58_ALPHABET].forEach((c, i) => m.set(c, BigInt(i)));
  return m;
})();

// Block of bytes -> base58 string (as a number: no "leading '1' = zero byte").
function blockToBase58(block) {
  let num = 0n;
  for (const b of block) num = (num << 8n) | BigInt(b);
  let s = "";
  while (num > 0n) {
    s = B58_ALPHABET[Number(num % 58n)] + s;
    num /= 58n;
  }
  return s;
}

// base58 block string -> exactly `bytes` bytes, right-aligned.
//
// Why not bs58 from npm: its decoder treats every leading '1' as a zero BYTE (bitcoin semantics). In Monero a
// block is a number and '1' can be just a digit, so bs58 adds a spurious zero byte and the checksum falsely fails.
function base58ToBlock(str, bytes) {
  let num = 0n;
  for (const ch of str) {
    const v = B58_VALUES.get(ch);
    if (v === undefined) throw new Error("Invalid Monero base58 character: " + ch);
    num = num * 58n + v;
  }
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  if (num !== 0n) throw new Error("Base58 block does not fit in " + bytes + " bytes");
  return out;
}

// Block-based Monero base58: string -> bytes.
//
// Block order matters: Monero encodes full 8-byte blocks first (11 chars each), and the PARTIAL remainder goes
// LAST with fewer chars. So the remainder is taken from the end of the string.
export function decodeMoneroBase58(str) {
  const s = String(str);
  const L = s.length;
  const rem = L % BLOCK_CHARS;
  const lastChars = rem === 0 ? BLOCK_CHARS : rem;
  const lastBytes = BYTES_BY_CHARS[lastChars];
  if (!lastBytes) throw new Error("Invalid Monero base58 length");

  const chunks = [];
  const headLen = L - lastChars;
  for (let i = 0; i < headLen; i += BLOCK_CHARS) chunks.push(base58ToBlock(s.slice(i, i + BLOCK_CHARS), 8));
  chunks.push(base58ToBlock(s.slice(headLen), lastBytes));

  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Block-based Monero base58: bytes -> string (inverse of decode above). Full 8-byte blocks are 11 chars
// (left-padded with '1'), the remainder goes last.
export function encodeMoneroBase58(bytes) {
  const arr = Array.from(bytes);
  const L = arr.length;
  const rem = L % 8;
  const lastBytes = rem === 0 ? 8 : rem;
  const headLen = L - lastBytes;

  let out = "";
  for (let i = 0; i < headLen; i += 8) {
    const s = blockToBase58(arr.slice(i, i + 8));
    out += "1".repeat(Math.max(0, CHARS_BY_BYTES[8] - s.length)) + s;
  }
  const t = blockToBase58(arr.slice(headLen));
  out += "1".repeat(Math.max(0, CHARS_BY_BYTES[lastBytes] - t.length)) + t;
  return out;
}

// Address payload (without checksum): prefix + public spend + public view [+ payment id]
export function addressPayload({ network, kind = "primary", spendPub, viewPub, paymentId }) {
  const prefix = prefixFor(network, kind);
  const spend = hexToBytes(spendPub, 32, "public spend key");
  const view = hexToBytes(viewPub, 32, "public view key");
  const out = [prefix, ...spend, ...view];
  if (kind === "integrated") {
    const pid = hexToBytes(paymentId, 8, "payment id");
    out.push(...pid);
  }
  return Uint8Array.from(out);
}

function hexToBytes(hex, expectedBytes, label) {
  const s = String(hex || "").trim();
  if (!new RegExp("^[0-9a-fA-F]{" + expectedBytes * 2 + "}$").test(s)) {
    throw new Error("Bad " + label + ": expected " + expectedBytes * 2 + " hex characters");
  }
  const out = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Assembly of the address from public keys: deps = { keccak256 } (in the browser, from the monero-js bundle).
// bs58 is not needed: Monero base58 is block-based and numeric, see the comment at base58ToBlock.
export function addressFromKeys({ network, kind = "primary", spendPub, viewPub, paymentId }, deps) {
  if (!deps?.keccak256) throw new Error("addressFromKeys needs { keccak256 }");
  const payload = addressPayload({ network, kind, spendPub, viewPub, paymentId });
  const digest = Uint8Array.from(deps.keccak256(deps.Buffer ? deps.Buffer.from(payload) : payload));
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(digest.slice(0, 4), payload.length);
  return encodeMoneroBase58(full);
}

// Full check: format + block decode + keccak256 checksum + network.
// expectNetwork (optional): if set, an address of another network is an error - on a stagenet swap a mainnet
// address is lost money, not a nitpick.
export async function checkAddress(addr, opts = {}) {
  const a = String(addr || "").trim();
  if (!formatCheck(a)) {
    return { ok: false, reason: "Not a Monero address (expected 95 or 106 base58 characters)" };
  }
  const shape = networkFromShape(a);
  if (opts.expectNetwork && shape && shape !== opts.expectNetwork) {
    return { ok: false, reason: `This is a ${shape} address, but the swap runs on ${opts.expectNetwork}` };
  }
  const l = await loadLib();
  if (!l) {
    return { ok: true, verified: false, network: shape, reason: "Format looks valid (checksum check unavailable: monero-js bundle is not built)" };
  }
  try {
    const bytes = decodeMoneroBase58(a);
    const payloadLen = bytes.length - 4;
    if (payloadLen < 65) throw new Error("Address is too short");
    const payload = bytes.slice(0, payloadLen);
    const checksum = bytes.slice(payloadLen);
    // keccak256 from the bundle needs Buffer: it does not take Uint8Array
    const digest = Uint8Array.from(l.keccak256(l.Buffer.from(payload)));
    const match = checksum.length === 4 && checksum.every((b, i) => b === digest[i]);
    if (!match) {
      // The demo mock addresses (wallet.js, mock mode) intentionally have no checksum: the UI marks them as fake,
      // so a "typo" is not the only explanation for such an address and the text must say so.
      return { ok: false, reason: "Checksum mismatch: the address has a typo, is corrupted, or is a demo mock address (mock addresses have no checksum)" };
    }

    const prefix = payload[0];
    const meta = PREFIXES[prefix] || { network: "unknown", kind: "unknown" };
    if (meta.network === "unknown") return { ok: false, reason: `Unsupported address prefix ${prefix}` };
    if (opts.expectNetwork && meta.network !== opts.expectNetwork) {
      return { ok: false, reason: `This is a ${meta.network} address, but the swap runs on ${opts.expectNetwork}` };
    }
    return { ok: true, verified: true, network: meta.network, kind: meta.kind, bytes: bytes.length };
  } catch (e) {
    return { ok: false, reason: "Address decode failed: " + e.message };
  }
}

// Helper for code that has already loaded the bundle: build an address of the right network from wallet keys.
export async function addressForNetwork({ network, kind = "primary", spendPub, viewPub }) {
  const l = await loadLib();
  if (!l) throw new Error("monero-js bundle is not available");
  return addressFromKeys({ network, kind, spendPub, viewPub }, { keccak256: l.keccak256, Buffer: l.Buffer });
}
