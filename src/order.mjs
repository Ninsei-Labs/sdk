// THE COUNTERPARTY'S SIDE AND THE JOINT ADDRESS.
//
// TWO CHECKS, BOTH MANDATORY BEFORE SIGNING - after it there is nothing to fix:
//
//   1) the DLEQ proof stands in the CONTEXT OF THIS order: the counterparty proved for our terms, not for others.
//      The context is the same one the quote signature is bound to (see quotes.firm);
//   2) the proven ed25519 point is THE VERY ONE that will go into the contract and from which the address is
//      assembled. Without this check the counterparty could prove one thing and substitute another: on our side
//      everything would look sound, and the discrepancy would surface when claiming the XMR, with nothing left to
//      fix.
//
// Both are done by the engine (order.js: the verifying code is the same for us and for the counterparty). The
// core has no cryptography of its own and should not: a copy would silently drift from the original.
import { SdkError } from "./errors.mjs";
import { primitives } from "./primitives.mjs";
import * as engine from "./engine.mjs";

const builder = () => engine.order.createOrderBuilder(primitives);

/** The order context: the string the proof and the quote signature are both bound to. */
export function contextOf(order) {
  if (!order || typeof order !== "object") throw new SdkError("bad-input", { field: "order" });
  try { return engine.orderContext.orderContextString(order); }
  catch { throw new SdkError("bad-input", { field: "order" }); }
}

/**
 * Check the counterparty's side in the order context. It passed - return the side itself; it did not - a refusal
 * with a CODE (`quote-refused { step: "proof" }`). "Probably fine" does not exist here: the side is either proven
 * or it is not.
 */
export function verifyCounterparty({ side, order, sealed = null, ownEncPriv = null }) {
  if (!side || typeof side !== "object") throw new SdkError("bad-input", { field: "side" });
  const context = contextOf(order);
  let verdict = null;
  try { verdict = builder().verifySide(side, context, sealed, ownEncPriv); }
  catch { throw new SdkError("bad-input", { field: "side" }); }
  if (!verdict || verdict.ok !== true) {
    throw new SdkError("quote-refused", { step: "proof", why: verdict && verdict.reason ? "rejected" : "unknown" });
  }
  return side;
}

/**
 * The shared Monero address: your own spend half and the other's POINT (the same for the view key). We take the
 * same encoder the wallet uses: a second one would drift from the first where the error is visible only by
 * sending XMR.
 */
export function jointAddress({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network }) {
  const need = { ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint };
  const missing = Object.keys(need).filter((k) => need[k] === undefined || need[k] === null || need[k] === "");
  if (missing.length) throw new SdkError("bad-input", { field: "jointAddress", missing });
  try {
    return builder().jointAddress({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network });
  } catch { throw new SdkError("bad-input", { field: "jointAddress" }); }
}

// --- THE ORDER STEP: FROM OUR SIDE TO THE JOINT ADDRESS -----------------------------------------
//
// WHY THIS IS A SINGLE CALL AND NOT THREE SEPARATE ONES. The order here IS the rule: your own side -> the
// counterparty's side (accepted and verified in THIS SAME context) -> the joint address. The address is assembled
// from YOUR half and the OTHER's point, so before the counterparty's side appears it simply does not exist - and
// refusing here is cheaper than discovering the discrepancy when claiming the XMR, with nothing left to fix.
//
// THERE IS NOT A SINGLE FORMULA OF OUR OWN HERE. The halves, the points, the DLEQ proof, the encryption key and
// the address are computed by the engine's builder (www/js/atomic/order.js) on the core's primitives. The core
// names the order and translates the result into the record's fields - exactly the names the engine reads
// (core/swap.js, halvesWalletOf).

