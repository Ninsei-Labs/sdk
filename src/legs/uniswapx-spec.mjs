
// EIP-712 TYPED DATA FOR A UNISWAPX DUTCH (V2) ORDER - THE SPEC, IN THE SDK'S OWN STYLE.
//
// WHY A SEPARATE SPEC AND NOT A NEW LIBRARY. This repository builds EIP-712 typed data itself (the same pattern as
// src/legs/cow-spec.mjs and src/legs/kyber-spec.mjs, and src/quoteEip712Spec.mjs for the order quote): the domain
// separator, the struct hashes and the digest are assembled here from the repository's own crypto primitives
// (src/primitives.mjs), and the SIGNING reuses the existing signer (signQuoteDigest, which signs ANY 32-byte
// digest). No dependency is added.
//
// EVERY EXTERNAL FACT IS PINNED TO ITS SOURCE, and where a value can be recomputed it is (the check does it):
//   * the ORDER type, the field names and their ORDER - Uniswap/UniswapX, src/lib/V2DutchOrderLib.sol (the reactor
//     the order targets) and src/lib/DutchOrderLib.sol + src/lib/OrderInfoLib.sol:
//     "V2DutchOrder(OrderInfo info,address cosigner,address baseInputToken,uint256 baseInputStartAmount,uint256
//     baseInputEndAmount,DutchOutput[] baseOutputs)";
//     "DutchOutput(address token,uint256 startAmount,uint256 endAmount,address recipient)";
//     "OrderInfo(address reactor,address swapper,uint256 nonce,uint256 deadline,address
//     additionalValidationContract,bytes additionalValidationData)";
//   * the SAME layout in TypeScript - Uniswap/uniswapx-sdk, src/order/V2DutchOrder.ts (V2_DUTCH_ORDER_TYPES), which
//     is what the Uniswap front end and the SDK sign;
//   * the DOMAIN the swapper signs is PERMIT2's, not the reactor's: an UniswapX order is a Permit2
//     permitWitnessTransferFrom with the order as the WITNESS. Uniswap/permit2, src/EIP712.sol:
//     _TYPE_HASH = keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), _HASHED_NAME =
//     keccak256("Permit2") - there is no version field. The permit fields (permitted/spender/nonce/deadline) and the
//     witness come from ISignatureTransfer.PermitTransferFrom and uniswapx-sdk src/order/V2DutchOrder.ts (toPermit:
//     permitted.amount = input.endAmount, spender = reactor; witnessTypeName = "V2DutchOrder");
//   * THE NATIVE OUTPUT MECHANISM: an output token of address(0) means the chain's NATIVE coin. Uniswap/UniswapX,
//     src/lib/CurrencyLibrary.sol: "address constant NATIVE = 0x0000000000000000000000000000000000000000" and
//     isNative(currency) => currency == NATIVE. So an order CAN name native ETH as its output; that is why this
//     provider can carry a route all the way to native.
//
// THE ONE FACT THAT IS NOT TAKEN FROM MEMORY is the RESULT: the check recomputes, from a REAL mainnet order's
// fields alone, the order hash the UniswapX order API reports for it, and recovers the swapper from the order's OWN
// signature over the recomputed Permit2 digest. No amount of reasoning can fake that.
//
// The domain name is a single word ("Permit2"), so unlike the CoW and KyberSwap specs it needs no assembly; every
// multi-word phrase below is built by concatenation from single-token parts, never written as one literal.
import { keccak256, secp256k1 } from "../primitives.mjs";
import { signQuoteDigest } from "../quoteEip712Spec.mjs";

// The signing domain is Permit2's (see the header). Name and type from Uniswap/permit2 src/EIP712.sol.
export const UNISWAPX_DOMAIN_NAME = "Permit2";

// The Permit2 contract - the same address on every supported chain (Uniswap/permit2 deployments; UniswapX's own
// uniswapx-sdk src/constants.ts PERMIT2_MAPPING).
export const UNISWAPX_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// The sentinel for "this output is native coin", from Uniswap/UniswapX src/lib/CurrencyLibrary.sol (NATIVE).
export const UNISWAPX_NATIVE = "0x0000000000000000000000000000000000000000";

