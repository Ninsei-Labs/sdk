// MONERO KEYS FROM A SEED, WITHOUT THE VENDORED MONERO-JS BUNDLE.
//
// Monero is edwards25519, but its key derivation is not the BIP39/BIP32 one:
//   spend secret = sc_reduce32(seed)
//   view secret  = sc_reduce32(keccak256(spend secret))
//   public keys  = secret * G (compressed)
// The subaddress formula is the Monero one: m = Hs("SubAddr\0" || view secret || account || index), then
// (spend public + m*G, view secret * that public point).
//
// The primitives are the package's own: @noble/curves for ed25519 and @noble/hashes for keccak. No new dependency
// and no second implementation of the curve are introduced by this module.
import { ed25519, keccak256 } from "../../src/primitives.mjs";

const ORDER = ed25519.Point.Fn.ORDER;
const SCALAR_BYTES = 32;

function toBigIntLE(bytes) {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function toBytesLE(value, width = SCALAR_BYTES) {
  const out = new Uint8Array(width);
  let n = value;
  for (let i = 0; i < width; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function reduce(bytes) {
  if (bytes.length > 64) throw new Error("scalar is longer than 64 bytes");
  const padded = new Uint8Array(64);
  padded.set(bytes);
  return toBytesLE(toBigIntLE(padded) % ORDER);
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value && value.buffer instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value || []);
}

function hexOf(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function pointOf(bytes) {
  return ed25519.Point.fromHex(hexOf(bytes));
}

function publicOf(secret) {
  return ed25519.Point.BASE.multiply(toBigIntLE(secret)).toBytes();
}

function uint32LE(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 32) throw new Error("invalid subaddress index");
  const out = new Uint8Array(4);
  out[0] = value & 0xff;
  out[1] = (value >>> 8) & 0xff;
  out[2] = (value >>> 16) & 0xff;
  out[3] = (value >>> 24) & 0xff;
  return out;
}

const SUBADDR_PREFIX = new TextEncoder().encode("SubAddr\0");

function subaddressKeys({ privateView, publicSpend }, index, account) {
  if (index === 0 && account === 0) return { publicSpendKey: publicSpend, publicViewKey: publicOf(privateView) };
  const buffer = new Uint8Array(SUBADDR_PREFIX.length + SCALAR_BYTES + 8);
  buffer.set(SUBADDR_PREFIX, 0);
  buffer.set(privateView, SUBADDR_PREFIX.length);
  buffer.set(uint32LE(account), SUBADDR_PREFIX.length + SCALAR_BYTES);
  buffer.set(uint32LE(index), SUBADDR_PREFIX.length + SCALAR_BYTES + 4);
  const scalar = reduce(keccak256(buffer));
  const publicSpendKey = pointOf(publicSpend).add(ed25519.Point.BASE.multiply(toBigIntLE(scalar))).toBytes();
  const publicViewKey = pointOf(publicSpendKey).multiply(toBigIntLE(privateView)).toBytes();
  return { publicSpendKey, publicViewKey };
}

export class Wallet {
  #privateSpend;
  #privateView;
  #publicSpend;
  #publicView;

  constructor(privateSpend) {
    if (!(privateSpend instanceof Uint8Array) || privateSpend.length !== SCALAR_BYTES) {
      throw new Error("invalid private spend key");
    }
    if (toBigIntLE(privateSpend) >= ORDER) throw new Error("invalid private spend key");
    this.#privateSpend = privateSpend;
    this.#privateView = reduce(keccak256(privateSpend));
    this.#publicSpend = publicOf(privateSpend);
    this.#publicView = publicOf(this.#privateView);
  }

  get privateSpendKey() { return this.#privateSpend; }
  get privateViewKey() { return this.#privateView; }
  get publicSpendKey() { return this.#publicSpend; }
  get publicViewKey() { return this.#publicView; }

  subaddress(index = 0, account = 0) {
    return subaddressKeys({ privateView: this.#privateView, publicSpend: this.#publicSpend }, index, account);
  }
}

export function fromSeed(seed) {
  const bytes = bytesOf(seed);
  return new Wallet(reduce(bytes.length === SCALAR_BYTES ? bytes : keccak256(bytes)));
}

export function fromPrivateSpendKey(key) {
  return new Wallet(bytesOf(key));
}

export async function initEcc() {
  // The noble primitives are ready on import; the old async libsodium initialiser is gone.
  return undefined;
}
