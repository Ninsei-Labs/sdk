// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/swap.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// The demo core: the deal state over time.
//
// PRINCIPLE: the state is NOT kept as a "current step". Timestamps and events are kept, and the phase is derived
// by derive() from the sim time. So the demo survives a page reload, and "close the tab and come back" truly works.
//
//
// The model follows litepaper §4.2 and §5.3:
//  - T0: the maker's XMR lock deadline. Did not lock - the user refunds the ETH (permissionless).
//  - ready: the user confirms he saw the lock with his view key.
//  - T1: the maker's claim deadline. Did not claim - the user refunds the ETH.
//  - If the user did not mark ready - the maker takes the XMR back and the user refunds the ETH.
//  - A watchtower can refund the user's money without his involvement.

// DEMO IS NEEDED HERE, AND IT IS NOT A TRIFLE: the default chain mode is taken from it below. The name was not
// imported, so ANY deal created without an explicit chainMode failed with "DEMO is not defined" - while the live
// deal page passes the mode explicitly, so the break stayed invisible until the first check that creates a deal without it.
import { TIMING, MONERO, SCENARIO_LABELS, DEFAULT_CHAIN, API, DEMO, chainById, SIGNING_GUARDS } from "./config.js";
// THE XMR SELL WINDOW - ONE rule for the node and the page. Here it is only read for the countdown.
import { sellWindowSec, SELL_WINDOW } from "./sellWindow.js";
import { simElapsed, simWall, nowReal, rescaleStart } from "./clock.js";
import { loadState, saveState } from "./store.js";
import { shortId, randomHex } from "./format.js";
import * as chain from "../mock/chain.js";
import * as node from "../monero/node.js";
// The Monero-leg source: in "app" mode confirmations and arrivals come from the backend,
// in "mock" mode - from the demo simulator. Exactly what goes outward (only the address and view key)
// is checked mechanically.
import { XMR_STATUS, explorerXmrTx, fetchSession, isLiveSource, openSession, pollInterval, xmrView } from "./chainSource.js";
import { watchOnlyShareFromWallet } from "../recovery/restore.js";

export const STEP_LABELS = [
  ["funded", "Funded on-chain"],
  ["maker_locking", "Maker locking XMR"],
  ["xmr_locked", "XMR locked"],
  ["ready", "Verified by you"],
  ["claimed", "Claimed by maker"],
  ["swept", "Sent to your address"],
];

export const TERMINAL = {
  success: { phase: "success", label: "XMR delivered" },
  refunded_eth: { phase: "refunded_eth", label: "ETH refunded" },
  xmr_returned: { phase: "xmr_returned", label: "Swap cancelled, funds returned" },
};

export function createSwap(input) {
  const s = loadState();
  const now = Date.now();
  const swap = {
    id: shortId(),
    side: input.side || "buy",
    scenario: input.scenario || "happy",
    speed: input.speed || 60,
    // THERE IS NO QUOTE KIND IN THE RECORD. The former field mode ("floating"/"fixed") was a choice of price
    // kind, and in version 4 there is no second kind: a firm quote is exactly one - the order quote.
    network: input.network || DEFAULT_CHAIN,
    moneroNetwork: MONERO.networkType,
    realStart: now,
    simStartWall: now,
    createdAt: new Date(now).toISOString(),
    payToken: input.payToken,
    payAmount: Number(input.payAmount),
    xmrAmount: Number(input.xmrAmount),
    rate: Number(input.rate),
    fee: Number(input.fee),
    maker: { id: input.makerId, name: input.makerName, spread: input.makerSpread },
    dexSpread: input.dexSpread,
    gasUsd: input.gasUsd,
    receiveAddress: input.receiveAddress,
    quoteSignature: input.quoteSignature,
    swapWallet: input.swapWallet || null, // the one-shot Monero wallet's keys
    timeline: {
      fundAtSim: 0,
      lockAtSim: input.scenario === "maker_no_lock" ? null : TIMING.makerLock,
      blockSim: MONERO.blockTimeSim,
      confTarget: MONERO.confirmTarget,
      t0Sim: TIMING.t0Refund,
    },
    // THE SAME DEFAULT AS IN THE SETTINGS: "live" - the real chain height, "mock" - a sandbox timer.
  // A second default here would mean a deal without an explicit mode is timed.
  chainMode: input.chainMode || DEMO.defaultChainMode, // mock | live (the real Monero mainnet height)
    // The Monero-leg source: "app" - the real backend (see core/chainSource.js), "mock" - the simulator.
    xmrSource: input.xmrSource || API.xmrSource,
    xmrSession: null, // the last backend poll: status, amount, confirmations, txid
    xmrSessionError: null, // the backend refusal cause: shown as a state, not a crash
    events: [],
    escrow: null,
    xmr: null,
    settlement: null,
    log: [],
  };

  // DEMO FUNDING ONLY IN THE DEMO. An unconditional call to the mock branch (chain.fundEscrow) used to stand
  // here and ran INCLUDING on the live path: the record got an INVENTED escrow address and an INVENTED
  // transaction hash, and the live flow then fought them. From outside it looked like this: a real order was
  // created and paid, while the progress screen, the explorer link, the recovery file and the payer looked at
  // an address not on chain. On the live path only the live flow may give the address and hash.
  if (swap.chainMode !== "live") {
    const fund = chain.fundEscrow({ swapId: swap.id, ethAmountUsd: swap.payAmount, ethUsd: 3212.4 });
    swap.escrow = {
      address: fund.escrow,
      fundTx: fund.txHash,
      method: fund.method,
      fundedAtSim: 0,
      gasUsd: fund.gasUsd,
    };
    pushLog(swap, 0, "Escrow funded", `eth escrow ${fund.escrow}`);
  } else {
    // A PLACEHOLDER FOR A LIVE ORDER - WITH NOT ONE INVENTED VALUE. The address and hash will come from the live
    // funding flow (confirm.js writes them from the flow's answer). The empty fields are here not for beauty:
    // without the object the record had nowhere for the live path to write, and the address was lost silently.
    swap.escrow = { address: null, fundTx: null, method: null, fundedAtSim: 0, gasUsd: input.gasUsd ?? null };
  }

  s.swaps[swap.id] = swap;
  s.activeSwapId = swap.id;
  saveState(s);
  return swap;
}

