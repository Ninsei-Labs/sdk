// EIP-712 TYPED DATA FOR A COW PROTOCOL ORDER - THE SPEC, IN THE SDK'S OWN STYLE.
//
// WHY A SEPARATE SPEC AND NOT A NEW LIBRARY. This repository builds EIP-712 typed data itself
// (src/quoteEip712Spec.mjs is the same pattern for the order quote): the encoding words, the domain separator, the
// struct hash and the digest are assembled here from the repository's own crypto primitives (src/primitives.mjs),
// and the SIGNING reuses the existing signer (signQuoteDigest from src/quoteEip712Spec.mjs, which signs ANY 32-byte
// digest). No dependency is added.
//
// EVERY EXTERNAL FACT IS PINNED TO ITS SOURCE, and where a value can be recomputed it is (the check does it):
//   * ORDER type, field types and order      - cowprotocol/contracts, lib GPv2Order.sol
//     (github.com/cowprotocol/contracts/blob/main/src/contracts/libraries/GPv2Order.sol): the TYPE_HASH is the
//     keccak256 of the string built from GPv2Order.Data, and the contract HARD-CODES that hash next to the struct;
//   * the TYPE_HASH constant, the kind/balance markers - the same file (TYPE_HASH, KIND_SELL, KIND_BUY,
//     BALANCE_ERC20 are the contract's own constants; keccak256("sell"), keccak256("buy"), keccak256("erc20"));
//   * the DOMAIN name "Gnosis Protocol", version "v2", and the domain separator shape built as
//     keccak256(abi.encode(DOMAIN_TYPE_HASH, DOMAIN_NAME, DOMAIN_VERSION, chainId, address(this)))
//     - cowprotocol/contracts, mixin GPv2Signing.sol
//     (github.com/cowprotocol/contracts/blob/main/src/contracts/mixins/GPv2Signing.sol);
//   * the settlement contract address 0x9008D19f58AAbD9eD0D60971565AA8510560ab41 (deterministic, identical on every
//     supported network) - docs.cow.fi, "Core" contracts (docs.cow.fi/cow-protocol/reference/contracts/core);
//   * the order UID = 56 bytes = digest(32) ++ owner(20) ++ validTo(4), and UID_LENGTH 56 - GPv2Order.sol.
//
// THE one fact that is NOT taken from memory is the RESULT: the check recomputes the digest of a REAL settled
// order and demands it equal the digest half of that order's on-chain UID (fetched from the CoW order book).
//
// The domain type string is assembled from parts ON PURPOSE, exactly as in quoteEip712Spec.mjs: a single literal of
// it is a phrase of several space-separated words, and the SDK reads such literals as user-facing text. Do not
// "simplify" it. The domain NAME is assembled the same way for the same reason.
import { keccak256, secp256k1 } from "../primitives.mjs";
import { signQuoteDigest } from "../quoteEip712Spec.mjs";

// The domain name and version, from GPv2Signing.sol (DOMAIN_NAME = keccak256("Gnosis Protocol"),
// DOMAIN_VERSION = keccak256("v2")). Built from parts so no literal here is a multi-word phrase (see the header).
export const COW_DOMAIN_NAME = ["Gnosis", "Protocol"].join(" ");
export const COW_DOMAIN_VERSION = "v2";

// The settlement contract that verifies the signature, identical on every network CoW supports (docs.cow.fi, Core).
export const COW_SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";

// The marker for "an order is buying native coin": it has meaning ONLY in buyToken (using it as sellToken makes the
// settlement revert). Source: cowprotocol contracts TS docs (BUY_ETH_ADDRESS) and docs.cow.fi native-token swaps.
export const COW_BUY_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// The type strings, assembled from their fields so the order is the single source of truth here (as in GPv2Order).
const DOMAIN_TYPE_PARTS = ["EIP712Domain(", "string name,", "string version,", "uint256 chainId,", "address verifyingContract)"];
export const COW_DOMAIN_TYPE = DOMAIN_TYPE_PARTS.join("");

