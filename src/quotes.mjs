// FIRM QUOTES THROUGH A RELAY: the SDK's only quote path.
//
// The old direct node client is gone with its routes. A quote now starts from one recovery key, goes through a
// relay, and comes back as a signed order quote plus the maker's view half. Every check that used to guard the
// direct answer - the signature, the registry/provider binding, the cashier pin, the factory and implementation
// code, the claim tip - still runs here, against the same signed fields.
import { fail } from "./errors.mjs";
import * as engine from "./engine.mjs";
import { claimGasGiftWei } from "../engine/evm/claimGas.js";
import { takerHalvesV2, recoverySaltOf } from "./recovery-key.mjs";
import { acceptCounterpartyChunked, buildOwnSideFromHalvesChunked, jointAddress } from "./order.mjs";
import { requestFirmQuote } from "./relayFirmClient.mjs";
import { predictEscrow } from "./predictEscrow.mjs";
import { readReadyWindow } from "./readyWindow.mjs";
import { quoteLifeVerdict } from "./quotePolicy.mjs";
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

// THE CASHIER IS THE NETWORK'S VAULT, NOT A FIELD THE MAKER MAY CHOOSE. The escrow binds it at birth, but the
// client must refuse an answer before it funds or sends XMR: a look-alike vault with the canonical runtime and
// crafted storage would pass the escrow's code check and make every claim revert after the payout.
const pinnedCashier = (config) => {
  const chain = config && config.settlement && config.settlement.chain;
  const value = chain && chain.escrow && chain.escrow.cashier;
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
};
const requirePinnedCashier = (quote, step, config) => {
  const chain = config && config.settlement && config.settlement.chain;
  const pin = pinnedCashier(config);
  // A caller without a network profile has nothing to compare against. A profile that names a chain but no vault
  // is a broken profile, not a free pass: refuse it before a quote can be funded.
  if (!pin && !chain) return;
  const got = String(quote && quote.cashier || "").toLowerCase();
  if (!pin) fail("quote-cashier-mismatch", { step, why: "no-pinned-cashier", got: got || null });
  if (got !== pin) fail("quote-cashier-mismatch", { step, got: got || null, want: pin });
};


/**
 * A CLAIM TIP IS SIZED BY THE CLAIM, NOT BY THE MAKER'S MOOD. The node's own estimate uses the chain's current
 * base fee and the same formula; a quote may carry up to twice that estimate (gas moves between the sizing and
 * the check). Zero is the buy side and is always allowed. An unmeasured base fee is a refusal, not a free pass.
 */
/**
 * THE PRIORITY FEE OF A BLOCK, FROM ONE RULE. An explicit priority field wins; a plain RPC block may carry only
 * `gasPrice`, so the priority is the part above the base fee. No block or no readable pair means zero - the
 * caller then uses the base fee alone, which is the old, stricter behaviour.
 */
const priorityFeeOfBlock = (block) => {
  if (!block || typeof block !== "object") return 0n;
  const explicit = block.priorityFeePerGas !== undefined && block.priorityFeePerGas !== null
    ? block.priorityFeePerGas
    : (block.maxPriorityFeePerGas !== undefined && block.maxPriorityFeePerGas !== null
      ? block.maxPriorityFeePerGas : null);
  if (explicit !== null) return explicit;
  const base = block.baseFeePerGas !== undefined ? block.baseFeePerGas : block.baseFeeWei;
  if (block.gasPrice === undefined || block.gasPrice === null || base === undefined || base === null) return 0n;
  try {
    const gas = BigInt(block.gasPrice);
    const baseValue = BigInt(base);
    return gas > baseValue ? gas - baseValue : 0n;
  } catch { return 0n; }
};

export const claimPriorityFeeOfBlock = priorityFeeOfBlock;

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

