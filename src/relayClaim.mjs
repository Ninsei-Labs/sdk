// ONE HTTP HOP TO A RELAY CLAIM.
//
// A seller on a bid holds XMR and no ETH. The escrow pays the signed `claimTip` out of the payout, so a sender can
// submit the seller's one-time half and be repaid from the claim itself. This module joins the stored sale record
// to that wire: it builds the exact body, sends it once to the relay that answered the quote, and returns a claim
// ONLY when the answer carries a real transaction hash. No wallet is created, used or signed here.
import { SdkError } from "./errors.mjs";
import { createHttp } from "./http.mjs";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HALF = /^[0-9a-f]{64}$/;
const TXID = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * THE RELAY ORIGIN, NORMALISED ONCE. A claim is bound to the origin that answered the quote, so a trailing slash
 * is not a different relay. Plain http is refused for the same reason a quote refuses it: the half must not travel
 * through a hop any middlebox can read and change.
 */
export function relayOriginOf(value) {
  const base = String(value === undefined || value === null ? "" : value).trim().replace(/\/+$/, "");
  if (!base) throw new SdkError("bad-input", { field: "relayUrl" });
  if (!/^https:\/\//i.test(base)) throw new SdkError("bad-input", { field: "relayUrl", why: "not-https" });
  return base;
}

/** A 20-byte address, lower-cased for the path and for comparison. */
export function addressTextOf(value, field) {
  const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (!ADDRESS.test(text)) throw new SdkError("bad-input", { field });
  return text;
}

/** The seller's half in the one form the relay accepts: `0x` and exactly 64 hex digits. */
export function halfTextOf(value) {
  const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase().replace(/^0x/, "");
  if (!HALF.test(text)) throw new SdkError("bad-input", { field: "halfClaimer", why: "not-in-record" });
  return "0x" + text;
}

/**
 * POST the half to the relay that answered the quote.
 *
 * A refusal from the relay is `quote-refused` with the provider's own code kept in `params.code`; the provider's
 * message is deliberately NOT copied, because it is not this package's user-facing text. A lost answer is
 * `claim-unknown`: the claim may have been sent, so a second call must begin by reading the escrow, never by
 * assuming that nothing happened. Only a validated transaction hash is a success.
 */
export async function postRelayClaim({
  relayUrl,
  provider,
  escrow,
  halfClaimer,
  expectedTipWei,
  fetchImpl = null,
  timeoutMs = 20_000,
} = {}) {
  const base = relayOriginOf(relayUrl);
  const to = addressTextOf(provider, "provider");
  const at = addressTextOf(escrow, "escrow");
  const half = halfTextOf(halfClaimer);
  const http = createHttp({ apiBase: base, fetchImpl, timeoutMs });
  const body = JSON.stringify({ version: 1, halfClaimer: half });

  let response;
  try {
    response = await http.tryJson(`/v1/claims/${to}/${at}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (error) {
    // A missing fetch is a caller's input problem, not an unknown claim. Everything else that prevented an answer
    // leaves the outcome UNKNOWN: the request may have reached the relay and the claim may already be sent.
    if (error instanceof SdkError && error.code === "bad-input") throw error;
    throw new SdkError("claim-unknown", {
      step: "relay-claim",
      why: (error && error.params && error.params.why) || "answer-lost",
      outcome: "unknown",
    });
  }

  const answer = response.body && typeof response.body === "object" ? response.body : null;
  const version = answer ? Number(answer.version) : null;
  const code = answer && typeof answer.code === "string" && answer.code ? answer.code : null;

  if (!response.ok) {
    if (code === "claim-unknown" || code === "claim_unknown") {
      throw new SdkError("claim-unknown", { step: "relay-claim", why: "relay-timeout", code, status: response.status, outcome: "unknown" });
    }
    if (code && version === 1) throw new SdkError("quote-refused", { step: "relay-claim", code, status: response.status });
    // AN UNVERSIONED NON-2XX IS NOT A REFUSAL WE CAN READ. The claim may still have been sent, so it is unknown.
    throw new SdkError("claim-unknown", { step: "relay-claim", why: "answer-status", status: response.status, outcome: "unknown" });
  }
  if (!answer || version !== 1) {
    throw new SdkError("claim-unknown", { step: "relay-claim", why: "answer", outcome: "unknown" });
  }
  if (code) throw new SdkError("quote-refused", { step: "relay-claim", code, status: response.status });

  // ONLY A REAL TRANSACTION HASH IS A CLAIM. A body without one leaves the outcome unknown, whether the claim never
  // left the relay or its answer was cut off.
  const txid = String(answer.txid === undefined || answer.txid === null ? "" : answer.txid).trim().toLowerCase();
  if (!TXID.test(txid)) {
    throw new SdkError("claim-unknown", { step: "relay-claim", why: "answer-txid", outcome: "unknown" });
  }
  const from = String(answer.from === undefined || answer.from === null ? "" : answer.from).trim().toLowerCase();
  if (!ADDRESS.test(from)) {
    throw new SdkError("claim-unknown", { step: "relay-claim", why: "answer-from", outcome: "unknown" });
  }
  const tipWei = String(answer.tipWei === undefined || answer.tipWei === null ? "" : answer.tipWei).trim();
  if (!DECIMAL.test(tipWei)) {
    throw new SdkError("claim-unknown", { step: "relay-claim", why: "answer-tip", outcome: "unknown" });
  }

  // THE ANSWER IS BOUND TO THE REQUEST. A relay that answers for another provider, escrow or tip has not reported
  // this sale, and the txid it names is not evidence about this claim.
  const answerProvider = String(answer.provider === undefined || answer.provider === null ? "" : answer.provider).trim().toLowerCase();
  const answerEscrow = String(answer.escrow === undefined || answer.escrow === null ? "" : answer.escrow).trim().toLowerCase();
  if (!answerProvider || !answerEscrow) {
    throw new SdkError("claim-unknown", { step: "relay-claim", why: "answer-binding", outcome: "unknown" });
  }
  if (answerProvider !== to) {
    throw new SdkError("quote-refused", { step: "relay-claim", why: "answer-provider" });
  }
  if (answerEscrow !== at) {
    throw new SdkError("quote-refused", { step: "relay-claim", why: "answer-escrow" });
  }
  if (BigInt(tipWei) !== BigInt(expectedTipWei)) {
    throw new SdkError("quote-refused", { step: "relay-claim", why: "tip", tipWei, expectedTipWei: String(expectedTipWei) });
  }
  return { txid, from, tipWei };
}
