// THE ATOMIC ORDER FLOW: ONE SEQUENCE, ASSEMBLED IN ONE PLACE.
//
// WHY A SEPARATE MODULE. The rule "create the order -> lock the funds" used to be smeared across the interface:
// the UI called a simulation while the funding module waited for ready-made sealedCommitment and sealedHalf. Now
// the order is fixed here, and there is no step that can be skipped by accident:
//
//   1) build your own side (the half + the proof) - in the WORKER, so the page does not freeze;
//   2) assemble the counterparty's side (in the demo - a local stand-in, marked standIn);
//   3) CHECK the counterparty against the single mandatory condition - the DLEQ proof in the context of THIS
//      order (there is no envelope in the scheme any more, doc 27) - before any locking: after it, that would no
//      longer help. The item "the envelope that confirms the half" left together with the envelope itself;
//   4) obtain commitments on BOTH halves: our own is computed by the worker over our half (only the hash goes
//      out), the counterparty's commitment arrives in the quote. There is no longer any need to encrypt the half
//      and hand it to the counterparty: it is revealed on-chain at settlement (claim/refund);
//   5) and only now put the money in: with ONE createOrderAndFund transaction that creates the escrow together
//      with the money (the "lock" step below). The former name lock(sealedHalf) lied twice here: the contract has
//      no such function - the payable constructor moves the money - and there is no envelope in the order. Nor
//      does the escrow have a separate funding function: an order is either born with money or not born at all.
//
// THE CRYPTOGRAPHY LIVES UNDER www/js/atomic/* (mirrored as ../engine/atomic/*) AND IS CALLED ONLY THROUGH THE
// WORKER. There is no crypto here - here is the order.
//
// WHY IT IS IN THE PACKAGE NOW. The page used to import this module straight from www/js/core/swap-flow.js; the
// core (www/js, mirrored under ../engine/) was the second home of the deal flow. That is exactly the debt
// issue #32 pays off: the deal engine is business logic, so it belongs to the package (@ninsei-labs/sdk), and
// the page reaches it through ONE seam (www/js/sdk/bridge.js) by module name, not by pulling a file out of
// www/js. The engine modules it needs are still read through the same verified mirror (./engine.mjs); what moved
// is the RULES, not the crypto.
import { SdkError } from "./errors.mjs";
import * as engine from "./engine.mjs";

// THE ENGINE SURFACES, TAKEN THROUGH THE ONE SEAM (./engine.mjs) - exactly as the rest of the core does.
const { chainById, DEFAULT_CHAIN, MONERO } = engine.config;
const { fundOrderLive, newSecret, sendTransaction, readContract } = engine.evm;
const {
  encodeClaim, encodeRefund, encodeMarkReady, encodeStatus, encodeT1, encodeTermsHash, encodeRead,
  decodeUint64, decodeBytes32, decodeStatus,
} = engine.escrow;
// THE COUNTERPARTY GUARDS: whether a stand-in may be signed on this chain.
const { liveOrderSlotsVerdict, counterpartyVerdict } = engine.guards;
// THE HALF WORKER, THE ORDER CONTEXT, THE ORDER QUOTE AND THE SHARED CLAIM GAS LIMIT - all through the mirror,
// so the page and the package never keep a second copy of these rules.
const { createOrderWorker } = engine.orderClient;
const { orderContextString } = engine.orderContext;
const { requestOrderQuote, checkOrderQuoteShape } = engine.rfqSource;
const { CLAIM_GAS_LIMIT } = engine.claimGas;

// The factory address comes from the network registry: a second source of truth about addresses must not exist.
export function escrowFactoryAddress(chainSlug) {
  const chain = chainById(chainSlug || DEFAULT_CHAIN);
  const address = chain && chain.escrow && chain.escrow.address;
  if (!address) throw new SdkError("bad-input", { field: "factory", chain: typeof chainSlug === "string" ? chainSlug : null });
  return address;
}

