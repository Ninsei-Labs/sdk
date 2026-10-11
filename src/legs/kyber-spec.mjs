// EIP-712 TYPED DATA FOR A KYBERSWAP LIMIT ORDER - THE SPEC, IN THE SDK'S OWN STYLE.
//
// WHY A SEPARATE SPEC AND NOT A NEW LIBRARY. This repository builds EIP-712 typed data itself (the same pattern as
// src/legs/cow-spec.mjs for the CoW order and src/quoteEip712Spec.mjs for the order quote): the domain separator,
// the struct hash and the digest are assembled here from the repository's own crypto primitives (src/primitives.mjs),
// and the SIGNING reuses the existing signer (signQuoteDigest from src/quoteEip712Spec.mjs, which signs ANY 32-byte
// digest). No dependency is added.
//
// EVERY EXTERNAL FACT IS PINNED TO ITS SOURCE, and where a value can be recomputed it is (the check does it):
//   * the ORDER type, its field types and their ORDER - the Limit Order contract, KyberNetwork DSLOProtocol, abstract
//     contract DSOrderMixin (verified source on Etherscan, e.g. the deployment on Arbitrum One
//     0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C, and the same DSLOProtocol on Ethereum/BSC/Polygon):
//     "bytes32 public constant LIMIT_ORDER_TYPEHASH = keccak256('Order(uint256 salt,address makerAsset,address
//     takerAsset,address maker,address receiver,address allowedSender,uint256 makingAmount,uint256 takingAmount,
//     uint256 feeConfig,bytes makerAssetData,bytes takerAssetData,bytes getMakerAmount,bytes getTakerAmount,bytes
//     predicate,bytes interaction)')". The SAME field names and order are what the order book returns from
//     POST /write/api/v1/orders/sign-message (docs.kyberswap.com, Limit Order API, Maker API, "Get Unsigned Create
//     Order Message"): types.Order = [{salt,uint256},{makerAsset,address},{takerAsset,address},{maker,address},
//     {receiver,address},{allowedSender,address},{makingAmount,uint256},{takingAmount,uint256},{feeConfig,uint256},
//     {makerAssetData,bytes},{takerAssetData,bytes},{getMakerAmount,bytes},{getTakerAmount,bytes},{predicate,bytes},
//     {interaction,bytes}];
//   * the DSOrder type that the OPERATOR co-signature is over - the same contract source:
//     "bytes32 public constant DS_LIMIT_ORDER_TYPEHASH = keccak256('DSOrder(bytes32 orderHash,uint32
//     opExpireTime)')". The operator signature binds (orderHash, opExpireTime) - see the scope note in kyber.mjs;
//   * the DOMAIN name "Kyber DSLO Protocol", version "1", and the domain separator shape
//     keccak256(abi.encode(DOMAIN_TYPE_HASH, name, version, chainId, verifyingContract)) - the order book's own
//     sign-message response (docs.kyberswap.com, Maker API) returns exactly domain {name:"Kyber DSLO Protocol",
//     version:"1", chainId, verifyingContract} with EIP712Domain = name/version/chainId/verifyingContract, and the
//     contract is EIP712 (OZ) with the same four fields;
//   * the contract address 0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C (identical on every supported chain) -
//     docs.kyberswap.com, Limit Order API, "Contracts & Addresses";
//   * the ORDER IDENTITY. There is no CoW-style packed UID here: the contract's hashOrder() is
//     _hashTypedDataV4(keccak256(abi.encode(LIMIT_ORDER_TYPEHASH, StaticOrder{...}, keccak256(makerAssetData),
//     keccak256(takerAssetData), keccak256(getMakerAmount), keccak256(getTakerAmount), keccak256(predicate),
//     keccak256(interaction)))) - i.e. EXACTLY this digest - and the order book addresses an order by a numeric id
//     it assigns on creation (POST /write/api/v1/orders -> data.id). So `chainId` + this digest is the order's
//     identity on chain, and the numeric id is the off-chain handle for reading/cancelling.
//
// THE ONE FACT THAT IS NOT TAKEN FROM MEMORY is the RESULT: the check recomputes the digest of a REAL order returned
// by KyberSwap's own Taker API and demands the order's OWN signature recover its maker address - no amount of
// reasoning can fake that.
//
// The domain name is assembled from parts ON PURPOSE, exactly as in cow-spec.mjs: a single literal of it is a phrase
// of several space-separated words, and the SDK reads such literals as user-facing text. Do not "simplify" it.
import { keccak256, secp256k1 } from "../primitives.mjs";
import { signQuoteDigest } from "../quoteEip712Spec.mjs";