export const norm = (h) => "0x" + String(h).replace(/^0x/i, "").toLowerCase();
// A HALF AT THE BOUNDARY IS A HEX STRING: a BigInt survives neither storage nor the recovery file
// (www/js/recovery/recoveryFile.js, bigintSafe). One form at every boundary, otherwise JSON silently loses the key.
export const halfHex = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const isPoint = (h) => /^0x[0-9a-f]{64}$/.test(String(h));
// THE PROVEN POINT AND THE POINT IN THE ORDER MUST BE WRITTEN IDENTICALLY. The engine compares them AS STRINGS
// (order.js, verifySide), so the record's form is part of the check, not cosmetics: without bringing both to one
// form, a correct proof would look like a discrepancy. The page does the same
// (sdk/src/swap-flow.mjs: it normalises both proof.XB and the point). One normalisation for both sides.
const sameFormAsPoint = (proof) => (proof && typeof proof === "object" && proof.XB ? { ...proof, XB: norm(proof.XB) } : proof);
// A POINT AT THE BOUNDARY IS IN CANONICAL FORM (0x + lowercase). The engine's points arrive WITHOUT the 0x prefix
// (that is how www/js/atomic/halves.js stores them), while the proof check compares points AS STRINGS. The
// normalisation must be SYMMETRIC: the proven point of the proof is already normalised by sameFormAsPoint, so the
// counterparty's declared point is normalised the same way - otherwise the same number written once with 0x and
// once without would give a false quote-refused { step: "proof" } on a matching proof. The page does the same
// (sdk/src/swap-flow.mjs, with0x). Not a string - then there is no point: we leave it as is, this is a refusal
// "no point", not "point in another form".
const pointForm = (v) => (typeof v === "string" && v ? norm(v) : v);

/**
 * Our side of the order. It is built by the engine's builder: two halves, their points, the DLEQ PROOF (it is
 * bound to the order terms and so is not computed without the context) and the side's encryption key.
 * The long proof computation lives here - one side, one computation.
 */
export function buildOwnSide(order, onBit) {
  const context = contextOf(order);
  const side = builder().newSide(context, false, onBit);
  return { context, side, spendPoint: norm(side.pub.ed), viewPoint: norm(side.viewPub), encPub: norm(side.enc.pub) };
}

/**
 * The counterparty's side: accept and verify. The check is ONE for both sides and is done by the engine
 * (order.js, verifySide): the proof stands in the CONTEXT OF THIS order, the proven point matches the one that
 * will go into the contract, and if a sealed package arrived it is opened with OUR encryption key and checked
 * against its point. The sandbox stand-in is built here too and marked: it must not be passed off as a real
 * provider.
 */
export function acceptCounterparty({ context, side = null, counterparty = null, standIn = false }) {
  let accepted = null;
  if (counterparty && typeof counterparty === "object") {
    const pub = counterparty.pub && typeof counterparty.pub === "object" ? counterparty.pub : {};
    // THE ORDER-QUOTE FIELD NAMES ARE THE ONES THE CORE ITSELF RETURNS (a defect found). The counterparty's side
    // comes from `quotes.firm`, and there the point is called `edPointClaimer`, the view half - `viewHalfClaimer`
    // (rfq/orderQuote.mjs). While only `edPub`/`viewPub` were accepted, the facade's own side was NOT accepted:
    // start answered bad-input { field: "counterparty", missing: ["edPub"] } to its own answer. The engine knew
    // this mapping (sdk/src/swap-flow.mjs: edPub: quote.edPointClaimer). We accept BOTH names.
    accepted = {
      proof: sameFormAsPoint(counterparty.proof),
      edPub: pointForm(counterparty.edPub || counterparty.edPoint || counterparty.edPointClaimer || pub.ed || null),
      viewPoint: pointForm(counterparty.viewPoint || counterparty.viewPub || null),
      viewHalf: counterparty.viewHalf || counterparty.viewHalfClaimer || null,
      // THE COUNTERPARTY'S SPEND HALF: HIS commitment (commitHalfClaimer) is computed from it where it did not
      // arrive ready-made. Without the half the commitment cannot be obtained - and that is named null, not invented.
      half: counterparty.half !== undefined ? counterparty.half : null,
      commitHalfClaimer: counterparty.commitHalfClaimer || null,
      sealed: counterparty.sealed || null,
      providerId: counterparty.providerId || null,
      standIn: false,
    };
  } else if (standIn === true) {
    // THE STAND-IN IS COMPUTED IN THE SAME CONTEXT AS THE ORDER: the string gets nothing appended. The same path
    // as the page (sdk/src/swap-flow.mjs: worker.buildSide) and the flow check - otherwise what would be checked is
    // not what the page runs on.
    const mock = builder().newSide(context, true);
    accepted = { proof: sameFormAsPoint(mock.proof), edPub: norm(mock.pub.ed), viewPoint: norm(mock.viewPub),
      viewHalf: mock.viewHalf, half: mock.half, commitHalfClaimer: null, sealed: null, providerId: null, standIn: true, mock };
  } else {
    throw new SdkError("bad-input", { field: "counterparty" });
  }
  const missing = [];
  if (!accepted.proof) missing.push("proof");
  if (!accepted.edPub) missing.push("edPub");
  if (missing.length) throw new SdkError("bad-input", { field: "counterparty", missing });
  // OPENING THE SEALED PACKAGE - BY THE SAME ENGINE CALL, and the key is OURS (the package is addressed to us).
  // The envelope's composition is locked separately (www/js/atomic/halfenc.js, HALFENC_LOCK_REASON): in the live
  // flow the half arrives from the chain via the commit/reveal mechanism, so a locked package honestly answers
  // with a refusal rather than passing itself off as a working key handover.
  const ownEncPriv = accepted.sealed && side && side.enc ? side.enc.priv : null;
  let verdict = null;
  try { verdict = builder().verifySide({ proof: accepted.proof, pub: { ed: accepted.edPub } }, context, accepted.sealed, ownEncPriv); }
  catch { throw new SdkError("bad-input", { field: "counterparty" }); }
  if (!verdict || verdict.ok !== true) {
    throw new SdkError("quote-refused", { step: "proof", why: verdict && verdict.reason ? "rejected" : "unknown" });
  }
  return accepted;
}

