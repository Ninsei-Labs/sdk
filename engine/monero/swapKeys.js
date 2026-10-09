// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/swapKeys.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// JOINT ADDRESS KEYS FROM HALVES.
//
// THERE IS NO FULL SPEND KEY HERE. Neither side generates the swap wallet whole: each gives ITS half and the
// address is their SUM. So "take the XMR and hand the ETH back" does not work - the counterparty lacks the other
// half and cannot spend the output alone. The old combineAddress assembled the address from the maker's seed,
// i.e. a full key on one side - a custodial scheme we moved away from.
//
// ARITHMETIC. Monero is edwards25519. The address spend key is the SUM of halves and the public point is the SUM
// of points, because (a+b)G == aG + bG. That equality is what the split rests on: both sides know the address,
// only the holder of both halves can spend.
//
// TWO OPERATIONS, NOT TO BE MERGED:
//   1) THE ADDRESS is built from PUBLIC data: own half + the other side's POINT. No secret of the counterparty is
//      needed, so it is built when the order is created.
//   2) THE SPEND KEY (s_a + s_b) appears only AFTER the second half is revealed by settlement.

// (1) Address from public data: nothing secret about the counterparty is needed.
export function swapAddressFromHalves({ halves, addressFromKeys, deps, ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network }) {
  if (!halves || !addressFromKeys) throw new Error("halves and addressFromKeys are required");
  for (const [name, v] of Object.entries({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint })) {
    if (v === undefined || v === null || v === "") throw new Error("not set: " + name);
  }
  const ownSpendPub = halves.publicHalves(ownSpendHalf).ed;
  const ownViewPub = halves.publicHalves(ownViewHalf).ed;
  const spendPub = halves.combinePublic(ownSpendPub, otherSpendPoint);
  const viewPub = halves.combinePublic(ownViewPub, otherViewPoint);
  // The address string uses the same encoder as before: the network comes from the config, so mainnet and
  // stagenet both work. Only the key source changed - halves, not a seed.
  // deps = { keccak256, Buffer }: the encoder computes the checksum itself and must not rely on globals.
  const address = addressFromKeys({ network, kind: "primary", spendPub, viewPub }, deps);
  return { address, spendPub, viewPub, ownSpendPub, ownViewPub };
}

// (2) Spend key after the second half is revealed, WITH A MANDATORY CHECK.
//
// THE CHECK IS THE POINT. The revealed half may be the wrong one: the contract accepts any half whose hash
// matches the commitment, so this comparison is the only place the link "revealed half <-> address point" is
// confirmed. We compare (s_a + s_b)*G with the spend public key from the order: no match - we do NOT sweep and
// say so aloud.
export function sweepSpendSecret({ halves, ownSpendHalf, revealedOtherHalf, expectedSpendPub }) {
  if (!halves) throw new Error("halves are required");
  for (const [name, v] of Object.entries({ ownSpendHalf, revealedOtherHalf, expectedSpendPub })) {
    if (v === undefined || v === null || v === "") throw new Error("not set: " + name);
  }
  const sum = halves.combineHalves(ownSpendHalf, BigInt(revealedOtherHalf));
  const sumPub = halves.publicHalves(sum).ed;
  const norm = (h) => "0x" + String(h).replace(/^0x/i, "").toLowerCase();
  if (norm(sumPub) !== norm(expectedSpendPub)) {
    throw new Error(
      "the revealed half does not match the address: (s_a + s_b)*G != the order's spend public key. " +
      "Do not sweep - the half is foreign or from another order"
    );
  }
  return { spendSecret: sum, spendPub: sumPub };
}

// The view key for watching the arrival: also a sum, but from its own pair of halves. A separate function
// because watching and spending are different secrets and must not be confused.
export function watchViewSeedHex({ halves, ownViewHalf, otherViewHalf }) {
  const sum = halves.combineHalves(ownViewHalf, BigInt(otherViewHalf));
  return "0x" + sum.toString(16).padStart(64, "0");
}