// THE INTERFACE FEE CASHIER (#103): the address comes from the network registry, like the factory. The factory
// no longer creates the cashier - it arrives in the ORDER TERMS, and without it no quote under the order can be
// assembled.
export function escrowCashierAddress(chainSlug) {
  const chain = chainById(chainSlug || DEFAULT_CHAIN);
  const cashier = chain && chain.escrow && chain.escrow.cashier;
  if (!cashier) throw new SdkError("bad-input", { field: "cashier", chain: typeof chainSlug === "string" ? chainSlug : null });
  return cashier;
}

// The full flow. onStage(stage, detail) is called on every step - the interface must show what is going on.
export async function runAtomicOrder({
  chainSlug, locker, claimer, amountWei, amountLabel, providerId = null,
  // THE DEPOSITOR'S SIGNATURE (issue #97, parts A/C): when given, the order is placed through
  // createOrderAndFundByDepositor - any wallet may send the transaction, while the signer is recorded as the
  // depositor.
  depositorSignature = null,
  claimWindowSeconds = 3600, readyWindowSeconds = 14400, salt: providedSalt, onStage,
  // THE SUBSTITUTION POINTS FOR THE SAKE OF THE CHECK, and they are not decoration. The live flow could be
  // neither run in a check nor covered otherwise: it requires a browser Worker and a signature in the wallet.
  // Because of that two defects in a row appeared in it that neither the syntax nor the suite could see: the
  // signature did not accept the mandatory fields, and after the fix a reference to a variable outside its scope
  // remained - such things are visible only in operation. The defaults here are real: substitution is only in
  // checks.
  deps = {},
}) {
  const makeWorker = deps.createOrderWorker || createOrderWorker;
  const fundLive = deps.fundOrderLive || fundOrderLive;
  const askQuote = deps.requestOrderQuote || requestOrderQuote;
  const factory = escrowFactoryAddress(chainSlug);
  const cashier = escrowCashierAddress(chainSlug);
  const chain = chainById(chainSlug || DEFAULT_CHAIN);

  // THE DEADLINES AND THE SALT ARE DECIDED HERE, BEFORE THE PROOF, AND NOWHERE ELSE.
  //
  // This is the very reason the context stopped being a string from the caller. The proof is bound to the order
  // terms, and the terms include the deadlines and the salt. While the funding module decided them - that is,
  // AFTER the computation - the proof was bound to one set of deadlines while a different set went into the
  // contract: the check would fail at the counterparty, and on our own side everything would look healthy.
  // The salt here is the same in meaning as before: it determines the escrow address, so repeating an order must
  // come with the previous salt, otherwise a second escrow is created instead of the same one.
  const nowSec = Math.floor(Date.now() / 1000);
  const readyBy = nowSec + readyWindowSeconds;
  // t1 IS THE WINDOW AFTER readyBy, NOT "from now" (issue #88): the owner's claim window equals an hour AFTER the
  // readiness deadline. The flat formula "now + claimWindowSeconds" at a 4-hour readyBy gave t1 EARLIER than
  // readyBy, that is, an order created already closed (this is what check-atomic-flow caught).
  const t1 = readyBy + claimWindowSeconds;
  const salt = providedSalt || newSecret();

  // THE CONTEXT IS ASSEMBLED FROM THE ORDER FIELDS - by the same code as the provider node's and any verifier's.
  // The provider's half is derived from THESE SAME terms, so its proof will agree only here.
  // ONE ORDER OBJECT - ONE SOURCE OF FIELDS. Both the proof context and the quote request to the provider are
  // assembled from it. A second copy of these fields would diverge exactly where it costs the most: the provider
  // would derive its half from one set of terms while the proof was computed over another.
  //
  // THERE IS NO CLAIMER HERE, AND THAT IS FUNDAMENTAL. The contract pays whoever is recorded as claimer, and at
  // claim time the half is revealed by whoever claims. So only the PROVIDER can name the claimer: it holds the
  // half and its address must receive the money. While the application substituted its own value, the provider
  // got an order with a foreign address and could not claim the ETH for it - the half stayed with it while the
  // money went to someone else. That is why the claimer comes in the quote, and the context is assembled AFTER
  // the quote.
  const orderBase = {
    chainId: chain.chainId, factory, cashier, locker,
    amount: String(amountWei), readyBy: String(readyBy), t1: String(t1), salt,
    asset: "XMR",                  // what the user receives; not part of the context (it follows from the pair and network)
  };
  // THERE IS NO HASHLOCK AND ENVELOPE HERE ANY MORE. Under the scheme of doc 27 the order carries BOTH half
  // commitments and BOTH public ed25519 points, and the half is published by the settlement itself
  // (claim/refund). The secret that used to be placed in the recovery file is now MY HALF: it is exactly what is
  // needed to claim the XMR.
  const worker = makeWorker();
  const say = (stage, detail) => onStage?.(stage, detail);
  try {
    // THE QUOTE FIRST, THEN YOUR OWN SIDE. The order of steps is set by the fact that the claimer is named by the
    // provider: the half binding includes the claimer's address, so our own half must be computed over the
    // context that is already fully known. It used to be the other way round, and the provider got an order with
    // the address the application had chosen.
    let counter = null;
    let standIn = true;
    let quote = null;
    if (providerId) {
      say("quote", "provider-quote");
      quote = await askQuote({ providerId, order: orderBase });
      checkOrderQuoteShape(quote);
      // THE CLAIMER'S ADDRESS COMES FROM THE PROVIDER, and it is the one that goes into the contract. We check
      // the shape here because it takes part in the binding further on: garbage in this field would break the
      // proof.
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(quote.claimer || ""))) {
        throw new SdkError("quote-refused", { step: "claimer" });
      }
      if (claimer && String(claimer).toLowerCase() !== String(quote.claimer).toLowerCase()) {
        // TWO DIFFERENT RECIPIENTS: the ETH would go not to whoever holds the half.
        throw new SdkError("quote-refused", { step: "claimer", why: "caller-mismatch" });
      }
    }
    const claimerResolved = (quote && quote.claimer) || claimer;
    if (!claimerResolved) {
      throw new SdkError("bad-input", { field: "claimer" });
    }
    const order = { ...orderBase, claimer: claimerResolved };
    const orderContext = orderContextString(order);

    say("half", "side");
    const mine = await worker.buildSide(orderContext, say);
    say("half", "side-ready");

    // The counterparty stand-in. Honestly: only a real counterparty with its own key gives a guarantee; a
    // stand-in by definition guarantees nothing. Here it is needed to run the whole path in the demo.
    // THE COUNTERPARTY SIDE: A REAL PROVIDER IF ONE IS SELECTED, otherwise the stand-in.
    //
    // WITH A REAL PROVIDER WE DO NOT LEARN ITS HALF - AND MUST NOT. Only the half commitment, the ed25519 point
    // and the proof arrive in the quote; the half itself stays with it and is revealed on-chain only when it
    // claims the ETH. That is exactly why the commitment is taken FROM THE QUOTE rather than computed by us:
    // there is nothing to compute it from.
    if (quote) {
      // THE CONTEXT STRING IS CHECKED EXPLICITLY, although the proof is bound to it anyway: a mismatch must be
      // called by its own name rather than look like "the proof did not agree".
      if (String(quote.context) !== orderContext) {
        throw new SdkError("quote-refused", { step: "context" });
      }
      // THE VIEW HALF COMES FROM THE PROVIDER: without it the shared address cannot be assembled and the arrival
      // cannot be seen. The point is derived from it below - there is no cryptography in the main flow.
      // THE PROVIDER'S POINTS COME WITHOUT THE "0x" PREFIX, WHILE THE CALLDATA ENCODER REQUIRES IT.
      // The encoder (factory.js: word) accepts a decimal number or hex WITH the prefix and refuses "not a number
      // and not hex" on 64 digits without one. So the points are normalised to one form HERE - at the boundary
      // where the provider's data enters the order. IMPORTANT: we normalise both pub.ed and proof.XB, because the
      // check compares them against each other, and different spellings of one point would look like a proof
      // mismatch.
      const with0x = (v) => (typeof v === "string" && v.length && !v.startsWith("0x") ? "0x" + v : v);
      const quoteProof = quote.proof && typeof quote.proof === "object"
        ? { ...quote.proof, ...(quote.proof.XB ? { XB: with0x(String(quote.proof.XB)) } : {}) }
        : quote.proof;
      counter = { proof: quoteProof, edPub: with0x(quote.edPointClaimer), commitHalfClaimer: quote.commitHalfClaimer,
        viewHalf: quote.viewHalfClaimer, providerId: quote.providerId };
      standIn = false;
    } else {
      // THE STAND-IN IS COMPUTED OVER THE SAME CONTEXT AS THE ORDER. It used to append ":counterparty" to the
      // string, and that turned the check into a ritual: the stand-in's proof was bound to a different string,
      // that is, to nothing. Now exactly the path a real provider would take is checked.
      const mock = await worker.buildSide(orderContext);
      counter = { proof: mock.proof, edPub: mock.pub.ed, mock, viewHalf: mock.viewHalf, viewPoint: mock.viewPub };
    }
    // THE COUNTERPARTY CHECK REMAINS ONE AND IT IS THE MAIN ONE: the DLEQ proof in the context of this order.
    // It confirms that both public points stand for ONE scalar - that is, that the half declared for the Monero
    // address and the half by which the chain will compute are the same number. There is no envelope in the
    // scheme any more, so there is nothing to open - and nothing to check except the proof.
    // TOGETHER WITH IT, the fact is checked that the proven ed25519 point IS THE VERY ONE the contract will
    // receive: without that check a correct proof would guarantee nothing about the chain.
    say("verify", "dleq");
    const verdict = await worker.verifyCounterparty(orderContext, {
      proof: counter.proof, edPub: counter.edPub,
    }, null);
    if (!verdict.ok) throw new SdkError("quote-refused", { step: "proof", why: "rejected" });

    // COMMITMENTS ON BOTH HALVES: our own is computed in the worker (only the hash goes out), the counterparty's
    // either arrived in the quote or is computed over the stand-in's half. Exactly these values are checked by
    // the contract in claim and refund and are included in termsHash.
    const commitHalfLocker = (await worker.halfCommitment(mine.half)).commitment;
    const commitHalfClaimer = counter.commitHalfClaimer || (await worker.halfCommitment(counter.mock.half)).commitment;

    // THE SHARED MONERO ADDRESS - FROM THE HALVES, AND IT IS COMPUTED BEFORE THE MONEY IS LOCKED. The address used
    // to be assembled from the maker's seed, that is, from the FULL key on its side: that is a custodial scheme,
    // in which the other side can take the XMR at any moment. Now each side has its own half, and the address is
    // their sum.
    //
    // We compute it BEFORE funding on purpose: the address is derived from the same points that will go into the
    // contract, and if it cannot be assembled (the counterparty has neither a point nor a view half), we must
    // learn about it before the user signs the deposit.
    const otherViewPoint = counter.viewPoint || (counter.viewHalf ? (await worker.pointOf(counter.viewHalf)).ed : null);
    if (!otherViewPoint) {
      throw new SdkError("quote-refused", { step: "view-half" });
    }
    say("address", "joint-address");
    const joint = await worker.jointAddress({
      ownSpendHalf: mine.half, ownViewHalf: mine.viewHalf,
      otherSpendPoint: counter.edPub, otherViewPoint,
      network: (chain.monero && chain.monero.networkType) || MONERO.networkType,
    });

    // THE COUNTERPARTY STAND-IN ON A LIVE NETWORK IS A REFUSAL, NOT A SIGNATURE (the auditor's finding, review_02
    // section 6.3 and block D1, item 5). Without a provider the counterparty side is assembled locally, the proof
    // is checked against itself and proves nothing: this is the showcase mode. On a live network it would mean the
    // money went against a non-existent side. THE TRIGGER IS EXACTLY THE LIVE NETWORK: on a testnet and in the
    // local stand the stand-in is allowed and marked, otherwise the demonstration flow on arbitrum-sepolia would
    // stop working.
    // TWO DIFFERENT QUESTIONS THAT ARE EASY TO CONFUSE. "Is the escrow live" is about whether the deal is REAL
    // (on sepolia the escrow is deployed, the transactions are real - the deal is real). Here a different thing
    // is asked: whether the MONEY IN THE NETWORK IS REAL, that is, whether a made-up side can be slipped in. On
    // sepolia the contract is deployed but the money is play: the stand-in is fine there, otherwise the
    // demonstration flow would stall. On a live network the same trick would mean the funds are locked against a
    // side that does not exist. Hence the name: this is not "a live network in general" and not a network named
    // mainnet, but a network where the money is real.
    const realMoney = Boolean(chain.escrow && chain.escrow.mode === "live" && !chain.testnet);
    const counterparty = counterpartyVerdict({
      standIn, liveChain: realMoney,
      network: chain.name || chainSlug || null, chainId: chain.chainId || null,
    });
    if (!counterparty.ok) throw new SdkError("bad-input", { field: "counterparty", why: "stand-in-on-live-network" });

    // ONE TRANSACTION, NOT TWO: funding goes through createOrderAndFund, which creates the escrow together with
    // the deposit. The label on the button remained from the two-step path and lied about the number of
    // signatures.
    say("lock", "fund-order");
    const funded = await fundLive({
      // THE CLAIMER GOES INTO THE CONTRACT EXACTLY THE ONE THAT ENTERED THE BINDING: it came from the provider
      // (or from the caller in a simulation) and already participates in the context over which our half was
      // computed.
      factory, locker, claimer: order.claimer,
      // WE PASS THE DEPOSITOR'S SIGNATURE FURTHER instead of losing it halfway: without it the funding would go
      // the previous way, and the relayer would get a NotLocker refusal only after the person had signed.
      depositorSignature,
      // THE DEADLINES GO INTO THE CONTRACT EXACTLY THE ONES THAT ENTERED THE CONTEXT. This is not duplication but
      // a condition: diverge by even a second - and the proof by which the provider confirms the half stops
      // agreeing.
      readyBy, t1, readyWindowSeconds, claimWindowSeconds,
      salt,
      commitHalfLocker, commitHalfClaimer,
      // The ed25519 points go into the order explicitly: the other side assembles the shared address from them
      // and checks the proof EXACTLY against the on-chain fields, not against what arrived in the quote (doc 27
      // section 11).
      edPointLocker: mine.pub.ed, edPointClaimer: counter.edPub,
      // THE DEPOSITOR'S VIEW POINT: from it the claimer assembles the address FROM THE ORDER FIELDS. Without it
      // it does not know where to send the XMR - and learns about it only after the money is deposited.
      edViewPointLocker: mine.viewPub,
      salt,                        // our swap salt: see funding.js
      amountLabel,                 // the ready amount string for the label: formatting lives in the UI
      amountWei, claimWindowSeconds, readyWindowSeconds,
      onStep: (text) => say("lock", text),
    });
    // WE HAND OUT OUR HALF: it is what claims the XMR and what must go into the recovery file. There used to be a
    // separate test secret here - along with the hashlock it left the scheme.
    // WE RETURN EVERYTHING NEEDED AFTER THE DEAL, and nothing extra.
    return {
      escrow: funded.escrow,
      // THE FUNDING TRANSACTION HASH: without it the swap record cannot show what exactly paid for the order, and
      // the run cannot verify that the VERY transaction it saw was paid.
      createHash: (funded && funded.createHash) || null,
      // The salt goes out: it determines the escrow address, and the swap record must keep it, otherwise
      // repeating the order creates a second escrow instead of the previous one.
      salt: (funded && funded.salt) || salt,
      // THE FEE ACTUALLY DEPOSITED OVER THE ORDER AMOUNT: it must be kept - from it the swap record shows how
      // much was actually deposited, and this is the only place where the value is known.
      feeWei: (funded && funded.feeWei) || 0n,
      feeTotalWei: (funded && funded.feeTotalWei) || null,
      feeBps: (funded && funded.feeBps) || 0,
      half: mine.half,
      counterHalf: standIn ? counter.mock.half : null,
      // THE VIEW HALVES: our own and the counterparty's. Without them the address cannot be assembled and the
      // version 3 recovery file cannot be filled in, and without the file the user will not claim the XMR after
      // losing the tab.
      viewHalf: mine.viewHalf,
      commitHalfLocker,
      commitHalfClaimer,
      edPointLocker: mine.pub.ed,
      edPointClaimer: counter.edPub,
      // THE DEPOSITOR'S VIEW POINT goes into the record: without it there is nothing to compare the chain slot
      // edViewPointLocker against before signing - and it is part of the address the claimer will see.
      edViewPointLocker: mine.viewPub,
      // THE COUNTERPARTY'S VIEW HALF: the stand-in has it, a real provider does NOT, and this is a known gap of
      // the protocol, not a trifle: without its view half the shared Monero address cannot be assembled. While
      // the address in the application is built the previous way, the path does not break, but a quote under the
      // order must carry the view point - written in doc 21, D14.3.
      // ONE KIND OF HALF ON THE OUTPUT, and this is not pedantry: the stand-in's half is a number, the provider's
      // arrives as a string, and the consumer (the recovery file and the sweep) must not guess which it was
      // given. Next to the spend half, which is also a number.
      counterViewHalf: standIn ? counter.mock.viewHalf : BigInt(counter.viewHalf),
      counterViewPoint: otherViewPoint,
      // THE SHARED ADDRESS: where the maker sends the XMR. Nobody can spend from it before the half is revealed.
      moneroAddress: joint.address,
      moneroSpendPub: joint.spendPub,
      moneroViewPub: joint.viewPub,
      standIn,
      providerId: providerId || null,
      // THE QUOTE ID IS NEEDED OUTSIDE THE FLOW: the provider node links the created escrow to its own record by
      // it, and only after that can it claim the ETH. Without this link the half stays unclaimed and the node's
      // order_ref is empty (the regular payout does not reach the order).
      quoteId: (quote && quote.id) || null,
    };
  } finally {
    worker.stop();
  }
}

