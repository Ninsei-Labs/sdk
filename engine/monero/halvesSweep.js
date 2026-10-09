// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/halvesSweep.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// KEYS FOR SWEEPING FROM A HALVES FILE. One logic for two consumers: the sweep page (sweep.js) and the
// check, so the two cannot drift.
// This is the main check of the whole sweep: the contract only verifies that the HASH of the revealed half
// matched the commitment, but ed25519 does not exist in the EVM, so WE must verify that (s_a + s_b)*G equals
// the order's public spend key - before any synchronisation. No match: do not sweep and say so.
// No secrets are created here: both halves already exist for the side (its own in the file, the other on chain).
export function spendKeysFromRevealedHalf({
  halves, ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewHalf, revealedHalf,
}) {
  if (!halves) throw new Error("half maths is required");
  for (const [name, v] of Object.entries({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewHalf, revealedHalf })) {
    if (v === undefined || v === null || v === "") throw new Error("not set: " + name);
  }
  const sum = halves.combineHalves(BigInt(ownSpendHalf), BigInt(revealedHalf));
  const sumPub = halves.publicHalves(sum).ed;
  // The expected spend key is built FROM OWN HALF AND THE COUNTERPARTY POINT (what was in the order).
  // The half from the file arrives as a string, so it must be converted - forgetting this crashed the XMR
  // sweep with "expected bigint, got string".
  const expected = halves.combinePublic(halves.publicHalves(BigInt(ownSpendHalf)).ed, otherSpendPoint);
  const norm = (h) => String(h).replace(/^0x/i, "").toLowerCase();
  if (norm(sumPub) !== norm(expected)) {
    throw new Error(
      "revealed half does not match the address: (s_a + s_b)*G != the order spend key. " +
        "The half is from another order or substituted - sweeping is not allowed"
    );
  }
  // The full VIEW key is also a sum (own half from the file + the counterparty half); it cannot spend, but
  // without it the wallet cannot find our XMR on chain.
  const viewSum = halves.combineHalves(BigInt(ownViewHalf), BigInt(otherViewHalf));
  // BYTE ORDER IS A FORMAT, NOT COSMETICS, and here it was wrong until 28.09.2026: the old code wrote the
  // scalar most-significant-byte first, while the library expects Monero order (least-significant first).
  // Both monero-ts 0.11.16 builds rejected the reversed key; the workarounds kept elsewhere must not fire.
  //
  // NO 0x PREFIX here: the library returns and accepts 64 hex without it, and rejects "0x"+64 hex at parse.
  const be32 = (v) => BigInt(v).toString(16).padStart(64, "0");  // ordinary number notation, most significant byte first
  const le32 = (v) => be32(v).match(/../g).reverse().join("");   // Monero notation: least significant byte first
  return { privateSpendKey: le32(sum), privateViewKey: le32(viewSum) };
}

// THE REVERSE IS ALSO ONE FUNCTION FOR ALL: reading a returned key directly as a number
// (BigInt("0x" + key)) silently reverses Monero order and gives another scalar.
export function scalarFromMoneroHex(h) {
  const hex = String(h).replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("key is not in Monero notation: expected 64 hex");
  return BigInt("0x" + hex.match(/../g).reverse().join(""));
}
