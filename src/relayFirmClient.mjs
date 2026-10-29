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
 * `server-unavailable`; a relay refusal keeps its code in `quote-refused`. A timeout is not retried here:
 * the salt is part of the signed terms, so a retry needs the caller's decision and a fresh proof.
 */
export async function requestFirmQuote({
  relayUrl,
  partner = null,
  fetchImpl = null,
  timeoutMs = 20_000,
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
  const response = await http.tryJson("/v1/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

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
  return {
    ...verified,
    relay: response.body.relay ?? null,
    offered: response.body.offered ?? null,
    forwarded: response.body.forwarded ?? null,
    answer,
  };
}
