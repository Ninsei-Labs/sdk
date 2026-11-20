// MONERO KEY IMAGES WITHOUT A WALLET. The spend key and the funding outputs are already in the SDK; this module
// turns each verified output into the image a node's `is_key_image_spent` call takes.
//
// THE FORMULAS COME FROM MONERO'S OWN SOURCE, NOT FROM A GUESS:
//   u = fe_frombytes(keccak256(outputKey))
//   P = ge_fromfe_frombytes_vartime(u)
//   Hp(P) = 8 * P
//   x = Hs(derivation || varint(index)) + b mod l
//   keyImage = x * Hp(P)
//
// `ge_fromfe_frombytes_vartime` is CryptoNote's map from a field element to a curve point. It is NOT
// `Point.fromHex(hash)`: ref10's `fromfe` is an Elligator-style map and the cofactor multiply is part of the
// key-image rule. The constants below are the canonical values from Monero's `crypto-ops-data.c`; a wrong root
// here returns a valid-looking point and a wrong image, so the vectors in `tools/check-key-image.mjs` pin every
// branch.
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ED_ORDER, bytesToHex, hashToScalar, hexToBytes, scalarFromHexLE, varint } from "./scan.js";

const P = (1n << 255n) - 19n;
const A = 486662n;
const mod = (x) => ((x % P) + P) % P;
const pow = (b, e) => {
  let result = 1n;
  let base = mod(b);
  let exponent = e;
  while (exponent > 0n) {
    if (exponent & 1n) result = result * base % P;
    base = base * base % P;
    exponent >>= 1n;
  }
  return result;
};
const invert = (x) => pow(x, P - 2n);
const MA = mod(-A);
const MA2 = mod(-A * A);
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
const FFFB1 = 57192811444617977854858898469001663971726463542204390960804972474891788632558n;
const FFFB2 = 34838897745748397871374137087405348832069628406613012804793447631241588021984n;
const FFFB3 = 46719087769223307720043111813545796356806574765024592941723029582131464514662n;
const FFFB4 = 11880190023474909848668974726140447524736946358411580136929581950889876492678n;

const pointHex = (value) => String(value == null ? "" : value).replace(/^0x/i, "").toLowerCase();
const isPoint = (value) => /^[0-9a-f]{64}$/.test(pointHex(value));

/** ref10 `ge_fromfe_frombytes_vartime`, returning the compressed Edwards point. */
export function hashToPoint(input) {
  const bytes = typeof input === "string" ? hexToBytes(input) : Uint8Array.from(input);
  if (bytes.length !== 32) throw new Error("hashToPoint: expected 32 bytes");
  const u = BigInt("0x" + bytesToHex(Uint8Array.from(bytes).reverse()));
  const v = 2n * u % P * u % P;
  const w = (v + 1n) % P;
  let x = mod(w * w + MA2 * v);
  let X = pow(w * invert(x), (P + 3n) / 8n);
  x = X * X % P * x % P;
  let y = mod(w - x);
  let z = MA;
  let sign;

  if (y !== 0n) {
    const sum = (w + x) % P;
    if (sum !== 0n) {
      // The square root was the other one. Multiply by sqrt(-1) and look again.
      x = x * SQRT_M1 % P;
      y = mod(w - x);
      X = X * (y !== 0n ? FFFB3 : FFFB4) % P;
      sign = 1;
    } else {
      X = X * FFFB1 % P * u % P;
      z = z * v % P;
      sign = 0;
    }
  } else {
    X = X * FFFB2 % P * u % P;
    z = z * v % P;
    sign = 0;
  }

  // THE SIGN IS CHOSEN ON X BEFORE THE PROJECTIVE MULTIPLICATION. Checking it on X/Z afterwards flips a valid
  // point for some inputs; the first vectors happened to have Z with the same parity.
  if ((X & 1n) !== BigInt(sign)) X = mod(-X);
  const Z = (z + w) % P;
  const Y = (z - w + P) % P;
  X = X * Z % P;
  const inverseZ = invert(Z);
  const affineX = X * inverseZ % P;
  const affineY = Y * inverseZ % P;
  const out = scalarToBytes(affineY);
  out[31] |= Number(affineX & 1n) << 7;
  return bytesToHex(out);
}

function scalarToBytes(value, width = 32) {
  const out = new Uint8Array(width);
  let rest = value;
  for (let i = 0; i < width; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** Monero `biased_hash_to_ec`: keccak(P), the fromfe map, then the cofactor multiply by 8. */
export function biasedHashToEc(publicKey) {
  if (!isPoint(publicKey)) throw new Error("biasedHashToEc: expected a compressed point");
  return ed25519.Point.fromHex(hashToPoint(keccak_256(hexToBytes(pointHex(publicKey)))))
    .multiply(8n).toHex();
}

/**
 * THE RAW KEY IMAGE PRIMITIVE: `b * Hp(P)`. `keyImageFromOutput` uses this after deriving `x`; the Monero
 * `generate_key_image` vectors call it with a known spend scalar. `requireOwnership` checks `b*G == P` and is on
 * for callers that hold both values.
 */
export function keyImageFromSpendKey({ outputKey, privateSpendKey, requireOwnership = true }) {
  if (!isPoint(outputKey)) throw new Error("keyImage: outputKey is not a compressed point");
  const spend = scalarFromHexLE(String(privateSpendKey || ""));
  if (spend <= 0n || spend >= ED_ORDER) throw new Error("keyImage: private spend key is not a scalar");
  const output = ed25519.Point.fromHex(pointHex(outputKey));
  if (requireOwnership && output.toHex().toLowerCase() !== ed25519.Point.BASE.multiply(spend).toHex().toLowerCase()) {
    throw new Error("keyImage: output does not belong to the private spend key");
  }
  return ed25519.Point.fromHex(biasedHashToEc(outputKey)).multiply(spend).toHex();
}

/**
 * THE KEY IMAGE OF ONE VERIFIED OUTPUT. `derivation` is the per-output value `findOurOutputs` already carries;
 * `privateSpendKey` is the little-endian hex `sweep.keys` returns. The `x*G == outputKey` check refuses a spend key
 * from another address instead of producing an image that no node can match.
 */
export function keyImageFromOutput({ outputKey, derivation, index, privateSpendKey }) {
  if (!isPoint(outputKey)) throw new Error("keyImage: outputKey is not a compressed point");
  if (!/^[0-9a-f]{64}$/i.test(String(derivation || "").replace(/^0x/i, ""))) {
    throw new Error("keyImage: derivation is not 32 bytes");
  }
  if (!Number.isSafeInteger(Number(index)) || Number(index) < 0) throw new Error("keyImage: bad output index");
  const spend = scalarFromHexLE(String(privateSpendKey || ""));
  if (spend <= 0n || spend >= ED_ORDER) throw new Error("keyImage: private spend key is not a scalar");
  const output = ed25519.Point.fromHex(pointHex(outputKey));
  const scalar = hashToScalar(hexToBytes(derivation), varint(Number(index)));
  const x = (scalar + spend) % ED_ORDER;
  if (x === 0n || output.toHex().toLowerCase() !== ed25519.Point.BASE.multiply(x).toHex().toLowerCase()) {
    throw new Error("keyImage: output does not belong to the private spend key");
  }
  return ed25519.Point.fromHex(biasedHashToEc(outputKey)).multiply(x).toHex();
}
