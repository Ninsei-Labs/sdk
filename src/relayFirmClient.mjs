// ONE HTTP HOP TO A RELAY FIRM QUOTE.
//
// The three crypto layers are already separate: features, request and answer. This module joins them to the
// wire: it builds the exact payload, sends it once, maps a refusal to a named code and verifies the answer
// before returning anything a caller could fund. The payload string is never re-serialised.
import { SdkError } from "./errors.mjs";
import { createHttp } from "./http.mjs";
import { buildFirmRequest } from "./relayRequest.mjs";
import { verifyFirmAnswer, verifyRelayForwarded } from "./relayQuote.mjs";

const REFUSAL_CODES = new Set([
  "compliance",
  "no_liquidity",
  "size",
  "paused",
  "unavailable",
  "bad_request",
  "price_changed",
]);
const wireText = (value, field) => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  throw new SdkError("bad-input", { field });
};
const sameRelay = (a, b) => (a === undefined || a === null ? "" : wireText(a, "relay")) ===
  (b === undefined || b === null ? "" : wireText(b, "relay"));

/**
 * Request a firm quote from a relay.
 *
 * `relayUrl` is the relay origin (for example `https://relay.example`), `partner` is the optional partner
 * label and every other option is passed to `buildFirmRequest`. A transport error is
 * `server-unavailable`; a relay refusal keeps its code in `quote-refused`. A timeout is retried once with the
 * same bytes (the same salt, proof and body); a network failure or a refusal is not.
 */
export async function requestFirmQuote({
  relayUrl,
  partner = null,
  fetchImpl = null,
  timeoutMs = 20_000,
  retryTimeouts = 1,
  ...request
} = {}) {
  const base = String(relayUrl === undefined || relayUrl === null ? "" : relayUrl).trim().replace(/\/+$/, "");
  if (!base) throw new SdkError("bad-input", { field: "relayUrl" });
  // A QUOTE IS SIGNED FOR A RELAY ORIGIN, NOT FOR A PLAIN-TEXT HOP. An http:// base would let any middlebox read
  // the sealed view material and change the relay's answer before the signature check.
  if (!/^https:\/\//i.test(base)) throw new SdkError("bad-input", { field: "relayUrl", why: "not-https" });

  const built = await buildFirmRequest(request);
  const body = JSON.stringify({
    version: 1,
    payload: built.payload,
    ...(partner ? { partner: String(partner) } : {}),
  });

  const http = createHttp({ apiBase: base, fetchImpl, timeoutMs });
  // THE RELAY'S PUBLISHED FEE IS PART OF THE VERDICT. `GET /v1/relay` is unauthenticated and names the operator's
  // recipient and rate; without comparing the signed quote with it, a relay can put an arbitrary fee recipient into
  // the escrow terms. Partner rates are private, so only the recipient is compared when a partner key is used.
  let published = null;
  try {
    const info = await http.tryJson("/v1/relay");
    if (!info || info.ok !== true || !info.body || typeof info.body !== "object") {
      throw new SdkError("quote-refused", { step: "relay-info", why: "unavailable" });
    }
    published = info.body;
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError("quote-refused", { step: "relay-info", why: "unavailable" });
  }
  const sendQuote = () => http.tryJson("/v1/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  let response;
  try {
    response = await sendQuote();
  } catch (error) {
    // A TIMEOUT IS RETRIED WITH THE EXACT SAME BYTES. The salt and proof are already in `body`; reusing them is
    // what makes the retry idempotent for a relay that keys by request hash. A network failure or a refusal is
    // not retried here: the caller has to decide, and a second quote could move the terms.
    if (retryTimeouts > 0 && error && error.code === "server-unavailable" && error.params && error.params.why === "timeout") {
      response = await sendQuote();
    } else throw error;
  }

  if (!response.ok) {
    const code = response.body && response.body.code ? String(response.body.code) : null;
    if (code && REFUSAL_CODES.has(code)) {
      throw new SdkError("quote-refused", { step: "relay", code, status: response.status });
    }
    throw new SdkError("server-unavailable", { step: "relay", status: response.status });
  }

  const answer = response.body && response.body.answer;
  let envelopeVersion = null;
  try { envelopeVersion = response.body ? Number(response.body.version) : null; } catch { envelopeVersion = null; }
  if (!response.body || envelopeVersion !== 1 || !answer) {
    throw new SdkError("quote-refused", { step: "answer", why: "envelope" });
  }
  if (typeof response.body.relay !== "string" || !response.body.relay
    || !response.body.forwarded || response.body.forwarded.relayId !== response.body.relay) {
    throw new SdkError("quote-refused", { step: "answer", why: "relay" });
  }
  if (!sameRelay(answer.relayId, response.body.relay)) {
    throw new SdkError("quote-refused", { step: "answer", why: "relay" });
  }

  // THE RELAY'S OWN FORWARDED FRAME IS SIGNED AND BOUND TO THE CLIENT'S EXACT PAYLOAD. Checking it here, before
  // the answer is used, closes the gap where a relay changed the forwarded payload/provider but returned a valid
  // answer for another request.
  verifyRelayForwarded({
    forwarded: response.body.forwarded,
    relayKey: published.relayKey,
    payload: built.payload,
    provider: request.features.provider,
    requestHash: answer.requestHash === undefined || answer.requestHash === null ? "" : answer.requestHash,
  });
  const verified = verifyFirmAnswer({
    answer,
    features: request.features,
    request: built,
  });
  const publishedRecipient = wireText(published.feeRecipient === undefined || published.feeRecipient === null ? "" : published.feeRecipient, "relay.feeRecipient").toLowerCase();
  const quoteRecipient = wireText(verified.quote.feeRecipient === undefined || verified.quote.feeRecipient === null ? "" : verified.quote.feeRecipient, "quote.feeRecipient").toLowerCase();
  if (!publishedRecipient || publishedRecipient !== quoteRecipient) {
    throw new SdkError("quote-refused", { step: "fee", why: "fee-recipient" });
  }
  if (!partner && wireText(published.feeBps === undefined || published.feeBps === null ? "" : published.feeBps, "relay.feeBps") !==
    wireText(verified.quote.feeBps === undefined || verified.quote.feeBps === null ? "" : verified.quote.feeBps, "quote.feeBps")) {
    throw new SdkError("quote-refused", { step: "fee", why: "fee-bps" });
  }
  // THE RELAY MUST NAME ITSELF. A missing id on GET /v1/relay is not "nothing to compare": the answer's relay
  // label would then be accepted without the one check that binds it.
  if (published.relayId === undefined || published.relayId === null
    || wireText(published.relayId, "relay.relayId") !== wireText(response.body.relay, "relay")) {
    throw new SdkError("quote-refused", { step: "relay-info", why: "relay" });
  }
  return {
    ...verified,
    // THE ORIGIN THAT ANSWERED, KEPT FOR THE LATER CLAIM. The seller has no wallet, so the claim goes back to the
    // same relay through `swaps.claimViaRelay`; the record stores this value and a different origin is refused.
    relayUrl: base,
    relay: response.body.relay ?? null,
    offered: response.body.offered ?? null,
    forwarded: response.body.forwarded ?? null,
    answer,
  };
}
