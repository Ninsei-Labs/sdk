// GENERATED FILE - a byte-for-byte copy of the engine module www/js/sdk/bridge.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// THE PAGE-TO-CORE SHIM: THE ONE PLACE WHERE SCREENS KNOW ABOUT THE SDK (sdk/).
//
// WHY IT EXISTS. The swap logic lives in the core (sdk/, the @ninsei-labs/sdk package) while the page should do
// only markup, screen state and texts. Before this shim every screen called the engine itself and the logic
// spread across two places. Now a screen calls the SHIM, and only it knows about the core.
//
//
// WHAT THE SHIM PASSES TO THE CORE - exactly the seams the core asks for from outside and cannot get itself:
//   storage    - the page's storage: deals and session are read from where the page puts them (core/store.js);
//   serverAuth - a pass to our service: only the wallet can sign the sign-in message (evm/auth.js signIn),
//                so the core gets the pass READY-MADE;
//   evmCall    - chain reads WITH THE PAGE'S WALLET: the core has no provider of its own and must not;
//   wallet     - the page wallet adapter (sdk/src/adapters/evm-wallet.mjs): signing happens only in it.
//
// WHAT THE SHIM DOES NOT DO. It computes neither thresholds nor step order nor the escrow address: method names
// and paths are only those that EXIST in the core, and the decisions stay in the core.
//
// ABOUT THE CORE BEING AVAILABLE TO THE PAGE - IT IS NOW BUILT, NOT WAITING FOR A BUILD.
//   * sdk/src/primitives.mjs imports @noble/curves and @noble/hashes by BARE package names, so the page is
//     served not the sdk/ source but a BUILT BUNDLE (www/assets/vendors/sdk/sdk-browser.js, the same path as the
//     atomic-swap crypto bundle). The bundle exposes the WHOLE FACADE:
//     createNinsei (config/wallet/quotes/preflight/swaps/actions/order/sweep/recovery/sim) plus the browser
//     adapters (evmWallet, localStorageAdapter/memoryAdapter). So starting a swap (swaps.start) and facade
//     quotes ARE available to the page - a "facade not served to the page" refusal is no longer expected.
//   * The bundle link carries ?v=<hash>, so the edge cache resets itself after a rebuild.
//
//
// THE ORDER ACTIONS HAVE NO FALLBACK PATH ANY MORE, AND THAT IS A CONSEQUENCE OF THE MOVE. The deal engine used
// to sit on the page and, with the bundle unavailable, the order actions ran on it - "the same functions", as it
// was written here. Now the deal engine is a module OF THE PACKAGE (sdk/src/swap-flow.mjs): there is no second
// copy on the page, so no fallback can exist. The bundle did not load (missing file, old cache, network) - that
// is a NAMED refusal with the cause in the console (sdkBundle below), not silence and not a substitution.
//

import { chainById, DEFAULT_CHAIN, MONERO, allowedProvidersFor, knownFactoryCodesFor, knownImplementationCodesFor } from "../core/config.js";
import { storage as pageStorage } from "../core/store.js";
import { token as authToken, signIn } from "../evm/auth.js";
import * as evm from "../evm/index.js";
// ORDER TERMS FOR THE CORE ARE ASSEMBLED FROM DATA, NOT FROM RULES: the windows come from the finality policy
// (core/finality.js), the salt from the engine's generator (evm/funding.js). No deadlines or numbers of its own here.
import { orderWindows } from "../core/finality.js";
import { newSecret } from "../evm/funding.js";
// THE ORDER CALLS - ACTION AND READ - COME FROM THE CORE. The deal engine moved into the package, and the shim
// exposes EXACTLY the same names (markReadyOrder/claimOrder/refundOrder/orderStatus/orderDeadlines), so a screen
// changes only the import source, not the call expression - and the guard that fixes the call site sees the old call.
//
// THE DEAL LIST AND ITS UPKEEP (the #/swaps screen). States come from the CORE: swaps.list - display, swaps.sync -
// merging with the server list, swaps.forget - dropping a record. The core needs only the page's seams for this
// (the pass and the storage), and both are already passed above - the shim adds no rules of its own.
//
// WATCHING IS A PAGE MECHANISM, NOT THE CORE'S: the poll tick lives in app.js, so the focus stays in
// core/swap.js and the screen only declares it to the shim.
import { setLiveFocus, dealSwapIds, serverRestoreHeightFor, STEP_LABELS,
  confirmReady as engineConfirmReady, refundEth as engineRefundEth, sweepNow as engineSweepNow,
  getSwap as engineGetSwap, saveSwap as engineSaveSwap } from "../core/swap.js";
