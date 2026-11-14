// THE ORDER QUOTE FOR THE EXECUTOR FALLBACK. This module no longer carries the indicative quote book: the SDK has
// no book path, and the bridge helpers it called (`sdkBook`, `sdkBookSnapshot`) are gone. What remains is the
// order quote the executor asks for when it has to fall back to the provider, and its shape check.
import { API } from "./config.js";

// QUOTE FOR A SPECIFIC ORDER (orderQuote). The request goes THROUGH OUR BACKEND, not straight to the provider
// node: a direct request would require CORS headers, i.e. a node exposed to the internet. Our backend routes
// the request and also checks the provider signature against an allowlist of keys.
export async function requestOrderQuote({ providerId, order }) {
  if (!providerId) throw new Error("no provider selected: there is no one to ask for an order quote");
  // A PATH WITHOUT A SECOND "api": apiBase() already returns "/api", and a stray prefix gave /api/api/order-quote -
  // a 404 on every request.
  const res = await fetch(apiBase() + "/order-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId, order }),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body || body.ok !== true || !body.quote) {
    const why = (body && (body.error || body.why)) || ("HTTP " + res.status);
    throw new Error("the provider gave no order quote: " + why);
  }
  // THE BACKEND CHECKS THE SIGNATURE, BUT THE RESULT COMES AS A FIELD, NOT BY SILENCE. An unverified signature
  // is not "probably fine": an order quote commits to keys. A missing flag also counts as unverified.
  if (body.signatureVerified !== true) {
    throw new Error("provider signature not confirmed: " + String(body.signatureWhy || "the backend did not verify"));
  }
  return body.quote;
}

// ORDER-QUOTE CHECK - the reason it is requested at all. The verifier code is the same as our own side: a proof
// in the order context, and the proven ed25519 point must match the one we will send to the contract.
export function checkOrderQuoteShape(quote) {
  // THE VIEW HALF IS MANDATORY: without it the Monero address cannot be built from the quote.
  const missing = ["providerId", "amount", "claimer", "edPointClaimer", "commitHalfClaimer", "viewHalfClaimer", "proof", "context", "expiresAt"]
    .filter((f) => quote[f] === undefined || quote[f] === null || quote[f] === "");
  if (missing.length) throw new Error("the order quote is missing fields: " + missing.join(", "));
  // THE ONLY FIRM KIND IS THE ORDER ONE: a broadcast quote does not fit here.
  if (quote.quoteKind !== "orderQuote") throw new Error("not an order quote, but " + String(quote.quoteKind));
  if (Number(quote.expiresAt) <= Date.now()) throw new Error("the order quote has expired");
}

let baseOverride = null;
const apiBase = () => baseOverride || API.base;
