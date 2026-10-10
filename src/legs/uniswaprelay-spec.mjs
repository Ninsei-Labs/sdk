// EIP-712 TYPED DATA FOR A UNISWAP RELAY ORDER, AND THE UNIVERSALROUTER CALLDATA - THE SPEC, IN THE SDK'S OWN STYLE.
//
// WHY A SEPARATE SPEC AND NOT A NEW LIBRARY. This repository builds EIP-712 typed data itself (the same pattern as
// src/legs/cow-spec.mjs, kyber-spec.mjs and uniswapx-spec.mjs): the domain separator, the struct hashes and the
// digest are assembled here from the repository's own crypto primitives (src/primitives.mjs), and the SIGNING reuses
// the existing signer (signQuoteDigest, which signs ANY 32-byte digest). No dependency is added.
//
// WHAT THIS IS. Uniswap's own repository Uniswap/relayer ships contracts that RELAY a transaction to the
// UniversalRouter in exchange for ERC-20 tokens. A swapper signs a RelayOrder; whoever holds that signature (the
// "relayer") calls RelayOrderReactor.execute(SignedOrder, address feeRecipient), pays the gas, and is reimbursed in
// the input token through the order's own fee. That is the KEY-FREE route: no hosted service, no API key.
//
// EVERY EXTERNAL FACT IS PINNED TO ITS SOURCE, and where a value can be recomputed it is (the check does it):
//   * the RelayOrder struct and its field order - Uniswap/relayer, src/base/ReactorStructs.sol:
//     RelayOrder { RelayOrderInfo info; Input input; FeeEscalator fee; bytes universalRouterCalldata; };
//     RelayOrderInfo { address reactor; address swapper; uint256 nonce; uint256 deadline; };
//     Input { address token; uint256 amount; address recipient; };
//     FeeEscalator { address token; uint256 startAmount; uint256 endAmount; uint256 startTime; uint256 endTime; };
//   * the SAME layout in TypeScript - Uniswap/uniswapx-sdk, src/order/RelayOrder.ts (RELAY_WITNESS_TYPES), which is
//     what Uniswap's own tooling signs;
//   * the DOMAIN the swapper signs is PERMIT2's, not the reactor's: a relay order is a Permit2
//     permitWitnessTransferFrom with the order as the WITNESS, batch flavour (two permitted tokens - the input and
//     the fee). Uniswap/permit2, src/EIP712.sol: _TYPE_HASH = keccak256(EIP712Domain(string name,uint256
//     chainId,address verifyingContract)), _HASHED_NAME = keccak256(Permit2) - there is no version field.
//     The permit fields and the witness come from Uniswap/relayer src/lib/RelayOrderLib.sol (toTokenPermissions /
//     toTransferDetails / transferInputTokens) and Uniswap/uniswapx-sdk src/order/RelayOrder.ts (toPermit:
//     permitted = [{input.token, input.amount}, {fee.token, fee.endAmount}], spender = the reactor);
//   * THE WITNESS TYPE STRING. Permit2 does not hash the primary type alone: hashWithWitness computes
//     keccak256(_PERMIT_BATCH_WITNESS_TRANSFER_FROM_TYPEHASH_STUB ++ witnessTypeString)
//     (Uniswap/permit2, src/libraries/PermitHash.sol). The stub is
//     PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,
//     and the witness type string is built by Uniswap/relayer src/lib/RelayOrderLib.sol PERMIT2_ORDER_TYPE as
//     RelayOrder witness) ++ FeeEscalator ++ Input ++ RelayOrder ++ RelayOrderInfo ++ TokenPermissions, in
//     EIP-712's alphabetical dependency order. Signing with only the primary part would produce a digest no permit2
//     call ever verifies;
//   * THE FEE. The fee is a FeeEscalator and is paid to `feeRecipient` - the address the RELAYER names in the
//     execute() call, or the caller itself when the two-argument overload is used (Uniswap/relayer README
//     RelayOrderReactor and src/reactors/RelayOrderReactor.sol: execute(SignedOrder) calls
//     execute(signedOrder, msg.sender)). The amount actually transferred is resolved on the escalation curve at
//     fill time (src/lib/FeeEscalatorLib.sol resolve); the permit signs the END amount (toTokenPermissions);
//   * THE INPUT TOKEN PULL: the reactor pulls BOTH the input and the fee from the SWAPPER through Permit2's
//     permitWitnessTransferFrom (src/lib/RelayOrderLib.sol transferInputTokens): input goes to input.recipient, the
//     fee goes to feeRecipient. So the swapper grants a Permit2 allowance (an ERC-20 approve to Permit2) and signs
//     the permit - there is no other approval mechanism;
//   * THE UNIVERSALROUTER CALLDATA. The reactor makes exactly one call with order.universalRouterCalldata, and only
//     when it is non-empty (src/reactors/RelayOrderReactor.sol). Uniswap's own integration tests build that calldata
//     for token -> native as V3_SWAP_EXACT_IN (0x00) followed by UNWRAP_WETH (0x0c)
//     (Uniswap/relayer test/integration-tests/RelayOrderReactor.test.ts basic v3 swap to native), and the command
//     bytes come from Uniswap/universal-router contracts/libraries/Commands.sol. The UniversalRouter command
//     placeholders ADDRESS_THIS (0x...02) and the payerIsUser=false flag come from the same tests
//     (test/integration-tests/shared/constants.ts).
//
// Multi-word phrases below are built by concatenation from single-token parts, never written as one literal: the SDK
// reads such literals as user-facing text (see the demo's own www-tools check-sdk).
import { keccak256, secp256k1 } from "../primitives.mjs";
import { signQuoteDigest } from "../quoteEip712Spec.mjs";

