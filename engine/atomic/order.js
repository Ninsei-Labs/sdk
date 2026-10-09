// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/order.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// ASSEMBLING ONE ORDER SIDE of an atomic swap: a key half, points, a proof, the encrypted envelope and the
// contract commitment.
//
// WHAT THIS CLOSES. The modules used to exist separately; here they assemble into one order side and, above all,
// two mandatory conditions are enforced IN CODE: before locking, the counterparty envelope must hold a real half
// (checked against the point), and its DLEQ must verify (both public points stand for one scalar).
//
// AN HONEST DEMO LIMIT. There is no real maker yet (quotes are fake), so the counterparty side is built LOCALLY
// and marked standIn: true. This runs the full cycle, but the guarantee only becomes real with a counterparty
// that has its own key.

import { createHalves } from "./halves.js";import { halfCommitmentHex } from "./orderHalfCommit.js";
import { createDleq2 } from "./dleq2.js";
import { createHalfEnc, packSealed } from "./halfenc.js";
import { addressFromKeys } from "../monero/address.js";
import { swapAddressFromHalves } from "../monero/swapKeys.js";

export function createOrderBuilder({ ed25519, secp256k1, keccak256, sha3_512, randomBytes }) {
  const halves = createHalves({ ed25519, secp256k1, keccak256, randomBytes });
  const dleq = createDleq2({ ed25519, secp256k1, keccak256, sha3_512, randomBytes });
  const enc = createHalfEnc({ secp256k1, ed25519, keccak256, randomBytes });

  // An order side: TWO halves (spend and view), their points, the proof and the encryption key.
  //
  // WHY A SEPARATE VIEW HALF. The Monero view key is independent of the spend key and cannot be derived from the
  // spend half; without the sum of VIEW halves the wallet cannot find incoming funds. Sharing the view half is safe
  // - it sees but cannot spend; spending needs the sum of SPEND halves.
  //
  // NO PROOF IS NEEDED FOR IT, deliberately: the view half comes with the quote and defines its own view point, so
  // it cannot be substituted. The DLEQ proof stays on the SPEND half, the one paid for with ETH.
  function newSide(orderContext, standIn = false, onBit) {
    const half = halves.newHalf();
    const pub = halves.publicHalves(half);                     // ed25519 and secp256k1
    const viewHalf = halves.newHalf();
    const viewPub = halves.publicHalves(viewHalf).ed;          // view point: the address is built from it
    const encPair = enc.recipientKeyPair();                    // separate from the spend key
    const proof = dleq.prove(half, orderContext, onBit);        // bound to the order context
    return { half, pub, viewHalf, viewPub, enc: encPair, proof, standIn };
  }

  // Checking the counterparty side IS conditions (1) and (2): its proof, and - if an envelope is given - opening
  // ITS envelope with OUR private key and verifying against ITS public point.
  //
  // KEY ROLES ARE FUNDAMENTAL HERE, and the first version mixed them up: it opened the envelope with the
  // counterparty's own key (which we do not have - the envelope is addressed to them). That check could never pass.
  function verifySide(side, orderContext, sealedPayloadBytes, ownEncPriv) {
    const proofOk = dleq.verify(side.proof, orderContext);
    if (!proofOk.ok) return { ok: false, reason: "counterparty DLEQ failed: " + proofOk.reason };
    // THE PROVEN POINT MUST BE THE ONE THAT GOES INTO THE ORDER, and this check was missing. A proof confirms that
    // ONE scalar stands behind a pair of points, but not that the proven ed25519 point is the one the joint address
    // and the contract use. The counterparty could prove one point and put another in the order; the mismatch would
    // surface only at XMR claim time.
    //
    // One comparison for both sides: our pub.ed is derived from the half, the counterparty's comes from the quote;
    // in both cases this is THE point the contract will see.
    if (side.pub && side.pub.ed && String(side.proof.XB).toLowerCase() !== String(side.pub.ed).toLowerCase()) {
      return { ok: false, reason: "the proven ed25519 point does not match the declared one: " + side.proof.XB + " vs " + side.pub.ed };
    }
    if (sealedPayloadBytes && ownEncPriv) {
      const opened = enc.open(enc.unpackSealed(sealedPayloadBytes), ownEncPriv, side.pub.ed);
      if (!opened.ok) return { ok: false, reason: "the counterparty envelope does not confirm the half: " + opened.reason };
    }
    return { ok: true };
  }

  // The envelope with our half, encrypted to the counterparty key: what goes to them and to the contract.
  function sealFor(counterparty, ownHalf, orderContext) {
    const sealed = enc.seal(ownHalf, counterparty.enc.pub, orderContext);
    const bytes = packSealed(sealed);
    return { sealed, bytes, commitment: enc.sealedCommitmentOf(bytes) };
  }

  // Open the counterparty envelope with our half and check it is really their half.
  function openFrom(sealedBytes, ownEncPriv, counterpartyEdPub) {
    return enc.open(enc.unpackSealed(sealedBytes), ownEncPriv, counterpartyEdPub);
  }

  // THE HALF COMMITMENT - what the contract checks in `claim` and `refund` and what goes into `termsHash`. Solidity
  // computes `keccak256` of the secp256k1 POINT of the half (`half*G`), not of the number. So the formula must match
  // in the app and the node; it lives in a separate module and is only called here, with the curve passed in.
  function halfCommitment(half) {
    return halfCommitmentHex(half, secp256k1, keccak256);
  }

  // The joint Monero address: the sum of the public halves. Checked by the property (a+b)G == aG + bG.
  function jointAddressPoint(sideA, sideB) {
    return halves.combinePublic(sideA.pub.ed, sideB.pub.ed);
  }

  // POINT FROM A HALF. Needed where the counterparty sent a HALF (as in the quote) and the address needs a point.
  function pointOf(half) {
    return halves.publicHalves(typeof half === "bigint" ? half : BigInt(half)).ed;
  }

  // THE JOINT MONERO ADDRESS - the whole point of the scheme. Neither side knows the other's SPEND half: the
  // address is built from OUR half and THEIR point, because (a+b)G == aG + bG. Before the second half is revealed,
  // the address exists but nobody can spend from it.
  //
  // SAME ENCODER AS THE WALLET (monero/address.js): a second encoder would diverge where the error is visible only by sending XMR.
  //
  // THE VIEW KEY IS ASSEMBLED SEPARATELY FROM ITS OWN HALVES: in Monero, view and spend keys are independent.
  function jointAddress({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network }) {
    return swapAddressFromHalves({
      halves, addressFromKeys, deps: { keccak256 },
      ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network,
    });
  }

  return { halves, dleq, enc, newSide, verifySide, sealFor, openFrom, jointAddressPoint, pointOf, jointAddress, halfCommitment };
}