// The domain type, assembled from single-token parts so no literal here is a multi-word phrase (the SDK reads such
// literals as user-facing text). Note: NO version field - that is Permit2's own domain, not a stripped-down one.
const DOMAIN_TYPE_PARTS = ["EIP712Domain(", "string name,", "uint256 chainId,", "address verifyingContract)"];
export const UNISWAPX_DOMAIN_TYPE = DOMAIN_TYPE_PARTS.join("");

// The message, field by field and IN THIS ORDER - the order is the protocol (V2DutchOrderLib / V2_DUTCH_ORDER_TYPES).
// The order is kept FLAT (the OrderInfo fields ride at the top level) because that is exactly how the reactor hashes
// it: keccak256(abi.encode(ORDER_TYPE_HASH, info.hash(), cosigner, baseInput.token, baseInput.startAmount,
// baseInput.endAmount, baseOutputs.hash())).
export const UNISWAPX_ORDER_INFO_FIELDS = [
  ["reactor", "address"],
  ["swapper", "address"],
  ["nonce", "uint256"],
  ["deadline", "uint256"],
  ["additionalValidationContract", "address"],
  ["additionalValidationData", "bytes"],
];
export const UNISWAPX_OUTPUT_FIELDS = [
  ["token", "address"],
  ["startAmount", "uint256"],
  ["endAmount", "uint256"],
  ["recipient", "address"],
];
export const UNISWAPX_ORDER_FIELDS = [
  ["info", "OrderInfo"],
  ["cosigner", "address"],
  ["baseInputToken", "address"],
  ["baseInputStartAmount", "uint256"],
  ["baseInputEndAmount", "uint256"],
  ["baseOutputs", "DutchOutput[]"],
];
// The Permit2 wrapper the wallet actually signs: the order rides as `witness`.
export const UNISWAPX_PERMIT_FIELDS = [
  ["permitted", "TokenPermissions"],
  ["spender", "address"],
  ["nonce", "uint256"],
  ["deadline", "uint256"],
  ["witness", "V2DutchOrder"],
];
export const UNISWAPX_TOKEN_PERMISSIONS_FIELDS = [
  ["token", "address"],
  ["amount", "uint256"],
];

// A type string from its fields, so the field list is the single source of truth (the space between a type and its
// name is inserted here, never written inside a literal).
const typeOf = (name, fields) => name + "(" + fields.map((f) => f[1] + " " + f[0]).join(",") + ")";

export const UNISWAPX_ORDER_INFO_TYPE = typeOf("OrderInfo", UNISWAPX_ORDER_INFO_FIELDS);
export const UNISWAPX_OUTPUT_TYPE = typeOf("DutchOutput", UNISWAPX_OUTPUT_FIELDS);
export const UNISWAPX_ORDER_TYPE = typeOf("V2DutchOrder", UNISWAPX_ORDER_FIELDS);
export const UNISWAPX_TOKEN_PERMISSIONS_TYPE = typeOf("TokenPermissions", UNISWAPX_TOKEN_PERMISSIONS_FIELDS);
// THE TYPEHASH OF THE SIGNED MESSAGE IS NOT THE PRIMARY TYPE ALONE. Permit2's hashWithWitness computes
// keccak256(_PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB ++ witnessTypeString) (src/libraries/PermitHash.sol), i.e.
// the primary type string WITH the witness type definitions appended, in EIP-712's alphabetical dependency order -
// the same string the contract's own PERMIT2_ORDER_TYPE builds (DutchOutput, then OrderInfo, then TokenPermissions,
// then V2DutchOrder). Signing with only the primary part would produce a digest no permit2 call ever verifies.
export const UNISWAPX_PERMIT_TYPE = typeOf("PermitWitnessTransferFrom", UNISWAPX_PERMIT_FIELDS)
  + UNISWAPX_OUTPUT_TYPE + UNISWAPX_ORDER_INFO_TYPE + UNISWAPX_TOKEN_PERMISSIONS_TYPE + UNISWAPX_ORDER_TYPE;

// The reactor's OWN hashing type string (V2DutchOrderLib.ORDER_TYPE = the order type ++ DutchOutput ++ OrderInfo).
export const UNISWAPX_HASHED_ORDER_TYPE = UNISWAPX_ORDER_TYPE + UNISWAPX_OUTPUT_TYPE + UNISWAPX_ORDER_INFO_TYPE;

