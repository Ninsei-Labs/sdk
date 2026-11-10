// THE MONERO INDEXER FOR THE SDK. The browser bundle carries a generated copy; this module is the source the package
// checks and tests use. Edit it here and regenerate the browser copy with `pnpm run build:sdk:docker` when a bundle
// change is needed.
//
// MONERO INDEXER: we find arrivals at the swap address ourselves by parsing blocks.
// WHY. Before, arrivals were learned from monero-wallet-rpc through a watch-only wallet, a path that hit a defect
// (the wallet+keys pair is created and never reopens) and where one instance held one wallet, so scanning 25
// swaps took 140 s. Our own block parsing depends on neither.
// WHAT IS NEEDED: the VIEW KEY and the PUBLIC SPEND KEY - both on the client and already sent to the backend by
// an allowlist. The spend key is NOT needed: seeing arrivals and spending them are different rights, the
// non-custodial boundary.
// FORMULAS FROM THE MONERO SOURCES, not from memory:
//   derivation    = 8 * (view_secret * tx_public_key)
//   scalar_i      = Hs(derivation || varint(i))
//   derived_key_i = scalar_i * G + spend_public_key
//   amount_i      = ecdhInfo[i].amount XOR Hs("amount" || derivation)[0..8]   (RingCT v2)
//   amount_i      = ecdhInfo[i].amount - Hs(derivation)                        (RingCT v1)
// Both versions are implemented: old transactions in the chain are still there.
// keccak-256 from @noble/hashes, the same package as the SDK core: the standalone keccak256 npm package needs Buffer.
// THE unlock_time RULE IS THE SAME ONE, lives next door (./unlock.js) and is re-exported from here.
//
//
//

import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { UNLOCK_TIME_BLOCK_MAX, unlockStateOf, laterBoundary } from "./unlock.js";
import { decodeAddressKeys } from "./arrivalRead.js";
export { UNLOCK_TIME_BLOCK_MAX, unlockStateOf, laterBoundary };

export function keccak(bytes) { return keccak_256(bytes); }

// Order of the edwards25519 group (l). Taken from the curve, not a remembered number: a wrong constant would
// corrupt the scalar, the derivation and the sum - an "invisible arrival".
export const ED_ORDER = ed25519.Point.CURVE().n;

// THE SECOND PEDERSEN GENERATOR, FROM THE MONERO SOURCE. `rct::H` is a fixed point whose discrete logarithm to
// the base point is unknown: C = mask*G + amount*H. The bytes are the compressed point from
// monero/src/ringct/rctTypes.h (`static const key H`), not a value recomputed from a remembered string.
// It is the same point the DLEQ module calls Galt - one constant, two uses, no second derivation.
export const PEDERSEN_H = "8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94";
const PEDERSEN_H_POINT = ed25519.Point.fromHex(PEDERSEN_H);

function scalarPoint(point, scalar) {
  const mod = ((BigInt(scalar) % ED_ORDER) + ED_ORDER) % ED_ORDER;
  return mod === 0n ? ed25519.Point.ZERO : point.multiply(mod);
}

/** The Pedersen commitment C = mask*G + amount*H, compressed. Used to check a decoded amount against `outPk`. */
export function amountMaskCommitment(amount, mask) {
  const value = BigInt(amount);
  if (value < 0n) throw new Error("the amount must not be negative");
  return scalarPoint(ed25519.Point.BASE, mask).add(scalarPoint(PEDERSEN_H_POINT, value)).toHex();
}

export function hexToBytes(hex) {
  const t = String(hex).trim().replace(/^0x/, "");
  if (t.length % 2) throw new Error("odd hex length");
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }

