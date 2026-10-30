// LIVE INDICATIVE QUOTES: the SDK's own quote client.
//
// WHY OUR OWN AND NOT THE ENGINE'S. The package must work without `www/js`: the consumer does not have it. The
// rules for reading the quote book are a specification (docs 41 and 54), not foreign code, so they are embodied
// here anew and pinned by a run on fixtures next to the engine implementation. For now the demo screen computes
// with its own copy: it is a test bench, and it is not scary for it to diverge from the SDK - the bench exists
// precisely to notice that.
//
// WHAT MUST NOT BE LOST HERE (all three rules cost the project mistakes):
//   1) a row has TWO rates: rateQuote - as written in the pair, rate - how much non-XMR per 1 XMR. This is not
//      duplication but different orientations; zero means "no direction", and it is NEVER divided and never
//      becomes a price;
//   2) the size is requested in the units of the pair's ASSET (the first element): for a buy that is XMR, for a
//      sell - the token; a size outside the provider's grid is not accepted, so the size is snapped to the grid
//      DOWN, not to the nearest;
//   3) a quote older than its own ttlMs is not shown, and a row that contradicts itself (the named sides disagree
//      with the pair's name) is not read at all.
import { fail } from "./errors.mjs";
import { SDK_VERSION } from "./version.mjs";
import * as engine from "./engine.mjs";
import { orderQuoteMissingFields, recoverOrderQuoteKey } from "./quoteEip712.mjs";
import { claimGasGiftWei } from "../engine/evm/claimGas.js";
import { parseXmr } from "../engine/core/xmrAmount.js";
import { takerHalves, takerHalvesV2, recoverySaltOf } from "./recovery-key.mjs";
import { acceptCounterparty, buildOwnSideFromHalves, jointAddress } from "./order.mjs";
import { requestFirmQuote } from "./relayFirmClient.mjs";
// THE CHAIN READ NEEDED TO ASK THE REGISTRY WHO OWNS THE KEY. The selector is COMPUTED from the signature, not
// remembered: a single wrong hex digit would call another function and return a zero address - and a zero
// address is exactly the answer "nobody owns this key", which the caller would take as the truth.
import { keccak256, secp256k1 } from "./primitives.mjs";

const utf8 = (value) => new TextEncoder().encode(String(value));
const bytesToHexQ = (bytes) => { let out = "0x"; for (const b of bytes) out += b.toString(16).padStart(2, "0"); return out; };
const providerOfSelector = () => bytesToHexQ(keccak256(utf8("providerOf(address)")).slice(0, 4));
const providerOfData = (key) => providerOfSelector() + "0".repeat(24) + String(key).toLowerCase().replace(/^0x/, "");
// THE FACTORY IS READ FROM THE RECORD, NOT FROM SETTINGS: `factoryOf(provider)` answers the factory the
// provider named in its record (#103). Selected by a COMPUTED selector, like providerOf.
const factoryOfSelector = () => bytesToHexQ(keccak256(utf8("factoryOf(address)")).slice(0, 4));
const factoryOfData = (provider) => factoryOfSelector() + "0".repeat(24) + String(provider).toLowerCase().replace(/^0x/, "");
const hexToBytesQ = (hex) => {
  const h = String(hex == null ? "" : hex).replace(/^0x/, "");
  if (h.length % 2) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) { const b = parseInt(h.slice(i * 2, i * 2 + 2), 16); if (Number.isNaN(b)) return null; out[i] = b; }
  return out;
};
const ZERO_ADDRESS = "0x" + "00".repeat(20);
const sameText = (a, b) => String(a === undefined || a === null ? "" : a).toLowerCase()
  === String(b === undefined || b === null ? "" : b).toLowerCase();
const addressFromWord = (raw) => {
  const h = String(raw == null ? "" : raw).replace(/^0x/, "");
  return h.length >= 40 ? "0x" + h.slice(-40).toLowerCase() : null;
};

