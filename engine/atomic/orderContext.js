// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/orderContext.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// CANONICAL ORDER CONTEXT - what the DLEQ proof binds to.
// It is built FROM THE ORDER FIELDS and identically everywhere (app, provider node, any verifier), so a
// proof can be checked from the on-chain order alone (docs 27, section 11).
// It holds only the ORDER CONDITIONS known before any proof: network, factory, depositor, claimer, amount,
// deadlines and salt. Commitments and points are NOT here - they appear only WITH the proof, so binding them
// would make the order circular. They are pinned separately in the order's termsHash.
// The escrow address is not here either: it is a CREATE2 consequence, not an input.
// CONTEXT VERSION. The prefix separates the context from any other signature or proof; the field set may change
// only together with the version. v2 changed the field set; v3 changed the DLEQ call hash (SHA3-512 wide
// reduction instead of keccak256), so a v2 proof does not verify under v3.
export const ORDER_CONTEXT_VERSION = "ninsei-order-v3";

const norm = (v) => String(v === undefined || v === null ? "" : v).trim().toLowerCase();
const dec = (v) => {
  // Numbers are turned into decimal strings: "0x10" and "16" are the same number, and leaving them as
  // received would give different contexts for one order and break the proof for no reason.
  if (typeof v === "bigint") return v.toString(10);
  if (typeof v === "number") return String(Math.trunc(v));
  const s = norm(v);
  if (s.startsWith("0x")) return BigInt(s).toString(10);
  return s;
};

// Fields are listed EXPLICITLY in a fixed order. The order is part of the protocol: rearranging it
// invalidates all issued quotes for the order at once.
const FIELDS = [
  "chainId",            // network: the same order on different networks is a different order
  "factory",            // which factory creates the escrow
  "locker",             // who deposits ETH
  "claimer",            // whom the contract pays
  "amount",             // amount in wei
  "readyBy",            // readiness deadline
  "t1",                 // settlement deadline
  "salt",               // order salt
];

export function orderContextString(order) {
  if (!order || typeof order !== "object") throw new Error("order context needs an object with the order fields");
  const missing = FIELDS.filter((f) => order[f] === undefined || order[f] === null || order[f] === "");
  if (missing.length) throw new Error("order context is missing fields: " + missing.join(", "));
  return ORDER_CONTEXT_VERSION + "|" + FIELDS.map((f) => dec(order[f])).join("|");
}
