// SWAPS: READING STATE AND STARTING.
//
// Here the SDK shows what already lies in storage (the engine's swap records) and starts a new swap. The SDK holds
// the step order of a start, not the interface: guards -> record and recovery file -> the person's confirmation ->
// order and halves -> server -> watching the Monero address. A lock without a recovery file is a lock with nothing
// to open it with if the browser is lost, so the confirmation stands BEFORE anything that locks funds.
import { SdkError } from "./errors.mjs";
import * as engine from "./engine.mjs";
// The name is NOT `record`: inside start there is a variable with that name, and referencing the module before it
// ran into "Cannot access 'record' before initialization" - a refusal without a code, that is, a breakdown. A check
// showed exactly that.
import * as recordModule from "./record.mjs";
// The order: our own side is built by the engine's builder, the counterparty's side is verified and accepted, and
// the joint address is assembled from the halves. There are no formulas of our own in the core - see order.mjs.
import { buildOwnSideFromHalves, contextOf, orderStep } from "./order.mjs";
// Locking the funds: sending goes through the already-finished step (`lock.send`), the wallet is an adapter from outside.
import * as lock from "./lock.mjs";
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
  commitRecoveryIndex, createRecoveryKeyFile, importRecoveryKey, loadRecoveryKey,
  recoveryIndexTaken, recoveryKeyFileName, recoverySaltOf, reserveRecoveryIndex, saveRecoveryKey,
  takerHalves, takerHalvesV2,
} from "./recovery-key.mjs";
// THE XMR ARRIVAL CHECK ON TWO NODES (issue #85) - IN THE CORE, from the same mirrored rule and block parser.
import * as xmrArrival from "./xmr-arrival.mjs";
// THE MAKER'S DECLINE (issue #40): the escrow's `Declined` event and the node's `declined` + `compliance` status
// are TWO independent sources of the same state, and either one is enough. The detectors and the neutral
// vocabulary live in one module, so this file names the state instead of re-reading the two.
import { declineOf, logReaderOf, blockBoundaryOf, DECLINED_TOPIC0, DECLINED_TERMINAL, DECLINED_CODE } from "./decline.mjs";

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

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

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
const MARK_FIELDS = ["id", "network", "escrow", "quoteId", "providerId", "hashlock", "amount", "t0", "t1"];
// THE FIELDS OF THE FACTORY WATCH RECORD - the same whitelist as the page client's
// (www/js/core/chainSource.js:33, ALLOWED_SESSION_FIELDS). The body is assembled FROM IT anew, so neither the spend
// half nor the spend key can get into the request, even if someone adds them to the record "just in case".
const ALLOWED_SESSION_FIELDS = ["swapId", "network", "address", "viewKey", "expectedAmountXmr", "restoreHeight", "chain"];

/**
 * The mark body from the swap record. THE FIELDS ARE THE SAME AND WITH THE SAME MEANING as the interface's
 * (auth.js:114-125), not a private list: only public data goes out (the escrow address, amounts, deadlines, the
 * quote reference), and nothing secret - the spend key never leaves the browser under any configuration.
 */