// THE FEE RATE AND THE ORDER STATE - CHAIN READS WITH THE PAGE'S WALLET: the reference panel ("how it works")
// and recovery-file parsing take them. The page gets them FROM HERE, not directly from evm/*.
import { cachedFeeRate } from "../evm/fees.js";
// MONERO ADDRESS AND HEIGHT - DELIBERATE PAGE READS (the progress screen): checking the recipient address
// format and the node height for the scan height in the recovery file. The address logic lives in the core
// (swaps.addressNetwork), here a fallback by the same module; the node height is the page node's read.
import { networkFromShape } from "../monero/address.js";
import { height as nodeHeightValue } from "../monero/node.js";

// THE CORE ADDRESS AS A STRING - THE BUILT BUNDLE UNDER www/: the page gets the core as ONE module, not a pile
// of sdk/ sources; ?v=<hash> keeps the cache fresh.
const SDK_BUNDLE = "/assets/vendors/sdk/sdk-browser.js?v=3ce64c53";

// A NAMED SEAM FOR CHECKS - THE SAME TECHNIQUE AS sdkBookUse BELOW. The asynchronous path is driven against a
// stand-in order book (the demo network has no provider), and the ordinary escrow funding that follows a settled
// swap can be replaced while that runs, because deploying an escrow factory on a throwaway chain is the stand's
// job, not a check's. The replacement is named, set only by a check, and unset by the same function; production
// never calls it, so the real funding path is what ships.
let startSwapOverride = null;
export function useStartSwap(fn = null) { startSwapOverride = typeof fn === "function" ? fn : null; return Boolean(startSwapOverride); }

// ONE LOAD PER PAGE. A refusal is a state, not a breakdown: it is named in the console and the caller decides.
let loading = null;
export async function sdkBundle() {
  if (!loading) {
    loading = (async () => {
      try { return await import(SDK_BUNDLE); }
      catch (error) {
        console.warn("[bridge] the built SDK core was not served to the page (" + ((error && error.message) || error) +
          "): actions go by the previous engine call; see www/js/sdk/bridge.js");
        return null;
      }
    })();
  }
  return loading;
}

// THE SURFACES FROM THE BUNDLE - EXACTLY THE NAMES USED BELOW. So a screen need not know the core came as one
// file rather than three: the call form does not change.
export async function sdkCoreModules() {
  const mod = await sdkBundle();
  if (!mod) return null;
  return {
    actions: { createActions: mod.createActions },
    wallet: { evmWallet: mod.evmWallet },
    recovery: { createRecovery: mod.createRecovery },
  };
}

// THE CORE FACADE (config/quotes/swaps/actions/recovery whole) - THE SAME bundle, only its createNinsei is needed.
async function coreFacade() {
  const mod = await sdkBundle();
  return mod ? { factory: mod.createNinsei } : null;
}

function modeOf(chain) {
  return chain && chain.escrow && chain.escrow.mode === "live" ? "live" : "sim";
}

// CORE SETTINGS FROM THE PAGE. No value here decides anything FOR the core: it is the service address, the
// network, the storage and the seams the core asks for from outside.
function optionsFor(chain) {
  return {
    settlement: { chain: chain.id },
    xmrNetwork: MONERO.networkType,
    apiBase: "/api",
    assetsBase: "/",
    mode: modeOf(chain),
    // THE PAGE STORAGE BECOMES THE CORE STORAGE: deal records and the session live in one place.
    storage: pageStorage(),
    // A PASS TO OUR SERVICE: the core only presents it; the page wallet obtains it.
    serverAuth: async () => {
      if (authToken()) return authToken();
      try { await signIn(); } catch { return null; }
      return authToken();
    },
    // CHAIN READS - WITH THE PAGE'S WALLET (the core needs this seam: it has no provider of its own).
    evmCall: (request) => evm.readContract(request),
    // CONTRACT CODE - WITH THE PAGE'S WALLET: needed by the factory-code check, extcodehash is computed from it.
    evmCode: (address) => evm.readCode({ address }),
    // OUR ALLOW-LIST - INTERFACE POLICY. The core confirms with the CHAIN whose key signed the quote (the maker
    // registry); this list decides whom the PAGE trades with. A provider outside the list fails with the code
    // `quote-provider-not-allowed` - and the refusal is visible BEFORE signing, because without a firm quote
    // there is neither a fee rate nor a lock. The list comes from the network registry (core/config.js,
    // allowedProvidersFor), not invented here; a network without a list = no policy.
    allowedProviders: allowedProvidersFor(chain),
    // THE LIST OF KNOWN FACTORY BUILDS - INTERFACE POLICY, next to allowedProviders. The core takes the factory
    // from the provider registry record and compares its CODE against this list (extcodehash). Empty = no policy;
    // then the factory must still match the signed quote.
    knownFactoryCodes: knownFactoryCodesFor(chain),
    // THE HASH OF A KNOWN ESCROW-IMPLEMENTATION BUILD - NEXT TO knownFactoryCodes. The factory compares the pair
    // (implementation, implementationCodeHash) at order creation; the core compares THE SAME pair on chain, and
    // this list is interface policy: which implementation builds it accepts. Empty = no policy (a network with an
    // old factory), and then the pair is still read and the code at the implementation address must be non-empty.
    knownImplementationCodes: knownImplementationCodesFor(chain),
  };
}