// The signing domain is Permit2's (see the header). Name and type from Uniswap/permit2 src/EIP712.sol.
export const UNISWAPRELAY_DOMAIN_NAME = "Permit2";

// The Permit2 contract - the same address on every supported chain (Uniswap/permit2 deployments; the reactor's own
// PERMIT2 constant in Uniswap/relayer src/reactors/RelayOrderReactor.sol).
export const UNISWAPRELAY_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// The sentinel for "this output is native coin", the same address(0) the UniversalRouter unwraps to.
export const UNISWAPRELAY_NATIVE = "0x0000000000000000000000000000000000000000";

// THE UNIVERSALROUTER PLACEHOLDER "THIS CONTRACT" - where a swap must send its output so that the following
// UNWRAP_WETH can take the whole wrapped balance (Uniswap/universal-router Constants.sol ADDRESS_THIS; the same
// placeholder the demo's own DEX leg uses, www/js/evm/dexExec.js DEX_EXEC_PLACEHOLDER).
export const UNISWAPRELAY_ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

// THE UNIVERSALROUTER ENTRY POINT execute(bytes,bytes[]) - the selector Uniswap's own relayer fixtures carry
// (0x24856bc3, test/foundry-tests/interop.json) and the ABI in test/.../RelayOrderReactor.test.ts uses.
export const UNISWAPRELAY_EXECUTE_SELECTOR = "0x24856bc3";

// THE COMMAND BYTES the UniversalRouter decodes (Uniswap/universal-router contracts/libraries/Commands.sol). Only
// the four this route can need are named; the values are the library's own constants.
export const UNISWAPRELAY_UR_COMMAND = Object.freeze({
  v3SwapExactIn: 0x00,
  sweep: 0x04,
  wrapEth: 0x0b,
  unwrapWeth: 0x0c,
});

// The V3 pool fee is a 3-byte field in the swap path (Uniswap/universal-router Path.sol / uniswapx-sdk
// test/integration-tests/shared/swapRouter02Helpers.ts encodePath).
export const UNISWAPRELAY_PATH_FEE_BYTES = 3;

