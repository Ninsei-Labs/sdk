// Funding an order in the escrow contract: real transactions, not a simulation.
//
// Roles and why:
//   - the order is created and the ETH deposited by whoever is recorded as `locker` in the terms (the contract
//     requires exactly them);
//   - the claimer takes by the secret - the address is set in the terms, the caller cannot change the recipient;
//   - the secret at this step is generated HERE and marked as a test one: in production it is born when the XMR is
//     spent (HTLC), and then this same function simply receives it from outside.
//
// keccak256 is passed in as a dependency, as in the address module: the caller loads the key library, not this
// module. Monero and Ethereum share Keccak-256, so the hash computed by the bundle matches what Solidity checks.

import { encodeCreateOrderAndFund, encodePredict, decodeAddress, ORDER_CREATED_TOPIC } from "./factory.js";
import { encodeStatus, decodeStatus } from "./escrow.js";
// THE FEE: rate, amount and recipient are PART OF THE SIGNED QUOTE. The factory no longer has them (the router was
// removed), so the amount comes from the quote and is cross-checked by the formula mirror. Without a quote there
// is nothing to fund with: the factory takes a signed set, not bare order terms.
import { feeTermsFromQuote } from "./fees.js";
// PRE-SIGNING GUARDS: the order deadlines and the escrow state are pure functions, because they can be checked
// against the numbers that BREAK them only if they know neither the network nor the wallet.
import { deadlineVerdict, escrowStateVerdict } from "../core/preSignGuards.js";
import { SIGNING_GUARDS } from "../core/config.js";

const ATOMIC = 1_000_000_000_000_000_000n; // 1 ETH = 10^18 wei

// A test secret: 32 bytes from the browser's crypto generator.
export function newSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Order terms. Time is absolute (unix), as the contract requires.
//
// NO PREIMAGE HERE ANY MORE: instead, BOTH half commitments and BOTH ed25519 public points go into the order. The
// function REQUIRES them and fails if they are missing - on purpose: silently sending an order with missing fields
// would create an escrow that can neither be claimed nor have its half-to-address link proven. Better to refuse
// here and loudly.
//
// TWO DEADLINES THAT DO NOT COINCIDE: until readyBy the depositor marks readiness ("I see the XMR"), from t1 a
// claim is closed and anyone may refund. Coincidence would restore a window where both paths are valid and gas
// would decide the dispute.
export function testOrderTerms({ locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker, amountWei, salt, claimWindowSeconds = 3600, readyWindowSeconds = 14400, readyBy, t1, nowSec = null }) {
  // THE VIEW POINT IS ON THE REQUIRED LIST: without it the Monero address cannot be assembled from the order
  // fields, and the one who learns about it would be the claimer, after funding.
  for (const [k, v] of Object.entries({ commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker })) {
    if (!v) throw new Error("order term not set: " + k);
  }
  const now = Number.isSafeInteger(Number(nowSec)) && Number(nowSec) > 0
    ? Number(nowSec) : Math.floor(Date.now() / 1000);
  // DEADLINES MAY BE PASSED IN READY-MADE, AND THAT IS NECESSITY, NOT CONVENIENCE. They enter the canonical order
  // context the proof is bound to, and the proof is computed BEFORE funding. Computing the deadlines here and now
  // would put them AFTER the proof, so the proof would bind one set of deadlines while the contract gets another.
  // The caller therefore fixes them in advance and passes them here.
  const hasReady = readyBy !== undefined && readyBy !== null && readyBy !== "";
  const hasT1 = t1 !== undefined && t1 !== null && t1 !== "";
  const readyByValue = hasReady ? Number(readyBy) : now + readyWindowSeconds;
  // t1 is a WINDOW AFTER readyBy, not "from now": the flat formula with a 4-hour readiness window gave t1 earlier
  // than readyBy. Same meaning as in the package's swap flow and the node's reverse order.
  const t1Value = hasT1 ? Number(t1) : readyByValue + claimWindowSeconds;
  // THE ORDER INVARIANT IS CHECKED HERE: readiness is marked before readyBy, a claim is closed from t1.
  // Coincidence or a swap would give a window where both paths are valid and gas would decide the dispute.
  if (!(t1Value > readyByValue)) throw new Error("the settlement deadline must be later than the readiness deadline: t1=" + t1Value + ", readyBy=" + readyByValue);
  // DEADLINES ARE CHECKED NOT ONLY FOR "LATER": an order with a past deadline or too tight a window can neither be
  // marked ready nor claimed - money hanging until refund. The rule (and the thresholds) live in the guard module;
  // here it is a refusal in words.
  const deadlines = deadlineVerdict({ nowSec: now, readyBy: readyByValue, t1: t1Value, ...SIGNING_GUARDS });
  if (deadlines.blocks) throw new Error("order deadlines are not usable: " + deadlines.reason);
  return {
    locker,
    claimer,
    commitHalfLocker,                           // commitment to the depositor's half
    commitHalfClaimer,                          // commitment to the claimer's half
    edPointLocker,                              // P_a: the other side assembles the joint address from it
    edPointClaimer,                             // P_b
    edViewPointLocker,                          // V_a: the depositor's VIEW half (needed for the Monero address)
    amount: String(amountWei),
    // THE READINESS WINDOW IS ABOUT MONERO, NOT EVM. The maker locks the XMR only after funding, and marking
    // readiness makes sense only once the XMR is really confirmed: Monero blocks are Poisson, about 2.5 minutes on
    // average to the first confirmation, but one slow block easily gives 10-20. Plus the maker's own steps: wallet,
    // fee, send. Fifteen minutes did not fit the tail, so 30 - by measurement, not "just in case".
    readyBy: String(readyByValue),
    t1: String(t1Value),                        // settlement boundary: one hour by default
    // THE SALT ENTERS THE TERMS, IT IS NOT ADDED TO THEM. It determines the escrow address (CREATE2), and predict
    // must compute the address FROM THE SAME FIELDS that go into creation. It used to be added only to the creation
    // call while predict ran without it - and failed its own check in the calldata encoder. "One source of fields"
    // was broken on exactly this field.
    salt,
  };
}