// ONE CORE INSTANCE PER NETWORK: the facade holds storage and subscriptions, and a second instance for the same
// network would mean a second poll. Unavailable - null, and the caller names the refusal itself.
const instances = new Map();
async function instanceFor(chainSlug) {
  const facade = await coreFacade();
  if (!facade) return null;
  const chain = chainById(chainSlug || DEFAULT_CHAIN);
  if (!instances.has(chain.id)) instances.set(chain.id, facade.factory(optionsFor(chain)));
  return { chain, sdk: instances.get(chain.id) };
}

// THE PAGE WALLET FOR THE CORE: an adapter over ITS provider. Taken AT THE MOMENT of an action: the provider
// appears with the connection, not at page load.
function walletFor(mods) {
  const provider = typeof evm.currentProvider === "function" ? evm.currentProvider() : null;
  if (!provider) return null;
  return mods.wallet.evmWallet(provider);
}

// --- ORDER ACTIONS -------------------------------------------------------------------------------
// THE NAMES AND THE REQUEST SHAPE ARE THE SAME AS THE SCREEN'S FORMER CALLS. The screen passes the order
// expectations (expect) and recomputes nothing: the core checks slots against the chain BEFORE signing and does
// not sign without expectations. The wallet is the one that signs the page; the core needs no network here
// (reading and sending go through the same provider as before).
export async function markReadyOrder({ escrow, expect } = {}) {
  const mods = await sdkCoreModules();
  const wallet = mods ? walletFor(mods) : null;
  // THE CORE AND THE WALLET ARE MANDATORY: there is no fallback path (an engine on the page) any more. The refusal is named, not silence.
  if (!mods || !wallet) throw new Error("[bridge] nothing to sign the readiness mark with: " + (mods ? "wallet not connected" : "the SDK core was not served to the page"));
  return await mods.actions.createActions({ call: (r) => evm.readContract(r) })
    .markReady({ escrow, expect }, wallet);
}

export async function claimOrder({ escrow, halfClaimer, expect } = {}) {
  const mods = await sdkCoreModules();
  const wallet = mods ? walletFor(mods) : null;
  if (!mods || !wallet) throw new Error("[bridge] nothing to sign the claim with: " + (mods ? "wallet not connected" : "the SDK core was not served to the page"));
  return await mods.actions.createActions({ call: (r) => evm.readContract(r) })
    .claim({ escrow, halfClaimer, expect }, wallet);
}

export async function refundOrder({ escrow, halfLocker } = {}) {
  const mods = await sdkCoreModules();
  const wallet = mods ? walletFor(mods) : null;
  if (!mods || !wallet) throw new Error("[bridge] nothing to sign the refund with: " + (mods ? "wallet not connected" : "the SDK core was not served to the page"));
  // THERE ARE NO EXPECTATIONS HERE ON PURPOSE: the refund screen did not pass any, and adding them would enable
  // slot comparison where it was not - i.e. change the refund behaviour.
  return await mods.actions.createActions({ call: (r) => evm.readContract(r) })
    .refund({ escrow, halfLocker }, wallet);
}

// --- AUTOMATIC EARLY REFUND ---------------------------------------------------------------------
// THE DECISION STAYS IN THE CORE. The screen only passes the deal record, the order expectations and the network;
// the arrival check (two nodes of different operators on one block) and the "time to refund" decision are the
// core's (swaps.refundIfXmrMissing). The witness nodes come from the settings of THE SAME core (config.nodesFor),
// not invented here: the list lives as one truth per network. The wallet is the same page adapter that signs the other order actions.
export async function sdkAutoRefund(request) {
  const ctx = await instanceFor(request && request.chain);
  if (!ctx) return null;
  const req = { ...(request || {}) };
  if (!req.nodes && ctx.sdk.config && typeof ctx.sdk.config.nodesFor === "function") {
    req.nodes = ctx.sdk.config.nodesFor(req.xmrNetwork || MONERO.networkType);
  }
  if (!req.wallet) {
    const mods = await sdkCoreModules();
    const wallet = mods ? walletFor(mods) : null;
    if (wallet) req.wallet = wallet;
  }
  return ctx.sdk.swaps.refundIfXmrMissing(req);
}