// --- The second half of the order's life: claim or refund ---------------------------------------
//
// Both operations are ordinary transactions in the user's wallet, and both are called ONLY from the interface:
// no automatic claiming of funds, because the secret grants the right to the money.

// The order state is read by a status() call, not from logs - and the previous explanation here was WRONG. It
// claimed that the escrow has a SealedHalf event but no "claimed"/"refunded" events. The contract has NO
// SealedHalf event at all, while the settlement events EXIST: HalfRevealed(bytes32 half, bool byClaimer)
// (ArrakisEscrow.sol:109; the byClaimer flag distinguishes a claim from a refund), OrderTerms (:111-117) and
// Ready (:119). The reason for polling is different, and it is also in the contract:
//   * THE DEPOSIT HAS NO EVENT: the funded flag is set in the constructor together with OrderTerms, so there is
//     no separate "deposited" in the logs, and that is the first of the order's states;
//   * status() (:255-257) exists "for the front end and the watchtower" and returns all four values in one call -
//     funded, claimed, refunded, remainder - by the address already known from the swap record.
// Hence: subscribing to events is the business of whoever keeps the order journal, while the state of a
// particular order is read by a call.
export async function orderStatus(escrow, deps = {}) {
  if (!escrow) throw new SdkError("bad-input", { field: "escrow" });
  // READER SEAM: the caller may bring its own chain read (deps.call), exactly as the actions do. The default is
  // the engine read. The page goes through the bridge, which hands in the wallet's own reader, so the state is
  // read by the same wallet that will sign.
  const call = deps.call || readContract;
  const raw = await call({ to: escrow, data: encodeStatus() });
  return decodeStatus(raw);
}

