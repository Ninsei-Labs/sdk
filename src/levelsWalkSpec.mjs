// THE MAKER'S LEVEL SET: THE REFERENCE WALK OVER IT (issue #110, part B).
//
// WHY. The maker sends the node a LEVEL SET - chunks of volume with their own prices - and the node computes a
// firm price by WALKING it. The client (SDK) needs the same walk to show the same price before signing. This is
// the SINGLE implementation of the walk and of the level-set rules; the file exists as BYTE-IDENTICAL copies in
// two places, and tools/check-levels-walk.mjs verifies that:
//     node: rfq/lib/levelsWalkSpec.mjs        SDK: sdk/src/levelsWalkSpec.mjs
// Two copies, not an import: the node runs on the provider's machine and sees neither www/ nor sdk/, and the SDK
// package does not see rfq/ - each starts on its own (the same argument as rfq/lib/quoteEip712Spec.mjs). A
// divergence would mean the node and the client name a DIFFERENT price for the same set.
//
// NUMBERS ARE INTEGERS ONLY, BigInt ONLY (rule 10). XMR is in atomic units (1 XMR = 1e12). A price is in the
// asset's atomic units PER 1 WHOLE XMR (for a wei asset that is wei per 1 XMR). No Number for money.
//
// THE RULES OF THE SET (part B of the ticket):
//   1. a level is the NEXT chunk of volume, not a running total;
//   2. the best price comes FIRST, then only worse (for ask the best is the lowest, for bid the highest; checked
//      by the same rule on the reversed set, the orientation argument); a violation is a NAMED refusal, not silence;
//   3. the first level sets the minimum deal size (there is no separate min);
//   4. an EMPTY set = the side is off, and that is NOT an error;
//   5. the walk goes BOTH ways: "I give asset - how much XMR" and "I give XMR - how much asset";
//   6. rounding to atomic units is in the maker's favour;
//   7. one orientation: volume in XMR, price in the asset per 1 XMR;
//   8. a fixed swap fee (fee in wei, separate for each side): the buyer pays the walk PLUS the fee, the seller
//      receives the walk MINUS the fee. It is NOT spread over the volume: otherwise the average price would fall
//      as the deal grew and the levels would break rule 2;
//   9. an order deeper than the side is a NAMED refusal; there is no partial fill.
//
// ROLES. role="buy"  - the taker BUYS XMR and PAYS the asset (the fee is ADDED to the asset).
//       role="sell" - the taker SELLS XMR and RECEIVES the asset (the fee is SUBTRACTED from the asset).
//
// REFUSALS COME BACK AS A reason TOKEN, NOT AS AN EXCEPTION: the caller must have a named refusal it can show
// in words, not a crash without a cause.

export const XMR_ATOMIC_PER_ONE = 1000000000000n;

// Parse an integer value into BigInt. Fractional / NaN / garbage -> null (the caller names the refusal, it does not guess).
export function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isInteger(value) && Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^[0-9]+$/.test(s)) return BigInt(s);
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
  }
  return null;
}