// BYTE ORDER IS LITTLE-ENDIAN. Monero stores scalars least-significant first, and sc_reduce32 reads the 32 hash
// bytes that way. Reading them big-endian gives a DIFFERENT number, the derivation does not match, and the
// arrival is not found SILENTLY.
export function scalarFromBytesLE(bytes) {
  const rev = Uint8Array.from(bytes).reverse();
  return BigInt("0x" + bytesToHex(rev));
}
export function scalarFromHexLE(hex) { return scalarFromBytesLE(hexToBytes(hex)); }
export function scalarToBytesLE(v, n = 32) {
  const out = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

// Hash to scalar: Hs(...) in Monero = keccak256 read LEAST-SIGNIFICANT first, reduced mod l.
export function hashToScalar(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return scalarFromBytesLE(keccak(buf)) % ED_ORDER;
}

// Monero varint (LEB128, 7 bits per byte, high bit = continuation).
export function varint(n) {
  const out = [];
  let v = BigInt(n);
  while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
  out.push(Number(v));
  return new Uint8Array(out);
}

// The swap public key is checked on parse: the point must lie on the curve.
function pointFromHex(hex) { return ed25519.Point.fromHex(String(hex).replace(/^0x/, "")); }

// derivation = 8 * (view_secret * tx_public_key) - exactly what generate_key_derivation does.
//
// BYTE ORDER: HERE WAS A SILENT LOSS OF ARRIVALS. The view key comes in two forms that look identical as a
// string: from monero-rpc as LITTLE-ENDIAN BYTES, from the swap record as a NUMBER in hex. Reading one as the
// other gives another scalar: the derivation does not match, the arrival is not found, and no error is written.
// So the form is tried EXPLICITLY and the winner is named in the result.
export function viewSecretCandidates(viewSecret) {
  if (typeof viewSecret === "bigint") return [["number", viewSecret % ED_ORDER]];
  const hex = String(viewSecret).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return [["unparsed", null]];
  // Both forms are reduced mod the group order: without this, a value larger than the order (any garbage string)
  // cannot produce a point and the key check would crash instead of saying "no match".
  return [["BE-number", BigInt("0x" + hex) % ED_ORDER], ["LE-bytes", scalarFromHexLE(hex) % ED_ORDER]];
}

// WHETHER THE VIEW KEY MATCHES THE ADDRESS. One comparison: the key point must equal the view point in the
// address. Return: the form name that matched; false - no form matched, so the key is from another address;
// null - nothing to compare.
export function viewKeyFormForAddress(viewSecret, expectedViewPubHex) {
  const want = String(expectedViewPubHex || "").toLowerCase();
  if (!want) return null;
  for (const [form, v] of viewSecretCandidates(viewSecret)) {
    if (v === null) continue;
    if (ed25519.Point.BASE.multiply(v).toHex().toLowerCase() === want) return form;
  }
  return false;
}

// THE KEY MATERIAL MUST BELONG TO THE ADDRESS IT IS SCANNED FOR. A public `scanRange` used to try both byte-order
// readings of the view key and could count a payment to another address as ours. This is the ONE binding rule: the
// scanner and both facade paths call it, so a host cannot get a different answer by choosing another entry point.
// A subaddress or integrated address is refused here; the joint address this SDK builds is primary.
export function watchedAddressVerdict({ address, viewSecret, spendPub } = {}) {
  let keys;
  try {
    keys = decodeAddressKeys(address);
  } catch {
    return { ok: false, code: "bad-input", why: "not-a-monero-address", field: "address" };
  }
  if (!keys.network) return { ok: false, code: "bad-input", why: "not-a-primary-address", field: "address" };
  const wantedSpend = String(spendPub === undefined || spendPub === null ? "" : spendPub).replace(/^0x/, "").toLowerCase();
  if (!wantedSpend || wantedSpend !== keys.spendPub.toLowerCase()) {
    return { ok: false, code: "xmr-address-mismatch", field: "spendPub" };
  }
  const form = viewKeyFormForAddress(viewSecret, keys.viewPub);
  if (!form) return { ok: false, code: "xmr-address-mismatch", field: "viewSecret" };
  const secret = viewSecretCandidates(viewSecret).find(([name]) => name === form)?.[1];
  if (secret === undefined || secret === null) {
    return { ok: false, code: "xmr-address-mismatch", field: "viewSecret" };
  }
  return { ok: true, address, keys, form, viewSecret: secret, spendPub: keys.spendPub };
}

export function keyDerivation(txPublicKeyHex, viewSecretHex) {
  const txPub = pointFromHex(txPublicKeyHex);
  // The view key is accepted both as LE bytes from monero-rpc and as a number if already parsed.
  const a = (typeof viewSecretHex === "bigint" ? viewSecretHex : scalarFromHexLE(String(viewSecretHex).replace(/^0x/, ""))) % ED_ORDER;
  const shared = txPub.multiply(a);
  // IMPORTANT: return BYTES, not a hex string. A string would later travel as the string's "bytes" (ASCII codes
  // into the hash) and the arrival simply would not be found - silently.
  return hexToBytes(shared.multiply(8n).toHex());   // 32-byte point (ge_tobytes) - this is the derivation
}

// derived_key_i = Hs(derivation || varint(i)) * G + B
export function derivedOutputKey(derivation, outputIndex, spendPubHex) {
  const scalar = hashToScalar(derivation, varint(outputIndex));
  const point = ed25519.Point.BASE.multiply(scalar).add(pointFromHex(spendPubHex));
  return point.toHex();
}

// Helper: the tx public key sits in the transaction extra, tag 0x01, 32 bytes. We read extra as is - the same
// parse the wallet does. extra arrives from the node as a BYTE ARRAY (not hex), so both forms are accepted.
//
// MONERO'S EXTRA IS A TAGGED SEQUENCE, NOT A FIXED LAYOUT. The tags we must know here:
//   0x00 padding      - a run of zero bytes (the tag itself is one of them), no length field;
//   0x01 public key   - 32 bytes;
//   0x02 nonce        - varint length, then that many bytes;
//   0x03 merge mining - a length-prefixed string holding varint depth + 32-byte hash;
//   0x04 additional   - varint count, then count * 32-byte public keys, ONE PER OUTPUT INDEX.
// The old parser treated 0x00 as an additional key and skipped it with `1 + b[i+1]`, and it stopped at 0x04.
// A subaddress payment in a mixed transaction then looked absent: the main key does not derive that output.
function readExtraVarint(bytes, at) {
  let value = 0n;
  let shift = 0n;
  let i = at;
  for (let count = 0; count < 10 && i < bytes.length; count++) {
    const byte = bytes[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7n;
  }
  return null;
}

/** The transaction keys in `extra`: the main key(s) and the per-output additional keys (tag 0x04). */
export function txKeysFromExtra(extra) {
  const b = Array.isArray(extra) ? Uint8Array.from(extra) : hexToBytes(extra);
  const txPublicKeys = [];
  const additionalPublicKeys = [];
  let i = 0;
  while (i < b.length) {
    const tag = b[i++];
    if (tag === 0x00) {
      // Padding is a run of zeros; the next non-zero byte is the next tag (or the end).
      while (i < b.length && b[i] === 0x00) i++;
      continue;
    }
    if (tag === 0x01) {
      if (i + 32 > b.length) break;
      txPublicKeys.push(bytesToHex(b.subarray(i, i + 32)));
      i += 32;
      continue;
    }
    if (tag === 0x02 || tag === 0x03) {
      const size = readExtraVarint(b, i);
      if (!size || size.value > BigInt(b.length - size.next)) break;
      i = size.next + Number(size.value);
      continue;
    }
    if (tag === 0x04) {
      const count = readExtraVarint(b, i);
      if (!count || count.value > BigInt(Math.floor((b.length - count.next) / 32))) break;
      i = count.next;
      for (let n = 0; n < Number(count.value); n++) {
        additionalPublicKeys.push(bytesToHex(b.subarray(i, i + 32)));
        i += 32;
      }
      continue;
    }
    // An unknown tag is not a guess: stop before it and use only what was parsed unambiguously.
    break;
  }
  return { txPublicKeys, additionalPublicKeys };
}

/** The first tx public key in `extra`, or null. Kept for callers that only need the primary key. */
export function txPublicKeyFromExtra(extra) {
  return txKeysFromExtra(extra).txPublicKeys[0] || null;
}

// Amount and mask decryption. THE ENCODING IS CHOSEN BY THE RingCT TYPE, not by a boolean:
//   types 0-3 (old): every ecdhInfo entry carries a 32-byte amount and a 32-byte mask;
//   types 4-6 (Bulletproof2, CLSAG, BulletproofPlus): the entry carries only the 8-byte amount, and the
//   receiver DERIVES the mask as Hs("commitment_mask" || sharedSec). A transaction from a current node has no
//   `ecdhInfo.mask` at all.
//
// THE SECRET IS THE DERIVATION SCALAR, NOT THE DERIVATION. Easy to get wrong: both are 32 bytes, but what goes
// into genAmountEncodingFactor is the scalar (derivation_to_scalar), written LEAST-SIGNIFICANT first. With the
// derivation the result looks plausible and is WRONG (checked on live numbers).
//
// THE TWO OLD FACTORS ARE DIFFERENT: amount -= Hs(Hs(sharedSec)), mask -= Hs(sharedSec). Using the amount's
// double hash for the mask (the first version) makes every old-encoding commitment fail.
function compactEncoding(rctType) { return Number(rctType) >= 4; }
function oldFactor(scalarLE, label) {
  const base = hashToScalar(scalarLE);
  if (label === "mask") return base;
  return hashToScalar(hexToBytes(base.toString(16).padStart(64, "0")));
}
function decodeField(ecdhHex, scalarLE, rctType, label) {
  if (compactEncoding(rctType)) {
    if (label === "mask") return hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
    const enc = hexToBytes(ecdhHex);
    const prefix = new TextEncoder().encode(label);
    const buf = new Uint8Array(prefix.length + scalarLE.length);
    buf.set(prefix, 0); buf.set(scalarLE, prefix.length);
    const factor = keccak(buf);
    const out = enc.slice();
    for (let i = 0; i < out.length && i < factor.length; i++) out[i] ^= factor[i];
    return scalarFromBytesLE(out);
  }
  const enc = hexToBytes(ecdhHex);
  const value = BigInt("0x" + bytesToHex(enc)) % ED_ORDER;
  return (value - oldFactor(scalarLE, label) + ED_ORDER) % ED_ORDER;
}

export function decodeAmount(ecdhAmountHex, scalarLE, rctType) {
  return decodeField(ecdhAmountHex, scalarLE, rctType, "amount");
}

export function decodeMask(ecdhMaskHex, scalarLE, rctType) {
  return decodeField(ecdhMaskHex, scalarLE, rctType, "mask");
}

// MAIN: parse a transaction and return OUR outputs (their indices, keys and amounts).
// txView - { txPublicKey(s), additionalPublicKeys, vout: [{key, index}], ecdhAmounts: [...], ecdhMasks: [...], outPk: [...], rctVersion }
//
// ADDITIONAL KEYS ARE PER OUTPUT, NOT PER TRANSACTION. A transaction paying several subaddresses carries tag 0x04:
// key i belongs to output i. Trying only the main key misses those outputs; trying every additional key against
// every output would be wrong in the other direction and can match another recipient's output. The main key is
// tried first, then this output's own additional key, exactly as the wallet does.
export function findOurOutputs({ txPublicKey = null, txPublicKeys = null, additionalPublicKeys = [], viewSecretHex, spendPubHex, outputs, ecdhAmounts = [], ecdhMasks = [], outPk = [], rctVersion = 2 }) {
  const primaryKeys = Array.isArray(txPublicKeys) ? txPublicKeys.filter(Boolean)
    : (txPublicKey ? [txPublicKey] : []);
  const additional = Array.isArray(additionalPublicKeys) ? additionalPublicKeys : [];
  if (!primaryKeys.length && !additional.length) throw new Error("the transaction has no public key (extra tag 0x01/0x04) - nothing to parse");
  // The key form is tried EXPLICITLY; the winner's name goes up so the log shows what was used. If none matched,
  // the first meaningful form is returned, not nothing.
  const usable = viewSecretCandidates(viewSecretHex).filter(([, v]) => v !== null);
  const first = usable[0] || ["unparsed", null];
  for (const [form, secret] of usable) {
    // A MALFORMED EXTRA KEY IS NOT A REASON TO STOP LOOKING AT THE OTHER KEYS. Monero's wallet skips a key that is
    // not a curve point and keeps scanning; a transaction with one bad tag-0x01 key otherwise blinds every arrival
    // whose range includes its block.
    const primaryDerivations = [];
    for (const key of primaryKeys) {
      try { primaryDerivations.push(keyDerivation(key, secret)); }
      catch { /* skip this candidate; the other keys may still be ours */ }
    }
    const found = [];
    for (const o of outputs) {
      // The main keys first, then only THIS output's additional key.
      const candidates = primaryDerivations.slice();
      if (additional[o.index]) {
        try { candidates.push(keyDerivation(additional[o.index], secret)); }
        catch { /* a malformed per-output key is skipped, like the primary list */ }
      }
      for (const derivation of candidates) {
        const scalar = hashToScalar(derivation, varint(o.index));
        const derived = derivedOutputKey(derivation, o.index, spendPubHex);
        if (derived.toLowerCase() !== String(o.key).toLowerCase()) continue;
        // The amount decryption uses THIS output's SCALAR, least-significant first.
        const amount = ecdhAmounts[o.index] ? decodeAmount(ecdhAmounts[o.index], scalarToBytesLE(scalar), rctVersion) : null;
        // THE COMMITMENT CHECK: outPk[i] = mask*G + amount*H. A node can flip a bit of the encrypted amount
        // without any key; the commitment is the only figure it cannot forge. A missing or mismatching
        // commitment is named on the output instead of being accepted as an arrival.
        // COMPACT TYPES HAVE NO mask FIELD: it is derived from the same scalar. Old types carry it.
        const mask = compactEncoding(rctVersion)
          ? decodeMask(null, scalarToBytesLE(scalar), rctVersion)
          : (ecdhMasks[o.index] ? decodeMask(ecdhMasks[o.index], scalarToBytesLE(scalar), rctVersion) : null);
        let amountVerified = false;
        if (amount !== null && mask !== null && outPk[o.index]) {
          try {
            amountVerified = amountMaskCommitment(amount, mask).toLowerCase() === String(outPk[o.index]).replace(/^0x/, "").toLowerCase();
          } catch { amountVerified = false; }
        }
        found.push({ index: o.index, key: o.key, amountAtomic: amount, maskAtomic: mask, amountVerified, derivation: bytesToHex(derivation) });
        break;                                   // one derivation per output; a later key cannot make it ours twice
      }
    }
    if (found.length) return { derivation: found[0].derivation, outputs: found, viewKeyForm: form };
    }
    let fallback = null;
    if (first[1] !== null && primaryKeys.length) {
      try { fallback = bytesToHex(keyDerivation(primaryKeys[0], first[1])); } catch { fallback = null; }
    }
    return {
      derivation: fallback,
      outputs: [],
      viewKeyForm: first[0],
    };
    }

// ============================================================================================
// SCANNING A HEIGHT RANGE. This is the indexing itself: read blocks in order, take their transaction hashes
// and parse them with ONE request per block, then check each transaction's outputs against ALL watched
// addresses at once. That is why the scan does not depend on the number of swaps.
//
// Deliberately NOT here: truncation, "height-based" confirmations, writing state to files. The height is a call
// parameter; the caller owns the scan state.
// ============================================================================================


// A trailing-slash trim without a backtracking regular expression: the daemon URL is caller input, and CodeQL
// flags `/+$` on a long run of slashes as a possible denial of service.
const baseUrl = (value) => {
  let out = String(value);
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
};

export async function fetchBlock(daemonUrl, height, fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  // THE DEADLINE COVERS THE BODY, NOT ONLY THE HEADERS. Without a signal a daemon that sends `{` and stops holds
  // the whole scan forever.
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 8000)) : undefined;
  const res = await fetchImpl(`${baseUrl(daemonUrl)}/json_rpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height } }),
    signal,
  });
  const j = await res.json();
  // A BUSY ANSWER IS NOT AN EMPTY BLOCK. The daemon answers BUSY while it is still indexing; a reader that treats
  // the missing `json` as "no transactions" reports a complete range with a smaller balance.
  if (j && String(j.status || "").toUpperCase() === "BUSY") throw new Error(`block ${height}: daemon is BUSY`);
  if (!j.result) throw new Error(`block ${height} not received: ${j.error ? j.error.message : "empty answer"}`);
  if (String(j.result.status || "").toUpperCase() === "BUSY") throw new Error(`block ${height}: daemon is BUSY`);
  // THE BLOCK MUST CARRY ITS DECODED BODY. `json` is what scanRange walks; without it the block is unreadable, not
  // empty. A result with only a blob or a header is refused by the same rule.
  if (j.result.json === undefined || j.result.json === null || j.result.json === "") {
    throw new Error(`block ${height}: no decoded body`);
  }
  return j.result;
}

// Transactions by hash list. We hit the PATH /get_transactions, not /json_rpc: over JSON-RPC this method
// silently returns empty, which looks like "no transactions".
export async function fetchTransactions(daemonUrl, hashes, fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  if (!hashes.length) return [];
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 8000)) : undefined;
  const res = await fetchImpl(`${baseUrl(daemonUrl)}/get_transactions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txs_hashes: hashes, decode_as_json: true }),
    signal,
  });
  const j = await res.json();
  // A BUSY ANSWER IS NOT AN EMPTY BLOCK. The daemon says BUSY while it is still indexing; returning [] would turn
  // money that is there into a complete scan with a zero balance.
  if (j && String(j.status || "").toUpperCase() === "BUSY") throw new Error("transactions-busy");
  const wrappers = Array.isArray(j && j.txs) ? j.txs : [];
  const encoded = Array.isArray(j && j.txs_as_json) ? j.txs_as_json : [];
  // EVERY HASH WE ASKED FOR MUST COME BACK. A partial answer is a missing block, not a quiet "no transactions".
  const requested = [...new Set(hashes.map((h) => String(h).replace(/^0x/, "").toLowerCase()))];
  const byHash = new Map();
  for (const wrapper of wrappers) {
    const hash = String((wrapper && wrapper.tx_hash) || "").replace(/^0x/, "").toLowerCase();
    if (!hash) continue;
    if (byHash.has(hash)) throw new Error("transactions-duplicate: " + hash);
    byHash.set(hash, wrapper);
  }
  const missing = requested.filter((h) => !byHash.has(h));
  if (missing.length) throw new Error("transactions-missing: " + missing.length);
  // EXACTLY THE REQUESTED SET. An extra transaction is not money this range asked for, and it may belong to another
  // block; counting it silently inflates the sum. A decoded body is required for every wrapper, one for one.
  if (byHash.size !== requested.length) throw new Error("transactions-extra: " + (byHash.size - requested.length));
  if (encoded.length !== wrappers.length) throw new Error("transactions-undecoded");
  // HASH AND HEIGHT LIVE IN THE WRAPPER, not in the parsed body: as_json omits them. Without this stitching a
  // "found transfer" would have neither hash nor height - useless to the caller, yet everything would look successful.
  const indexOf = new Map(wrappers.map((w, i) => [String((w && w.tx_hash) || "").replace(/^0x/, "").toLowerCase(), i]));
  return requested.map((hash) => {
    const w = byHash.get(hash) || {};
    const s = encoded[indexOf.get(hash)];
    const body = typeof s === "string" ? JSON.parse(s) : s;
    body.tx_hash = w.tx_hash || body.tx_hash || null;
    body.block_height = w.block_height ?? null;
    body.confirmations = w.confirmations ?? null;
    body.in_pool = w.in_pool ?? null;
    return body;
  });
}