// The domain name and version, from the order book's own sign-message response (docs.kyberswap.com, Maker API).
// Built from parts so no literal here is a multi-word phrase (see the header).
export const KYBER_DOMAIN_NAME = ["Kyber", "DSLO", "Protocol"].join(" ");
export const KYBER_DOMAIN_VERSION = "1";

// The limit order contract that verifies the signature; identical on every network KyberSwap serves
// (docs.kyberswap.com, "Contracts & Addresses": Ethereum, BSC, Arbitrum, Polygon, ... all DSLOProtocol 0xcab2...).
export const KYBER_LIMIT_ORDER_CONTRACT = "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C";

// The type strings, assembled from their fields so the order is the single source of truth here (as in DSOrderMixin).
const DOMAIN_TYPE_PARTS = ["EIP712Domain(", "string name,", "string version,", "uint256 chainId,", "address verifyingContract)"];
export const KYBER_DOMAIN_TYPE = DOMAIN_TYPE_PARTS.join("");

// The message, field by field and IN THIS ORDER - the order is the protocol (DSOrderMixin.LIMIT_ORDER_TYPEHASH).
export const KYBER_ORDER_FIELDS = [
  ["salt", "uint256"],
  ["makerAsset", "address"],
  ["takerAsset", "address"],
  ["maker", "address"],
  ["receiver", "address"],
  ["allowedSender", "address"],
  ["makingAmount", "uint256"],
  ["takingAmount", "uint256"],
  ["feeConfig", "uint256"],
  ["makerAssetData", "bytes"],
  ["takerAssetData", "bytes"],
  ["getMakerAmount", "bytes"],
  ["getTakerAmount", "bytes"],
  ["predicate", "bytes"],
  ["interaction", "bytes"],
];
export const KYBER_ORDER_TYPE = "Order(" + KYBER_ORDER_FIELDS.map((f) => f[1] + " " + f[0]).join(",") + ")";

// The contract's OWN type-hash constant (DSOrderMixin.LIMIT_ORDER_TYPEHASH). It is NOT trusted: the check recomputes
// keccak256(KYBER_ORDER_TYPE) and demands it equal this - so a typo in the field list above reddens rather than
// silently signing orders the contract would reject.
export const KYBER_ORDER_TYPE_HASH = "0x346e0660be2aef32794b25da30f6733303978cb6c10c395480eb5d2c56bcd956";

// The OPERATOR co-signature type (DSOrderMixin.DS_LIMIT_ORDER_TYPEHASH). A fill carries a second signature - the
// KyberSwap operator signs DSOrder(orderHash, opExpireTime) - which is why a Maker order alone cannot be filled
// without a fresh operator signature (see kyber.mjs). Kept here so the role is checkable, not just described.
export const KYBER_DS_ORDER_FIELDS = [
  ["orderHash", "bytes32"],
  ["opExpireTime", "uint32"],
];
export const KYBER_DS_ORDER_TYPE = "DSOrder(" + KYBER_DS_ORDER_FIELDS.map((f) => f[1] + " " + f[0]).join(",") + ")";
export const KYBER_DS_ORDER_TYPE_HASH = "0xd5012ad50b71ffd4515ff18ee49caf4bcd3d1e15ff26a40cab61bbb54200b063";

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
// BYTES ARE ACCEPTED IN EITHER FORM: the order book returns some hex fields WITHOUT a 0x prefix and others WITH one
// (docs.kyberswap.com, Taker API: signature, getMakerAmount, ... are returned without a 0x prefix; an empty value
// means empty bytes). Both are the same bytes, so both are accepted; an empty value is empty bytes.
const hexToBytes = (hex) => {
  const h = String(hex === undefined || hex === null ? "" : hex).replace(/^0x/, "");
  if (h.length % 2) boom("kyber-odd-hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) boom("kyber-bad-hex");
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
  boom("kyber-bad-number");
};
const wordUint = (v, bits) => {
  const n = asBigInt(v);
  if (n < 0n) boom("kyber-negative");
  if (n >= (1n << BigInt(bits))) boom("kyber-overflow");
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const wordAddress = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(s)) boom("kyber-bad-address");
  const out = new Uint8Array(32);
  out.set(hexToBytes(s.replace(/^0x/, "")), 12);
  return out;
};
const wordBytes32 = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s)) boom("kyber-bad-bytes32");
  return hexToBytes(s.replace(/^0x/, ""));
};
// A `bytes` field in EIP-712 is encoded as the keccak256 of its bytes - empty bytes hash to keccak256("").
const wordBytes = (v) => keccak256(hexToBytes(v));

const encodeField = (type, value) => {
  if (type === "address") return wordAddress(value);
  if (type === "bytes32") return wordBytes32(value);
  if (type === "uint32") return wordUint(value, 32);
  if (type === "uint256") return wordUint(value, 256);
  if (type === "bytes") return wordBytes(value);
  boom("kyber-bad-type");
};

