// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/scan.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

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
export { UNLOCK_TIME_BLOCK_MAX, unlockStateOf, laterBoundary };

export function keccak(bytes) { return keccak_256(bytes); }

// Order of the edwards25519 group (l). Taken from the curve, not a remembered number: a wrong constant would
// corrupt the scalar, the derivation and the sum - an "invisible arrival".
export const ED_ORDER = ed25519.Point.CURVE().n;

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
export function txPublicKeyFromExtra(extra) {
  const b = Array.isArray(extra) ? Uint8Array.from(extra) : hexToBytes(extra);
  let i = 0;
  while (i < b.length) {
    const tag = b[i];
    if (tag === 0x01) return bytesToHex(b.subarray(i + 1, i + 33));
    if (tag === 0x02) { i += 1 + b[i + 1]; continue; }          // nonce
    if (tag === 0x00) { i += 1 + b[i + 1]; continue; }          // additional public key
    return null;                                                 // unknown tag: we do not guess
  }
  return null;
}

// Amount decryption. version: 2 = current scheme (xor of the first 8 bytes), 1 = old (scalar subtraction).
//
// THE SECRET IS THE DERIVATION SCALAR, NOT THE DERIVATION. Easy to get wrong: both are 32 bytes, but what goes
// into genAmountEncodingFactor is the scalar (derivation_to_scalar), written LEAST-SIGNIFICANT first. With the
// derivation the result looks plausible and is WRONG (checked on live numbers).
export function decodeAmount(ecdhAmountHex, scalarLE, rctVersion) {
  const enc = hexToBytes(ecdhAmountHex);
  if (Number(rctVersion) >= 2) {
    // Multiplier: keccak("amount" || scalar_LE), 38 bytes - order checked against the source.
    const label = new TextEncoder().encode("amount");
    const buf = new Uint8Array(label.length + scalarLE.length);
    buf.set(label, 0); buf.set(scalarLE, label.length);
    const factor = keccak(buf);
    const out = enc.slice();
    for (let i = 0; i < 8; i++) out[i] ^= factor[i];             // xor of the FIRST 8 bytes only
    // And again LEAST-SIGNIFICANT first: Monero amounts are little-endian too.
    return scalarFromBytesLE(out);
  }
  const s2 = hashToScalar(hexToBytes(hashToScalar(hexToBytes(bytesToHex(rctVersion === 1 ? scalarLE : scalarLE))).toString(16).padStart(64, "0")));
  const amt = BigInt("0x" + bytesToHex(enc)) % ED_ORDER;
  return (amt - s2 + ED_ORDER) % ED_ORDER;
}

// MAIN: parse a transaction and return OUR outputs (their indices, keys and amounts).
// txView - { txPublicKey, vout: [{key, index}], ecdhAmounts: [...], rctVersion }
export function findOurOutputs({ txPublicKey, viewSecretHex, spendPubHex, outputs, ecdhAmounts = [], rctVersion = 2 }) {
  if (!txPublicKey) throw new Error("the transaction has no public key (extra tag 0x01) - nothing to parse");
  // The key form is tried EXPLICITLY; the winner's name goes up so the log shows what was used. If none matched,
  // the first meaningful form is returned, not nothing.
  const usable = viewSecretCandidates(viewSecretHex).filter(([, v]) => v !== null);
  const first = usable[0] || ["unparsed", null];
  for (const [form, secret] of usable) {
    const derivation = keyDerivation(txPublicKey, secret);
    const found = [];
    for (const o of outputs) {
      const scalar = hashToScalar(derivation, varint(o.index));
      const derived = derivedOutputKey(derivation, o.index, spendPubHex);
      if (derived.toLowerCase() === String(o.key).toLowerCase()) {
        // The amount decryption uses THIS output's SCALAR, least-significant first.
        const amount = ecdhAmounts[o.index] ? decodeAmount(ecdhAmounts[o.index], scalarToBytesLE(scalar), rctVersion) : null;
        found.push({ index: o.index, key: o.key, amountAtomic: amount });
      }
    }
    if (found.length) return { derivation: bytesToHex(derivation), outputs: found, viewKeyForm: form };
  }
  return {
    derivation: first[1] === null ? null : bytesToHex(keyDerivation(txPublicKey, first[1])),
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


export async function fetchBlock(daemonUrl, height) {
  const res = await fetch(`${String(daemonUrl).replace(/\/+$/, "")}/json_rpc`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "block", method: "get_block", params: { height } }),
  });
  const j = await res.json();
  if (!j.result) throw new Error(`block ${height} not received: ${j.error ? j.error.message : "empty answer"}`);
  return j.result;
}

