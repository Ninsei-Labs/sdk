// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/chainSource.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// DATA SOURCE FOR THE MONERO LEG OF THE SWAP: the demo simulator or the real backend.
// TWO LEGS, DIFFERENT READINESS. The EVM leg (escrow, claim, refund) is a SIMULATION (no contract yet): every
// reply is marked mock: true and the UI must show it. The Monero leg (has XMR arrived, how many confirmations)
// can be REAL: the backend tracks a watch-only wallet by address and view key, while the spend key stays in the browser.
// So the source is chosen for the Monero leg: 'mock' (sim-time, no network) or 'app' (HTTP to the backend).
// A BOUNDARY PINNED BY CODE: only the address and view key go to the backend, and the request body is rebuilt from
// a field allowlist, so neither the spend key nor the seed can leave.

import { API, XMR_NETWORKS, MONERO } from "./config.js";
import { confirmations as mockConfirmations } from "../mock/chain.js";

// Backend statuses - the same strings the API returns.
export const XMR_STATUS = {
  AWAITING: "awaiting_funding", // nothing has arrived at the address yet (or less than expected)
  FUNDED: "funded", // arrived, confirmations below target
  // MONEY ON THE ADDRESS BUT LOCKED by unlock_time: NOT an arrival, and 'ready' does not turn on.
  // A separate status, named by the backend itself.
  LOCKED: "xmr_locked",
  READY: "ready", // enough confirmations: the user can confirm readiness
  SWEPT: "swept", // XMR withdrawn by the user
  CLOSED: "closed", // swap closed (cancelled or refunded)
};

// The only fields allowed to be sent to the backend when a swap is created.
export const ALLOWED_SESSION_FIELDS = ["swapId", "network", "address", "viewKey", "expectedAmountXmr", "restoreHeight", "chain"];

export function isLiveSource(source = API.xmrSource) {
  return source === "app";
}

// The Monero network the swap address must use for this source.
export function xmrNetworkForSource(source = API.xmrSource) {
  return XMR_NETWORKS[isLiveSource(source) ? "app" : "mock"];
}

export function xmrSourceLabel(source = API.xmrSource) {
  return isLiveSource(source) ? "backend app/ (stagenet)" : "demo simulator";
}

// ---------------------------------------------------------------------------
// HTTP to the backend
//
// The base can be overridden. In the browser this is not needed: "/api" is a relative path of the same origin
// and the CSP (connect-src self) covers it. The override exists for Node tests and for a non-production host.
let apiBaseOverride = null;
export function setApiBase(base) {
  apiBaseOverride = base ? String(base).replace(/[/]$/, "") : null;
}

// Polling settings that can be overridden: needed by tests (interval in milliseconds, not seconds) and by the
// screen. Defaults come from config.
let pollMsOverride = null;
export function setApiOptions({ pollMs } = {}) {
  if (Number.isFinite(Number(pollMs)) && Number(pollMs) > 0) pollMsOverride = Number(pollMs);
  return { pollMs: pollMsOverride || "default" };
}
export function pollInterval() {
  return pollMsOverride || API.pollMs;
}
// ---------------------------------------------------------------------------

// One API request. It NEVER throws: a failed network is a screen state, not a demo crash, and the user must
// see the reason, not a blank page.
async function api(path, { method = "GET", body, base, timeoutMs = API.timeoutMs, fetchImpl } = {}) {
  const target = base || apiBaseOverride || API.base;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, status: 0, error: "no fetch: backend unavailable" };
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await doFetch(target + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined,
    });
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON - the reason will be visible from the text */
    }
    if (!res.ok) {
      const base_ = (json && (json.error || json.detail)) || text.slice(0, 200) || `HTTP ${res.status}`;
      const extra = json && Array.isArray(json.problems) ? ": " + json.problems.join("; ") : "";
      return { ok: false, status: res.status, error: `${base_}${extra}` };
    }
    return { ok: true, status: res.status, json };
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: aborted ? `backend did not answer within ${timeoutMs} ms` : "backend unavailable: " + ((e && e.message) || e),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Backend response -> a snapshot for the screen and the state engine.
export function normalizeSession(json) {
  const j = json || {};
  return {
    id: j.id || null,
    status: j.status || XMR_STATUS.AWAITING,
    network: j.network || null,
    address: j.address || null,
    expectedAmountXmr: j.expectedAmountXmr ?? null,
    receivedXmr: j.receivedXmr ?? "0",
    receivedAtomic: j.receivedAtomic ?? "0",
    // LOCKED unlock_time: the sum and the boundary ({code,untilHeight,untilTime}) - separate from the arrival.
    lockedXmr: j.lockedXmr ?? "0",
    lockedAtomic: j.lockedAtomic ?? "0",
    lockedUntil: j.lockedUntil || null,
    confirmations: Number(j.confirmations) || 0,
    fundingTxids: Array.isArray(j.fundingTxids) ? j.fundingTxids : [],
    nodeHeightAtSeen: j.nodeHeightAtSeen ?? null,
    sweepTxid: j.sweepTxid || null,
    updatedAt: j.updatedAt || null,
    at: Date.now(),
  };
}

