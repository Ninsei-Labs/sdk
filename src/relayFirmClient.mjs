// ONE HTTP HOP TO A RELAY FIRM QUOTE.
//
// The three crypto layers are already separate: features, request and answer. This module joins them to the
// wire: it builds the exact payload, sends it once, maps a refusal to a named code and verifies the answer
// before returning anything a caller could fund. The payload string is never re-serialised.
import { SdkError } from "./errors.mjs";
import { createHttp } from "./http.mjs";
import { buildFirmRequest } from "./relayRequest.mjs";
import { verifyFirmAnswer } from "./relayQuote.mjs";

const REFUSAL_CODES = new Set([
  "compliance",
  "no_liquidity",
  "size",
  "paused",
  "unavailable",
  "bad_request",
  "price_changed",
]);
const sameRelay = (a, b) => String(a === undefined || a === null ? "" : a) === String(b === undefined || b === null ? "" : b);

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
  if (!response.body || Number(response.body.version) !== 1 || !answer) {
    throw new SdkError("quote-refused", { step: "answer", why: "envelope" });
  }
  if (typeof response.body.relay !== "string" || !response.body.relay
    || !response.body.forwarded || response.body.forwarded.relayId !== response.body.relay) {
    throw new SdkError("quote-refused", { step: "answer", why: "relay" });
  }
  if (!sameRelay(answer.relayId, response.body.relay)) {
    throw new SdkError("quote-refused", { step: "answer", why: "relay" });
  }

  const verified = verifyFirmAnswer({
    answer,
    features: request.features,
    request: built,
  });
  const publishedRecipient = String(published.feeRecipient === undefined || published.feeRecipient === null ? "" : published.feeRecipient).toLowerCase();
  const quoteRecipient = String(verified.quote.feeRecipient === undefined || verified.quote.feeRecipient === null ? "" : verified.quote.feeRecipient).toLowerCase();
  if (!publishedRecipient || publishedRecipient !== quoteRecipient) {
    throw new SdkError("quote-refused", { step: "fee", why: "fee-recipient" });
  }
  if (!partner && String(published.feeBps) !== String(verified.quote.feeBps)) {
    throw new SdkError("quote-refused", { step: "fee", why: "fee-bps" });
  }
  if (published.relayId !== undefined && published.relayId !== null && String(published.relayId) !== String(response.body.relay)) {
    throw new SdkError("quote-refused", { step: "relay-info", why: "relay" });
  }
  return {
    ...verified,
    relay: response.body.relay ?? null,
    offered: response.body.offered ?? null,
    forwarded: response.body.forwarded ?? null,
    answer,
  };
}
