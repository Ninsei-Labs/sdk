// SWAPS: READING STATE AND STARTING.
//
// Here the SDK shows what already lies in storage (the engine's swap records) and starts a new swap. The SDK holds
// the step order of a start, not the interface: guards -> record and recovery file -> the person's confirmation ->
// order and halves -> server -> watching the Monero address. A lock without a recovery file is a lock with nothing
// to open it with if the browser is lost, so the confirmation stands BEFORE anything that locks funds.
import { SdkError } from "./errors.mjs";
import { quoteLifeVerdict } from "./quotePolicy.mjs";
import { SDK_VERSION } from "./version.mjs";
import * as engine from "./engine.mjs";
// The name is NOT `record`: inside start there is a variable with that name, and referencing the module before it
// ran into "Cannot access 'record' before initialization" - a refusal without a code, that is, a breakdown. A check
// showed exactly that.
import * as recordModule from "./record.mjs";
// The order: our own side is built by the engine's builder, the counterparty's side is verified and accepted, and
// the joint address is assembled from the halves. There are no formulas of our own in the core - see order.mjs.
import { buildOwnSideFromHalvesKnown, contextOf, halfHex, norm, normalizeCounterpartyView, orderStepChunked } from "./order.mjs";
// Locking the funds: sending goes through the already-finished step (`lock.send`), the wallet is an adapter from outside.
import * as lock from "./lock.mjs";
import * as flow from "./swap-flow.mjs";
import { fundingReceiptVerdict } from "../engine/evm/funding.js";
import { vmOfChain, legFor } from "./legs/index.mjs";
// THE VIEW HALVES - from the core's primitives: the sum of two halves is the key the wallet sees incoming payments
// with. There is no arithmetic of the core's own here either (see order.mjs) - we use the same halves builder.
import { primitives } from "./primitives.mjs";
import { probeMoneroNode } from "./probes.mjs";
// MARKING READY - A FINISHED STEP, NOT A SECOND IMPLEMENTATION OF IT: it requires the order expectations and checks
// the slots against the chain BEFORE signing (actions.markReady). The watch must call exactly it, otherwise "we saw
// the XMR" and "we allowed the settlement to be taken" would diverge.
import { createActions } from "./actions.mjs";
// THE ONE RECOVERY KEY (sdk#76): the taker's halves come from it, not from a fresh random pair per swap.
import {
  createRecoveryKeyFile, importRecoveryKey, loadRecoveryKey,
  recoveryKeyFileName, recoverySaltOf, saveRecoveryKey,
  newRecoverySalt, takerHalvesV2,
} from "./recovery-key.mjs";
// THE XMR ARRIVAL CHECK ON TWO NODES (issue #85) - IN THE CORE, from the same mirrored rule and block parser.
import * as xmrArrival from "./xmr-arrival.mjs";
// THE MAKER'S DECLINE (issue #40): the escrow's `Declined` event is the decision. The node's `declined` +
// `compliance` status is an observation on the wire, not a second source this file trusts; the detectors and the
// neutral vocabulary live in one module, so this file names the state instead of re-reading either.
import { declineOf, logReaderOf, blockBoundaryOf, DECLINED_TOPIC0, DECLINED_TERMINAL, DECLINED_CODE } from "./decline.mjs";
import { readReadyWindow, readyLeadSec, readyLateSec, readyWindowMs } from "./readyWindow.mjs";
// THE NO-WALLET CLAIM: the seller's half goes to the relay that answered the quote, which sends `claim` for the
// signed tip. This module speaks that one wire; swaps.mjs decides which record may be claimed.
import { relayOriginOf, addressTextOf, halfTextOf, postRelayClaim } from "./relayClaim.mjs";

// THE ENGINE'S SETTLEMENT KINDS -> THE CONTRACT'S CODES: THE KEY IS THE KIND THE ENGINE REALLY WRITES.
//
// The map used to be keyed by names no code path writes - `refunded` for a refund (the engine writes
// `kind: "refund_eth"`), and `xmr_returned` and `closed`, for which no settlement with that kind is written
// anywhere in the engine or in this package. A REFUND therefore never met its key and fell into the fallback:
// get/list/progress told the app `closed` about an order whose ETH was already back in the wallet - the very
// distinction that became load-bearing once the maker's decline was made a state of its own (issue #40).
//
// WHAT CAN BE A KIND, EXHAUSTIVELY. The record's settlement belongs to the engine (engine/core/swap.js, the only
// module that assigns swap.settlement), and `declined` is the one kind written by us (src/decline.mjs):
//   `success`    - the swap completed and the XMR is on the depositor's address (sweepNow and the auto-sweep in the
//                  ticker; the SDK does not take it from a backend session);
//   `refund_eth` - the ETH went back to the depositor. TWO WRITERS, ONE KIND: the person's own refund (refundEth)
//                  and the watchtower inside the ticker both write `kind: "refund_eth"` with the phase
//                  `refunded_eth`, so there is exactly ONE refund-shaped kind here and nothing is collapsed;
//   `declined`   - the maker refused a funded order. Not the engine's: the escrow reads `refunded` either way, so
//                  the engine cannot tell a decline from a refund, and the SDK writes this kind itself when it SEES
//                  the decline (src/decline.mjs). From then on every surface that reads the record reports it
//                  without asking the chain again.
//
// AND WHAT IS NOT A KEY: an unknown kind is named, not invented - it comes out as "closed", the fallback in
// toState below, which is why `closed` is a code here and not a key (no settlement carries that kind; the string
// `closed` in the engine is the XMR SESSION's status vocabulary, not a settlement). The maker taking the XMR back
// without a ready mark is NOT a kind either: it does not end a swap - the depositor's ETH is still in the escrow -
// so it is a PHASE of a live swap (`xmr_reclaimed`, engine/core/swap.js, told apart by that code from the maker who
// never locked), and the swap ends later as `refunded_eth`. `xmr_returned`, which stood in the engine's terminal
// table and in the `TerminalCode` type as a state nothing could produce, is gone with it. Every one of these facts
// is asserted by the `terminal` check rather than left to a reader.
const TERMINAL = {
  success: "success",
  refund_eth: "refunded_eth",
  [DECLINED_TERMINAL]: DECLINED_TERMINAL,
};