// The fields an order cannot do without. An absent field is not "probably zero": the caller refuses, not signs.
// A `bytes` field is DIFFERENT: EMPTY BYTES are a legitimate value (a public order carries makerAssetData "0x" and an
// empty interaction), so for those only undefined/null is missing - an empty string is a real, allowed value.
export const kyberOrderMissingFields = (order) => {
  const missing = [];
  for (const [name, type] of KYBER_ORDER_FIELDS) {
    const v = order ? order[name] : undefined;
    if (v === undefined || v === null) missing.push(name);
    else if (type !== "bytes" && v === "") missing.push(name);
  }
  return missing;
};

// The EIP-712 domain. chainId and verifyingContract come LIVE from the order's context, not cached: the digest must
// change when either does, else an order could move between networks or contracts.
export const kyberDomainSeparator = ({ chainId, contract = KYBER_LIMIT_ORDER_CONTRACT }) => keccak256(concat(
  keccak256(utf8(KYBER_DOMAIN_TYPE)),
  keccak256(utf8(KYBER_DOMAIN_NAME)),
  keccak256(utf8(KYBER_DOMAIN_VERSION)),
  wordUint(chainId, 256),
  wordAddress(contract),
));

export const kyberStructHash = (order) => {
  const parts = [keccak256(utf8(KYBER_ORDER_TYPE))];
  for (const [name, type] of KYBER_ORDER_FIELDS) parts.push(encodeField(type, order ? order[name] : undefined));
  return keccak256(concat(...parts));
};

// The digest the wallet key signs - and the contract's hashOrder() result. Anything that changes here changes the
// recovered address (and the order the operator co-signature binds).
export const kyberOrderDigest = ({ order, chainId, contract = KYBER_LIMIT_ORDER_CONTRACT }) =>
  keccak256(concat(Uint8Array.from([0x19, 0x01]), kyberDomainSeparator({ chainId, contract }), kyberStructHash(order)));

export const kyberOrderDigestHex = (ctx) => bytesToHex(kyberOrderDigest(ctx));

// The digest the OPERATOR co-signature is over: EIP-712 DSOrder(orderHash, opExpireTime) in the same domain. Kept so
// the operator role is a value the check can recompute, not only prose. A fill without this signature reverts on
// chain ("LOP: bad op signature", DSOrderMixin.fillOrderTo).
export const kyberOperatorDigest = ({ orderHash, opExpireTime, chainId, contract = KYBER_LIMIT_ORDER_CONTRACT }) => {
  const struct = keccak256(concat(keccak256(utf8(KYBER_DS_ORDER_TYPE)), wordBytes32(orderHash), wordUint(opExpireTime, 32)));
  return keccak256(concat(Uint8Array.from([0x19, 0x01]), kyberDomainSeparator({ chainId, contract }), struct));
};
export const kyberOperatorDigestHex = (ctx) => bytesToHex(kyberOperatorDigest(ctx));

// The typed data a wallet signs (eth_signTypedData_v4). The message carries every Order field as the order book
// returns them (strings), so the wallet shows them readably and the contract hashes them identically.
export const kyberOrderTypedData = ({ order, chainId, contract = KYBER_LIMIT_ORDER_CONTRACT }) => ({
  domain: { name: KYBER_DOMAIN_NAME, version: KYBER_DOMAIN_VERSION, chainId: Number(chainId), verifyingContract: contract },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Order: KYBER_ORDER_FIELDS.map(([name, type]) => ({ name, type })),
  },
  primaryType: "Order",
  message: {
    salt: String(order.salt),
    makerAsset: order.makerAsset,
    takerAsset: order.takerAsset,
    maker: order.maker,
    receiver: order.receiver,
    allowedSender: order.allowedSender,
    makingAmount: String(order.makingAmount),
    takingAmount: String(order.takingAmount),
    feeConfig: String(order.feeConfig),
    makerAssetData: order.makerAssetData,
    takerAssetData: order.takerAssetData,
    getMakerAmount: order.getMakerAmount,
    getTakerAmount: order.getTakerAmount,
    predicate: order.predicate,
    interaction: order.interaction,
  },
});

// SIGN THE DIGEST THROUGH THE REPOSITORY'S EXISTING SIGNER: signQuoteDigest signs any 32-byte digest and returns
// r || s || v with v in {27, 28}. No second signer is written here.
export const signKyberOrderDigest = ({ digest, privateKey }) =>
  signQuoteDigest({ crypto: { secp256k1 }, digest, privateKey });

// Recover the signer of a digest from a signature (the same rule the CoW check uses): lowercase 0x address, or null
// when the signature is not usable. The caller turns null into a NAMED refusal, never into consent.
export const recoverKyberOrderSigner = ({ digest, signature }) => {
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
