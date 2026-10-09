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
import * as engine from "./engine.mjs";
import { orderQuoteMissingFields, recoverOrderQuoteKey } from "./quoteEip712.mjs";
// THE CHAIN READ NEEDED TO ASK THE REGISTRY WHO OWNS THE KEY. The selector is COMPUTED from the signature, not
// remembered: a single wrong hex digit would call another function and return a zero address - and a zero
// address is exactly the answer "nobody owns this key", which the caller would take as the truth.
import { keccak256 } from "./primitives.mjs";

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
  why: o.why, signature: o.signature, keyId: o.keyId, ageMs: o.ageMs,
  networks: { asset: o.assetNetwork, currency: o.currencyNetwork, stated: o.networkStated },
});

// A REFUSAL IS THE SAME ROW PLUS A REASON CODE. The fields are not trimmed: the interface needs the range and
// the price of the failed row to tell the person WHY there is no offer (and not just "none").
const compactRefusal = (r) => ({ ...compactOffer(r), code: r.code, why: r.why });

export function createQuotes({ config, http, now = () => Date.now(), evmCall = null, evmCode = null, providerAllowed = null, knownFactoryCodes = null, knownImplementationCodes = null, denylist = null }) {
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
      const offer = book.best;
      const amount = Number.isFinite(Number(request.amount)) ? Number(request.amount) : null;
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
      try {
        // THE ANSWER IS READ AS A VALUE (tryJson), NOT AS AN EXCEPTION: "did not answer" and "answered and
        // refused" must stay different, and a refusal's own body carries the reason. `json` throws
        // server-unavailable and LOSES that body.
        res = await http.tryJson(config.route("orderQuote"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerId: request.providerId, order: request.order }),
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
      // (format arrakis-order-v3; the field order is part of the protocol and must not be rearranged). There is
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
      return quote;
    },
  };
}
