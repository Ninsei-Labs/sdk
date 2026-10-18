// RFQ NODE IDENTITY: the code from the PROVIDER ADDRESS and a human-readable name.
//
// THIS IS THE NODE'S RESPONSIBILITY, NOT OUR BACKEND'S. The node derives its code from its address itself, picks the
// name itself and only sends them in the packet. Our backend accepts and CHECKS the shape, but invents nothing:
// if we assigned the code or the name, we would be defining the provider's identity instead of him.
//
// WHY FROM THE ADDRESS AND NOT FROM THE KEY. A provider's identity is his EVM address: a quote signature is made with an EIP-712
// wallet key, and the CHAIN checks that the key belongs to the address (maker registry, providerOf). The Ed25519 key
// stays with the node, but does something else: the Monero halves are derived from it and the market packets are signed with it. The code
// must follow the one the chain confirms - the address. The former code was computed from the ed25519 key and
// therefore changed with it, not with the identity (owner's decision: backward compatibility is not needed).
import { createHash, randomBytes } from "node:crypto";

// Code shape. Strict: "lp-" and exactly 8 hex in lower case.
export const PROVIDER_CODE_RE = /^lp-[0-9a-f]{8}$/;

// A human-readable name shorter than this limit: long names break tables and logs.
export const DISPLAY_NAME_MAX = 48;

// PROVIDER CODE. Computed from the provider's EVM ADDRESS (lower case, with 0x), not from the ed25519 key.
//
// Why deterministic and from one address: the code must be THE SAME everywhere the maker is seen (decision 14),
// and must not change when the node restarts. The address IS the identity, so the code survives a key change and does not
// depend on which of the accepted keys signed the quote this time.
export function providerCode(address) {
  const a = String(address == null ? "" : address).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) {
    throw new Error("provider code is derived from an EVM address, got " + JSON.stringify(String(address).slice(0, 24)));
  }
  return "lp-" + createHash("sha256").update(a).digest("hex").slice(0, 8);
}

// A RANDOM NAME - for the case when no name is set in the config. The node must not stay nameless: in market
// view a provider has to be called something for a human. The alphabet is Latin simply because this is a generated name;
// a manually set one may be anything - identity is defined by the code, not by the name.
const WORDS = ["north", "harbor", "lumen", "cedar", "atlas", "quartz", "verde", "nova", "orbit", "delta"];

export function randomDisplayName() {
  const word = WORDS[randomBytes(2).readUInt16BE(0) % WORDS.length];
  return word + "-" + randomBytes(2).toString("hex");
}