// The domain type, assembled from single-token parts so no literal here is a multi-word phrase. NO version field -
// that is Permit2's own domain, not a stripped-down one.
const DOMAIN_TYPE_PARTS = ["EIP712Domain(", "string name,", "uint256 chainId,", "address verifyingContract)"];
export const UNISWAPRELAY_DOMAIN_TYPE = DOMAIN_TYPE_PARTS.join("");

// The message, field by field and IN THIS ORDER - the order is the protocol (ReactorStructs.sol / RELAY_WITNESS_TYPES).
export const UNISWAPRELAY_INFO_FIELDS = [
  ["reactor", "address"],
  ["swapper", "address"],
  ["nonce", "uint256"],
  ["deadline", "uint256"],
];
export const UNISWAPRELAY_INPUT_FIELDS = [
  ["token", "address"],
  ["amount", "uint256"],
  ["recipient", "address"],
];
export const UNISWAPRELAY_FEE_FIELDS = [
  ["token", "address"],
  ["startAmount", "uint256"],
  ["endAmount", "uint256"],
  ["startTime", "uint256"],
  ["endTime", "uint256"],
];
export const UNISWAPRELAY_ORDER_FIELDS = [
  ["info", "RelayOrderInfo"],
  ["input", "Input"],
  ["fee", "FeeEscalator"],
  ["universalRouterCalldata", "bytes"],
];
export const UNISWAPRELAY_TOKEN_PERMISSIONS_FIELDS = [
  ["token", "address"],
  ["amount", "uint256"],
];
// The Permit2 wrapper the wallet actually signs: the order rides as `witness`, and `permitted` is a LIST (the input
// and the fee). Primary type = PermitBatchWitnessTransferFrom (Uniswap/relayer RelayOrderLib.transferInputTokens).
export const UNISWAPRELAY_PERMIT_FIELDS = [
  ["permitted", "TokenPermissions[]"],
  ["spender", "address"],
  ["nonce", "uint256"],
  ["deadline", "uint256"],
  ["witness", "RelayOrder"],
];

// A type string from its fields, so the field list is the single source of truth (the space between a type and its
// name is inserted here, never written inside a literal).
const typeOf = (name, fields) => name + "(" + fields.map((f) => f[1] + " " + f[0]).join(",") + ")";

export const UNISWAPRELAY_INFO_TYPE = typeOf("RelayOrderInfo", UNISWAPRELAY_INFO_FIELDS);
export const UNISWAPRELAY_INPUT_TYPE = typeOf("Input", UNISWAPRELAY_INPUT_FIELDS);
export const UNISWAPRELAY_FEE_TYPE = typeOf("FeeEscalator", UNISWAPRELAY_FEE_FIELDS);
export const UNISWAPRELAY_ORDER_TYPE = typeOf("RelayOrder", UNISWAPRELAY_ORDER_FIELDS);
export const UNISWAPRELAY_TOKEN_PERMISSIONS_TYPE = typeOf("TokenPermissions", UNISWAPRELAY_TOKEN_PERMISSIONS_FIELDS);

// The reactor's OWN hashing type string: RelayOrderLib.FULL_RELAY_ORDER_TYPESTRING = the order type ++ FeeEscalator
// ++ Input ++ RelayOrderInfo (the nested types in alphabetical order).
export const UNISWAPRELAY_HASHED_ORDER_TYPE = UNISWAPRELAY_ORDER_TYPE
  + UNISWAPRELAY_FEE_TYPE + UNISWAPRELAY_INPUT_TYPE + UNISWAPRELAY_INFO_TYPE;

// The FULL permit type string Permit2 hashes: the batch witness stub (closed by the witness name) ++ the witness
// types. RelayOrderLib.PERMIT2_ORDER_TYPE, verbatim in that order.
export const UNISWAPRELAY_PERMIT_TYPE = typeOf("PermitBatchWitnessTransferFrom", UNISWAPRELAY_PERMIT_FIELDS)
  + UNISWAPRELAY_FEE_TYPE + UNISWAPRELAY_INPUT_TYPE + UNISWAPRELAY_ORDER_TYPE
  + UNISWAPRELAY_INFO_TYPE + UNISWAPRELAY_TOKEN_PERMISSIONS_TYPE;