// Parsing one transaction against the watched addresses. watched: [{ address, viewSecret, spendPub }] - viewSecret
// is taken as a number, LE-hex or BE-hex. The result carries viewKeyForm: the form name that matched.
export function matchTransaction(tx, watched, { height = null, tipHeight = null, nowSec = null } = {}) {
  const out = [];
  // BOTH KEY LISTS ARE PART OF THE TRANSACTION. A subaddress output carries its own key under tag 0x04; using only
  // `txPublicKeyFromExtra` drops exactly those outputs.
  const keys = txKeysFromExtra(tx.extra);
  if (!keys.txPublicKeys.length && !keys.additionalPublicKeys.length) return out;
  // WHETHER THE OUTPUT IS LOCKED IS DECIDED HERE, ONCE PER TRANSACTION: all its outputs carry one unlock_time.
  // A normal transaction (unlock_time = 0) goes as before; the height comes from the block holding the transfer.
  const blockHeight = height === null || height === undefined ? (tx.block_height ?? null) : height;
  // THE INCLUSION HEIGHT IS FOR CONFIRMATIONS, THE TIP FOR THE LOCK. A height lock at 101 is open once the chain
  // has reached 101, not once the transaction was mined at 100; using the inclusion height kept a matured lock
  // reporting `xmr-locked` forever.
  const unlockHeight = tipHeight === null || tipHeight === undefined ? blockHeight : Number(tipHeight);
  const unlock = unlockStateOf(tx.unlock_time, { height: unlockHeight, nowSec });
  const keyOf = (o) => ((o.target || {}).tagged_key || o.target || {}).key;
  const outputs = (tx.vout || []).map((o, i) => ({ index: i, key: keyOf(o) }));
  const ecdh = ((tx.rct_signatures || {}).ecdhInfo || []);
  const ecdhAmounts = ecdh.map((e) => e.amount);
  const ecdhMasks = ecdh.map((e) => e.mask);
  const outPk = ((tx.rct_signatures || {}).outPk || []);
  const rctVersion = (tx.rct_signatures || {}).type || 2;
  for (const w of watched) {
    // ONLY THE FORM THAT BELONGS TO THIS ADDRESS IS TRIED. A watched entry with another byte-order reading, another
    // spend key, or a subaddress is not a match; it cannot be made one by calling the public scanner directly.
    const bound = watchedAddressVerdict(w);
    if (!bound.ok) continue;
    const r = findOurOutputs({
      txPublicKeys: keys.txPublicKeys, additionalPublicKeys: keys.additionalPublicKeys,
      viewSecretHex: bound.viewSecret, spendPubHex: bound.spendPub,
      outputs, ecdhAmounts, ecdhMasks, outPk, rctVersion: Number(rctVersion) || 1,
    });
    if (r.outputs.length) out.push({ address: w.address, index: w.index ?? null, outputs: r.outputs, derivation: r.derivation, viewKeyForm: r.viewKeyForm, unlockTime: Number(tx.unlock_time) || 0, unlock });
  }
  return out;
}