// Amount in wei from a human decimal value and the token decimals.
//
// The value must carry its exact digits. A significant digit beyond `decimals` is a refusal; it is never sliced
// away, because that would fund a different amount from the signed one. Trailing zeroes beyond the decimals are
// not significant and are accepted.
export function toWei(human, decimals = 18) {
  const text = String(human);
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error("the amount is not a decimal number");
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0) throw new Error("the decimals are not a whole number");
  const fraction = match[1] || "";
  if (fraction.length > dec && /[1-9]/.test(fraction.slice(dec))) {
    throw new Error("the amount has more decimal digits than the token");
  }
  const kept = fraction.slice(0, dec).padEnd(dec, "0");
  return BigInt(text.split(".")[0]) * 10n ** BigInt(dec) + BigInt(kept || "0");
}

// THE ONE NATIVE AMOUNT OF A TOKEN-FUNDED ORDER.
//
// The escrow holds the network's NATIVE coin; a quote paid in USDC/USDT carries a different number in the token.
// The native figure is the quote's own `payNative`, in the network's native decimals. A quote without that figure
// is a NAMED refusal, never a fallback to the payment amount: rescaling the payment amount is a known wrong answer
// (10^12 on a 6-decimal token), not a smaller error. This is the rule both the intent target and the escrow order
// read, so the two cannot diverge.
export function escrowNativeWei({ quote = null, nativeDecimals = 18 } = {}) {
  const raw = quote ? quote.payNative : null;
  if (raw === null || raw === undefined || raw === "") {
    return { ok: false, code: "native-amount-unread", reason: "the quote carries no native amount" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, code: "native-amount-unread", reason: "the quote's native amount is not a positive number" };
  }
  // A number at or above the safe-integer range has already lost digits before this function sees it.
  if (typeof raw === "number" && Math.abs(raw) > Number.MAX_SAFE_INTEGER) {
    return { ok: false, code: "native-amount-unread", reason: "the quote's native amount is not a safe number" };
  }
  const dec = Number(nativeDecimals);
  if (!Number.isInteger(dec) || dec < 0) {
    return { ok: false, code: "native-amount-unread", reason: "the native decimals are not a whole number" };
  }
  // THE QUOTE'S OWN DIGITS. A canonical decimal string keeps them; exponent form is not a canonical amount.
  const text = String(raw);
  // DECIMAL DIGITS ONLY. BigInt accepts "0x10", and a native amount read as a hex literal would silently become
  // sixteen times the token amount; a quote carries decimal text.
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    return { ok: false, code: "native-amount-unread", reason: "the native amount is not a decimal number" };
  }
  let wei;
  try { wei = toWei(text, dec); }
  catch { return { ok: false, code: "native-amount-unread", reason: "the native amount is not a decimal number" }; }
  if (wei <= 0n) {
    return { ok: false, code: "native-amount-unread", reason: "the native amount rounds to zero wei" };
  }
  return { ok: true, wei: wei.toString(), source: "native" };
}