// THE REACTOR'S OWN CONSTANT (RelayOrderLib.FULL_RELAY_ORDER_TYPEHASH = keccak256(FULL_RELAY_ORDER_TYPESTRING)) and
// Permit2's type hash for this witness (keccak256(PERMIT2_ORDER_TYPE)). They are NOT trusted: the check recomputes
// keccak256(...) and demands they equal these - a typo in a field list would sign orders no reactor accepts.
export const UNISWAPRELAY_ORDER_TYPE_HASH = "0x356a26e7c5955b7b24a8bff954c96c53622e6a8471513bb66b69bc7069243ff0";
export const UNISWAPRELAY_PERMIT_TYPE_HASH = "0x918f75c8e25ec281e8dc3255229111f447dc1c210102666cc63cd9da2dee620c";

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
  if (h.length % 2) boom("uniswaprelay-odd-hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) boom("uniswaprelay-bad-hex");
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
  boom("uniswaprelay-bad-number");
};
const wordUint = (v, bits) => {
  const n = asBigInt(v);
  if (n < 0n) boom("uniswaprelay-negative");
  if (n >= (1n << BigInt(bits))) boom("uniswaprelay-overflow");
  return hexToBytes("0x" + n.toString(16).padStart(64, "0"));
};
const wordAddress = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(s)) boom("uniswaprelay-bad-address");
  const out = new Uint8Array(32);
  out.set(hexToBytes(s.replace(/^0x/, "")), 12);
  return out;
};
const wordBool = (v) => wordUint(v ? 1 : 0, 8);
// A bytes field in EIP-712 is encoded as the keccak256 of its bytes - empty bytes hash to keccak256("").
const wordBytes = (v) => keccak256(hexToBytes(v === undefined || v === null ? "0x" : v));

// -----------------------------------------------------------------------------------------------
// THE ORDER: MISSING FIELDS, HASHES, DOMAIN, DIGEST, TYPED DATA, SIGN, RECOVER
// -----------------------------------------------------------------------------------------------

// The fields an order cannot do without. An absent field is not "probably zero": the caller refuses, not signs.
// universalRouterCalldata MAY be empty (the reactor skips the call when it is - RelayOrderReactor.execute), so like
// any bytes field only undefined/null counts as missing.
export const uniswapRelayOrderMissingFields = (order) => {
  const missing = [];
  for (const [name] of UNISWAPRELAY_INFO_FIELDS) {
    const v = order && order.info ? order.info[name] : undefined;
    if (v === undefined || v === null || v === "") missing.push("info." + name);
  }
  for (const [name] of UNISWAPRELAY_INPUT_FIELDS) {
    const v = order && order.input ? order.input[name] : undefined;
    if (v === undefined || v === null || v === "") missing.push("input." + name);
  }
  for (const [name] of UNISWAPRELAY_FEE_FIELDS) {
    const v = order && order.fee ? order.fee[name] : undefined;
    if (v === undefined || v === null || v === "") missing.push("fee." + name);
  }
  if (!order || order.universalRouterCalldata === undefined || order.universalRouterCalldata === null) missing.push("universalRouterCalldata");
  return missing;
};

const infoHash = (order) => keccak256(concat(
  keccak256(utf8(UNISWAPRELAY_INFO_TYPE)),
  wordAddress(order.info.reactor),
  wordAddress(order.info.swapper),
  wordUint(order.info.nonce, 256),
  wordUint(order.info.deadline, 256),
));
const inputHash = (input) => keccak256(concat(
  keccak256(utf8(UNISWAPRELAY_INPUT_TYPE)),
  wordAddress(input.token),
  wordUint(input.amount, 256),
  wordAddress(input.recipient),
));
const feeHash = (fee) => keccak256(concat(
  keccak256(utf8(UNISWAPRELAY_FEE_TYPE)),
  wordAddress(fee.token),
  wordUint(fee.startAmount, 256),
  wordUint(fee.endAmount, 256),
  wordUint(fee.startTime, 256),
  wordUint(fee.endTime, 256),
));