const num = (v) => {
  // NULL/UNDEFINED/EMPTY IS NOT ZERO. `Number(null)` is 0, which made every unknown amount look measured as empty;
  // a missing number is a missing fact and the state/interface must see null.
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// THE SERVICE'S NAMED STATE FOR FUNDS THAT ARE ON THE ADDRESS BUT BARRED BY THE TRANSACTION'S unlock_time
// (app/store.mjs, app/watcher.mjs; the rule itself is app/indexer.mjs, unlockStateOf). "Has the XMR arrived" is
// decided by the SERVICE, which alone reads the chain's outputs; the core does NOT re-derive it from the amount -
// it reads THIS state. That is the one rule: the indexer and the wallet path classify unlock_time, and the core
// treats locked funds as not-an-arrival instead of inventing a second rule of its own.
const LOCKED_STATUS = "xmr_locked";

// --- THE "SERVER" STEP: RECORDING THE SWAP WITH US AND WATCHING THE MONERO ADDRESS -------------------
//
// WHAT THIS STEP IS AND WHY AFTER THE LOCK. The funds are already locked (the escrow was created by the factory
// call), but only the browser knows about the swap: until the record reaches the service, the swap list is tied to
// the tab, and nobody notices incoming XMR. So the step consists of two actions, and both are THE SAME REQUESTS the
// current interface makes:
//
//   1) RECORDING: POST /api/evm-swaps, body { id, network, escrow, quoteId, providerId, hashlock, amount, t0, t1 }
//      (www/js/evm/auth.js:111-125, saveServerSwap). Our app accepts it by the template /^\/api\/evm-swaps$/
//      (app/server.mjs:1230) and requires a pass: without Authorization: Bearer *** 401 (app/server.mjs:1232).
//      It checks the escrow address against the CHAIN (locker() versus the address from the pass) - that is, it
//      confirms the record by the chain, not by the client's words.
//   2) WATCHING: POST /api/swaps (address + VIEW KEY + expected amount; www/js/ui/views/confirm.js:581,
//      www/js/core/chainSource.js:178) and then polling GET /api/swaps/{id} (chainSource.js:184). The spend key does
//      not leave and cannot: no one has it until the half is revealed.
//
// WHAT IS DELIBERATELY ABSENT HERE: a waiting policy of its own inside the step. How long to wait for the XMR to
// arrive is the caller's decision, so the watch is exposed as a separate method (`swaps.watch`) with a timeout from
// the configuration.
/**
 * THE VIEW KEY OF THE JOINT ADDRESS - THE SUM OF TWO HALVES. That is how the interface assembles it
 * (www/js/ui/views/confirm.js:559; math - www/js/monero/swapKeys.js, watchViewSeedHex), and only with it does the
 * wallet see incoming payments: the view and spend halves are independent in Monero.
 * Recorded as 64 hex WITHOUT the 0x prefix: the app checks the key by this form (app/store.mjs:74, HEX64).
 */
export function jointViewKey(swap) {
  const e = (swap && swap.escrow) || {};
  if (typeof e.viewHalf !== "string" || !e.viewHalf) throw new SdkError("bad-input", { field: "viewHalf" });
  if (typeof e.counterViewHalf !== "string" || !e.counterViewHalf) throw new SdkError("bad-input", { field: "counterViewHalf" });
  try {
    const halves = engine.halves.createHalves(primitives);
    return halves.combineHalves(BigInt(e.viewHalf), BigInt(e.counterViewHalf)).toString(16).padStart(64, "0");
  } catch { throw new SdkError("bad-input", { field: "viewKey" }); }
}

/**
 * What is visible in the app's watch response. AN EMPTY RESPONSE IS NOT COUNTED AS AN ARRIVAL: it has no receivedXmr
 * field at all, and "the field is absent" and "zero" are different things (zero means "nothing arrived", absence -
 * "not read"). We return null if this is not a watch response at all - emptiness must not be taken for data.
 */
/** Translating the engine's record into the contract state: our names, the engine's meaning. */
export function toState(swap) {
  if (!swap || typeof swap !== "object" || !swap.id) throw new SdkError("bad-input", { field: "swap" });
  const d = engine.swap.derive(swap);
  const steps = [];
  const engineSteps = Array.isArray(d.steps) ? d.steps : [];
  const funded = engineSteps.find((s) => s.key === "funded") || null;
  // THE FIRST STEP IS IN THE CONTRACT BUT NOT IN THE ENGINE: the engine considers the swap already created from the
  // "funded" step. Waiting for payment is a state the interface must show, so we add the step ourselves.
  steps.push({ code: "awaiting_funding", done: !!(funded && funded.done), active: !(funded && funded.done), at: null });
  for (const s of engineSteps) {
    steps.push({
      code: s.key, done: !!s.done, active: !!s.active, failed: !!s.failed,
      // The step time is taken from the record only in the sandbox: in a live swap it is the demonstration time.
      at: d.simulated && d.simulated.evm ? (s.atSim ?? null) : null,
    });
  }
  const active = steps.find((s) => s.active) || [...steps].reverse().find((s) => s.done) || steps[0];
  // THE TERMINAL STATE IS TRANSLATED ONCE, AND THE DECLINE IS READ OFF IT. A declined order is NOT a refunded
  // one, and the difference is drawn here and in the action flags below, not left to the screen.
  const terminal = d.terminal ? (TERMINAL[d.terminal.kind] ?? "closed") : null;
  const declined = terminal === DECLINED_TERMINAL;
  const chain = swap.network || swap.chain || null;
  // The virtual machine is taken from the network registry. An unknown network has none, and "unknown" is more honest
  // than the network's name: it is visible in the state and does not turn into "probably EVM".
  const vm = chain ? (vmOfChain(chain) || "unknown") : "unknown";
  return {
    id: swap.id,
    direction: swap.side === "sell" ? "sell" : "buy",
    // WHAT THE LIST SHOWS, NOT ONLY THE STEPPER (www/js/ui/views/info.js, swapsView). The list needs the date,
    // who gave the price, the human name of the phase and whether the swap is settled - and it must take them
    // from the CORE, not by reaching into the record itself. The names repeat the record's (core/swap.js,
    // createSwap: createdAt, maker, escrow).
    createdAt: swap.createdAt ?? null,
    maker: {
      id: (swap.makerId !== undefined && swap.makerId !== null) ? swap.makerId : ((swap.maker && swap.maker.id) ?? null),
      name: (swap.makerName !== undefined && swap.makerName !== null) ? swap.makerName : ((swap.maker && swap.maker.name) ?? null),
    },
    // THE HUMAN NAME OF THE PHASE IS THE ENGINE'S (derive -> phaseLabel): the words on the screen come from the
    // same place as the state they describe, so they cannot drift apart.
    phase: d.phase || null,
    phaseLabel: d.phaseLabel || null,
    // "LIVE OR SETTLED" IS THE RECORD'S SETTLEMENT, exactly as the screen split it before. It is NOT read from
    // the phase's text: the text is for the person, the flag is for the code.
    settled: !!swap.settlement,
    // WHAT HAS ALREADY MOVED ON THE SWAP - the two signs the removal prompt warns about. Computed HERE from the
    // record: the screen must not reach into it for them.
    funds: {
      // UNKNOWN IS NULL, NOT ZERO. Zero is a measured empty amount; an absent field is a different fact and the
      // interface must be able to show a dash instead of claiming that nothing arrived. The engine's xmrView
      // materialises a zero when it has no session, so the evidence is checked before its `seen`.
      receivedXmr: (swap.xmrSession !== null && swap.xmrSession !== undefined)
        || (swap.xmr && (swap.xmr.received !== undefined || swap.xmr.arrived !== undefined))
        ? num(d.xmrAmount && d.xmrAmount.seen) : null,
      escrowLocked: !!(swap.escrow && (swap.escrow.fundTx || swap.escrow.secret)),
    },
    pay: { token: swap.payToken || "eth", amount: num(swap.payAmount) },
    get: { xmr: num(swap.xmrAmount) },
    step: active.code,
    steps,
    deadlines: {
      readyBy: d.deadlines && d.deadlines.readyBy !== undefined ? num(d.deadlines.readyBy) : null,
      t1: d.deadlines && d.deadlines.t1 !== undefined ? num(d.deadlines.t1) : null,
    },
    xmr: {
      confirmations: num(d.xmr && (d.xmr.confirmations !== undefined ? d.xmr.confirmations : d.conf)) ?? 0,
      target: num(d.xmr && d.xmr.confTarget) ?? num(d.confTarget) ?? 0,
      txid: (d.xmr && Array.isArray(d.xmr.txids) && d.xmr.txids[0]) || null,
      amount: {
        expected: d.xmrAmount ? d.xmrAmount.expected ?? null : null,
        seen: d.xmrAmount ? d.xmrAmount.seen ?? null : null,
      },
    },
    counterparty: {
      chain,
      vm,
      // The address of whatever secures the leg. While there is none - null, not an empty string: the interface must
      // distinguish "not created yet" from "created, but the address was not read".
      leg: (swap.escrow && (swap.escrow.address || swap.escrow.leg)) || null,
      status: d.phase || null,
      txs: (swap.escrow && (swap.escrow.txids || swap.escrow.txs)) || [],
    },
    // A DECLINED ORDER OFFERS NOTHING, AND THAT IS THE POINT OF THE STATE (issue #40). The ETH - the fee
    // included - is already back in the depositor's wallet and no half was revealed, so there is no ready mark to
    // place, no XMR to sweep and NO REFUND TO SIGN: the flags are OFF rather than left to whatever the engine's
    // `can` says about an order whose escrow merely reads `refunded`. The app needs no second source for "there
    // is nothing to do": this state plus the terminal code says it.
    actions: declined
      ? { markReady: false, sweep: false, refund: false }
      : { markReady: !!(d.can && d.can.ready), sweep: !!(d.can && d.can.sweep), refund: !!(d.can && d.can.refund) },
    simulated: { evm: !!(d.simulated && d.simulated.evm), xmr: !!(d.simulated && d.simulated.xmr) },
    terminal,
  };
}

// A PASSPHRASE SHORTER THAN THIS IS NOT ACCEPTED: a file with a weak passphrase is a file strangers will open.
const MIN_PASSPHRASE = 12;

// The record fields are taken from the request: what exactly the person changes is set by the interface, not the core.
// A FIXED DEFECT: the record lost WHERE TO WITHDRAW XMR AND WHAT IT OWES. `receiveTo` and the quote data (maker, fee,
// signature, rate) were not carried into the record at all, so the progress screen - which reads EXACTLY the record -
// knew neither the withdrawal address nor the maker, and exporting the recovery file from that screen went out with an
// empty address. The record fields stay the same as the engine's (core/swap.js, createSwap): the field name is
// `receiveAddress`.
// Exported for the relay/record seam check: the function is the only place that decides which amount reaches
// the arrival check, and a unit test of createRecord alone cannot see that decision.
export const recordInputOf = (request, xmrNetwork = null) => {
  const quote = request && request.quote && typeof request.quote === "object" ? request.quote : {};
  const pass = (v) => (v === undefined || v === null || v === "" ? undefined : v);
  const orderAtomic = request && request.order && request.order.xmrAmount !== undefined && request.order.xmrAmount !== null
    ? String(request.order.xmrAmount) : null;
  const quoteAtomic = request && request.orderQuote && request.orderQuote.xmrAmount !== undefined && request.orderQuote.xmrAmount !== null
    ? String(request.orderQuote.xmrAmount) : null;
  if (orderAtomic !== null && quoteAtomic !== null && orderAtomic !== quoteAtomic) {
    throw new SdkError("bad-input", { field: "xmrAmount", why: "order-vs-quote" });
  }
  return {
    side: request.side || "buy",
    network: quote.chain ? quote.chain : undefined,
    // THE RECORD'S MONERO NETWORK COMES FROM THE INSTANCE, NOT THE DEMO CONSTANT. A testnet instance that recorded
    // stagenet made the recovery file and the start-height probe disagree with the node it was configured for.
    moneroNetwork: request.moneroNetwork || xmrNetwork || undefined,
    payToken: quote.asset ? String(quote.asset).toLowerCase() : undefined,
    payAmount: quote.amount !== undefined ? quote.amount : undefined,
    xmrAmount: quote.size !== undefined ? quote.size : undefined,
    // THE SIGNED INTEGER, NOT THE DISPLAY NUMBER. `quote.size` is a rounded view of the XMR amount; the signed
    // order's `xmrAmount` is the exact atomic value the maker will pay, and the arrival check compares that one.
    // THE SIGNED FIGURE, NEVER A DISPLAY ONE. The firm path puts the quote's signed `xmrAmount` on the order it
    // returns; a bare `quote.size` is a rounded screen number and must not reach the arrival check.
    expectedAtomic: quoteAtomic !== null ? quoteAtomic : (orderAtomic !== null ? orderAtomic : undefined),
    // THE ORDER-QUOTE ID IS PART OF THE RECORD, NOT A DETAIL OF THE SCREEN (a defect found): our service uses it to
    // tie the created escrow to the provider node's record, and without it the node cannot take the ETH
    // (sdk/src/swap-flow.mjs: quoteId: quote.id -> swap.orderQuoteId).
    orderQuoteId: pass(quote.id),
    // THE PENDING-FUNDING IDENTITY. A retry without the relay answer still has to prove that the record it found
    // belongs to the same order; the salt alone is not enough, so the chain, the factory and the predicted escrow
    // are stored beside it.
    chainId: pass((request.order && request.order.chainId) ?? (request.orderQuote && request.orderQuote.chainId)),
    factory: pass((request.order && request.order.factory) ?? (request.orderQuote && request.orderQuote.factory)),
    // WHERE TO WITHDRAW XMR: part of the record, not a detail of the screen - the progress screen exports the file by it.
    receiveAddress: pass(request.receiveTo),
    // WHAT THE PERSON SAW: the maker, its spread, the fee, the rate and the quote signature. Screen data, but it must
    // live in the record - otherwise the progress screen shows an empty maker instead of whoever gave the price.
    makerId: pass(quote.makerId), makerName: pass(quote.makerName), makerSpread: pass(quote.makerSpread),
    quoteSignature: pass(quote.signature), fee: pass(quote.ninseiFee),
    dexSpread: pass(quote.dexSpread), gasUsd: pass(quote.gasUsd), rate: pass(quote.rate),
  };
};

// createRecord is the start step that requires a Monero wallet IN THE BROWSER (creating the wallet and the order of
// the halves). It arrives from outside, so the whole path after it (building the file, encryption, the person's
// confirmation) is written and checked already now, rather than appearing together with the browser part.
/**
 * The Monero height a swap starts at, measured from the configured nodes. Exported for the guard, not as a
 * package entry: the start is the only production caller. A node that answers on another network is not a height
 * for this deal, and a missing answer is a named refusal, never a scan from zero.
 */
export async function startHeightFromNodes({ nodes = [], network = null, fetchImpl = globalThis.fetch } = {}) {
  const urls = (Array.isArray(nodes) ? nodes : [])
    .map((entry) => typeof entry === "string" ? entry : entry && entry.url).filter(Boolean);
  const answers = await Promise.all(urls.map(async (url) => {
    try { return await probeMoneroNode({ url, fetchImpl }); }
    catch { return { ok: false, why: "unreachable" }; }
  }));
  const good = answers.filter((answer) => answer.ok === true && (!network || answer.network === network));
  if (good.length) {
    // A LAGGING NODE MUST NOT HIDE THE TRANSFER. The scan starts at the OLDEST height any good witness reports, so
    // a node that answers too high cannot move the walk past the arrival. A large spread means the witnesses do not
    // agree on the chain: refuse the measurement instead of choosing one and calling it the chain's height.
    const heights = good.map((answer) => Number(answer.height)).filter((height) => Number.isSafeInteger(height) && height >= 0);
    if (!heights.length) throw new SdkError("xmr-no-nodes", { step: "restore-height", network: network || null, why: "no-height" });
    const low = Math.min(...heights);
    const high = Math.max(...heights);
    if (high - low > 100) throw new SdkError("xmr-no-nodes", { step: "restore-height", network: network || null, why: "disagree", low, high });
    return low;
  }
  const why = answers.find((answer) => answer.ok === true) ? "network" : (answers[0] && answers[0].why) || "no-node";
  throw new SdkError("xmr-no-nodes", { step: "restore-height", network: network || null, why });
}

// THE SELL WAIT MUST OUTLIVE THE READY DEADLINE. The old fixed 20-minute wait equalled the mean time of ten
// Monero blocks, so about half of honest sales expired before `ready`. A caller may set an explicit timeout;
// otherwise the configured wait is extended to cover the remaining time to `readyBy` plus one confirmation margin.
const SELL_WATCH_MARGIN_SEC = 300;
export function sellWatchTimeoutMs({ configuredMs = 1_200_000, readyBySec = null, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const configured = Number.isFinite(Number(configuredMs)) && Number(configuredMs) > 0 ? Number(configuredMs) : 1_200_000;
  const readyAt = Number(readyBySec);
  const now = Number(nowSec);
  if (!Number.isSafeInteger(readyAt) || !Number.isSafeInteger(now) || readyAt <= now) return configured;
  return Math.max(configured, (readyAt - now + SELL_WATCH_MARGIN_SEC) * 1000);
}

// A PENDING FUNDING IS RESUMED ONLY FOR THE SAME ORDER, NOT MERELY THE SAME NONCE. The quote nonce is the maker's
// value and a second offer can reuse it. The identity is the client's salt together with the chain, the factory and
// the predicted escrow: those four values are the order the record was built for. A record that names no predicted
// escrow cannot prove it is the same order and is not resumed.
const pendingSalt = (value) => String(value === undefined || value === null ? "" : value).replace(/^0x/i, "").toLowerCase();
const pendingAddress = (value) => String(value === undefined || value === null ? "" : value).replace(/^0x/i, "").toLowerCase();
function pendingFundingIdentity(swap) {
  const escrow = swap && swap.escrow && typeof swap.escrow === "object" ? swap.escrow : {};
  const order = swap && swap.order && typeof swap.order === "object" ? swap.order : {};
  const quote = swap && swap.quote && typeof swap.quote === "object" ? swap.quote : {};
  return {
    salt: pendingSalt(escrow.salt ?? (swap && swap.recoverySalt)),
    chainId: Number(order.chainId ?? quote.chainId ?? (swap && swap.chainId) ?? escrow.chainId),
    factory: pendingAddress(order.factory ?? quote.factory ?? (swap && swap.factory) ?? escrow.factory),
    escrow: pendingAddress(escrow.address ?? (swap && swap.predictedEscrow)),
  };
}

// THE PENDING ROW CAN BE FOUND WITHOUT ITS ESCROW. A reloaded retry has the salt, chain and factory, but it has
// no request escrow; the address must be predicted from the signed quote before the row can prove it is the same
// order. This base match only selects a row that *might* be resumed; it never authorises a send.
function samePendingBase(swap, identity = {}) {
  if (!swap || !(swap.fundingPending === true || (swap.escrow && swap.escrow.fundingPending === true))) return false;
  const recorded = pendingFundingIdentity(swap);
  const wanted = {
    salt: pendingSalt(identity.salt),
    chainId: Number(identity.chainId),
    factory: pendingAddress(identity.factory),
  };
  if (!wanted.salt || !wanted.factory || !Number.isSafeInteger(wanted.chainId) || wanted.chainId <= 0) return false;
  // Records written before the identity gained chain/factory still have the salt. They may be matched on what they
  // have, but the caller still has to name the same predicted address; a partial record is never a free pass.
  if (recorded.salt !== wanted.salt) return false;
  if (recorded.factory && recorded.factory !== wanted.factory) return false;
  if (Number.isSafeInteger(recorded.chainId) && recorded.chainId > 0 && recorded.chainId !== wanted.chainId) return false;
  return true;
}

export function samePendingFunding(swap, identity = {}) {
  if (!swap || !(swap.fundingPending === true || (swap.escrow && swap.escrow.fundingPending === true))) return false;
  const recorded = pendingFundingIdentity(swap);
  const wanted = {
    salt: pendingSalt(identity.salt),
    chainId: Number(identity.chainId),
    factory: pendingAddress(identity.factory),
    escrow: pendingAddress(identity.escrow),
  };
  if (!wanted.salt || !wanted.factory || !wanted.escrow || !Number.isSafeInteger(wanted.chainId) || wanted.chainId <= 0) return false;
  if (recorded.salt !== wanted.salt || recorded.escrow !== wanted.escrow) return false;
  // A RECORD WRITTEN BEFORE THE IDENTITY FIELDS STILL HAS ONE OPINION: its salt and its escrow address. Missing
  // chain/factory fields are wildcards only for that old shape; a record that carries them must match them exactly.
  if (Number.isSafeInteger(recorded.chainId) && recorded.chainId > 0 && recorded.chainId !== wanted.chainId) return false;
  if (recorded.factory && recorded.factory !== wanted.factory) return false;
  return true;
}

/**
 * WHAT A PENDING RECORD MEANS FOR THIS START.
 * `salt-required` is the expensive branch made loud: a caller that knows only the nonce of a pending record cannot
 * prove it is the same order, and falling through would build a second deposit. The caller must bring the full
 * identity (salt, chain, factory, predicted escrow), not guess.
 */
export function pendingFundingVerdict(swap, identity = {}) {
  const pending = Boolean(swap && (swap.fundingPending === true || (swap.escrow && swap.escrow.fundingPending === true)));
  if (!pending) return "not-pending";
  const salt = pendingSalt(identity.salt);
  const quoteId = String(identity.quoteId === undefined || identity.quoteId === null ? "" : identity.quoteId);
  if (!salt) {
    // THE QUOTE ID CAN SELECT THE RECORD, BUT IT CANNOT PROVE THE ORDER. Only a record that the caller named by the
    // same quote id is this branch; an unrelated pending record must not block a new start.
    return !quoteId || String(swap.orderQuoteId || "") === quoteId ? "salt-required" : "different";
  }
  return samePendingFunding(swap, identity) ? "resume" : "different";
}

// THE RECORD OF A SALE, FOUND BY ITS ESCROW. `sellWatch` is called from a reloaded page with the address in hand,
// so the window stored by `startSell` must be readable without a second argument. A record the store cannot read
// is not a reason to invent a local window; the caller gets the store's refusal at the point it matters.
function swapByEscrow(store, escrow) {
  try {
    const state = store.loadState();
    const wanted = String(escrow || "").toLowerCase();
    for (const swap of Object.values((state && state.swaps) || {})) {
      if (swap && swap.escrow && String(swap.escrow.address || "").toLowerCase() === wanted) return swap;
    }
  } catch { /* the caller names the missing window */ }
  return null;
}

export function createSwaps({ preflight, createRecord, mode = null, xmrNetwork = null, call = null, fetchImpl = null, now = null, sleep = null, evmBlock = null, store = engine.store,
  // THE MONERO TIMINGS ARE BROUGHT BY THE CONFIGURATION: the watch's rate and timeout live in config.limits. There is
  // no server step and no route table to consult.
  config = null,
  // THE INTERFACE'S ADDRESS DENYLIST (issue #16), a Set of lower-cased addresses already assembled by the facade.
  // The check on the ACTUAL sender is done in start() below, ONE place, right before the send - the wallet adapter
  // only HANDS OUT the current account (`address()`), it does not carry the policy.
  denylist = null,
  watch: watchOptions = null,
  // THE CHAIN LOG READER FOR THE DECLINE CHECK (issue #40). A seam, as the chain read is: by default the logs are
  // read through the page's wallet (`readDeclinedLogs`), and from outside a caller brings its own
  // ({ address, topics, fromBlock, toBlock }) -> logs. It is a READ of the escrow's own event, not a node
  // substitution - the address is the escrow of the swap being watched.
  logs: chainLogs = null } = {}) {
  // WHAT READS THE CHAIN AT THE LOCK IS A SEAM, as in actions.mjs: by default the engine's read, from outside you can
  // substitute your own. Otherwise the lock step could not be checked beyond predicting the address - and "the address
  // from the receipt" would remain an argument on trust, not a verified property.
  const reader = typeof call === "function" ? call : engine.evm.readContract;
  // A RELOADED RETRY DOES NOT CARRY THE ESCROW. It still carries the signed order quote and the order terms, so the
  // same factory predict() the send would use can name the address before the pending row is compared. A missing
  // quote or a failed read is a refusal by name, never permission to send a second deposit.
  const predictedEscrowForRetry = async (request) => {
    const quote = request && request.orderQuote;
    const order = request && request.order;
    if (!quote || typeof quote !== "object" || !quote.signature) return null;
    const factory = (order && order.factory) || quote.factory;
    if (!factory) return null;
    const lockerHalf = {
      commitHalfLocker: (order && order.commitHalfLocker) ?? quote.commitHalfLocker,
      edPointLocker: (order && order.edPointLocker) ?? quote.edPointLocker,
      edViewPointLocker: (order && order.edViewPointLocker) ?? quote.edViewPointLocker,
    };
    if (!lockerHalf.commitHalfLocker || !lockerHalf.edPointLocker || !lockerHalf.edViewPointLocker) return null;
    try {
      const raw = await reader({ to: factory, data: engine.evm.encodePredict({ ...quote, ...lockerHalf, factory }) });
      return engine.evm.decodeAddress(raw);
    } catch {
      return null;
    }
  };
  // THE INSTANCE TRANSPORT IS THE DEFAULT, NOT BACKGROUND MAGIC. A per-call `fetch` still wins; otherwise every
  // network read made by this client (height probes, relay quote/claim, witness verification) uses `fetchImpl`.
  const withDefaultFetch = (request) => (fetchImpl && request && typeof request === "object"
    && typeof request.fetch !== "function" ? { ...request, fetch: fetchImpl } : request);
  // THE SLOT CLOCK IS A SEAM. A real caller uses wall time and a timer; a check can advance both, so a 15-30 s
  // slot is exercised without making the suite wait for it.
  const clockMs = () => {
    const value = typeof now === "function" ? Number(now()) : Date.now();
    return Number.isFinite(value) ? value : Date.now();
  };
  const sleepFor = typeof sleep === "function" ? sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // ONE BLOCK FOR THE SELL GATE. A block read is a seam like the contract read: `evmBlock` from the interface
  // wins, then the wallet's own provider. The number pins every escrow read below to the same state; the
  // timestamp is the chain's clock, not the device's.
  const chainSnapshot = async (wallet = null) => {
    let block = null;
    if (typeof evmBlock === "function") {
      block = await evmBlock("latest");
    } else if (wallet && typeof wallet.driver === "function") {
      const provider = wallet.driver();
      if (provider && typeof provider.request === "function") {
        const tag = await provider.request({ method: "eth_blockNumber" });
        if (typeof tag === "string" && /^0x[0-9a-f]+$/i.test(tag)) {
          block = await provider.request({ method: "eth_getBlockByNumber", params: [tag, false] });
        }
      }
    }
    const number = block && Number(block.number);
    const timestamp = block && Number(block.timestamp);
    if (!Number.isSafeInteger(number) || number < 0 || !Number.isFinite(timestamp) || timestamp <= 0) return null;
    return { blockTag: "0x" + number.toString(16), timestamp };
  };
  // THE SAME RULE FOR THE LOGS: one reader per facade, chosen once.
  const logReader = logReaderOf(chainLogs);
  // MARKING READY GOES THROUGH THE SAME READ SEAM as the lock: checking the slots and signing must go one way,
  // otherwise part of the check goes past the wallet and part does not (see actions.mjs).
  const actions = createActions({ call: typeof call === "function" ? call : null });
  const limitOf = (name, fallback) => {
    const value = config && config.limits ? config.limits[name] : null;
    return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  };

  // THE MONERO HEIGHT A SWAP STARTS AT. It is measured before the recovery data is handed over: a file without
  // it scans Monero from block zero, and a watch opened at an EVM block sees nothing. The node must name the same
  // network as the swap; a different network is not a height for this deal.
  async function measuredStartHeight(request, moneroNetwork) {
    const explicit = Number(request.restoreHeight);
    if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
    const listed = Array.isArray(request.xmrNodes) ? request.xmrNodes
      : (config && typeof config.nodesFor === "function" ? config.nodesFor(moneroNetwork) : []);
    return startHeightFromNodes({ nodes: listed, network: moneroNetwork,
      fetchImpl: request.fetchImpl || fetchImpl || (typeof fetch === "function" ? fetch : null) });
  }
  const records = () => {
    const state = store.loadState();
    const all = Object.values((state && state.swaps) || {}).filter((s) => s && s.id);
    return all.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  };
  // A START THAT ENDED WITH A SENT TRANSACTION AND NO RECEIPT IS RESUMED, NOT RESENT. The transaction hash and the
  // predicted escrow are kept on the record; a retry of the same quote reads that receipt instead of building a
  // second side and sending a second deposit.
  const pendingFundingOf = (identity) => {
    const salt = pendingSalt(identity && identity.salt);
    const quoteId = String(identity && identity.quoteId !== undefined && identity.quoteId !== null ? identity.quoteId : "");
    // WITHOUT EITHER HANDLE NOTHING CAN SELECT A RECORD. With a quote id the loop below can still name the record and
    // refuse it as salt-required instead of silently starting a second deposit.
    if (!salt && !quoteId) return null;
    for (const swap of records()) {
      const verdict = pendingFundingVerdict(swap, identity);
      if (verdict === "salt-required") {
        throw new SdkError("bad-input", { field: "recoverySalt", why: "required-for-pending-funding" });
      }
      if (verdict === "resume") return swap;
    }
    return null;
  };
  async function resumePendingFunding(record, request) {
    const swap = record.swap || record;
    const escrowRecord = swap.escrow && typeof swap.escrow === "object" ? swap.escrow : {};
    const txHash = escrowRecord.fundTx || swap.fundTx || null;
    // THE RECEIPT IS A HANDLE, NOT THE ONLY SOURCE OF TRUTH. A Safe over WalletConnect, a sped-up transaction or
    // a provider that lost the receipt can hide a funded escrow; the predicted address is already on the record,
    // so its own status() is asked before the start is left pending forever. A failed read is not "not funded".
    let onChain = null;
    if (escrowRecord.address) {
      try { onChain = await flow.orderStatus(escrowRecord.address, { call: reader }); }
      catch (error) {
        // AN EMPTY status() ANSWER IS A SUCCESSFUL READ OF AN ADDRESS WITH NO CONTRACT, not an unreadable chain.
        // Anything else leaves `onChain` null and the record pending: a failed read must never authorise a resend.
        if (/short .*status\(\)/.test(String((error && error.message) || error))) onChain = { isFunded: false, absent: true };
        else onChain = null;
      }
    }
    // A PROCESS THAT DIED BETWEEN THE PRE-SEND RECORD AND THE WALLET CALL LEFT "not-sent" BEHIND. The chain was
    // read and the escrow is not funded, so no transaction can be in flight: clear the mark and let the caller
    // build the same salt/address again. If the read failed, the record stays pending - never resend blind.
    if (!txHash && onChain && !onChain.isFunded && escrowRecord.fundingReason === "not-sent") {
      delete swap.fundingPending;
      swap.escrow = { ...escrowRecord, fundingPending: false, fundingReason: "send-not-started" };
      try { engine.swap.saveSwap(swap, store); }
      catch { throw new SdkError("storage-unavailable", { step: "save-pending" }); }
      return null;
    }
    if (!txHash && !(onChain && onChain.isFunded)) {
      return { id: swap.id || null, escrow: escrowRecord.address || null,
        address: (record.swapWallet && record.swapWallet.address) || null,
        step: "funding-pending", txHash: null, reason: "no-transaction-hash", next: "receipt" };
    }
    const wallet = request.wallet;
    let receipt = null;
    if (txHash && wallet && typeof wallet.receipt === "function") {
      try { receipt = await wallet.receipt(txHash); } catch { receipt = null; }
    }
    const order = request.order && typeof request.order === "object" ? request.order : {};
    const verdict = fundingReceiptVerdict(receipt, {
      factory: order.factory || (request.orderQuote && request.orderQuote.factory) || null,
      expectedEscrow: escrowRecord.address || null,
    });
    if (verdict.status === "reverted") throw new SdkError("contract-reverted", { step: "funding" });
    if (verdict.status === "funded" || (onChain && onChain.isFunded)) {
      const escrow = verdict.status === "funded" ? verdict.escrow : escrowRecord.address;
      if (!escrow) throw new SdkError("funding-pending", { reason: "no-escrow-address" });
      swap.escrow = { ...escrowRecord, address: escrow, fundingPending: false,
        evmBirthBlock: Number(verdict.birthBlock) > 0 ? Number(verdict.birthBlock) : (escrowRecord.evmBirthBlock ?? null) };
      delete swap.fundingPending;
      try { engine.swap.saveSwap(swap, store); } catch { throw new SdkError("storage-unavailable", { step: "save-escrow" }); }
      return { id: swap.id || null, escrow,
        address: (record.swapWallet && record.swapWallet.address) || null,
        step: "xmr-incoming", next: "watch" };
    }
    return { id: swap.id || null, escrow: escrowRecord.address || null,
      address: (record.swapWallet && record.swapWallet.address) || null,
      step: "funding-pending", txHash, reason: verdict.reason || "no-receipt", next: "receipt" };
  }

  // THE GUARDS' DATA: what the core knows itself (the network, the order amount, the token allowance) plus the balance
  // read by THE SAME wallet the lock will be signed with. Here too - a refusal WITH A CODE where there is no data at
  // all (order terms or an amount in them): silently handing a guard an empty value means hearing "the amount is
  // unknown" about a quantity that is simply not in the request.
  async function guardOptionsOf(request) {
    // NOT A SINGLE REFUSAL HERE UNTIL THE GUARDS ARE ASKED. The absence of order terms is NOT a reason to refuse before
    // the guards: the start order is held by their precedence (see the check "a guard's refusal stops the swap with its
    // own code"). If the data is absent, a guard will say "not checked" and not lock, and the next step will name the
    // missing field (contextOf -> bad-input { field: "order" }). No "the amount is unknown" about a quantity simply not
    // in the request: the amount is taken from the terms, and if they are absent - the refusal names EXACTLY the terms.
    const order = request.order && typeof request.order === "object" ? request.order : {};
    const amountWei = order.amount;
    const wei = amountWei === undefined || amountWei === null || amountWei === "" ? null : String(amountWei);
    const chainId = Number(order.chainId);
    const chain = Number.isFinite(chainId) ? engine.config.chainByChainId(chainId) : null;
    // tokensOf EXPECTS THE NETWORK ID (slug), NOT a chainId: a passed chainId matches no record, and the registry
    // silently returns the tokens of the DEFAULT NETWORK (www/js/core/config.js, chainById -> DEFAULT_CHAIN).
    const tokens = chain ? engine.config.tokensOf(chain.id) : [];
    const payId = String((request.quote && (request.quote.token || request.quote.asset)) || "").toLowerCase();
    const payToken = tokens.find((t) => String(t.symbol).toLowerCase() === payId) || null;
    const nativeToken = tokens.find((t) => !t.address) || null;
    const tokenIsNative = !!(payToken && !payToken.address);
    const options = {
      tokenIsNative,
      // A STAND-IN OR A LIVE COUNTERPARTY - THE CALLER KNOWS. If there is no side, a stand-in will build it exactly in
      // a mode other than live, and the guard must see that rather than consider the swap real.
      standIn: !request.counterparty && mode !== "live",
      // A PRODUCTION NETWORK - BY THE REGISTRY'S RULE (escrow.mode === "live" and no testnet marker), the same as the
      // page's. false means "a stand-in is allowed here", not "we did not check".
      liveChain: !!(chain && chain.escrow && chain.escrow.mode === "live" && !chain.testnet),
    };
    // THE ORDER AMOUNT - IN WEI AND ONLY IT: for the amount-coverage guards the quantity is one. No amount - the field
    // will be absent entirely (the guard honestly says "not measured"), not a substituted number.
    if (wei !== null) { options.payAmountWei = wei; options.requiredNativeWei = wei; }
    // THE BALANCE IS READ BY THE LOCK'S WALLET. The core keeps no path into the chain of its own: we take the same seam
    // as `wallet.balances` (the leg driver) and read exactly the needed tokens. Not read - we leave null: the guard
    // will call it a code (balance-unchecked), and substituting zero is forbidden (zero is an empty wallet).
    try {
      const wallet = request.wallet;
      const driver = wallet && typeof wallet.driver === "function" ? wallet.driver() : null;
      const address = wallet && typeof wallet.address === "function" ? await wallet.address() : null;
      const leg = legFor("evm");
      const idOf = (t) => String(t.symbol).toLowerCase();
      const wanted = [];
      if (nativeToken) wanted.push({ id: idOf(nativeToken), symbol: nativeToken.symbol, decimals: nativeToken.decimals, address: null });
      if (payToken && payToken.address) wanted.push({ id: idOf(payToken), symbol: payToken.symbol, decimals: payToken.decimals, address: payToken.address });
      if (driver && address && leg && typeof leg.balances === "function" && wanted.length) {
        const read = await leg.balances({ driver, address, tokens: wanted });
        const pick = (token) => { const hit = token ? read.find((b) => b.token === idOf(token)) : null; return hit && hit.amount !== null ? hit.amount : null; };
        const nativeWei = nativeToken ? pick(nativeToken) : null;
        if (nativeWei !== null) options.nativeBalanceWei = nativeWei;
        const payWei = tokenIsNative ? nativeWei : pick(payToken);
        if (payWei !== null) options.payBalanceWei = payWei;
      }
    } catch { /* not read - the guard will name the field itself; silently considering the balance sufficient is not allowed */ }
    return options;
  }

  // A SELL SENDS XMR ONLY INTO AN ESCROW THE CHAIN ALREADY HOLDS. The relay answer proves the maker signed the
  // terms; it does not prove that the maker funded them. Read the escrow itself (code, status, slots and
  // deadlines), compare the slots with the halves this offer verified, and refuse before `send-xmr`.
  async function sellEscrowGate(escrow, expect, wallet = null) {
    if (!escrow || !expect) throw new SdkError("bad-input", { field: "escrow" });
    let snapshot = null;
    try { snapshot = await chainSnapshot(wallet); }
    catch (e) { throw new SdkError("quote-refused", { step: "send-xmr", why: "block-unreadable" }); }
    // Compatibility with a caller that has neither a wallet nor a block seam: the reads still go to `latest`,
    // and the deadline falls back to the documented `now` seam. A live sell carries one of the two.
    const gate = { call: reader, blockTag: snapshot ? snapshot.blockTag : "latest" };
    const chainNow = snapshot ? snapshot.timestamp : Math.floor((typeof now === "function" ? now() : Date.now()) / 1000);
    let status = null;
    try { status = await flow.orderStatus(escrow, gate); }
    catch (e) { throw new SdkError("quote-refused", { step: "send-xmr", why: "escrow-unreadable" }); }
    if (!status || status.isFunded !== true || status.isClaimed === true || status.isRefunded === true) {
      throw new SdkError("quote-refused", { step: "send-xmr", why: "escrow-not-open" });
    }
    let deadlines = null;
    try { deadlines = await flow.orderDeadlines(escrow, gate); }
    catch (e) { throw new SdkError("quote-refused", { step: "send-xmr", why: "deadline-unreadable" }); }
    if (Number(deadlines.readyBy) !== Number(expect.readyBy) || Number(deadlines.t1) !== Number(expect.t1)) {
      throw new SdkError("quote-refused", { step: "send-xmr", why: "terms-mismatch" });
    }
    // Leave time for the XMR to be sent and confirmed before the maker's ready mark closes. The lead follows the
    // confirmation setting; an explicit `limits.sellReadyLeadSec` can override it for a stand.
    const confirmations = Math.max(1, Number(limitOf("xmrConfirmations", 10)));
    const blockTimeSec = Math.max(1, Number(limitOf("xmrBlockTimeSec", 120)));
    const configuredLead = Number(limitOf("sellReadyLeadSec", 0));
    const leadSec = Number.isFinite(configuredLead) && configuredLead > 0 ? configuredLead : confirmations * blockTimeSec;
    if (chainNow + leadSec >= Number(deadlines.readyBy)) {
      throw new SdkError("quote-refused", { step: "send-xmr", why: "deadline-too-close" });
    }
    try { await flow.assertOrderSlots(escrow, expect, "send-xmr", gate); }
    catch (e) {
      if (e && e.code === "contract-reverted") throw e;
      throw new SdkError("quote-refused", { step: "send-xmr", why: "slots-unreadable" });
    }
  }

  return {
    // list/get DO NOT ASK THE NETWORK: the state lies in storage, and after a page reload the interface raises the swaps
    // from it, not from memory.
    async list() { return records().map(toState); },
    async get(id) {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      const found = records().find((s) => s.id === id);
      return found ? toState(found) : null;
    },

    /**
     * THE DEAL-PROGRESS SNAPSHOT. The progress screen shows one swap live: which steps are done, how many Monero
     * confirmations are left, what is allowed now, when the refund opens, what the Monero leg is doing - plus the
     * record's own facts (the escrow, the maker, the amounts, the one-time address, the destination). ALL of it is
     * assembled HERE: the record is read (engine.swap.getSwap), the state is DERIVED by the core
     * (engine.swap.derive) and the wallet is rebuilt from the halves (engine.swap.halvesWalletOf). The screen only
     * draws this snapshot - it no longer reads the record or derives the state itself, so there is one
     * implementation of the deal's rules instead of two.
     *
     * `null` means "there is no such record" - it is NOT an empty state.
     */
    async progress(id) {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      const swap = engine.swap.getSwap(id, store);
      if (!swap) return null;
      return {
        id: String(swap.id || id),
        // THE RECORD'S OWN FIELDS. The screen shows them and hands the escrow back as the order expectations for a
        // live action (markReady/claim/refund), so they travel as they are - no second copy of the record.
        swap,
        // THE WALLET REBUILT FROM THE HALVES: the recovery file is assembled from it, and the half-of-the-key rule
        // stays the engine's (halvesWalletOf), not a second reading on the screen.
        swapWallet: engine.swap.halvesWalletOf(swap),
        // THE DERIVED DEAL VIEW: the phase, the allowed actions, the deadlines, the steps, the Monero leg and the
        // amounts. The field names are the engine's (derive) - one source for the state and the words about it.
        view: engine.swap.derive(swap),
      };
    },

    /**
     * THE DEMONSTRATION RECORD'S ACTIONS (mode "sim"): confirming readiness, refunding the ETH, sweeping the XMR.
     * In a LIVE swap the same steps go through `actions` (a real escrow and the wallet adapter); here they are the
     * sandbox's record mutations, kept in ONE place instead of on the screen.
     */
    async confirmReady(id) {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      return engine.swap.confirmReady(id, store);
    },
    async refundEth(id, by = "you") {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      return engine.swap.refundEth(id, by, store);
    },
    async sweepNow(id) {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      return engine.swap.sweepNow(id, store);
    },

    /**
     * WHERE TO WITHDRAW THE XMR. Sets the record's `receiveAddress` and saves it: the destination is part of the
     * recovery file, so the change is WRITTEN (named), not inferred. The order and the chain are untouched.
     * `null` - there is no such record.
     */
    async setDestination(id, address) {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      if (typeof address !== "string" || !address) throw new SdkError("bad-input", { field: "address" });
      const swap = engine.swap.getSwap(id, store);
      if (!swap) return null;
      swap.receiveAddress = address;
      return engine.swap.saveSwap(swap, store);
    },

    /**
     * THE MONERO NETWORK OF AN ADDRESS, BY ITS SHAPE. The format and the network prefixes live in one module
     * (engine.xmrAddress), the SAME one the Monero wallet adapter uses - the interface must not keep a prefix table
     * of its own. `null` - not an address of a known network.
     */
    async addressNetwork(address) {
      if (typeof address !== "string" || !address) return null;
      try { return engine.xmrAddress.networkFromShape(address); } catch { return null; }
    },

    /**
     * REMOVING A RECORD FROM THE LIST. The record leaves THIS store only: on the service and in the contract
     * everything stays, so this is a tidy-up of the list, not a cancellation of the swap. `false` means there was
     * no such record - the caller tells that apart from a refusal.
     */
    async forget(id) {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      let state = null;
      try { state = store.loadState(); } catch { throw new SdkError("storage-unavailable", { step: "forget" }); }
      const swaps = state && state.swaps;
      if (!swaps || !swaps[id]) return false;
      delete swaps[id];
      try { store.saveState(state); } catch { throw new SdkError("storage-unavailable", { step: "forget" }); }
      return true;
    },

    // THE ARRIVAL VERDICT WITHOUT THE WATCH LOOP, and the deadline check as a separate call: an interface may
    // want to run both itself. The watch uses exactly these, so there is one decision, not two.
    verifyArrival: (request) => xmrArrival.verifyArrival(withDefaultFetch(request)),
    /**
     * SHADOW THE FIXED-SLICE WITNESS WITHOUT CHANGING THE DECISION. It runs the exact check and the witness-v1
     * slice check and returns both; `witnessNodes` must carry `{protocol: "witness-v1"}`. Nothing here opens
     * `ready` or refunds. It exists so the protocol can be exercised before an independent operator serves it.
     */
    verifyArrivalShadow: (request) => xmrArrival.verifyArrivalShadow(withDefaultFetch(request)),
    assertTimeForConfirmations: (request) => xmrArrival.assertTimeForConfirmations(request),

    /**
     * THE CLIENT'S OWN EARLY REFUND WHEN THE XMR DID NOT ARRIVE (issue #88). After `readyBy` the maker may claim
     * even without the ready mark, and the early-refund window closes; so while the interface is open a depositor
     * who sees no XMR must take the ETH back BEFORE `readyBy`. The arrival is decided by THE SAME rule the watch
     * uses (xmr-arrival.verifyArrival): two nodes of different operators on one block, and money barred by
     * unlock_time is not an arrival.
     *
     * ONLY A POSITIVE "NOT ARRIVED" REFUNDS (`absent: true`, returned only when two operators completed the walk
     * and found no matching transaction). `pending` with a transaction, `one-node`, and every failure to check are NOT
     * "no money": the helper refuses to sign, so a lagging or busy witness can never look like an empty address.
     *
     * IT FIRES ONLY WHEN LESS THAN THE NODE'S REFUND LEAD IS LEFT before `readyBy` (`readyLeadSec` of the window
     * stored with the record, overridable with `leadSec`): refunding earlier would abandon a maker who still has
     * time to deliver. The lead is the window's own headroom, not the retired `minConfirmations * blockTimeSec`.
     * The refund goes through the same action seam as the screen (actions.refund), and the order expectations are
     * mandatory.
     *
     * The seams `deps.verify` / `deps.refund` / `deps.now` exist for the checks; in production they are the real
     * arrival check and the real refund.
     */
    async refundIfXmrMissing(request = {}, deps = {}) {
      const verify = typeof deps.verify === "function" ? deps.verify
        : (request) => xmrArrival.verifyArrival(withDefaultFetch(request));
      const refund = typeof deps.refund === "function" ? deps.refund : actions.refund;
      const nowOf = typeof deps.now === "function" ? deps.now : () => Math.floor(Date.now() / 1000);
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      const swap = request.swap && typeof request.swap === "object" ? request.swap : null;
      const e = (swap && swap.escrow) || {};
      const escrow = request.escrow || e.address || null;
      if (!escrow) throw new SdkError("bad-input", { field: "escrow" });
      const halfLocker = request.halfLocker || e.half || null;
      if (!halfLocker) throw new SdkError("bad-input", { field: "halfLocker" });
      if (!request.expect || typeof request.expect !== "object") throw new SdkError("bad-input", { field: "expect" });
      const address = request.address || e.moneroAddress || null;
      if (!address) throw new SdkError("bad-input", { field: "address" });
      const viewSecret = request.viewSecret !== undefined && request.viewSecret !== null
        ? request.viewSecret : (swap ? jointViewKey(swap) : null);
      if (viewSecret === undefined || viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
      const spendPub = request.spendPub || e.moneroSpendPub || null;
      if (!spendPub) throw new SdkError("bad-input", { field: "spendPub" });
      // THE EXPECTED SUM IN ATOMIC UNITS. Given explicitly, or derived from the record's XMR amount (1 XMR = 10^12).
      // THE AMOUNT MUST BE THE SIGNED ONE. `swap.xmrAmount` is a display figure; deriving the arrival amount from
      // it would let a rounded number decide whether a payment is short. A record without the signed value is
      // refused instead of guessed.
      const expectedAtomic = request.expectedAtomic !== undefined && request.expectedAtomic !== null
        ? request.expectedAtomic : (e.expectedAtomic !== undefined && e.expectedAtomic !== null ? e.expectedAtomic : null);
      if (expectedAtomic === null) throw new SdkError("bad-input", { field: "expectedAtomic", why: "unsigned-amount" });
      const readyBy = Number(request.readyBySec !== undefined && request.readyBySec !== null ? request.readyBySec : e.readyBy);
      if (!Number.isFinite(readyBy) || readyBy <= 0) throw new SdkError("bad-input", { field: "readyBySec" });
      const minConfirmations = Number.isFinite(Number(request.minConfirmations)) && Number(request.minConfirmations) > 0
        ? Math.trunc(Number(request.minConfirmations)) : limitOf("xmrConfirmations", 10);
      const leadSec = Number.isFinite(Number(request.leadSec)) && Number(request.leadSec) >= 0
        ? Number(request.leadSec) : (() => {
            const window = request.readyWindow || (swap && (swap.readyWindow || swap.sellWindow));
            if (!window) throw new SdkError("bad-input", { field: "readyWindow", why: "not-in-record" });
            return readyLeadSec(readReadyWindow(window, { field: "readyWindow" }));
          })();
      // THE WALK STARTS AT THE SWAP'S BIRTH, NEVER AT GENESIS. A missing height used to become block 0, so a refund
      // check on a real chain would walk every block ever mined. The record carries the measured height; a caller
      // that has neither an explicit height nor a record height is refused rather than given a scan of the whole chain.
      const fromHeight = request.fromHeight !== undefined && request.fromHeight !== null
        ? Number(request.fromHeight)
        : Number(swap && (swap.restoreHeight ?? e.moneroRestoreHeight ?? e.restoreHeight));
      if (!Number.isSafeInteger(fromHeight) || fromHeight <= 0) {
        throw new SdkError("bad-input", { field: "fromHeight", why: "missing" });
      }
      const nowSec = Number.isFinite(Number(request.nowSec)) ? Number(request.nowSec) : nowOf();
      const leftSec = Math.floor(readyBy - nowSec);
      // PAST `readyBy` THE EARLY WINDOW IS GONE and the claim window is open: refunding is no longer ours to open.
      if (leftSec <= 0) return { refunded: false, state: "claim-window", leftSec, readyBy, nowSec };
      // TIME STILL LEFT BEYOND THE RESERVE - the maker has room to deliver; a refund now would abandon a live trade.
      if (leftSec > leadSec) return { refunded: false, state: "waiting", leftSec, needSec: leadSec, readyBy, nowSec };

      let verdict = null;
      try {
        verdict = await verify({
          nodes: request.nodes, address, viewSecret, spendPub, expectedAtomic, minConfirmations,
          txid: request.txid || null, fromHeight,
          timeoutMs: request.timeoutMs, nowSec,
        });
      } catch (error) {
        // A SHORT PAYMENT OR A LOCKED OUTPUT IS NOT AN EMPTY ADDRESS. It is also not a completed arrival: return
        // the named state and sign nothing. The caller can wait for the remainder or the lock to mature.
        if (error && error.code === "xmr-underpaid") {
          return { refunded: false, state: "arrival-underpaid", leftSec, verdict: null, error: error.params || null };
        }
        if (error && error.code === "xmr-locked") {
          return { refunded: false, state: "arrival-locked", leftSec, verdict: null, error: error.params || null };
        }
        throw error;
      }
      // THE XMR IS THERE - NOTHING IS REFUNDED. This is the decisive condition of the guard: without it the
      // client would take the ETH back from under a maker who has already sent the XMR.
      if (verdict.seen) return { refunded: false, state: "arrived", leftSec, verdict };
      // A TRANSACTION THAT IS THERE BUT NOT YET SETTLED IS NOT AN EMPTY ADDRESS. `pending` with a txid or height,
      // and `one-node`, mean the money was seen; only the explicit absence marker proves there is nothing to wait
      // for. A throw from `verify` above never reaches here and signs nothing either.
      if (!verdict || verdict.absent !== true) return { refunded: false, state: "arrival-pending", leftSec, verdict };
      const res = await refund({ escrow, halfLocker, expect: request.expect, onStep: request.onStep }, request.wallet);
      return { refunded: true, state: "refunded", hash: (res && res.hash) || null, leftSec, verified: verdict };
    },

    async start(request) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      // SELL IS NOT A BUY WITH ANOTHER LABEL. The lock step sends the settlement deposit from the caller; on a sell
      // the caller is the claimer and the node is the locker, so this path would ask the wallet to sign the wrong
      // transaction. Refuse before the recovery key, the wallet or any network read; the sell client has its own
      // flow and must not be simulated by this one.
      if (request.side === "sell") {
        throw new SdkError("bad-input", { field: "side", why: "sell-not-supported", surface: "swaps.start" });
      }
      if (!request.quote || typeof request.quote !== "object") throw new SdkError("bad-input", { field: "quote" });
      // THE PER-SWAP FILE PATH IS GONE. One key covers every swap, and a per-swap file issued before funding cannot
      // name the escrow (it does not exist yet), so `sweep.plan` could not read the revealed half from it.
      if (request.recoveryKey === undefined || request.recoveryKey === null) {
        throw new SdkError("bad-input", { field: "recoveryKey", why: "required" });
      }
      if (!request.receiveTo || typeof request.receiveTo !== "string") throw new SdkError("bad-input", { field: "receiveTo" });
      // A START WITHOUT THE SIGNED XMR AMOUNT IS NOT A START. `quote.size` is a rounded display value and the relay
      // answer does not carry it; the arrival check needs the exact integer the order quote signed. Refuse here, before
      // a wallet or a funding send, instead of recording an incomplete swap that later reads "no amount".
      if (!recordInputOf(request, xmrNetwork).expectedAtomic) {
        throw new SdkError("bad-input", { field: "expectedAtomic", why: "signed-amount-missing" });
      }

      // RESUME BEFORE ANY NEW SIDE OR SEND. The previous start may have sent the deposit and lost the receipt;
      // reusing its hash is the only way to learn the escrow without a second payment.
      const rawSaltForResume = request.recoverySalt || (request.order && request.order.salt) ||
        (request.orderQuote && request.orderQuote.salt) || null;
      // THE SALT THAT MATCHES THE PENDING ROW IS THE CANONICAL ONE. A caller may pass a number or a bigint
      // (`StartRequest.recoverySalt` allows all three); the record holds hex, so the raw value would miss the row
      // after a reload and start a second deposit. Canonicalise once, before the identity lookup.
      let saltForResume = null;
      try {
        saltForResume = rawSaltForResume === null || rawSaltForResume === undefined || rawSaltForResume === ""
          ? null : recoverySaltOf(rawSaltForResume);
      } catch { saltForResume = null; }
      const resumeIdentity = {
        salt: saltForResume,
        // THE QUOTE ID IS ONLY A SELECTOR. It lets a salt-less retry name the pending row and be refused loudly, but
        // it never replaces the salt/chain/factory/escrow proof below.
        quoteId: (request.orderQuote && request.orderQuote.id) || (request.quote && request.quote.id) || null,
        chainId: (request.order && request.order.chainId) ?? (request.orderQuote && request.orderQuote.chainId)
          ?? (request.quote && request.quote.chainId),
        factory: (request.order && request.order.factory) ?? (request.orderQuote && request.orderQuote.factory)
          ?? (request.quote && request.quote.factory),
        escrow: request.escrow || request.predictedEscrow || (request.quote && request.quote.escrow)
          || (request.orderQuote && request.orderQuote.escrow) || null,
      };
      // A RELOADED RETRY HAS NO ESCROW FIELD. Find the pending row by the part it does have, then let the factory
      // predict the address from the same signed terms the send uses. If that address cannot be named, the retry is
      // refused by name; it must not fall through to a new deposit.
      let pendingRecord = null;
      if (records().some((swap) => samePendingBase(swap, resumeIdentity))) {
        const predicted = await predictedEscrowForRetry(request);
        if (!predicted) {
          throw new SdkError("bad-input", { field: "escrow", why: "required-for-pending-funding" });
        }
        const named = pendingAddress(resumeIdentity.escrow);
        if (resumeIdentity.escrow && !named) {
          throw new SdkError("bad-input", { field: "escrow", why: "unreadable" });
        }
        if (named && named !== pendingAddress(predicted)) {
          throw new SdkError("bad-input", { field: "escrow", why: "escrow-mismatch" });
        }
        resumeIdentity.escrow = predicted;
        pendingRecord = pendingFundingOf(resumeIdentity);
        if (!pendingRecord) {
          throw new SdkError("bad-input", { field: "escrow", why: "pending-funding-unresolved" });
        }
      } else {
        pendingRecord = pendingFundingOf(resumeIdentity);
      }
      if (pendingRecord) {
        const resumed = await resumePendingFunding(pendingRecord, request);
        if (resumed) return resumed;
      }
      // A NEW START USES A PER-ORDER SALT. When the caller brings no `recoverySalt`, the order's own salt is the
      // client salt; a missing salt is drawn here and written into the order before its context is built.
      if (request.recoverySalt === undefined || request.recoverySalt === null) {
        if (!request.order || typeof request.order !== "object") throw new SdkError("bad-input", { field: "order" });
        if (request.order.salt === undefined || request.order.salt === null || request.order.salt === "") {
          request.order = { ...request.order, salt: newRecoverySalt() };
        }
        request.recoverySalt = request.order.salt;
      }
      // THE ORDER CONTEXT IS MANDATORY AND NOT INVENTED. It is assembled by the engine FROM THE VERY FIELDS the firm
      // quote's signature is bound to (orderContext.js, FIELDS), because the DLEQ proof proves a half FOR THESE TERMS.
      // Substituting an empty value here would mean issuing a key bound to nothing.

      // 1. THE GUARDS. THE DECISION IS BY `blocks`, AS THE ENGINE ITSELF DOES: the signature is locked only by a check
      // that directly forbids (preSignGuards, signingGateVerdict: blocks === true), while "not measured" (checked ===
      // false) is a state of the data, not a prohibition. The previous revision called the guards WITH AN EMPTY DATA SET
      // and counted any `ok === false` as a refusal, which made a live start run into it at the very first step.
      //
      // The guards are fed what the core HAS: the network (their guards take it themselves - the registry plus the
      // wallet state), the order amount in wei (it is in the terms) and the token allowance (native or ERC-20 - by the
      // network registry).
      const guardOptions = await guardOptionsOf(request);
      const report = preflight ? await preflight(request.quote, guardOptions) : null;
      const checks = (report && (report.checks || report.results)) || [];
      const blocking = checks.filter((c) => c && c.blocks === true);
      if (blocking.length) {
        const first = blocking[0];
        throw new SdkError(first.code || "bad-input", { ...(first.params || {}), kind: first.kind, surface: "swaps.start" });
      }

      // 2. THE SWAP RECORD. For now only the interface with a browser wallet can do it - and that is NAMED, not covered
      // by a stub.
      // THE SWAP RECORD IS CREATED ITSELF if the interface did not bring its own: the engine can do it as a pure state
      // record, and our side of the order is computed from the core's primitives.
      // THE RECORD IS CREATED TOGETHER WITH OUR SIDE: the order terms go into it, and the side is built by the engine's
      // builder (with the DLEQ proof and the encryption key), not by the core's own arithmetic.
      let keySide = null;
      let derivedViewHalf = null;
      const makeRecord = typeof createRecord === "function" ? createRecord
        : async (req) => recordModule.createRecord(recordInputOf(req, xmrNetwork), { order: req.order, side: keySide, store });
      const passphrase = typeof request.passphrase === "string" ? request.passphrase : "";
      if (typeof passphrase !== "string") throw new SdkError("bad-input", { field: "passphrase" });
      if (passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE) throw new SdkError("bad-input", { field: "passphrase", min: MIN_PASSPHRASE });
      // THE ORDER TERMS ARE CHECKED BEFORE THE RECORD. The context is assembled by the engine from the very fields the
      // firm quote's signature is bound to; incomplete terms - a refusal with a named field, not a substitution of empty
      // values: the DLEQ proof would then be bound to nothing.
      const orderContext = contextOf(request.order);

      // THE KEY RECORD AND THE SIDE. A key is made once and kept through the SDK's store; this path uses the
      // per-order salt, and no per-swap file is assembled here.
      let recovery = null;
      {
        const storage = store.storage();
        const supplied = typeof request.recoveryKey === "string"
          ? request.recoveryKey
          : request.recoveryKey && typeof request.recoveryKey.mnemonic === "string" ? request.recoveryKey.mnemonic : null;
        const saved = loadRecoveryKey(storage);
        if (saved && supplied && saved.mnemonic !== supplied) {
          throw new SdkError("bad-input", { field: "recoveryKey", why: "different-key" });
        }
        if (!saved && !supplied) throw new SdkError("bad-input", { field: "recoveryKey" });
        const key = saved || importRecoveryKey(supplied);
        // THE KEY IS SAVED, BUT NOT YET BACKED UP. `backupConfirmed` is its own fact: a key in storage is not a
        // key the person has saved. Saving it here keeps the key across a refresh; funding waits for the flag.
        if (!saved) saveRecoveryKey(storage, { ...key, backupConfirmed: false });
        const chainId = request.order.chainId;
        // THE CLIENT OWNS THE SALT. A maker that chose it could hand the same salt to the same client twice, so
        // the caller composes the signed quote with this value and passes it here. The order's own salt must be
        // the same bytes; a mismatch means the quote is not the one being started.
        if (typeof request.order.factory !== "string" || !request.order.factory) {
          throw new SdkError("bad-input", { field: "order.factory" });
        }
        let salt;
        try { salt = recoverySaltOf(request.recoverySalt); } catch { throw new SdkError("bad-input", { field: "recoverySalt" }); }
        let orderSalt;
        try { orderSalt = recoverySaltOf(request.order.salt); } catch { throw new SdkError("bad-input", { field: "recoverySalt", why: "order-salt" }); }
        if (salt !== orderSalt) throw new SdkError("bad-input", { field: "recoverySalt", why: "order-salt" });
        const derived = takerHalvesV2({ mnemonic: key.mnemonic, chainId, factory: request.order.factory, salt });
        recovery = { storage, key, salt, derivation: "salt-v2", newKey: !saved || saved.backupConfirmed !== true };
        keySide = buildOwnSideFromHalvesKnown(request.order, { spendHalf: derived.spendHalf, viewHalf: derived.viewHalf }).side;
        // THE MAKER'S VIEW HALF IS DERIVED FROM THE KEY, NOT CHOSEN BY THE NODE. Without this binding a
        // signed quote could carry another view half; the funded address would differ from the one the twelve
        // words rebuild, and `sweep.fromOrder` would refuse after the funds were locked.
        derivedViewHalf = { half: derived.makerViewHalf, point: derived.makerViewPoint };
      }

      // THE KEY PATH BINDS THE VIEW HALF BEFORE THE ORDER IS BUILT. The quote must echo the half derived from
      // the same words and number; a missing or different half is refused, never silently replaced.
      if (derivedViewHalf) {
        const cp = request.counterparty && typeof request.counterparty === "object" ? request.counterparty : null;
        // ONE NORMALISATION FOR THE GUARD AND THE BUILDER. Conflicting aliases are a refusal here, not a choice
        // between two values; the point is derived from the half when the quote names only the half.
        const view = normalizeCounterpartyView(cp);
        if (view.half === null) throw new SdkError("quote-field-unbound", { step: "viewHalfClaimer", field: "viewHalfClaimer" });
        let sameHalf = false;
        try { sameHalf = BigInt(view.half) === BigInt(derivedViewHalf.half); } catch { sameHalf = false; }
        if (!sameHalf) throw new SdkError("quote-refused", { step: "viewHalfClaimer", why: "not-the-derived-half" });
        if (view.point !== null &&
            String(view.point).replace(/^0x/, "").toLowerCase() !== String(derivedViewHalf.point).replace(/^0x/, "").toLowerCase()) {
          throw new SdkError("quote-refused", { step: "viewHalfClaimer", why: "point-mismatch" });
        }
      }

      let made = null;
      try { made = await makeRecord(request); } catch (error) {
        // THE CODE MATTERS, NOT THE CLASS: an error with a code (including from another instance of the module) passes
        // as is; without a code it means a breakdown inside the record, and it is named as a storage refusal.
        if (error && typeof error.code === "string") throw error;
        throw new SdkError("storage-unavailable", { step: "create-record" });
      }
      if (!made || !made.swap) throw new SdkError("bad-input", { field: "record" });

      // 2b. THE ORDER. IT GOES BEFORE THE FILE and this is not a rearrangement for convenience: the halves and the
      // counterparty's open points, without which the recovery file is empty, appear exactly here. The counterparty's
      // side comes from outside; in the sandbox the engine builds it as a stand-in, but on a live chain a stand-in would
      // mean the money goes against a non-existent side, so there it is a refusal.
      let record = made;
      // THE NODE'S WINDOW IS PART OF THE RECORD. It is read from the signed features and later decides how long a
      // sale may wait and when a depositor may still refund; a record without it is refused when that decision is
      // made, never filled with the old local constants.
      const readyWindowRaw = request.readyWindow || (request.quote && request.quote.readyWindow) || null;
      let readyWindow = null;
      if (readyWindowRaw) {
        readyWindow = readReadyWindow(readyWindowRaw, { side: "ask", field: "readyWindow" });
        record.swap.readyWindow = readyWindow;
      }
      // THE ORDER SIDE BUILT BY THE CORE STAYS UNTIL THE END OF THE START: the points and commitments for the lock terms
      // are taken from it - otherwise the record and the order would diverge, and the slot check against the chain would
      // go red (and rightly so). There is no second build of the side here.
      let builtSide = null;
      if (!record.swapWallet) {
        const step = await orderStepChunked({
          order: request.order, side: made.side || null, counterparty: request.counterparty || null,
          standIn: mode !== "live", network: (record.swap.moneroNetwork || xmrNetwork || null),
        });
        // THE RECORD FIELDS ARE UNDER THE VERY NAMES THE ENGINE READS. So the record, after a page reload, again yields a
        // wallet from the halves (`halvesWalletOf`), rather than losing the address together with the tab.
        const escrow = record.swap.escrow && typeof record.swap.escrow === "object" ? record.swap.escrow : {};
        record.swap.escrow = { ...escrow,
          half: step.wallet.spendHalf, viewHalf: step.wallet.viewHalf,
          edPointLocker: step.own.spendPoint, edViewPointLocker: step.own.viewPoint,
          edPointClaimer: step.wallet.otherSpendPoint, counterViewPoint: step.wallet.otherViewPoint,
          counterViewHalf: step.wallet.otherViewHalf,
          moneroAddress: step.wallet.address, moneroSpendPub: step.wallet.spendPub, moneroViewPub: step.wallet.viewPub,
          moneroNetwork: step.wallet.network, standIn: step.counterparty.standIn,
          providerId: step.counterparty.providerId, orderContext: step.context,
        };
        try { engine.swap.saveSwap(record.swap, store); } catch { throw new SdkError("storage-unavailable", { step: "save-swap" }); }
        record = { ...record, swapWallet: engine.swap.halvesWalletOf(record.swap) };
        if (!record.swapWallet) throw new SdkError("bad-input", { field: "swapWallet" });
        builtSide = step;
      }

      // THE HEIGHT IS MEASURED BEFORE THE FILE OR THE WATCH: the node is asked once, while the swap is still in
      // front of us. A swap without it is not funded - a recovery file that scans from zero is a file that looks
      // usable and is not.
      const measuredHeight = await measuredStartHeight(request, record.swap.moneroNetwork || xmrNetwork || null);
      record.swap.restoreHeight = measuredHeight;
      record.restoreHeight = measuredHeight;
      record.swap.escrow = { ...(record.swap.escrow || {}), moneroRestoreHeight: measuredHeight };
      try { engine.swap.saveSwap(record.swap, store); } catch { throw new SdkError("storage-unavailable", { step: "save-restore-height" }); }

      // 2a. THE KEY IS CONFIRMED ONCE. The same twelve words cover every swap, and a person who already saved them
      // is not asked again. A new key is shown before the money moves - no saved key, no funding.
      let file = null;
      if (recovery.newKey) {
        if (typeof request.onRecoveryKey !== "function") throw new SdkError("bad-input", { field: "onRecoveryKey" });
        try {
          file = {
            name: recoveryKeyFileName(recovery.key),
            contents: await createRecoveryKeyFile({ mnemonic: recovery.key.mnemonic, createdAt: recovery.key.createdAt, passphrase }),
          };
        } catch { throw new SdkError("recovery-failed", { step: "encrypt-key" }); }
        const confirmed = await request.onRecoveryKey(file);
        if (confirmed !== true) throw new SdkError("recovery-declined", { key: recovery.key.fingerprint });
        // ONLY THE PERSON'S TRUE ANSWER MAKES THE KEY "BACKED UP". The record already exists; this flag is what a
        // later start reads. A failed write is a refusal before any funds move.
        try {
          saveRecoveryKey(recovery.storage, { ...recovery.key, backupConfirmed: true });
          recovery.key = { ...recovery.key, backupConfirmed: true };
        } catch { throw new SdkError("storage-unavailable", { step: "save-recovery-key" }); }
      }

      // 4. LOCKING THE FUNDS. The wallet comes FROM OUTSIDE (an adapter with `send`/`receipt`): signing is possible only
      // in it, and the core keeps no path into the chain of its own. The absence of a wallet is a REFUSAL WITH A CODE,
      // not a substitution of something by default: a lock without a signature would either not happen or go out with
      // the wrong key. The recovery key has by now been shown and confirmed by the person - a lock without a saved
      // key is not done.
      const wallet = request.wallet;
      if (!wallet || typeof wallet.send !== "function" || typeof wallet.receipt !== "function") {
        throw new SdkError("bad-input", { field: "wallet", missing: ["send", "receipt"], surface: "swaps.start", step: "lock" });
      }
      // THE INTERFACE'S ADDRESS DENYLIST, ON THE ACTUAL SENDER (issue #16). The person may have switched accounts
      // in the wallet, so what matters is the address the funding transaction will really be sent from AT THIS
      // MOMENT, not `order.locker` checked earlier. The wallet adapter hands out the current account (the adapter's
      // `address()` reads `eth_accounts[0]`); the comparison lives HERE, one place, right before the send - not
      // inside the adapter. The refusal happens BEFORE any request: no transaction is signed or sent.
      if (denylist) {
        const sender = typeof wallet.address === "function" ? await wallet.address() : null;
        if (typeof sender !== "string" || !sender) {
          // A HALF-ADAPTER CANNOT BE APPLIED THE POLICY TO: silently skipping would make the list skippable.
          throw new SdkError("bad-input", { field: "wallet", missing: ["address"], surface: "swaps.start", step: "lock" });
        }
        if (denylist.has(sender.toLowerCase())) throw new SdkError("address-denied", { step: "lock" });
      }
      // THE LOCK TERMS ARE THE SAME AS THE ORDER'S, and are taken from the caller: exactly these fields enter the
      // context the DLEQ proof is bound to (orderContext.js, FIELDS). The deadlines and composition are checked by the
      // engine (lock.send -> escrow.orderTerms) BEFORE sending, not by our own arithmetic: the contract sets the rules.
      // In the order terms the amount is already in wei, so amountWei is that same one, without recomputation.
      // THE LOCK TERMS ARE FROM THE SAME SIDE THAT WENT INTO THE RECORD. The points and commitments are computed by the
      // core (orderStep), not the caller: they do not know the half the core just built, and a second build of it would
      // be a second side. The deadlines, composition, amounts and addresses remain the caller's; the core merely ADDS
      // what follows from the built side. When the caller brought the side (createRecord returned a ready record with
      // its own side), builtSide is empty - then the terms are taken as passed.
      const derived = builtSide ? {
        commitHalfLocker: builtSide.wallet.commitHalfLocker,
        commitHalfClaimer: builtSide.wallet.commitHalfClaimer,
        edPointLocker: builtSide.own.spendPoint,
        edPointClaimer: builtSide.wallet.otherSpendPoint,
        edViewPointLocker: builtSide.own.viewPoint,
      } : {};
      const lockRequest = { ...request.order, ...derived, amountWei: request.order.amount };
      // THE SIGNED QUOTE: the fee, the registry address and the provider live in IT, not in the factory
      // (decision #76). The caller brings it (the interface got it from the maker); without it the lock is not signed.
      // THE QUOTE MUST NAME THE SAME COUNTERPARTY HALF THAT WAS VERIFIED. `orderStep` verifies
      // `request.counterparty`, while funding encodes `request.orderQuote`; a caller that brings both can otherwise
      // prove one point and fund another. The same comparison is repeated in funding.js, at the money boundary.
      if (request.orderQuote && (builtSide || request.counterparty)) {
        const norm = (v) => String(v === null || v === undefined ? "" : v).replace(/^0x/i, "").toLowerCase();
        const verifiedCommit = builtSide ? builtSide.wallet.commitHalfClaimer
          : (request.counterparty.commitHalfClaimer || null);
        const verifiedPoint = builtSide ? builtSide.wallet.otherSpendPoint
          : (request.counterparty.edPointClaimer || request.counterparty.edPub || null);
        if (!verifiedCommit || !verifiedPoint ||
            norm(request.orderQuote.commitHalfClaimer) !== norm(verifiedCommit) ||
            norm(request.orderQuote.edPointClaimer) !== norm(verifiedPoint)) {
          throw new SdkError("quote-refused", { step: "quote-binding", why: "counterparty-half" });
        }
      }
      // THE SIGNED QUOTE MUST STILL BE VALID WHEN THE MONEY MOVES. The proof and the record work take seconds; a
      // quote that expired in that window would reach the wallet and revert at the factory. Check the signed field
      // immediately before the send, with a small margin for the next block.
      const validUntil = request.orderQuote && request.orderQuote.validUntil !== undefined
        ? request.orderQuote.validUntil
        : undefined;
      if (validUntil !== undefined && validUntil !== null) {
        const until = Number(validUntil);
        // THE CLOCK IS THE SDK'S OWN SEAM, IN MILLISECONDS, LIKE EVERY OTHER NOW IN THE FACADE.
        const nowMs = typeof now === "function" ? Number(now()) : Date.now();
        const nowSec = Math.floor(nowMs / 1000);
        // THE PREPARATION WAS ALREADY PAID FOR AT THE ANSWER. This check runs after the proof, the record and the
        // chain reads; requiring START_PREP_SEC again would refuse a quote that the answer accepted and spent those
        // seconds on. Only the next-block margin remains between here and the send.
        const life = quoteLifeVerdict({ validUntil: until, nowSec, side: "ask", prepSec: 0 });
        if (!life.ok) {
          throw new SdkError("quote-expired", {
            validUntil: Number.isFinite(until) ? until : null,
            now: Number.isFinite(nowSec) ? nowSec : null,
            remainingSec: life.remainingSec,
            marginSec: life.marginSec,
            prepSec: life.prepSec,
            confirmBySec: life.confirmBySec,
            step: "lock",
          });
        }
      }
      lockRequest.quote = request.orderQuote || null;
      // THE PENDING RECORD EXISTS BEFORE THE SEND, NOT AFTER THE RECEIPT WAIT. If the receipt arrives late (or the
      // process dies while waiting), a retry must find the predicted escrow and read it instead of asking for a
      // second deposit. `fundOrder` calls this after its state guard and immediately before `eth_sendTransaction`.
      const notePredicted = async ({ escrow: predicted, salt }) => {
        if (!predicted || !/^0x[0-9a-fA-F]{40}$/.test(String(predicted))) return;
        const escrowRecord = record.swap.escrow && typeof record.swap.escrow === "object" ? record.swap.escrow : {};
        record.swap.fundingPending = true;
        record.swap.escrow = { ...escrowRecord, address: predicted, salt: salt || escrowRecord.salt || null,
          fundingPending: true, fundingReason: "not-sent" };
        try { engine.swap.saveSwap(record.swap, store); }
        catch { throw new SdkError("storage-unavailable", { step: "save-pending" }); }
      };
      let funded = null;
      try { funded = await lock.send(lockRequest, wallet, { call: reader, onPredicted: notePredicted }); }
      catch (error) {
        // A REJECTION BEFORE BROADCAST MUST NOT LEAVE THE SWAP STUCK IN funding-pending. The pre-send record exists
        // for a process that dies while the send is in flight; an explicit wallet refusal is the other case, and the
        // retry has to be allowed to sign again. A transaction that was already mined is caught by the escrow's own
        // state guard; one still in the mempool is not, and the resend can revert and cost gas - never a second deposit.
        if (record.swap.escrow && record.swap.escrow.fundingReason === "not-sent") {
          delete record.swap.fundingPending;
          record.swap.escrow = { ...record.swap.escrow, fundingPending: false, fundingReason: "send-rejected" };
          try { engine.swap.saveSwap(record.swap, store); } catch { /* the pending record stays; never resend blind */ }
        }
        if (error && typeof error.code === "string") throw error;
        throw new SdkError("server-unavailable", { step: "lock" });
      }
      // A SENT TRANSACTION IS NOT A FUNDED ESCROW. Without a status-1 receipt and the expected OrderCreated, the
      // address is unknown and calling the step xmr-incoming would make the person wait for XMR at a guess. Keep
      // the swap pending: the transaction hash is the handle for a later receipt read.
      if (funded && funded.pending) {
        // THE TRANSACTION IS SENT; ONLY THE RECEIPT IS LATE. Keep the hash and the predicted escrow on the record
        // so this start and a later retry can read the receipt instead of building a second deposit.
        const pendingTx = funded.createHash || null;
        const predicted = funded.predictedEscrow || null;
        const escrowRecord = record.swap.escrow && typeof record.swap.escrow === "object" ? record.swap.escrow : {};
        record.swap.fundingPending = true;
        record.swap.escrow = { ...escrowRecord, address: predicted || escrowRecord.address || null,
          fundTx: pendingTx || escrowRecord.fundTx || null, fundingPending: true,
          fundingReason: funded.pendingReason || "no-receipt" };
        try { engine.swap.saveSwap(record.swap, store); } catch { throw new SdkError("storage-unavailable", { step: "save-pending" }); }
        return { id: record.swap.id || null, escrow: record.swap.escrow.address || null,
          address: (record.swapWallet && record.swapWallet.address) || null,
          step: "funding-pending", txHash: pendingTx,
          reason: funded.pendingReason || "no-receipt", predictedEscrow: predicted, next: "receipt",
          readyWindow };
      }
      // THE ESCROW ADDRESS IS TAKEN FROM THE RECEIPT (lock.send does this), not from a prediction. It is also written
      // into the swap: otherwise the progress screen and the explorer link would show an address that is not on the
      // chain (the page does this on its side: www/js/ui/views/confirm.js:463).
      const escrowAddress = (funded && funded.escrow) || null;
      if (escrowAddress) {
        const escrowRecord = record.swap.escrow && typeof record.swap.escrow === "object" ? record.swap.escrow : {};
        record.swap.escrow = { ...escrowRecord, address: escrowAddress,
          // THE SETTLEMENT-CHAIN HEIGHT, NAMED AS SUCH. It is for the OrderCreated/Declined log search; the XMR
          // watch and the recovery file take the Monero height measured above. The old name `birthHeight` stays
          // readable on records written before this split.
          evmBirthBlock: Number(funded.birthBlock) > 0 ? Number(funded.birthBlock) : (escrowRecord.evmBirthBlock ?? escrowRecord.birthHeight ?? null) };
        try { engine.swap.saveSwap(record.swap, store); } catch { throw new SdkError("storage-unavailable", { step: "save-escrow" }); }
        // THE SALT IS THE RECOVERY BINDING; there is no index reservation to commit here.
      }

      // THE START ENDS AT THE JOINT ADDRESS. There is no backend step any more: the retired node routes are gone,
      // and the caller watches the chain through `swaps.watch` with its own node list.
      // THE STATE IS NAMED, NOT PASSED OFF AS COMPLETION: the swap reached exactly "waiting for XMR at the joint address",
      // and there is no arrival yet - `receivedXmr` is never implied by zero.
      return {
        id: record.swap.id || null,
        escrow: escrowAddress,
        address: (record.swapWallet && record.swapWallet.address) || null,
        step: "xmr-incoming",
        next: "watch",
        readyWindow,
      };
    },

    /**
     * WAIT FOR THE XMR TO ARRIVE AT THE JOINT ADDRESS - the whole point of opening the watch.
     *
     * The CLIENT checks the arrival from the Monero nodes (`verify`); there is no backend watcher. The rate and the
     * timeout come from the configuration (config.limits.watchPollMs/watchTimeoutMs) and are overridable here.
     * IT ARRIVED - we return the FACT (the amount, the confirmations, the txid); WE DID NOT WAIT - a refusal with the
     * code `xmr-timeout`, separate from the others, so "the wait expired" is confused with neither a breakdown nor an
     * empty response. XMR ON THE ADDRESS BUT BARRED BY unlock_time is a THIRD answer with its own code `xmr-locked`
     * (the boundary - a height or a date - is in `until`): such funds are not an arrival, and the ready mark is not
     * signed under them.
     *
     * MARKING READY HAPPENS RIGHT HERE, AND ONLY AFTER THE ARRIVAL: `actions.markReady` allows a foreign address to
     * take the settlement, so it requires the order expectations (`expect`) - the slot check against the chain stands in
     * it BEFORE the signature. The caller passes them: the core does not invent the commitments of the order it signs.
     */
    async watch(request) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      const id = typeof request.id === "string" && request.id ? request.id : null;
      if (!id) throw new SdkError("bad-input", { field: "id" });
      // THE EXPECTATIONS AND THE WALLET COME AS A PAIR: with one of them there is nothing to check against, with the
      // other nothing to sign with. Skipping silently is not allowed - a signature without a check would allow a foreign
      // order to take the settlement.
      const wantExpect = request.expect !== undefined && request.expect !== null;
      const wantWallet = request.wallet !== undefined && request.wallet !== null;
      if (wantExpect !== wantWallet) throw new SdkError("bad-input", { field: wantExpect ? "wallet" : "expect" });
      if (wantExpect && !(request.escrow || request.address)) throw new SdkError("bad-input", { field: "escrow" });
      const storedSwap = (() => { try { return engine.swap.getSwap(id, store); } catch { return null; } })();
      const readyWindowRaw = request.readyWindow || (storedSwap && (storedSwap.readyWindow || storedSwap.sellWindow)) || null;
      const pollMs = Number.isFinite(Number(request.pollMs)) && Number(request.pollMs) > 0 ? Number(request.pollMs) : limitOf("watchPollMs", 5000);
      const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : limitOf("watchTimeoutMs", 1_200_000);
      // THE CONFIRMATION TARGET - FROM THE CONFIGURATION (one number, the owner's decision: 10).
      const minConfirmations = Number.isFinite(Number(request.minConfirmations)) && Number(request.minConfirmations) > 0
        ? Math.trunc(Number(request.minConfirmations)) : limitOf("xmrConfirmations", 10);
      // THE CLIENT-SIDE CHECK IS OPT-IN BY ITS DATA: it needs the joint address, the joint view secret and the
      // joint spend public key - all of which the client has and the backend no longer needs. Without them the
      // watch keeps the service's answer (notifications only); with them the CLIENT decides.
      const verifyRequest = request.verify && typeof request.verify === "object"
        ? { ...request.verify,
            nodes: Array.isArray(request.verify.nodes) ? request.verify.nodes
              : (config && typeof config.nodesFor === "function" ? config.nodesFor(request.verify.network || request.network || xmrNetwork) : []),
            minConfirmations }
        : null;
      // LESS TIME LEFT THAN THE CONFIRMATIONS TAKE - NAMED AND NOT STARTED (issue #85, the owner's decision).
      if (verifyRequest) {
        if (!readyWindowRaw) throw new SdkError("bad-input", { field: "readyWindow", why: "not-in-record" });
        const readyWindow = readReadyWindow(readyWindowRaw, { side: "ask", field: "readyWindow" });
        const readyBy = request.readyBySec !== undefined && request.readyBySec !== null ? Number(request.readyBySec)
          : (request.deadline && request.deadline.readyBy !== undefined ? Number(request.deadline.readyBy) : null);
        if (readyBy) xmrArrival.assertTimeForConfirmations({
          readyBySec: readyBy, nowSec: Math.floor(Date.now() / 1000), minConfirmations,
          blockTimeSec: limitOf("xmrBlockTimeSec", 120),
          minLeadSec: readyLateSec(readyWindow),
        });
      }
      // THE WATCH IS A CLIENT-SIDE CHECK AND NOTHING ELSE. It needs the joint address, the joint view secret and
      // the spend public key. Without them there is nothing to wait on: a named refusal, not a request to the
      // page's own origin and not a fallback to a retired backend.
      if (!verifyRequest) throw new SdkError("bad-input", { field: "verify", why: "required" });
      const started = Date.now();
      // --- THE MAKER'S DECLINE: THE WAIT IS NOT STARTED AT ALL (issue #40). -------------------------------------
      // A decline leaves the escrow `refunded`, so nothing in the state says "do not wait any longer": without
      // this, the wait runs to its timeout and the app is told the generic `xmr-timeout` about an order that is
      // CLOSED and whose ETH is already back - or, worse, the app offers the recovery file and a manual refund
      // for money nobody can recover.
      //
      // THE DECLINE IS READ FROM THE CHAIN: the escrow's own `Declined` event, through the same log reader the rest
      // of the core uses. A CHAIN READ THAT FAILS is neither a decline nor a refusal of the swap: the wait goes on,
      // and what the chain read did is carried out with the result (`chain.checked` / `chain.error`), so a broken
      // reader is visible instead of silent.
      // A STORAGE THAT CANNOT BE READ IS NOT A REASON TO REFUSE THE WAIT: the record is what makes the state
      // durable, and the escrow may also arrive in the request. The watch is not a new user of the store - and it
      // must not start failing where it did not before.
      let record = null;
      try { record = engine.swap.getSwap(id, store); } catch { record = null; }
      const escrowAddress = request.escrow || (record && record.escrow && record.escrow.address) || null;
      // FROM THE ESCROW'S BIRTH HEIGHT when the record knows it: the event cannot be older than the funding, and
      // walking the whole chain every tick is a cost with no answer behind it.
      const fromBlock = blockBoundaryOf(record && record.escrow
        ? (record.escrow.evmBirthBlock ?? record.escrow.birthHeight) : null);
      const chainDecline = { checked: false, error: null, logs: undefined };
      const readDeclineLogs = async () => {
        chainDecline.checked = false; chainDecline.error = null; chainDecline.logs = undefined;
        // NO ESCROW KNOWN, NO CHAIN ANSWER: named, so `checked: false` is never a silent "nothing there".
        if (!escrowAddress) { chainDecline.error = "no-escrow"; return; }
        try {
          chainDecline.logs = await logReader({ address: escrowAddress, topics: [DECLINED_TOPIC0], fromBlock, toBlock: "latest" });
          chainDecline.checked = true;
        } catch (error) {
          chainDecline.error = (error && error.code) || "logs-unread";
        }
      };
      // WRITTEN, NAMED, NOT INFERRED - the rule the record's destination follows too. The decline becomes the
      // record's OWN settlement once, so later reads of the record report the same state without asking the chain
      // again, and the state survives a page reload.
      const settleDecline = (swap, at) => {
        if (!swap || swap.settlement) return;
        swap.settlement = { kind: DECLINED_TERMINAL, phase: DECLINED_TERMINAL, at };
        try { engine.swap.saveSwap(swap, store); } catch { throw new SdkError("storage-unavailable", { step: "decline" }); }
      };
      // THE STATE THE WATCH REPORTS FOR A DECLINE: no arrival, the state's own code, the node's own token and
      // WHERE it was seen ("event" or "record" when it was already written down). NO reason, category
      // or provider travels here - the node names none, and the sentence a person reads is the interface's.
      const declineResult = ({ source, at, waitedMs, address, chainChecked, chainError }) => ({
        id,
        escrow: escrowAddress,
        address: address || null,
        seen: false,
        declined: true,
        terminal: DECLINED_TERMINAL,
        code: DECLINED_CODE,
        source,
        at,
        waitedMs,
        chain: { checked: Boolean(chainChecked), error: chainError || null },
      });
      if (record && record.settlement && record.settlement.kind === DECLINED_TERMINAL) {
        const at = Number(record.settlement.at);
        return declineResult({ source: "record", at: Number.isFinite(at) ? at : Date.now(), waitedMs: 0,
          address: null, chainChecked: false, chainError: null });
      }
      let last = null;
      for (;;) {
        await readDeclineLogs();
        last = { address: request.address || escrowAddress, expectedXmr: request.expectedXmr ?? null, status: null };
        // THE DECLINE IS THE ESCROW'S EVENT, NOT THE SERVICE'S WORD. The legacy backend's `declined` status used
        // to become a settlement and end the wait; it no longer does. A service answer is at most a notification.
        const declineNow = declineOf({ logs: chainDecline.logs, escrow: escrowAddress, at: Date.now() });
        if (declineNow.declined) {
          settleDecline(record, declineNow.at);
          return declineResult({ source: declineNow.source, at: declineNow.at, waitedMs: Date.now() - started,
            address: last && last.address, chainChecked: chainDecline.checked, chainError: chainDecline.error });
        }
        // THE CLIENT'S OWN ANSWER COMES FIRST AND DECIDES. The backend's `seen` may still be false (it no longer
        // holds the view key), so it is not consulted when the client verifies. A disagreement or locked money
        // throws its own code above and closes the button; one operator / few confirmations name a WAITING state.
        if (verifyRequest) {
          const verdict = await xmrArrival.verifyArrival(withDefaultFetch({ ...verifyRequest, nowSec: Math.floor(Date.now() / 1000) }));
          last.verify = verdict;
          if (!verdict.seen) {
            if (Date.now() - started >= timeoutMs) {
              throw new SdkError("xmr-timeout", { id, address: last.address, expectedXmr: last.expectedXmr,
                state: verdict.state, confirmations: verdict.confirmations ?? 0, waitedMs: Date.now() - started, timeoutMs, pollMs });
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            continue;
          }
          const verified = { seen: true, id, address: last.address, status: last.status,
            expectedXmr: last.expectedXmr, receivedXmr: Number(verdict.amountAtomic) / 1e12, confirmations: verdict.confirmations,
            txids: [verdict.txid], at: Date.now(),
            verified: { height: verdict.height, blockHash: verdict.blockHash, operators: verdict.operators, agreedBy: verdict.agreedBy },
            source: "client" };
          if (wantExpect && wantWallet) {
            verified.marked = await actions.markReady(
              { escrow: request.escrow || last.address, expect: request.expect, onStep: request.onStep }, request.wallet);
          } else {
            verified.next = "mark-ready";
          }
          return verified;
        }
      }
    },

    /**
     * START A SELL FROM A VERIFIED RELAY OFFER. The offer is the result of `quotes.firmRelay` for the bid side;
     * the record keeps the one-time address, the escrow, our half, the order expectations and the relay origin, so a
     * reload can continue with `get` + `sellWatch` + `sellClaim`. The optional `claimSender` is a legacy
     * single-sender fallback; `claimViaRelay` takes the client's ordered list at claim time. This method sends nothing.
     */
    async startSell(request) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      const offer = request.offer && typeof request.offer === "object" ? request.offer : null;
      if (!offer) throw new SdkError("bad-input", { field: "offer" });
      const order = offer.order && typeof offer.order === "object" ? offer.order : null;
      const quote = offer.quote && typeof offer.quote === "object" ? offer.quote : null;
      if (!order || !quote) throw new SdkError("bad-input", { field: "offer", missing: ["order", "quote"] });
      if (typeof offer.jointAddress !== "string" || !offer.jointAddress) throw new SdkError("bad-input", { field: "offer.jointAddress" });
      if (typeof offer.escrow !== "string" || !offer.escrow) throw new SdkError("bad-input", { field: "offer.escrow" });
      // THE RELAY ORIGIN IS PART OF THE OFFER. It is stored with the record so a later claim goes back to the relay
      // that answered this quote; an origin that is present but not https is refused here, not at claim time.
      const offerRelay = offer.relayUrl === undefined || offer.relayUrl === null || offer.relayUrl === ""
        ? null : relayOriginOf(offer.relayUrl);
      // THE NODE'S WINDOW IS PART OF THE OFFER. `firmRelay` took it from the signed features; a hand-built offer
      // without one is stored as null, and `sellWatch`/`refundIfXmrMissing` refuse by name instead of using the
      // old local 1200 s or 20-minute numbers.
      const offerWindowRaw = offer.readyWindow || (quote && quote.readyWindow) || null;
      const offerWindow = offerWindowRaw
        ? readReadyWindow(offerWindowRaw, { side: "bid", field: "offer.readyWindow" }) : null;
      // THE RECORD'S ROLE IS THE BID ROLE. The node is the locker and the person is the claimer; a quote whose
      // addresses or factory disagree with the order is not the offer this record describes.
      const sameValue = (a, b) => String(a || "").replace(/^0x/, "").toLowerCase() === String(b || "").replace(/^0x/, "").toLowerCase();
      if (!sameValue(quote.locker, order.locker) || !sameValue(quote.claimer, order.claimer)
        || !sameValue(quote.provider, order.locker)
        || !sameValue(quote.factory, order.factory) || Number(quote.chainId) !== Number(order.chainId)) {
        throw new SdkError("quote-refused", { step: "sell-record", why: "terms" });
      }
      // THE SENDER IS CHOSEN BY THE CLIENT, NOT THE DEAL'S MAKER. The record keeps it so a reload claims through
      // the same node; a sender naming the maker or the quote key owner would reveal the half to the party that
      // must never receive it.
      const dealMaker = addressTextOf(quote.provider, "provider");
      const quoteKeyOwner = quote.quoteKey === undefined || quote.quoteKey === null
        || String(quote.quoteKey).trim() === "" ? null : addressTextOf(quote.quoteKey, "quoteKey");
      const requestedSender = request.claimSender === undefined || request.claimSender === null
        || String(request.claimSender).trim() === "" ? null : addressTextOf(request.claimSender, "claimSender");
      if (requestedSender && requestedSender === dealMaker) {
        throw new SdkError("bad-input", { field: "claimSender", why: "is-deal-maker" });
      }
      if (requestedSender && quoteKeyOwner && requestedSender === quoteKeyOwner) {
        throw new SdkError("bad-input", { field: "claimSender", why: "is-quote-key" });
      }
      // THE RECORD IS FOUND BEFORE A SECOND ONE IS MADE. The same offer retried after a reload yields the same
      // one-time address and escrow; a second record would be a second promise about one deal.
      const quoteId = quote.id || quote.nonce || null;
      const existing = records().find((swap) => swap.side === "sell" &&
        ((swap.escrow && String(swap.escrow.address || "").toLowerCase() === String(offer.escrow).toLowerCase()) ||
          (quoteId !== null && String(swap.orderQuoteId || "") === String(quoteId))));
      if (existing) {
        // A RETRY IS THE SAME OFFER, NOT A NEW ONE THAT HAPPENS TO NAME THE SAME ESCROW. The stored fields are
        // the commitment the first call verified; a changed point or commitment is refused before it is resumed.
        const stored = existing.quote && typeof existing.quote === "object" ? existing.quote : {};
        const same = (a, b) => String(a || "").replace(/^0x/, "").toLowerCase() === String(b || "").replace(/^0x/, "").toLowerCase();
        if (!same(stored.commitHalfClaimer, quote.commitHalfClaimer)
          || !same(stored.edPointClaimer, quote.edPointClaimer)
          || !same(existing.escrow && existing.escrow.moneroAddress, offer.jointAddress)) {
          throw new SdkError("quote-refused", { step: "sell-record", why: "offer-changed" });
        }
        const storedSender = existing.claimSender ? addressTextOf(existing.claimSender, "claimSender") : null;
        // THE OLD SCALAR IS NOT A PIN. A reload may name another sender or bring the ordered list at claim time; the
        // record keeps the latest scalar only for callers that still use it.
        if (requestedSender && requestedSender !== storedSender) {
          existing.claimSender = requestedSender;
          delete existing.claimSenders;
          try { engine.swap.saveSwap(existing, store); }
          catch { throw new SdkError("storage-unavailable", { step: "save-claim-sender" }); }
        }
        // THE RELAY IS PART OF THE VERIFIED OFFER. A claim later goes to the origin that answered this quote, so
        // a resumed offer naming another origin is a different offer; one that now names the same origin fills a
        // record made before the origin was kept.
        const storedRelay = existing.relayUrl ? relayOriginOf(existing.relayUrl) : null;
        if (offerRelay && storedRelay && offerRelay !== storedRelay) {
          throw new SdkError("quote-refused", { step: "sell-record", why: "relay-changed" });
        }
        await sellEscrowGate((existing.escrow && existing.escrow.address) || offer.escrow, existing.expect || null, request.wallet);
        if (offerRelay && !storedRelay) {
          existing.relayUrl = offerRelay;
          try { engine.swap.saveSwap(existing, store); }
          catch { throw new SdkError("storage-unavailable", { step: "save-relay" }); }
        }
        const storedWindow = existing.readyWindow || existing.sellWindow || null;
        if (offerWindow && storedWindow) {
          const a = readReadyWindow(storedWindow, { side: "bid", field: "readyWindow" });
          if (a.readyMinSeconds !== offerWindow.readyMinSeconds || a.readyMaxSeconds !== offerWindow.readyMaxSeconds) {
            throw new SdkError("quote-refused", { step: "sell-record", why: "window-changed" });
          }
        }
        if (offerWindow && !storedWindow) {
          existing.readyWindow = offerWindow;
          try { engine.swap.saveSwap(existing, store); }
          catch { throw new SdkError("storage-unavailable", { step: "save-window" }); }
        }
        return { id: existing.id, side: "sell", escrow: (existing.escrow && existing.escrow.address) || offer.escrow,
          address: (existing.escrow && existing.escrow.moneroAddress) || offer.jointAddress,
          xmrAmount: (existing.escrow && existing.escrow.xmrAmount) || quote.xmrAmount,
          claimTip: existing.claimTip || quote.claimTip, orderQuote: existing.orderQuote || offer.orderQuote,
          claimSender: existing.claimSender || null,
          readyWindow: existing.readyWindow || existing.sellWindow || null,
          resumed: true, next: "send-xmr" };
      }
      const storage = store.storage();
      const supplied = typeof request.recoveryKey === "string"
        ? request.recoveryKey
        : request.recoveryKey && typeof request.recoveryKey.mnemonic === "string" ? request.recoveryKey.mnemonic : null;
      const saved = loadRecoveryKey(storage);
      if (saved && supplied && saved.mnemonic !== supplied) throw new SdkError("bad-input", { field: "recoveryKey", why: "different-key" });
      if (!saved && !supplied) throw new SdkError("bad-input", { field: "recoveryKey" });
      const key = saved || importRecoveryKey(supplied);
      if (!saved) saveRecoveryKey(storage, { ...key, backupConfirmed: false });
      // A SELL CARRIES THE SAME KEY AS A BUY, SO IT NEEDS THE SAME BACKUP GATE. The one-time XMR address is the
      // moment the seller can lose money; handing it out before the twelve words are saved turns a closed tab into
      // an unrecoverable sale. The buy path already refuses to fund until this flag is true.
      if (!saved || saved.backupConfirmed !== true) {
        if (typeof request.onRecoveryKey !== "function") throw new SdkError("bad-input", { field: "onRecoveryKey" });
        let file = null;
        try {
          file = {
            name: recoveryKeyFileName(key),
            contents: await createRecoveryKeyFile({ mnemonic: key.mnemonic, createdAt: key.createdAt, passphrase: request.passphrase }),
          };
        } catch { throw new SdkError("recovery-failed", { step: "encrypt-key" }); }
        const confirmed = await request.onRecoveryKey(file);
        if (confirmed !== true) throw new SdkError("recovery-declined", { key: key.fingerprint });
        try { saveRecoveryKey(storage, { ...key, backupConfirmed: true }); }
        catch { throw new SdkError("storage-unavailable", { step: "save-recovery-key" }); }
      }
      const chainId = Number(order.chainId);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new SdkError("bad-input", { field: "order.chainId" });
      if (!order.factory || order.salt === undefined || order.salt === null) throw new SdkError("bad-input", { field: "order" });
      let salt = null;
      try { salt = recoverySaltOf(offer.recovery && offer.recovery.salt ? offer.recovery.salt : order.salt); }
      catch { throw new SdkError("bad-input", { field: "offer.recovery" }); }
      const derived = takerHalvesV2({ mnemonic: key.mnemonic, chainId, factory: order.factory, salt });
      const own = buildOwnSideFromHalvesKnown(order, { spendHalf: derived.spendHalf, viewHalf: derived.viewHalf });
      // THE OFFER MUST NAME THE HALF THIS KEY ACTUALLY PRODUCES. The relay already checked the proof; the record
      // needs the same point and commitment, otherwise a later claim would reveal a half the escrow rejects.
      // THE COMMITMENT COMES FROM THE HALF, NOT FROM A SECOND PROOF. `buildOwnSideFromHalvesKnown` derives it with
      // the same builder the contract mirrors; the side carries no proof because the firm answer already did.
      const ownCommit = own.commitHalf;
      // THE WHOLE COMMITMENT, NOT ITS LOW 160 BITS. `findSwaps` compares all 32 bytes, so a bid whose high 96 bits
      // differ would be invisible to a words-only search while `startSell` accepted it.
      const fullHex = (v) => String(v || "").replace(/^0x/, "").toLowerCase();
      if (!ownCommit || fullHex(ownCommit) !== fullHex(quote.commitHalfClaimer)) {
        throw new SdkError("quote-refused", { step: "sell-record", why: "commitment" });
      }
      if (String(own.spendPoint).toLowerCase() !== String(quote.edPointClaimer || "").toLowerCase()) {
        throw new SdkError("quote-refused", { step: "sell-record", why: "spend-point" });
      }
      if (offer.edViewPointClaimer && String(own.viewPoint).toLowerCase() !== String(offer.edViewPointClaimer).toLowerCase()) {
        throw new SdkError("quote-refused", { step: "sell-record", why: "view-point" });
      }
      const made = recordModule.createRecord({
        side: "sell", network: String(order.chainId),
        moneroNetwork: xmrNetwork || undefined,
        payToken: order.asset || quote.asset || undefined,
        payAmount: quote.amount, xmrAmount: Number(quote.xmrAmount) / 1e12,
        orderQuoteId: quoteId || undefined,
        receiveAddress: order.claimer,
        makerId: quote.provider || null,
      }, { order, side: own.side, store });
      const swap = made.swap;
      swap.side = "sell";
      swap.order = order;
      swap.orderQuote = offer.orderQuote || null;
      swap.quote = quote;
      swap.claimTip = quote.claimTip || null;
      // THE CLAIM SENDER IS PART OF THE OFFER, NOT A LATER CHOICE. Keeping it means a reload cannot silently
      // send the half to a different node than the one the client selected.
      if (requestedSender) swap.claimSender = requestedSender;
      swap.expect = {
        chainId, factory: order.factory, locker: order.locker, claimer: order.claimer, amount: String(order.amount),
        readyBy: order.readyBy, t1: order.t1, salt: order.salt,
        commitHalfLocker: (offer.nodeHalf && offer.nodeHalf.commitHalf) || null,
        edPointLocker: (offer.nodeHalf && offer.nodeHalf.edPoint) || null,
        edViewPointLocker: offer.edViewPointLocker || null,
        commitHalfClaimer: quote.commitHalfClaimer || null,
        edPointClaimer: quote.edPointClaimer || null,
      };
      swap.escrow = { ...(swap.escrow || {}),
        address: offer.escrow, moneroAddress: offer.jointAddress,
        half: halfHex(own.side.half), viewHalf: halfHex(own.side.viewHalf),
        edPointClaimer: own.spendPoint, edViewPointClaimer: norm(own.side.viewPub),
        commitHalfClaimer: quote.commitHalfClaimer,
        edPointLocker: (offer.nodeHalf && offer.nodeHalf.edPoint) || null,
        edViewPointLocker: offer.edViewPointLocker || null,
        commitHalfLocker: (offer.nodeHalf && offer.nodeHalf.commitHalf) || null,
        orderContext: offer.context || null, xmrAmount: quote.xmrAmount || null,
      };
      // KEPT WITH THE RECORD, NOT BUILT LATER: the claim and the watch use the relay and window that signed this
      // offer, not a value the page chose after the quote.
      if (offerRelay) swap.relayUrl = offerRelay;
      if (offerWindow) swap.readyWindow = offerWindow;
      // THE RECORD IS NOT A RECEIPT FOR A GATE THAT FAILED. createRecord has already written it, so a refusal
      // from the escrow/deadline/slot gate must remove it again; otherwise the interface lists send-xmr for an
      // order the SDK never checked.
      try {
        await sellEscrowGate(offer.escrow, swap.expect, request.wallet);
      } catch (error) {
        try { engine.swap.forgetSwap(swap.id, store); } catch { /* the gate's refusal is the actionable one */ }
        throw error;
      }
      try { engine.swap.saveSwap(swap, store); } catch { throw new SdkError("storage-unavailable", { step: "save-swap" }); }
      return { id: swap.id, side: "sell", escrow: offer.escrow, address: offer.jointAddress,
        xmrAmount: quote.xmrAmount, claimTip: quote.claimTip || null, orderQuote: offer.orderQuote || null,
        claimSender: swap.claimSender || null,
        readyWindow: swap.readyWindow || null, resumed: false, next: "send-xmr" };
    },

    /**
     * CLAIM THE ETH ON A SELL. The half and the expectations are in the record made by `startSell`; the sender
     * must be the claimer's own wallet.
     */
    async sellClaim(request, wallet) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      const id = String(request.id || "").trim();
      if (!id) throw new SdkError("bad-input", { field: "id" });
      let swap = null;
      try { swap = engine.swap.getSwap(id, store); } catch { swap = null; }
      if (!swap || swap.side !== "sell") throw new SdkError("bad-input", { field: "id", why: "sell-not-found" });
      const escrow = request.escrow || (swap.escrow && swap.escrow.address) || null;
      const halfClaimer = request.halfClaimer || (swap.escrow && swap.escrow.half) || null;
      if (!escrow || !halfClaimer) throw new SdkError("bad-input", { field: "escrow", missing: ["escrow", "halfClaimer"] });
      const expect = request.expect || swap.expect || null;
      if (!expect) throw new SdkError("bad-input", { field: "expect", why: "not-in-record" });
      return actions.claim({ escrow, halfClaimer, claimer: swap.order && swap.order.claimer,
        expect, onStep: request.onStep }, wallet);
    },

    /**
     * CLAIM THE ETH ON A SELL WITHOUT A WALLET.
     *
     * The seller holds XMR and no ETH, so the escrow pays the signed `claimTip` to whoever submits the claim.
     * `claimSenders` is the client's ordered list: the relay's own sender first, then the listed makers. The SDK
     * sends the half to one sender at a time through `POST /v1/claims/{sender}/{escrow}`; a refusal moves on at once,
     * a txid or unknown answer is followed by reading the escrow for the rest of that sender's 15-30 s slot, and
     * only `claimed` on chain is success. An exhausted list returns `state: "claim-yourself"` with the time left
     * before `t1`. The deal's maker and its quote-key owner are refused before the half leaves the client. This
     * method never creates or uses a wallet and never signs a chain transaction; `sellClaim` remains that path.
     */
    async claimViaRelay(request = {}) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      const id = String(request.id === undefined || request.id === null ? "" : request.id).trim();
      if (!id) throw new SdkError("bad-input", { field: "id" });
      let swap = null;
      try { swap = engine.swap.getSwap(id, store); } catch { swap = null; }
      if (!swap || swap.side !== "sell") throw new SdkError("bad-input", { field: "id", why: "sell-not-found" });

      // THE TIP PAYS THE SENDER. A zero tip is not a claim the relay can make: the node would pay the gas for
      // nothing, and the request would be refused after the half had already left the client. Refuse here.
      let tip = 0n;
      try { tip = BigInt(swap.claimTip === undefined || swap.claimTip === null || swap.claimTip === "" ? 0 : swap.claimTip); }
      catch { throw new SdkError("bad-input", { field: "claimTip", why: "unreadable" }); }
      if (tip <= 0n) throw new SdkError("bad-input", { field: "claimTip", why: "not-positive" });

      // THE DEAL'S MAKER IS THE ONE PARTY THAT MUST NOT RECEIVE THE HALF. It is the quote's provider and, on a
      // sell, the order's locker. The sender is a different node, chosen by the client; a record with no sender
      // cannot be claimed through a guess.
      const quote = swap.quote && typeof swap.quote === "object" ? swap.quote : {};
      const order = swap.order && typeof swap.order === "object" ? swap.order : {};
      const escrowRecord = swap.escrow && typeof swap.escrow === "object" ? swap.escrow : {};
      const makerRaw = quote.provider !== undefined && quote.provider !== null ? quote.provider
        : (escrowRecord.providerId !== undefined && escrowRecord.providerId !== null ? escrowRecord.providerId : order.locker);
      if (makerRaw === undefined || makerRaw === null || makerRaw === "") {
        throw new SdkError("bad-input", { field: "provider", why: "not-in-record" });
      }
      const maker = addressTextOf(makerRaw, "provider");
      for (const [field, value] of [["order.locker", order.locker], ["quote.locker", quote.locker]]) {
        if (value !== undefined && value !== null && String(value) !== "") {
          if (addressTextOf(value, field) !== maker) {
            throw new SdkError("quote-refused", { step: "relay-claim", why: "provider" });
          }
        }
      }
      const quoteKeyOwner = quote.quoteKey === undefined || quote.quoteKey === null
        || String(quote.quoteKey).trim() === "" ? null : addressTextOf(quote.quoteKey, "quoteKey");
      const storedSenderRaw = swap.claimSender === undefined || swap.claimSender === null
        || String(swap.claimSender).trim() === "" ? null : swap.claimSender;
      const requestedSenderRaw = request.claimSender === undefined || request.claimSender === null
        || String(request.claimSender).trim() === "" ? null : request.claimSender;
      // THE ORDER IS THE CLIENT'S, NOT THE RECORD'S. A list passed now wins; the old scalar and the stored value are
      // only one-element fallbacks for callers written before the list existed. Neither is a pin: the next sender is
      // tried when this one refuses or its slot ends.
      if (request.claimSenders !== undefined && !Array.isArray(request.claimSenders)) {
        throw new SdkError("bad-input", { field: "claimSenders", why: "not-an-array" });
      }
      const explicitList = Array.isArray(request.claimSenders) ? request.claimSenders : null;
      if (explicitList && explicitList.length === 0) {
        throw new SdkError("bad-input", { field: "claimSenders", why: "empty" });
      }
      if (explicitList && requestedSenderRaw) {
        throw new SdkError("bad-input", { field: "claimSenders", why: "with-claim-sender" });
      }
      const rawSenders = explicitList || (requestedSenderRaw ? [requestedSenderRaw] : null)
        || (Array.isArray(swap.claimSenders) ? swap.claimSenders : null)
        || (storedSenderRaw ? [storedSenderRaw] : []);
      if (!rawSenders.length) throw new SdkError("bad-input", { field: "claimSenders", why: "not-in-record" });
      const senders = [];
      for (const raw of rawSenders) {
        if (raw === undefined || raw === null || String(raw).trim() === "") {
          throw new SdkError("bad-input", { field: "claimSenders", why: "empty" });
        }
        const sender = addressTextOf(raw, "claimSenders");
        if (sender === maker) throw new SdkError("bad-input", { field: "claimSenders", why: "is-deal-maker" });
        if (quoteKeyOwner && sender === quoteKeyOwner) {
          throw new SdkError("bad-input", { field: "claimSenders", why: "is-quote-key" });
        }
        if (!senders.includes(sender)) senders.push(sender);
      }
      if (!senders.length) throw new SdkError("bad-input", { field: "claimSenders", why: "not-in-record" });
      if (escrowRecord.address === undefined || escrowRecord.address === null || escrowRecord.address === "") {
        throw new SdkError("bad-input", { field: "escrow", why: "not-in-record" });
      }
      const escrow = addressTextOf(escrowRecord.address, "escrow");
      const halfClaimer = halfTextOf(escrowRecord.half);
      // THE ORIGIN IS THE QUOTE'S, NOT THE CALLER'S. The record stores the relay that answered; a request may
      // repeat it (with a trailing slash), but may not choose another one after the quote.
      if (swap.relayUrl === undefined || swap.relayUrl === null || swap.relayUrl === "") {
        throw new SdkError("bad-input", { field: "relayUrl", why: "not-in-record" });
      }
      const relayUrl = relayOriginOf(swap.relayUrl);
      if (request.relayUrl !== undefined && request.relayUrl !== null && String(request.relayUrl).trim() !== "") {
        if (relayOriginOf(request.relayUrl) !== relayUrl) {
          throw new SdkError("bad-input", { field: "relayUrl", why: "foreign-relay" });
        }
      }
      // A LIST IS NOT A PIN. It is saved only as the fallback for a reload whose caller no longer has the relay's
      // answer; a later request that brings its own order ignores it.
      if (!Array.isArray(swap.claimSenders) || swap.claimSenders.length !== senders.length
        || swap.claimSenders.some((value, index) => String(value).toLowerCase() !== senders[index])) {
        swap.claimSenders = senders;
        swap.claimSender = senders[0];
        try { engine.swap.saveSwap(swap, store); }
        catch { throw new SdkError("storage-unavailable", { step: "save-claim-senders" }); }
      }

      const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0
        ? Number(request.timeoutMs) : 20_000;
      // ONE SENDER AT A TIME, EACH WITH ITS OWN SLOT. Refusal moves on immediately; an accepted/unknown answer is
      // followed by reading the escrow until it says claimed or the slot ends. A txid alone is never success.
      const slotMs = Number.isFinite(Number(request.slotMs)) && Number(request.slotMs) > 0
        ? Math.min(30_000, Math.max(15_000, Number(request.slotMs))) : 20_000;
      const pollMs = Number.isFinite(Number(request.pollMs)) && Number(request.pollMs) > 0
        ? Math.min(slotMs, Number(request.pollMs)) : 2_000;
      const readStatus = async () => {
        try { return await flow.orderStatus(escrow, { call: reader }); }
        catch (error) {
          // AN UNREAD ESCROW IS NOT AN OPEN ONE. The caller must not be told to claim a sale whose state we could
          // not read; the half may already have landed. This is the same unknown state as a lost relay answer.
          throw new SdkError("claim-unknown", { step: "relay-claim", why: "escrow-unread",
            detail: String((error && error.message) || error).slice(0, 160) });
        }
      };
      const t1Raw = order.t1 ?? (swap.expect && swap.expect.t1);
      let t1 = Number.isSafeInteger(Number(t1Raw)) && Number(t1Raw) > 0 ? Number(t1Raw) : null;
      const secondsLeft = () => (t1 === null ? null : Math.max(0, t1 - Math.floor(clockMs() / 1000)));
      // THE CLAIM WINDOW BELONGS TO THE CONTRACT, NOT TO THE RELAY. The relay can forward any half it is given, so
      // the client must refuse to hand it over before `readyBy` without the ready mark, after `t1`, and inside the
      // settlement margin when neither a sender nor the seller's own claim can still land. The check reads the
      // escrow's ready mark and both deadlines for EVERY sender, not once for the whole list: a slot can cross a
      // boundary while the previous sender is being polled.
      const CLAIM_MARGIN_SEC = 120;
      const SELLER_CLAIM_SEC = 60;
      const windowOf = async () => {
        let deadlines;
        try { deadlines = await flow.orderDeadlines(escrow, { call: reader }); }
        catch { return { ok: false, reason: "unreadable" }; }
        const t1Sec = Number(deadlines.t1);
        const readyBySec = Number(deadlines.readyBy);
        const nowSec = Math.floor(clockMs() / 1000);
        if (![t1Sec, readyBySec, nowSec].every(Number.isSafeInteger)) {
          return { ok: false, reason: "unreadable" };
        }
        let marked;
        try {
          const raw = await reader({ to: escrow, data: engine.evm.encodeRead("ready") });
          marked = BigInt(String(raw || "").replace(/^0x/, "") || "0") !== 0n;
        } catch { return { ok: false, reason: "unreadable" }; }
        if (nowSec >= t1Sec) return { ok: false, reason: "window-closed" };
        // A SEND LANDS IN A LATER BLOCK. The last 120 s belong to the relay's settlement margin, and the seller
        // still needs a slot plus time for their own claim if the relay cannot land it.
        if (nowSec + CLAIM_MARGIN_SEC + Math.ceil(slotMs / 1000) + SELLER_CLAIM_SEC >= t1Sec) {
          return { ok: false, reason: "settlement-margin" };
        }
        if (nowSec < readyBySec && !marked) return { ok: false, reason: "not-ready" };
        return { ok: true, t1: t1Sec, readyBy: readyBySec, nowSec };
      };
      const windowResult = (reason, tried) => ({
        id, state: "claim-window", reason, provider: null, claimSender: null, escrow, relayUrl,
        txid: null, from: null, tipWei: tip.toString(), t1, secondsLeft: secondsLeft(), tried,
      });
      const STOP_ESCROW_CODES = new Set([
        "claim-not-ready", "claim-window-closed", "claim-settlement-margin",
        "claim-not-funded", "claim-already-closed", "claim-half-invalid",
      ]);
      const claimedByEscrow = (sender = null, answer = null, tried = []) => ({
        id, state: "claimed", provider: sender, claimSender: sender, escrow, relayUrl,
        txid: answer ? answer.txid : null, from: (answer && answer.from) || null,
        tipWei: (answer && answer.tipWei) || tip.toString(), tried,
      });
      // A CLAIM THAT ALREADY LANDED IS NOT A REASON TO SEND THE HALF AGAIN. The caller may have lost the answer on
      // the previous attempt; read the escrow before the first POST, and read it once more before returning
      // `claim-yourself`, so a late claim cannot be reported as "claim yourself".
      const initial = await readStatus();
      if (initial.isClaimed) return claimedByEscrow();
      if (!initial.isFunded) return windowResult("not-funded", []);
      let refunded = Boolean(initial.isRefunded);
      const tried = [];
      if (!refunded) for (const sender of senders) {
        const gate = await windowOf();
        if (!gate.ok) return windowResult(gate.reason, tried);
        if (gate.t1 !== null) t1 = gate.t1;
        let answer = null;
        let failure = null;
        try {
          answer = await postRelayClaim({
            relayUrl, provider: sender, escrow, halfClaimer, expectedTipWei: tip,
            fetchImpl: request.fetchImpl || fetchImpl || null, timeoutMs,
          });
        } catch (error) {
          failure = error;
        }
        // A REFUSAL IS THE SENDER'S ANSWER, NOT A CLAIM IN FLIGHT. Move to the next one at once; only an unknown
        // outcome (or a txid, which is not yet a claim on chain) deserves the slot. An escrow-state refusal is
        // different: it says the order itself is closed, so trying another sender would publish the half for no
        // reason. Read the escrow and stop.
        if (failure && failure.code !== "claim-unknown") {
          tried.push({ sender, outcome: "refused", code: failure.code || "unknown",
            params: failure.params || null });
          if (STOP_ESCROW_CODES.has(String((failure.params && failure.params.code) || ""))) {
            const stopped = await readStatus();
            if (stopped.isClaimed) return claimedByEscrow(sender, null, tried);
            if (stopped.isRefunded) return windowResult("escrow-refunded", tried);
            return windowResult("escrow-refused", tried);
          }
          continue;
        }
        const slotEnd = clockMs() + slotMs;
        for (;;) {
          const status = await readStatus();
          if (status && status.isClaimed) {
            swap.claimSender = sender;
            try { engine.swap.saveSwap(swap, store); } catch { /* the chain already says claimed */ }
            return claimedByEscrow(sender, answer, tried);
          }
          if (status && status.isRefunded) { refunded = true; break; }
          const left = slotEnd - clockMs();
          if (left <= 0) break;
          await sleepFor(Math.min(pollMs, left));
        }
        tried.push({ sender, outcome: failure ? "unknown" : "unconfirmed",
          txid: answer ? answer.txid : null, code: failure ? failure.code : null });
        if (refunded) break;
      }

      // THE LAST LOOK BEFORE THE FALLBACK. A claim can land after the last slot ended or while a later sender is
      // refusing; the seller must not be sent to `sellClaim` on an escrow that is already closed as claimed.
      const finalStatus = await readStatus();
      if (finalStatus.isClaimed) {
        try { engine.swap.saveSwap(swap, store); } catch { /* the chain already says claimed */ }
        return claimedByEscrow(null, null, tried);
      }
      if (finalStatus.isRefunded) refunded = true;
      if (!finalStatus.isFunded) return windowResult("not-funded", tried);
      const finalGate = await windowOf();
      if (!finalGate.ok) return windowResult(finalGate.reason, tried);
      return { id, state: "claim-yourself", reason: refunded ? "escrow-refunded" : "senders-exhausted",
        provider: null, claimSender: null, escrow, relayUrl, txid: null, from: null, tipWei: tip.toString(),
        t1, secondsLeft: secondsLeft(), tried };
    },

    /**
     * WAIT FOR THE NODE'S SIDE ON A SELL. The client sends XMR to the one-time joint address; the node (the
     * locker) must mark the order ready before the claimer can take the ETH. This reads the escrow itself - no
     * backend watcher - and returns as soon as the chain says ready, claimed or refunded.
     */
    async sellWatch(request) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      const escrow = String(request.escrow || "").trim();
      if (!escrow) throw new SdkError("bad-input", { field: "escrow" });
      // THE NODE'S WINDOW IS READ FROM THE RECORD BY THE ESCROW. A reload keeps only the address in hand; the
      // stored `startSell` record carries the range the maker signed, so the wait is not the old fixed 20 minutes.
      const storedSwap = swapByEscrow(store, escrow);
      const readyWindowRaw = request.readyWindow || (storedSwap && (storedSwap.readyWindow || storedSwap.sellWindow)) || null;
      const pollMs = Number.isFinite(Number(request.pollMs)) && Number(request.pollMs) > 0
        ? Number(request.pollMs) : limitOf("watchPollMs", 6_000);
      const explicitTimeout = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0;
      const readyWindow = !explicitTimeout && readyWindowRaw
        ? readReadyWindow(readyWindowRaw, { side: "bid", field: "readyWindow" }) : null;
      if (!readyWindow && !explicitTimeout) {
        throw new SdkError("bad-input", { field: "readyWindow", why: "not-in-record" });
      }
      let timeoutMs = explicitTimeout ? Number(request.timeoutMs) : null;
      if (!explicitTimeout) {
        try {
          const deadlines = await flow.orderDeadlines(escrow, { call: reader });
          timeoutMs = sellWatchTimeoutMs({ configuredMs: readyWindowMs(readyWindow), readyBySec: deadlines.readyBy });
        } catch {
          // NO DEADLINE READ: the node's own maximum horizon is the bound, not a second local 20-minute number.
          timeoutMs = readyWindowMs(readyWindow);
        }
      }
      // THE CLAIM OPENS AT readyBy WITHOUT A MARK. The deadline comes from the escrow once; the clock is the
      // facade's own millisecond seam, so a simulation and a caller that controls time agree with the rest of
      // the SDK. A failed deadline read does not invent a claim window.
      let deadlines = null;
      try { deadlines = await flow.orderDeadlines(escrow, { call: reader }); }
      catch { /* no deadline: the wait keeps its configured timeout and never reports claim-open */ }
      const nowSec = () => {
        const at = typeof now === "function" ? Number(now()) : Date.now();
        return Number.isFinite(at) ? Math.floor(at / 1000) : null;
      };
      const started = Date.now();
      let lastStatus = null;
      let lastError = null;
      for (;;) {
        try { lastStatus = await flow.orderStatus(escrow, { call: reader }); }
        catch (error) { lastError = (error && error.code) || "status-unread"; lastStatus = null; }
        if (lastStatus && (lastStatus.isClaimed || lastStatus.isRefunded)) {
          return { escrow, state: lastStatus.isClaimed ? "claimed" : "refunded",
            funded: lastStatus.isFunded, claimed: lastStatus.isClaimed, refunded: lastStatus.isRefunded,
            ready: null, claimOpen: false, balanceWei: String(lastStatus.balance), waitedMs: Date.now() - started };
        }
        if (lastStatus && lastStatus.isFunded) {
          let ready = null;
          try {
            const raw = await reader({ to: escrow, data: engine.evm.encodeRead("ready") });
            const hex = String(raw || "").replace(/^0x/, "");
            ready = hex.length > 0 && BigInt("0x" + hex) !== 0n;
          } catch (error) { lastError = (error && error.code) || "ready-unread"; }
          if (ready === true) {
            return { escrow, state: "ready", funded: true, claimed: false, refunded: false,
              ready: true, claimOpen: false, balanceWei: String(lastStatus.balance), waitedMs: Date.now() - started };
          }
        }
        // AFTER readyBy THE CLAIM IS OPEN EVEN WITHOUT THE NODE'S READY MARK. The order is funded, no terminal
        // action was seen, and the escrow's own deadline has passed; the seller can claim the ETH now.
        if (lastStatus && lastStatus.isFunded && deadlines && Number.isSafeInteger(Number(deadlines.readyBy))) {
          const at = nowSec();
          if (at !== null && at >= Number(deadlines.readyBy)) {
            return { escrow, state: "claim-open", funded: true, claimed: false, refunded: false,
              ready: false, claimOpen: true, balanceWei: String(lastStatus.balance), waitedMs: Date.now() - started };
          }
        }
        if (Date.now() - started >= timeoutMs) {
          throw new SdkError("sell-timeout", { escrow, waitedMs: Date.now() - started, timeoutMs,
            status: lastStatus, error: lastError });
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}
