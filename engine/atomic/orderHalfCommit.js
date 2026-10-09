// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/orderHalfCommit.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// COMMITMENT TO A HALF - one formula for all sides.
//
// WHAT THE CHAIN COMPUTES. `keccak256(x || y)` of the secp256k1 POINT of the half `half*G` - that is, the ADDRESS of that point.
// On reveal the contract checks not "the hash of the number matched" but that the presented half MULTIPLIES up to that
// same point (the `ecrecover` trick, `NinseiEscrow.halfMatchesCommit`). The POINT-commitment closes that hole: before,
// `keccak256(be32(half))` accepted any number with a matching hash, and the ETH depositor could commit the hash of
// garbage, return the ETH with that garbage and lock the other side's XMR. The link between the secp256k1 point and
// the ed25519 point (and the Monero address) is held by DLEQ - the risking side checks it BEFORE payment.
//
// This same commitment goes into termsHash and into the quote. So the formula must match in the app, in the
// provider's node and in anyone who will verify the swap. Two implementations of one formula diverge exactly
// when it is most expensive: the chain rejects a half that is "definitely correct".
//
// THE POINT IS TAKEN UNCOMPRESSED - 64 bytes `x || y`, big-byte-first, like Ethereum key coordinates.
// `secp256k1` and `keccak256` are passed in from outside: the module pulls no dependencies itself, like its neighbours.

export function halfCommitmentHex(half, secp256k1, keccak256) {
  if (!secp256k1 || !keccak256) throw new Error("secp256k1 and keccak256 are required");
  const value = BigInt(half);
  if (value <= 0n) throw new Error("the half must be a positive number");
  const raw = secp256k1.Point.BASE.multiply(value).toBytes(false);   // 65 bytes: 0x04 || x(32) || y(32)
  const xy = raw.slice(1);                                            // 64 bytes: x || y
  return "0x" + Array.from(keccak256(xy), (b) => b.toString(16).padStart(2, "0")).join("");
}