// THE ORDER DEADLINE IS ONE - t1. Before it the claimer takes the ETH by its half and only with the ready mark
// (:215); from t1 claiming is forbidden (:216), and anyone may refund by PRESENTING THE DEPOSITOR'S HALF
// (:232-235) - the watchtower does not have it, and that limitation is named in doc 24 section 1. The deadline
// is read from the contract: it is immutable and exists only on-chain. It is needed for live deals created
// before we started storing the deadlines ourselves: without reading, the counter would show the time invented by
// the simulator. The contract no longer has t0() (decision 2026-09-16, doc 26).
export async function orderDeadlines(escrow, deps = {}) {
  if (!escrow) throw new SdkError("bad-input", { field: "escrow" });
  // THE SAME READER SEAM AS orderStatus: the deadline must be read by the wallet that will sign, not by a second
  // provider.
  const call = deps.call || readContract;
  const [raw1, rawH, rawReadyBy] = await Promise.all([
    call({ to: escrow, data: encodeT1() }),
    call({ to: escrow, data: encodeTermsHash() }),
    // THE READY-MARK DEADLINE IS READ HERE TOO: without it the screen cannot say that the person is already in
    // the dead zone (the mark is closed, claiming is closed, refunding is not open yet) - and that is exactly
    // where the deal hangs silently.
    call({ to: escrow, data: encodeRead("readyBy") }),
  ]);
  // An empty eth_call response means there is NO CODE at the address: the contract is not deployed. This happens
  // when the createOrder transaction did not go through (for example the wallet rejected it over the fee) while
  // the predicted address is already written into the swap and looks real. This is NOT a call error, and the
  // reason must be named, not "a short response".
  for (const [raw, what] of [[raw1, "t1()"]]) {
    if (String(raw || "").replace(/^0x/, "").length === 0) {
      // NOT A CALL ERROR: the predicted address exists only on paper until the createOrder transaction is
      // confirmed. The refusal names the reason instead of "a short response".
      throw new SdkError("bad-input", { field: "escrow", why: "no-contract" });
    }
  }
  return {
    t1: decodeUint64(raw1, "t1()"),
    // The terms hash from the chain: the recovery file is bound to a particular order by it.
    termsHash: decodeBytes32(rawH, "termsHash()"),
    // readyBy in seconds: the ready-mark boundary, one per order.
    readyBy: decodeUint64(rawReadyBy, "readyBy()"),
  };
}