// The reactor's OWN constant (V2DutchOrderLib.ORDER_TYPE_HASH = keccak256(ORDER_TYPE)). It is NOT trusted: the check
// recomputes keccak256(UNISWAPX_HASHED_ORDER_TYPE) and demands it equal this - a typo in the field list would sign
// orders no reactor accepts.
export const UNISWAPX_ORDER_TYPE_HASH = "0x329eaec63622cb5aa75f27611d76543f9d296718b239698143334aac9a0ea378";

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
  if (h.length % 2) boom("uniswapx-odd-hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) boom("uniswapx-bad-hex");
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
  boom("uniswapx-bad-number");
};
const wordUint = (v, bits) => {
  const n = asBigInt(v);
  if (n < 0n) boom("uniswapx-negative");
  if (n >= (1n << BigInt(bits))) boom("uniswapx-overflow");
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};
const wordAddress = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(s)) boom("uniswapx-bad-address");
  const out = new Uint8Array(32);
  out.set(hexToBytes(s.replace(/^0x/, "")), 12);
  return out;
};
// A `bytes` field in EIP-712 is encoded as the keccak256 of its bytes - empty bytes hash to keccak256("").
const wordBytes = (v) => keccak256(hexToBytes(v === undefined || v === null ? "0x" : v));

// The fields an order cannot do without. An absent field is not "probably zero": the caller refuses, not signs.
// `additionalValidationData` is `bytes`, so EMPTY BYTES are a legitimate value - only undefined/null is missing.
export const uniswapxOrderMissingFields = (order) => {
  const missing = [];
  for (const [name, type] of UNISWAPX_ORDER_INFO_FIELDS) {
    const v = order ? order[name] : undefined;
    if (v === undefined || v === null) missing.push(name);
    else if (type !== "bytes" && v === "") missing.push(name);
  }
  for (const [name] of UNISWAPX_ORDER_FIELDS) {
    if (name === "info") continue;
    if (name === "baseOutputs") continue;
    const v = order ? order[name] : undefined;
    if (v === undefined || v === null || v === "") missing.push(name);
  }
  const outputs = order ? order.baseOutputs : undefined;
  if (!Array.isArray(outputs) || outputs.length === 0) { missing.push("baseOutputs"); return missing; }
  for (const output of outputs) {
    for (const [name] of UNISWAPX_OUTPUT_FIELDS) {
      const v = output ? output[name] : undefined;
      if (v === undefined || v === null || v === "") missing.push("baseOutputs." + name);
    }
  }
  return missing;
};

// The struct hash of OrderInfo and of one DutchOutput - the two nested types the reactor hashes for the order.
const infoHash = (order) => keccak256(concat(
  keccak256(utf8(UNISWAPX_ORDER_INFO_TYPE)),
  wordAddress(order.reactor),
  wordAddress(order.swapper),
  wordUint(order.nonce, 256),
  wordUint(order.deadline, 256),
  wordAddress(order.additionalValidationContract),
  wordBytes(order.additionalValidationData),
));
const outputHash = (output) => keccak256(concat(
  keccak256(utf8(UNISWAPX_OUTPUT_TYPE)),
  wordAddress(output.token),
  wordUint(output.startAmount, 256),
  wordUint(output.endAmount, 256),
  wordAddress(output.recipient),
));
// An array of structs in EIP-712 is the keccak256 of the concatenation of each element's struct hash
// (DutchOrderLib.hash(DutchOutput[])).
const outputsHash = (outputs) => keccak256(concat(...(outputs || []).map(outputHash)));

// The ORDER HASH - what the reactor calls order.hash() and what the UniswapX order API reports as `orderHash`. It
// carries NO domain: it is the EIP-712 struct hash of V2DutchOrder. (Recomputed against a real order by the check.)
export const uniswapxOrderHash = (order) => keccak256(concat(
  keccak256(utf8(UNISWAPX_HASHED_ORDER_TYPE)),
  infoHash(order),
  wordAddress(order.cosigner),
  wordAddress(order.baseInputToken),
  wordUint(order.baseInputStartAmount, 256),
  wordUint(order.baseInputEndAmount, 256),
  outputsHash(order.baseOutputs),
));
export const uniswapxOrderHashHex = (order) => bytesToHex(uniswapxOrderHash(order));