// REVERSE-FLOW DEAL RECORD . The sell screen used to stop at the request, and there was
// nowhere to show a refund: a reverse deal had no record. It is created here - from exactly what the screen
// already has (the node ticket plus the computed halves) - and lands in the same store as the buy flow, so the
// deal card, the recovery file and the XMR sweep all work off it.
//
// WHAT THE REVERSE DEAL DOES DIFFERENTLY. On the buy flow the PAGE funds the escrow, and the counterparty's half
// is only learned after settlement. On the sell flow the PROVIDER funds the escrow, the page merely requests the
// order, and it computes ITS OWN halves (atomic/order-worker.js, newMakerMaterial). So fields are named by side:
// our half is `half`, and the DEPOSITOR's (provider's) point and view half are counterSpendPoint/counterView*.
// The page does not know the depositor's SPEND half and must not: the contract publishes it on settlement, and
// only then does the sweep of our own XMR open up (see refundHalfRevealed).
export function createReverseSwap(input = {}) {
  const s = loadState();
  const now = Date.now();
  const xmr = Number(input.xmrAmount);
  const swap = {
    id: shortId(),
    side: "reverse",
    scenario: "happy",
    speed: Number(input.speed) || 60,
    network: input.network || DEFAULT_CHAIN,
    moneroNetwork: MONERO.networkType,
    realStart: now,
    simStartWall: now,
    createdAt: new Date(now).toISOString(),
    // THE USER GIVES XMR AND RECEIVES THE NATIVE COIN: payToken is XMR, receiveAddress is their payout address
    // on the settlement chain.
    payToken: "XMR",
    payAmount: xmr,
    xmrAmount: xmr,
    rate: Number(input.rate) || 0,
    fee: Number(input.fee) || 0,
    maker: { id: input.providerId || null, name: input.providerName || null, spread: null },
    receiveAddress: input.claimer || null,
    quoteSignature: null,
    ticket: input.ticketId || null,
    timeline: { fundAtSim: 0, lockAtSim: 0, blockSim: MONERO.blockTimeSim, confTarget: MONERO.confirmTarget, t0Sim: TIMING.t0Refund },
    chainMode: input.chainMode || DEMO.defaultChainMode,
    xmrSource: input.xmrSource || API.xmrSource,
    xmrSession: null,
    xmrSessionError: null,
    events: [],
    // HALVES WALLET OF THE REVERSE ORDER: our own spend and view half plus the depositor's PUBLIC halves. The
    // recovery file builds the wallet from here (recovery/recoveryFile.js, buildPayload v3), and after the half
    // is revealed, so does the spend key. The counterparty's SPEND half is not here: the chain provides it
    // (refundHalfRevealed).
    escrow: {
      address: input.escrowAddress || null,
      moneroAddress: input.moneroAddress || null,
      half: input.ownSpendHalf || null,
      viewHalf: input.ownViewHalf || null,
      counterViewHalf: input.counterViewHalf || null,
      counterViewPoint: input.counterViewPoint || null,
      counterSpendPoint: input.counterSpendPoint || null,
      moneroNetwork: MONERO.networkType,
      birthHeight: input.escrowBirthHeight || null,
      readyBy: input.readyBy || null,
      t1: input.t1 || null,
      // The DEPOSITOR's REVEALED HALF appears when the chain publishes it on settlement. Until then there is
      // nothing to sweep with.
      counterHalf: null,
    },
    xmr: null,
    settlement: null,
    log: [],
  };
  s.swaps[swap.id] = swap;
  s.activeSwapId = swap.id;
  saveState(s);
  return swap;
}

function pushLog(swap, atSim, title, detail) {
  swap.log.push({ atSim, wall: simWall(swap, atSim), title, detail: detail || "" });
  // We duplicate to the CONSOLE too, and it is the main channel for diagnosis. The journal used to be shown only
  // on the page, where it lived in the screen state and vanished on a redraw - exactly when it was needed most.
  // In the console the history is kept and can be copied whole.
  console.log(`[swap ${swap.id}] ${title}${detail ? " - " + detail : ""}`);
}

// Drop a deal from the browser state. Locally only: the server keeps the record, and so do the wallet files the
// backend manages. They must not be mass-deleted by a pattern - those are real swaps' wallets - so server cleanup
// is a separate script on purpose.
// THE HALVES WALLET FROM THE RECORD - FOR THE RECOVERY FILE. The halves are saved in the deal record at funding
// time (escrow.half and neighbouring fields), and that is their only home: no full spend key exists for either
// side, and one's own half is random - a mnemonic cannot restore it. The export used to take swapWallet (the
// former scheme's wallet), and the file came out version 2 - from which one's XMR cannot be claimed. We assemble
// exactly the fields recoveryFile.js version 3 expects, in one place, so the export and the checks do not diverge.
//
export function halvesWalletOf(swap) {
  const e = (swap && swap.escrow) || {};
  if (!e.half || !e.viewHalf || !e.counterViewHalf || !e.moneroAddress) return null;
  return {
    source: "halves",
    library: "monero-js",
    network: e.moneroNetwork || MONERO.networkType,
    address: e.moneroAddress,
    subaddress: null,
    spendHalf: e.half,
    viewHalf: e.viewHalf,
    // THE COUNTERPARTY'S SPEND POINT CARRIES DIFFERENT NAMES PER FLOW: on the direct swap it is the claimer's
    // point (edPointClaimer); on the reverse swap it is the DEPOSITOR's point, which the contract publishes on
    // settlement (counterSpendPoint). One consumer (the recovery file and the sweep) must read both, or the
    // reverse order would end up without its own spend key.
    otherSpendPoint: e.counterSpendPoint || e.edPointClaimer || null,
    otherViewPoint: e.counterViewPoint || null,
    otherViewHalf: e.counterViewHalf,
  };
}

export function forgetSwap(id) {
  const s = loadState();
  if (!s.swaps[id]) return false;
  delete s.swaps[id];
  saveState(s);
  return true;
}

export function getSwap(id) {
  return loadState().swaps[id] || null;
}

export function allSwaps() {
  const s = loadState();
  return Object.values(s.swaps).sort((a, b) => (a.realStart < b.realStart ? 1 : -1));
}

// ---- MERGING WITH THE SERVER LIST -----------------------------------------------------------------
//
// Why. While records live only in localStorage the list is tied to the browser: cleared site data or another
// device - no deals visible, although the money is in the escrow. The server list removes that.
//
//
// MERGE RULES, deliberately cautious:
//   1) a local record ALWAYS wins: it knows more (secret, wallet, stages). A server row only ADDS what this
//      browser lacks and never overwrites what was found;
//   2) a record that came from the server is marked source: "server" - so a person and the code see where it
//      came from, and the screen can say so honestly;
//   3) from a server row we take only public fields. There is no secret there and there cannot be - so such a
//      deal will be visible but claiming funds from it cannot be signed: the secret lies in the recovery file.
//      That is not an omission but a consequence of the secret never leaving for the server.
export function serverRowToSwap(row) {
  const escrow = String((row && row.escrow) || "").toLowerCase();
  return {
    id: String(row.id),
    network: row.network || null,
    chain: row.network || null,
    source: "server",
    status: "in_progress",
    escrow: {
      address: escrow,
      t0: row.t0 != null ? Number(row.t0) : null,
      t1: row.t1 != null ? Number(row.t1) : null,
      hashlock: row.hashlock || null,
      amountWei: row.amount != null ? String(row.amount) : null,
      fromServer: true,
    },
    log: [],
    events: [],
  };
}

// Add server records the browser lacks. Returns the number added: the caller decides from it whether to redraw
// the list, rather than guessing.
export function addServerSwaps(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const s = loadState();
  let added = 0;
  for (const row of rows) {
    if (!row || !row.id || !row.escrow) continue;
    if (s.swaps[row.id]) continue;                       // a local record wins - do not touch
    s.swaps[row.id] = serverRowToSwap(row);
    added += 1;
  }
  if (added) saveState(s);
  return added;
}

// Find a deal by escrow address: needed to tie a server-list record to a real order.

export function activeSwaps() {
  return allSwaps().filter((sw) => !sw.settlement);
}

// SAVE A DEAL AFTER OUTSIDE EDITS. persist() was internal, and calling modules (e.g. confirm.js) edited record
// fields - escrow address, salt, deadlines, secret - and did NOT save it: the edits lived in memory and vanished
// with the tab, while the progress screen read the OLD record from storage. That is exactly why the interface
// showed an address not on chain even when funding had succeeded.
export function saveSwap(swap) {
  return persist(swap);
}

function persist(swap) {
  const s = loadState();
  s.swaps[swap.id] = swap;
  saveState(s);
  return swap;
}

function event(swap, type, atSim, extra = {}) {
  swap.events.push({ type, atSim, ...extra });
  return swap;
}