// Range scan. Returns per address the sum (receivedAtomic - only the UNLOCKED), hashes, the locked sum
// (lockedAtomic) with its boundary (lockedUntil) and the best (highest) height of a found output.
export async function scanRange({ daemonUrl, fromHeight, toHeight, watched, log = () => {}, concurrency = 4, nowSec = null, tipHeight = null, fetchImpl = globalThis.fetch }) {
  const from = Number(fromHeight), to = Number(toHeight);
  if (!(from >= 0) || !(to >= from)) throw new Error("bad height range: " + fromHeight + ".." + toHeight);
  const acc = new Map();
  for (const w of watched) acc.set(w.address, { address: w.address, receivedAtomic: 0n, lockedAtomic: 0n, lockedUntil: null, lockedTxids: [], txids: [], bestHeight: null, outputs: 0, viewKeyForm: null });
  const heights = [];
  for (let h = from; h <= to; h++) heights.push(h);
  const missingHeights = [];

  // Bounded parallelism: the node is a shared resource and blocks are independent.
  let cursor = 0;
  const worker = async () => {
    while (cursor < heights.length) {
      const h = heights[cursor++];
      try {
        const block = await fetchBlock(daemonUrl, h, fetchImpl);
        const hashes = block.json ? (typeof block.json === "string" ? JSON.parse(block.json) : block.json).tx_hashes || [] : [];
        if (!hashes.length) continue;
        const txs = await fetchTransactions(daemonUrl, hashes, fetchImpl);
        for (const tx of txs) {
          for (const hit of matchTransaction(tx, watched, { height: h, tipHeight: tipHeight === null || tipHeight === undefined ? to : tipHeight, nowSec })) {
            const a = acc.get(hit.address);
            if (!a) continue;
            if (hit.viewKeyForm) a.viewKeyForm = hit.viewKeyForm;   // what matched - this goes to the log
            const lockedHere = !!(hit.unlock && hit.unlock.locked);
            const hash = String(tx.tx_hash || "").replace(/^0x/, "");
            for (const o of hit.outputs) {
              // AN UNVERIFIED AMOUNT IS NOT MONEY. A node can alter ecdhInfo.amount; until the Pedersen
              // commitment confirms it, the figure is not added to any sum.
              const amount = o.amountVerified ? (o.amountAtomic || 0n) : 0n;
              // A LOCKED OUTPUT IS NOT AN ARRIVAL. Its transfer shows in txids (money is on the address) but the
              // sum does NOT go into receivedAtomic: else 'ready' would allow claiming ETH against locked XMR.
              if (lockedHere) {
                a.lockedAtomic += amount;
                if (hash && !a.lockedTxids.includes(hash)) a.lockedTxids.push(hash);
                if (laterBoundary(hit.unlock) > laterBoundary(a.lockedUntil)) a.lockedUntil = hit.unlock;
              } else {
                a.receivedAtomic += amount;
                a.outputs += 1;
              }
              if (hash && !a.txids.includes(hash)) a.txids.push(hash);
              if (a.bestHeight === null || h > a.bestHeight) a.bestHeight = h;
            }
          }
        }
      } catch (e) {
        // A BLOCK THAT COULD NOT BE READ IS NOT A BLOCK WITH NO MONEY. Keep its height so the caller can say the
        // range is partial instead of treating a smaller sum as complete.
        missingHeights.push(h);
        log({ event: "indexer_block_error", height: h, error: String(e.message).slice(0, 160) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, heights.length)) }, worker));
  const missing = [...new Set(missingHeights)].sort((a, b) => a - b);
  return {
    fromHeight: from,
    toHeight: to,
    results: Array.from(acc.values()),
    complete: missing.length === 0,
    missingHeights: missing,
    ...(missing.length ? { incompleteReason: "blocks-unreadable" } : {}),
  };
}