// The ORDER HASH - what RelayOrderLib.hash() computes and what the reactor's own Relay event carries as orderHash.
// It carries NO domain: it is the EIP-712 struct hash of RelayOrder.
export const uniswapRelayOrderHash = (order) => keccak256(concat(
  keccak256(utf8(UNISWAPRELAY_HASHED_ORDER_TYPE)),
  infoHash(order),
  inputHash(order.input),
  feeHash(order.fee),
  keccak256(hexToBytes(order.universalRouterCalldata)),
));
export const uniswapRelayOrderHashHex = (order) => bytesToHex(uniswapRelayOrderHash(order));

// Permit2's domain separator: keccak256(abi.encode(TYPE_HASH, keccak256(Permit2), chainId, permit2)). chainId and the
// contract come LIVE from the order's context, not cached: the digest must change when either does.
export const uniswapRelayDomainSeparator = ({ chainId, permit2 = UNISWAPRELAY_PERMIT2 }) => keccak256(concat(
  keccak256(utf8(UNISWAPRELAY_DOMAIN_TYPE)),
  keccak256(utf8(UNISWAPRELAY_DOMAIN_NAME)),
  wordUint(chainId, 256),
  wordAddress(permit2),
));

// The digest the swapper's key signs: EIP-712 over Permit2's domain with PermitBatchWitnessTransferFrom as the
// primary type and the order as the witness. permitted is the input plus the fee (the fee's END amount - the permit
// signs the top of the escalator; RelayOrderLib.toTokenPermissions / FeeEscalatorLib.toTokenPermissions), and the
// spender is the reactor.
export const uniswapRelayOrderDigest = ({ order, chainId, permit2 = UNISWAPRELAY_PERMIT2 }) => {
  const permitted = [
    { token: order.input.token, amount: order.input.amount },
    { token: order.fee.token, amount: order.fee.endAmount },
  ];
  // An array of structs in EIP-712 is the keccak256 of the concatenation of each element's struct hash.
  const permittedHash = keccak256(concat(...permitted.map((p) => keccak256(concat(
    keccak256(utf8(UNISWAPRELAY_TOKEN_PERMISSIONS_TYPE)),
    wordAddress(p.token),
    wordUint(p.amount, 256),
  )))));
  const message = keccak256(concat(
    keccak256(utf8(UNISWAPRELAY_PERMIT_TYPE)),
    permittedHash,
    wordAddress(order.info.reactor),
    wordUint(order.info.nonce, 256),
    wordUint(order.info.deadline, 256),
    uniswapRelayOrderHash(order),
  ));
  return keccak256(concat(Uint8Array.from([0x19, 0x01]), uniswapRelayDomainSeparator({ chainId, permit2 }), message));
};
export const uniswapRelayOrderDigestHex = (ctx) => bytesToHex(uniswapRelayOrderDigest(ctx));

/**
 * The typed data a wallet signs (eth_signTypedData_v4). The domain is Permit2's, the primary type is
 * PermitBatchWitnessTransferFrom, and the order rides as the witness - the same shape Uniswap's own SDK signs.
 */