// CHECK THE SET. Returns a NAMED verdict (it does not throw):
//   { ok: true, enabled: false }                              - empty set: the side is off (rule 4);
//   { ok: true, enabled: true, count, minAtomic, totalAtomic } - the set is valid;
//   { ok: false, reason, index }                              - the set breaks a rule.
export function checkLevels(levels, orientation = "ask") {
  if (!Array.isArray(levels)) return { ok: false, reason: "levels-not-array" };
  if (levels.length === 0) {
    return { ok: true, enabled: false, count: 0, minAtomic: 0n, totalAtomic: 0n };
  }
  if (orientation !== "ask" && orientation !== "bid") return { ok: false, reason: "levels-bad-orientation" };
  // ORIENTATION. Rule 2 ("the best price first, then only worse") reads DIFFERENTLY per side: for ask the best is
  // the LOWEST, for bid the HIGHEST. So for bid the REVERSED set is checked - by the same device already used in
  // the listener (levelOrderRefusal), not by a second rule beside it. The walk itself still runs over the ORIGINAL
  // order: only the RULE is reversed, not the list (the best price must stay first for the walk).
  const order = orientation === "bid" ? levels.slice().reverse() : levels;
  let totalAtomic = 0n;
  let prevPrice = null;
  for (let index = 0; index < order.length; index += 1) {
    const level = order[index];
    if (!level || typeof level !== "object") return { ok: false, reason: "levels-bad-level", index };
    const amount = toBigInt(level.amount);
    const price = toBigInt(level.price);
    if (amount === null || price === null) return { ok: false, reason: "levels-not-integer", index };
    if (amount <= 0n || price <= 0n) return { ok: false, reason: "levels-not-positive", index };
    // Equal prices are allowed (two chunks at one price are one level cut in two); a worse price is a NAMED
    // refusal, and the index is translated back to the ORIGINAL numbering so the maker finds the guilty level.
    if (prevPrice !== null && price < prevPrice) {
      return { ok: false, reason: "levels-not-best-first", index: orientation === "bid" ? levels.length - 1 - index : index };
    }
    prevPrice = price;
    totalAtomic += amount;
  }
  return { ok: true, enabled: true, count: levels.length, minAtomic: toBigInt(levels[0].amount), totalAtomic };
}

// THE COST OF A CHUNK OF VOLUME IN WEI, ROUNDED UP (rule 6, in the maker's favour).
function levelCostWei(amountAtomic, priceWeiPerXmr) {
  const num = amountAtomic * priceWeiPerXmr;
  return (num + XMR_ATOMIC_PER_ONE - 1n) / XMR_ATOMIC_PER_ONE;
}

// HOW MANY XMR ATOMS A BUDGET GIVES WITHIN ONE LEVEL, ROUNDED DOWN (rule 6).
function levelXmrForBudget(budgetWei, priceWeiPerXmr) {
  return (budgetWei * XMR_ATOMIC_PER_ONE) / priceWeiPerXmr;
}

// THE FULL COST OF A SIDE (the sum of its levels' costs) and its volume - computed once.
function sideSummary(levels) {
  let totalAtomic = 0n;
  let fullCostWei = 0n;
  for (const level of levels) {
    const amount = toBigInt(level.amount);
    const price = toBigInt(level.price);
    totalAtomic += amount;
    fullCostWei += levelCostWei(amount, price);
  }
  return { totalAtomic, fullCostWei };
}

// THE WALK WITHOUT THE FEE: a budget is given - how much XMR it yields (rounding down within a level, rule 6).
function walkXmrForBudget(levels, budgetWei) {
  let remaining = budgetWei;
  let xmrAtomic = 0n;
  for (const level of levels) {
    const amount = toBigInt(level.amount);
    const price = toBigInt(level.price);
    const full = levelCostWei(amount, price);
    if (remaining >= full) {
      xmrAtomic += amount;
      remaining -= full;
      continue;
    }
    xmrAtomic += levelXmrForBudget(remaining, price);
    break;
  }
  return xmrAtomic;
}

// THE WALK WITHOUT THE FEE: an XMR volume is given - what it costs (each chunk's cost rounded up, rule 6).
function walkCostForXmr(levels, xmrAtomic) {
  let left = xmrAtomic;
  let costWei = 0n;
  for (const level of levels) {
    if (left <= 0n) break;
    const amount = toBigInt(level.amount);
    const price = toBigInt(level.price);
    const take = left < amount ? left : amount;
    costWei += levelCostWei(take, price);
    left -= take;
  }
  return costWei;
}