/**
 * THE ORDER STEP AS A WHOLE: your own side (or one already built by the record), the counterparty's side and the
 * joint address. It hands out the fields the record and the recovery file are assembled from; NOT A SINGLE empty
 * value: an address is not assembled without the other's point, and that is a refusal, not an empty string.
 */
export function orderStep({ order, side = null, counterparty = null, standIn = false, network = null }) {
  const context = contextOf(order);
  const own = side
    ? { context, side, spendPoint: norm(side.pub && side.pub.ed), viewPoint: norm(side.viewPub),
        encPub: norm(side.enc && side.enc.pub ? side.enc.pub : null) }
    : buildOwnSide(order);
  const lack = [];
  if (own.side.half === undefined || own.side.half === null) lack.push("half");
  if (own.side.viewHalf === undefined || own.side.viewHalf === null) lack.push("viewHalf");
  if (!isPoint(own.spendPoint)) lack.push("spendPoint");
  if (!isPoint(own.viewPoint)) lack.push("viewPoint");
  if (lack.length) throw new SdkError("bad-input", { field: "side", missing: lack });

  const other = acceptCounterparty({ context: own.context, side: own.side, counterparty, standIn });
  const otherViewPoint = other.viewPoint || (other.viewHalf ? norm(builder().pointOf(other.viewHalf)) : null);
  if (!otherViewPoint) throw new SdkError("bad-input", { field: "counterparty", missing: ["viewPoint"] });

  let joint = null;
  try {
    joint = builder().jointAddress({
      ownSpendHalf: own.side.half, ownViewHalf: own.side.viewHalf,
      otherSpendPoint: other.edPub, otherViewPoint, network,
    });
  } catch { throw new SdkError("bad-input", { field: "network" }); }

  return {
    context: own.context,
    own: { spendPoint: own.spendPoint, viewPoint: own.viewPoint, encPub: own.encPub, proof: own.side.proof },
    side: own.side,
    counterparty: other,
    // READY-MADE RECORD AND FILE FIELDS: the names the engine reads (core/swap.js, halvesWalletOf) and the ones
    // recovery file version 3 requires. A file without the other's view half will not be assembled - and that is
    // named by the otherViewHalf field with the value null, not by an invented half.
    wallet: {
      spendHalf: halfHex(own.side.half), viewHalf: halfHex(own.side.viewHalf),
      otherSpendPoint: other.edPub, otherViewPoint: norm(otherViewPoint),
      otherViewHalf: other.viewHalf ? halfHex(other.viewHalf) : null,
      address: joint.address, spendPub: norm(joint.spendPub), viewPub: norm(joint.viewPub),
      otherCommitHalf: other.commitHalfClaimer || null,
      // THE COMMITMENTS FOR THE HALVES - FROM THESE SAME SIDES, by the same call as the contract
      // (keccak256(abi.encodePacked(bytes32 half))). One built side -> one commitment: there is no second half
      // computation here. The other's half may not arrive (the order brings it) - then the counterparty's
      // commitment is taken ready-made or stays null, not invented.
      commitHalfLocker: norm(builder().halfCommitment(own.side.half)),
      commitHalfClaimer: other.half !== undefined && other.half !== null
        ? norm(builder().halfCommitment(other.half))
        : (other.commitHalfClaimer || null),
      network: network || null,
    },
  };
}