// --- RECOVERY-FILE PARSING -----------------------------------------------------------------------
// The parsing module is served to the browser, so this is a real core path, not a fallback.
export async function sdkOpenRecovery(file, passphrase) {
  const mods = await sdkCoreModules();
  if (!mods) return null;
  return await mods.recovery.createRecovery().open(file, passphrase);
}

// --- FACADE SURFACES (quotes, deal state, swap start) ---------------------------------------------
// The core is served to the page as a bundle, so these calls go through the REAL facade. They answer null only
// if the bundle itself did not load - and then the cause is named in the console, not hidden.

export async function sdkWatchQuotes(request, onSnapshot) {
  const ctx = await instanceFor(request && request.chain);
  if (!ctx) return null;
  return ctx.sdk.quotes.watch(request, onSnapshot);
}

export async function sdkQuotesSnapshot(chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.quotes.snapshot() : null;
}

// --- THE INDICATIVE QUOTE BOOK ON THE CORE ---------------------------------------------------------
// THE BOOK (offers and refusals) COMES FROM THE CORE: quotes.watch subscribes to the core poll, quotes.snapshot
// returns the last snapshot without waiting. The shim does exactly ONE job here - TRANSLATION OF SHAPE: the core
// snapshot's field names are mapped to those the screen already draws. There is no selection or priority rule
// here: offer, refusal or best is decided by the core (sdk/src/quotes.mjs, readBook). The core is silent or
// refused - the book is empty, and the former (engine) book is not substituted: it no longer exists.
//
// SUBSCRIPTION IS ONE. The core polls for the duration of the subscription; a second listener would be a second
// poll, so the previous subscription is removed BEFORE the new one. The last snapshot survives re-subscription:
// the reader sees the previous book until a fresh one arrives - not emptiness on every tick.
let bookStop = null;       // unsubscribe from the core's current subscription
let bookKey = null;        // which request (network|side|token|size) this subscription is for
let bookCore = null;       // the last CORE snapshot (not the translation): the translation is done on read
let bookResume = null;     // waiting for the first tick after subscribing
// A SEAM HOOK (sdkBookUse): a core quote surface brought from outside. Needed by checks that run WITHOUT a
// browser: the core itself is not in the bundle there, and the book must be checked. Not set in production.
let bookQuotes = null;

// THE CORE FOR CHECKS WITHOUT A BROWSER: put in a quote surface (watch/snapshot) and work with it.
export function sdkBookUse(quotesApi) {
  bookQuotes = quotesApi || null;
  bookCore = null;
  bookKey = null;
  bookResume = null;
  if (bookStop) { try { bookStop(); } catch { /* already removed */ } }
  bookStop = null;
}

// TRANSLATING A CORE ROW INTO A SCREEN ROW. Names only: values are carried as is. The age is computed
// HERE (from the quote's own timestamp): the core computed it on its own tick, while display asks for freshness
// now - otherwise the quote's lifetime would be rejuvenated by a poll tick.
function bookRow(o) {
  const at = Number.isFinite(Number(o.at)) ? Number(o.at) : null;
  return {
    providerId: o.providerId, displayName: o.displayName, pair: o.pair,
    asset: o.asset, currency: o.currency,
    assetNetwork: o.assetNetwork, currencyNetwork: o.currencyNetwork, networkStated: o.networkStated === true,
    rateQuote: o.rateQuote, rate: o.rate,
    min: o.min, max: o.max, step: o.step, ttlMs: o.ttlMs,
    at, ageMs: at === null ? null : Math.max(0, Date.now() - at),
    seq: o.seq, why: o.why, signature: o.signature, keyId: o.keyId, finality: o.finality,
    networksDerived: o.networksDerived === true, networksUnnamed: o.networksUnnamed === true,
  };
}

// THE REFUSAL KIND WITH WHICH THE SCREEN NAMES THE CAUSE. The core code `disabled` is called `off` by the
// screen; other code names match, and there is no reason to rename them.
const REFUSAL_KIND = { disabled: "off" };
function bookRefusal(r) {
  return { ...bookRow(r), code: r.code, kind: REFUSAL_KIND[r.code] || r.code, why: r.why };
}

