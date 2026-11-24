// ONE DECISION FOR REFUND, CLAIM, READY MARK AND THE SALE'S SEND WINDOW.
//
// This module is deliberately pure. It receives the escrow cut and the two clocks as data; it never calls Date.now()
// and never reads a wallet, a chain or a configuration. The SDK paths that sign, the site and the recovery page can
// therefore agree on one answer before any of them asks a person to confirm.
import { SdkError } from "./errors.mjs";

export const ACTION_DECISION_DEFAULTS = Object.freeze({
  refundLeadSec: 780,
  refundMarginSec: 180,
  claimMarginSec: 60,
  markReadyMarginSec: 60,
});

const bad = (field, why = null) => new SdkError("bad-input", why ? { field, why } : { field });
const int = (value, field, { min = 0 } = {}) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw bad(field);
  return n;
};
const bool = (value, field) => {
  if (typeof value !== "boolean") throw bad(field);
  return value;
};
const optionalInt = (value, field, fallback) => (value === undefined || value === null ? fallback : int(value, field));

function readEscrow(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw bad("escrow");
  const status = value.status;
  if (!status || typeof status !== "object") throw bad("escrow.status");
  const isFunded = bool(status.isFunded, "escrow.status.isFunded");
  const isClaimed = bool(status.isClaimed, "escrow.status.isClaimed");
  const isRefunded = bool(status.isRefunded, "escrow.status.isRefunded");
  const ready = bool(value.ready, "escrow.ready");
  const readyBy = int(value.readyBy, "escrow.readyBy", { min: 1 });
  const t1 = int(value.t1, "escrow.t1", { min: 1 });
  const block = value.block;
  if (!block || typeof block !== "object") throw bad("escrow.block");
  const blockTimeSec = int(block.timestamp, "escrow.block.timestamp", { min: 1 });
  return { status: { isFunded, isClaimed, isRefunded }, ready, readyBy, t1, blockTimeSec };
}

// The arrival's kind is the part the decision needs. An error code is kept as the same kind the returned verdict
// would carry, so a caller that still catches `xmr-underpaid`/`xmr-locked` gets the same rule.
function arrivalKindOf(arrival, arrivalError) {
  const code = arrivalError && typeof arrivalError === "object" ? arrivalError.code : null;
  if (code === "xmr-underpaid") return "short";
  if (code === "xmr-locked") return "locked";
  if (code) return "unknown";
  if (!arrival || typeof arrival !== "object") return "unknown";
  if (arrival.absent === true) return "absent";
  const state = String(arrival.state || "");
  if (state === "arrived") return "arrived";
  // `over` is an at-least payment that passed the signed amount; a buy may mark it ready. An exact sale claim still
  // refuses it through `exactArrival` because the comparison is not `"exact"`.
  if (state === "over") return "arrived";
  if (state === "short") return "short";
  if (state === "locked") return "locked";
  if (state === "pool") return "pool";
  if (state === "one-node") return "one";
  if (state === "confirming" || state === "pending") {
    if (arrival.absent === true) return "absent";
    // Both operators can see the whole amount while its confirmations are still accruing. That is not a missing
    // payment and it is not a claim yet; it is `seen`.
    const amount = String(arrival.amountAtomic ?? "");
    if (arrival.txid && amount && amount !== "0") {
      if (arrival.amountComparison === "short") return "short";
      return "seen";
    }
    return state === "pending" ? "unknown" : "confirming";
  }
  return "unknown";
}

const exactArrival = (arrival, kind) =>
  kind === "arrived" && (arrival.amountComparison === undefined || arrival.amountComparison === "exact");

const knownArrival = (kind) => ["arrived", "short", "locked", "absent"].includes(kind);

