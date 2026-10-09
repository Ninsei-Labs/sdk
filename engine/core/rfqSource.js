// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/rfqSource.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// LIVE INDICATIVE QUOTES FROM OUR PROVIDER - THROUGH THE SDK CORE.
// WHY THROUGH THE CORE, NOT OUR OWN REQUEST. The read rules (zero = "no direction", staleness by the quote own
// stamp, a self-contradicting row) used to live here and, separately, in the core, and two editions of one rule
// diverge silently. So the book now comes from the CORE: watch - quotes.watch, snapshot - quotes.snapshot, and
// the shape is translated by the bridge. NO selection rule is left here: the core decides. Core silence or
// refusal gives an EMPTY book.
// THE SNAPSHOT SHAPE, in short: no STEPS (one RANGE, one price); one quote KIND - quoteKind is gone, the only
// firm quote is the order one; rate: 0 means "direction disabled" with a why, and zero is NEVER a price; the
// network is part of the market identity and is checked against ours; seq and at travel with the quote for
// freshness; the SIZE is in units of the ASSET (the first pair element).
//
//
import { API, DEFAULT_CHAIN } from "./config.js";

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

// WHAT WE ASK THE CORE. The side and SIZE are in units of the ASSET; the network and token let the core pick ITS
// instance. No numbers appear here: the size comes from the screen, aligned to the provider grid.
let query = { size: 1, side: "buy", chain: DEFAULT_CHAIN, token: null };
export function setRfqQuery(next) {
  if (!next) return;
  if (next.side === "buy" || next.side === "sell") query.side = next.side;
  // NO QUOTE KIND IN THE REQUEST anymore: the second kind does not exist.
  if (next.size !== null && next.size !== undefined && Number(next.size) > 0) query.size = Number(next.size);
  else query.size = 1;                 // no amount entered - ask for one ASSET unit, not "nothing"
  if (typeof next.chain === "string" && next.chain) query.chain = next.chain;
  if (typeof next.token === "string" && next.token) query.token = next.token;
}

// The current request: the screen needs to know the side and size asked for, else it cannot tell "the provider is
// silent" from "the provider does not take this size".
export function rfqQuery() {
  return { ...query };
}

// THE SNAPSHOT THE SCREENS READ: { ok, error, data, at }. In data - references and best, while offers and
// refusals come from rfqOffers(). If the core was never polled or refused, there is no data, shown by ok.
// Old numbers are not pasted as "live".
const snapshot = { ok: false, error: null, data: null, at: 0, fetching: false };
export function rfqSnapshot() {
  return snapshot;
}

// The pair the user SEES: buying XMR means the pairs XMR/<asset>; selling means the reverse.
export function pairFacingUser(side = query.side, asset = "ETH") {
  return side === "sell" ? asset.toUpperCase() + "/XMR" : "XMR/" + asset.toUpperCase();
}

// PAIR SIDES ARE READ BY POSITION: the first element is the ASSET (the size is measured in it), the second is
// the CURRENCY (what is paid). Separate functions, because this is a convention.
export function pairAsset(pair) {
  return String(pair || "").split("/")[0].toUpperCase();
}
export function pairCurrency(pair) {
  return String(pair || "").split("/")[1] ? String(pair).split("/")[1].toUpperCase() : "";
}

// OFFERS AND REFUSALS - FROM THE CORE SNAPSHOT, NO SECOND SELECTION. The core already split the rows into
// offers and refusals and named the best. Here they are only transferred: no own filtering, sorting or
// thresholds. An empty snapshot is an empty book.
export function rfqOffers() {
  const data = snapshot.ok && snapshot.data ? snapshot.data : null;
  if (!data) return { offers: [], refused: [], seq: null, at: null };
  return {
    offers: data.offers || [],
    refused: data.refused || [],
    seq: data.seq === undefined ? null : data.seq,
    at: data.at === undefined ? null : data.at,
  };
}

// CHECKING THE QUOTE NETWORK AGAINST OURS. The network is part of the market identity: arbitrum and
// arbitrum-sepolia are ONE WORD FOR DIFFERENT MONEY, and a wallet does not move coins between them. The side
// holding XMR must speak Monero, the other the EVM registry language (its id). We return a verdict, not a
// throw: one quote refusal does not close the market.
export function quoteNetworksFit(quote, { monero, evm }) {
  const xmrOnAsset = quote.asset === "XMR";
  const xmrOnCurrency = quote.currency === "XMR";
  if (!xmrOnAsset && !xmrOnCurrency) return { ok: false, stated: quote.networkStated, why: "pair " + quote.pair + " has no XMR on either side" };
  const moneroNet = xmrOnAsset ? quote.assetNetwork : quote.currencyNetwork;
  const evmNet = xmrOnAsset ? quote.currencyNetwork : quote.assetNetwork;
  const moneroSide = xmrOnAsset ? "assetNetwork" : "currencyNetwork";
  const evmSide = xmrOnAsset ? "currencyNetwork" : "assetNetwork";
  if (moneroNet && moneroNet !== monero) {
    return { ok: false, stated: true, why: quote.pair + ": " + moneroSide + " is " + moneroNet + ", but this page pays XMR on " + monero };
  }
  if (evmNet && evmNet !== evm) {
    return { ok: false, stated: true, why: quote.pair + ": " + evmSide + " is " + evmNet + ", but this page settles on " + evm };
  }
  // NOT NAMED - DOES NOT MEAN "OURS". There is nothing to compare, and that is logged, but we do not close the
  // market for it: the rule catches a network NAMED WRONG, not a missing field.
  return { ok: true, stated: quote.networkStated, moneroNet: moneroNet || null, evmNet: evmNet || null, why: null };
}

// POLLING GOES THROUGH THE CORE. The bridge hands the core what it needs (network, size, direction) and returns
// the TRANSLATED snapshot. The core is loaded DYNAMICALLY: this module is also read without a browser, and then
// the book is simply not requested. A load failure IS a failure, not a reason to take the book elsewhere.
export async function refreshRfq() {
  if (snapshot.fetching) return snapshot;
  snapshot.fetching = true;
  try {
    const bridge = await import("../sdk/bridge.js");
    await bridge.sdkBook({ chain: query.chain, direction: query.side, token: query.token, size: query.size });
    const next = bridge.sdkBookSnapshot();
    snapshot.ok = next.ok;
    snapshot.error = next.error;
    snapshot.data = next.data;
    snapshot.at = next.at || Date.now();
  } catch (error) {
    // A REFUSAL IS NOT REPLACED BY OLD NUMBERS: showing a stale price as live is worse than saying there is no
    // connection. No data is left at all.
    snapshot.ok = false;
    snapshot.error = String((error && error.message) || error);
    snapshot.data = null;
    snapshot.at = Date.now();
  } finally {
    snapshot.fetching = false;
  }
  return snapshot;
}

let timer = null;

// ALWAYS POLL. The poll is not to "catch a new price": it confirms the provider is there. The core holds the
// poll for the subscription; this tick keeps the book updating with the screen. Node silence shows as a missing
// fresh stamp, not as "the price is the same".
export function startRfqPolling(chain = null, ms = API.pollMs) {
  if (typeof chain === "string" && chain) query.chain = chain;
  if (timer) return;
  refreshRfq();
  timer = setInterval(() => refreshRfq(), ms);
}