// CORE SNAPSHOT -> SCREEN SNAPSHOT. The shape is the one the screen had: ok/error/data/at, and in data -
// references (the reference rate) and best. A connection failure does not turn into the former numbers: ok is
// dropped and the screen shows an honest state. Core silence (no snapshot) is also an empty book, not the former one.
function bookOf(core) {
  if (!core) return { ok: false, error: null, data: null, at: 0, fetching: false };
  const offers = (Array.isArray(core.offers) ? core.offers : []).map(bookRow);
  const refused = (Array.isArray(core.refused) ? core.refused : []).map(bookRefusal);
  const stamps = offers.map((o) => o.at).filter((v) => Number.isFinite(v));
  return {
    ok: !core.error,
    error: core.error ? String(core.error.code || "unknown") : null,
    at: core.at,
    fetching: false,
    data: {
      offers, refused, quotes: offers,
      // THE BEST, AS THE SERVICE NAMED IT: by it the screen confirms its "best" mark by pair and provider.
      best: core.best || null,
      seq: core.seq === undefined ? null : core.seq,
      references: Array.isArray(core.references) ? core.references : [],
      at: stamps.length ? Math.max(...stamps) : null,
    },
  };
}

// ASKING THE CORE FOR THE BOOK. The subscription is ONE and is replayed only when the REQUEST CHANGED: while
// size and side are the same, the core polls the book on its own tick and no second poll is created. When the
// request changed, the caller waits for the first tick and gets a FRESH snapshot, not a previous one. The core
// did not come up - empty (and the console names why).
export async function sdkBook({ chain, direction, token, size } = {}) {
  let quotes = bookQuotes;
  let instance = "injected";        // the hook (seam) has no network: its instance is one
  if (!quotes) {
    const ctx = await instanceFor(chain);
    if (!ctx) {
      if (bookStop) { try { bookStop(); } catch { /* already removed */ } bookStop = null; }
      bookKey = null;
      bookResume = null;
      bookCore = null;
      return null;
    }
    quotes = ctx.sdk.quotes;
    instance = ctx.chain.id;       // books of different networks must not be mixed: the network is part of the key
  }
  const dir = direction === "sell" ? "sell" : "buy";
  const key = instance + "|" + dir + "|" + String(token || "") + "|" + String(size === undefined || size === null ? "" : size);
  // THE SAME REQUEST - A POLL IS ALREADY RUNNING: return the last snapshot, do not create a second subscription.
  // Otherwise every screen tick would reset the core state and briefly serve an empty book to a direct reader.
  if (bookStop && bookKey === key) return bookCore;
  if (bookStop) { try { bookStop(); } catch { /* already removed */ } bookStop = null; }
  bookKey = key;
  bookResume = null;
  const wait = new Promise((resolve) => { bookResume = resolve; });
  try {
    bookStop = quotes.watch({ direction: dir, token, size }, (snap) => {
      bookCore = snap;
      if (bookResume) { const resume = bookResume; bookResume = null; resume(); }
    });
  } catch (error) {
    bookResume = null;
    bookCore = null;
    console.warn("[bridge] the quote book was not served to the core (" + ((error && error.message) || error) +
      "): there will be no offers; see www/js/sdk/bridge.js");
    return null;
  }
  await wait;
  return bookCore;
}

// THE LAST SNAPSHOT WITHOUT WAITING - in the screen's shape. The core has not been polled once - empty (and that is honest).
export function sdkBookSnapshot() {
  return bookOf(bookCore);
}

export async function sdkListSwaps(chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.list() : null;
}

export async function sdkGetSwap(id, chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.get(id) : null;
}

// ORDER TERMS - DATA FOR THE CORE, NOT ITS RULES.
// The core requires these eight fields FROM OUTSIDE (sdk/index.d.ts, StartRequest.order) and refuses without them:
// both the DLEQ proof and the firm-quote signature are bound to them (atomic/orderContext.js, FIELDS). Here they
// are not derived again but taken from the same sources the page used: network and factory from the network
// registry, the depositor - the connected wallet, the amount - from the quote, the windows - from the provider's
// finality policy (core/finality.js, orderWindows), the salt - from the engine's generator (evm/funding.js,
// newSecret). No windows or numbers of its own appear here: the minimum-window rule lives in core/finality.js and core/preSignGuards.js.
export function sdkOrderTerms({ chain, amountWei, finality = null, salt = null, asset = "XMR" } = {}) {
  const windows = orderWindows(finality);
  const nowSec = Math.floor(Date.now() / 1000);
  const escrow = (chain && chain.escrow) || {};
  // THE FEE CASHIER IS PART OF THE ORDER TERMS, like the factory: it comes from the network registry, not from
  // the contract. Without it the order cannot be assembled: the term is mandatory and enters termsHash.
  if (!escrow.cashier) throw new Error("no fee cashier set on this network (escrow.cashier) - the order cannot be assembled");
  return {
    chainId: chain.chainId,
    factory: escrow.address,
    cashier: escrow.cashier,
    locker: evm.address(),
    amount: String(amountWei),
    // WHAT THE PERSON RECEIVES. The field is not part of the canonical order context (it is a consequence of the
    // pair and network), but the provider expects it - by it he understands the payout is in XMR, and puts it in
    // his quote record. The value comes as data from the screen; the default is XMR (the screen buying XMR for the native coin).
    asset: String(asset || "XMR"),
    readyBy: String(nowSec + windows.readyWindowSeconds),
    t1: String(nowSec + windows.claimWindowSeconds),
    salt: salt || newSecret(),
  };
}

