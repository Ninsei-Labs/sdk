// ATOMIC SWAP PRIMITIVES - FROM THE SAME npm PACKAGES AS THE PAGE BUNDLE.
//
// The bundle entry point (tools/atomic-browser-entry.mjs) hands the page exactly five names: ed25519, secp256k1,
// keccak256, sha3_512, randomBytes. The order-side build modules (www/js/atomic/order.js) do NOT import them
// themselves - they arrive as parameters. That is what lets the SDK expose the same primitives from the same
// packages instead of dragging a hashed build artefact into the core: a package never has a "version with a
// different cache".
//
// WHY EXACTLY THESE PACKAGES, AND NOT JUST ANY. keccak256 and sha3_512 are DIFFERENT functions, and they must
// not be confused: the commitment for a half is computed with keccak256 (exactly as Solidity does it), while the
// DLEQ proof uses SHA3-512 with wide reduction. Swapping one for the other looks like a typo and costs a whole
// swap, so the difference is verified by a run on known values, not by eye.

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
// keccak_256 is taken from here, and NOT from the separate keccak256 package: that one accepts only a Buffer of
// ITS OWN instance and refuses bytes from another module with "invalid type" (verified by a run). The popular
// package of the family is already present for the curves and SHA3-512, and keccak_256 from it gives the same
// thing - this is confirmed by the known value of the empty string in the check, which also shows it is not
// sha3_256.
import { keccak_256, sha3_512 } from "@noble/hashes/sha3.js";
// The core speaks in CODES, not in phrases: a message here would become UI text by accident (check-sdk
// forbids user-facing strings in sdk/src).
import { fail } from "./errors.mjs";
export { ed25519, secp256k1, sha3_512 };

// The engine passes a Uint8Array, a Buffer and a string alike. We normalise on input so the caller need not think about it.
export const keccak256 = (data) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return keccak_256(bytes);
};

/** Bytes: the same representation as keccak256, so the caller need not tell the source apart. */
export const keccak256Bytes = (data) => keccak256(data);

// Random bytes. We take them from the environment (both the browser and Node provide crypto.getRandomValues),
// not from a third-party library: the source of randomness is the last thing you want to shuffle around.
export const randomBytes = (length) => {
  const out = new Uint8Array(length);
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function") fail("bad-input", { field: "random-bytes", why: "no-source" });
  source.getRandomValues(out);
  return out;
};

/** The five primitives as one set - exactly the shape createOrderBuilder expects. */
export const primitives = { ed25519, secp256k1, keccak256, sha3_512, randomBytes };
