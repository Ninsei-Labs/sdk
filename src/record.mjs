// THE SWAP RECORD: CREATION AND OUR SIDE OF THE ORDER.
//
// What is here and what is not - and why exactly so.
//
// PRESENT: the swap record (the engine's `createSwap` - a pure state record) and OUR side of the order. When the
// order terms are given, the side is built by the ENGINE'S BUILDER (www/js/atomic/order.js): two halves, their
// public points, the DLEQ PROOF and the side's encryption key. The core does not invent its own halves: the
// proof is bound to the order terms (how much, to whom, the deadlines, the salt, the factory, the chain), so
// without them there is nothing to bind it to - and the record refuses with a code naming the field.
//
// ABSENT: the counterparty's side. Its half and point come from the order (or a sandbox stand-in is built), and
// that is exactly why the record returns nextStep: "order" and missing: ["counterparty-half"]: a recovery file
// cannot be assembled without the other half.
import { SdkError } from "./errors.mjs";
import { primitives } from "./primitives.mjs";
import * as engine from "./engine.mjs";
import { buildOwnSide, halfHex, norm } from "./order.mjs";

/**
 * Our side. Without order terms - only the halves and their points (a shape of the record; there is no proof and
 * there cannot be: there is nothing to prove). With terms - the whole side is built by the engine's builder.
 *
 * THE HALF NAMES ARE THE ENGINE'S: the half is returned in the engine's form (BigInt), and it goes into the
 * record as a hex string, because a BigInt survives neither storage nor the recovery file's JSON.
 */
export function ownSide(order = null) {
  if (order !== null && order !== undefined) {
    const built = buildOwnSide(order);
    return built.side;
  }
  const halves = engine.halves.createHalves(primitives);
  const half = halves.newHalf();
  const viewHalf = halves.newHalf();
  return { half, viewHalf, pub: halves.publicHalves(half), viewPub: halves.publicHalves(viewHalf).ed };
}

/**
 * Create the swap record and put OUR side into it.
 * The record's field names are the ones the engine reads them by (`halvesWalletOf`: half, viewHalf,
 * edPointLocker, edViewPointLocker). The counterparty's half cannot and need not be put in: it will come from
 * the order.
 */
export function createRecord(input, { order = null } = {}) {
  if (!input || typeof input !== "object") throw new SdkError("bad-input", { field: "input" });
  const side = ownSide(order);
  let swap = null;
  try { swap = engine.swap.createSwap(input); } catch { throw new SdkError("bad-input", { field: "input" }); }
  const escrow = { ...(swap.escrow || {}),
    // THE HALVES ARE A HEX STRING (a BigInt does not survive JSON), the points are in canonical form: that is how
    // both the slot check against the chain and the address check read them.
    half: halfHex(side.half), viewHalf: halfHex(side.viewHalf),
    edPointLocker: norm(side.pub.ed), edViewPointLocker: norm(side.viewPub) };
  // THE SIDE'S ENCRYPTION KEY - only the public one: the private one stays with the side and never enters the record.
  if (side.enc && side.enc.pub) escrow.encPub = norm(side.enc.pub);
  const record = { ...swap, escrow };
  // THE ORDER-QUOTE ID (a defect found). The engine's createSwap builds the record BY A LIST OF FIELDS, and the
  // `orderQuoteId` field is not in it: the value brought by the request was silently lost. And our service uses
  // it to tie the created escrow to the provider node's record - without it the node will not take the ETH (the
  // mark body carried quoteId: null). The screen used to set this field itself
  // (www/js/ui/views/confirm.js: swap.orderQuoteId = flow.quoteId).
  const quoteId = input && input.orderQuoteId;
  if (quoteId !== undefined && quoteId !== null && quoteId !== "") record.orderQuoteId = quoteId;
  try { engine.swap.saveSwap(record); } catch { throw new SdkError("storage-unavailable", { step: "save-swap" }); }
  return { swap: record, side, missing: ["counterparty-half"], nextStep: "order" };
}