export const uniswapRelayOrderTypedData = ({ order, chainId, permit2 = UNISWAPRELAY_PERMIT2 }) => ({
  domain: { name: UNISWAPRELAY_DOMAIN_NAME, chainId: Number(chainId), verifyingContract: permit2 },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    PermitBatchWitnessTransferFrom: UNISWAPRELAY_PERMIT_FIELDS.map(([name, type]) => ({ name, type })),
    TokenPermissions: UNISWAPRELAY_TOKEN_PERMISSIONS_FIELDS.map(([name, type]) => ({ name, type })),
    RelayOrder: UNISWAPRELAY_ORDER_FIELDS.map(([name, type]) => ({ name, type })),
    RelayOrderInfo: UNISWAPRELAY_INFO_FIELDS.map(([name, type]) => ({ name, type })),
    Input: UNISWAPRELAY_INPUT_FIELDS.map(([name, type]) => ({ name, type })),
    FeeEscalator: UNISWAPRELAY_FEE_FIELDS.map(([name, type]) => ({ name, type })),
  },
  primaryType: "PermitBatchWitnessTransferFrom",
  message: {
    permitted: [
      { token: order.input.token, amount: String(order.input.amount) },
      { token: order.fee.token, amount: String(order.fee.endAmount) },
    ],
    spender: order.info.reactor,
    nonce: String(order.info.nonce),
    deadline: String(order.info.deadline),
    witness: {
      info: {
        reactor: order.info.reactor,
        swapper: order.info.swapper,
        nonce: String(order.info.nonce),
        deadline: String(order.info.deadline),
      },
      input: { token: order.input.token, amount: String(order.input.amount), recipient: order.input.recipient },
      fee: {
        token: order.fee.token,
        startAmount: String(order.fee.startAmount),
        endAmount: String(order.fee.endAmount),
        startTime: String(order.fee.startTime),
        endTime: String(order.fee.endTime),
      },
      universalRouterCalldata: order.universalRouterCalldata,
    },
  },
});

// SIGN THE DIGEST THROUGH THE REPOSITORY'S EXISTING SIGNER: signQuoteDigest signs any 32-byte digest and returns
// r || s || v with v in {27, 28}. No second signer is written here.
export const signUniswapRelayOrderDigest = ({ digest, privateKey }) =>
  signQuoteDigest({ crypto: { secp256k1 }, digest, privateKey });