export function createQuotes({ config, now = () => Date.now(), evmCall = null, evmCode = null, evmBlock = null,
  providerAllowed = null, knownFactoryCodes = null, knownImplementationCodes = null, denylist = null, fetchImpl = null }) {
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
  return {
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
      // THE REGISTRY IS A PROPERTY OF THE NETWORK, NOT OF THE FEATURES THAT ARRIVED WITH THE QUOTE. A relay that
      // names its own registry can authorise its own maker. The pinned value comes from the network config; a
      // network without a pinned registry keeps the old path until it is deployed.
      const pinnedRegistry = config && config.settlement && config.settlement.chain &&
        config.settlement.chain.escrow && config.settlement.chain.escrow.registry;
      if (pinnedRegistry && !sameText(registry, pinnedRegistry)) {
        fail("bad-input", { field: "features.registry", why: "not-the-network-registry" });
      }
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
      // THE CLIENT'S OWN ADDRESS IS WHAT THE DENYLIST COVERS. On an ask that is the locker; on a bid the client
      // is the claimer, and testing the maker's locker there checks the wrong party.
      const deniedAddress = side === "bid" ? order.claimer : order.locker;
      if (denylist && typeof deniedAddress === "string" && denylist.has(deniedAddress.toLowerCase())) {
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
      const readyWindow = readReadyWindow(window, { side, field: "features.firmWindows" });
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
      if (!order.factory || !/^0x[0-9a-f]{40}$/i.test(String(order.factory))) fail("bad-input", { field: "order.factory" });
      let salt = null;
      try { salt = recoverySaltOf(saltRequested ? request.recoverySalt : order.salt); }
      catch { fail("bad-input", { field: "recoverySalt" }); }
      if (saltRequested) {
        let orderSalt = null;
        try { orderSalt = recoverySaltOf(order.salt); } catch { fail("bad-input", { field: "recoverySalt", why: "order-salt" }); }
        if (salt !== orderSalt) fail("bad-input", { field: "recoverySalt", why: "order-salt" });
      }
      const derived = takerHalvesV2({ mnemonic, chainId, factory: order.factory, salt });
      const derivation = { kind: "salt-v2", salt };
      const own = await buildOwnSideFromHalvesChunked(order, { spendHalf: derived.spendHalf, viewHalf: derived.viewHalf });
      const xa = secp256k1.Point.fromHex(own.side.proof.XA);
      const clientHalf = {
        commitHalf: bytesToHexQ(keccak256(xa.toBytes(false).slice(1))),
        edPoint: own.side.pub.ed,
        proof: own.side.proof,
      };
      const result = await requestFirmQuote({
        relayUrl: request.relayUrl,
        partner: request.partner,
        fetchImpl: request.fetchImpl || fetchImpl,
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
        clientViewScalar: derived.viewHalf,
        side,
      });
      const quote = result.quote;
      requirePinnedCashier(quote, "relay", config);
      // THE NODE HALF IS NOT A DECORATION. The answer's proof must stand in THIS order's context and the proven
      // point must be the one the quote commits to. For ask that is the claimer's commitment; for bid the node
      // half is the locker's and carries its own commitment. This is the same engine check the swap path uses.
      const nodeHalf = result.nodeHalf;
      await acceptCounterpartyChunked({
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
        escrow = await predictEscrow({ quote: result.orderQuote, lockerHalf, call: evmCall });
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
        const priorityFeeWei = priorityFeeOfBlock(block);
        const verdict = claimTipVerdict({ claimTipWei: quote.claimTip, baseFeeWei, priorityFeeWei });
        if (!verdict.ok) fail(verdict.code, { step: "claimTip", ...verdict });
      }
      // THE SIGNED XMR AMOUNT TRAVELS WITH THE ORDER TERMS. `swaps.start` records its order as given, and the
      // arrival check must compare the exact amount signed in the quote - not the display size, which the relay
      // answer does not carry at all.
      const signedAtomic = result.orderQuote && result.orderQuote.xmrAmount !== undefined && result.orderQuote.xmrAmount !== null
        ? String(result.orderQuote.xmrAmount) : null;
      if (!signedAtomic) fail("quote-field-unbound", { step: "xmrAmount", field: "orderQuote.xmrAmount" });
      // THE ANSWER IS ALSO A START REQUEST. `swaps.start` reads the paying asset from the quote; the relay answer
      // carried only the signed order terms, so a caller that followed the guide reached `balance-unchecked`.
      // The asset is display metadata here; the signed `orderQuote` is unchanged.
      const marketAsset = request.market && String(request.market).includes(":")
        ? String(request.market).split(":").slice(1).join(":") : null;
      const asset = String(order.asset || marketAsset || "").trim();
      // THE LIFE CHECK RUNS AFTER ALL THE WORK THE ANSWER NEEDS. The proof, the predict and the registry reads
      // happen first; a quote that had 31 s on arrival has less by now, and showing a confirmation would waste the
      // person's time only to refuse at the lock. A sell (bid) is checked by its own expiry alone: its escrow is
      // already funded, so there is no local lock to prepare and no margin to reserve.
      const answerNowSec = Math.floor(Number(now()) / 1000);
      const life = quoteLifeVerdict({ validUntil: quote.validUntil, nowSec: answerNowSec, side });
      if (!life.ok) {
        fail("quote-too-short", { step: "answer", side,
          validUntil: Number.isFinite(Number(quote.validUntil)) ? Number(quote.validUntil) : null,
          now: answerNowSec, remainingSec: life.remainingSec, marginSec: life.marginSec,
          prepSec: life.prepSec, confirmBySec: life.confirmBySec });
      }
      const startQuote = { ...quote, viewHalfClaimer: derived.makerViewHalf, xmrAmount: signedAtomic, readyWindow,
        escrow, remainingSec: life.remainingSec, confirmBySec: life.confirmBySec,
        ...(asset ? { asset, token: asset.toLowerCase() } : {}),
        // A STABLE ID FOR THE PENDING-FUNDING RECORD. The signed nonce is the one value every relay answer carries.
        ...(quote.nonce !== undefined && quote.nonce !== null ? { id: String(quote.nonce) } : {}) };
      const startCounterparty = {
        proof: nodeHalf.proof,
        edPointClaimer: side === "ask" ? quote.edPointClaimer : nodeHalf.edPoint,
        commitHalfClaimer: side === "ask" ? quote.commitHalfClaimer : nodeHalf.commitHalf,
        viewHalfClaimer: derived.makerViewHalf,
        viewPoint: side === "ask" ? result.edViewPointClaimer : result.edViewPointLocker,
      };
      // ONE ORDER OBJECT, TWO REFERENCES. `order` and `startRequest.order` must not drift apart.
      const startOrder = { ...order, xmrAmount: signedAtomic };
      return {
        ...result,
        quote: startQuote,
        order: startOrder,
        // THE NODE'S WINDOW TRAVELS WITH THE ANSWER, SO A SALE CAN USE THE SAME NUMBERS THE MAKER SIGNED.
        readyWindow,
        // THE CALLER ADDS ITS WALLET, `receiveTo` AND THE HEIGHT; everything the relay can know is here.
        startRequest: {
          quote: startQuote,
          order: startOrder,
          orderQuote: result.orderQuote,
          counterparty: startCounterparty,
          recoveryKey: request.recoveryKey,
          recoverySalt: order.salt,
          escrow,
        },
        remainingSec: life.remainingSec,
        confirmBySec: life.confirmBySec,
        // THE SHAPE `swaps.start` TAKES: the proof and the claimer commitment travel with the view half, so a
        // caller can pass this object as `counterparty` without rebuilding the relay fields.
        counterparty: startCounterparty,
        viewHalfClaimer: derived.makerViewHalf,
        viewHalfPoint: derived.makerViewPoint,
        jointAddress: oneTimeAddress.address,
        escrow,
        recovery: derivation,
      };
    },
  };
}
