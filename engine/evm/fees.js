// The NinseiSwap fee: PART OF THE SIGNED QUOTE (OrderQuote v7), not a contract setting.
//
// WHERE THE RATE LIVES. Before, it and the recipient were set by the FACTORY (or router) in immutable fields, and
// the client asked the chain for them (feeBps()/feeRecipient()/feeFor()). Now the contract has NO such functions:
// the router was removed, and the rate, amount and recipient of the fee are part of the SIGNED set
// of order terms. So the source of truth is ONE - the quote - and there must be no second place:
//   * the page settings hold NO rate; a copy would diverge from the signed set;
//   * there is nothing to ask the factory - it knows nothing about the fee;
//   * the amount in wei is computed by the formula `amount * feeBps / 10000` (rounding DOWN) and here it is verified
//     against that same formula by the MIRROR: a divergence must stop the signature, not turn into an escrow
//     refusal (WrongAmount/BadFee) after it.
//
// WHO PAYS. The fee is paid by the USER OF THE INTERFACE. The direction is visible from the quote roles: the
// provider takes ETH - a buy (fee ON TOP of the deposit), the provider deposits ETH - a sell (fee DEDUCTED from
// the payout, `amount - fee`). The provider is named in neither - nothing to tell, refusal.
//
// ONE UNIT OF TIME. Time in the project is SECONDS (order deadlines, quote validity, block.timestamp):
// converting between scales was the only place where an error by a thousand passes silently.

// The rate ceiling hard-wired in the contract (NinseiEscrow.MAX_FEE_BPS = 200 = 2%). Needed here to tell a
// meaningful rate from a corrupted one: reading garbage as a rate and computing a fee from it is not allowed.
export const MAX_FEE_BPS = 200;

// ONE STRICT RATE PARSER FOR EVERY MONEY FIGURE. A missing, empty, fractional or out-of-range rate is NOT zero:
// reading it as zero would understate a displayed fee or a Max reserve. An explicit 0 and its exact decimal string
// are valid. BigInt is accepted because callers may already carry the rate in that form.
const feeBpsOf = (feeBps) => {
  let bps;
  if (typeof feeBps === "bigint") bps = feeBps;
  else if (typeof feeBps === "number" && Number.isSafeInteger(feeBps)) bps = BigInt(feeBps);
  else if (typeof feeBps === "string" && /^\d+$/.test(feeBps)) bps = BigInt(feeBps);
  else throw new Error("fee rate must be an integer from 0 to 200");
  if (bps < 0n || bps > BigInt(MAX_FEE_BPS)) throw new Error("fee rate must be an integer from 0 to 200");
  return bps;
};

// ONE STRICT AMOUNT PARSER. A missing, empty, fractional or negative amount is NOT zero: reading it as zero
// would hide a missing signed figure behind a zero fee or a zero principal. Decimal strings and safe integers are
// accepted; BigInt is accepted because callers may already carry the amount that way.
const amountWeiOf = (value, what) => {
  let amount;
  if (typeof value === "bigint") amount = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) amount = BigInt(value);
  else if (typeof value === "string" && /^\d+$/.test(value)) amount = BigInt(value);
  else throw new Error(what + " must be a non-negative integer");
  if (amount < 0n) throw new Error(what + " must be a non-negative integer");
  return amount;
};

// THE MIRROR OF THE CONTRACT FORMULA. One place for the whole page: a second copy would diverge from the first
// exactly where it is most expensive - on the amount the escrow requires.
export function feeWeiFor(amountWei, feeBps) {
  const amount = amountWeiOf(amountWei, "fee amount");
  const bps = feeBpsOf(feeBps);
  return (amount * bps) / 10000n;   // DOWN, as in Solidity: amount * feeBps / 10000
}

// THE INVERSE OF A BUY'S TOTAL. A buy pays `p + floor(p*bps/10000)` and the person names the total; this returns the
// largest principal that still fits. The inequality is solved exactly, so a total that does not divide evenly keeps
// the rounding down of the fee formula instead of gaining a wei.
export function principalForTotal(totalWei, feeBps) {
  const total = amountWeiOf(totalWei, "principal total");
  const bps = feeBpsOf(feeBps);
  return ((total + 1n) * 10000n - 1n) / (10000n + bps);
}

const payoutBig = (value, { allowZero = true } = {}) => {
  if (value === null || value === undefined || value === "") return null;
  try {
    const n = BigInt(value);
    return n < 0n || (!allowZero && n === 0n) ? null : n;
  } catch { return null; }
};

/**
 * THE SALE'S TWO FIGURES BEFORE THE CLAIM. The escrow holds `amount`; `fee` and `claimTip` are separate fields. The
 * guaranteed minimum is `amount - fee - claimTip` (a third party sends the claim and takes the tip); the payout when
 * the seller sends it is `amount - fee`.
 */
export function salePayoutBeforeClaim({ amountWei, feeWei, claimTipWei = 0 } = {}) {
  const amount = payoutBig(amountWei, { allowZero: false });
  const fee = payoutBig(feeWei);
  const tip = payoutBig(claimTipWei);
  if (amount === null || fee === null || tip === null || fee > amount || fee + tip > amount) return null;
  return {
    amountWei: amount,
    feeWei: fee,
    claimTipWei: tip,
    guaranteedMinimumWei: amount - fee - tip,
    sellerClaimWei: amount - fee,
  };
}