export function markBodyOf(swap, escrow, order = null) {
  const e = (swap && swap.escrow) || {};
  const o = order && typeof order === "object" ? order : {};
  // A BIGINT AS A STRING: the order amount in wei comes both as a string and as a BigInt number (the order terms),
  // and the request body is serialized to JSON, where a BigInt does not live at all (a TypeError on the very first
  // call). The app expects a string.
  const first = (...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null || v === "") continue;
      return typeof v === "bigint" ? v.toString() : v;
    }
    return null;
  };
  return {
    id: swap.id || null,
    network: swap.network || swap.chain || null,
    escrow: escrow || e.address || null,
    quoteId: first(swap.orderQuoteId, e.quoteId),
    providerId: first(swap.providerId, e.providerId),
    hashlock: first(e.hashlock, swap.hashlock),
    amount: first(e.amountWei, o.amount, swap.amountWei),
    t0: first(e.t0, o.t0),
    t1: first(e.t1, o.t1),
  };
}

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
export function incomingOf(session) {
  if (!session || typeof session !== "object") return null;
  const received = Number(session.receivedXmr);
  if (!Number.isFinite(received)) return null;
  const confirmations = Number(session.confirmations);
  // LOCKED FUNDS ARE ON THE ADDRESS BUT ARE NOT AN ARRIVAL THE SWAP CAN USE: the sender set unlock_time, and the
  // service names that state. `receivedXmr` counts only what can be spent; the barred sum is `lockedXmr`, and the
  // boundary (a height or a date) travels as `lockedUntil` so the interface can say until WHEN.
  const locked = session.status === LOCKED_STATUS;
  const lockedXmr = num(session.lockedXmr);
  return {
    id: session.id || null,
    address: session.address || null,
    status: session.status || null,
    expectedXmr: num(session.expectedAmountXmr),
    receivedXmr: received,
    confirmations: Number.isFinite(confirmations) ? confirmations : 0,
    txids: Array.isArray(session.fundingTxids) ? session.fundingTxids : [],
    locked,
    lockedXmr: lockedXmr === null ? 0 : lockedXmr,
    lockedUntil: session.lockedUntil || null,
    // AN ARRIVAL IS MONEY AT THE ADDRESS THAT IS NOT BARRED BY unlock_time. Zero, or locked, means none.
    seen: received > 0 && !locked,
  };
}

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
      receivedXmr: num(d.xmrAmount && d.xmrAmount.seen) ?? 0,
      escrowLocked: !!(swap.escrow && (swap.escrow.fundTx || swap.escrow.secret)),
    },
    pay: { token: swap.payToken || "eth", amount: num(swap.payAmount) ?? 0 },
    get: { xmr: num(swap.xmrAmount) ?? 0 },
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
const recordInputOf = (request) => {
  const quote = request && request.quote && typeof request.quote === "object" ? request.quote : {};
  const pass = (v) => (v === undefined || v === null || v === "" ? undefined : v);
  return {
    side: request.side || "buy",
    network: quote.chain ? quote.chain : undefined,
    payToken: quote.asset ? String(quote.asset).toLowerCase() : undefined,
    payAmount: quote.amount !== undefined ? quote.amount : undefined,
    xmrAmount: quote.size !== undefined ? quote.size : undefined,
    // THE ORDER-QUOTE ID IS PART OF THE RECORD, NOT A DETAIL OF THE SCREEN (a defect found): our service uses it to
    // tie the created escrow to the provider node's record, and without it the node cannot take the ETH
    // (sdk/src/swap-flow.mjs: quoteId: quote.id -> swap.orderQuoteId; markBodyOf reads exactly this field).
    orderQuoteId: pass(quote.id),
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
  const good = answers.find((answer) => answer.ok === true && (!network || answer.network === network));
  if (good) return good.height;
  const why = answers.find((answer) => answer.ok === true) ? "network" : (answers[0] && answers[0].why) || "no-node";
  throw new SdkError("xmr-no-nodes", { step: "restore-height", network: network || null, why });
}

export function createSwaps({ preflight, http, createRecord, mode = null, xmrNetwork = null, call = null,
  // THE PATHS AND LIMITS ARE BROUGHT BY THE CONFIGURATION: the "server" step's paths are named by names (config.route),
  // and the timeout and rate of the watch polling - in config.limits. Without the configuration the step answers with a
  // code rather than following invented paths.
  config = null,
  // A SIGN-IN PASS - A SEAM FROM OUTSIDE. Only a wallet can sign the sign-in message, and its role in the core is an
  // adapter (send/receipt): windows and message signatures remain the interface's. A READY pass arrives here (as
  // www/js/evm/auth.js, signIn obtains it today), and the core merely presents it.
  auth = null,
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
  // THE SAME RULE FOR THE LOGS: one reader per facade, chosen once.
  const logReader = logReaderOf(chainLogs);
  // MARKING READY GOES THROUGH THE SAME READ SEAM as the lock: checking the slots and signing must go one way,
  // otherwise part of the check goes past the wallet and part does not (see actions.mjs).
  const actions = createActions({ call: typeof call === "function" ? call : null });
  const routeOf = (name, params) => {
    if (!config || typeof config.route !== "function") throw new SdkError("bad-input", { field: "config", step: "server" });
    return config.route(name, params);
  };
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
      fetchImpl: request.fetchImpl || (typeof fetch === "function" ? fetch : null) });
  }
  const records = () => {
    const state = engine.store.loadState();
    const all = Object.values((state && state.swaps) || {}).filter((s) => s && s.id);
    return all.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  };

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

  /**
   * RECORDING THE SWAP WITH US. The path and body are the interface's (see the step description above). A refusal is
   * called by a CODE and carries the service's response in full: the connection never got through - server-unavailable,
   * the service answered and did not accept - server-refused (with the status and ITS reason). The code is named so the
   * interface itself decides whether to abort the swap: today it does not abort it (www/js/evm/auth.js:15-16), and that
   * is its decision, not the core's silence.
   */
  async function markOnServer(swap, escrow, order) {
    if (!http || typeof http.tryJson !== "function") throw new SdkError("bad-input", { field: "http", step: "mark" });
    const mark = markBodyOf(swap, escrow, order);
    const body = JSON.stringify(Object.fromEntries(MARK_FIELDS.map((field) => [field, mark[field]])));
    const headers = { "content-type": "application/json" };
    // THE PASS IS ASKED EVERY TIME, NOT CACHED: it is short-lived (an hour: app/server.mjs, AUTH_TOKEN_TTL_MS), and a
    // cached pass would give a 401 at a step that does not move money itself but shows the swap to the service.
    if (typeof auth === "function") {
      let token = null;
      try { token = await auth(); } catch { token = null; }
      if (typeof token === "string" && token) headers.authorization = "Bearer " + token;
    }
    let answer = null;
    try { answer = await http.tryJson(routeOf("evmSwaps"), { method: "POST", headers, body }); }
    catch (error) { throw new SdkError("server-unavailable", { step: "mark", why: (error && error.code) || "fetch" }); }
    if (!answer || answer.ok !== true) {
      throw new SdkError("server-refused", {
        step: "mark", status: answer ? answer.status : null,
        why: (answer && answer.body && (answer.body.error || answer.body.detail)) || null,
      });
    }
    return { marked: true, httpStatus: answer.status, orderBinding: (answer.body && answer.body.orderBinding) || null };
  }

  /**
   * THE FACTORY WATCH RECORD with our service: by the same POST /api/swaps the page makes
   * (www/js/ui/views/confirm.js:581). The address and the VIEW KEY go out - that is enough to see incoming payments,
   * and not enough to spend them.
   */
  async function openWatch(swap, order) {
    if (!http || typeof http.tryJson !== "function") throw new SdkError("bad-input", { field: "http", step: "watch" });
    const e = (swap && swap.escrow) || {};
    const address = e.moneroAddress || (swap.swapWallet && swap.swapWallet.address) || null;
    if (!address) throw new SdkError("bad-input", { field: "moneroAddress" });
    // THE EXPECTED AMOUNT IS MANDATORY, and this is not a formality: without it the watch cannot check the sufficiency of
    // the arrival, and the app does not accept such a record (app/store.mjs:85-94). A refusal is more honest than a
    // silent record by which an underpayment would look like a completed swap.
    const expectedXmr = num(order && order.xmrAmount !== undefined ? order.xmrAmount : swap.xmrAmount);
    if (!(expectedXmr > 0)) throw new SdkError("bad-input", { field: "expectedAmountXmr" });
    const network = swap.moneroNetwork || xmrNetwork || null;
    if (!network) throw new SdkError("bad-input", { field: "moneroNetwork" });
    const restoreHeight = Number(swap.restoreHeight) > 0 ? Number(swap.restoreHeight)
      : (Number(e.moneroRestoreHeight) > 0 ? Number(e.moneroRestoreHeight) : null);
    if (!(restoreHeight > 0)) throw new SdkError("bad-input", { field: "restoreHeight", step: "watch" });
    const wanted = {
      swapId: swap.id || null, network, address, viewKey: jointViewKey(swap), expectedAmountXmr: expectedXmr,
      // THE RESTORE HEIGHT - THE MONERO HEIGHT, NEVER THE EVM BLOCK. It is measured before the file is handed
      // over and kept on the record; `birthHeight`/`evmBirthBlock` is a settlement-chain block for log search and
      // is far above any Monero tip, so using it here opened the watch nowhere near the money.
      restoreHeight,
      chain: swap.network || swap.chain || null,
    };
    const body = {};
    for (const field of ALLOWED_SESSION_FIELDS) if (wanted[field] !== undefined && wanted[field] !== null) body[field] = wanted[field];
    // THE VIEW KEY IS NOT NEEDED BY THE SERVICE FOR THE DECISION ANY MORE: since the arrival is checked by the
    // client (verifyArrival), the backend may keep a watch only for notifications, and even that it can do from
    // the maker's txid. So sending the key is an OPTION: `watch.sendViewKeyToServer === false` drops it from the
    // record. The default keeps the current backend flow working until it stops deciding on its own.
    if (watchOptions && watchOptions.sendViewKeyToServer === false) delete body.viewKey;
    let answer = null;
    try { answer = await http.tryJson(routeOf("swaps"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch (error) { throw new SdkError("server-unavailable", { step: "watch", why: (error && error.code) || "fetch" }); }
    if (!answer || answer.ok !== true) {
      throw new SdkError("server-refused", {
        step: "watch", status: answer ? answer.status : null,
        why: (answer && answer.body && (answer.body.error || answer.body.detail)) || null,
      });
    }
    const session = incomingOf(answer.body);
    if (!session) throw new SdkError("server-unavailable", { step: "watch", why: "bad-response" });
    return { registered: true, httpStatus: answer.status, ...session,
      expectedXmr: session.expectedXmr !== null ? session.expectedXmr : expectedXmr };
  }

  /** THE WATCH STATE: GET /api/swaps/{id} - the same path as the page's (chainSource.js:184). */
  async function readWatch(id) {
    if (!http || typeof http.tryJson !== "function") throw new SdkError("bad-input", { field: "http", step: "watch" });
    let answer = null;
    try { answer = await http.tryJson(routeOf("swap", { id }), { method: "GET" }); }
    catch (error) { throw new SdkError("server-unavailable", { step: "watch", why: (error && error.code) || "fetch" }); }
    if (!answer || answer.ok !== true) {
      throw new SdkError("server-refused", {
        step: "watch", status: answer ? answer.status : null, id,
        why: (answer && answer.body && (answer.body.error || answer.body.detail)) || null,
      });
    }
    return answer.body;
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
      const swap = engine.swap.getSwap(id);
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
      return engine.swap.confirmReady(id);
    },
    async refundEth(id, by = "you") {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      return engine.swap.refundEth(id, by);
    },
    async sweepNow(id) {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      return engine.swap.sweepNow(id);
    },

    /**
     * WHERE TO WITHDRAW THE XMR. Sets the record's `receiveAddress` and saves it: the destination is part of the
     * recovery file, so the change is WRITTEN (named), not inferred. The order and the chain are untouched.
     * `null` - there is no such record.
     */
    async setDestination(id, address) {
      if (typeof id !== "string" || !id) throw new SdkError("bad-input", { field: "id" });
      if (typeof address !== "string" || !address) throw new SdkError("bad-input", { field: "address" });
      const swap = engine.swap.getSwap(id);
      if (!swap) return null;
      swap.receiveAddress = address;
      return engine.swap.saveSwap(swap);
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
      try { state = engine.store.loadState(); } catch { throw new SdkError("storage-unavailable", { step: "forget" }); }
      const swaps = state && state.swaps;
      if (!swaps || !swaps[id]) return false;
      delete swaps[id];
      try { engine.store.saveState(state); } catch { throw new SdkError("storage-unavailable", { step: "forget" }); }
      return true;
    },

    /**
     * THE SERVICE'S SWAP LIST, MERGED INTO THE LOCAL ONE. The path and the body are the page's
     * (www/js/evm/auth.js, loadServerSwaps: GET /api/evm-swaps, the address ties the list to the wallet). The
     * merge rule is the ENGINE'S (core/swap.js, addServerSwaps): a local record always wins, the service only
     * adds what this browser does not have, and the rules are not written a second time here. The pass is
     * obtained by the interface and only presented by the core (the `auth` seam), so an unauthenticated call is
     * the service's own refusal with a code, not a silent empty list.
     */
    async sync() {
      if (!http || typeof http.tryJson !== "function") throw new SdkError("bad-input", { field: "http", step: "sync" });
      const headers = {};
      if (typeof auth === "function") {
        let token = null;
        try { token = await auth(); } catch { token = null; }
        if (typeof token === "string" && token) headers.authorization = "Bearer " + token;
      }
      let answer = null;
      try { answer = await http.tryJson(routeOf("evmSwaps"), { method: "GET", headers }); }
      catch (error) { throw new SdkError("server-unavailable", { step: "sync", why: (error && error.code) || "fetch" }); }
      if (!answer || answer.ok !== true) {
        throw new SdkError("server-refused", {
          step: "sync", status: answer ? answer.status : null,
          why: (answer && answer.body && (answer.body.error || answer.body.detail)) || null,
        });
      }
      // A GARBAGE ANSWER IS A REFUSAL, NOT AN EMPTY LIST: a non-JSON body (an SPA fallback, a proxy error page) must
      // not look like "the service has no swaps" - the two are different, and only one of them means "synced".
      const body = answer.body;
      if (!body || !Array.isArray(body.swaps)) throw new SdkError("server-unavailable", { step: "sync", why: "bad-response" });
      const added = engine.swap.addServerSwaps(body.swaps);
      return { ok: true, added, seen: body.swaps.length };
    },

    // THE ARRIVAL VERDICT WITHOUT THE WATCH LOOP, and the deadline check as a separate call: an interface may
    // want to run both itself. The watch uses exactly these, so there is one decision, not two.
    verifyArrival: (request) => xmrArrival.verifyArrival(request),
    assertTimeForConfirmations: (request) => xmrArrival.assertTimeForConfirmations(request),

    /**
     * THE CLIENT'S OWN EARLY REFUND WHEN THE XMR DID NOT ARRIVE (issue #88). After `readyBy` the maker may claim
     * even without the ready mark, and the early-refund window closes; so while the interface is open a depositor
     * who sees no XMR must take the ETH back BEFORE `readyBy`. The arrival is decided by THE SAME rule the watch
     * uses (xmr-arrival.verifyArrival): two nodes of different operators on one block, and money barred by
     * unlock_time is not an arrival.
     *
     * ONLY A POSITIVE "NOT ARRIVED" REFUNDS (state `pending` or `one-node`). A failure to check - no reachable
     * node, a disagreement, an underpayment, locked money - is NOT "no money": verifyArrival throws its own code
     * and NOTHING is signed, so a broken or lagging witness can never look like an empty address.
     *
     * IT FIRES ONLY WHEN LESS THAN THE CONFIRMATIONS' TIME IS LEFT before `readyBy`
     * (`minConfirmations * blockTimeSec`, overridable with `leadSec`): refunding earlier would abandon a maker who
     * still has time to deliver. The refund goes through the same action seam as the screen (actions.refund), and
     * the order expectations are mandatory.
     *
     * The seams `deps.verify` / `deps.refund` / `deps.now` exist for the checks; in production they are the real
     * arrival check and the real refund.
     */
    async refundIfXmrMissing(request = {}, deps = {}) {
      const verify = typeof deps.verify === "function" ? deps.verify : xmrArrival.verifyArrival;
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
      let expectedAtomic = request.expectedAtomic !== undefined && request.expectedAtomic !== null
        ? request.expectedAtomic : (e.expectedAtomic !== undefined && e.expectedAtomic !== null ? e.expectedAtomic : null);
      if (expectedAtomic === null && swap && Number.isFinite(Number(swap.xmrAmount))) {
        expectedAtomic = BigInt(Math.round(Number(swap.xmrAmount) * 1e12)).toString();
      }
      if (expectedAtomic === null) throw new SdkError("bad-input", { field: "expectedAtomic" });
      const readyBy = Number(request.readyBySec !== undefined && request.readyBySec !== null ? request.readyBySec : e.readyBy);
      if (!Number.isFinite(readyBy) || readyBy <= 0) throw new SdkError("bad-input", { field: "readyBySec" });
      const minConfirmations = Number.isFinite(Number(request.minConfirmations)) && Number(request.minConfirmations) > 0
        ? Math.trunc(Number(request.minConfirmations)) : limitOf("xmrConfirmations", 10);
      const blockTimeSec = Number.isFinite(Number(request.blockTimeSec)) && Number(request.blockTimeSec) > 0
        ? Number(request.blockTimeSec) : limitOf("xmrBlockTimeSec", 120);
      const leadSec = Number.isFinite(Number(request.leadSec)) && Number(request.leadSec) >= 0
        ? Number(request.leadSec) : minConfirmations * blockTimeSec;
      const nowSec = Number.isFinite(Number(request.nowSec)) ? Number(request.nowSec) : nowOf();
      const leftSec = Math.floor(readyBy - nowSec);
      // PAST `readyBy` THE EARLY WINDOW IS GONE and the claim window is open: refunding is no longer ours to open.
      if (leftSec <= 0) return { refunded: false, state: "claim-window", leftSec, readyBy, nowSec };
      // TIME STILL LEFT BEYOND THE RESERVE - the maker has room to deliver; a refund now would abandon a live trade.
      if (leftSec > leadSec) return { refunded: false, state: "waiting", leftSec, needSec: leadSec, readyBy, nowSec };

      const verdict = await verify({
        nodes: request.nodes, address, viewSecret, spendPub, expectedAtomic, minConfirmations,
        txid: request.txid || null, fromHeight: request.fromHeight === undefined ? null : request.fromHeight,
        timeoutMs: request.timeoutMs, nowSec,
      });
      // THE XMR IS THERE - NOTHING IS REFUNDED. This is the decisive condition of the guard: without it the
      // client would take the ETH back from under a maker who has already sent the XMR.
      if (verdict.seen) return { refunded: false, state: "arrived", leftSec, verdict };
      // NOT ARRIVED (pending / one-node) - the depositor takes the ETH back through the same action seam as the
      // screen. A throw from `verify` above never reaches here and signs nothing.
      const res = await refund({ escrow, halfLocker, expect: request.expect, onStep: request.onStep }, request.wallet);
      return { refunded: true, state: "refunded", hash: (res && res.hash) || null, leftSec, verified: verdict };
    },

    async start(request) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      if (!request.quote || typeof request.quote !== "object") throw new SdkError("bad-input", { field: "quote" });
      // THE OLD PATH IS UNCHANGED; THE NEW ONE ASKS FOR A KEY INSTEAD OF A PER-SWAP FILE.
      const wantsKey = request.recoveryKey !== undefined && request.recoveryKey !== null;
      if (!wantsKey && typeof request.onRecoveryFile !== "function") throw new SdkError("bad-input", { field: "onRecoveryFile" });
      if (!request.receiveTo || typeof request.receiveTo !== "string") throw new SdkError("bad-input", { field: "receiveTo" });
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
        : async (req) => recordModule.createRecord(recordInputOf(req), { order: req.order, side: keySide });
      const passphrase = typeof request.passphrase === "string" ? request.passphrase : "";
      if (typeof passphrase !== "string") throw new SdkError("bad-input", { field: "passphrase" });
      if (passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE) throw new SdkError("bad-input", { field: "passphrase", min: MIN_PASSPHRASE });
      // THE ORDER TERMS ARE CHECKED BEFORE THE RECORD. The context is assembled by the engine from the very fields the
      // firm quote's signature is bound to; incomplete terms - a refusal with a named field, not a substitution of empty
      // values: the DLEQ proof would then be bound to nothing.
      const orderContext = contextOf(request.order);

      // THE KEY RECORD, THE NUMBER AND THE SIDE. A key is made once and kept through the SDK's store; the
      // number is reserved before the order is built, and it is retired only after the order exists on chain.
      // No per-swap file is assembled on this path.
      let recovery = null;
      if (wantsKey) {
        const storage = engine.store.storage();
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
        // key the person has saved. Saving it here is needed for index reservations; funding waits for the flag.
        if (!saved) saveRecoveryKey(storage, { ...key, backupConfirmed: false });
        const chainId = request.order.chainId;
        const explicit = request.recoveryIndex !== undefined && request.recoveryIndex !== null;
        const saltRequested = request.recoverySalt !== undefined && request.recoverySalt !== null;
        let derived;
        if (saltRequested) {
          // THE CLIENT OWNS THE SALT. A maker that chose it could hand the same salt to the same client twice, so
          // the caller composes the signed quote with this value and passes it here. The order's own salt must be
          // the same bytes; a mismatch means the quote is not the one being started.
          if (explicit) throw new SdkError("bad-input", { field: "recoverySalt", why: "with-recovery-index" });
          if (typeof request.order.factory !== "string" || !request.order.factory) {
            throw new SdkError("bad-input", { field: "order.factory" });
          }
          let salt;
          try { salt = recoverySaltOf(request.recoverySalt); } catch { throw new SdkError("bad-input", { field: "recoverySalt" }); }
          let orderSalt;
          try { orderSalt = recoverySaltOf(request.order.salt); } catch { throw new SdkError("bad-input", { field: "recoverySalt", why: "order-salt" }); }
          if (salt !== orderSalt) throw new SdkError("bad-input", { field: "recoverySalt", why: "order-salt" });
          derived = takerHalvesV2({ mnemonic: key.mnemonic, chainId, factory: request.order.factory, salt });
          recovery = { storage, key, salt, derivation: "salt-v2", newKey: !saved || saved.backupConfirmed !== true };
        } else {
          let index = explicit ? Number(request.recoveryIndex) : reserveRecoveryIndex(storage, { chainId });
          if (!Number.isSafeInteger(index) || index < 0) throw new SdkError("bad-input", { field: "recoveryIndex" });
          // A BROWSER STORE IS PER DEVICE. The same words opened elsewhere start at the same number, so the factory's own
          // log is asked before the number is used; a taken number is retired locally and the next one is reserved.
          // Without a log seam the previous behaviour is kept - the caller cannot be asked to invent a chain read.
          if (typeof chainLogs === "function" && request.order.factory) {
            // THE CHAIN'S BIRTH HEIGHT IS THE DEFAULT START, NOT ZERO. The factory's own log cannot hold an order
            // before it existed; asking from zero is tens of log queries per number on a public RPC. An explicit
            // `fromBlock` still wins, including the literal zero.
            const chain = config && Array.isArray(config.chains)
              ? config.chains.find((entry) => Number(entry.chainId) === Number(chainId)) : null;
            const deploymentBlock = chain && chain.escrow ? chain.escrow.deploymentBlock : null;
            const fromBlock = request.fromBlock !== undefined
              ? request.fromBlock
              : (Number.isSafeInteger(deploymentBlock) ? deploymentBlock : 0);
            let hops = 0;
            while (await recoveryIndexTaken({ mnemonic: key.mnemonic, chainId, index, factory: request.order.factory,
              evmLogs: chainLogs, fromBlock })) {
              if (explicit) throw new SdkError("bad-input", { field: "recoveryIndex", why: "on-chain" });
              commitRecoveryIndex(storage, index);
              index = reserveRecoveryIndex(storage, { chainId });
              hops += 1;
              if (!Number.isSafeInteger(index) || index < 0 || hops > 1000) throw new SdkError("bad-input", { field: "recoveryIndex", why: "exhausted" });
            }
          }
          derived = takerHalves({ mnemonic: key.mnemonic, chainId, index });
          recovery = { storage, key, index, derivation: "index-v1", newKey: !saved || saved.backupConfirmed !== true };
        }
        keySide = buildOwnSideFromHalves(request.order, { spendHalf: derived.spendHalf, viewHalf: derived.viewHalf }).side;
        // THE MAKER'S VIEW HALF IS DERIVED FROM THE KEY, NOT CHOSEN BY THE NODE. Without this binding a
        // signed quote could carry another view half; the funded address would differ from the one the twelve
        // words rebuild, and `sweep.fromOrder` would refuse after the funds were locked.
        derivedViewHalf = { half: derived.makerViewHalf, point: derived.makerViewPoint };
      }

      // THE KEY PATH BINDS THE VIEW HALF BEFORE THE ORDER IS BUILT. The quote must echo the half derived from
      // the same words and number; a missing or different half is refused, never silently replaced.
      if (derivedViewHalf) {
        const cp = request.counterparty && typeof request.counterparty === "object" ? request.counterparty : null;
        const suppliedHalf = cp ? (cp.viewHalfClaimer !== undefined && cp.viewHalfClaimer !== null ? cp.viewHalfClaimer
          : (cp.viewHalf !== undefined && cp.viewHalf !== null ? cp.viewHalf : null)) : null;
        if (suppliedHalf === null) throw new SdkError("quote-field-unbound", { step: "viewHalfClaimer", field: "viewHalfClaimer" });
        let sameHalf = false;
        try { sameHalf = BigInt(suppliedHalf) === BigInt(derivedViewHalf.half); } catch { sameHalf = false; }
        if (!sameHalf) throw new SdkError("quote-refused", { step: "viewHalfClaimer", why: "not-the-derived-half" });
        const suppliedPoint = cp.viewPoint !== undefined && cp.viewPoint !== null ? cp.viewPoint
          : (cp.viewHalfClaimer !== undefined ? null : cp.viewPub);
        if (suppliedPoint !== undefined && suppliedPoint !== null &&
            String(suppliedPoint).replace(/^0x/, "").toLowerCase() !== String(derivedViewHalf.point).replace(/^0x/, "").toLowerCase()) {
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
      // THE ORDER SIDE BUILT BY THE CORE STAYS UNTIL THE END OF THE START: the points and commitments for the lock terms
      // are taken from it - otherwise the record and the order would diverge, and the slot check against the chain would
      // go red (and rightly so). There is no second build of the side here.
      let builtSide = null;
      if (!record.swapWallet) {
        const step = orderStep({
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
        try { engine.swap.saveSwap(record.swap); } catch { throw new SdkError("storage-unavailable", { step: "save-swap" }); }
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
      try { engine.swap.saveSwap(record.swap); } catch { throw new SdkError("storage-unavailable", { step: "save-restore-height" }); }

      // 2a. THE KEY IS CONFIRMED ONCE; THE OLD PATH STILL ASSEMBLES A PER-SWAP FILE. On the key path there is
      // no file per swap: the same twelve words cover every swap, and a person who already saved them is not
      // asked again. A new key is shown before the money moves - no saved key, no funding.
      let payload = null;
      let file = null;
      let confirmed = true;
      if (!recovery) {
        // THE RECOVERY FILE IS ASSEMBLED AND CHECKED BEFORE THE PERSON. A file that will not open is worse than no
        // file: the person will rely on it. So we check on our side, before the screen.
        try {
          payload = engine.recoveryFile.buildPayload({
            swap: record.swap, swapWallet: record.swapWallet, escrow: record.escrow,
            receiveAddress: record.receiveTo || request.receiveTo, restoreHeight: record.restoreHeight ?? null,
          });
          engine.recoveryFile.validatePayload(payload);
        } catch { throw new SdkError("recovery-failed", { step: "build-payload" }); }

        try {
          file = { name: engine.recoveryFile.recoveryFileName(payload.swapId), contents: await engine.recoveryFile.createRecoveryFile(payload, passphrase) };
        } catch { throw new SdkError("recovery-failed", { step: "encrypt" }); }

        // 3. THE PERSON'S CONFIRMATION - THE GATE. No action that locks funds goes earlier: otherwise the lock would end
        // up without a key if the browser is lost. "Did not answer" is a refusal, not consent.
        confirmed = await request.onRecoveryFile(file);
        if (confirmed !== true) throw new SdkError("recovery-declined", { swapId: payload.swapId });
      } else if (recovery.newKey) {
        if (typeof request.onRecoveryKey !== "function") throw new SdkError("bad-input", { field: "onRecoveryKey" });
        try {
          file = {
            name: recoveryKeyFileName(recovery.key),
            contents: await createRecoveryKeyFile({ mnemonic: recovery.key.mnemonic, createdAt: recovery.key.createdAt, passphrase }),
          };
        } catch { throw new SdkError("recovery-failed", { step: "encrypt-key" }); }
        confirmed = await request.onRecoveryKey(file);
        if (confirmed !== true) throw new SdkError("recovery-declined", { key: recovery.key.fingerprint });
        // ONLY THE PERSON'S TRUE ANSWER MAKES THE KEY "BACKED UP". The record already exists for reservations;
        // this flag is what a later start reads. A failed write is a refusal before any funds move.
        try {
          const stored = loadRecoveryKey(recovery.storage) || {};
          saveRecoveryKey(recovery.storage, { ...recovery.key, nextIndex: stored.nextIndex,
            reserved: stored.reserved, retired: stored.retired, backupConfirmed: true });
          recovery.key = { ...recovery.key, backupConfirmed: true };
        } catch { throw new SdkError("storage-unavailable", { step: "save-recovery-key" }); }
      }

      // 4. LOCKING THE FUNDS. The wallet comes FROM OUTSIDE (an adapter with `send`/`receipt`): signing is possible only
      // in it, and the core keeps no path into the chain of its own. The absence of a wallet is a REFUSAL WITH A CODE,
      // not a substitution of something by default: a lock without a signature would either not happen or go out with
      // the wrong key. The recovery file has by now been assembled and confirmed by the person - a lock without a file
      // is not done.
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
      lockRequest.quote = request.orderQuote || null;
      let funded = null;
      try { funded = await lock.send(lockRequest, wallet, { call: reader }); }
      catch (error) {
        if (error && typeof error.code === "string") throw error;
        throw new SdkError("server-unavailable", { step: "lock" });
      }
      // A SENT TRANSACTION IS NOT A FUNDED ESCROW. Without a status-1 receipt and the expected OrderCreated, the
      // address is unknown and calling the step xmr-incoming would make the person wait for XMR at a guess. Keep
      // the swap pending: the transaction hash is the handle for a later receipt read.
      if (funded && funded.pending) {
        throw new SdkError("funding-pending", {
          txHash: funded.createHash || null,
          reason: funded.pendingReason || "no-receipt",
          predictedEscrow: funded.predictedEscrow || null,
        });
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
        try { engine.swap.saveSwap(record.swap); } catch { throw new SdkError("storage-unavailable", { step: "save-escrow" }); }
        // THE NUMBER IS SPENT ONLY NOW, WHEN THE ORDER EXISTS ON CHAIN. A failed or abandoned start keeps the
        // reservation, so a retry uses the same number and the later search has no gap.
        if (recovery && recovery.index !== undefined) {
          try { commitRecoveryIndex(recovery.storage, recovery.index); } catch { /* the reservation stays; the key still works */ }
        }
      }

      // 5. A BACKEND IS OPTIONAL AND NEVER A DEFAULT. When the caller configured an API base, the swap is recorded
      // there and the watch row is opened. Without one, the SDK returns the local state and the joint address: the
      // caller watches the chain itself. The owner's rule: no request to the page's own origin.
      let server = null;
      let watch = null;
      if (config && config.apiBase) {
        server = await markOnServer(record.swap, escrowAddress, request.order);
        watch = await openWatch(record.swap, request.order);
      }
      // THE STATE IS NAMED, NOT PASSED OFF AS COMPLETION: the swap reached exactly "waiting for XMR at the joint address",
      // and there is no arrival yet - `receivedXmr` is never implied by zero.
      return {
        id: record.swap.id || null,
        escrow: escrowAddress,
        address: (watch && watch.address) || (record.swapWallet && record.swapWallet.address) || null,
        step: "xmr-incoming",
        server,
        watch,
        next: "watch",
      };
    },

    /**
     * WAIT FOR THE XMR TO ARRIVE AT THE JOINT ADDRESS - the whole point of opening the watch.
     *
     * The CLIENT checks the arrival from the Monero nodes (`verify`); there is no backend poll by default. The rate
     * and the timeout come from the configuration (config.limits.watchPollMs/watchTimeoutMs) and are overridable here.
     * A caller that explicitly configured `apiBase` may use the old watch-row flow instead.
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
        const readyBy = request.readyBySec !== undefined && request.readyBySec !== null ? Number(request.readyBySec)
          : (request.deadline && request.deadline.readyBy !== undefined ? Number(request.deadline.readyBy) : null);
        if (readyBy) xmrArrival.assertTimeForConfirmations({ readyBySec: readyBy, nowSec: Math.floor(Date.now() / 1000), minConfirmations, blockTimeSec: limitOf("xmrBlockTimeSec", 120) });
      }
      const hasBackend = Boolean(config && config.apiBase);
      // THE WATCH DOES NOT CALL A BACKEND BY DEFAULT. The client-side arrival check needs the joint address, the view
      // secret and the spend public key; without them, and without an explicitly configured backend, there is nothing
      // to wait on. That is a named refusal, not a request to the page's own origin.
      if (!verifyRequest && !hasBackend) throw new SdkError("bad-input", { field: "verify", why: "no-backend" });
      const started = Date.now();
      // --- THE MAKER'S DECLINE: THE WAIT IS NOT STARTED AT ALL (issue #40). -------------------------------------
      // A decline leaves the escrow `refunded`, so nothing in the state says "do not wait any longer": without
      // this, the wait runs to its timeout and the app is told the generic `xmr-timeout` about an order that is
      // CLOSED and whose ETH is already back - or, worse, the app offers the recovery file and a manual refund
      // for money nobody can recover.
      //
      // THE DECLINE IS ASKED WITH TWO INDEPENDENT SOURCES AND EITHER ONE ENDS THE WAIT:
      //   * THE CHAIN - the escrow's own `Declined` event, through the same log reader the rest of the core uses;
      //   * THE WIRE - the status the service answers with (`declined` with the code `compliance`).
      // A CHAIN READ THAT FAILS is neither a decline nor a refusal of the swap: the wait goes on and the wire may
      // still answer. What the chain read did is carried out with the result (`chain.checked` / `chain.error`), so
      // a broken reader is visible instead of silent.
      // A STORAGE THAT CANNOT BE READ IS NOT A REASON TO REFUSE THE WAIT: the record is what makes the state
      // durable, and the escrow may also arrive in the request. The watch is not a new user of the store - and it
      // must not start failing where it did not before.
      let record = null;
      try { record = engine.swap.getSwap(id); } catch { record = null; }
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
        try { engine.swap.saveSwap(swap); } catch { throw new SdkError("storage-unavailable", { step: "decline" }); }
      };
      // THE STATE THE WATCH REPORTS FOR A DECLINE: no arrival, the state's own code, the node's own token and
      // WHERE it was seen ("event", "status", or "record" when it was already written down). NO reason, category
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
        // THE CLIENT-SIDE CHECK DOES NOT ASK THE SERVICE. Only a watch without `verify` and with an explicitly
        // configured backend reads the watch row.
        const body = verifyRequest ? {} : await readWatch(id);
        last = verifyRequest
          ? { address: request.address || escrowAddress, expectedXmr: request.expectedXmr ?? null, status: null }
          : incomingOf(body);
        // THE DECLINE IS DECIDED BEFORE THE ARRIVAL IS LOOKED AT, and before the "foreign response" refusal below:
        // a declined swap's answer carries no `receivedXmr` at all, and refusing it as a bad response would name
        // the wrong thing (the state is known - it is a decline, not a broken answer).
        const declineNow = declineOf({ logs: chainDecline.logs, status: body, escrow: escrowAddress, at: Date.now() });
        if (declineNow.declined) {
          settleDecline(record, declineNow.at);
          return declineResult({ source: declineNow.source, at: declineNow.at, waitedMs: Date.now() - started,
            address: body && body.address, chainChecked: chainDecline.checked, chainError: chainDecline.error });
        }
        // AN EMPTY OR FOREIGN RESPONSE IS NOT AN ARRIVAL: counting it as incoming would mean declaring money that was
        // never seen. This is a named refusal, not "let us wait some more".
        if (!last) throw new SdkError("server-unavailable", { step: "watch", why: "bad-response", id });
        // XMR IS ON THE ADDRESS BUT LOCKED BY THE TRANSACTION'S unlock_time: a NAMED refusal, not "keep waiting".
        // The ready mark hands the escrow to the maker; under funds that cannot be spent the maker would take the
        // ETH and the XMR would stay locked (issue #84), so nothing is signed. The boundary is in `until`.
        if (last.locked) {
          const until = last.lockedUntil || {};
          throw new SdkError("xmr-locked", { id, address: last.address, status: last.status,
            expectedXmr: last.expectedXmr, receivedXmr: last.receivedXmr, lockedXmr: last.lockedXmr,
            // The boundary goes as NUMBERS and their kind - a block height or unix seconds - never as text:
            // turning them into a date the person reads is the interface's dictionary (www/js/sdk/codes.js).
            untilHeight: until.untilHeight ?? null, untilTime: until.untilTime ?? null,
            waitedMs: Date.now() - started });
        }
        // THE CLIENT'S OWN ANSWER COMES FIRST AND DECIDES. The backend's `seen` may still be false (it no longer
        // holds the view key), so it is not consulted when the client verifies. A disagreement or locked money
        // throws its own code above and closes the button; one operator / few confirmations name a WAITING state.
        if (verifyRequest) {
          const verdict = await xmrArrival.verifyArrival({ ...verifyRequest, nowSec: Math.floor(Date.now() / 1000) });
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
        if (last.seen) {
          const result = { seen: true, id, address: last.address, status: last.status,
            expectedXmr: last.expectedXmr, receivedXmr: last.receivedXmr, confirmations: last.confirmations,
            txids: last.txids, at: Date.now() };
          if (wantExpect && wantWallet) {
            result.marked = await actions.markReady(
              { escrow: request.escrow || last.address, expect: request.expect, onStep: request.onStep }, request.wallet);
          } else {
            // WITHOUT EXPECTATIONS AND A WALLET, THE WATCH HONESTLY NAMES THE NEXT STEP, rather than pretending the mark
            // has already been placed.
            result.next = "mark-ready";
          }
          return result;
        }
        if (Date.now() - started >= timeoutMs) {
          throw new SdkError("xmr-timeout", { id, address: last.address, expectedXmr: last.expectedXmr,
            receivedXmr: last.receivedXmr, confirmations: last.confirmations, waitedMs: Date.now() - started,
            timeoutMs, pollMs });
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };
}