const num = (v) => (v === undefined || v === null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const pairAsset = (pair) => String(pair || "").split("/")[0].toUpperCase();
const pairCurrency = (pair) => String(pair || "").split("/")[1] ? String(pair).split("/")[1].toUpperCase() : "";

/** The pair the user sees: buying XMR - looking at XMR/<token>, selling - at the reverse. */
export const pairFacingUser = (direction, token) =>
  (direction === "sell" ? String(token).toUpperCase() + "/XMR" : "XMR/" + String(token).toUpperCase());

/** Reading one quote row. The shape comes from the specification; networks are NOT filled in. */
export function readQuote(pair, raw, owner = {}, data = {}) {
  const q = raw && typeof raw === "object" ? raw : {};
  const text = String(pair || q.pair || "").trim().toUpperCase();
  if (!text.includes("/")) return null;
  const statedAsset = q.asset ? String(q.asset).toUpperCase() : null;
  const statedCurrency = q.currency ? String(q.currency).toUpperCase() : null;
  const asset = pairAsset(text);
  const currency = pairCurrency(text);
  const givenRateQuote = num(q.rateQuote);
  const givenRate = num(q.rate);
  const rateQuote = givenRateQuote !== null ? givenRateQuote : givenRate;
  let rate = null;
  if (givenRateQuote !== null) rate = givenRate;
  else if (rateQuote !== null) rate = currency === "XMR" ? (rateQuote > 0 ? 1 / rateQuote : null) : rateQuote;
  const contradicts = (statedAsset && statedAsset !== asset) || (statedCurrency && statedCurrency !== currency);
  const at = num(q.at);
  return {
    providerId: String(owner.providerId || q.providerId || "").trim(),
    displayName: owner.displayName || q.displayName || null,
    // THE PROVIDER'S MATURITY LEVEL RIDES WITH THE OFFER: a person chooses not only by price but also by how long
    // to wait. No field - no value either, not an invented default.
    finality: owner.finality || q.finality || null,
    pair: text,
    asset: statedAsset || asset,
    currency: statedCurrency || currency,
    assetNetwork: q.assetNetwork ? String(q.assetNetwork) : null,
    currencyNetwork: q.currencyNetwork ? String(q.currencyNetwork) : null,
    rateQuote,
    rate,
    // THE CLAIM TIP IS IN THE MAKER'S NATIVE TOKEN (wei). A sale is ranked by what the seller receives AFTER it;
    // the value is kept as a string, because a wei amount does not fit a float reliably.
    claimTip: (() => {
      if (q.claimTip === undefined || q.claimTip === null || q.claimTip === "") return "0";
      try { const n = BigInt(q.claimTip); return n < 0n ? "0" : n.toString(); }
      catch { return "0"; }
    })(),
    min: num(q.min),
    max: num(q.max),
    step: num(q.step),
    ttlMs: num(q.ttlMs) && num(q.ttlMs) > 0 ? num(q.ttlMs) : null,
    at,
    why: q.why ? String(q.why) : null,
    disabled: q.disabled === true || (givenRate !== null && !(givenRate > 0)),
    // NETWORKS NOT NAMED / FILLED IN BY THE RECEIVER - this is a FACT ABOUT THE QUOTE, and it is visible apart
    // from "named and matched": the screen must say "nothing to check against" rather than attribute our network
    // to the quote.
    networksUnnamed: q.networksUnnamed === true,
    networksDerived: q.networksDerived === true,
    seq: num(q.seq) !== null ? num(q.seq) : (num(owner.seq) !== null ? num(owner.seq) : num(data.seq)),
    signature: q.signature || owner.signature || null,
    keyId: q.keyId || null,
    networkStated: Boolean(q.assetNetwork || q.currencyNetwork),
    contradicts,
    ageMs: at === null ? null : Math.max(0, Date.now() - at),
  };
}

/**
 * THE BEST OFFER IS THE ONE THAT PAYS THE MOST, NOT THE ONE WITH THE HIGHEST RATE. On a sale the maker may move
 * its margin into `claimTip`: the escrow pays that tip out of the seller's payout, so a higher rate with a larger
 * tip can leave the seller with less. With no amount there is nothing to compare beyond the rate, and a buy has
 * no tip. Native-token wei are converted at 18 decimals: a sale settles in the chain's native coin.
 */
export function rankOffers(offers = [], { direction = "buy", amount = null } = {}) {
  const list = Array.isArray(offers) ? offers.filter((offer) => offer && Number(offer.rate) > 0) : [];
  const amountXmr = Number(amount);
  const score = (offer) => {
    const rate = Number(offer.rate);
    if (direction !== "sell" || !(amountXmr > 0)) return rate;
    let tip = 0;
    try { tip = Number(BigInt(offer.claimTip || "0")) / 1e18; } catch { tip = 0; }
    return amountXmr * rate - tip;
  };
  const ranked = list.map((offer) => ({ offer, net: score(offer) }))
    .sort((a, b) => (b.net - a.net) || (Number(b.offer.rate) - Number(a.offer.rate)));
  return { best: ranked.length ? ranked[0].offer : null, net: ranked.length ? ranked[0].net : null, ranked };
}

/**
 * Parsing the book in one place. The envelope is accepted in three forms (a map by pairs, a list of rows, a list
 * of providers) and is brought to a single list: the screen must not know which form the answer came in.
 * Refusals are named separately from offers: "no direction" and "the quote is stale" are not emptiness.
 */
export function readBook(data, now = Date.now()) {
  const quotes = data && data.quotes;
  const rows = [];
  const add = (pair, raw, owner) => { const row = readQuote(pair, raw, owner, data || {}); if (row) rows.push(row); };
  if (Array.isArray(quotes)) {
    for (const row of quotes) {
      if (!row || typeof row !== "object") continue;
      const nested = row.quotes && !Array.isArray(row.quotes) && typeof row.quotes === "object" ? row.quotes : null;
      if (nested) for (const [pair, q] of Object.entries(nested)) add(pair, q, row);
      else add(row.pair, row, row);
    }
  } else if (quotes && typeof quotes === "object") {
    for (const [pair, q] of Object.entries(quotes)) add(pair, q, q && typeof q === "object" ? q : {});
  }
  // ONE QUOTE PER PAIR PER PROVIDER: if several arrived, we keep the fresh one rather than choosing arbitrarily
  // (these are two different offers under one name).
  const byKey = new Map();
  for (const row of rows) {
    const key = (row.providerId || "?") + "|" + row.pair;
    const prev = byKey.get(key);
    if (!prev || Number(row.at) > Number(prev.at)) byKey.set(key, row);
  }
  const offers = [];
  const refused = [];
  for (const row of byKey.values()) {
    if (row.contradicts) { refused.push({ ...row, code: "malformed" }); continue; }
    if (row.rateQuote === null && row.rate === null) { refused.push({ ...row, code: "malformed" }); continue; }
    if (row.disabled || !(row.rate > 0)) { refused.push({ ...row, code: "disabled" }); continue; }
    if (row.ttlMs && row.ageMs !== null && row.ageMs > row.ttlMs) { refused.push({ ...row, code: "stale" }); continue; }
    offers.push(row);
  }
  const best = offers.slice().sort((a, b) => b.rate - a.rate)[0] || null;
  return { offers, refused, best, at: now };
}

/**
 * The size is snapped to the provider's grid DOWN. A size refusal is not aligned: a size outside the range is a
 * provider's refusal and must reach the interface as a code, not turn into permission.
 */
export function snapToGrid(size, { min = null, max = null, step = null } = {}) {
  const s = Number(size);
  if (!Number.isFinite(s) || s <= 0) return { size: null, asked: size, snapped: false, code: "bad-size" };
  const st = Number(step);
  const lo = Number.isFinite(Number(min)) && min !== null && min !== "" ? Number(min) : 0;
  const hi = Number.isFinite(Number(max)) && max !== null && max !== "" ? Number(max) : null;
  if (s < lo) return { size: s, asked: s, snapped: false, code: "below-min" };
  if (hi !== null && s > hi) return { size: s, asked: s, snapped: false, code: "above-max" };
  if (!Number.isFinite(st) || st <= 0) return { size: s, asked: s, snapped: false, code: null };
  const steps = Math.floor((s - lo) / st + 1e-9);
  let snapped = Number((lo + steps * st).toFixed(12));
  if (snapped < lo) snapped = lo;
  return { size: snapped, asked: s, snapped: Math.abs(snapped - s) > 1e-12, code: null };
}

/**
 * What the user will receive and what they pay for it, by the best offer and its rate.
 * buy: they pay with the token and receive XMR, so the size (the ASSET of the pair XMR/<token>) is XMR.
 * sell: they give XMR and receive the token, the ASSET of the pair <token>/XMR is the token itself.
 */
export function derivedFor(offer, direction, amount, now = Date.now()) {
  const rate = offer && Number.isFinite(Number(offer.rate)) && Number(offer.rate) > 0 ? Number(offer.rate) : null;
  const size = direction === "sell" ? (rate !== null && amount > 0 ? amount * rate : null)
                                    : (rate !== null && amount > 0 ? amount / rate : null);
  if (size === null) return { rate, size: null, unit: null, code: "no-offer", xmr: null };
  const settled = snapToGrid(size, offer || {});
  return {
    rate,
    size: settled.size,
    unit: direction === "sell" ? String(offer.currency || "").toUpperCase() || null : "XMR",
    snapped: settled.snapped,
    code: settled.code,
    // HOW MUCH XMR FOR THE REQUESTED SIZE. For a buy this is the size, for a sell - the amount the person gives.
    xmr: direction === "sell" ? amount : (Number.isFinite(Number(settled.size)) ? Number(settled.size) : null),
  };
}

// THE ROW FIELDS THAT GO OUT. This is a translation of the SHAPE, not a recomputation: the values are taken from
// the read row and are not changed. The fields are listed explicitly (and not `...row`) so that internal parsing
// markers do not leak out. Selection and priority are done by readBook above: a row gets here only if it has
// already been recognised as an offer.
const compactOffer = (o) => ({
  providerId: o.providerId, displayName: o.displayName, pair: o.pair, rate: o.rate, rateQuote: o.rateQuote,
  min: o.min, max: o.max, step: o.step, ttlMs: o.ttlMs, at: o.at, seq: o.seq,
  // THE MATURITY LEVEL IS PART OF THE CHOICE: one provider gives a better price but only on finalized, another is
  // pricier but faster. No field - null, not an invented default.
  finality: o.finality || null,
  // THE PAIR'S SIDES AND BOTH NETWORKS: the network is part of the market's identity, and the display must
  // distinguish arbitrum from arbitrum-sepolia. `networks` is kept as the assembled view of the same values.
  asset: o.asset, currency: o.currency,
  assetNetwork: o.assetNetwork, currencyNetwork: o.currencyNetwork, networkStated: o.networkStated,
  networksDerived: o.networksDerived === true, networksUnnamed: o.networksUnnamed === true,
  // THE REASON (in the provider's words), THE PACKAGE'S SIGNATURE AND KEY, THE AGE BY ITS OWN MARK.
  claimTip: o.claimTip, why: o.why, signature: o.signature, keyId: o.keyId, ageMs: o.ageMs,
  networks: { asset: o.assetNetwork, currency: o.currencyNetwork, stated: o.networkStated },
});

// A REFUSAL IS THE SAME ROW PLUS A REASON CODE. The fields are not trimmed: the interface needs the range and
// the price of the failed row to tell the person WHY there is no offer (and not just "none").
const compactRefusal = (r) => ({ ...compactOffer(r), code: r.code, why: r.why });

/**
 * A CLAIM TIP IS SIZED BY THE CLAIM, NOT BY THE MAKER'S MOOD. The node's own estimate uses the chain's current
 * base fee and the same formula; a quote may carry up to twice that estimate (gas moves between the sizing and
 * the check). Zero is the buy side and is always allowed. An unmeasured base fee is a refusal, not a free pass.
 */
export function claimTipVerdict({ claimTipWei = 0, baseFeeWei = null, priorityFeeWei = 0, factor = 2 } = {}) {
  let tip = 0n;
  try { tip = BigInt(claimTipWei === undefined || claimTipWei === null || claimTipWei === "" ? 0 : claimTipWei); }
  catch { return { ok: false, code: "quote-tip-unreadable" }; }
  if (tip < 0n) return { ok: false, code: "quote-tip-unreadable" };
  if (tip === 0n) return { ok: true, tipWei: "0", ceilingWei: null, estimateWei: null };
  if (baseFeeWei === null || baseFeeWei === undefined || baseFeeWei === "") {
    return { ok: false, code: "quote-tip-unchecked", tipWei: tip.toString() };
  }
  const estimate = claimGasGiftWei({ baseFeeWei, priorityFeeWei });
  if (estimate === null) return { ok: false, code: "quote-tip-unchecked", tipWei: tip.toString() };
  const f = BigInt(factor);
  const ceiling = estimate * f;
  if (tip > ceiling) {
    return { ok: false, code: "quote-tip-too-large", tipWei: tip.toString(), estimateWei: estimate.toString(), ceilingWei: ceiling.toString() };
  }
  return { ok: true, tipWei: tip.toString(), estimateWei: estimate.toString(), ceilingWei: ceiling.toString() };
}

export function createQuotes({ config, http, now = () => Date.now(), evmCall = null, evmCode = null, evmBlock = null,
  providerAllowed = null, knownFactoryCodes = null, knownImplementationCodes = null, denylist = null }) {
  // THE INTERFACE'S FACTORY POLICY (#103): the code hashes of factories it is willing to trade through
  // (extcodehash semantics = keccak256 of the runtime code). An EMPTY list is "no policy" (like
  // allowedProviders); a NON-EMPTY one refuses any factory whose code is not on it. Lower-cased once.
  const factoryPolicy = Array.isArray(knownFactoryCodes) && knownFactoryCodes.length
    ? knownFactoryCodes.map((h) => String(h).toLowerCase()).filter(Boolean)
    : null;
  // THE INTERFACE'S ESCROW-IMPLEMENTATION POLICY (#114): the code hashes of the escrow IMPLEMENTATION the
  // factory must lead to - the code every order's clone delegatecalls. Same rule as the factory policy: an
  // EMPTY list is "no policy" (then the pair is still read and the implementation's code must be non-empty).
  const implementationPolicy = Array.isArray(knownImplementationCodes) && knownImplementationCodes.length
    ? knownImplementationCodes.map((h) => String(h).toLowerCase()).filter(Boolean)
    : null;
  const listeners = new Set();
  let timer = null;
  let size = 1;              // the request size in units of the pair's ASSET; we start from one, as the engine does
  let state = null;
  let request = { direction: "buy", token: null, amount: null };
  let inFlight = false;

  const emit = () => { for (const handler of listeners) handler(state); };

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // THE REQUEST SIZE. Usually it is derived from the person's amount (amount) and refined on the next tick.
      // But the caller can name it HIMSELF (size) - then it is taken AS IS rather than derived anew: it is the
      // same size the interface has already aligned to the provider's grid. There is no second size rule here.
      const explicit = Number.isFinite(Number(request.size)) && Number(request.size) > 0;
      const asked = explicit ? Number(request.size) : size;
      const data = await http.json("/rate?amount=" + encodeURIComponent(asked) + "&side=" + encodeURIComponent(request.direction));
      const book = readBook(data, now());
      const amount = Number.isFinite(Number(request.amount)) ? Number(request.amount) : null;
      // A SALE IS RANKED BY THE PAYOUT AFTER THE TIP; a buy has no tip. Without an amount the rate is the only
      // comparable number, and the service's own best remains the fallback.
      const ranked = rankOffers(book.offers, { direction: request.direction, amount });
      const offer = ranked.best || book.best;
      // The size derived from the person's amount becomes the size of the NEXT request: the price does not depend
      // on volume, and the volume is needed by the provider to say whether it takes such a size. With a named size
      // there is nothing to derive - it stays what it was asked as.
      const derived = offer && amount !== null && !explicit ? derivedFor(offer, request.direction, amount, now()) : null;
      if (derived && derived.size !== null) size = derived.size;
      // THE UNIT with a named size: a buy is measured in XMR (the ASSET of the pair XMR/<token>), a sell - in the token.
      const unitFromOffer = offer ? (String(offer.currency || "").toUpperCase() || null) : null;
      const settled = explicit ? (offer ? snapToGrid(asked, offer) : null) : null;
      state = {
        direction: request.direction,
        token: request.token,
        amount,
        size: explicit ? asked : size,
        unit: explicit ? (request.direction === "sell" ? unitFromOffer : "XMR") : (derived ? derived.unit : null),
        rate: explicit ? (offer ? Number(offer.rate) : null) : (derived ? derived.rate : null),
        xmr: derived ? derived.xmr : null,
        at: now(),
        providerId: offer ? offer.providerId : null,
        sizeOk: explicit ? Boolean(settled && settled.code === null) : Boolean(derived && derived.code === null),
        sizeCode: explicit ? (settled ? settled.code : "no-offer") : (derived ? derived.code : "no-offer"),
        seq: book.offers.length ? (book.offers.find((o) => o.seq !== null) || {}).seq ?? null : null,
        // THE BEST, AS THE SERVICE NAMED IT (for the requested volume and side). The core does NOT recompute it:
        // these are response data the interface needs to confirm its own "best" mark by pair and provider.
        best: data && data.best && typeof data.best === "object"
          ? { providerId: String(data.best.providerId || ""), pair: String(data.best.pair || "") } : null,
        offers: book.offers.map(compactOffer),
        refused: book.refused.map(compactRefusal),
        references: Array.isArray(data && data.references) ? data.references.map((r) => ({ source: r.source, value: num(r.value), at: num(r.at) })) : [],
        ok: book.offers.length > 0,
      };
      emit();
    } catch (error) {
      // A REFUSAL IS NOT REPLACED BY PAST NUMBERS: showing a stale price as live is worse than saying the connection
      // is gone. The data is kept, but ok is cleared, and the interface sees it.
      state = { ...(state || { direction: request.direction, token: request.token, amount: null, size, unit: null, rate: null, xmr: null,
        at: now(), providerId: null, sizeOk: false, sizeCode: null, seq: null, best: null, offers: [], refused: [], references: [] }),
        at: now(), ok: false, error: { code: error && error.code === "server-unavailable" ? "quote-unavailable" : "unknown" } };
      emit();
    } finally {
      inFlight = false;
    }
  };

  const restart = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (listeners.size > 0) {
      void tick();
      timer = setInterval(() => { void tick(); }, config.limits.quotePollMs);
    }
  };

  return {
    watch(next, onSnapshot) {
      if (typeof onSnapshot !== "function") fail("bad-input", { field: "onSnapshot" });
      const direction = next && next.direction === "sell" ? "sell" : "buy";
      const token = next && typeof next.token === "string" && next.token ? next.token.toLowerCase() : config.settlement.chain.nativeSymbol.toLowerCase();
      request = {
        direction,
        token,
        amount: next && next.amount !== undefined ? next.amount : null,
        // A NAMED SIZE (in units of `unit`): an interface that has already aligned the volume to the provider's
        // grid hands it here, and the core asks for EXACTLY it rather than deriving it from the amount anew.
        size: next && Number.isFinite(Number(next.size)) && Number(next.size) > 0 ? Number(next.size) : null,
      };
      size = 1;
      state = null;
      listeners.add(onSnapshot);
      restart();
      return () => {
        listeners.delete(onSnapshot);
        if (listeners.size === 0) {
          if (timer) clearInterval(timer);
          timer = null;
        }
      };
    },
    // WHAT THE SDK KNOWS RIGHT NOW: a snapshot without waiting. Needed by an interface that subscribed later than
    // the first poll happened.
    snapshot: () => state,
    // A FIRM QUOTE FOR AN ORDER. It carries a commitment under keys, so THE PROVIDER'S SIGNATURE IS CONFIRMED
    // HERE, BY RECOVERING THE ADDRESS FROM THE EIP-712 SIGNATURE - not taken on trust from a flag the backend
    // reports. A quote that cannot be verified is not "probably fine": a missing field, a missing signature or
    // an unusable domain is REFUSED, never accepted (the rule the old flag carried is kept). The digest is
    // built from the quote's own fields, so nothing signed can be swapped afterwards; the named quoteKey is
    // matched against the recovered address. THEN THE CHAIN IS ASKED WHO OWNS THE KEY (providerOf): the
    // signature alone certifies itself, because a key can sign anything and call itself any provider. The
    // registry is read from the quote/order conditions - never from SDK settings: any registry can be deployed
    // by anyone, and the order carries which one it is (the field is signed and bound into the terms). Finally
    // the interface's allow-list, when it supplied one, is applied as policy (who is admitted at all).
    //
    // The path and the body are the same as the engine's (`requestOrderQuote` in www/js/core/rfqSource.js): POST to
    // the named path, body { providerId, order }. The path is named by name, so it is overridable by options.
    // A REVERSE-MODE TICKET. The maker sells XMR; the node answers with a signed order quote that carries the claim
    // tip. The tip is checked HERE, on the ticket's own signed figure, with the same formula the node used: base fee
    // plus the priority part of the gas price. A buy quote has no tip; a sale is the only route where one exists.
    async sale(request) {
      if (!request || typeof request !== "object") fail("bad-input", { field: "request" });
      // THE NODE GATES THE THREE BROWSER BODY ROUTES ON THE CLIENT'S SDK LINE. The value is the package's own
      // baked-in version, not a caller field: a caller cannot claim a line it was not built from.
      // THE ENVELOPE IS THE REQUEST. The node accepts both `{ request: {...} }` and a bare body; every check below
      // must read the same object the node priced, not the outer envelope that carries only `sdkVersion`.
      const saleRequest = request.request && typeof request.request === "object" ? request.request : request;
      const payload = { ...(request.request && typeof request.request === "object" ? request : { request }), sdkVersion: SDK_VERSION };
      let res = null;
      try {
        res = await http.tryJson(config.route("orderSell"), {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        });
      } catch (error) {
        if (error && error.code === "bad-input") throw error;
        fail("server-unavailable", { step: "order-sell" });
      }
      if (!res || res.ok !== true || !res.body || res.body.ok !== true) fail("quote-refused", { step: "order-sell" });
      const ticket = res.body;
      const quote = (ticket.handoff && ticket.handoff.quote) || ticket.quote || null;
      if (!quote || typeof quote !== "object") fail("quote-field-unbound", { step: "order-sell", field: "quote" });
      // THE SALE TICKET IS A SIGNED QUOTE, AND IT GETS THE SAME GATES AS `firm`: every field of the signed set,
      // its expiry, the EIP-712 signature and the named key, the registry's provider mapping, the interface's
      // allow-list, and the factory/implementation policy. The one difference is the binding below: a sale has no
      // caller-supplied order terms, so its context is checked against `ticket.order` when the node returns it.
      // A MISSING FIELD OF THE SIGNED SET IS NOT "PROBABLY ZERO": the digest cannot be built, so the quote is
      // not verifiable and is refused (its own code, so the interface can say which field is unbound).
      const missingFields = orderQuoteMissingFields(quote);
      if (missingFields.length) fail("quote-field-unbound", { step: "signature", missing: missingFields });
      // THE QUOTE'S OWN EXPIRY, checked against the clock the core already has. It is bound in the signature too,
      // but a stale quote is refused by its own code rather than looking like a signature failure.
      const validUntil = Number(quote.validUntil);
      // THE SCALE IS SECONDS: the same as the order's deadlines and block.timestamp. The core's clock is in
      // milliseconds (Date.now), so exactly ONE boundary is converted - "now", not the quote value itself: one
      // unit for the value, one conversion at the input.
      const nowSec = Math.floor(now() / 1000);
      if (Number.isFinite(validUntil) && validUntil > 0 && validUntil <= nowSec) {
        fail("quote-expired", { step: "signature", validUntil });
      }
      // RECOVER, THEN MATCH THE NAMED KEY. A signature that does not recover is one refusal; a valid signature
      // that recovers to a DIFFERENT address is another (the quote names a key that did not sign it).
      const recoveredKey = recoverOrderQuoteKey(quote);
      if (recoveredKey === null) fail("quote-signature-invalid", { step: "signature" });
      const declaredKey = String(quote.quoteKey).toLowerCase();
      if (recoveredKey !== declaredKey) fail("quote-key-mismatch", { step: "signature", got: recoveredKey, want: declaredKey });
      // WHO OWNS THE KEY - ASKED OF THE REGISTRY NAMED BY THE QUOTE. Both fields are part of the signed set, so
      // they cannot be swapped after signing; this is what turns "a key signed it" into "this provider's key
      // signed it". No chain-read seam - refuse rather than take the signature on trust.
      const registry = String(quote.registry || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(registry) || registry === ZERO_ADDRESS) {
        fail("quote-field-unbound", { step: "registry", field: "registry" });
      }
      const declaredProvider = String(quote.provider || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(declaredProvider) || declaredProvider === ZERO_ADDRESS) {
        fail("quote-field-unbound", { step: "registry", field: "provider" });
      }
      if (typeof evmCall !== "function") fail("quote-registry-unchecked", { step: "registry", why: "no-chain-read" });
      let mappedProvider = null;
      try {
        mappedProvider = addressFromWord(await evmCall({ to: registry, data: providerOfData(declaredKey) }));
      } catch {
        fail("quote-registry-unchecked", { step: "registry", why: "read-failed", registry });
      }
      if (mappedProvider === null || mappedProvider === ZERO_ADDRESS) {
        fail("quote-key-unknown", { step: "registry", registry, quoteKey: declaredKey });
      }
      if (mappedProvider !== declaredProvider) {
        fail("quote-provider-mismatch", { step: "registry", got: mappedProvider, want: declaredProvider });
      }
      // THE INTERFACE'S OWN ADMISSION LIST - POLICY, NOT PROOF. The chain says whose key it is; whether this
      // interface trades with that provider at all is the interface's decision, and it rides as a hook.
      if (typeof providerAllowed === "function" && providerAllowed(declaredProvider) !== true) {
        fail("quote-provider-not-allowed", { step: "policy", provider: declaredProvider });
      }
      // THE FACTORY: NAMED BY THE PROVIDER'S RECORD, CHECKED BY ITS CODE (#103). The factory will verify the
      // quote in EVM (it is the EIP-712 verifyingContract), so it must be the one the record names AND its
      // code must be a build this interface knows. The record lookup always runs; the code check runs when a
      // policy list was supplied (nothing to pin against otherwise).
      const declaredFactory = String(quote.factory || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(declaredFactory) || declaredFactory === ZERO_ADDRESS) {
        fail("quote-field-unbound", { step: "factory", field: "factory" });
      }
      let recordedFactory = null;
      try {
        recordedFactory = addressFromWord(await evmCall({ to: registry, data: factoryOfData(declaredProvider) }));
      } catch {
        fail("quote-factory-unchecked", { step: "factory", why: "read-failed", registry });
      }
      if (recordedFactory === null || recordedFactory === ZERO_ADDRESS) {
        fail("quote-factory-unknown", { step: "factory", registry, provider: declaredProvider });
      }
      if (recordedFactory !== declaredFactory) {
        fail("quote-factory-mismatch", { step: "factory", got: declaredFactory, want: recordedFactory });
      }
      if (factoryPolicy) {
        if (typeof evmCode !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-code-read" });
        let codeHex = null;
        try { codeHex = await evmCode(declaredFactory); } catch { fail("quote-factory-unchecked", { step: "factory", why: "code-read-failed", factory: declaredFactory }); }
        const codeBytes = hexToBytesQ(codeHex);
        // EXTCODEHASH SEMANTICS: keccak256 of the runtime code. An address with no code (empty/0x) hashes to
        // the keccak of empty, which is not on any build list - refused like any unknown build.
        const codeHash = bytesToHexQ(keccak256(codeBytes || new Uint8Array(0)));
        if (!factoryPolicy.includes(codeHash)) {
          fail("quote-factory-code-unknown", { step: "factory", factory: declaredFactory, codeHash });
        }
      }
      // THE IMPLEMENTATION THE CLONES WILL EXECUTE (#114). A pinned factory CODE is not enough on its own: the
      // implementation ADDRESS lives in the factory's STORAGE, so the client re-reads the pair the factory itself
      // checks (implementation() / implementationCodeHash()) and the CODE at that address, then applies the same
      // verdict (verifyFactoryImplementationOnChain). A delegatecall to an address WITHOUT code SUCCEEDS, so a
      // clone without an implementation would take the ETH and its markReady/claim/refund would appear to go
      // through while doing nothing - that is exactly the case this refuses. The live code is re-hashed here, so
      // the verdict does not trust the factory's own answer alone.
      if (implementationPolicy) {
        if (typeof evmCall !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-chain-read" });
        if (typeof evmCode !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-code-read" });
        const verdict = await engine.evm.verifyFactoryImplementationOnChain({
          factory: declaredFactory,
          read: evmCall,
          code: (address) => evmCode(address),
          policy: implementationPolicy,
          hashCode: (codeHex) => bytesToHexQ(keccak256(hexToBytesQ(codeHex) || new Uint8Array(0))),
        });
        if (!verdict.ok) {
          const unknown = verdict.why === "implementation-code-unknown" ||
            verdict.why === "implementation-code-mismatch" || verdict.why === "implementation-has-no-code";
          fail(unknown ? "quote-factory-code-unknown" : "quote-factory-unchecked",
            { step: "factory", why: verdict.why, factory: declaredFactory, implementation: verdict.implementation || null });
        }
      }
      // THE PERSON SELLING IS THE CLAIMER. The interface's denylist is applied to that address, not to a
      // caller-chosen value: a ticket that names a denied claimer must not reach the funding step.
      const saleClaimer = String((saleRequest && saleRequest.claimer) || quote.claimer || "").toLowerCase();
      if (saleClaimer && denylist && denylist.has(saleClaimer)) fail("address-denied", { step: "order-sell" });
      if (saleRequest && saleRequest.claimer && quote.claimer && String(saleRequest.claimer).toLowerCase() !== String(quote.claimer).toLowerCase()) {
        fail("quote-refused", { step: "order-sell", why: "claimer-not-bound" });
      }
      // THE XMR THE CALLER ASKED FOR IS THE XMR THE QUOTE SIGNED. A ticket is paid against the signed `xmrAmount`;
      // accepting a different requested amount shows one figure and settles another.
      const requestedXmr = saleRequest && (saleRequest.xmr !== undefined ? saleRequest.xmr
        : (saleRequest.xmrAmount !== undefined ? saleRequest.xmrAmount : null));
      if (requestedXmr !== null && requestedXmr !== undefined) {
        let wanted = null;
        try { wanted = BigInt(String(requestedXmr)); } catch { wanted = null; }
        // A whole-XMR request (the public `xmr` field) is converted with the package's own parser; digits are
        // already atomic. A value that cannot be read is a refusal, not a skipped check.
        if (wanted === null || wanted < 10n ** 12n) {
          try { wanted = parseXmr(String(requestedXmr)); } catch { wanted = null; }
        }
        let signedAtomic = null;
        try { signedAtomic = quote.xmrAmount === undefined || quote.xmrAmount === null || quote.xmrAmount === ""
          ? null : BigInt(String(quote.xmrAmount)); } catch { signedAtomic = null; }
        if (signedAtomic === null || wanted === null || wanted !== signedAtomic) {
          fail("quote-refused", { step: "order-sell", why: "xmr-amount" });
        }
      }
      // THE CONTEXT WHEN THE TICKET CARRIES ITS ORDER. The signed quote binds the order terms; when the node
      // returns the order it priced, recompute the context with our own engine and refuse a mismatch.
      if (ticket.order && typeof ticket.order === "object") {
        // THE RETURNED ORDER MUST BE THE SIGNED ONE FIELD BY FIELD. `quote.context` is a derived label, not a
        // signed field; comparing only it lets a node return another amount with a matching relabelled context.
        const sameValue = (a, b) => String(a === undefined || a === null ? "" : a).replace(/^0x/i, "").toLowerCase()
          === String(b === undefined || b === null ? "" : b).replace(/^0x/i, "").toLowerCase();
        for (const name of ["locker", "claimer", "amount", "readyBy", "t1", "salt"]) {
          if (!sameValue(ticket.order[name], quote[name])) {
            fail("quote-refused", { step: "order-sell", why: "other-terms", field: name });
          }
        }
        // The context remains a useful cross-check when both sides carry it.
        if (quote.context) {
          let expectedSaleContext = null;
          try { expectedSaleContext = engine.orderContext.orderContextString(ticket.order); } catch { expectedSaleContext = null; }
          if (expectedSaleContext !== null && String(quote.context) !== expectedSaleContext) {
            fail("quote-refused", { step: "order-sell", why: "other-terms", field: "context" });
          }
        }
      }
      // THE TICKET'S TIP MUST BE THE SIGNED ONE. The node returns both the ticket's `claimTip` object and the quote it
      // signed; a difference means the figure shown to the person is not the figure the escrow will pay.
      const shown = ticket.claimTip && ticket.claimTip.wei !== undefined && ticket.claimTip.wei !== null
        ? String(ticket.claimTip.wei) : null;
      if (shown === null) fail("quote-field-unbound", { step: "claimTip", field: "claimTip" });
      if (ticket.claimTip.signed !== true) fail("quote-field-unbound", { step: "claimTip", field: "signed" });
      let signedTip = null;
      try { signedTip = quote.claimTip === undefined || quote.claimTip === null || quote.claimTip === "" ? "0" : BigInt(quote.claimTip).toString(); }
      catch { fail("quote-field-unbound", { step: "claimTip", field: "claimTip" }); }
      let shownBig = null;
      try { shownBig = BigInt(shown); } catch { fail("quote-tip-unreadable", { step: "claimTip" }); }
      if (signedTip === null || shownBig < 0n || BigInt(signedTip) !== shownBig) {
        fail("quote-refused", { step: "claimTip", why: "not-the-signed-tip" });
      }
      if (shownBig > 0n) {
        if (typeof evmBlock !== "function") fail("quote-tip-unchecked", { step: "claimTip", why: "no-block-read" });
        let block = null;
        try { block = await evmBlock("latest"); } catch { fail("quote-tip-unchecked", { step: "claimTip", why: "block-read-failed" }); }
        const baseFeeWei = block && (block.baseFeePerGas !== undefined ? block.baseFeePerGas : block.baseFeeWei);
        // THE NODE SIZES THE TIP FROM THE GAS PRICE, PRIORITY INCLUDED. The SDK used to pass only the base fee, so an
        // honest L1 tip (or a base fee that dropped between sizing and checking) was refused.
        let priorityFeeWei = block && block.priorityFeePerGas !== undefined ? block.priorityFeePerGas : null;
        if (priorityFeeWei === null && block && block.gasPrice !== undefined && baseFeeWei !== undefined && baseFeeWei !== null) {
          try {
            const gas = BigInt(block.gasPrice); const base = BigInt(baseFeeWei);
            priorityFeeWei = gas > base ? gas - base : 0n;
          } catch { priorityFeeWei = 0n; }
        }
        const verdict = claimTipVerdict({ claimTipWei: shownBig, baseFeeWei, priorityFeeWei: priorityFeeWei === null ? 0n : priorityFeeWei });
        if (!verdict.ok) fail(verdict.code, { step: "claimTip", ...verdict });
      }
      return ticket;
    },
    async firm(request) {
      if (!request || typeof request !== "object") fail("bad-input", { field: "request" });
      if (typeof request.providerId !== "string" || !request.providerId) fail("bad-input", { field: "providerId" });
      if (!request.order || typeof request.order !== "object") fail("bad-input", { field: "order" });
      // THE INTERFACE'S OWN ADDRESS DENYLIST (issue #16): POLICY, not proof - the interface refuses to ask for a
      // quote for an address on its own list, and does it BEFORE any request is made. `order.locker` is the
      // address the funds come from on a purchase (the claimer there is the node's own address, so it is
      // deliberately not checked). An empty/absent list is "no policy"; the comparison is WITHOUT CASE.
      if (denylist && typeof request.order.locker === "string" && denylist.has(request.order.locker.toLowerCase())) {
        fail("address-denied", { step: "order-quote" });
      }
      let res = null;
      const viewHalfClaimer = request.viewHalfClaimer === undefined || request.viewHalfClaimer === null || request.viewHalfClaimer === ""
        ? null : String(request.viewHalfClaimer);
      try {
        // THE ANSWER IS READ AS A VALUE (tryJson), NOT AS AN EXCEPTION: "did not answer" and "answered and
        // refused" must stay different, and a refusal's own body carries the reason. `json` throws
        // server-unavailable and LOSES that body.
        res = await http.tryJson(config.route("orderQuote"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: request.providerId, order: request.order,
            ...(viewHalfClaimer === null ? {} : { viewHalfClaimer }), sdkVersion: SDK_VERSION }),
        });
      } catch (error) {
        if (error && error.code === "bad-input") throw error;
        fail("server-unavailable", { step: "order-quote" });
      }
      // A NODE'S DENYLIST REFUSAL REACHES THE APP UNDER ITS OWN NEUTRAL SDK CODE, WITHOUT the `why` text and
      // WITHOUT the address: the node names both (the maker's denylist and the address), and the interface shows
      // the person its own neutral message. Every other refusal keeps its existing code (quote-refused etc.).
      const refusedCode = res && res.body && typeof res.body.code === "string" ? res.body.code : null;
      if (refusedCode === "denied-address") fail("address-denied", { step: "order-quote" });
      if (!res || res.ok !== true || !res.body || res.body.ok !== true || !res.body.quote) {
        fail("quote-refused", { step: "order-quote" });
      }
      const body = res.body;
      const quote = body.quote;
      // THE MAKER'S VIEW HALF IS OURS, NOT THE NODE'S CHOICE. When the caller supplies it, the quote must carry the
      // same scalar back; otherwise the maker used another half and the joint view key cannot be rebuilt from the key.
      if (viewHalfClaimer !== null) {
        const echoed = quote.viewHalfClaimer;
        if (echoed === undefined || echoed === null || echoed === "") {
          fail("quote-field-unbound", { step: "viewHalfClaimer", field: "viewHalfClaimer" });
        }
        if (String(echoed).toLowerCase() !== viewHalfClaimer.toLowerCase()) {
          fail("quote-refused", { step: "viewHalfClaimer", why: "not-echoed" });
        }
      }
      // A MISSING FIELD OF THE SIGNED SET IS NOT "PROBABLY ZERO": the digest cannot be built, so the quote is
      // not verifiable and is refused (its own code, so the interface can say which field is unbound).
      const missingFields = orderQuoteMissingFields(quote);
      if (missingFields.length) fail("quote-field-unbound", { step: "signature", missing: missingFields });
      // THE QUOTE'S OWN EXPIRY, checked against the clock the core already has. It is bound in the signature too,
      // but a stale quote is refused by its own code rather than looking like a signature failure.
      const validUntil = Number(quote.validUntil);
      // THE SCALE IS SECONDS: the same as the order's deadlines and block.timestamp. The core's clock is in
      // milliseconds (Date.now), so exactly ONE boundary is converted - "now", not the quote value itself: one
      // unit for the value, one conversion at the input.
      const nowSec = Math.floor(now() / 1000);
      if (Number.isFinite(validUntil) && validUntil > 0 && validUntil <= nowSec) {
        fail("quote-expired", { step: "signature", validUntil });
      }
      // RECOVER, THEN MATCH THE NAMED KEY. A signature that does not recover is one refusal; a valid signature
      // that recovers to a DIFFERENT address is another (the quote names a key that did not sign it).
      const recoveredKey = recoverOrderQuoteKey(quote);
      if (recoveredKey === null) fail("quote-signature-invalid", { step: "signature" });
      const declaredKey = String(quote.quoteKey).toLowerCase();
      if (recoveredKey !== declaredKey) fail("quote-key-mismatch", { step: "signature", got: recoveredKey, want: declaredKey });
      // WHO OWNS THE KEY - ASKED OF THE REGISTRY NAMED BY THE QUOTE. Both fields are part of the signed set, so
      // they cannot be swapped after signing; this is what turns "a key signed it" into "this provider's key
      // signed it". No chain-read seam - refuse rather than take the signature on trust.
      const registry = String(quote.registry || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(registry) || registry === ZERO_ADDRESS) {
        fail("quote-field-unbound", { step: "registry", field: "registry" });
      }
      const declaredProvider = String(quote.provider || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(declaredProvider) || declaredProvider === ZERO_ADDRESS) {
        fail("quote-field-unbound", { step: "registry", field: "provider" });
      }
      if (typeof evmCall !== "function") fail("quote-registry-unchecked", { step: "registry", why: "no-chain-read" });
      let mappedProvider = null;
      try {
        mappedProvider = addressFromWord(await evmCall({ to: registry, data: providerOfData(declaredKey) }));
      } catch {
        fail("quote-registry-unchecked", { step: "registry", why: "read-failed", registry });
      }
      if (mappedProvider === null || mappedProvider === ZERO_ADDRESS) {
        fail("quote-key-unknown", { step: "registry", registry, quoteKey: declaredKey });
      }
      if (mappedProvider !== declaredProvider) {
        fail("quote-provider-mismatch", { step: "registry", got: mappedProvider, want: declaredProvider });
      }
      // THE INTERFACE'S OWN ADMISSION LIST - POLICY, NOT PROOF. The chain says whose key it is; whether this
      // interface trades with that provider at all is the interface's decision, and it rides as a hook.
      if (typeof providerAllowed === "function" && providerAllowed(declaredProvider) !== true) {
        fail("quote-provider-not-allowed", { step: "policy", provider: declaredProvider });
      }
      // THE FACTORY: NAMED BY THE PROVIDER'S RECORD, CHECKED BY ITS CODE (#103). The factory will verify the
      // quote in EVM (it is the EIP-712 verifyingContract), so it must be the one the record names AND its
      // code must be a build this interface knows. The record lookup always runs; the code check runs when a
      // policy list was supplied (nothing to pin against otherwise).
      const declaredFactory = String(quote.factory || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(declaredFactory) || declaredFactory === ZERO_ADDRESS) {
        fail("quote-field-unbound", { step: "factory", field: "factory" });
      }
      let recordedFactory = null;
      try {
        recordedFactory = addressFromWord(await evmCall({ to: registry, data: factoryOfData(declaredProvider) }));
      } catch {
        fail("quote-factory-unchecked", { step: "factory", why: "read-failed", registry });
      }
      if (recordedFactory === null || recordedFactory === ZERO_ADDRESS) {
        fail("quote-factory-unknown", { step: "factory", registry, provider: declaredProvider });
      }
      if (recordedFactory !== declaredFactory) {
        fail("quote-factory-mismatch", { step: "factory", got: declaredFactory, want: recordedFactory });
      }
      if (factoryPolicy) {
        if (typeof evmCode !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-code-read" });
        let codeHex = null;
        try { codeHex = await evmCode(declaredFactory); } catch { fail("quote-factory-unchecked", { step: "factory", why: "code-read-failed", factory: declaredFactory }); }
        const codeBytes = hexToBytesQ(codeHex);
        // EXTCODEHASH SEMANTICS: keccak256 of the runtime code. An address with no code (empty/0x) hashes to
        // the keccak of empty, which is not on any build list - refused like any unknown build.
        const codeHash = bytesToHexQ(keccak256(codeBytes || new Uint8Array(0)));
        if (!factoryPolicy.includes(codeHash)) {
          fail("quote-factory-code-unknown", { step: "factory", factory: declaredFactory, codeHash });
        }
      }
      // THE IMPLEMENTATION THE CLONES WILL EXECUTE (#114). A pinned factory CODE is not enough on its own: the
      // implementation ADDRESS lives in the factory's STORAGE, so the client re-reads the pair the factory itself
      // checks (implementation() / implementationCodeHash()) and the CODE at that address, then applies the same
      // verdict (verifyFactoryImplementationOnChain). A delegatecall to an address WITHOUT code SUCCEEDS, so a
      // clone without an implementation would take the ETH and its markReady/claim/refund would appear to go
      // through while doing nothing - that is exactly the case this refuses. The live code is re-hashed here, so
      // the verdict does not trust the factory's own answer alone.
      if (implementationPolicy) {
        if (typeof evmCall !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-chain-read" });
        if (typeof evmCode !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-code-read" });
        const verdict = await engine.evm.verifyFactoryImplementationOnChain({
          factory: declaredFactory,
          read: evmCall,
          code: (address) => evmCode(address),
          policy: implementationPolicy,
          hashCode: (codeHex) => bytesToHexQ(keccak256(hexToBytesQ(codeHex) || new Uint8Array(0))),
        });
        if (!verdict.ok) {
          const unknown = verdict.why === "implementation-code-unknown" ||
            verdict.why === "implementation-code-mismatch" || verdict.why === "implementation-has-no-code";
          fail(unknown ? "quote-factory-code-unknown" : "quote-factory-unchecked",
            { step: "factory", why: verdict.why, factory: declaredFactory, implementation: verdict.implementation || null });
        }
      }
      // BINDING THE QUOTE TO OUR TERMS. The signature confirms the provider signed THIS quote, but not that it is
      // about our swap: we are responsible for the binding. The context string is computed by OUR engine module
      // (format ninsei-order-v3; the field order is part of the protocol and must not be rearranged). There is
      // deliberately no copy of the format here: a copy would silently drift from the protocol.
      //
      // THE ORDER OF THE GATES: signature first, then binding. So a refusal names the nearest reason, not the first
      // one at hand.
      // THE PROVIDER MAY NAME THE CLAIMER HIMSELF, AND THAT IS ALSO AN ASSEMBLED CONTEXT (a defect found). The
      // provider may be the claimer: then it substitutes ITS OWN address into the order terms and signs the context
      // with it already in place. Requiring the context from the caller in that case is impossible - they do not
      // know the provider's address, and then the quote cannot be obtained at all (the live contour answered this
      // with bad-input {field:"order"} BEFORE any network). So if the sent terms had no claimer, the context is
      // computed from the terms WITH HIS value from the quote - exactly as the engine does it
      // (sdk/src/swap-flow.mjs: `{ ...orderBase, claimer: claimerResolved }`). No OPTIONAL checks appeared here:
      // a mismatched string is still a refusal (quote-refused { step: "context" }).
      let expectedContext = null;
      try { expectedContext = engine.orderContext.orderContextString(request.order); }
      catch { expectedContext = null; }
      if (expectedContext === null) {
        const providerClaimer = quote && quote.claimer;
        if (providerClaimer) {
          try { expectedContext = engine.orderContext.orderContextString({ ...request.order, claimer: providerClaimer }); }
          catch { fail("bad-input", { field: "order" }); }
        } else {
          fail("bad-input", { field: "order" });
        }
      }
      const quoted = quote.context || "";
      if (String(quoted) !== expectedContext) {
        fail("quote-refused", { step: "context", why: quoted ? "other-terms" : "not-reported" });
      }
      // THE CLAIM TIP: the seller pays it out of the payout, so a quote that asks for more than the claim can
      // cost is refused before it is signed. The chain's base fee is read through the caller's block seam; a
      // missing seam or an unreadable base fee is a named refusal, never a silently accepted tip.
      const tipCheck = (() => {
        try { return claimTipVerdict({ claimTipWei: quote.claimTip }); }
        catch { return { ok: true, tipWei: "0" }; }
      })();
      if (!tipCheck.ok && tipCheck.code === "quote-tip-unreadable") {
        fail("quote-field-unbound", { step: "claimTip", field: "claimTip" });
      }
      if (tipCheck.tipWei !== "0") {
        if (typeof evmBlock !== "function") fail("quote-tip-unchecked", { step: "claimTip", why: "no-block-read" });
        let block = null;
        try { block = await evmBlock("latest"); } catch { fail("quote-tip-unchecked", { step: "claimTip", why: "block-read-failed" }); }
        const baseFeeWei = block && (block.baseFeePerGas !== undefined ? block.baseFeePerGas : block.baseFeeWei);
        const verdict = claimTipVerdict({ claimTipWei: quote.claimTip, baseFeeWei });
        if (!verdict.ok) fail(verdict.code, { step: "claimTip", ...verdict });
      }
      return quote;
    },

    /**
     * A firm quote through the relay, starting from the one recovery key.
     *
     * The caller gives the signed features, the order terms and the recovery key; this method derives the
     * client half and both view points, sends one relay request and verifies the relay answer plus the
     * on-chain registry/factory binding. It returns the signed `orderQuote` and a `quote` carrying the maker's
     * view half, so `swaps.start` does not have to map relay fields by hand.
     */
    async firmRelay(request) {
      if (!request || typeof request !== "object") fail("bad-input", { field: "request" });
      const features = request.features;
      const order = request.order && typeof request.order === "object" ? { ...request.order } : null;
      if (!features || typeof features !== "object") fail("bad-input", { field: "features" });
      if (!order) fail("bad-input", { field: "order" });
      const side = String(request.side || "");
      if (side !== "ask" && side !== "bid") fail("bad-input", { field: "side" });
      const maker = String(features.provider || "").toLowerCase();
      const registry = String(features.registry || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(maker) || maker === ZERO_ADDRESS) fail("bad-input", { field: "features.provider" });
      if (!/^0x[0-9a-f]{40}$/.test(registry) || registry === ZERO_ADDRESS) fail("bad-input", { field: "features.registry" });
      // THE FEATURES' HPKE KEY AND FRAME KEY BELONG TO THE REGISTERED MAKER. Check the registry mapping BEFORE
      // sealing any view material to the HPKE key: a dishonest relay could otherwise hand us its own key, read both
      // view halves and swap in its own node half. The answer's registry check later is not a substitute for this
      // one - by then the view material has already been sealed.
      if (!/^0x[0-9a-f]{40}$/.test(String(features.quoteKey || "").toLowerCase()) || String(features.quoteKey).toLowerCase() === ZERO_ADDRESS) {
        fail("bad-input", { field: "features.quoteKey" });
      }
      if (typeof evmCall !== "function") fail("quote-registry-unchecked", { step: "features", why: "no-chain-read", registry });
      let featureProvider = null;
      try { featureProvider = addressFromWord(await evmCall({ to: registry, data: providerOfData(features.quoteKey) })); }
      catch { fail("quote-registry-unchecked", { step: "features", why: "read-failed", registry }); }
      if (featureProvider === null || featureProvider === ZERO_ADDRESS) {
        fail("quote-key-unknown", { step: "registry", registry, quoteKey: features.quoteKey });
      }
      if (!sameText(featureProvider, features.provider)) {
        fail("quote-provider-mismatch", { step: "registry", got: featureProvider, want: features.provider });
      }
      if (denylist && typeof order.locker === "string" && denylist.has(order.locker.toLowerCase())) {
        fail("address-denied", { step: "order-quote" });
      }
      // THE PROVIDER'S ROLE IS PART OF THE SIDE. A caller that names another claimer/locker is not asking
      // for this side; a caller that omits it gets the only value the wire allows.
      if (side === "ask") {
        if (order.claimer && !sameText(order.claimer, maker)) fail("bad-input", { field: "order.claimer" });
        order.claimer = maker;
      } else {
        if (order.locker && !sameText(order.locker, maker)) fail("bad-input", { field: "order.locker" });
        order.locker = maker;
      }
      const chainId = Number(order.chainId);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) fail("bad-input", { field: "order.chainId" });
      const windows = Array.isArray(features.firmWindows)
        ? features.firmWindows.filter((entry) => entry && entry.side === side)
        : [];
      const markets = [...new Set(windows.map((entry) => entry.market).filter((value) => typeof value === "string" && value))];
      const market = request.market !== undefined ? String(request.market) : (markets.length === 1 ? markets[0] : null);
      if (!market) fail("bad-input", { field: "market" });
      const window = windows.find((entry) => entry.market === market) || null;
      if (!window) fail("quote-refused", { step: "features", why: "window" });
      const xmrNetwork = request.xmrNetwork !== undefined ? String(request.xmrNetwork) : window.xmrNetwork;
      if (!xmrNetwork) fail("bad-input", { field: "xmrNetwork" });
      if (request.xmrAmount === undefined || request.xmrAmount === null || request.xmrAmount === "") {
        fail("bad-input", { field: "xmrAmount" });
      }
      const claimTip = request.claimTip === undefined || request.claimTip === null ? "0" : String(request.claimTip);
      const mnemonic = typeof request.recoveryKey === "string"
        ? request.recoveryKey
        : request.recoveryKey && typeof request.recoveryKey.mnemonic === "string" ? request.recoveryKey.mnemonic : null;
      if (!mnemonic) fail("bad-input", { field: "recoveryKey" });
      const saltRequested = request.recoverySalt !== undefined && request.recoverySalt !== null;
      const indexRequested = request.recoveryIndex !== undefined && request.recoveryIndex !== null;
      if (saltRequested && indexRequested) fail("bad-input", { field: "recoverySalt", why: "with-recovery-index" });
      let derived = null;
      let derivation = null;
      if (indexRequested) {
        const index = Number(request.recoveryIndex);
        if (!Number.isSafeInteger(index) || index < 0) fail("bad-input", { field: "recoveryIndex" });
        derived = takerHalves({ mnemonic, chainId, index });
        derivation = { kind: "index-v1", index };
      } else {
        if (!order.factory || !/^0x[0-9a-f]{40}$/i.test(String(order.factory))) fail("bad-input", { field: "order.factory" });
        let salt = null;
        try { salt = recoverySaltOf(saltRequested ? request.recoverySalt : order.salt); }
        catch { fail("bad-input", { field: "recoverySalt" }); }
        if (saltRequested) {
          let orderSalt = null;
          try { orderSalt = recoverySaltOf(order.salt); } catch { fail("bad-input", { field: "recoverySalt", why: "order-salt" }); }
          if (salt !== orderSalt) fail("bad-input", { field: "recoverySalt", why: "order-salt" });
        }
        derived = takerHalvesV2({ mnemonic, chainId, factory: order.factory, salt });
        derivation = { kind: "salt-v2", salt };
      }
      const own = buildOwnSideFromHalves(order, { spendHalf: derived.spendHalf, viewHalf: derived.viewHalf });
      const xa = secp256k1.Point.fromHex(own.side.proof.XA);
      const clientHalf = {
        commitHalf: bytesToHexQ(keccak256(xa.toBytes(false).slice(1))),
        edPoint: own.side.pub.ed,
        proof: own.side.proof,
      };
      const result = await requestFirmQuote({
        relayUrl: request.relayUrl,
        partner: request.partner,
        fetchImpl: request.fetchImpl,
        timeoutMs: request.timeoutMs,
        features,
        terms: {
          market,
          side,
          maker,
          registry,
          xmrNetwork,
          order,
          xmrAmount: String(request.xmrAmount),
          claimTip,
        },
        clientHalf,
        edViewPointClient: own.side.viewPub,
        edViewPointNode: derived.makerViewPoint,
        nodeViewScalar: derived.makerViewHalf,
        clientViewScalar: side === "bid" ? derived.viewHalf : null,
        side,
      });
      const quote = result.quote;
      // THE NODE HALF IS NOT A DECORATION. The answer's proof must stand in THIS order's context and the proven
      // point must be the one the quote commits to. For ask that is the claimer's commitment; for bid the node
      // half is the locker's and carries its own commitment. This is the same engine check the swap path uses.
      const nodeHalf = result.nodeHalf;
      acceptCounterparty({
        context: own.context,
        side: own.side,
        counterparty: side === "ask"
          ? {
              proof: nodeHalf.proof,
              edPub: quote.edPointClaimer,
              commitHalfClaimer: quote.commitHalfClaimer,
              viewPoint: result.edViewPointClaimer,
              viewHalf: derived.makerViewHalf,
            }
          : {
              proof: nodeHalf.proof,
              edPub: nodeHalf.edPoint,
              commitHalfClaimer: nodeHalf.commitHalf,
              viewPoint: result.edViewPointLocker,
              viewHalf: derived.makerViewHalf,
            },
      });
      // THE ONE-TIME XMR ADDRESS IS DERIVED, NOT TAKEN FROM THE RELAY. Both sides must assemble it from the same
      // points: our spend/view halves from the recovery key, the node's spend point and view point from the answer.
      // For ask we are the locker and the node is the claimer; for bid the roles are swapped.
      const nodeSpendPoint = side === "ask" ? quote.edPointClaimer : nodeHalf.edPoint;
      const nodeViewPoint = side === "ask" ? result.edViewPointClaimer : result.edViewPointLocker;
      const oneTimeAddress = jointAddress({
        ownSpendHalf: derived.spendHalf,
        ownViewHalf: derived.viewHalf,
        otherSpendPoint: nodeSpendPoint,
        otherViewPoint: nodeViewPoint,
        network: xmrNetwork,
      });
      // THE ESCROW ADDRESS IS A READ, NOT A GUESS. predict() is a free call and uses the same signed quote the
      // factory will receive; the locker fields are the side that deposits ETH. A read failure is a named refusal,
      // because a client that cannot name the escrow cannot watch it.
      const lockerHalf = side === "ask"
        ? { commitHalfLocker: clientHalf.commitHalf, edPointLocker: own.side.pub.ed, edViewPointLocker: own.side.viewPub }
        : { commitHalfLocker: nodeHalf.commitHalf, edPointLocker: nodeHalf.edPoint, edViewPointLocker: result.edViewPointLocker };
      let escrow = null;
      try {
        const predicted = await evmCall({
          to: quote.factory,
          data: engine.evm.encodePredict({ ...result.orderQuote, ...lockerHalf, signature: result.orderQuote.signature }),
        });
        escrow = engine.evm.decodeAddress(predicted);
      } catch {
        fail("quote-escrow-unchecked", { step: "factory", why: "predict-failed", factory: quote.factory });
      }
      if (providerAllowed && providerAllowed(maker) !== true) {
        fail("quote-provider-not-allowed", { step: "policy", provider: maker });
      }
      if (typeof evmCall !== "function") fail("quote-registry-unchecked", { step: "registry", why: "no-chain-read" });
      let mappedProvider = null;
      try {
        mappedProvider = addressFromWord(await evmCall({ to: registry, data: providerOfData(quote.quoteKey) }));
      } catch { fail("quote-registry-unchecked", { step: "registry", why: "read-failed", registry }); }
      if (mappedProvider === null || mappedProvider === ZERO_ADDRESS) fail("quote-key-unknown", { step: "registry", registry, quoteKey: quote.quoteKey });
      if (!sameText(mappedProvider, quote.provider)) {
        fail("quote-provider-mismatch", { step: "registry", got: mappedProvider, want: quote.provider });
      }
      let recordedFactory = null;
      try {
        recordedFactory = addressFromWord(await evmCall({ to: registry, data: factoryOfData(quote.provider) }));
      } catch { fail("quote-factory-unchecked", { step: "factory", why: "read-failed", registry }); }
      if (recordedFactory === null || recordedFactory === ZERO_ADDRESS) {
        fail("quote-factory-unknown", { step: "factory", registry, provider: quote.provider });
      }
      if (!sameText(recordedFactory, quote.factory)) {
        fail("quote-factory-mismatch", { step: "factory", got: quote.factory, want: recordedFactory });
      }
      if (factoryPolicy) {
        if (typeof evmCode !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-code-read" });
        let codeHex = null;
        try { codeHex = await evmCode(quote.factory); } catch { fail("quote-factory-unchecked", { step: "factory", why: "code-read-failed", factory: quote.factory }); }
        const codeHash = bytesToHexQ(keccak256(hexToBytesQ(codeHex) || new Uint8Array(0)));
        if (!factoryPolicy.includes(codeHash)) fail("quote-factory-code-unknown", { step: "factory", factory: quote.factory, codeHash });
      }
      if (implementationPolicy) {
        if (typeof evmCall !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-chain-read" });
        if (typeof evmCode !== "function") fail("quote-factory-unchecked", { step: "factory", why: "no-code-read" });
        const verdict = await engine.evm.verifyFactoryImplementationOnChain({
          factory: quote.factory,
          read: evmCall,
          code: (address) => evmCode(address),
          policy: implementationPolicy,
          hashCode: (codeHex) => bytesToHexQ(keccak256(hexToBytesQ(codeHex) || new Uint8Array(0))),
        });
        if (!verdict.ok) {
          const unknown = verdict.why === "implementation-code-unknown" ||
            verdict.why === "implementation-code-mismatch" || verdict.why === "implementation-has-no-code";
          fail(unknown ? "quote-factory-code-unknown" : "quote-factory-unchecked",
            { step: "factory", why: verdict.why, factory: quote.factory, implementation: verdict.implementation || null });
        }
      }
      const tipCheck = (() => {
        try { return claimTipVerdict({ claimTipWei: quote.claimTip }); }
        catch { return { ok: true, tipWei: "0" }; }
      })();
      if (!tipCheck.ok && tipCheck.code === "quote-tip-unreadable") {
        fail("quote-field-unbound", { step: "claimTip", field: "claimTip" });
      }
      if (tipCheck.tipWei !== "0") {
        if (typeof evmBlock !== "function") fail("quote-tip-unchecked", { step: "claimTip", why: "no-block-read" });
        let block = null;
        try { block = await evmBlock("latest"); } catch { fail("quote-tip-unchecked", { step: "claimTip", why: "block-read-failed" }); }
        const baseFeeWei = block && (block.baseFeePerGas !== undefined ? block.baseFeePerGas : block.baseFeeWei);
        const verdict = claimTipVerdict({ claimTipWei: quote.claimTip, baseFeeWei });
        if (!verdict.ok) fail(verdict.code, { step: "claimTip", ...verdict });
      }
      // THE SIGNED XMR AMOUNT TRAVELS WITH THE ORDER TERMS. `swaps.start` records its order as given, and the
      // arrival check must compare the exact amount signed in the quote - not the display size, which the relay
      // answer does not carry at all.
      const signedAtomic = result.orderQuote && result.orderQuote.xmrAmount !== undefined && result.orderQuote.xmrAmount !== null
        ? String(result.orderQuote.xmrAmount) : null;
      if (!signedAtomic) fail("quote-field-unbound", { step: "xmrAmount", field: "orderQuote.xmrAmount" });
      return {
        ...result,
        quote: { ...quote, viewHalfClaimer: derived.makerViewHalf, xmrAmount: signedAtomic },
        order: { ...order, xmrAmount: signedAtomic },
        // THE SHAPE `swaps.start` TAKES: the proof and the claimer commitment travel with the view half, so a
        // caller can pass this object as `counterparty` without rebuilding the relay fields.
        counterparty: {
          proof: nodeHalf.proof,
          edPointClaimer: side === "ask" ? quote.edPointClaimer : nodeHalf.edPoint,
          commitHalfClaimer: side === "ask" ? quote.commitHalfClaimer : nodeHalf.commitHalf,
          viewHalfClaimer: derived.makerViewHalf,
          viewPoint: side === "ask" ? result.edViewPointClaimer : result.edViewPointLocker,
        },
        viewHalfClaimer: derived.makerViewHalf,
        viewHalfPoint: derived.makerViewPoint,
        jointAddress: oneTimeAddress.address,
        escrow,
        recovery: derivation,
      };
    },
  };
}