// WE SET THE GAS OURSELVES, WITH A MARGIN - A CURE FOR A REAL BUG, NOT CAUTION.
// createOrderAndFund goes as ONE transaction, but the wallet estimates it at an address where the escrow does NOT
// exist yet: instead of cloning and recording the deposit it counts a plain transfer (21000 plus data). The wallet
// estimate cannot be trusted here, so the limit is set explicitly, with a margin over the MEASURED value.
// MEASURED: a full createOrderAndFund after the move to EIP-1167 clones - 315 530 gas (the old whole contract was
// 1,190,683). The limit is about twice the measured value: a shortfall costs the person a signature, while spare
// gas in a limit costs almost nothing.
// EXPORTED ON PURPOSE: the buyer's gas reserve (evm/gasReserve.js) must account for THIS deposit on the path
// where the wallet holds no native of its own - there the deposit is paid AFTER the swap, not before it, so
// its gas is part of what the wallet has to be able to afford. One constant, one source (the check ties the
// reserve's copy to this declaration).
export const GAS_CREATE_ORDER_AND_FUND = 700_000n;
// There is no separate "create without a deposit" constant. Each order escrow is an EIP-1167 clone, the terms live in
// the clone code, and the factory only has createOrderAndFund. The deposit rides in the same transaction.

// The OrderCreated event: topic0 comes from the actual signature. Topics are [topic0, escrow, locker, claimer].
// Data carries both commitments, both points, the amount, readyBy, t1 and the salt.
// The event topic comes from the factory module, not a second copy here.

// The ACTUAL escrow address from the receipt. Returns null when the event is absent (the transaction is not in a
// block, or the factory is another) - then the caller must say so aloud rather than substitute a guess.
export function escrowFromReceipt(receipt, { factory = null, expectedEscrow = null } = {}) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const wantFactory = factory ? String(factory).toLowerCase() : null;
  const wantEscrow = expectedEscrow ? String(expectedEscrow).toLowerCase() : null;
  for (const log of receipt.logs) {
    // THE EVENT MUST COME FROM THE FACTORY THAT WAS CALLED. Another contract can emit the same topic; accepting
    // it would let a receipt from a different order name the escrow that gets saved and used for the withdrawal.
    if (wantFactory && String(log && log.address || "").toLowerCase() !== wantFactory) continue;
    const topics = log.topics || [];
    if (String(topics[0]).toLowerCase() !== ORDER_CREATED_TOPIC) continue;
    if (topics.length < 2) continue;
    const addr = "0x" + String(topics[1]).slice(26).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr) || /^0x0{40}$/.test(addr)) continue;
    // THE PREDICTED ADDRESS IS THE EXPECTED ONE. A different escrow in the same factory is not this order; the
    // caller must not save it as funded.
    if (wantEscrow && addr !== wantEscrow) continue;
    return addr;
  }
  return null;
}