function findEvent(swap, type) {
  return swap.events.find((e) => e.type === type) || null;
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------

export function confirmReady(id) {
  const swap = getSwap(id);
  if (!swap || swap.settlement) return swap;
  const view = derive(swap);
  if (!view.can.ready) throw new Error("ready() is not available in this phase");
  const atSim = simElapsed(swap);
  event(swap, "ready", atSim);
  pushLog(swap, atSim, "ready() called by you", "maker may now claim the ETH escrow");
  if (!findEvent(swap, "funded_note")) event(swap, "funded_note", 0);
  return persist(swap);
}

// THE COUNTERPARTY'S SPEND HALF - THE ONE PLACE THAT SHOWS WHETHER THERE IS ANYTHING TO ASSEMBLE. The Monero
// spend key is the sum of two halves, and the user holds their own; sweeping XMR back after a refund is possible
// exactly when the second half is ALREADY revealed. In the record it is stored as counterHalf (the engine sets it
// while the counterparty is a stand-in) or as revealedHalf (read from the chain after claim/refund).
export function refundHalfRevealed(swap) {
  const e = (swap && swap.escrow) || {};
  return e.revealedHalf || e.counterHalf || null;
}

// XMR SWEEP. In the ordinary phase this happens after the other side reveals its half through settlement. A
// REVERSE-FLOW REFUND  is the SECOND case: the order was refunded, the user's coins
// stayed on the swap's one-time address, and the contract revealed the DEPOSITOR's half on refund. Then the same
// sweep takes our coins back, and the settlement is marked recovered: the money returned to the user rather
// than leaving through the swap.
export function sweepNow(id) {
  const swap = getSwap(id);
  if (!swap) return swap;
  // The deal already settled: no second sweep - EXCEPT a reverse-flow refund, which is how our own XMR are taken
  // back.
  if (swap.settlement && !(swap.settlement.kind === "refund_eth" && swap.side === "reverse")) return swap;
  const view = derive(swap);
  if (!view.can.sweep) throw new Error("sweep is not available in this phase");
  const atSim = simElapsed(swap);
  const tx = chain.sweepXmr({ swapId: swap.id });
  swap.xmr = swap.xmr || {};
  swap.xmr.sweepTxid = tx.txid;
  const fromRefund = Boolean(swap.settlement && swap.settlement.kind === "refund_eth");
  swap.settlement = { kind: "success", phase: TERMINAL.success.phase, atSim, txid: tx.txid, by: "you",
    ...(fromRefund ? { recovered: true } : {}) };
  pushLog(swap, atSim, "XMR swept to your address", tx.txid);
  return persist(swap);
}

export function refundEth(id, by = "you") {
  const swap = getSwap(id);
  if (!swap || swap.settlement) return swap;
  const view = derive(swap);
  if (!view.can.refund) throw new Error("refund is not available in this phase");
  const atSim = simElapsed(swap);
  const tx = chain.refundEscrow({ swapId: swap.id, by });
  swap.settlement = { kind: "refund_eth", phase: TERMINAL.refunded_eth.phase, atSim, txHash: tx.txHash, by };
  pushLog(swap, atSim, `ETH refunded to your wallet (${by})`, tx.txHash);
  return persist(swap);
}

// ---------------------------------------------------------------------------
// State output
// ---------------------------------------------------------------------------

// Whether the deal's network is live: escrow.mode = live in the network config. The network setting is a fact,
// the same for old and new deals, unlike the chainMode field inside a record.
function isLiveNetwork(swap) {
  const conf = (chainById((swap && swap.network) || DEFAULT_CHAIN) || {}).escrow || {};
  return conf.mode === "live";
}

// THE AMOUNT AT THE ADDRESS AGAINST THE QUOTE'S PROMISE. The ready mark lets the claimer settle by his half -
// i.e. gives him the ETH - so it is made not on "something arrived" but on a SUFFICIENT amount. The 1e-6 XMR
// tolerance covers display rounding, not a discount. An unknown amount is also a refusal: not knowing is not permission.
const XMR_AMOUNT_EPS = 1e-6;
export function xmrAmountCheck(swap, xmr) {
  const expected = Number(swap && swap.xmrAmount);
  const hasExpected = Number.isFinite(expected) && expected > 0;
  // "THE SEEN AMOUNT" IS EVERYTHING AT THE ADDRESS: both unlocked and locked by unlock_time. Otherwise a locked
  // arrival would show its amount as "not seen", although the money is at the address. What of it can be spent
  // is a separate question, decided by the status (ready does not enable while the money is locked).
  const seenSource = xmr && xmr.arrived !== null && xmr.arrived !== undefined ? xmr.arrived : (xmr ? xmr.received : null);
  const seen = seenSource !== null && seenSource !== undefined && Number.isFinite(Number(seenSource))
    ? Number(seenSource) : null;
  if (!hasExpected) {
    return { ok: true, checked: false, expected: null, seen,
      why: "the record has no quoted XMR amount, so the arrived sum cannot be compared - this is named, not assumed" };
  }
  if (seen === null) {
    return { ok: false, checked: true, expected, seen: null,
      why: "the amount of XMR on the address is not known (" + expected + " XMR was quoted): ready stays closed until the sum is seen" };
  }
  // THE COMPARISON IS TWO-SIDED, AND THIS IS A FIX. It used to be one-sided ("arrived no less") and therefore
  // BLIND to a node overpayment: the node counted the debt by a raw reference without spread and gave 5,000 XMR
  // where it promised 4,950 - the arrival was MORE than promised and the check stayed silent. The number we
  // compare against is the one the node writes into the journal as the debt (amount_xmr): it comes from the same
  // price feed as the one shown to the person. A divergence in EITHER direction means the recorded and shown numbers differ.
  if (seen + XMR_AMOUNT_EPS < expected) {
    return { ok: false, checked: true, expected, seen,
      why: "only " + seen + " XMR arrived, the quote promised " + expected + " XMR: ready is blocked - the escrow would pay out for less than agreed" };
  }
  if (seen > expected + XMR_AMOUNT_EPS) {
    return { ok: false, checked: true, expected, seen,
      why: seen + " XMR arrived, but the record promises " + expected + " XMR: the sum on the address does not match the quoted trade - ready is blocked until they agree (a node paying more than it quoted loses its spread)" };
  }
  return { ok: true, checked: true, expected, seen, why: null };
}

export function derive(swap, now = nowReal()) {
  const sim = simElapsed(swap, now);
  const t = swap.timeline;
  const ev = (type) => findEvent(swap, type);
  const readyEv = ev("ready");

  // The Monero-leg snapshot: in mock mode computed from sim time, in live read from the last backend poll.
  // Beyond this the engine works the same and does not know where the data came from.
  const live = isLiveSource(swap.xmrSource);
  const xmr = xmrView(swap, sim);
  // ARRIVAL IS EVERYTHING VISIBLE AT THE ADDRESS (arrived), not just the unlocked: money locked by unlock_time
  // has arrived but cannot be spent - a separate state, named below, that does not let "done" through.
  const arrived = Number(xmr.arrived !== undefined && xmr.arrived !== null ? xmr.arrived : (xmr.received || 0));
  const lockAt = live ? (arrived > 0 ? 0 : null) : t.lockAtSim; // null => the maker does not lock (the maker_no_lock scenario)
  const conf = xmr.confirmations;
  const lockDone = live ? arrived > 0 : lockAt !== null && sim >= lockAt;

  const readyAt = readyEv ? readyEv.atSim : null;
  // DEADLINES FROM CHAIN - IN REAL TIME: readyBy and t1 are set by the contract and have nothing to do with the
  // accelerated demo time or the simulator.
  const chainReadyByMs = swap.escrow && swap.escrow.readyBy ? Number(swap.escrow.readyBy) * 1000 : null;
  const chainT1Ms = swap.escrow && swap.escrow.t1 ? Number(swap.escrow.t1) * 1000 : null;
  // THE XMR SELL WINDOW. The countdown runs FROM the contract readyBy (set by neither us nor the simulator),
  // not from TIMING.readyWindow: that lives in the accelerated demo time and on a live deal would show demo
  // time. The soft promise (600 s) is extended to the contract one (1200 s) while the pool lacks the FULL amount
  // - by the same rule as the node (sellWindowSec). This does NOT change the right to act: the contract takes
  // the mark up to readyBy, and the window here is an on-screen promise.
  const sellSeen = Number(xmr.arrived !== undefined && xmr.arrived !== null ? xmr.arrived : (xmr.received || 0)) > 0;
  const sellWindow = (() => {
    if (swap.side !== "reverse" || chainReadyByMs === null) return null;
    const startMs = chainReadyByMs - SELL_WINDOW.hardSec * 1000;      // window start = readyBy minus the contract maximum
    const softAtMs = startMs + SELL_WINDOW.softSec * 1000;
    const windowSec = sellWindowSec({ poolSeen: sellSeen, soft: SELL_WINDOW.softSec, hard: SELL_WINDOW.hardSec });
    const extended = !sellSeen && nowReal() >= softAtMs;             // the promise extended to the contract window
    const atMs = extended ? startMs + windowSec * 1000 : softAtMs;   // before the extension the count goes to the soft promise
    return { startMs, atMs, leftMs: atMs - nowReal(), seen: sellSeen, extended,
      softSec: SELL_WINDOW.softSec, hardSec: SELL_WINDOW.hardSec, windowSec };
  })();
  const claimAt = readyAt !== null && swap.scenario !== "maker_stall" ? readyAt + TIMING.makerClaim : null;
  const sweptAt = claimAt !== null ? claimAt + TIMING.sweep : null;

  const readyDeadline = lockAt !== null ? lockAt + TIMING.readyWindow : null;
  const makerReclaimAt = readyDeadline !== null ? readyDeadline + TIMING.makerReclaim : null;
  const t1At = readyAt !== null ? readyAt + TIMING.t1Refund : null;

  // The "user did not confirm" scenario: the maker takes the XMR back.
  const xmrReclaimed = readyAt === null && makerReclaimAt !== null && sim >= makerReclaimAt;

  // Available actions/deadlines
  const can = { ready: false, sweep: false, refund: false };
  let phase = "xmr_locked";
  let phaseLabel = "Waiting";
  let refundAfterSim = null;
  let note = null;

  if (swap.settlement) {
    phase = swap.settlement.phase;
    phaseLabel = Object.values(TERMINAL).find((x) => x.phase === swap.settlement.phase)?.label || "Settled";
    // SWEEPING OUR OWN XMR AFTER A REFUND . On the reverse flow a refund leaves the
    // user's coins on the swap's one-time address: the claimer's ETH came back, and nobody moved the XMR. They can
    // only be taken by assembling the spend key from OUR half and the OTHER half that the chain revealed on
    // settlement. While the revealed half is missing we do NOT grant the right - can.sweep stays false precisely
    // so that the button cannot appear without a working action. The "arrived / expected" numbers are already
    // handed to the screen below (xmrAmount): only the right to sweep is decided here.
    if (swap.settlement.kind === "refund_eth" && swap.side === "reverse") {
      const revealed = refundHalfRevealed(swap);
      const stillOnAddress = arrived > 0;
      can.sweep = Boolean(revealed && stillOnAddress && halvesWalletOf(swap));
      // THE REASON IS NAMED, NOT HIDDEN: the screen must say what is missing, not merely omit the button.
      note = can.sweep
        ? "The refund published the provider's half, so your XMR can be swept back from the swap's one-time address to your own wallet."
        : (!stillOnAddress
          ? "The refund is done, but no XMR is on the swap's one-time address: there is nothing of yours to sweep back."
          : "The refund is done and your XMR is on the swap's one-time address, but the provider's half of the spend key is not published yet: sweeping needs both halves, so the button waits for the chain.");
    }
  } else if (live && readyAt === null && chainReadyByMs !== null && nowReal() >= chainReadyByMs
             && (chainT1Ms === null || nowReal() < chainT1Ms)) {
    // THERE WAS A DEAD ZONE - NOW AN OPEN DOOR. The depositor will not mark anymore, and the contract forbids a
    // claim without it, so the claim window NEVER OPENED - and a refund is allowed right after readyBy (the
    // contract condition: block.timestamp < readyBy || (block.timestamp < t1 && ready)). It also publishes the
    // depositor's half, so the maker takes his XMR back without waiting for t1. That is the answer to the dead
    // zone: before, the money and the half waited for t1, and the Monero leg was unavailable to both sides.
    phase = "dead_zone";
    phaseLabel = "Ready deadline passed - the refund is open";
    can.ready = false;
    can.refund = true;
    can.refundByAnyone = true;
    note = "The ready() deadline has passed without your confirmation, so the maker cannot claim - and the " +
      "refund is open NOW, not at T1. It returns your ETH and publishes your half, so the maker can reclaim " +
      "the XMR from Monero right away. " +
      (chainT1Ms !== null ? "T1 closes the order for good: " + new Date(chainT1Ms).toISOString() + "." : "");
  } else if (live && readyAt === null) {
    // Live mode: Monero-leg states come from the backend. The simulated EVM-leg timeouts (T0/T1, watchtower)
    // are deliberately NOT shown here: the contract does not exist yet, and a "refund ETH" button would be a
    // lie. The "EVM leg - simulation" mark hangs in the UI separately (derive().simulated).
    if (xmr.status === XMR_STATUS.LOCKED) {
      // THE MONEY IS AT THE ADDRESS BUT LOCKED BY unlock_time. This is a NAMED state, not "waiting for arrival":
      // otherwise the screen would be silent and the amount would look zero. A readiness mark is impossible here
      // - claiming ETH against locked XMR would give the maker ETH for money that cannot be paid with.
      phase = "xmr_unlock_pending";
      phaseLabel = "XMR is on your address but locked on-chain";
      can.ready = false;
      const u = xmr.lockedUntil || {};
      const untilText = u.untilHeight !== null && u.untilHeight !== undefined
        ? "block " + u.untilHeight
        : (u.untilTime !== null && u.untilTime !== undefined
          ? new Date(Number(u.untilTime) * 1000).toISOString() + " UTC"
          : "a time the sender set");
      note = "The sender set the transaction's unlock_time: " + (xmr.locked || 0) +
        " XMR is on your address but cannot be spent until " + untilText +
        ". Ready stays closed until then - confirming now would let the maker take the ETH behind locked XMR.";
    } else if (!xmr.received) {
      phase = "maker_locking";
      phaseLabel = "Waiting for XMR to arrive";
      note = xmr.error
        ? "Backend unavailable: " + xmr.error
        : "The backend watches your swap address with the view key only - it cannot spend your XMR.";
    } else if (xmr.status === XMR_STATUS.READY) {
      phase = "xmr_locked";
      phaseLabel = "XMR received and confirmed (" + conf + "/" + t.confTarget + ")";
      // THE AMOUNT IS CHECKED TOGETHER WITH READINESS. The backend sees the XMR by the view key and names the
      // amount, while the quote promised its own number: a divergence means the mark would give ETH cheaper than the agreement.
      const paid = xmrAmountCheck(swap, xmr);
      can.ready = paid.ok;
      can.readyAmount = paid;
      note = paid.ok
        ? "Confirm that you see the XMR on your address (ready)."
        : paid.why;
    } else if (xmr.status === XMR_STATUS.SWEPT) {
      phase = "success";
      phaseLabel = "XMR delivered";
    } else {
      phase = "xmr_locked";
      phaseLabel = "XMR received, waiting for confirmations (" + conf + "/" + t.confTarget + ")";
      note = "About " + Math.max(1, Math.round(((t.confTarget - conf) * t.blockSim) / 60000)) + " min left of confirmations.";
    }
  } else if (lockAt === null) {
    // The maker did not lock the XMR. After T0 the user can refund the ETH himself.
    if (sim >= t.t0Sim) {
      phase = "refund_available";
      phaseLabel = "Maker did not lock XMR";
      refundAfterSim = t.t0Sim;
      can.refund = true;
      note = "The maker never locked XMR. You can take your ETH back from the escrow - no permission needed.";
    } else {
      phase = "maker_locking";
      phaseLabel = "Waiting for the maker to lock XMR";
      note = "If the maker does not lock XMR by T0, you get a refund button.";
    }
  } else if (!lockDone) {
    phase = "maker_locking";
    phaseLabel = "Maker is locking XMR";
  } else if (xmrReclaimed) {
    phase = "refund_available";
    phaseLabel = "XMR returned to the maker";
    refundAfterSim = makerReclaimAt;
    can.refund = true;
    note = "You did not confirm (ready) in time, so the maker took the XMR back. Your ETH is still in escrow - refund it.";
  } else if (readyAt === null) {
    phase = "xmr_locked";
    phaseLabel = conf < t.confTarget ? `Waiting for Monero confirmations (${conf}/${t.confTarget})` : "XMR locked and verified - waiting for you";
    can.ready = live ? xmr.status === XMR_STATUS.READY : conf >= t.confTarget;
    refundAfterSim = readyDeadline;
    note = conf < t.confTarget
      ? `About ${Math.max(1, Math.round(((t.confTarget - conf) * t.blockSim) / 60000))} min left of confirmations. You can close this tab.`
      : "Confirm that you see the lock with your view key (ready). Until you do, the maker keeps the XMR.";
  } else if (claimAt !== null && sim < claimAt) {
    phase = "ready_wait_claim";
    phaseLabel = "Waiting for the maker to claim ETH";
    note = "The maker claims the escrow and reveals the secret; your swap wallet uses it to sweep the XMR.";
  } else if (claimAt !== null && sim >= claimAt && sweptAt !== null && sim >= sweptAt) {
    phase = "success";
    phaseLabel = "XMR delivered";
    can.sweep = true;
  } else if (claimAt !== null) {
    phase = "claimed";
    phaseLabel = "Secret revealed - sweeping XMR";
    can.sweep = true;
  } else {
    // maker_stall: ready is done, but no claim happens
    phase = "refund_available";
    phaseLabel = "Maker did not claim in time";
    refundAfterSim = t1At;
    // THE RIGHT TO REFUND IS DETERMINED BY THE CONTRACT, AND THE RULE DEPENDS ON THE ORDER'S AGE - and rightly
    // so, this is not branching for branching's sake. New orders are created with ONE boundary t1: before it
    // nobody may refund, from it anyone may. Orders created earlier carry t0 in their record and keep the old
    // rule: from t0 only the locker may refund, from t1 anyone. Roles and deadlines in old orders are immutable,
    // so there is no migration - they live out their term under the old rules. Compare against real time and by
    // the record's deadlines, not by simulator time (which is accelerated).
    const escrowT0 = swap.escrow && swap.escrow.t0 ? swap.escrow.t0 * 1000 : null;   // only in old orders
    const chainT1 = swap.escrow && swap.escrow.t1 ? swap.escrow.t1 * 1000 : null;
    const realNow = nowReal();
    if (chainT1 !== null) {
      if (escrowT0 !== null) {
        can.refund = realNow >= escrowT0;                   // an old order: from t0, and only the locker
        can.refundByAnyone = realNow >= chainT1;            // from t1 - anyone
      } else {
        // A NEW ORDER: TWO BOUNDARIES. From t1 - as before, a refund is open to all. But if the ready mark is
        // absent, the claim window never opened, and a refund is open right after readyBy: otherwise the dead
        // zone would hold the money and the half until t1. The mark is taken from the RECORD (readyAt) - the
        // user sets it himself, and in this branch it is empty. If the record is lost while the chain has the
        // mark, the contract refuses: an honest refusal instead of a promise we would not keep.
        const chainReadyBy = swap.escrow && swap.escrow.readyBy ? Number(swap.escrow.readyBy) * 1000 : null;
        const earlyRefund = chainReadyBy !== null && realNow >= chainReadyBy && readyAt === null;
        can.refund = realNow >= chainT1 || earlyRefund;
        can.refundByAnyone = can.refund;                    // and from t1 a refund is open to all at once
        if (earlyRefund && realNow < chainT1) refundAfterSim = null;   // the refund is already open: no countdown
      }
    } else if (!isLiveNetwork(swap)) {
      can.refund = sim >= t1At;                             // a demo deal: as before, from the simulator
    } else {
      can.refund = false;                                   // a live deal with unread deadlines: we do not promise
    }
    // WHAT CAN BE DONE NOW - WITHOUT PROMISES WE WILL NOT KEEP. The watchtower is a manual call right now, not a
    // service: it does NOT refund by itself. So we say not "will be refunded automatically" but that the right
    // has appeared for anyone, the watchtower included, and the button still works.
    note = can.refund
      ? (can.refundByAnyone
        ? "The claim deadline passed: the refund is open to anyone who can present the half of the depositor - " +
          "that half is YOURS (it is in your recovery file), and the watchtower does not have it. " +
          "Press Refund my ETH, or restore the file if you have lost this tab."
        : "The maker missed the claim deadline. You can take your ETH back from the escrow yourself.")
      : (escrowT0 !== null
        ? "This order predates the one-deadline rule: you could refund from T0, and from T1 anyone can."
        : "Waiting for T1: before it the ETH can only be claimed with the secret. From T1 the claim closes and the refund opens - and it always pays you, never the caller.");
  }

  // Steps for the stepper
  const confDone = conf >= t.confTarget;
  const claimed = claimAt !== null && sim >= claimAt;
  const steps = [
    { key: "funded", done: true, atSim: 0 },
    { key: "maker_locking", done: lockDone, active: !lockDone && !swap.settlement && lockAt !== null, failed: lockAt === null && sim >= t.t0Sim, atSim: lockAt },
    { key: "xmr_locked", done: confDone && !xmrReclaimed, active: lockDone && !confDone, atSim: lockAt },
    { key: "ready", done: readyAt !== null, active: confDone && readyAt === null && !xmrReclaimed, atSim: readyAt },
    { key: "claimed", done: claimed, active: readyAt !== null && !claimed, atSim: claimAt },
    { key: "swept", done: !!swap.settlement && swap.settlement.kind === "success", active: claimed && !swap.settlement, atSim: swappedAtOrNull(swap) },
  ];

  return {
    swap,
    sim,
    simWallTime: simWall(swap, sim),
    phase,
    phaseLabel,
    note,
    conf,
    confTarget: t.confTarget,
    confProgress: t.confTarget ? conf / t.confTarget : 0,
    // THE DEADLINES FOR DISPLAY ARE TAKEN FROM THE SAME SOURCE AS THE RIGHT TO REFUND - FROM THE DEAL RECORD.
    // Here stood simWall(swap, t.t0Sim): the DEMO SIMULATOR time (accelerated 60x), unrelated to a live deal.
    // That produced a contradiction on one screen: can.refund was computed by the REAL deadline from escrow
    // (saying "not yet"), while the button timer and the "T0 (refund if no XMR lock)" row showed the simulated
    // one (saying "available now" and "in 00:00").
    // Two indicators of the same event must be computed from one quantity: otherwise the screen contradicts
    // itself and the person does not know which deadline to believe.
    // For a LIVE deal the deadlines are contractual (the same as can.refund above), for a demo one - from the simulator.
    deadlines: {
      // t0 EXISTS ONLY IN OLD ORDERS. New ones have one boundary, and for a live deal without t0 it is more
      // honest to show nothing (null) than an invented number: the T0 row is not drawn on screen by this mark.
      // In demo mode the deadline comes from the simulator - it has its own time, deliberately accelerated.
      t0: swap.escrow && swap.escrow.t0 ? swap.escrow.t0 * 1000 : (swap.escrow ? null : simWall(swap, t.t0Sim)),
      t0Sim: t.t0Sim,
      lockAtSim: lockAt,
      readyBy: readyDeadline !== null ? simWall(swap, readyDeadline) : null,
      readyBySim: readyDeadline,
      t1: swap.escrow && swap.escrow.t1 ? swap.escrow.t1 * 1000 : (t1At !== null ? simWall(swap, t1At) : null),
      t1Sim: t1At,
      refundAfterSim,
      refundAfterWall: refundAfterSim !== null ? simWall(swap, refundAfterSim) : null,
    },
    refundLeftSim: refundAfterSim !== null ? refundAfterSim - sim : null,
    // Monero-leg data for the screen: status, address, txid and an explorer link.
    xmr: {
      live: xmr.live,
      source: swap.xmrSource,
      status: xmr.status,
      received: xmr.received,
      // Locks by unlock_time and everything visible at the address: the screen shows the cause and the boundary.
      locked: xmr.locked || 0,
      lockedUntil: xmr.lockedUntil || null,
      arrived: Number(xmr.arrived !== undefined && xmr.arrived !== null ? xmr.arrived : (xmr.received || 0)),
      confirmations: xmr.confirmations,
      confTarget: xmr.confTarget,
      txids: xmr.txids,
      address: xmr.address,
      explorer: explorerXmrTx(xmr.txids[0], (swap.xmrSession && swap.xmrSession.network) || "stagenet"),
      error: xmr.error,
      sweepTxid: xmr.sweepTxid,
    },
    // What is real now and what is a simulation. The UI must show this, not guess.
    // The EVM leg is simulated if and only if the deal's network is not switched to live. It used to stand as a
    // hard true, and on a LIVE deal with a real escrow the screen wrote "EVM leg ... is still simulated" - i.e.
    // lied, although the order existed in the contract. The mark comes from the network settings, not from a
    // field in the deal: the field is set at creation, and deals created earlier still have "mock" there.
    simulated: { evm: !isLiveNetwork(swap), xmr: !xmr.live },
    can,
    // HOW LONG TO THE MARK BOUNDARY and whether it has passed: the boundary exists, the mark does not. A warning
    // SIGNING_GUARDS.minReadyLeadSec seconds before it - because after the boundary NOT ONE button works.
    readyDeadline: {
      atMs: chainReadyByMs,
      soonMs: chainReadyByMs !== null && readyAt === null ? chainReadyByMs - nowReal() : null,
      soon: chainReadyByMs !== null && readyAt === null
        && chainReadyByMs - nowReal() > 0
        && chainReadyByMs - nowReal() <= Number(SIGNING_GUARDS.readyLeadWarnSec || 0) * 1000,
    },
    // BOTH AMOUNTS OUTWARD: the one promised by the quote and the one seen at the address. The screen must show both, not one.
    xmrAmount: { expected: (() => { const e = Number(swap.xmrAmount); return Number.isFinite(e) && e > 0 ? e : null; })(),
                 seen: xmr.received !== null && xmr.received !== undefined ? Number(xmr.received) : null },
    steps,
    // THE SELL WINDOW: the address is already in xmr.address, here is the countdown and its bounds. null on the direct flow.
    sellWindow,
    terminal: swap.settlement,
    xmrReclaimed,
  };
}

function swappedAtOrNull(swap) {
  return swap.settlement && swap.settlement.kind === "success" ? swap.settlement.atSim : null;
}

// ---------------------------------------------------------------------------
// The ticker: finishes deals that must finish without the user
// (auto-sweep and watchtower) and sends changes to subscribers.
// ---------------------------------------------------------------------------

let timer = null;
const listeners = new Set();
const notified = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error(e); }
  }
}