// A FIRM QUOTE FOR THE ORDER - BEFORE SIGNING. The screen shows the fee rate and recipient BEFORE the person
// signs, and hands THE SAME quote to the swap start (sdkStartSwap, field orderQuote): exactly what is shown is
// signed, and no second request to the node is made.
//
// WHY THIS PLACE AND NOT THE SCREEN. The order terms (network, factory, depositor, amount, windows, salt) are
// assembled in ONE place - sdkOrderTerms; the screen must not assemble them in a second edition. Here they are
// assembled, a firm quote is requested by them through the core's path, and both go outward: `order` and `quote`.
export async function sdkOrderQuote({ chain, providerId, amountWei, finality = null, salt = null, asset = "XMR" } = {}) {
  const ctx = await instanceFor(chain);
  if (!ctx) return null;
  const order = sdkOrderTerms({ chain: ctx.chain, amountWei, finality, salt, asset });
  const quote = await ctx.sdk.quotes.firm({ providerId, order });
  return { order, quote };
}

// STARTING THE SWAP WHOLE, BY THE CORE. Step order, the order side, deadlines into the contract, the escrow
// address FROM THE RECEIPT, our readiness mark and watching the XMR - all of it is held by the core
// (sdk/src/swaps.mjs, swaps.start). The screen passes only data: the quote, where to receive, the password, the
// wallet and the file-confirmation handler. The page assembles no order side, no addresses and no transactions here.
export async function sdkStartSwap(request) {
  // THE CHECK SEAM (see useStartSwap above): a stand-in for the escrow funding while the asynchronous path is
  // exercised. Absent in production - the real core path below is what runs.
  if (startSwapOverride) return startSwapOverride({ ...(request || {}) });
  const ctx = await instanceFor(request && request.chain);
  if (!ctx) return null;
  const req = { ...(request || {}) };
  // THE WALLET FOR THE LOCK - THE PAGE WALLET ADAPTER, IF THE CALLER DID NOT BRING ONE. Signing is possible only
  // in the page's wallet provider, and the core has no provider of its own: the core gets a ready adapter (send/receipt).
  if (!req.wallet) {
    const mods = await sdkCoreModules();
    const wallet = mods ? walletFor(mods) : null;
    if (wallet) req.wallet = wallet;
  }
  // THE PAGE WALLET IS ALSO GIVEN TO THE CORE AS ITS WALLET: the network guards (preflight) ask the network OF
  // THE CORE'S WALLET, not of the one passed for the lock - otherwise the start fails with the code network
  // { wallet-unknown } (the live Node run does the same: sdk.wallet.use(...); await sdk.wallet.connect()). The
  // signature does not change: both connecting and sending go through the same page provider.
  if (req.wallet) {
    try { ctx.sdk.wallet.use(req.wallet); await ctx.sdk.wallet.connect({ chainId: ctx.chain.chainId }); }
    catch { /* the wallet did not come up - the core itself will name the refusal (network/wallet-unknown), no silence */ }
  }
  // No order terms - assemble them from data (see sdkOrderTerms). The StartRequest contract also allows ready
  // ones: then the caller brings its own order side with its own points (record injection).
  if (!req.order) {
    req.order = sdkOrderTerms({ chain: ctx.chain, amountWei: req.amountWei, finality: req.finality,
      salt: req.salt, asset: req.receiveAsset });
  }
  // A FIRM QUOTE FOR THIS ORDER - AND IT ALSO GOES INTO THE LOCK. A screen that showed the fee BEFORE signing
  // brings the quote READY-MADE (sdkOrderQuote) - then we do not go to the node again and exactly what the person
  // saw is signed. If it did not, we request it here through the core's path (config.route("orderQuote")).
  //
  // WHY THIS SEPARATE FIELD. The lock takes the quote NOT from req.quote: req.quote is the book's indicative
  // quote for the guards (freshness, deadlines), while the factory needs a SIGNED SET (fee, registry, provider).
  // The core reads it as `request.orderQuote` (sdk/src/swaps.mjs). While the bridge did not put it there, the
  // start reached the deposit and failed there: "a signed quote is required: the factory takes a quote, not bare order terms".
  if (!req.orderQuote && req.providerId) {
    req.orderQuote = await ctx.sdk.quotes.firm({ providerId: req.providerId, order: req.order });
  }
  if (req.orderQuote) {
    // THE CLAIMER IS NAMED BY THE PROVIDER, and enters the order context: without it the proof would not agree
    // (the core refuses - context mismatch). Here we only carry its value into the terms.
    if (req.orderQuote.claimer) req.order = { ...req.order, claimer: req.orderQuote.claimer };
    // THE ORDER QUOTE ID GOES INTO THE DEAL RECORD: by it our service ties the escrow to the provider node's
    // record, and only then can the node take the ETH. The screen did it itself (swap.orderQuoteId) - so the data
    // stays the same, and it must not be lost in translation.
    if (req.orderQuote.id) req.quote = { ...(req.quote || {}), id: req.orderQuote.id };
    // THE COUNTERPARTY SIDE IS THIS SAME QUOTE: it holds the provider's half, point and proof, and the core
    // checks it too (order.acceptCounterparty). The bridge invents no counterparty side of its own.
    if (!req.counterparty) req.counterparty = req.orderQuote;
  }
  // THE ORDER DEADLINES ALSO GO INTO THE QUOTE: the deadline guards (preflight -> deadlineVerdict) read readyBy/t1
  // FROM THE QUOTE, not from the terms. The values are THE SAME as those that went into order - no second count
  // and no second opinion; otherwise the core honestly refuses with deadline { kind: "deadlines-unstated" }.
  req.quote = { ...(req.quote || {}), readyBy: Number(req.order.readyBy), t1: Number(req.order.t1) };
  return ctx.sdk.swaps.start(req);
}

