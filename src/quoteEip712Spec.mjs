// EIP-712 TYPED DATA FOR AN ORDER QUOTE - THE SPEC, SHARED BY THE NODE AND THE SDK.
//
// WHY THE SAME FILE EXISTS TWICE. The node (rfq/) runs on the provider's machine and never sees www/ or sdk/:
// it has to start on its own. The SDK is a package and never sees rfq/. So the spec is embodied twice and the
// two copies are pinned by sha256 (tools/check-quote-eip712.mjs), exactly like the order context. A divergence
// here would mean one side signs what the other does not verify - the failure this format exists to prevent.
//
// WHAT IS BOUND, AND WHY EACH FIELD IS INSIDE THE DIGEST (changing any of them breaks recovery):
//   provider, quoteKey   - whose quote it is and which key signed it. For a solo maker the two are equal; a
//                          delegated key is a different address, and the registry maps it back to the provider
//                          (the chain check itself is a later stage; here both values are only bound).
//   registry             - the maker registry named by the order. Bound now so a quote cannot be replayed
//                          from one registry into another even before anyone reads `providerOf`.
//   cashier              - the fee vault of the order (issue #103): the fee destination is part of the SIGNED
//                          terms, so the factory no longer mints one vault per maker and the fee is not
//                          scattered across them. Bound so a relayer cannot retarget where the fee accrues.
//   locker, claimer,     - the order conditions: the same terms the DLEQ context binds and the escrow's
//   amount, readyBy,       termsHash covers. Binding them means the quote is usable for THESE terms only.
//   t1, salt
//   xmrAmount            - the XMR side of the deal, in ATOMIC units (#110 step 3). It is IN this list AND in the
//                          chain's list (OrderQuote.sol) at once: the field set is ONE, so the provider's
//                          signature covers exactly the XMR the chain verifies at order birth. Earlier this field
//                          rode in the quote object OUTSIDE the digest on purpose - a field the chain could not
//                          see must not be signed; once the contract learned it, it moved in here together with
//                          the typehash, the depositor form and the independent vector.
//   commitHalfClaimer,   - the provider's own commitment and ed25519 spend point: both are inputs to the
//   edPointClaimer         escrow's termsHash, so they are bound and cannot be swapped for another order's.
//   chainId              - bound in the domain AND in the message. A quote signed for one network does not
//                          verify on another.
//   feeBps, fee,         - the provider's commission: the rate, the amount in wei and the recipient. Shown to
//   feeRecipient           the customer before signing (#76) and frozen by the signature afterwards.
//   validUntil           - the quote's own expiry, IN SECONDS (the order's readyBy/t1 and block.timestamp
//                          scale): a quote past it is refused regardless of the price.
//   nonce                - replay protection: the very same signed quote cannot be presented twice.
//
// The domain's verifyingContract is the escrow FACTORY taken from the order: the contract that will verify the
// quote in EVM (stage 2). The type order, the domain name and the version are part of the protocol - they may
// change only together with the quote version.
export const ORDER_QUOTE_DOMAIN_NAME = "NinseiEscrowFactory";
export const ORDER_QUOTE_DOMAIN_VERSION = "1";
// 8: the signed EIP-712 field set grew `xmrAmount` (#110 step 3) - the XMR the level walk gives is now covered by
// the provider's signature and verified ON CHAIN. This is the request-shape generation label, and it moves WITH the
// field set (see the note above). The DOMAIN name and the domain version string are UNCHANGED by it: they name the
// domain (the factory address and the chain), which did not change. So here the label and the domain version string
// move apart, and that is deliberate - the label tracks the message shape, not the domain identity.
export const ORDER_QUOTE_VERSION = 8;

// The domain type string is assembled from parts ON PURPOSE. A single literal of it is a phrase of several
// space-separated words, and the SDK check reads such literals as user-facing text. Do not "simplify" it.
const DOMAIN_TYPE_PARTS = ["EIP712Domain(", "string name,", "string version,", "uint256 chainId,", "address verifyingContract)"];
export const EIP712_DOMAIN_TYPE = DOMAIN_TYPE_PARTS.join("");

// The message, field by field and IN THIS ORDER. The order is the protocol: a rearrangement gives another
// digest, and every already-issued quote stops verifying at once.
export const ORDER_QUOTE_FIELDS = [
  ["provider", "address"],
  ["quoteKey", "address"],
  ["registry", "address"],
  ["cashier", "address"],
  ["locker", "address"],
  ["claimer", "address"],
  ["amount", "uint256"],
  ["readyBy", "uint64"],
  ["t1", "uint64"],
  ["salt", "bytes32"],
  ["commitHalfClaimer", "bytes32"],
  ["edPointClaimer", "bytes32"],
  ["chainId", "uint256"],
  ["feeBps", "uint256"],
  ["fee", "uint256"],
  ["feeRecipient", "address"],
  ["validUntil", "uint64"],
  ["nonce", "uint256"],
  ["xmrAmount", "uint256"],
];
export const ORDER_QUOTE_TYPE = "OrderQuote(" + ORDER_QUOTE_FIELDS.map((f) => f[1] + " " + f[0]).join(",") + ")";

// Error tokens are SINGLE WORDS: the SDK forbids multi-word string literals in sdk/src (they would read as
// user-facing text), so the spec names its failures by token and the caller maps them to its own codes.
const boom = (token) => { throw new Error(token); };