// --- live mode: the swap session on the backend -----------------------------------------------
//
// The poll runs without waiting: the screen ticker must not wait for the network, else with an unavailable backend
// the demo starts to lag. The result is put into the swap itself (xmrSession / xmrSessionError), and derive()
// reads it as ordinary state - it stays a pure function.
const liveInFlight = new Set();

function applyLive(id, patch) {
  const s = loadState();
  if (!s.swaps[id]) return;
  Object.assign(s.swaps[id], patch);
  saveState(s);
}

// The time of the last ATTEMPT to reach the backend per swap. Attempts, not successes: rate limiting must work
// even when the request fails.
const liveLastTry = new Map();


// THE DEAL KEY: THE PAGE AND THE APP NAME IT DIFFERENTLY. The page has its own id (lives in the browser), the
// app its own (localtest-...): the id is set by the app when it creates the watch record. The page asked for the
// XMR state by ITS OWN id, which the app does not know and answers with a refusal. From outside it looks like
// this: the XMR arrived, a dozen confirmations, while the deal screen shows the previous state and the readiness
// button does not open - and the deal window closes in vain (verified by a live run).
// WE TIE BY THE MONERO ADDRESS: the page already reports it to the app when creating the watch, so by it the page
// finds its record and then asks the state by its id. No change in the app is needed.
// ALL RECORDS OF ONE DEAL IN THE BROWSER. There are two (swap and escrow), and one must follow the deal, not
// whichever record the screen happened to land on: the escrow record has no expected XMR amount, so its session
// is not created and the state never reaches the screen. The link is the shared Monero address, one per deal.
export function dealSwapIds(swap) {
  const ids = new Set([String((swap && swap.id) || "")].filter(Boolean));
  const w0 = (() => { try { return halvesWalletOf(swap) || {}; } catch { return {}; } })();
  const address = w0.address || (swap && swap.escrow && swap.escrow.moneroAddress) || null;
  if (!address) return [...ids];
  for (const other of Object.values((loadState() || {}).swaps || {})) {
    if (!other || !other.id) continue;
    const w = (() => { try { return halvesWalletOf(other) || {}; } catch { return {}; } })();
    if (w.address === address) ids.add(String(other.id));
  }
  return [...ids];
}