// A RECEIPT IS A VERDICT, NOT A PRESENCE CHECK. `status: 0` is a reverted transaction; a receipt with no
// OrderCreated from the expected factory is not a funded escrow; a missing receipt is pending. Only status 1 plus
// the expected event is funded, and the caller saves the escrow only on that answer.
export function fundingReceiptVerdict(receipt, { factory = null, expectedEscrow = null } = {}) {
  if (!receipt || typeof receipt !== "object") return { status: "pending", reason: "no-receipt" };
  if (receipt.status === undefined || receipt.status === null || receipt.status === "") {
    return { status: "pending", reason: "no-status" };
  }
  const status = Number(receipt.status);
  if (!Number.isFinite(status)) return { status: "pending", reason: "bad-status" };
  if (status === 0) return { status: "reverted", reason: "status-0" };
  if (status !== 1) return { status: "pending", reason: "bad-status" };
  const escrow = escrowFromReceipt(receipt, { factory, expectedEscrow });
  if (!escrow) return { status: "pending", reason: "no-order-created" };
  const blockNumber = Number(receipt.blockNumber);
  return { status: "funded", escrow, birthBlock: Number.isFinite(blockNumber) ? blockNumber : null };
}

// Wait for a receipt: right after signing there is none, which is normal. Waiting forever is not allowed - we say so honestly.
async function waitReceipt(receiptReader, hash, { tries = 12, delayMs = 1500 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const r = await receiptReader({ hash }).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

// The full funding path. Steps are returned outward so the interface can show each one: predict is a free call,
// createOrder and lock are transactions in the user's wallet.
export async function fundOrder({ factory, locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker, salt: providedSalt, amountWei, amountLabel, claimWindowSeconds, readyWindowSeconds, readyBy, t1, quote, call, send, receipt, onStep, onPredicted, nowSec = null }) {
  if (!factory) throw new Error("no escrow factory address set for this network");
  if (!locker) throw new Error("no EVM wallet connected: there is nobody to deposit");
  if (!claimer) throw new Error("the order recipient (claimer) is not set");
  if (locker.toLowerCase() === claimer.toLowerCase()) {
    throw new Error("locker and claimer must not coincide: the contract rejects such an order");
  }
  // A signed quote is mandatory. It carries the fee, the registry address and the provider. Without it, the order
  // cannot be created, and funding would use the wrong amount.
  if (!quote || typeof quote !== "object") throw new Error("a signed quote is required: the factory takes a quote, not bare order terms");
  // THE QUOTE'S EXPIRY IS JUDGED AT THE FUNDING BOUNDARY. A device clock behind the chain lets an expired quote
  // reach createOrderAndFund, which reverts after the fee is paid. The caller passes the chain time; when it is
  // absent this is a test seam and the device clock remains the only clock available.
  const fundingNowSec = Number.isSafeInteger(Number(nowSec)) && Number(nowSec) > 0
    ? Number(nowSec) : Math.floor(Date.now() / 1000);
  const validUntil = Number(quote.validUntil);
  if (Number.isSafeInteger(validUntil) && validUntil > 0 && validUntil <= fundingNowSec) {
    const error = new Error("the signed quote has expired at the funding boundary");
    error.code = "quote-expired";
    error.params = { validUntil, now: fundingNowSec, step: "lock" };
    throw error;
  }

  // Commitments and points are mandatory. Without them the order can be created but cannot be claimed, and its link
  // to the Monero address cannot be proven.
  // The salt determines the escrow address and must exist before the terms are assembled. The terms also go to predict.
  const salt = providedSalt || newSecret(); // CREATE2 salt: determines the escrow address
  const terms = testOrderTerms({
    locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker,
    amountWei, salt, claimWindowSeconds, readyWindowSeconds, readyBy, t1, nowSec,
  });
  // Reuse the salt from the deal when it already has one. The salt determines the escrow address, so a new salt
  // creates a new escrow while the record keeps the old address. Reuse also makes a retry hit the same address.
  // The parameters are destructured, so the local is `salt` and the input is `providedSalt`.
  // 1) the escrow address is visible before creation. That is the point of the factory.
  onStep?.("computing the escrow address");
  // The prediction fields must match the creation fields byte for byte. Both paths use the same terms, so they can
  // diverge only when one place is edited alone. Keep one source of fields.
  // The depositor's fields go as separate factory arguments, but they are in the signed set. The overwrite below must
  // reproduce the signed values, or the digest check rejects the order.
  const quoteEnc = { ...quote, commitHalfLocker: terms.commitHalfLocker, edPointLocker: terms.edPointLocker, edViewPointLocker: terms.edViewPointLocker };
  // Quote and terms must agree. A divergence moves the escrow address and signs the wrong order.
  // The counterparty's spend half is part of that check. The proof is checked against the counterparty side, while
  // the factory encodes the signed quote.
  const sameValue = (a, b) => String(a === undefined || a === null ? "" : a).replace(/^0x/i, "").toLowerCase()
    === String(b === undefined || b === null ? "" : b).replace(/^0x/i, "").toLowerCase();
  for (const name of ["locker", "claimer", "amount", "readyBy", "t1", "salt", "commitHalfClaimer", "edPointClaimer",
    "commitHalfLocker", "edPointLocker", "edViewPointLocker"]) {
    if (!sameValue(quote[name], terms[name])) {
      throw new Error("the quote and the order terms diverge on field " + name);
    }
  }
  const predictedRaw = await call({ to: factory, data: encodePredict(quoteEnc) });
  const escrow = decodeAddress(predictedRaw);
  if (!/^0x[0-9a-fA-F]{40}$/.test(escrow) || /^0x0{40}$/i.test(escrow)) {
    throw new Error("the factory returned an invalid escrow address: " + String(predictedRaw).slice(0, 40));
  }

  // 1b) THE ESCROW STATE IS CHECKED BEFORE SIGNING, NOT AFTER. The address is known (predict above), and if it
  // already holds a funded, claimed or refunded order, signing is not allowed: the contract forbids a second
  // deposit (AlreadyFunded), while a new signature (with a new salt) would create a SECOND order instead of the old
  // one - the money would go there, not where the person thinks.
  //
  // AN EMPTY ANSWER MEANS "NO ORDER", NOT "COULD NOT CHECK": for an address that does not exist yet eth_call
  // returns empty. A CALL ERROR is a different state and it blocks: "did not check" must not count as "all good".
  onStep?.("checking the order is not already on chain");
  let stateRead = null;
  try {
    const raw = await call({ to: escrow, data: encodeStatus() });
    const body = String(raw || "").replace(/^0x/, "");
    // The escrow answer must be four status() words: shorter means no contract executing status() at this
    // address, so there is no order there and cannot be one.
    stateRead = body.length >= 256 ? { status: decodeStatus(raw) } : { status: null };
  } catch (e) {
    stateRead = { error: String((e && e.message) || e) };
  }
  const escrowState = escrowStateVerdict({ status: stateRead.status, error: stateRead.error, address: escrow });
  if (escrowState.blocks) throw new Error("signature not started: " + escrowState.reason);
  // 2) One transaction creates the order and funds it.
  //
  // A failure rolls back creation, and one signature is enough. The sender becomes the locker, so the refund address
  // always belongs to the payer.
  // The amount is shown in ETH, not wei, and arrives as a ready string. Formatting lives in one place.
  // The fee is part of the value. The contract requires exactly `amount + fee`, so funding the order amount alone is
  // rejected after signing. The order amount is what the claimer receives and what enters the terms hash. The fee is
  // added on top, taken at claim and returned on refund.
  onStep?.("reading the escrow fee from the signed quote");
  // THE FEE COMES FROM THE QUOTE AND IS MIRROR-CHECKED. Direction is already accounted for: a buy is amount + fee
  // (on top), a sell is amount (the fee is deducted from the claimer's payout).
  const fee = feeTermsFromQuote(quote);
  const totalValueWei = fee.totalWei;
  const feeWords = fee.feeWei > 0n
    ? " (order " + amountWei + " + fee " + fee.feeWei + ")"
    : "";
  onStep?.("locking " + (amountLabel || "funds") + feeWords + " in one transaction - confirm in wallet");
  // WHICH FACTORY DOOR THE DEPOSIT GOES THROUGH. There is ONE path: createOrderAndFund, where the wallet that
  // sends the transaction becomes the locker. The sender may not change the order terms - the quote signature
  // covers THE SAME digest the escrow checks.
  // THE PREDICTED ADDRESS IS WRITTEN TO THE CALLER'S RECORD BEFORE THE TRANSACTION. A receipt can take longer than
  // the process that sent it; a record saved only after the wait leaves nothing to resume from, and the retry asks
  // for a second deposit. The callback runs after every refusal and immediately before the send.
  if (typeof onPredicted === "function") await onPredicted({ escrow, salt, terms });
  const createData = encodeCreateOrderAndFund(quoteEnc);
  const createHash = await send({
    to: factory,
    data: createData,
    value: "0x" + totalValueWei.toString(16),
    gas: GAS_CREATE_ORDER_AND_FUND,
  });

  // 2b) The escrow address comes from the receipt, not from the prediction. The prediction is right only when the
  // salt and the factory code match. A divergence is a sign of a real error and must be named.
  let actualEscrow = null;
  // The escrow birth block is the height where the deal exists on chain. It is the only source of that height
  // independent of the Monero node. Declare it outside the branch so every path can return it.
  let birthBlock = null;
  let verdict = { status: "pending", reason: "no-receipt-reader" };
  if (typeof receipt === "function") {
    const rc = await waitReceipt(receipt, createHash);
    verdict = fundingReceiptVerdict(rc, { factory, expectedEscrow: escrow });
    if (verdict.status === "reverted") {
      const error = new Error("the funding transaction reverted");
      error.code = "contract-reverted";
      error.receiptStatus = 0;
      throw error;
    }
    if (verdict.status === "funded") {
      actualEscrow = verdict.escrow;
      birthBlock = verdict.birthBlock;
      if (actualEscrow !== String(escrow).toLowerCase()) {
        console.warn("[escrow] receipt address " + actualEscrow + " != predicted " + escrow + " - using the receipt one");
        onStep?.("receipt address differs from predicted - using the receipt one");
      }
    } else if (!rc) {
      onStep?.("no receipt yet - funding is pending, not funded");
    } else {
      onStep?.("receipt has no matching OrderCreated - funding is pending, not funded");
    }
  }

  // 3) THE SECOND TRANSACTION IS GONE: the money left together with order creation. The name lockHash is kept on
  // purpose - callers look at it, and renaming would touch them with no benefit. THERE IS AND WILL BE NO TOP-UP:
  // the escrow has no separate funding function, and adding one would restore the "create empty, fund by a second
  // call" path that locked money inside a closed order. An unfunded order shows in the receipt: an order is never
  // created without money.
  const lockHash = createHash;

  // ONLY A STATUS-1 RECEIPT WITH THE EXPECTED ORDER CREATED IS FUNDED. A missing receipt, a receipt without the
  // event, or an event from another factory keeps `escrow` null and is returned as pending; the caller must not
  // save it, retire a recovery number for it, or call it xmr-incoming.
  // THE FEE GOES OUTWARD: it went into the transaction and the deal record must keep it - otherwise the record
  // cannot tell how much the person deposited, and it would diverge from what the chain shows.
  const common = { feeWei: fee.feeWei, feeTotalWei: totalValueWei, feeBps: fee.bps, feeWasLegacyFactory: Boolean(fee.legacy),
    predictedEscrow: escrow, salt, terms, createHash, lockHash };
  if (verdict.status !== "funded") {
    return { ...common, escrow: null, birthBlock: null, funded: false, pending: true, pendingReason: verdict.reason };
  }
  return { ...common, escrow: actualEscrow, escrowMismatch: actualEscrow !== String(escrow).toLowerCase(),
    birthBlock, funded: true, pending: false };
}
