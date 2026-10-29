// THE EIP-712 TERMS A RELAY FIRM REQUEST SIGNS.
//
// The relay forwards the client's exact payload as a string and signs its UTF-8 bytes. The same terms are
// also the HPKE context: `relayViewInfo` takes this digest, so a ciphertext is bound to the amounts, roles,
// deadlines and salt in the request rather than to a separately supplied label.
//
// The domain is the relay domain, not the factory domain: `{name: "Ninsei Relay", version: "1"}` has no
// chainId and no verifyingContract. The inner `OrderQuote` keeps its own factory domain; the two signatures
// are deliberately separate.
//
// The type strings and field order are wire format. A rearrangement produces another digest, and the node
// refuses the request before it decrypts anything.
import { SdkError } from "./errors.mjs";

export const FIRM_DOMAIN_NAME = "Ninsei Relay";
export const FIRM_DOMAIN_VERSION = "1";
const DOMAIN_TYPE_PARTS = ["EIP712Domain(", "string name,", "string version)"];
export const FIRM_DOMAIN_TYPE = DOMAIN_TYPE_PARTS.join("");

export const FIRM_ORDER_FIELDS = [
  ["chainId", "uint256"],
  ["factory", "address"],
  ["locker", "address"],
  ["claimer", "address"],
  ["amount", "uint256"],
  ["readyBy", "uint64"],
  ["t1", "uint64"],
  ["salt", "bytes32"],
];
export const FIRM_ORDER_TYPE = "FirmOrder(" + FIRM_ORDER_FIELDS.map(([name, type]) => type + " " + name).join(",") + ")";

export const FIRM_TERMS_FIELDS = [
  ["market", "string"],
  ["side", "string"],
  ["maker", "address"],
  ["registry", "address"],
  ["featuresHash", "bytes32"],
  ["xmrNetwork", "string"],
  ["order", "FirmOrder"],
  ["xmrAmount", "uint256"],
  ["claimTip", "uint256"],
];
// EIP-712 appends every referenced struct type to the primary type, sorted by name. `FirmOrder` is the only
// one, so the type hash covers both strings.
export const FIRM_TERMS_TYPE = "FirmTerms(" + FIRM_TERMS_FIELDS.map(([name, type]) => type + " " + name).join(",") + ")" + FIRM_ORDER_TYPE;

const utf8 = (value) => new TextEncoder().encode(String(value));
const concat = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const array of arrays) { out.set(array, at); at += array.length; }
  return out;
};
const hexToBytes = (value, field) => {
  const text = String(value === undefined || value === null ? "" : value).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2) throw new SdkError("bad-input", { field });
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const number = (value, field, bits) => {
  let n = null;
  try { n = BigInt(String(value === undefined || value === null ? "" : value).trim()); } catch { n = null; }
  if (n === null || n < 0n || n >= (1n << BigInt(bits))) throw new SdkError("bad-input", { field });
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i -= 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};
const address = (value, field) => {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(text)) throw new SdkError("bad-input", { field });
  const out = new Uint8Array(32);
  out.set(hexToBytes(text.replace(/^0x/, ""), field), 12);
  return out;
};
const bytes32 = (value, field) => {
  const bytes = hexToBytes(value, field);
  if (bytes.length !== 32) throw new SdkError("bad-input", { field });
  return bytes;
};

const encodeField = (crypto, type, value, field) => {
  if (type === "string") return crypto.keccak256(utf8(value === undefined || value === null ? "" : value));
  if (type === "address") return address(value, field);
  if (type === "bytes32") return bytes32(value, field);
  if (type === "uint64") return number(value, field, 64);
  if (type === "uint256") return number(value, field, 256);
  throw new SdkError("bad-input", { field });
};

const structHash = (crypto, typeString, fields, value, prefix) => {
  const parts = [crypto.keccak256(utf8(typeString))];
  for (const [field, type] of fields) {
    if (type === "FirmOrder") {
      const order = value && value.order;
      if (!order || typeof order !== "object") throw new SdkError("bad-input", { field: prefix + ".order" });
      parts.push(firmOrderHash(crypto, order));
    } else {
      parts.push(encodeField(crypto, type, value ? value[field] : undefined, prefix + "." + field));
    }
  }
  return crypto.keccak256(concat(...parts));
};

export function firmOrderHash(crypto, order) {
  return structHash(crypto, FIRM_ORDER_TYPE, FIRM_ORDER_FIELDS, order, "terms.order");
}

export function firmTermsDomainSeparator(crypto) {
  return crypto.keccak256(concat(
    crypto.keccak256(utf8(FIRM_DOMAIN_TYPE)),
    crypto.keccak256(utf8(FIRM_DOMAIN_NAME)),
    crypto.keccak256(utf8(FIRM_DOMAIN_VERSION)),
  ));
}

export function firmTermsStructHash({ crypto, terms } = {}) {
  if (!crypto || typeof crypto.keccak256 !== "function") throw new SdkError("bad-input", { field: "crypto" });
  return structHash(crypto, FIRM_TERMS_TYPE, FIRM_TERMS_FIELDS, terms, "terms");
}

export function firmTermsDigest({ crypto, terms } = {}) {
  if (!crypto || typeof crypto.keccak256 !== "function") throw new SdkError("bad-input", { field: "crypto" });
  return crypto.keccak256(concat(Uint8Array.from([0x19, 0x01]), firmTermsDomainSeparator(crypto), firmTermsStructHash({ crypto, terms })));
}

// Absent fields are named, not treated as zero. The relay client builds a request only from a complete set.
export function firmTermsMissingFields(terms) {
  const missing = [];
  if (!terms || typeof terms !== "object") return ["terms"];
  for (const [name] of FIRM_TERMS_FIELDS) {
    if (name === "order") {
      if (!terms.order || typeof terms.order !== "object") missing.push("order");
      else for (const [field] of FIRM_ORDER_FIELDS) {
        const value = terms.order[field];
        if (value === undefined || value === null || value === "") missing.push("order." + field);
      }
    } else {
      const value = terms[name];
      if (value === undefined || value === null || value === "") missing.push(name);
    }
  }
  return missing;
}