// THE SMALLEST TRADE (rule 3). It is the size of the FIRST level the maker SENT, and the node's own
// deductions (outstanding quotes, a balance cut) never change it: they take depth off the TOP, and a trade
// that was allowed when the set arrived must stay allowed after the top was eaten. If the minimum were read
// off the EFFECTIVE set, eating the first level whole would RAISE it to the next, larger level, and eating it
// in part would LOWER it below what the maker sent - both wrong. Callers pass the sent minimum as minAtomic;
// absent, the set's own first level is the minimum (the historical behaviour and what the vectors pin).
function minOf(levels, minAtomic) {
  if (minAtomic === null || minAtomic === undefined) return toBigInt(levels[0].amount);
  return toBigInt(minAtomic);
}

// DIRECTION 1: "I give/take ASSET - how much XMR".
//   buy:  assetWei - the asset the taker PAYS; the walk budget = assetWei - fee;
//   sell: assetWei - the asset the taker RECEIVES; the walk budget = assetWei + fee (the set must yield that
//         much so that AFTER the fee is taken out exactly assetWei is left in hand).
export function xmrForAsset({ levels, role, feeWei = 0n, assetWei, orientation = "ask", minAtomic = null }) {
  const verdict = checkLevels(levels, orientation);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, role, index: verdict.index };
  if (!verdict.enabled) return { ok: false, reason: "side-off", role };
  if (role !== "buy" && role !== "sell") return { ok: false, reason: "levels-bad-role", role };
  const asset = toBigInt(assetWei);
  const fee = toBigInt(feeWei === undefined || feeWei === null ? 0n : feeWei);
  if (asset === null || fee === null || fee < 0n) return { ok: false, reason: "levels-not-integer", role };
  const budget = role === "buy" ? asset - fee : asset + fee;
  if (budget <= 0n) return { ok: false, reason: "levels-fee-beyond-budget", role };
  const { fullCostWei } = sideSummary(levels);
  if (budget > fullCostWei) return { ok: false, reason: "levels-exceed-side", role };
  // THE SMALLEST TRADE, from the set AS THE MAKER SENT IT (rule 3): callers pass it in minAtomic and the
  // node's deductions never change it. Absent, the set's own first level is used, as it always was.
  const min = minOf(levels, minAtomic);
  // Its cost ON THE EFFECTIVE SET: after deductions the smallest trade may reach into a later level, so the
  // cost is walked, not read off one price.
  const minCost = walkCostForXmr(levels, min);
  if (budget < minCost) return { ok: false, reason: "levels-below-minimum", role };
  const xmrAtomic = walkXmrForBudget(levels, budget);
  return { ok: true, role, xmrAtomic, assetWei: asset };
}

// DIRECTION 2: "I give/want XMR - how much ASSET".
//   buy:  xmrAtomic - how much XMR the taker WANTS; the asset to pay = the walk + fee;
//   sell: xmrAtomic - how much XMR the taker GIVES;  the asset to receive = the walk - fee.
export function assetForXmr({ levels, role, feeWei = 0n, xmrAtomic, orientation = "ask", minAtomic = null }) {
  const verdict = checkLevels(levels, orientation);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, role, index: verdict.index };
  if (!verdict.enabled) return { ok: false, reason: "side-off", role };
  if (role !== "buy" && role !== "sell") return { ok: false, reason: "levels-bad-role", role };
  const want = toBigInt(xmrAtomic);
  const fee = toBigInt(feeWei === undefined || feeWei === null ? 0n : feeWei);
  if (want === null || fee === null || fee < 0n) return { ok: false, reason: "levels-not-integer", role };
  if (want > verdict.totalAtomic) return { ok: false, reason: "levels-exceed-side", role };
  // THE SMALLEST TRADE AS THE MAKER SENT IT, never the effective set's first level (rule 3): see minOf.
  if (want < minOf(levels, minAtomic)) return { ok: false, reason: "levels-below-minimum", role };
  const walkWei = walkCostForXmr(levels, want);
  const assetWei = role === "buy" ? walkWei + fee : walkWei - fee;
  if (assetWei <= 0n) return { ok: false, reason: "levels-fee-beyond-budget", role };
  return { ok: true, role, xmrAtomic: want, assetWei };
}