// THE LIVE ORDER SLOTS: both sides' points and both halves' commitments, READ FROM THE ESCROW rather than taken
// from the swap record. The record is what we thought; the chain is what the order actually is, and before
// signing they must agree.
export async function orderLiveSlots(escrow, deps = {}) {
  // SEAM: the caller decides what reads the chain (`deps.call`), the default is the engine read. It is needed so
  // that the slot check goes through the same wallet as the signature rather than past it.
  const call = deps.call || readContract;
  if (!escrow) throw new SdkError("bad-input", { field: "escrow" });
  const keys = ["edPointLocker", "edPointClaimer", "edViewPointLocker", "commitHalfLocker", "commitHalfClaimer"];
  try {
    const raws = await Promise.all(keys.map((k) => call({ to: escrow, data: encodeRead(k) })));
    const slots = {};
    keys.forEach((k, i) => { slots[k] = decodeBytes32(raws[i], k + "()"); });
    return { slots };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// A REFUSAL BEFORE SIGNING: the on-chain order must hold exactly the points and commitments the page assembled
// and on which the proof agreed. The check costs one read, and without it the signature goes out under an
// unknown order: foreign points mean the shared Monero address was assembled from other halves, and the XMR
// cannot be claimed after settlement. Expectations are mandatory: a check without them verifies nothing, so this
// is an error, not a skip.
export async function assertOrderSlots(escrow, expect, what = "signature", deps = {}) {
  if (!expect) throw new SdkError("bad-input", { field: "expect" });
  const read = await orderLiveSlots(escrow, deps);
  const verdict = liveOrderSlotsVerdict({ slots: read.slots, readError: read.error, expect });
  if (verdict.blocks) throw new SdkError("contract-reverted", { step: what, why: "slots-mismatch" });
  return verdict;
}

// Claim the ETH by the CLAIMER'S half. The field name in the contract is halfClaimer (:213); the former word
// "secret" is a synonym of the same value (the half serves as the preimage of the commitment), while "hashlock"
// lied here: the current contract has NO hashlock field. Instead it has two half commitments -
// commitHalfClaimer and commitHalfLocker (:74-75), and claim compares the half against the first (:217).
// In production this is the second half of the Monero spend key, so claiming and revealing the half are one
// action: the half is published by whoever claims, and it is also obtained by the other side (HalfRevealed, :222).
export async function claimOrder({ escrow, halfClaimer, expect, onStep, deps = {} }) {
  if (!escrow) throw new SdkError("bad-input", { field: "escrow" });
  if (!halfClaimer) throw new SdkError("bad-input", { field: "halfClaimer" });
  // SLOT CHECK BEFORE SIGNING: a claim reveals the half, and it must be revealed in the VERY order whose
  // commitments we know. Beyond this point the decision cannot be undone.
  await assertOrderSlots(escrow, expect, "claim", deps);
  onStep?.("confirm-claim");
  // THE CLAIM GAS LIMIT COMES FROM THE SHARED MODULE, NOT A LITERAL HERE (issue #127): the node lays exactly
  // this limit into the gas gift. It is set explicitly and with a margin: claim has the same trap as order
  // creation - the wallet estimates gas over a state that no longer exists on the chain (the same reason is
  // named in the contract, ArrakisEscrow.sol:137-138), and the call costs tens of thousands of gas.
  const hash = await (deps.send || sendTransaction)({ to: escrow, data: encodeClaim(halfClaimer), gas: CLAIM_GAS_LIMIT });
  return { hash };
}

// Refund after the settlement deadline t1. It requires the DEPOSITOR'S half: the contract compares its hash
// against the commitHalfLocker commitment (:235), publishes it and always sends the money to the depositor
// (:242). Hence a consequence to be aware of: it is not "anyone" who can refund, but whoever holds the
// depositor's half - the depositor itself or whoever it gave it to. The contract does not check the sender
// (:228-231), but the freedom to call is not the freedom to sign: the right to run the transaction is given by
// the half itself.
export async function refundOrder({ escrow, halfLocker, onStep, expect = null, deps = {} }) {
  if (!escrow) throw new SdkError("bad-input", { field: "escrow" });
  if (!halfLocker) throw new SdkError("bad-input", { field: "halfLocker" });
  onStep?.("confirm-refund");
  // THE SLOT CHECK HERE TOO, WHEN EXPECTATIONS ARE GIVEN. A refund REVEALS the half - that is, it is as
  // irreversible as a claim, and signing it under an order whose commitments we have not checked is forbidden
  // for the same reason. Expectations are optional for compatibility with previous calls (the page calls without
  // them); the core always passes them.
  if (expect) await assertOrderSlots(escrow, expect, "refund", deps);
  const hash = await (deps.send || sendTransaction)({ to: escrow, data: encodeRefund(halfLocker), gas: 250_000n });
  return { hash };
}

// Readiness: "I saw the XMR on the shared address, claiming is allowed". Without it the contract FORBIDS
// claiming (:215) - and this is protection, not a formality: the contract does not see Monero and would pay on
// the deadline alone to someone who sent nothing. The party that deposited the ETH sets it, and only after it
// has itself seen the XMR lock. THE MARK WINDOW IS LIMITED, and this matters for the moment of the call: only on
// a funded order, only before readyBy and only once (:200-204). After readyBy without the mark the order closes
// by a refund (decision 30.09.2026): the claim window did not open, so claim is forbidden while refund opens
// immediately. There used to be a dead zone here: neither claim (needs ready) nor refund (needs the deadline)
// would go through.
export async function markReadyOrder({ escrow, expect, onStep, deps = {} }) {
  if (!escrow) throw new SdkError("bad-input", { field: "escrow" });
  // SLOT CHECK BEFORE SIGNING: ready() grants the claimer settlement at its own address, and the grant is given
  // to the VERY order whose points and commitments we have checked. A mark on a foreign order is a signature
  // under what we did not assemble.
  await assertOrderSlots(escrow, expect, "mark-ready", deps);
  onStep?.("confirm-mark-ready");
  const hash = await (deps.send || sendTransaction)({ to: escrow, data: encodeMarkReady(), gas: 120_000n });
  return { hash };
}
