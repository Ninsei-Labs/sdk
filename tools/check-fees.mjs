// Synthetic OrderQuote examples; expected wei are worked from the contract's integer fee rule.
import assert from "node:assert/strict";
import { feeTermsFromQuote, feeWeiFor, MAX_FEE_BPS, principalForTotal, resetFeeCache } from "../engine/evm/fees.js";
import { fundOrder } from "../engine/evm/funding.js";
import { ORDER_CREATED_TOPIC } from "../engine/evm/factory.js";

const address = (byte) => "0x" + byte.repeat(20);
const locker = address("11"), claimer = address("22"), recipient = address("33");
const base = { locker, claimer, provider: claimer, amount: "333333", feeBps: 30, fee: "999", feeRecipient: recipient };
export async function feesCheck() {
  resetFeeCache();
  assert.equal(MAX_FEE_BPS, 200, "fee ceiling is 200 basis points");
  // Below the rounding step, on it, and above it; then the cap's two neighbours.
  for (const [amount, bps, fee] of [[333333n, 30, 999n], [333334n, 30, 1000n], [333335n, 30, 1000n],
    [10000n, 0, 0n], [10000n, 199, 199n], [10000n, 200, 200n]]) {
    assert.equal(feeWeiFor(amount, bps), fee, `fee rounding ${amount}/${bps}`);
    for (const [provider, feeOnTop, total] of [[claimer, true, amount + fee], [locker, false, amount]]) {
      const terms = feeTermsFromQuote({ ...base, amount: String(amount), feeBps: bps, fee: String(fee), provider });
      assert.deepEqual(terms, { bps, feeWei: fee, totalWei: total, recipient, feeOnTop, legacy: false }, "fee roles and wei");
    }
  }
  for (const bps of [201, -1, NaN, Infinity, 1.5, undefined, null, "", "abc"]) {
    assert.throws(() => feeTermsFromQuote({ ...base, feeBps: bps }), /outside the ceiling/, `rate ${bps}`);
  }
  assert.throws(() => feeTermsFromQuote({ ...base, fee: "1000" }), /diverges from the formula/, "rounded-up signed fee");
  for (const feeRecipient of [address("00"), null]) {
    assert.throws(() => feeTermsFromQuote({ ...base, feeRecipient }), /recipient must be named/);
  }
  // A MISSING OR EMPTY AMOUNT IS NOT ZERO. The fee and the inverse principal both read a signed figure; a missing
  // one must stop the calculation rather than silently produce a zero fee or a zero deposit.
  assert.equal(feeWeiFor(0n, 30), 0n, "an explicit zero amount is valid");
  assert.equal(principalForTotal("0", 0), 0n, "an explicit zero total is valid");
  for (const amount of [undefined, null, "", -1, 1.5, NaN, Infinity, true, false]) {
    assert.throws(() => feeWeiFor(amount, 30), /must be a non-negative integer/, `fee amount ${String(amount)}`);
    assert.throws(() => principalForTotal(amount, 30), /must be a non-negative integer/, `principal total ${String(amount)}`);
  }
  // Drive the real funding entry with the same non-zero fee. The fake chain supplies only prediction/status/receipt.
  const factory = address("44"), escrow = address("55"), hash = "0x" + "66".repeat(32);
  const quote = { ...base, factory, quoteKey: claimer, registry: address("77"), cashier: address("88"),
    chainId: 421614, readyBy: 2000000000, t1: 2000003600, validUntil: 1999999990, nonce: "1",
    salt: "0x" + "99".repeat(32), xmrAmount: "1000000000000", claimTip: "0", signature: "0x" + "aa".repeat(65),
    commitHalfLocker: "0x" + "01".repeat(32), commitHalfClaimer: "0x" + "02".repeat(32),
    edPointLocker: "0x" + "03".repeat(32), edPointClaimer: "0x" + "04".repeat(32), edViewPointLocker: "0x" + "05".repeat(32) };
  const sent = [], reads = [];
  const previousNow = Date.now;
  Date.now = () => 1999996400000;
  try {
    await fundOrder({ ...quote, amountWei: quote.amount, quote,
      call: async (request) => { reads.push(request); return request.to === factory ? "0x" + escrow.slice(2).padStart(64, "0") : "0x"; },
      send: async (request) => { sent.push(request); return hash; },
      receipt: async () => ({ status: "0x1", transactionHash: hash, logs: [{ address: factory,
        topics: [ORDER_CREATED_TOPIC, "0x" + escrow.slice(2).padStart(64, "0")], data: "0x" }] }),
    });
  } finally { Date.now = previousNow; }
  assert.equal(sent.length, 1, "funding sends exactly one transaction");
  assert.equal(sent[0].to, factory, "funding targets the requested factory");
  assert.equal(BigInt(sent[0].value), 334332n, "buy funding includes 999 wei fee on 333333 wei principal");
  assert.equal(reads.length, 2, "funding predicts and checks the escrow before sending");
  const expiredSent = [];
  let expiredError = null;
  try {
    await fundOrder({ ...quote, amountWei: quote.amount, quote: { ...quote, validUntil: 1999996300 },
      nowSec: 1999996400,
      call: async () => { throw new Error("a read happened after the quote expiry"); },
      send: async (request) => { expiredSent.push(request); return hash; },
      receipt: async () => ({ status: "0x1", transactionHash: hash, logs: [] }),
    });
  } catch (error) { expiredError = error; }
  assert.equal(expiredError && expiredError.code, "quote-expired", "an expired quote is refused at the funding boundary");
  assert.equal(expiredSent.length, 0, "the expired quote sends nothing");
  // A NONEMPTY WRONG-LENGTH STATUS IS NOT "NO ORDER". The successful call above answers `0x` (no code) and is
  // allowed; one short word means something answered and cannot be read, so signing must stop.
  const shortSent = [];
  let shortError = null;
  try {
    await fundOrder({ ...quote, amountWei: quote.amount, quote, nowSec: 1999996400,
      call: async (request) => request.to === factory ? "0x" + escrow.slice(2).padStart(64, "0") : "0x" + "11".repeat(32),
      send: async (request) => { shortSent.push(request); return hash; },
      receipt: async () => ({ status: "0x1", transactionHash: hash, logs: [] }),
    });
  } catch (error) { shortError = error; }
  assert.match(String(shortError && shortError.message), /invalid answer status\(\)/,
    "a nonempty wrong-length status blocks the signature as unknown");
  assert.equal(shortSent.length, 0, "the unreadable status sends nothing");
  resetFeeCache();
  return { note: "non-zero buy/sell fees, rounding, ceiling and funding value", problems: [] };
}