export function actionDecision(request) {
  if (!request || typeof request !== "object") throw bad("request");
  if (request.side !== "buy" && request.side !== "sale") throw bad("side");
  const deviceTimeSec = int(request.deviceTimeSec, "deviceTimeSec", { min: 1 });
  const escrow = readEscrow(request.escrow === undefined ? null : request.escrow);
  const arrival = request.arrival === undefined ? null : request.arrival;
  const kind = arrivalKindOf(arrival, request.arrivalError);
  const read = knownArrival(kind) ? "complete" : "unknown";
  const answer = (action, reason, untilSec = null) => ({
    action, reason, untilSec, blockTimeSec: escrow ? escrow.blockTimeSec : null, deviceTimeSec, read,
  });

  if (!escrow) return answer("unknown", "escrow-unread");
  const { status, ready, readyBy, t1, blockTimeSec } = escrow;
  // A DEVICE CLOCK MAY CLOSE A WINDOW, NEVER OPEN ONE. Every closing boundary uses the later of the read block and
  // the device; every opening boundary uses the read block.
  const closingNow = Math.max(blockTimeSec, deviceTimeSec);

  if (status.isClaimed || status.isRefunded) return answer("none", "closed");
  if (!status.isFunded) return answer("none", "not-funded");
  if (!(readyBy < t1)) return answer("unknown", "bad-deadlines");

  const refundLeadSec = optionalInt(request.refundLeadSec, "refundLeadSec", ACTION_DECISION_DEFAULTS.refundLeadSec);
  const refundMarginSec = optionalInt(request.refundMarginSec, "refundMarginSec", ACTION_DECISION_DEFAULTS.refundMarginSec);
  const claimMarginSec = optionalInt(request.claimMarginSec, "claimMarginSec", ACTION_DECISION_DEFAULTS.claimMarginSec);
  const markReadyMarginSec = optionalInt(request.markReadyMarginSec, "markReadyMarginSec", ACTION_DECISION_DEFAULTS.markReadyMarginSec);
  // A SALE MUST NAME ITS LEAD. The node's signed window owns this number; a silent 1200 s default would recreate the
  // disagreement issue #390 removes.
  const saleLeadSec = request.side === "sale"
    ? int(request.saleLeadSec, "saleLeadSec")
    : optionalInt(request.saleLeadSec, "saleLeadSec", 0);
  const earlyRefundClosesAt = readyBy - refundMarginSec;
  const claimClosesAt = t1 - claimMarginSec;

  if (request.side === "buy") {
    // The settlement deadline is a read-block fact. A device clock at or after t1 must not open it.
    if (blockTimeSec >= t1) return answer("refund", "late-refund");
    if (blockTimeSec >= readyBy) return answer("none", "claim-window");
    if (ready) return answer("none", "ready-marked");

    if (kind === "arrived") {
      const markClosesAt = readyBy - markReadyMarginSec;
      if (blockTimeSec < markClosesAt && closingNow < markClosesAt) {
        return answer("markReady", "arrival-verified", markClosesAt);
      }
      return answer("none", "ready-window-closed");
    }

    // Both operators see the full amount; its confirmations are still accruing. A refund would cut a swap that is
    // going fine, and a ready mark is not allowed until the arrival is complete.
    if (kind === "seen") return answer("later", "confirmations");

    // A short or locked payment is already a reason to offer the way out. The protective margin still closes it.
    if (kind === "short" || kind === "locked") {
      if (closingNow < earlyRefundClosesAt) return answer("refund", kind === "short" ? "arrival-short" : "arrival-locked", earlyRefundClosesAt);
      return answer("none", "refund-margin");
    }

    // An unknown, absent or one-operator read is not a payment. It waits for the warning window, then is offered
    // as a refund with the uncertainty still visible; the caller decides whether to ask the person.
    const refundOpensAt = readyBy - refundLeadSec;
    // A device clock may close the window even when the read block is still early; it may never open one.
    if (closingNow >= earlyRefundClosesAt) return answer("none", "refund-margin");
    if (blockTimeSec < refundOpensAt) return answer("later", "refund-window-opens", refundOpensAt);
    return answer("refund", "refund-window");
  }

  // Sale: the seller may start sending XMR until the node's lead before readyBy. The same deadline is used when a
  // card is reopened; the decision does not sign or send.
  if (blockTimeSec >= t1) return answer("none", "claim-window-closed");
  if (ready) {
    if (closingNow < claimClosesAt) return answer("claim", "claim-ready", claimClosesAt);
    return answer("none", "claim-margin");
  }
  if (blockTimeSec >= readyBy) {
    if (exactArrival(arrival, kind)) {
      if (closingNow < claimClosesAt) return answer("claim", "claim-proof", claimClosesAt);
      return answer("none", "claim-margin");
    }
    if (kind === "unknown" || kind === "one" || kind === "confirming" || kind === "pool") {
      return answer("unknown", "arrival-unknown");
    }
    if (kind === "seen") return answer("later", "confirmations");
    return answer("none", "claim-not-proven");
  }

  const sendClosesAt = readyBy - saleLeadSec;
  // The money is already at the joint address. Sending it again would be a second payment; wait for the claim to
  // open at readyBy instead. An exact amount is the only arrival that can claim without the Ready mark.
  if (kind === "seen" || kind === "arrived") return answer("later", "claim-window-opens", readyBy);
  if (blockTimeSec < sendClosesAt && closingNow < sendClosesAt) return answer("sendXmr", "send-window", sendClosesAt);
  // The ring is closed, but the claim may still open at readyBy if the exact amount is proven by then.
  return answer("later", "claim-window-opens", readyBy);
}