// Creating a swap on the backend. share is what watchOnlyShareFromWallet() returns: address + private view key.
// The spend key stays in the browser. The same intent (sum, currency, network) must not create a new swap on
// the same address. A pure function - checked without a network.
export function sameSwapTarget(a, b) {
  if (!a || !b) return false;
  return String(a.payAmount) === String(b.payAmount) &&
    a.payToken === b.payToken &&
    a.chain === b.chain;
}

export async function openSession({ swapId, share, expectedAmountXmr, chain, restoreHeight }, opts = {}) {
  const src = share || {};
  const address = src.address || null;
  const viewKey = src.viewKey || src.privateViewKey || null;
  if (!address || !viewKey) {
    return { ok: false, status: 0, error: "the watch-only share has no address/viewKey - nothing to send to the backend" };
  }
  // THE EXPECTED AMOUNT IS MANDATORY and must be a number. Before, a non-number meant no field, and the swap
  // was created WITHOUT an amount: any arrival was accepted as enough, so an underpayment looked like a done
  // deal. Now it is a refusal with an explanation.
  const amountXmr = Number(expectedAmountXmr);
  if (!Number.isFinite(amountXmr) || amountXmr <= 0) {
    const where = (new Error("caller").stack || "").split("\n").slice(1, 4).map((x) => x.trim().split("/").pop()).join(" <- ");
    console.warn("[chainSource] no expected amount, call from: " + where);
    return { ok: false, status: 0, error: "the expected XMR amount is unknown (" + String(expectedAmountXmr) + "): without it no watch is created" };
  }
  const wanted = {
    swapId: swapId || src.swapId || null,
    network: src.network || xmrNetworkForSource(),
    address,
    viewKey,
    expectedAmountXmr: amountXmr,
    restoreHeight: Number.isFinite(Number(restoreHeight)) && Number(restoreHeight) > 0 ? Number(restoreHeight) : Number(src.restoreHeight) || undefined,
    chain: chain || undefined,
  };
  // The body is rebuilt from the allowlist: what is not in the list never reaches the request.
  const body = {};
  for (const field of ALLOWED_SESSION_FIELDS) {
    if (wanted[field] !== undefined && wanted[field] !== null) body[field] = wanted[field];
  }
  const res = await api("/swaps", { method: "POST", body, ...opts });
  if (!res.ok) return res;
  return { ok: true, status: res.status, created: res.json?.created !== false, session: normalizeSession(res.json) };
}

export async function fetchSession(swapId, opts = {}) {
  const res = await api(`/swaps/${encodeURIComponent(swapId)}`, opts);
  if (!res.ok) return res;
  return { ok: true, status: res.status, session: normalizeSession(res.json) };
}

// Tell the backend the XMR was withdrawn (the hash of the real transfer). Needed because a watch-only wallet
// cannot see outgoing transfers.
export async function reportSwept(swapId, txid, opts = {}) {
  const res = await api(`/swaps/${encodeURIComponent(swapId)}/swept`, { method: "POST", body: { txid }, ...opts });
  return res.ok ? { ok: true, status: res.status, session: normalizeSession(res.json) } : res;
}

// Close the swap (cancel or refund on the backend): the watch stops.
export async function closeSession(swapId, reason = "cancelled", opts = {}) {
  const res = await api(`/swaps/${encodeURIComponent(swapId)}/closed`, { method: "POST", body: { reason }, ...opts });
  return res.ok ? { ok: true, status: res.status, session: normalizeSession(res.json) } : res;
}

