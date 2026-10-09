// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/funding.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

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

import { encodeCreateOrderAndFund, encodeCreateOrderAndFundByDepositor, encodePredict, decodeAddress, ORDER_CREATED_TOPIC } from "./factory.js";
// THE DEPOSITOR BY SIGNATURE: the signature shape comes from one place (evm/depositor.js), next to the protocol
// shape. Checking the shape here would be a second record of the same rule.
import { depositorSignatureShape } from "./depositor.js";
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
export function testOrderTerms({ locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker, amountWei, salt, claimWindowSeconds = 3600, readyWindowSeconds = 14400, readyBy, t1 }) {
  // THE VIEW POINT IS ON THE REQUIRED LIST: without it the Monero address cannot be assembled from the order
  // fields, and the one who learns about it would be the claimer, after funding.
  for (const [k, v] of Object.entries({ commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker })) {
    if (!v) throw new Error("order term not set: " + k);
  }
  const now = Math.floor(Date.now() / 1000);
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

// Amount in wei from a human value (string) and the token decimals.
export function toWei(human, decimals = 18) {
  const [intPart, fracPart = ""] = String(human).split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

// WE SET THE GAS OURSELVES, WITH A MARGIN - A CURE FOR A REAL BUG, NOT CAUTION.
// createOrderAndFund goes as ONE transaction, but the wallet estimates it at an address where the escrow does NOT
// exist yet: instead of cloning and recording the deposit it counts a plain transfer (21000 plus data). The wallet
// estimate cannot be trusted here, so the limit is set explicitly, with a margin over the MEASURED value.
// MEASURED: a full createOrderAndFund after the move to EIP-1167 clones - 315 530 gas (the old whole contract was
// 1,190,683). The limit is about twice the measured value: a shortfall costs the person a signature, while spare
// gas in a limit costs almost nothing.
const GAS_CREATE_ORDER_AND_FUND = 700_000n;
// THERE IS NO SEPARATE "CREATE WITHOUT A DEPOSIT" CONSTANT: no whole contract is created any more - each order's
// escrow is an EIP-1167 clone of one shared implementation, the terms live in the clone's code, and the factory
// only knows createOrderAndFund. The old lock(bytes) call and its gas constant are gone: the deposit rides in the
// same transaction.

// The OrderCreated event: topic0 is computed from the actual signature (also checked by the watchtower);
// topics = [topic0, escrow, locker, claimer]; data carries both commitments, both points, the amount, readyBy, t1,
// the salt. THE EVENT TOPIC COMES FROM ONE PLACE - the factory module, not a second copy here. It USED to be a
// second copy here, which caused a real defect: after the OrderCreated field set changed, the stale copy failed to
// find the event and the escrow address silently fell back to the prediction - so the "address from the receipt"
// check stopped working without a word.

// The ACTUAL escrow address from the receipt. Returns null when the event is absent (the transaction is not in a
// block, or the factory is another) - then the caller must say so aloud rather than substitute a guess.
export function escrowFromReceipt(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  for (const log of receipt.logs) {
    const topics = log.topics || [];
    if (String(topics[0]).toLowerCase() !== ORDER_CREATED_TOPIC) continue;
    if (topics.length < 2) continue;
    const addr = "0x" + String(topics[1]).slice(26).toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(addr) && !/^0x0{40}$/.test(addr)) return addr;
  }
  return null;
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
export async function fundOrder({ factory, locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker, salt: providedSalt, amountWei, amountLabel, claimWindowSeconds, readyWindowSeconds, readyBy, t1, quote, depositorSignature = null, call, send, receipt, onStep }) {
  if (!factory) throw new Error("no escrow factory address set for this network");
  if (!locker) throw new Error("no EVM wallet connected: there is nobody to deposit");
  if (!claimer) throw new Error("the order recipient (claimer) is not set");
  if (locker.toLowerCase() === claimer.toLowerCase()) {
    throw new Error("locker and claimer must not coincide: the contract rejects such an order");
  }
  // A SIGNED QUOTE IS MANDATORY: it carries the fee, the registry address and the provider, without which the
  // order cannot be created. The fee used to be asked of the factory - now there is nothing to ask; a missing
  // quote is a NAMED refusal, not a silent funding of the wrong amount.
  if (!quote || typeof quote !== "object") throw new Error("a signed quote is required: the factory takes a quote, not bare order terms");

  // COMMITMENTS AND POINTS ARE MANDATORY, and checked here and not deeper: without them the order is created but
  // can neither be claimed nor have its half-to-Monero-address link proven. Let it fail loudly.
  // The salt determines the escrow address and must exist BEFORE the terms are assembled: the terms also go to predict.
  const salt = providedSalt || newSecret(); // CREATE2 salt: determines the escrow address
  const terms = testOrderTerms({
    locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker,
    amountWei, salt, claimWindowSeconds, readyWindowSeconds, readyBy, t1,
  });
  // TAKE THE SALT FROM THE DEAL IF IT ALREADY HAS ONE. The salt determines the escrow address (CREATE2), so a
  // re-run of funding with a new salt created a NEW escrow while the deal record kept the old address - the page,
  // the explorer link and the progress screen showed an address not on chain. Re-using the salt also means a retry
  // hits the SAME address and, if the order is already funded, simply fails instead of quietly creating a second
  // escrow. The parameters are destructured, so there is no `order` variable here; the local is named `salt` and
  // the input `providedSalt` to avoid a temporal-dead-zone self-reference.
  // 1) the escrow address is visible BEFORE creation - that is the point of the factory
  onStep?.("computing the escrow address");
  // THE PREDICTION FIELDS MUST MATCH THE CREATION FIELDS BYTE FOR BYTE - the address is a hash of the creation
  // code. Here that is guaranteed because both predict and createOrderAndFund are built from THE SAME terms: they
  // can diverge only if one of the two places is edited alone. They already did once (the preimage was missing from
  // the prediction); the cure is a shared source of fields, not care.
  // THE DEPOSITOR'S FIELDS GO AS SEPARATE FACTORY ARGUMENTS (they are not in the signed set).
  const quoteEnc = { ...quote, commitHalfLocker: terms.commitHalfLocker, edPointLocker: terms.edPointLocker, edViewPointLocker: terms.edViewPointLocker };
  // QUOTE AND TERMS ARE ABOUT ONE THING: a divergence moves the escrow address and signs the wrong order.
  for (const name of ["locker", "claimer", "amount", "readyBy", "t1", "salt"]) {
    if (String(quote[name]).toLowerCase() !== String(terms[name]).toLowerCase()) {
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

  // 2) ONE TRANSACTION: creating the order TOGETHER with the deposit.
  //
  // It used to be two steps (createOrder, then lock) with two defects, both seen live: the wallet estimated the
  // gas of the second transaction before code existed at the address (the limit came out as for a plain ETH
  // transfer and it failed), and a funding failure left an empty contract on chain. Now a failure rolls back
  // TOGETHER with creation, and only one signature is needed. Locker cannot be passed to this function - the sender
  // becomes it, so the refund address always belongs to whoever paid.
  // THE AMOUNT IS SHOWN IN ETH, NOT WEI, and taken as a ready string from the caller: amount formatting lives in
  // one place in the project, and a second formatter here would diverge from it. The label is short on purpose: it
  // is printed ON A BUTTON and must fit one line.
  // THE FEE IS PART OF VALUE, AND THAT IS THE MAIN CONSEQUENCE OF ITS INTRODUCTION. The contract requires
  // depositing EXACTLY `amount + fee`, so funding for the order amount alone is rejected - and rejected after
  // signing, because the check lives in the contract. The order amount (`amount` in the terms) does NOT change: it
  // is exactly what the claimer receives and what enters the terms hash. The fee is added on top, taken at claim,
  // returned on refund.
  onStep?.("reading the escrow fee from the signed quote");
  // THE FEE COMES FROM THE QUOTE AND IS MIRROR-CHECKED. Direction is already accounted for: a buy is amount + fee
  // (on top), a sell is amount (the fee is deducted from the claimer's payout).
  const fee = feeTermsFromQuote(quote);
  const totalValueWei = fee.totalWei;
  const feeWords = fee.feeWei > 0n
    ? " (order " + amountWei + " + fee " + fee.feeWei + ")"
    : "";
  onStep?.("locking " + (amountLabel || "funds") + feeWords + " in one transaction - confirm in wallet");
  // WHICH FACTORY DOOR THE DEPOSIT GOES THROUGH, AND IT IS NOT DECORATION. If a depositor signature is present, we
  // deposit via part A: createOrderAndFundByDepositor recovers the depositor FROM THE SIGNATURE over the quote
  // digest, so anyone may send the transaction (a relayer, our service) while the `locker` role (right to refund,
  // right to mark readiness) stays with the signer. Without a signature, the old createOrderAndFund: one wallet
  // deposits and sends, and the direct swap works as before. On neither path may the sender change the order terms
  // - both signatures cover THE SAME quote digest.
  if (depositorSignature !== null && depositorSignature !== undefined && depositorSignature !== "") {
    const shape = depositorSignatureShape(depositorSignature);
    if (!shape.ok) throw new Error("the depositor signature is unusable: " + shape.reason);
  }
  const relayedByDepositor = Boolean(depositorSignature);
  const createData = relayedByDepositor
    ? encodeCreateOrderAndFundByDepositor(quoteEnc, depositorSignature)
    : encodeCreateOrderAndFund(quoteEnc);
  const createHash = await send({
    to: factory,
    data: createData,
    value: "0x" + totalValueWei.toString(16),
    gas: GAS_CREATE_ORDER_AND_FUND,
  });

  // 2b) THE ESCROW ADDRESS COMES FROM THE RECEIPT, NOT THE PREDICTION. The prediction is right only while the salt
  // and the factory code match: a re-run of funding creates an escrow at a new address while the deal record keeps
  // the old one - and the deal looks broken (deadlines unreadable, no refund button). That is exactly what
  // happened. A divergence from the prediction is named aloud: it is a sign of a real error.
  let actualEscrow = null;
  // THE ESCROW'S BIRTH BLOCK is the height from which the deal exists on chain, and the only source of that height
  // independent of the Monero node. Declared outside the branch on purpose: a variable declared inside a block is
  // not visible outside, and it must always be returned.
  let birthBlock = null;
  if (typeof receipt === "function") {
    const rc = await waitReceipt(receipt, createHash);
    actualEscrow = escrowFromReceipt(rc);
    if (rc && Number.isFinite(Number(rc.blockNumber))) birthBlock = Number(rc.blockNumber);
    if (!rc) {
      onStep?.("no receipt yet - using the predicted address");
    } else if (!actualEscrow) {
      onStep?.("no OrderCreated in the receipt - using the predicted address");
    } else if (actualEscrow !== String(escrow).toLowerCase()) {
      console.warn("[escrow] receipt address " + actualEscrow + " != predicted " + escrow + " - using the receipt one");
      onStep?.("receipt address differs from predicted - using the receipt one");
    }
  }
  const escrowToUse = actualEscrow || escrow;

  // 3) THE SECOND TRANSACTION IS GONE: the money left together with order creation. The name lockHash is kept on
  // purpose - callers look at it, and renaming would touch them with no benefit. THERE IS AND WILL BE NO TOP-UP:
  // the escrow has no separate funding function, and adding one would restore the "create empty, fund by a second
  // call" path that locked money inside a closed order. An unfunded order shows in the receipt: an order is never
  // created without money.
  const lockHash = createHash;

  // escrow is the ACTUAL address (from the receipt, if there was one); predictedEscrow is kept so a divergence is
  // visible outside, not only in the log.
  // THE FEE GOES OUTWARD: it went into the transaction and the deal record must keep it - otherwise the record
  // cannot tell how much the person deposited, and it would diverge from what the chain shows.
  return { feeWei: fee.feeWei, feeTotalWei: totalValueWei, feeBps: fee.bps, feeWasLegacyFactory: Boolean(fee.legacy),
           // WHICH FACTORY PATH RAN: visible outside, not only in the wallet's calldata. By it the checks and the
           // deal record know whether the ETH returns to the signer and not to the sender.
           depositorPath: relayedByDepositor,
           escrow: escrowToUse, predictedEscrow: escrow, escrowMismatch: Boolean(actualEscrow && actualEscrow !== String(escrow).toLowerCase()), salt, birthBlock, terms, createHash, lockHash };
}