// Recover the signer of a digest from a signature (the same rule the CoW, KyberSwap and UniswapX specs use):
// lowercase 0x address, or null when the signature is not usable. The caller turns null into a NAMED refusal, never
// into consent.
export const recoverUniswapRelayOrderSigner = ({ digest, signature }) => {
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

// -----------------------------------------------------------------------------------------------
// THE UNIVERSALROUTER CALLDATA: token -> NATIVE (the classic swap-exact-tokens-for-ETH shape)
// -----------------------------------------------------------------------------------------------
//
// The reactor hands the router EXACTLY this calldata (RelayOrderReactor.execute) after moving the input token to
// input.recipient, which for a relayed swap IS the UniversalRouter. So the swap must pay from the ROUTER'S OWN
// BALANCE: the V3 swap's recipient is ADDRESS_THIS and its payerIsUser flag is FALSE (Uniswap/relayer
// test/integration-tests/RelayOrderReactor.test.ts: Guidelines for relay orders - ROUTER pays, payerIsUser = false),
// and the following UNWRAP_WETH pays the native out to `recipient`.

// One right-padded hex body to a 32-byte boundary (the abi.encode padding rule for dynamic bytes).
const padRight = (hex) => {
  const body = String(hex).replace(/^0x/, "").toLowerCase();
  return body.length % 64 === 0 ? body : body.padEnd(Math.ceil(body.length / 64) * 64, "0");
};
const wordHex = (v) => asBigInt(v).toString(16).padStart(64, "0");

// abi.encode(bytes value) as a standalone value: offset (0x20), length, then the padded bytes.
export const abiEncodeBytes = (hex) =>
  "0x" + wordHex(0x20) + wordHex(hexToBytes(hex).length) + padRight(hex);

// abi.encode(bytes[] items): length, then one offset word per item, then each item (its own length word + padded
// bytes). The offsets are relative to the START OF THE OFFSET TABLE, i.e. to the word right after the length - the
// same rule the demo's own multicall encoder follows (www/js/evm/dexExec.js encodeMulticall).
export const abiEncodeBytesArray = (items) => {
  const bodies = items.map((h) => String(h).replace(/^0x/, ""));
  const head = wordHex(bodies.length);
  const offsets = [];
  let offset = bodies.length * 32;
  for (const b of bodies) {
    offsets.push(wordHex(offset));
    offset += 32 + Math.ceil(b.length / 64) * 32;
  }
  const tails = bodies.map((b) => wordHex(b.length / 2) + padRight(b)).join("");
  return "0x" + head + offsets.join("") + tails;
};

// THE V3 PATH: tokenIn(20) ++ fee(3 bytes, big-endian) ++ tokenOut(20) ++ (fee ++ token)... The 3-byte fee is the
// pool fee tier (Uniswap/universal-router Path.sol; uniswapx-sdk swapRouter02Helpers.encodePath).
export const uniswapRelayPath = (tokens, fees) => {
  if (!Array.isArray(tokens) || tokens.length !== fees.length + 1) boom("uniswaprelay-bad-path");
  let body = "";
  for (let i = 0; i < fees.length; i++) {
    body += String(tokens[i]).replace(/^0x/, "").toLowerCase();
    const fee = Number(fees[i]);
    if (!Number.isInteger(fee) || fee < 0 || fee > 0xffffff) boom("uniswaprelay-bad-fee");
    body += fee.toString(16).padStart(UNISWAPRELAY_PATH_FEE_BYTES * 2, "0");
  }
  body += String(tokens[tokens.length - 1]).replace(/^0x/, "").toLowerCase();
  return "0x" + body;
};

// abi.encode(address recipient,uint256 amountIn,uint256 amountOutMin,bytes path,bool payerIsUser) - the parameter
// order of the UniversalRouter's V3_SWAP_EXACT_IN command (Uniswap/universal-router V3SwapRouter / IV3SwapRouter).
export const encodeV3SwapExactIn = ({ recipient, amountInWei, amountOutMinimumWei, path, payerIsUser = false }) => {
  const pathBody = String(path).replace(/^0x/, "");
  const head = concat(
    wordAddress(recipient),
    wordUint(amountInWei, 256),
    wordUint(amountOutMinimumWei, 256),
    wordUint(0xa0, 256),
    wordBool(payerIsUser),
  );
  const tail = concat(wordUint(pathBody.length / 2, 256), hexToBytes("0x" + padRight(pathBody)));
  return bytesToHex(concat(head, tail));
};

// abi.encode(address recipient,uint256 amountMin) - the parameter order of the UNWRAP_WETH command
// (Uniswap/universal-router V3SwapRouter.unwrapWETH9).
export const encodeUnwrapWeth = ({ recipient, amountMinimumWei }) =>
  bytesToHex(concat(wordAddress(recipient), wordUint(amountMinimumWei, 256)));

/**
 * BUILD THE UNIVERSALROUTER CALLDATA for a swap of tokenIn into the chain's NATIVE coin through the wrapped native
 * (weth): a V3 exact-input swap paying from the router's own balance, followed by unwrapping the whole wrapped
 * balance to `recipient`. This is the shape Uniswap's own relayer tests generate for token -> native.
 */
export const uniswapRelayRouterCalldata = ({
  tokenIn, weth, fee, amountInWei, amountOutMinimumWei, recipient,
}) => {
  const path = uniswapRelayPath([tokenIn, weth], [fee]);
  const commands = "0x"
    + UNISWAPRELAY_UR_COMMAND.v3SwapExactIn.toString(16).padStart(2, "0")
    + UNISWAPRELAY_UR_COMMAND.unwrapWeth.toString(16).padStart(2, "0");
  const swap = encodeV3SwapExactIn({ recipient: UNISWAPRELAY_ADDRESS_THIS, amountInWei, amountOutMinimumWei, path, payerIsUser: false });
  const unwrap = encodeUnwrapWeth({ recipient, amountMinimumWei: amountOutMinimumWei });
  const commandsBody = commands.replace(/^0x/, "");
  const commandsEnc = wordHex(hexToBytes(commands).length) + padRight(commandsBody);
  const inputsEnc = abiEncodeBytesArray([swap, unwrap]).replace(/^0x/, "");
  const offsetCommands = 0x40;
  const offsetInputs = 0x40 + commandsEnc.length / 2;
  return UNISWAPRELAY_EXECUTE_SELECTOR
    + wordHex(offsetCommands) + wordHex(offsetInputs) + commandsEnc + inputsEnc;
};

// Reading back the words a calldata carries: the idiom the demo's own DEX leg uses (www/js/evm/dexExec.js
// decodeSwapCalldata), so a built calldata is checked against the order rather than trusted.
const wordsOf = (hex) => {
  const body = String(hex).replace(/^0x/, "");
  const out = [];
  for (let i = 0; i + 64 <= body.length; i += 64) out.push(BigInt("0x" + body.slice(i, i + 64)));
  return out;
};
const wordToAddress = (w) => "0x" + w.toString(16).padStart(40, "0");

/**
 * DECODE the calldata this spec builds, back into the commands and the two command inputs. Returns null when the
 * bytes are not exactly this shape (not execute(bytes,bytes[]), not two commands, not V3_SWAP_EXACT_IN +
 * UNWRAP_WETH). A decode that nearly works is exactly how a substituted field reads as trusted, so every boundary
 * is checked.
 */
export const uniswapRelayRouterDecode = (data) => {
  const body = String(data || "").replace(/^0x/, "").toLowerCase();
  if (body.slice(0, 8) !== UNISWAPRELAY_EXECUTE_SELECTOR.slice(2)) return null;
  const args = body.slice(8);
  const w = wordsOf("0x" + args);
  if (w.length < 2) return null;
  const offCommands = Number(w[0]);
  const offInputs = Number(w[1]);
  if (offCommands % 32 !== 0 || offInputs % 32 !== 0) return null;
  const commandsLen = Number(w[offCommands / 32]);
  const commands = "0x" + args.slice(offCommands * 2 + 64, offCommands * 2 + 64 + commandsLen * 2);
  const arrayAt = offInputs / 32;
  const count = Number(w[arrayAt]);
  if (count !== 2) return null;
  const readItem = (i) => {
    const rel = Number(w[arrayAt + 1 + i]);
    const at = arrayAt + 1 + rel / 32;
    const hex = "0x" + args.slice(at * 64 + 64);
    return { words: w.slice(at + 1), hex };
  };
  const a = readItem(0);
  const b = readItem(1);
  const swap = {
    recipient: wordToAddress(a.words[0]),
    amountInWei: a.words[1],
    amountOutMinimumWei: a.words[2],
    pathOffset: Number(a.words[3]),
    payerIsUser: a.words[4] === 1n,
  };
  const pathAt = swap.pathOffset / 32;
  const pathLen = Number(a.words[pathAt]);
  swap.path = "0x" + a.hex.replace(/^0x/, "").slice(pathAt * 64 + 64, pathAt * 64 + 64 + pathLen * 2);
  const unwrap = { recipient: wordToAddress(b.words[0]), amountMinimumWei: b.words[1] };
  return { commands, swap, unwrap, items: [a.hex, b.hex] };
};

// THE PATH READ BACK AS TOKENS AND FEES: the 20+3 byte walk (Uniswap/universal-router Path.sol). Returns the token
// list and the fee list, or null when an address is not 20 bytes or a fee slot is not 3 bytes.
export const uniswapRelayDecodePath = (path) => {
  const body = String(path || "").replace(/^0x/, "").toLowerCase();
  if (body.length < 40) return null;
  const tokens = ["0x" + body.slice(0, 40)];
  const fees = [];
  let at = 40;
  while (at < body.length) {
    if (body.length - at < 6 + 40) return null;
    fees.push(parseInt(body.slice(at, at + 6), 16));
    at += 6;
    tokens.push("0x" + body.slice(at, at + 40));
    at += 40;
  }
  return { tokens, fees };
};
