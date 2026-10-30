// THE PUBLIC FEATURES A RELAY MAKER SIGNS.
//
// A relay price answer carries a `node_features` string signed by the maker's quote key. The client must check
// that signature before it uses the `hpkeKey`, the registry or the firm windows: an unsigned or substituted key
// would receive view material for another maker. This module owns the EIP-712 type, the relay domain and the
// verification; the request builder takes only the verified result.
//
// The public object has no contact fields. The relay forwards the exact string it received; this module hashes
// the decoded values, not a reconstructed subset.
import { SdkError } from "./errors.mjs";
import { keccak256, secp256k1 } from "./primitives.mjs";

export const RELAY_FEATURES_TYPE_NAME = "NodeFeatures";
export const RELAY_DOMAIN_NAME = "Ninsei Relay";
export const RELAY_DOMAIN_VERSION = "1";

const DOMAIN_TYPE = "EIP712Domain(string name,string version)";
export const FIRM_WINDOW_TYPE =
  "FirmWindow(string market,string side,string xmrNetwork,uint32 readyMinSeconds,uint32 readyMaxSeconds,uint32 settlementMinSeconds,uint32 settlementMaxSeconds,uint32 quoteTtlSeconds)";
export const NODE_FEATURES_TYPE =
  "NodeFeatures(string relayId,address provider,address quoteKey,address registry,bytes32 hpkeKey,FirmWindow[] firmWindows,uint64 time,bytes32 nonce)" +
  FIRM_WINDOW_TYPE;

export const FIRM_WINDOW_FIELDS = [
  ["market", "string"],
  ["side", "string"],
  ["xmrNetwork", "string"],
  ["readyMinSeconds", "uint32"],
  ["readyMaxSeconds", "uint32"],
  ["settlementMinSeconds", "uint32"],
  ["settlementMaxSeconds", "uint32"],
  ["quoteTtlSeconds", "uint32"],
];
export const NODE_FEATURES_FIELDS = [
  ["relayId", "string"],
  ["provider", "address"],
  ["quoteKey", "address"],
  ["registry", "address"],
  ["hpkeKey", "bytes32"],
  ["firmWindows", "FirmWindow[]"],
  ["time", "uint64"],
  ["nonce", "bytes32"],
];

const utf8 = (value) => new TextEncoder().encode(String(value));
const concat = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const array of arrays) { out.set(array, at); at += array.length; }
  return out;
};
const hexBytes = (value, field, width) => {
  const text = String(value === undefined || value === null ? "" : value).replace(/^0x/, "");
  if (!new RegExp("^[0-9a-fA-F]{" + width * 2 + "}$").test(text)) {
    throw new SdkError("bad-input", { field });
  }
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const numberWord = (value, field, bits) => {
  let n = null;
  try { n = BigInt(String(value === undefined || value === null ? "" : value).trim()); } catch { n = null; }
  if (n === null || n < 0n || n >= (1n << BigInt(bits))) throw new SdkError("bad-input", { field });
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i -= 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};
const addressWord = (value, field) => {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(text)) throw new SdkError("bad-input", { field });
  const out = new Uint8Array(32);
  out.set(hexBytes(text, field, 20), 12);
  return out;
};
const stringWord = (value) => keccak256(utf8(value === undefined || value === null ? "" : value));
const arrayWord = (values, field, hashOf) => {
  if (!Array.isArray(values)) throw new SdkError("bad-input", { field });
  const parts = values.map((value) => hashOf(value));
  return keccak256(concat(...parts));
};

function firmWindowHash(window) {
  if (!window || typeof window !== "object") throw new SdkError("bad-input", { field: "firmWindows" });
  const parts = [keccak256(utf8(FIRM_WINDOW_TYPE))];
  for (const [field, type] of FIRM_WINDOW_FIELDS) {
    parts.push(type === "string" ? stringWord(window[field]) : numberWord(window[field], "firmWindows." + field, 32));
  }
  return keccak256(concat(...parts));
}