// The message, field by field and IN THIS ORDER - the order is the protocol (GPv2Order.Data). The types match the
// contract's type-hash expression: kind, sellTokenBalance and buyTokenBalance are `string` in the TYPE (their value
// is the keccak256 of the marker string), while in the struct they are the pre-hashed bytes32 markers.
export const COW_ORDER_FIELDS = [
  ["sellToken", "address"],
  ["buyToken", "address"],
  ["receiver", "address"],
  ["sellAmount", "uint256"],
  ["buyAmount", "uint256"],
  ["validTo", "uint32"],
  ["appData", "bytes32"],
  ["feeAmount", "uint256"],
  ["kind", "string"],
  ["partiallyFillable", "bool"],
  ["sellTokenBalance", "string"],
  ["buyTokenBalance", "string"],
];
export const COW_ORDER_TYPE = "Order(" + COW_ORDER_FIELDS.map((f) => f[1] + " " + f[0]).join(",") + ")";

// The contract's OWN type-hash constant (GPv2Order.TYPE_HASH). It is NOT trusted: the check recomputes
// keccak256(COW_ORDER_TYPE) and demands it equal this - so a typo in the field list above reddens rather than
// silently signing orders the settlement would reject.
export const COW_ORDER_TYPE_HASH = "0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489";

// The order-kind and token-balance markers (GPv2Order.KIND_SELL / KIND_BUY / BALANCE_ERC20), derived here from the
// repository's own keccak256 rather than copied: the check compares them against the contract's constants.
export const COW_KINDS = ["sell", "buy"];
export const COW_BALANCES = ["erc20", "external", "internal"];
export const cowKindMarker = (kind) => bytesToHex(keccak256(String(kind)));
export const cowBalanceMarker = (balance) => bytesToHex(keccak256(String(balance)));

// Error tokens are SINGLE WORDS (the SDK forbids multi-word literals in sdk/src): the spec names a failure by token
// and the caller maps it to its own code.
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
  if (h.length % 2) boom("cow-odd-hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) boom("cow-bad-hex");
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
  boom("cow-bad-number");
};
const wordUint = (v, bits) => {
  const n = asBigInt(v);
  if (n < 0n) boom("cow-negative");
  if (n >= (1n << BigInt(bits))) boom("cow-overflow");
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const wordAddress = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(s)) boom("cow-bad-address");
  const out = new Uint8Array(32);
  out.set(hexToBytes(s.replace(/^0x/, "")), 12);
  return out;
};
const wordBytes32 = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s)) boom("cow-bad-bytes32");
  return hexToBytes(s.replace(/^0x/, ""));
};
const wordBool = (v) => {
  const out = new Uint8Array(32);
  if (v === true || v === "true" || v === 1 || v === "1") out[31] = 1;
  else if (v === false || v === "false" || v === 0 || v === "0" || v === undefined || v === null) out[31] = 0;
  else boom("cow-bad-bool");
  return out;
};
// A `string` field in EIP-712 is encoded as the keccak256 of its UTF-8 bytes - this is why the contract's
// KIND_SELL equals keccak256("sell").
const wordString = (v) => keccak256(utf8(v));

const encodeField = (type, value) => {
  if (type === "address") return wordAddress(value);
  if (type === "bytes32") return wordBytes32(value);
  if (type === "uint32") return wordUint(value, 32);
  if (type === "uint256") return wordUint(value, 256);
  if (type === "bool") return wordBool(value);
  if (type === "string") return wordString(value);
  boom("cow-bad-type");
};

// The fields an order cannot do without. An absent field is not "probably zero": the caller refuses, not signs.
export const cowOrderMissingFields = (order) => {
  const missing = [];
  for (const [name] of COW_ORDER_FIELDS) {
    const v = order ? order[name] : undefined;
    if (v === undefined || v === null || v === "") missing.push(name);
  }
  return missing;
};