const serverIdByAddress = new Map();

// WE LOOK FOR THE DEAL'S FACTS ACROSS ALL ITS RECORDS IN THE BROWSER. The page keeps TWO records per deal: one
// created by the swap (Monero address, expected XMR amount), another by the escrow (halves, escrow address). A
// screen opened on the escrow record did not know the expected amount, the session was not created at all and the
// readiness button did not turn on - although the app was already reporting readiness. The records are tied by the SHARED Monero address: one per deal.
function dealFactsFor(swap) {
  const w0 = (() => { try { return halvesWalletOf(swap) || {}; } catch { return {}; } })();
  let address = w0.address || (swap && swap.escrow && swap.escrow.moneroAddress) || (swap && swap.xmrSession && swap.xmrSession.address) || null;
  let amountXmr = Number(swap && swap.xmrAmount) > 0 ? Number(swap.xmrAmount) : null;
  let source = "own record";
  if (address && amountXmr === null) {
    for (const other of Object.values((loadState() || {}).swaps || {})) {
      if (!other || other === swap) continue;
      const w = (() => { try { return halvesWalletOf(other) || {}; } catch { return {}; } })();
      if (!w.address || w.address !== address) continue;
      if (Number(other.xmrAmount) > 0) { amountXmr = Number(other.xmrAmount); source = "another record of the same deal (" + String(other.id || "?") + ")"; break; }
    }
  }
  if (!address) {
    for (const other of Object.values((loadState() || {}).swaps || {})) {
      const w = (() => { try { return halvesWalletOf(other) || {}; } catch { return {}; } })();
      if (w.address && Number(other.xmrAmount) > 0) { address = w.address; amountXmr = amountXmr || Number(other.xmrAmount); source = "another record of the same deal"; break; }
    }
  }
  return { address, amountXmr, source };
}