export function nodeFeaturesStructHash(features) {
  if (!features || typeof features !== "object") throw new SdkError("bad-input", { field: "features" });
  const parts = [keccak256(utf8(NODE_FEATURES_TYPE))];
  for (const [field, type] of NODE_FEATURES_FIELDS) {
    if (type === "string") parts.push(stringWord(features[field]));
    else if (type === "address") parts.push(addressWord(features[field], "features." + field));
    else if (type === "bytes32") parts.push(hexBytes(features[field], "features." + field, 32));
    else if (type === "uint64") parts.push(numberWord(features[field], "features." + field, 64));
    else if (type === "string[]") parts.push(arrayWord(features[field], "features." + field, (value) => stringWord(value)));
    else if (type === "FirmWindow[]") parts.push(arrayWord(features[field], "features." + field, firmWindowHash));
    else throw new SdkError("bad-input", { field: "features." + field });
  }
  return keccak256(concat(...parts));
}

export function nodeFeaturesDomainSeparator() {
  return keccak256(concat(
    keccak256(utf8(DOMAIN_TYPE)),
    keccak256(utf8(RELAY_DOMAIN_NAME)),
    keccak256(utf8(RELAY_DOMAIN_VERSION)),
  ));
}

export function nodeFeaturesDigest(features) {
  return keccak256(concat(Uint8Array.from([0x19, 0x01]), nodeFeaturesDomainSeparator(), nodeFeaturesStructHash(features)));
}

const bytesToHex = (bytes) => {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

function recoverAddress(digest, signature) {
  const sig = String(signature || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(sig)) return null;
  let v = parseInt(sig.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const publicKey = secp256k1.Signature.fromBytes(concat(
      hexBytes(sig.slice(0, 64), "signature", 32),
      hexBytes(sig.slice(64, 128), "signature", 32),
    )).addRecoveryBit(v).recoverPublicKey(digest);
    return bytesToHex(keccak256(publicKey.toBytes(false).slice(1)).slice(12));
  } catch {
    return null;
  }
}

/**
 * Verify the signed public features. `terms` optionally binds the features to one request: the provider, the
 * registry, the market, the side and the Monero network must agree. A zero key, a short key, a missing or empty
 * window list, or a signature from another key is a refusal.
 */
export function verifyNodeFeatures({ features, terms = null } = {}) {
  if (!features || typeof features !== "object") throw new SdkError("bad-input", { field: "features" });
  if (features.type !== "node_features" || Number(features.version) !== 1) {
    throw new SdkError("quote-refused", { step: "features", why: "version" });
  }
  const digest = nodeFeaturesDigest(features);
  const recovered = recoverAddress(digest, features.signature);
  const quoteKey = String(features.quoteKey || "").toLowerCase();
  if (recovered === null || recovered !== quoteKey) {
    throw new SdkError("quote-refused", { step: "features", why: "signature" });
  }
  const hpkeKey = String(features.hpkeKey || "").replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hpkeKey) || /^0+$/.test(hpkeKey)) {
    throw new SdkError("quote-refused", { step: "features", why: "hpke-key" });
  }
  if (!Array.isArray(features.firmWindows) || features.firmWindows.length === 0) {
    throw new SdkError("quote-refused", { step: "features", why: "windows" });
  }
  if (terms) {
    if (String(features.provider || "").toLowerCase() !== String(terms.maker || "").toLowerCase()
      || String(features.registry || "").toLowerCase() !== String(terms.registry || "").toLowerCase()) {
      throw new SdkError("quote-refused", { step: "features", why: "identity" });
    }
    const market = String(terms.market || "");
    const side = String(terms.side || "");
    const network = String(terms.xmrNetwork || "");
    const window = features.firmWindows.find((entry) => entry
      && entry.market === market && entry.side === side && entry.xmrNetwork === network);
    if (!window) throw new SdkError("quote-refused", { step: "features", why: "window" });
    return { featuresHash: bytesToHex(digest), hpkeKey: "0x" + hpkeKey, window };
  }
  return { featuresHash: bytesToHex(digest), hpkeKey: "0x" + hpkeKey, window: null };
}

// Absent fields are named, not zero-filled.
export function nodeFeaturesMissingFields(features) {
  if (!features || typeof features !== "object") return ["features"];
  const missing = [];
  for (const [field] of NODE_FEATURES_FIELDS) {
    const value = features[field];
    if (value === undefined || value === null || value === "") missing.push(field);
  }
  return missing;
}
