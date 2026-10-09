// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/halfenc.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Transferring a key half: an encrypted half fit for publishing on chain.
// WHAT THIS IS. A half x is sent so that: third parties cannot read it (the mask comes from an ECDH shared secret
// with the recipient); THE RECIPIENT can check that the ciphertext holds the half matching the published point X by
// the simple equality x*G == X, with no separate ZK proof; and the data fits on chain.
// THIS IS OUR COMPOSITION, not from the paper: instead of an ECDSA adaptor signature we use ECDH + mask + equality
// check. The primitives are @noble/curves; the composition is ours.
// THE ADAPTOR-SIGNATURE DECISION IS MADE: NOT USED. Revealing the half goes by keccak commit/reveal (commitments
// before money, the contract verifies the half hash), and here the half is sent encrypted.
// IMPORTANT: the primitives are audited, THIS implementation is not.
// LOCKED UNTIL EXPLICIT PERMISSION: the encrypted-half envelope is not used in the live flow, and a dead key path
// nobody tested in a swap is locked. SEALING AND OPENING (seal/open) ARE LOCKED, NOT THE CONSTRUCTOR: the
// constructor is called by the live flow, so locking it would break the working path.
//
//
//
//

//
// PERMISSION IS GIVEN EXPLICITLY: globalThis.ARRAKIS_ALLOW_HALFENC = true (only a check sets it, with a separate locked case).
export const HALFENC_LOCK_REASON =
  "halfenc is locked: the sealed-half envelope is not part of the live flow (keccak commit/reveal replaced it). " +
  "Set globalThis.ARRAKIS_ALLOW_HALFENC = true to work with it in a test or a spike.";

export function halfencUnlocked() {
  return globalThis.ARRAKIS_ALLOW_HALFENC === true;
}

export function createHalfEnc({ secp256k1, ed25519, keccak256, randomBytes }) {
  const ED_ORDER = ed25519.Point.Fn.ORDER;
  const SEC_ORDER = secp256k1.Point.Fn.ORDER;
  const LIMIT = ED_ORDER < SEC_ORDER ? ED_ORDER : SEC_ORDER;   // mask within the smaller order

  function bytesToBig(b) { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; }
  function randScalar(limit) {
    for (let i = 0; i < 256; i++) {
      const v = bytesToBig(randomBytes(32));
      if (v > 0n && v < limit) return v;
    }
    throw new Error("randScalar: failed in 256 attempts");
  }
  const bigToHex = (v) => v.toString(16).padStart(64, "0");

  // The encryption recipient key: published in advance and unrelated to the spend half.
  function recipientKeyPair() {
    const priv = randScalar(SEC_ORDER);
    return { priv, pub: secp256k1.Point.BASE.multiply(priv).toHex() };
  }

  // The mask comes from the ECDH shared secret: the sender via its ephemeral pair and the recipient key, the
  // recipient via its private key and the ephemeral point. Same formula.
  function maskFrom(sharedPointHex, context) {
    const h = keccak256(Uint8Array.from(Buffer.concat([
      Buffer.from(sharedPointHex.replace(/^0x/, ""), "hex"),
      Buffer.from(context || "", "utf8"),
    ])));
    return bytesToBig(h) % LIMIT;
  }

  // SEAL: half x -> a publishable envelope for the recipient.
  function seal(x, recipientPubHex, context) {
    // LOCK ON THE ENVELOPE ITSELF: only the dead branch reaches it, so it cannot be called "just in case".
    if (!halfencUnlocked()) throw new Error(HALFENC_LOCK_REASON);
    if (!(x > 0n && x < LIMIT)) throw new Error("seal: half outside min(l, n)");
    const recipient = secp256k1.Point.fromHex(recipientPubHex.replace(/^0x/, ""));
    const ephPriv = randScalar(SEC_ORDER);
    const ephPub = secp256k1.Point.BASE.multiply(ephPriv);
    const shared = recipient.multiply(ephPriv);                     // ECDH on the sender
    const mask = maskFrom(shared.toHex(), context);
    // All hex fields are normalised: 0x prefix, lowercase. Else the envelope and the unpacked result would differ
    // in representation of the same bytes.
    const canon = (h) => "0x" + String(h).replace(/^0x/i, "").toLowerCase();
    return {
      recipient: canon(recipientPubHex),   // to whom it is addressed
      ephemeral: canon(ephPub.toHex()),    // ephemeral point, needed by the recipient
      masked: "0x" + bigToHex((x + mask) % LIMIT),   // masked scalar
      context: context || "",
    };
  }

  // OPEN: the recipient restores the half and CHECKS it against the published point.
  function open(sealed, recipientPriv, publicPointHex) {
    // LOCK ON OPEN TOO: the second half of the same dead branch.
    if (!halfencUnlocked()) return { ok: false, reason: HALFENC_LOCK_REASON };
    if (!sealed || !sealed.ephemeral || !sealed.masked) return { ok: false, reason: "incomplete envelope" };
    const eph = secp256k1.Point.fromHex(sealed.ephemeral.replace(/^0x/, ""));
    const shared = eph.multiply(recipientPriv);                      // ECDH on the recipient
    const mask = maskFrom(shared.toHex(), sealed.context);
    const x = (BigInt(sealed.masked) - mask + LIMIT) % LIMIT;
    if (x === 0n) return { ok: false, reason: "restored zero" };
    if (!publicPointHex) return { ok: true, x };
    // Check the binding "the ciphertext holds exactly this half": x*G must equal the published point.
    const expect = ed25519.Point.BASE.multiply(x).toHex();
    const got = ed25519.Point.fromHex((publicPointHex.startsWith("0x") ? publicPointHex.slice(2) : publicPointHex)).toHex();
    if (expect !== got) return { ok: false, reason: "the ciphertext holds a different half" };
    return { ok: true, x };
  }

  // The commitment for the contract: keccak256 of the envelope bytes. It lives inside the factory, with the hash
  // passed in from outside.
  function sealedCommitmentOf(hexBytes) {
    const h = keccak256(hexToBytesArr(hexBytes));
    return "0x" + bytesToHexStr(h);
  }

  return { LIMIT, recipientKeyPair, seal, open, packSealed, unpackSealed, sealedCommitmentOf };
}

