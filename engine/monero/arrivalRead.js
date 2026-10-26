// READING AN XMR ARRIVAL WITHOUT A WALLET: WHAT THE ADDRESS IS, WHETHER A KEY MATCHES IT, AND WHETHER THE COIN IS
// LOCKED.
//
// WHY THIS MODULE. A node that pays XMR holds only ONE half of the view key, so it cannot open a wallet on the
// address it pays to - and it still has to answer three questions before it treats a transfer as money it can
// spend. The sweep page needs the same answers when it verifies a recovery file. Both used to carry their own
// copies: base58 decoding, the little-endian scalar form the daemon expects, the view-key comparison, and the
// unlock_time rule. A second copy of the last one is the expensive kind - money at the address that cannot be
// spent yet reads as an arrival.
//
// WHAT IS HERE: reading only. No signing, no sending, no network, no wallet.
//
// THE NETWORK TABLE IS DERIVED from the package's own prefix table rather than written out with numbers: a prefix
// typed from memory (stagenet is not 18) already produced an address that no wallet would open.
import { decodeMoneroBase58, PREFIX_BY_NETWORK } from "./address.js";

const NETWORK_BY_PREFIX = Object.fromEntries(
  Object.entries(PREFIX_BY_NETWORK).map(([network, kinds]) => [kinds.primary, network]),
);

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * AN ADDRESS -> ITS NETWORK AND ITS PUBLIC KEYS, or an error when the text is not an address.
 * A primary address carries a 65-byte payload; an integrated one 73 (the extra 8 are the payment id, not returned).
 */
export function decodeAddressKeys(address) {
  const raw = decodeMoneroBase58(String(address == null ? "" : address).trim());
  if (!raw || raw.length < 69) throw new Error("not a Monero address: " + (raw ? raw.length + " bytes" : "not base58"));
  const netByte = raw[0];
  return {
    network: NETWORK_BY_PREFIX[netByte] || null,
    netByte,
    spendPub: toHex(raw.slice(1, 33)),
    viewPub: toHex(raw.slice(33, 65)),
  };
}

/**
 * THE SCALAR IN THE FORM THE DAEMON EXPECTS: little-endian hex, low byte first.
 *
 * A number written high byte first is a DIFFERENT key, and nothing refuses it: the wallet is created without an
 * error and simply sees no arrival.
 */
export function scalarToLeHex(scalar, bytes = 32) {
  const size = Number(bytes);
  if (!Number.isInteger(size) || size <= 0) throw new Error("scalarToLeHex: bad width");
  let value;
  try { value = BigInt(scalar); } catch { throw new Error("scalarToLeHex: not an integer"); }
  if (value < 0n || value >= 1n << BigInt(size * 8)) throw new Error("scalarToLeHex: value does not fit " + size + " bytes");
  const out = new Uint8Array(size);
  let rest = value;
  for (let i = 0; i < size; i++) { out[i] = Number(rest & 0xffn); rest >>= 8n; }
  return toHex(out);
}

/**
 * IS THIS VIEW KEY THE ONE THE ADDRESS NAMES.
 *
 * `halves` is the object `createHalves` returns: the comparison must use the same point arithmetic as the address
 * build, otherwise a key that opens the wallet looks wrong.
 *
 * Answers: true - the key matches; false - it belongs to another address; null - there is no public key to compare
 * with (an address without a view key, which is not a case this code builds).
 */
export function viewKeyMatchesAddress(viewScalar, expectedViewPubHex, halves) {
  const want = String(expectedViewPubHex || "").trim().toLowerCase().replace(/^0x/, "");
  if (!want) return null;
  if (!halves || typeof halves.publicHalves !== "function") throw new Error("viewKeyMatchesAddress: createHalves is required");
  const got = String(halves.publicHalves(viewScalar).ed || "").toLowerCase().replace(/^0x/, "");
  return got === want;
}

// THE UNLOCK RULE HAS ONE HOME: ./unlock.js. This module re-exports it for the public xmr entry instead of keeping
// a second copy; a second copy is a second truth about whether money can be spent.
export { UNLOCK_TIME_BLOCK_MAX, unlockStateOf } from "./unlock.js";