const utf8 = (s) => new TextEncoder().encode(String(s));
const concat = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) { out.set(a, at); at += a.length; }
  return out;
};
const hexToBytes = (hex) => {
  const h = String(hex).replace(/^0x/, "");
  if (h.length % 2) boom("eip712-odd-hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) boom("eip712-bad-hex");
    out[i] = byte;
  }
  return out;
};
const bytesToHex = (bytes) => {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
};
const asBigInt = (v) => {
  if (typeof v === "bigint") return v;
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  boom("eip712-bad-number");
};
const wordUint = (v, bits) => {
  const n = asBigInt(v);
  if (n < 0n) boom("eip712-negative");
  if (n >= (1n << BigInt(bits))) boom("eip712-overflow");
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
// FORM IS NORMALISED, NOT DEMANDED. The quote carries ed25519 points WITHOUT the 0x prefix (that is how the
// node writes them, see rfq/orderAddress.mjs), while the contract returns them WITH one. Both are the same
// bytes, so both are accepted and encoded identically - otherwise the node could not sign its own quote.
const wordAddress = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(s)) boom("eip712-bad-address");
  const out = new Uint8Array(32);
  out.set(hexToBytes(s.replace(/^0x/, "")), 12);
  return out;
};
const wordBytes32 = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s)) boom("eip712-bad-bytes32");
  return hexToBytes(s.replace(/^0x/, ""));
};
const encodeField = (type, value) => {
  if (type === "address") return wordAddress(value);
  if (type === "bytes32") return wordBytes32(value);
  if (type === "uint64") return wordUint(value, 64);
  if (type === "uint256") return wordUint(value, 256);
  boom("eip712-bad-type");
};

// The fields a signed set cannot do without. An absent field is not "probably zero": the caller must refuse,
// not verify a partial set (that is the rule the old signatureVerified witness carried).
export const quoteMissingFields = (quote) => {
  const missing = [];
  for (const [name] of ORDER_QUOTE_FIELDS) {
    const v = quote ? quote[name] : undefined;
    if (v === undefined || v === null || v === "") missing.push(name);
  }
  if (quote && (quote.factory === undefined || quote.factory === null || quote.factory === "")) missing.push("factory");
  if (quote && (quote.signature === undefined || quote.signature === null || quote.signature === "")) missing.push("signature");
  return missing;
};

// The EIP-712 domain. chainId and verifyingContract are taken LIVE from the quote, not cached: the digest must
// change when either does, otherwise a quote could move between networks or contracts.
export function quoteDomainSeparator({ crypto, quote }) {
  return crypto.keccak256(concat(
    crypto.keccak256(utf8(EIP712_DOMAIN_TYPE)),
    crypto.keccak256(utf8(ORDER_QUOTE_DOMAIN_NAME)),
    crypto.keccak256(utf8(ORDER_QUOTE_DOMAIN_VERSION)),
    wordUint(quote.chainId, 256),
    wordAddress(quote.factory),
  ));
}

export function quoteStructHash({ crypto, quote }) {
  const parts = [crypto.keccak256(utf8(ORDER_QUOTE_TYPE))];
  for (const [name, type] of ORDER_QUOTE_FIELDS) parts.push(encodeField(type, quote ? quote[name] : undefined));
  return crypto.keccak256(concat(...parts));
}

// The digest the wallet key signs. Anything that changes here changes the recovered address.
export function quoteDigest({ crypto, quote }) {
  return crypto.keccak256(concat(Uint8Array.from([0x19, 0x01]), quoteDomainSeparator({ crypto, quote }), quoteStructHash({ crypto, quote })));
}

// Signature on the wire: r || s || v with v in {27, 28} - the shape ecrecover (and the registry contract)
// expects. The curve library returns [recovery, r, s], so the order is normalised here once, not at each call.
export function signQuoteDigest({ crypto, digest, privateKey }) {
  const sig = crypto.secp256k1.sign(digest, hexToBytes(privateKey), { format: "recovered", prehash: false });
  if (sig.length !== 65) boom("eip712-bad-signature");
  const recovery = Number(sig[0]);
  if (recovery !== 0 && recovery !== 1) boom("eip712-bad-recovery");
  const out = new Uint8Array(65);
  out.set(sig.slice(1, 33), 0);
  out.set(sig.slice(33, 65), 32);
  out[64] = 27 + recovery;
  return bytesToHex(out);
}

// Recover the signer without knowing it beforehand. Returns a lowercase 0x address, or null when the quote is
// not verifiable at all (missing fields, malformed signature, unusable domain) - the caller turns that into a
// named refusal, never into consent.
export function recoverQuoteKey({ crypto, quote }) {
  try {
    if (quoteMissingFields(quote).length) return null;
    const sig = hexToBytes(String(quote.signature).replace(/^0x/, ""));
    if (sig.length !== 65) return null;
    let v = sig[64];
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const digest = quoteDigest({ crypto, quote });
    const pub = crypto.secp256k1.Signature.fromBytes(concat(sig.slice(0, 32), sig.slice(32, 64)))
      .addRecoveryBit(v).recoverPublicKey(digest);
    const raw = pub.toBytes(false);
    return bytesToHex(crypto.keccak256(raw.slice(1)).slice(12));
  } catch {
    return null;
  }
}