// Backend state: is it up and does it see the wallet. The screen needs this to show 'backend unavailable'
// before the user sends money, not after.
export async function health(opts = {}) {
  const res = await api("/health", opts);
  return res.ok ? { ok: true, ...res.json } : res;
}

// ---------------------------------------------------------------------------
// The Monero-leg snapshot for the state engine
// ---------------------------------------------------------------------------

// Mock mode: confirmations by sim-time, as the demo always did.
export function mockView(swap, simElapsedMs) {
  const confTarget = (swap.timeline && swap.timeline.confTarget) || MONERO.confirmTarget;
  const lockAt = swap.timeline ? swap.timeline.lockAtSim : 0;
  const locked = lockAt !== null && simElapsedMs >= lockAt;
  const confirmations = mockConfirmations(swap, simElapsedMs);
  const status = !locked ? XMR_STATUS.AWAITING : confirmations >= confTarget ? XMR_STATUS.READY : XMR_STATUS.FUNDED;
  // WHAT ACTUALLY ARRIVED. By default the quoted amount: the demo path without underpayment. If the record names
  // the amount that REALLY arrived (swap.xmr.received), show that: it is exactly what an underpayment looks like -
  // the shortfall that sends the order into a refund - and the screen must name BOTH numbers, not repeat one twice.
  const stated = Number(swap.xmr && swap.xmr.received);
  const received = locked ? (Number.isFinite(stated) ? stated : swap.xmrAmount) : 0;
  return {
    live: false,
    status,
    received,
    // The demo simulator has no unlock_time lock: the arrival and the unlocked are the same.
    unlocked: received,
    locked: 0,
    lockedUntil: null,
    arrived: received,
    confirmations,
    confTarget,
    txids: swap.xmr && swap.xmr.txid ? [swap.xmr.txid] : [],
    address: (swap.xmr && swap.xmr.address) || null,
    sweepTxid: (swap.xmr && swap.xmr.sweepTxid) || null,
    error: null,
  };
}

// Live mode: take the latest backend poll, put there by the ticker; derive() stays a pure function - it reads
// state, not the network.
export function liveView(swap) {
  const confTarget = (swap.timeline && swap.timeline.confTarget) || MONERO.confirmTarget;
  const s = swap.xmrSession;
  if (!s) {
    return {
      live: true,
      status: swap.xmrSessionError ? "error" : "opening",
      received: 0,
      unlocked: 0,
      locked: 0,
      lockedUntil: null,
      arrived: 0,
      confirmations: 0,
      confTarget,
      txids: [],
      address: (swap.swapWallet && swap.swapWallet.address) || null,
      sweepTxid: null,
      error: swap.xmrSessionError || null,
    };
  }
  return {
    live: true,
    status: swap.xmrSessionError ? "error" : s.status,
    // ARRIVAL AND UNLOCKED ARE DIFFERENT FACTS. received - what can be spent (receivedXmr); locked - unlock_time-
    // locked; arrived - everything visible at the address. The backend names the state.
    received: Number(s.receivedXmr) || 0,
    unlocked: Number(s.receivedXmr) || 0,
    locked: Number(s.lockedXmr) || 0,
    lockedUntil: s.lockedUntil || null,
    arrived: (Number(s.receivedXmr) || 0) + (Number(s.lockedXmr) || 0),
    confirmations: s.confirmations,
    confTarget,
    txids: s.fundingTxids,
    address: s.address || (swap.swapWallet && swap.swapWallet.address) || null,
    sweepTxid: s.sweepTxid,
    error: swap.xmrSessionError || null,
  };
}

export function xmrView(swap, simElapsedMs) {
  return isLiveSource(swap && swap.xmrSource) ? liveView(swap) : mockView(swap, simElapsedMs);
}

// A link to the transfer in an explorer. In live mode this is stagenet: it must not be signed as real money, so
// the network comes from the session.
export function explorerXmrTx(txid, network = "stagenet") {
  if (!txid) return null;
  const prefix = network === "mainnet" ? "" : network + ".";
  return `https://${prefix}xmrchain.net/tx/${txid}`;
}