// --- Envelope byte format ---------------------------------------------------------------
//
// The contract needs BYTES: their keccak256 goes into the order's sealedCommitment and the same bytes go into
// calldata at lock(). The format is fixed, because the commitment depends on it: any other layout changes the
// hash and the lock is rejected.
//
//   0        : format version (1)
//   1..33    : encryption recipient public key (33 bytes, compressed secp256k1)
//   34..66   : sender ephemeral point (33 bytes, compressed)
//   67..98   : masked scalar (32 bytes, big-endian)
//   99       : context length in bytes (0..255)
//   100..    : order context in UTF-8
//
// Total 100 + context length bytes. JSON is deliberately not used: key order and number formatting would give
// different bytes for the same content, and the commitment requires uniqueness.
const FORMAT_VERSION = 1;

function bytesToHexStr(b) {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function utf8(str) {
  const s = String(str == null ? "" : str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}
function fromUtf8(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[++i] & 0x3f));
    else s += String.fromCharCode(((c & 0x0f) << 12) | ((b[++i] & 0x3f) << 6) | (b[++i] & 0x3f));
  }
  return s;
}
const hexToBytesArr = (h) => {
  const s = String(h || "").replace(/^0x/i, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};

// Envelope -> bytes (hex). These bytes are hashed into the commitment and go into calldata.
export function packSealed(sealed) {
  if (!sealed || !sealed.recipient || !sealed.ephemeral || !sealed.masked) throw new Error("packSealed: incomplete envelope");
  const recipient = hexToBytesArr(sealed.recipient);
  const ephemeral = hexToBytesArr(sealed.ephemeral);
  if (recipient.length !== 33) throw new Error("packSealed: recipient key must be 33 bytes (compressed point)");
  if (ephemeral.length !== 33) throw new Error("packSealed: ephemeral point must be 33 bytes (compressed)");
  const masked = BigInt(sealed.masked).toString(16).padStart(64, "0");
  const ctx = utf8(sealed.context);
  if (ctx.length > 255) throw new Error("packSealed: context longer than 255 bytes");
  return "0x" + bytesToHexStr(Uint8Array.of(FORMAT_VERSION))
    + bytesToHexStr(recipient) + bytesToHexStr(ephemeral) + masked
    + ctx.length.toString(16).padStart(2, "0") + bytesToHexStr(ctx);
}

// Bytes -> envelope. Checks the version and lengths; corrupted data is not parsed silently.
export function unpackSealed(hexBytes) {
  const b = hexToBytesArr(hexBytes);
  if (b.length < 100) throw new Error("unpackSealed: envelope shorter than 100 bytes");
  if (b[0] !== FORMAT_VERSION) throw new Error("unpackSealed: unknown format version: " + b[0]);
  const ctxLen = b[99];
  if (b.length !== 100 + ctxLen) throw new Error("unpackSealed: length does not match the one in the context");
  return {
    recipient: "0x" + bytesToHexStr(b.slice(1, 34)),
    ephemeral: "0x" + bytesToHexStr(b.slice(34, 67)),
    masked: "0x" + bytesToHexStr(b.slice(67, 99)),
    context: fromUtf8(b.slice(100)),
  };
}