// WE TAKE THE DEAL ADDRESS FROM EVERYWHERE IT MAY LIE. A browser deal and the app's watch record are DIFFERENT
// records about one deal (the page creates its own for the escrow, the app one for watching the address), so the
// page's record does not always have the address: on the escrow record it lies in the halves, not in the
// escrow.moneroAddress field. A live run therefore polled a dead id, got 404 and left the readiness button off.
// Extracted separately so the same address is used by the server height lookup too.
function dealMoneroAddress(swap) {
  const fromHalves = (() => { try { return (halvesWalletOf(swap) || {}).address || null; } catch { return null; } })();
  return (swap && swap.escrow && swap.escrow.moneroAddress)
    || (swap && swap.xmrSession && swap.xmrSession.address)
    || (swap && swap.swapWallet && swap.swapWallet.address)
    || fromHalves
    || null;
}

// THE SCAN HEIGHT THE APP KNOWS. Needed by OLD deals' files: their record has no birthHeight (the field appeared
// later), while the app resolved and stored the height when registering the watch. The source is ours, so it does
// not depend on someone else's Monero node. The server is silent - we return null and the caller keeps the
// previous behaviour: the height comes from other sources or the file honestly warns of its absence.
export async function serverRestoreHeightFor(swap, { attempts = 3, pauseMs = 1200 } = {}) {
  const addr = dealMoneroAddress(swap);
  if (!addr) return null;
  // NOT ONE ATTEMPT. The app's watch row appears the same instant as the escrow, and the file may be issued a
  // hair earlier: then the fallback source is silent and null goes into the file - and there is nowhere else to
  // get the height, the file is already with the owner. A few short attempts close this gap instead of turning
  // it into an empty field; the price is fractions of a second in the rare case when there is no row at all.
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch("/api/swaps", { headers: { accept: "application/json" } });
      if (r.ok) {
        const j = await r.json();
        const rows = Array.isArray(j) ? j : (j.swaps || []);
        const row = rows.find((x) => String((x && x.address) || "") === String(addr));
        const h = Number(row && row.restoreHeight);
        if (Number.isFinite(h) && h > 0) return h;
      }
    } catch {
      /* try again: the service may have been busy with the first request */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return null;
}