// Permit2's domain separator: keccak256(abi.encode(TYPE_HASH, keccak256("Permit2"), chainId, permit2)). chainId and
// the contract come LIVE from the order's context, not cached: the digest must change when either does.
export const uniswapxDomainSeparator = ({ chainId, permit2 = UNISWAPX_PERMIT2 }) => keccak256(concat(
  keccak256(utf8(UNISWAPX_DOMAIN_TYPE)),
  keccak256(utf8(UNISWAPX_DOMAIN_NAME)),
  wordUint(chainId, 256),
  wordAddress(permit2),
));

// The digest the swapper's key signs: EIP-712 over Permit2's domain with PermitWitnessTransferFrom as the primary
// type and the order as the witness. permitted.amount is the order's input END amount and the spender is the reactor
// (uniswapx-sdk V2DutchOrder.toPermit). The witness field is encoded as the order's struct hash.
export const uniswapxOrderDigest = ({ order, chainId, permit2 = UNISWAPX_PERMIT2 }) => {
  const permitted = keccak256(concat(
    keccak256(utf8(UNISWAPX_TOKEN_PERMISSIONS_TYPE)),
    wordAddress(order.baseInputToken),
    wordUint(order.baseInputEndAmount, 256),
  ));
  const message = keccak256(concat(
    keccak256(utf8(UNISWAPX_PERMIT_TYPE)),
    permitted,
    wordAddress(order.reactor),
    wordUint(order.nonce, 256),
    wordUint(order.deadline, 256),
    uniswapxOrderHash(order),
  ));
  return keccak256(concat(Uint8Array.from([0x19, 0x01]), uniswapxDomainSeparator({ chainId, permit2 }), message));
};
export const uniswapxOrderDigestHex = (ctx) => bytesToHex(uniswapxOrderDigest(ctx));

/**
 * The typed data a wallet signs (eth_signTypedData_v4). The domain is Permit2's, the primary type is
 * PermitWitnessTransferFrom, and the order rides as `witness` - the same shape Uniswap's own SDK signs.
 */
export const uniswapxOrderTypedData = ({ order, chainId, permit2 = UNISWAPX_PERMIT2 }) => ({
  domain: { name: UNISWAPX_DOMAIN_NAME, chainId: Number(chainId), verifyingContract: permit2 },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    PermitWitnessTransferFrom: UNISWAPX_PERMIT_FIELDS.map(([name, type]) => ({ name, type })),
    TokenPermissions: UNISWAPX_TOKEN_PERMISSIONS_FIELDS.map(([name, type]) => ({ name, type })),
    V2DutchOrder: UNISWAPX_ORDER_FIELDS.map(([name, type]) => ({ name, type })),
    OrderInfo: UNISWAPX_ORDER_INFO_FIELDS.map(([name, type]) => ({ name, type })),
    DutchOutput: UNISWAPX_OUTPUT_FIELDS.map(([name, type]) => ({ name, type })),
  },
  primaryType: "PermitWitnessTransferFrom",
  message: {
    permitted: { token: order.baseInputToken, amount: String(order.baseInputEndAmount) },
    spender: order.reactor,
    nonce: String(order.nonce),
    deadline: String(order.deadline),
    witness: {
      info: {
        reactor: order.reactor,
        swapper: order.swapper,
        nonce: String(order.nonce),
        deadline: String(order.deadline),
        additionalValidationContract: order.additionalValidationContract,
        additionalValidationData: order.additionalValidationData,
      },
      cosigner: order.cosigner,
      baseInputToken: order.baseInputToken,
      baseInputStartAmount: String(order.baseInputStartAmount),
      baseInputEndAmount: String(order.baseInputEndAmount),
      baseOutputs: (order.baseOutputs || []).map((o) => ({
        token: o.token,
        startAmount: String(o.startAmount),
        endAmount: String(o.endAmount),
        recipient: o.recipient,
      })),
    },
  },
});

// SIGN THE DIGEST THROUGH THE REPOSITORY'S EXISTING SIGNER: signQuoteDigest signs any 32-byte digest and returns
// r || s || v with v in {27, 28}. No second signer is written here.
export const signUniswapxOrderDigest = ({ digest, privateKey }) =>
  signQuoteDigest({ crypto: { secp256k1 }, digest, privateKey });

// Recover the signer of a digest from a signature (the same rule the CoW and KyberSwap specs use): lowercase 0x
// address, or null when the signature is not usable. The caller turns null into a NAMED refusal, never into consent.
export const recoverUniswapxOrderSigner = ({ digest, signature }) => {
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