// Transactions by hash list. We hit the PATH /get_transactions, not /json_rpc: over JSON-RPC this method
// silently returns empty, which looks like "no transactions".
export async function fetchTransactions(daemonUrl, hashes) {
  if (!hashes.length) return [];
  const res = await fetch(`${String(daemonUrl).replace(/\/+$/, "")}/get_transactions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ txs_hashes: hashes, decode_as_json: true }),
  });
  const j = await res.json();
  const wrappers = j.txs || [];
  // HASH AND HEIGHT LIVE IN THE WRAPPER, not in the parsed body: as_json omits them. Without this stitching a
  // "found transfer" would have neither hash nor height - useless to the caller, yet everything would look successful.
  return (j.txs_as_json || []).map((s, i) => {
    const body = typeof s === "string" ? JSON.parse(s) : s;
    const w = wrappers[i] || {};
    body.tx_hash = w.tx_hash || body.tx_hash || null;
    body.block_height = w.block_height ?? null;
    body.confirmations = w.confirmations ?? null;
    body.in_pool = w.in_pool ?? null;
    return body;
  });
}

// Parsing one transaction against the watched addresses. watched: [{ address, viewSecret, spendPub }] - viewSecret
// is taken as a number, LE-hex or BE-hex. The result carries viewKeyForm: the form name that matched.
export function matchTransaction(tx, watched, { height = null, nowSec = null } = {}) {
  const out = [];
  const txPublicKey = txPublicKeyFromExtra(tx.extra);
  if (!txPublicKey) return out;                       // no key in extra - nothing to look at
  // WHETHER THE OUTPUT IS LOCKED IS DECIDED HERE, ONCE PER TRANSACTION: all its outputs carry one unlock_time.
  // A normal transaction (unlock_time = 0) goes as before; the height comes from the block holding the transfer.
  const blockHeight = height === null || height === undefined ? (tx.block_height ?? null) : height;
  const unlock = unlockStateOf(tx.unlock_time, { height: blockHeight, nowSec });
  const keyOf = (o) => ((o.target || {}).tagged_key || o.target || {}).key;
  const outputs = (tx.vout || []).map((o, i) => ({ index: i, key: keyOf(o) }));
  const ecdhAmounts = ((tx.rct_signatures || {}).ecdhInfo || []).map((e) => e.amount);
  const rctVersion = (tx.rct_signatures || {}).type || 2;
  for (const w of watched) {
    const r = findOurOutputs({
      txPublicKey, viewSecretHex: w.viewSecret, spendPubHex: w.spendPub,
      outputs, ecdhAmounts, rctVersion: Number(rctVersion) >= 2 ? 2 : 1,
    });
    if (r.outputs.length) out.push({ address: w.address, index: w.index ?? null, outputs: r.outputs, derivation: r.derivation, viewKeyForm: r.viewKeyForm, unlockTime: Number(tx.unlock_time) || 0, unlock });
  }
  return out;
}

// Range scan. Returns per address the sum (receivedAtomic - only the UNLOCKED), hashes, the locked sum
// (lockedAtomic) with its boundary (lockedUntil) and the best (highest) height of a found output.
export async function scanRange({ daemonUrl, fromHeight, toHeight, watched, log = () => {}, concurrency = 4, nowSec = null }) {
  const from = Number(fromHeight), to = Number(toHeight);
  if (!(from >= 0) || !(to >= from)) throw new Error("bad height range: " + fromHeight + ".." + toHeight);
  const acc = new Map();
  for (const w of watched) acc.set(w.address, { address: w.address, receivedAtomic: 0n, lockedAtomic: 0n, lockedUntil: null, lockedTxids: [], txids: [], bestHeight: null, outputs: 0, viewKeyForm: null });
  const heights = [];
  for (let h = from; h <= to; h++) heights.push(h);

  // Bounded parallelism: the node is a shared resource and blocks are independent.
  let cursor = 0;
  const worker = async () => {
    while (cursor < heights.length) {
      const h = heights[cursor++];
      try {
        const block = await fetchBlock(daemonUrl, h);
        const hashes = block.json ? (typeof block.json === "string" ? JSON.parse(block.json) : block.json).tx_hashes || [] : [];
        if (!hashes.length) continue;
        const txs = await fetchTransactions(daemonUrl, hashes);
        for (const tx of txs) {
          for (const hit of matchTransaction(tx, watched, { height: h, nowSec })) {
            const a = acc.get(hit.address);
            if (!a) continue;
            if (hit.viewKeyForm) a.viewKeyForm = hit.viewKeyForm;   // what matched - this goes to the log
            const lockedHere = !!(hit.unlock && hit.unlock.locked);
            const hash = String(tx.tx_hash || "").replace(/^0x/, "");
            for (const o of hit.outputs) {
              const amount = o.amountAtomic || 0n;
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
        log({ event: "indexer_block_error", height: h, error: String(e.message).slice(0, 160) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, heights.length)) }, worker));
  return { fromHeight: from, toHeight: to, results: Array.from(acc.values()) };
}