// WATCHING THE XMR ARRIVAL - THE SAME CORE STEP AS THE START (GET /api/swaps/{id}). The separate function is
// needed by state screens: they wait for the arrival rather than starting a swap. The order expectations and the
// wallet are passed by the caller - without them the core does not sign the readiness mark, only names its next step.
export async function sdkWatchSwap(request) {
  const ctx = await instanceFor(request && request.chain);
  if (!ctx) return null;
  return ctx.sdk.swaps.watch(request);
}

// --- THE DEAL LIST FROM THE CORE (the #/swaps screen) ---------------------------------------------
// READING, MERGING AND DROPPING GO THROUGH THE CORE, NOT THE ENGINE ON THE PAGE. sdkListSwaps above returns
// deal states (swaps.list); below is the server list (swaps.sync: the path and merge rule live in the core) and
// record dropping (swaps.forget: it removes the record only here; the server and the contract keep everything).
// The core did not come up - null, and the console names the cause (see sdkBundle), not silence.
export async function sdkSyncSwaps(chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.sync() : null;
}

export async function sdkForgetSwap(id, chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.forget(id) : null;
}

// WATCHING AND PAGE READS - THROUGH THE SAME SEAM, UNDER THE FORMER NAMES. The screen declares the poll focus and
// reads the fee rate (the reference panel) HERE, not from core/ and evm/ directly. The names are left VERBATIM as
// the engine's (the same technique as markReadyOrder/claimOrder/refundOrder above): the screen changes the import
// SOURCE, not the call expression. The order state (orderStatus/orderDeadlines) is declared as functions above -
// the same reads, but the reading rules now live in the package.
export { setLiveFocus, cachedFeeRate, dealSwapIds, serverRestoreHeightFor, STEP_LABELS };

// THE ORDER STATE AND ITS DEADLINES - CHAIN READS WITH THE PAGE'S WALLET, BUT THROUGH THE CORE. The reading rules
// themselves (status()/t1()/termsHash()/readyBy() and answer parsing) moved into the package
// (sdk/src/swap-flow.mjs, the order.status/order.deadlines facade). The shim exposes them to the screen UNDER THE
// FORMER NAMES, and the reader wallet it hands the core is the same as for the order actions (optionsFor ->
// evmCall), so it reads the same wallet that will sign. The core did not load - a NAMED refusal, not an empty state.
export async function orderStatus(escrow) {
  const ctx = await instanceFor(undefined);
  if (!ctx) throw new Error("[bridge] cannot read the order state: the SDK core was not served to the page");
  return ctx.sdk.order.status(escrow);
}

export async function orderDeadlines(escrow) {
  const ctx = await instanceFor(undefined);
  if (!ctx) throw new Error("[bridge] cannot read the order deadlines: the SDK core was not served to the page");
  return ctx.sdk.order.deadlines(escrow);
}

