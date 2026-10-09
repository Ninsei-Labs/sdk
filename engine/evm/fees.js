// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/fees.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

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

// THE MIRROR OF THE CONTRACT FORMULA. One place for the whole page: a second copy would diverge from the first
// exactly where it is most expensive - on the amount the escrow requires.
export function feeWeiFor(amountWei, feeBps) {
  const amount = BigInt(amountWei === null || amountWei === undefined || amountWei === "" ? 0 : amountWei);
  const bps = BigInt(Number(feeBps) || 0);
  if (amount < 0n || bps < 0n) throw new Error("fee: negative amount or rate");
  return (amount * bps) / 10000n;   // DOWN, as in Solidity: amount * feeBps / 10000
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
  const bps = Number(quote.feeBps === undefined || quote.feeBps === null ? 0 : quote.feeBps);
  if (!Number.isFinite(bps) || bps < 0 || bps > MAX_FEE_BPS) throw new Error("fee rate outside the ceiling: " + quote.feeBps);
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