async function resolveServerSwapId(swap) {
  const addr = dealMoneroAddress(swap);
  if (!addr) return null;
  if (serverIdByAddress.has(addr)) return serverIdByAddress.get(addr);
  try {
    const r = await fetch("/api/swaps", { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.swaps || []);
    const row = rows.find((x) => String((x && x.address) || "") === String(addr));
    if (!row || !row.id) return null;
    serverIdByAddress.set(addr, String(row.id));
    return String(row.id);
  } catch {
    return null;   // the server is silent - we keep the previous behaviour, the screen does not wait for the network
  }
}

function refreshLiveSession(id) {
  if (liveInFlight.has(id)) return;
  // No more than once per pollMs per swap, REGARDLESS of whether the session survived. The limit used to stand
  // only in the "session exists" branch: if the request failed (429 from the proxy, 502 from a timeout), the
  // session was not saved, the limit did not apply - and the tick repeated the request every 5 seconds for EACH
  // swap. With eight accumulated swaps that produced a stream of 429s: the app fought itself.
  const now = Date.now();
  const lastTry = liveLastTry.get(id) || 0;
  if (now - lastTry < pollInterval()) return;
  liveLastTry.set(id, now);
  liveInFlight.add(id);
  (async () => {
    try {
      const fresh = loadState().swaps[id];
      if (!fresh || fresh.settlement) return;
      if (!fresh.xmrSession) {
        // The swap wallet is created in the browser; only the address and view key go outward (see chainSource).
        // THE EXPECTED AMOUNT IS MANDATORY. Without it we do not create a session at all: the wallet is the same
        // as on the confirmation screen, so the address is already watched. Otherwise a second truth about one
        // deal would appear at the same address, and a record without an amount would let an underpayment through.
        // As soon as the amount appears, the next tick creates the session itself.
        const facts = dealFactsFor(fresh);
        const amountXmr = facts.amountXmr;
        if (!Number.isFinite(amountXmr) || amountXmr <= 0) {
          pushLog(fresh, simElapsed(fresh), "Backend session not opened yet: amount of XMR is unknown", String((fresh && fresh.xmrAmount) ?? "no"));
          return;
        }
        if (facts.source !== "own record") {
          pushLog(fresh, simElapsed(fresh), "Amount of XMR taken from the deal's other record", facts.source + ", " + String(amountXmr));
        }
        const share = watchOnlyShareFromWallet({ swapId: fresh.id, wallet: fresh.swapWallet });
        const opened = await openSession({
          swapId: fresh.id,
          share,
          expectedAmountXmr: amountXmr,
          chain: fresh.network,
        });
        if (opened.ok) {
          applyLive(id, { xmrSession: opened.session, xmrSessionError: null });
          const s2 = loadState();
          if (s2.swaps[id]) {
            pushLog(s2.swaps[id], simElapsed(s2.swaps[id]), "Backend session opened (watch-only: address + view key)", opened.session.address || "");
            saveState(s2);
          }
        } else {
          applyLive(id, { xmrSessionError: opened.error });
        }
      } else if (Date.now() - (fresh.xmrSession.at || 0) >= pollInterval()) {
        // WE ASK BY THE APP'S ID, not our own: see resolveServerSwapId. If the record was not found, we do NOT
        // ask by our own id - the app will answer 404 and the screen will silently wait forever. Instead we
        // create the watch afresh: the app itself ties it by address to the existing record and returns the same
        // one, not a second truth about one deal.
        const serverId = await resolveServerSwapId(fresh);
        const polled = await fetchSession(serverId || id);
        if (polled.ok) {
          applyLive(id, { xmrSession: polled.session, xmrSessionError: null });
        } else if (!serverId) {
          const share = watchOnlyShareFromWallet({ swapId: fresh.id, wallet: fresh.swapWallet });
          const again = await openSession({
            swapId: fresh.id, share, expectedAmountXmr: Number(fresh.xmrAmount), chain: fresh.network,
          });
          if (again.ok) {
            applyLive(id, { xmrSession: again.session, xmrSessionError: null });
            const s3 = loadState();
            if (s3.swaps[id]) { pushLog(s3.swaps[id], simElapsed(s3.swaps[id]), "Backend record re-linked by the Monero address", again.session.address || ""); saveState(s3); }
          } else {
            applyLive(id, { xmrSessionError: again.error });
          }
        } else {
          applyLive(id, { xmrSessionError: polled.error });
        }
      }
    } catch (e) {
      applyLive(id, { xmrSessionError: "session did not open: " + e.message });
    } finally {
      liveInFlight.delete(id);
    }
  })();
}

// The deals currently open on screen. The core polls the backend ONLY for them.
//
// Why: the tick used to poll all unfinished deals indiscriminately. After a few presses of the sign button they
// accumulated to eight, and the app itself flooded the proxy with requests - a 429 came back. And on the main
// page there is nothing to watch at all: there is no deal yet.
//
// An empty set (the default) means "poll nothing". Screens that need watching report their set themselves: the
// deal list - all unfinished, the deal screen - one.
let liveFocusIds = new Set();

export function setLiveFocus(ids) {
  liveFocusIds = new Set(Array.isArray(ids) ? ids.map(String) : []);
  return liveFocusIds.size;
}

export function tick() {
  const s = loadState();
  let changed = false;

  for (const swap of Object.values(s.swaps)) {
    if (swap.settlement) continue;

    // Live mode: a session on the backend. We create it on the first tick after the swap is created and then
    // poll no more often than API.pollMs. Not awaited: the screen must not wait for the network.
    // We poll only what is open on screen.
    if (isLiveSource(swap.xmrSource) && liveFocusIds.has(String(swap.id))) refreshLiveSession(swap.id);

    const view = derive(swap);

    // the maker locks the XMR at the joint one-shot address (except the maker_no_lock scenario)
    if (!isLiveSource(swap.xmrSource) && !swap.xmr && view.deadlines.lockAtSim !== null && view.sim >= view.deadlines.lockAtSim) {
      const lock = chain.lockXmr({ swapId: swap.id, xmrAmount: swap.xmrAmount });
      swap.xmr = { ...lock, reclaimed: false, sweepTxid: null };

      // In live mode we fix the node's real height at the lock moment: confirmations are counted from it
      // (a Monero block is ~2 minutes, so the deal really takes ~20 minutes).
      if (swap.chainMode === "live") {
        const snap = node.snapshot();
        swap.xmr.lockHeight = snap ? snap.height : null;
        if (!swap.xmr.lockHeight) {
          node.getInfo({ force: true }).then((info) => {
            if (info && !swap.settlement) {
              const s2 = loadState();
              if (s2.swaps[swap.id]) {
                s2.swaps[swap.id].xmr.lockHeight = info.height;
                saveState(s2);
              }
            }
          });
        }
      }

      pushLog(swap, view.sim, "Maker locked XMR on the shared address", lock.txid);
      const key = swap.id + ":lock";
      if (!notified.has(key)) { notified.add(key); notify(swap.xmrAmount.toFixed(4) + " XMR locked; view key verified", "ok"); }
      changed = true;
    }

    // Live mode: the first seen XMR arrival is turned into a swap.xmr record with the REAL txid, so the rest of
    // the code (logs, steps, screens) works with it the same as with a mock lock.
    if (isLiveSource(swap.xmrSource) && !swap.xmr && view.xmr && view.xmr.received > 0) {
      swap.xmr = {
        mock: false,
        txid: view.xmr.txids[0] || null,
        address: view.xmr.address,
        amount: view.xmr.received,
        confirmations: view.xmr.confirmations,
        status: view.xmr.status,
        explorer: view.xmr.explorer,
        reclaimed: false,
        sweepTxid: null,
      };
      pushLog(swap, view.sim, "XMR received (backend, " + ((swap.xmrSession && swap.xmrSession.network) || "stagenet") + ")", swap.xmr.txid || "");
      const key = swap.id + ":xmr-in";
      if (!notified.has(key)) {
        notified.add(key);
        notify(view.xmr.received.toFixed(6) + " XMR received; confirmations " + view.xmr.confirmations + "/" + view.xmr.confTarget, "ok");
      }
      changed = true;
    }

    // Live mode: the withdrawal is confirmed by the sweep page (a watch-only wallet cannot see outgoing
    // transfers), so the final state is taken from the session status, and the hash is not invented.
    if (isLiveSource(swap.xmrSource) && swap.xmrSession && swap.xmrSession.status === XMR_STATUS.SWEPT && !swap.settlement) {
      const atSim = view.sim;
      swap.settlement = {
        kind: "success",
        phase: TERMINAL.success.phase,
        atSim,
        txid: swap.xmrSession.sweepTxid || null,
        by: "your sweep wallet",
      };
      pushLog(swap, atSim, "XMR swept by you (backend reported)", swap.settlement.txid || "");
      const key = swap.id + ":success";
      if (!notified.has(key)) {
        notified.add(key);
        notify("Swap " + swap.id + " complete: XMR is on your address", "ok");
      }
      changed = true;
      continue;
    }

    // happy path: after claim the user's wallet sweeps the XMR itself (litepaper §4.2)
    if (!isLiveSource(swap.xmrSource) && view.can.sweep && view.phase === "success") {
      const atSim = view.sim;
      swap.xmr.sweepTxid = chain.sweepXmr({ swapId: swap.id }).txid;
      swap.settlement = { kind: "success", phase: TERMINAL.success.phase, atSim, txid: swap.xmr.sweepTxid, by: "your swap wallet" };
      pushLog(swap, atSim, "XMR swept to your address", swap.xmr.sweepTxid);
      const key = swap.id + ":success";
      if (!notified.has(key)) { notified.add(key); notify("Swap " + swap.id + " complete: XMR is on your address", "ok"); }
      changed = true;
      continue;
    }

    // watchtower: if the user left and the money can be refunded - the watchtower does it
    if (!isLiveSource(swap.xmrSource) && view.can.refund && view.refundLeftSim !== null && view.refundLeftSim <= -TIMING.watchtowerGrace) {
      const atSim = view.sim;
      const tx = chain.refundEscrow({ swapId: swap.id, by: "watchtower" });
      swap.settlement = { kind: "refund_eth", phase: TERMINAL.refunded_eth.phase, atSim, txHash: tx.txHash, by: "watchtower" };
      pushLog(swap, atSim, "Watchtower refunded your ETH", tx.txHash);
      const key = swap.id + ":refund";
      if (!notified.has(key)) { notified.add(key); notify("Watchtower refunded the ETH escrow of swap " + swap.id, "bad"); }
      changed = true;
      continue;
    }

    // the "user did not confirm" scenario: the maker takes the XMR back
    if (!isLiveSource(swap.xmrSource) && swap.xmr && view.xmrReclaimed && !swap.xmr.reclaimed) {
      swap.xmr.reclaimed = true;
      pushLog(swap, view.sim, "Maker reclaimed the XMR", swap.xmr.txid);
      const key = swap.id + ":reclaim";
      if (!notified.has(key)) { notified.add(key); notify("Maker took the XMR back: no ready() call in time", "bad"); }
      changed = true;
    }
  }

  if (changed) {
    saveState(s);
  }
}

const notifier = { fn: null };
export function onNotify(fn) {
  notifier.fn = fn;
}
function notify(msg, kind) {
  if (notifier.fn) notifier.fn(msg, kind);
}

export function startTicker(intervalMs = 400) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    try { tick(); } catch (e) { console.error(e); }
    emit(); // the screen redraws every tick: confirmations and timers run live
  }, intervalMs);
}