// THE MONERO NODE HEIGHT - A PAGE READ. The core has no node (all chain reads go through the page's wallet
// adapter), so the height for the scan height is taken here, not invented. The name is kept (nodeHeight).
export async function nodeHeight() { return nodeHeightValue(); }

// --- THE DEMO DEAL STATE AND ACTIONS (the progress screen, progress.js) ---------------------------
// THE STATE COMES FROM THE CORE: swaps.progress assembles a deal snapshot (record + state output + wallet from halves).
// The screen has NO former engine road (unlike the order actions above): the core did not come up - null, and the
// screen honestly says there is no state. The list screen is built the same way (sdkListSwaps).
export async function sdkProgress(id, chainSlug) {
  const ctx = await instanceFor(chainSlug);
  return ctx ? ctx.sdk.swaps.progress(id) : null;
}

// THE DEMO DEAL ACTIONS AND RECORD - through the core, with the former engine call as a fallback: they are THE SAME
// functions (sdk/src/swaps.mjs calls engine.swap.*). The names are the core's (swaps.confirmReady/refundEth/sweepNow/
// setDestination), not the screen's call strings.
export async function sdkConfirmReady(id) {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.confirmReady(id);
  return engineConfirmReady(id);
}

export async function sdkRefundEth(id, by = "you") {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.refundEth(id, by);
  return engineRefundEth(id, by);
}

export async function sdkSweepNow(id) {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.sweepNow(id);
  return engineSweepNow(id);
}

export async function sdkSetDestination(id, address) {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.setDestination(id, address);
  const swap = engineGetSwap(id);
  if (!swap) return null;
  swap.receiveAddress = address;
  return engineSaveSwap(swap);
}

// THE MONERO ADDRESS NETWORK - A CORE SURFACE (it owns the address format): the shim only exposes it to the screen.
// The fallback is the same module that mirrors the core (www/js/monero/address.js): there is no second prefix table.
export async function sdkAddressNetwork(address) {
  const ctx = await instanceFor(undefined);
  if (ctx) return ctx.sdk.swaps.addressNetwork(address);
  try { return networkFromShape(address); } catch { return null; }
}

// --- THE PAGE SHOWCASE AND MECHANISMS: FORM, SIGNING, SALE, FOUNDATION ----------------------------
// HERE LIVES WHAT SCREENS TOOK FROM THE ENGINE DIRECTLY and now take through THE SAME SEAM - under the same names.
// This is deliberately kept and named, not forgotten:
//   * evm, swapCore, moneroNode - PAGE mechanisms: the wallet (signing is possible only in its provider),
//     the deal digest and the poll tick, reads and polling of the Monero node (the core has no node);
//   * prices, fees, gas and the form's DEX leg - SHOWCASE: the numbers are read from the chain by engine
//     modules, and the screen gets them through the seam, not by a second road into the engine;
//   * networkFromShape/networkLabel - the Monero address shape and its name: the same format module the core
//     mirrors (there is no second prefix table);
//   * createOrderWorker - the atomic-swap halves worker: the cryptography lives in one place and is called by a
//     worker so the main thread does not freeze;
//   * createSwap/createReverseSwap/activeSwaps - the RECORD of the demo and reverse deal (the record is kept by
//     the engine; the core exposes its STATE via swaps.list/swaps.progress).
//   * createSwapWallet - THE FORM'S DEAL WALLET (state between screens, ui/formState.js): the page wallet with
//     its own keys. The core does not need it, so the seam exposes it with the same import as the rest.
// THE NAME IS TAKEN FROM THE ENGINE HERE (by import) AND EXPOSED OUTWARD (by export) - one seam, one copy. No
// new rule here: the screen changes the import source, not the call expression.
import { networkLabel, probeMode, createSwapWallet } from "../monero/wallet.js";
import { amountInputValue } from "../evm/amounts.js";
import { refreshChainPrices, priceLabel } from "../evm/prices.js";
import { orderGasReservePlan } from "../evm/gasReserve.js";
import { quoteDexOut, dexLegVerdict } from "../evm/dex.js";
import { toWei } from "../evm/funding.js";
import { cachedFeeTerms, feeWeiFor, ensureFeeTerms } from "../evm/fees.js";
import { createOrderWorker } from "../atomic/order-client.js";
import { activeSwaps, createSwap, createReverseSwap } from "../core/swap.js";

export { evm, networkFromShape };
export * as swapCore from "../core/swap.js";
export * as moneroNode from "../monero/node.js";
export { networkLabel, probeMode, createSwapWallet, amountInputValue, refreshChainPrices, priceLabel, orderGasReservePlan, quoteDexOut, dexLegVerdict, toWei, cachedFeeTerms, feeWeiFor, ensureFeeTerms, createOrderWorker, activeSwaps, createSwap, createReverseSwap };

