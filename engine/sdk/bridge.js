// THE PAGE-TO-CORE SHIM: THE ONE PLACE WHERE SCREENS KNOW ABOUT THE SDK (sdk/).
//
// WHY IT EXISTS. The swap logic lives in the core (sdk/, the @ninsei-labs/sdk package) while the page should do
// only markup, screen state and texts. Before this shim every screen called the engine itself and the logic
// spread across two places. Now a screen calls the SHIM, and only it knows about the core.
//
//
// WHAT THE SHIM PASSES TO THE CORE - exactly the seams the core asks for from outside and cannot get itself:
//   storage    - the page's storage: deals and session are read from where the page puts them (core/store.js);
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
import * as evm from "../evm/index.js";
// ORDER TERMS FOR THE CORE ARE ASSEMBLED FROM DATA, NOT FROM RULES: the windows come from the finality policy
// (core/finality.js), the salt from the engine's generator (evm/funding.js). No deadlines or numbers of its own here.
import { orderWindows } from "../core/finality.js";
import { newSecret } from "../evm/funding.js";
// THE ORDER CALLS - ACTION AND READ - COME FROM THE CORE. The deal engine moved into the package, and the shim
// exposes EXACTLY the same names (markReadyOrder/claimOrder/refundOrder/orderStatus/orderDeadlines), so a screen
// changes only the import source, not the call expression - and the guard that fixes the call site sees the old call.
//
// THE DEAL LIST AND ITS UPKEEP (the #/swaps screen). States come from the CORE: swaps.list - display, swaps.forget -
// dropping a record. The core needs only the page's storage, and the shim adds no rules of its own.
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

// THE CORE ADDRESS AS A STRING - THE BUILT BUNDLE SHIPPED WITH THE PACKAGE. A relative URL resolves both in the
// published `engine/` tree and in the page that serves this shim from `www/js/sdk/`; ?v=<hash> keeps the cache fresh.
const SDK_BUNDLE = new URL("../../assets/vendors/sdk/sdk-browser.js?v=fa7dc71a", import.meta.url).href;

// A NAMED SEAM FOR CHECKS. The asynchronous path is driven against a
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
    xmrNetwork: (chain.monero && chain.monero.networkType) || MONERO.networkType,
    // NO BACKEND BY DEFAULT: a page that needs one passes its base explicitly.
    assetsBase: "/",
    mode: modeOf(chain),
    // THE PAGE STORAGE BECOMES THE CORE STORAGE: deal records and the session live in one place.
    storage: pageStorage(),
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
  // THE SIGNED QUOTE COMES FROM THE RELAY PATH AND IS PASSED IN. There is no direct node call to fetch one here:
  // a start without `orderQuote` reaches the lock without a signed set and the core refuses it.
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
// deal states (swaps.list) and record dropping (swaps.forget: it removes the record only here; the server and
// the contract keep everything).
// The core did not come up - null, and the console names the cause (see sdkBundle), not silence.
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
// The fallback is the same address module the SDK uses (engine/monero/address.js): there is no second prefix table.
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
//   * networkFromShape/networkLabel - the Monero address shape and its name: the same format module the SDK
//     uses (there is no second prefix table);
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
import { activeSwaps, createSwap, createReverseSwap } from "../core/swap.js";

export { evm, networkFromShape };
export * as swapCore from "../core/swap.js";
export * as moneroNode from "../monero/node.js";
export { networkLabel, probeMode, createSwapWallet, amountInputValue, refreshChainPrices, priceLabel, orderGasReservePlan, quoteDexOut, dexLegVerdict, toWei, cachedFeeTerms, feeWeiFor, ensureFeeTerms, activeSwaps, createSwap, createReverseSwap };