/**
 * THE SELLER'S ACTUAL PAYOUT AFTER A CONFIRMED CLAIM. `sender` is the contract's `msg.sender`, not `tx.from`: a claim
 * routed through another contract has a different caller. A direct claim can supply the transaction's `{ to, from }`
 * together with `escrow`; `from` is trusted only when `to` is that escrow. A tip of zero pays `amount - fee` even when
 * the caller is unknown; a positive tip pays `amount - fee` only when the claimer sent it, otherwise
 * `amount - fee - claimTip`, and is unknown when the actual caller is not known. A promised tip is never reported as
 * the seller's payout.
 */
export function salePayoutAfterClaim({ amountWei, feeWei, claimTipWei = 0, claimed = false, claimSucceeded = false,
  sender = null, claimer = null, to = null, from = null, escrow = null } = {}) {
  const amount = payoutBig(amountWei, { allowZero: false });
  const fee = payoutBig(feeWei);
  const tip = payoutBig(claimTipWei);
  if (amount === null || fee === null || tip === null) return { outcome: "unknown", payoutWei: null };
  if (!claimed || !claimSucceeded || fee > amount || fee + tip > amount) {
    return { outcome: "unknown", payoutWei: null };
  }
  if (tip === 0n) return { outcome: "claimed", payoutWei: amount - fee };
  // A DIRECT CLAIM'S `from` IS `msg.sender` ONLY WHEN `to` IS THE ESCROW. A claim routed through another contract
  // has a different caller; without the escrow there is no way to check `to`, so the sender stays unknown.
  const text = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
  const actualSender = text(sender) ? sender
    : (text(to) && text(from) && text(escrow) && text(to) === text(escrow) ? from : null);
  const senderText = text(actualSender);
  const claimerText = text(claimer);
  if (!senderText || !claimerText) return { outcome: "unknown", payoutWei: null };
  if (senderText === claimerText) return { outcome: "claimed", payoutWei: amount - fee };
  return { outcome: "claimed", payoutWei: amount - fee - tip };
}

const sameAddr = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
const zeroAddr = (a) => !a || /^0x0{40}$/i.test(String(a));

// MEMORY OF THE LAST SIGNED QUOTE. The rate becomes known ONLY with the quote; before it there is none,
// and showing zero or a config value instead would be lying. The checks insert their own values
// via resetFeeCache + feeTermsFromQuote.
let lastTerms = null;

// RESET THE MEMORY. Needed by the checks and by any retry after the quote changes.
export function resetFeeCache() {
  lastTerms = null;
}

// FEE FROM THE QUOTE. Returns the rate, the amount (verified by the mirror), the recipient and the direction;
// with a non-zero rate and no recipient - a refusal (the fee would burn). The result is kept in memory for the screen.
export function feeTermsFromQuote(quote) {
  if (!quote || typeof quote !== "object") throw new Error("no signed quote: there is nowhere to take the fee and the registry address");
  const amount = BigInt(String(quote.amount));
  let bps;
  try {
    bps = Number(feeBpsOf(quote.feeBps));
  } catch {
    throw new Error("fee rate outside the ceiling or missing: " + quote.feeBps);
  }
  const fee = feeWeiFor(amount, bps);
  if (BigInt(String(quote.fee === undefined || quote.fee === null ? 0 : quote.fee)) !== fee) {
    throw new Error("signed fee " + quote.fee + " diverges from the formula amount * rate (" + fee + ") - signature not started");
  }
  if (bps !== 0 && zeroAddr(quote.feeRecipient)) throw new Error("with a non-zero rate the fee recipient must be named");
  const providerIsLocker = sameAddr(quote.locker, quote.provider);
  const providerIsClaimer = sameAddr(quote.claimer, quote.provider);
  if (providerIsLocker === providerIsClaimer) throw new Error("cannot tell who pays the fee: the provider is named neither as depositor nor as claimer");
  const feeOnTop = providerIsClaimer;   // the provider takes ETH -> a buy -> fee on top of the deposit
  const terms = { bps, feeWei: fee, totalWei: feeOnTop ? amount + fee : amount, recipient: quote.feeRecipient || null, feeOnTop, legacy: false };
  lastTerms = terms;
  return terms;
}

// SYNCHRONOUS ACCESS TO WHAT WAS READ. Empty means "not read yet or could not": this is NOT zero, and
// the caller must close the signature, not count the fee as zero.
export function cachedFeeTerms() {
  return lastTerms;
}

// RATE FOR DISPLAY. The only place the page takes the number for the price-breakdown line from. No answer -
// null, and the screen says the rate is not known yet.
export function cachedFeeRate() {
  if (!lastTerms || !Number.isFinite(Number(lastTerms.bps))) return null;
  return Number(lastTerms.bps) / 10000;
}

// THIS FUNCTION USED TO READ THE RATE FROM THE CHAIN. Now there is nothing to read: the rate is in the signed
// quote and arrives with it (feeTermsFromQuote). The function is kept for the screens that call it: before the
// quote it honestly returns what is already known (usually null - "rate unknown"), and invents nothing.
export async function ensureFeeTerms() {
  return lastTerms;
}