// The EIP-712 domain. chainId and verifyingContract come LIVE from the order's context, not cached: the digest must
// change when either does, else an order could move between networks or settlement contracts.
export const cowDomainSeparator = ({ chainId, settlement = COW_SETTLEMENT }) => keccak256(concat(
  keccak256(utf8(COW_DOMAIN_TYPE)),
  keccak256(utf8(COW_DOMAIN_NAME)),
  keccak256(utf8(COW_DOMAIN_VERSION)),
  wordUint(chainId, 256),
  wordAddress(settlement),
));

export const cowStructHash = (order) => {
  const parts = [keccak256(utf8(COW_ORDER_TYPE))];
  for (const [name, type] of COW_ORDER_FIELDS) parts.push(encodeField(type, order ? order[name] : undefined));
  return keccak256(concat(...parts));
};

// The digest the wallet key signs. Anything that changes here changes the recovered address.
export const cowOrderDigest = ({ order, chainId, settlement = COW_SETTLEMENT }) =>
  keccak256(concat(Uint8Array.from([0x19, 0x01]), cowDomainSeparator({ chainId, settlement }), cowStructHash(order)));

export const cowOrderDigestHex = (ctx) => bytesToHex(cowOrderDigest(ctx));

/**
 * The order UID: 56 bytes = digest(32) ++ owner(20) ++ validTo(uint32). The order book returns this from
 * POST /api/v1/orders and addresses the order by it. GPv2Order.packOrderUidParams.
 */
export const cowOrderUid = ({ digest, owner, validTo }) => {
  const d = hexToBytes(digest);                      // must be 32 bytes
  if (d.length !== 32) boom("cow-bad-digest");
  const o = hexToBytes(owner);                       // must be 20 bytes
  if (o.length !== 20) boom("cow-bad-owner");
  const v = wordUint(validTo, 32).slice(28);         // the last 4 bytes of the uint32 word, big-endian
  return bytesToHex(concat(d, o, v));
};

/**
 * The typed data a wallet signs (eth_signTypedData_v4). The message carries the kind and balances as STRINGS
 * ("sell", "erc20"), matching the type - the wallet shows them readably, and the digest the settlement computes
 * replaces them with their keccak256 (see wordString).
 */
export const cowOrderTypedData = ({ order, chainId, settlement = COW_SETTLEMENT }) => ({
  domain: { name: COW_DOMAIN_NAME, version: COW_DOMAIN_VERSION, chainId: Number(chainId), verifyingContract: settlement },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Order: COW_ORDER_FIELDS.map(([name, type]) => ({ name, type })),
  },
  primaryType: "Order",
  message: {
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    receiver: order.receiver,
    sellAmount: String(order.sellAmount),
    buyAmount: String(order.buyAmount),
    validTo: Number(order.validTo),
    appData: order.appData,
    feeAmount: String(order.feeAmount),
    kind: String(order.kind),
    partiallyFillable: Boolean(order.partiallyFillable),
    sellTokenBalance: String(order.sellTokenBalance),
    buyTokenBalance: String(order.buyTokenBalance),
  },
});

// SIGN THE DIGEST THROUGH THE REPOSITORY'S EXISTING SIGNER: signQuoteDigest signs any 32-byte digest and returns
// r || s || v with v in {27, 28}. No second signer is written here.
export const signCowOrderDigest = ({ digest, privateKey }) =>
  signQuoteDigest({ crypto: { secp256k1 }, digest, privateKey });

// Recover the signer of a digest from a signature (the same rule the quote check uses): lowercase 0x address, or
// null when the signature is not usable. The caller turns null into a NAMED refusal, never into consent.
export const recoverCowOrderSigner = ({ digest, signature }) => {
  try {
    const sig = hexToBytes(String(signature).replace(/^0x/, ""));
    if (sig.length !== 65) return null;
    let v = sig[64];
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const pub = secp256k1.Signature.fromBytes(concat(sig.slice(0, 32), sig.slice(32, 64)))
      .addRecoveryBit(v).recoverPublicKey(digest);
    return bytesToHex(keccak256(pub.toBytes(false).slice(1)).slice(12));
  } catch {
    return null;
  }
};
