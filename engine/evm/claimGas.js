// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/claimGas.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// CLAIM GAS FOR THE XMR SELL (claim): ONE SOURCE OF TRUTH FOR THE CLIENT AND THE NODE.
// In a reverse swap the person gives XMR and claims ETH via `claim` on the settlement chain. They have no ETH,
// so the node sends the claim gas. The gas rules used to live in TWO places and the numbers differed ~100x, so
// a person with one gift could not send the claim. Now this module computes both numbers.
// WHY ONE MODULE UNDER www/js: the formula must be ONE. The EVM engine lives under www/js, and the node imports
// from www/js too; the reverse import is impossible (the browser is never served the node directory).
// WHAT IS ONE HERE: the claim gas limit, the fee rule (2 x baseFee + tip) and the GIFT SIZE - the same claim
// cost plus an EXPLICIT margin for base-fee growth between ticket and claim.

// THE CLAIM GAS LIMIT IS ONE NUMBER ON BOTH SIDES. MEASURED: an honest claim costs 120 721 gas on a live chain,
// more than the old 120 000, which cut off legitimate claims. The limit has a margin: 200 000.
export const CLAIM_GAS_LIMIT = 200_000n;

// THE TIP FLOOR IS NETWORK POLICY, NOT A CONSTANT IN THE SENDING CODE. A fixed 1 gwei minimum inflated
// maxFeePerGas ~50x on cheap-gas networks and broke exactly those the gas is for. Arbitrum needs no tip
// (floor 0); a network with its own policy passes minTipWei, taken from the network registry.
export const CLAIM_TIP_FLOOR_WEI = 0n;

const toBig = (v) => {
  if (v === null || v === undefined || v === "") return null;
  try { return BigInt(typeof v === "bigint" ? v : String(v)); } catch { return null; }
};

// CLAIM FEE (EIP-1559): `maxFeePerGas = 2 x baseFee + tip`. Doubling the base fee covers its growth during the
// transaction; the tip is gasPrice - baseFee, not below the network floor. baseFee = 0 (no EIP-1559): no fee
// fields at all, and that is null, not zero.
export function claimMaxFeePerGasWei({ baseFeeWei, priorityFeeWei = 0n, minTipWei = CLAIM_TIP_FLOOR_WEI } = {}) {
  const base = toBig(baseFeeWei);
  if (base === null || base <= 0n) return null;
  const prio = toBig(priorityFeeWei);
  const floor = toBig(minTipWei);
  const floored = floor === null || floor < 0n ? 0n : floor;
  const tip = prio !== null && prio > floored ? prio : floored;
  return base * 2n + tip;
}

// HOW MUCH THE BALANCE NEEDS FOR CLAIM - the node acceptance rule: `gasLimit x maxFeePerGas`. If a factor is
// unmeasured - null (not "zero gas").
export function claimRequiredWei({ gasLimit = CLAIM_GAS_LIMIT, maxFeePerGasWei } = {}) {
  const limit = toBig(gasLimit);
  const maxFee = toBig(maxFeePerGasWei);
  if (limit === null || limit <= 0n || maxFee === null || maxFee <= 0n) return null;
  return limit * maxFee;
}

// MARGIN FOR BASE-FEE GROWTH BETWEEN TICKET AND CLAIM, in basis points (10 000 = +100%).
//
// WHY IT IS NEEDED AND WHY THIS MUCH. The claim cost is computed at TICKET time, but the claim happens later:
// the ticket lives RFQ_ORDER_QUOTE_TTL_MS, 40 minutes by default. The client rule (2 x baseFee) covers growth
// only during its own transaction, not those 40 minutes. +100% covers a doubling of the base fee over the
// ticket window, so the gift stays sufficient. The value is a node setting (RFQ_REVERSE_GAS_RESERVE_BPS), not
// a guess: it is visible and can be overridden.
export const DEFAULT_GIFT_RESERVE_BPS = 10_000n;

// GIFT SIZE - the same claim cost the client requires, PLUS the margin. This is the ONLY computation of the
// gift size: the node and the live run call IT, not their own copy. base comes from the chain at ticket time;
// priorityFeeWei is the real network tip. An unreadable base is null, not zero.
export function claimGasGiftWei({ baseFeeWei, priorityFeeWei, minTipWei, gasLimit = CLAIM_GAS_LIMIT, reserveBps = DEFAULT_GIFT_RESERVE_BPS } = {}) {
  const maxFee = claimMaxFeePerGasWei({ baseFeeWei, priorityFeeWei, minTipWei });
  const need = claimRequiredWei({ gasLimit, maxFeePerGasWei: maxFee });
  if (need === null) return null;
  const bps = toBig(reserveBps);
  const step = bps === null || bps < 0n ? 0n : bps;
  return need + (need * step) / 10_000n;
}
