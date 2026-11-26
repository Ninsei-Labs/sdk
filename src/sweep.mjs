// XMR WITHDRAWAL: PARSING THE FILE AND PREPARING. The withdrawal itself requires a Monero wallet - it arrives as
// an adapter.
//
// Here is exactly what the sweep page does before syncing: decrypt the recovery file, validate it, take the shared
// address, ask the app for the restore height (on the page it is taken by address) and say aloud what is missing
// so the withdrawal can go. Funds do not move at this step.
import { SdkError } from "./errors.mjs";
import { checkAddressOrThrow } from "./addressGuard.mjs";
import { assertSameKeyImages, normalizeKeyImages, signedKeyImages } from "./sweep-inputs.mjs";
import { actionMaterialOf } from "./sweep-action.mjs";
import { primitives } from "./primitives.mjs";
import * as engine from "./engine.mjs";
import { restoreWallet } from "./sweep-restore.mjs";
import { moneroWalletAdapter } from "./adapters/monero-wallet.mjs";
import { checkDestination } from "./destination.mjs";
import { readWithdrawalState } from "./xmr-arrival.mjs";
import { reconcileVerdict } from "./sweep-reconcile.mjs";
import { revealedHalfWord } from "./sweep-half.mjs";
import { takerHalvesV2 } from "./recovery-key.mjs";
import { jointAddress } from "./order.mjs";
import { formatXmr } from "../engine/core/xmrAmount.js";
import { keyImageFromOutput } from "../engine/monero/keyImage.js";

// THE XMR AMOUNT IS PART OF THE RECOVERY FILE. A found order carries the amount the provider signed, in atomic
// units; the file keeps it in whole XMR, the unit every other payload user reads. An order without the amount
// stays null rather than silently falling back to the ETH side or to zero.
const xmrAmountOf = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (/^\d+$/.test(text)) return formatXmr(BigInt(text));
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? text : null;
};

// The same boundary as when the file was issued: a passphrase shorter than twelve characters will not open the file.
const MIN_PASSPHRASE = 12;
const STEPS = ["unlock", "sync", "sweep", "relay"];

// The transaction ids the signed set can name before the wallet answers. They are a hint for the caller's chain
// check, not proof that a relay happened.
const txidsOf = (signed) => {
  const list = Array.isArray(signed) ? signed : (signed === null || signed === undefined ? [] : [signed]);
  const ids = [];
  for (const tx of list) {
    let id = null;
    try {
      id = tx && typeof tx.getHash === "function" ? tx.getHash()
        : (tx && (typeof tx.hash === "string" ? tx.hash : (typeof tx.txid === "string" ? tx.txid : null)));
    } catch { id = null; }
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
};

// A NODE MUST NOT BE ABLE TO SET THE WITHDRAWAL FEE. The node's estimate reaches the SDK through the wallet,
// and an untrusted node can answer with most of the balance. The absolute ceiling is deliberately far above a
// normal priority fee (0.01 XMR) while still rejecting a percentage-sized charge. A caller that needs another
// ceiling can pass `maxFeeAtomic` explicitly.
export const MAX_SWEEP_FEE_ATOMIC = 10_000_000_000n; // 0.01 XMR

export function sweepFeeVerdict({ feeAtomic = null, amountAtomic = null, maxFeeAtomic = MAX_SWEEP_FEE_ATOMIC } = {}) {
  if (feeAtomic === null || feeAtomic === undefined) {
    // A FEE THAT WAS NOT REPORTED IS NOT A FREE WITHDRAWAL. The ceiling cannot be applied to an unknown number;
    // the page must show the refusal instead of a withdrawal whose cost is invisible.
    return { ok: false, code: "sweep-fee-unknown", checked: false, fee: null, limit: String(maxFeeAtomic) };
  }
  let fee;
  let amount;
  let limit;
  try { fee = BigInt(feeAtomic); amount = amountAtomic === null || amountAtomic === undefined ? null : BigInt(amountAtomic); limit = BigInt(maxFeeAtomic); }
  catch { return { ok: false, code: "sweep-fee-too-high", why: "unreadable", fee: String(feeAtomic), limit: String(maxFeeAtomic) }; }
  if (fee < 0n || limit < 0n) return { ok: false, code: "sweep-fee-too-high", why: "negative", fee: fee.toString(), limit: limit.toString() };
  if (fee > limit) return { ok: false, code: "sweep-fee-too-high", why: "ceiling", fee: fee.toString(), limit: limit.toString(), amount: amount === null ? null : amount.toString() };
  return { ok: true, checked: true, fee: fee.toString(), limit: limit.toString(), amount: amount === null ? null : amount.toString() };
}
// `revealedHalf()` on the escrow. Public data: the function returns the half the settlement published.
const REVEALED_HALF_SELECTOR = "0x3f267bb6";

const contentsOf = (file) => (typeof file === "string" ? file : file && typeof file.contents === "string" ? file.contents : null);

const bare = (value) => String(value == null ? "" : value).replace(/^0x/i, "").toLowerCase();

// THE JOINT VIEW SECRET IS A SUM, IN MONERO'S BYTE ORDER. The two halves are independent scalars of the same
// address; the sum is what a wallet watches with. `sweep.keys` returns it little-endian after the spend half is
// revealed, so this path must use the same notation before any reveal.
const moneroScalarHex = (value) =>
  BigInt(value).toString(16).padStart(64, "0").match(/../g).reverse().join("");

// A FOUND ORDER AND THE KEY, WITHOUT A FILE. The recovery page used to write the order into the SDK's own payload
// (buildPayload) in memory; that rule belongs here, next to the withdrawal it feeds. The page keeps the order and
// the key; this function decides which side is the person, checks the chain's points against the key, builds the
// joint address and returns the same payload a recovery file would carry.
const payloadFromOrder = async (request) => {
  const order = request && request.order;
  if (!order || typeof order !== "object") throw new SdkError("bad-input", { field: "order" });
  if (typeof request.mnemonic !== "string" || !request.mnemonic.trim()) throw new SdkError("bad-input", { field: "mnemonic" });
  const chainId = Number(request.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new SdkError("bad-input", { field: "chainId" });
  const network = typeof request.network === "string" ? request.network.trim() : "";
  const moneroNetwork = typeof request.moneroNetwork === "string" ? request.moneroNetwork.trim() : "";
  if (!network) throw new SdkError("bad-input", { field: "network" });
  if (!moneroNetwork) throw new SdkError("bad-input", { field: "moneroNetwork" });
  const passphrase = typeof request.passphrase === "string" ? request.passphrase : "";
  if (passphrase && passphrase.length < MIN_PASSPHRASE) {
    throw new SdkError("bad-input", { field: "passphrase", min: MIN_PASSPHRASE });
  }

  const side = order.side === "locker" ? "buy" : order.side === "claimer" ? "sell" : null;
  if (!side) throw new SdkError("bad-input", { field: "order.side" });
  // TWO DERIVATIONS, BOTH LIVE. A v1 order has an index; a v2 order has the public salt from OrderCreated and
  // the factory in its binding. The page may hand either shape back; reading `index` from a v2 order would invent
  // a number and rebuild the wrong address.
  // ONE DERIVATION. An order without the factory and salt of its OrderCreated event is not an order this key can
  // rebuild; there is no index branch left to guess from.
  if (typeof order.factory !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(order.factory)) {
    throw new SdkError("bad-input", { field: "order.factory" });
  }
  const halves = takerHalvesV2({ mnemonic: request.mnemonic, chainId, factory: order.factory, salt: order.salt });
  const buy = side === "buy";
  if (bare(buy ? order.edPointLocker : order.edPointClaimer) !== bare(halves.spendPoint)) {
    throw new SdkError("bad-input", { field: "order", why: "spend-point" });
  }
  if (bare(order.edViewPointLocker) !== bare(buy ? halves.viewPoint : halves.makerViewPoint)) {
    throw new SdkError("bad-input", { field: "order", why: buy ? "own-view-point" : "maker-view-point" });
  }

  const otherSpendPoint = "0x" + bare(buy ? order.edPointClaimer : order.edPointLocker);
  const otherViewPoint = "0x" + bare(halves.makerViewPoint);
  const joint = jointAddress({
    ownSpendHalf: halves.spendHalf, ownViewHalf: halves.viewHalf,
    otherSpendPoint, otherViewPoint, network: moneroNetwork,
  });
  // THE SIGNED XMR AMOUNT TRAVELS WITH THE ESCROW. A recovery file rebuilt from the chain must compare the
  // arrival against the exact integer the order carries, not against the rounded display number.
  const signedAtomic = (() => {
    try {
      const atomic = BigInt(String(order.xmrAmount));
      return atomic > 0n ? atomic.toString() : null;
    } catch { return null; }
  })();
  const escrow = { address: order.escrow, readyBy: order.readyBy, t1: order.t1,
    ...(signedAtomic ? { expectedAtomic: signedAtomic } : {}) };
  const payload = engine.recoveryFile.buildPayload({
    swap: {
      id: order.escrow, side, network, moneroNetwork,
      createdAt: order.blockTime ? Number(order.blockTime) * 1000 : null,
      payToken: null, payAmount: null, xmrAmount: xmrAmountOf(order.xmrAmount), rate: null, maker: null, quoteSignature: null,
      escrow, timeline: null,
    },
    swapWallet: {
      source: "halves", network: moneroNetwork, address: joint.address,
      spendHalf: halves.spendHalf, viewHalf: halves.viewHalf,
      otherSpendPoint, otherViewPoint, otherViewHalf: halves.makerViewHalf,
      escrowAddress: order.escrow,
    },
    escrow,
    receiveAddress: null,
    restoreHeight: Number(order.startHeight) > 0 ? Number(order.startHeight) : null,
  });
  // THE ETH ACTION MATERIAL COMES FROM THE SAME DERIVATION. The half and the order expectations are what
  // `actions.refund` / `actions.claim` need; returning them here keeps the page from rebuilding the order fields.
  // A found order from `findSwaps` carries every field; an incomplete order is refused before a half can be used.
  const action = actionMaterialOf({ order, chainId, half: halves.spendHalf });
  const viewSecret = moneroScalarHex(engine.halves.createHalves(primitives)
    .combineHalves(BigInt(halves.viewHalf), BigInt(halves.makerViewHalf)));
  return {
    payload,
    contents: await engine.recoveryFile.createRecoveryFile(payload, passphrase),
    address: joint.address,
    viewSecret,
    ...action,
  };
};

// A LOW-LEVEL WALLET ERROR IS STILL A REFUSAL, AND EVERY REFUSAL CARRIES A CODE.
//
// The library brings its own exceptions with no code at all - monero-ts answers "failed to get hashes" while
// scanning, and lets it out as a bare `Error`. Releasing one turns a named refusal into `code: null` + raw
// text: the interface cannot translate it (it has no phrase to look up) and a check cannot assert it. So a
// wallet step that fails with anything but an SdkError is re-thrown as one, on a code from the package's own
// dictionary, with the library's message kept as a detail.
const walletStep = async (surface, step) => {
  try {
    return await step();
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError("wallet-rejected", { surface, why: String((error && error.message) || error) });
  }
};

// THE FEE A WALLET REPORTS FOR A SIGNED TRANSACTION. Optional on purpose: the adapter contract does not require
// it, and an adapter without it is not broken - the answer is simply unknown. The library's own shape is tried
// (`getFee()` on the transaction or on the signed wrapper), because that is what monero-ts returns; a value that is
// not a non-negative integer string is refused as unknown rather than trusted.
const feeOf = async (wallet, signed) => {
  if (!wallet || typeof wallet.fee !== "function") return null;
  let value;
  try {
    value = await wallet.fee(signed);
  } catch {
    return null;
  }
  if (value === null || value === undefined) return null;
  const text = String(value);
  return /^\d+$/.test(text) ? text : null;
};

export function createSweep({ call = null, fetchImpl = null } = {}) {
  // THE NAME IS NEEDED BY THE OBJECT ITSELF: `run` calls `api.plan(...)` - the step order is held by the plan and
  // the withdrawal living in one object, not in two copies. During a manual merge of branches the object was left
  // unnamed, and the withdrawal failed with "api is not defined": not a refusal, but a breakdown. `node --check`
  // misses this, there are no conflict markers in the file - only a run shows it.
  // AN OPEN SIGN SESSION: a token -> { wallet, plan, signed }. It lives until `relay`; it keeps no keys - they are
  // owned by the library's wallet.
  const sessions = new Map();
  let sessionSeq = 0;
  // THE SCAN THAT PRECEDED SIGNING. `sweep.restore` records its own answer against the exact wallet adapter that
  // performed it; `sign` accepts only a complete scan from that same adapter. This is what keeps a stale or partial
  // restore from becoming a signature, without adding a caller-supplied boolean that a page could forget or forge.
  const scans = new WeakMap();

  // THE NETWORK NAME MONERO-TS TAKES. The adapter speaks a string ("stagenet") because that is what a node says and
  // what a human reads; the library wants its own enum. That translation used to be a callback on the sweep page -
  // the last thing a caller had to know about the library to open a wallet.
  const NETWORK_ENUM = { mainnet: "MAINNET", stagenet: "STAGENET", testnet: "TESTNET" };

  const api = {
    // BUILD THE WITHDRAWAL MATERIAL FROM A FOUND ORDER AND THE KEY. No recovery file, no temporary payload in the
    // page: the returned `contents` is the same file `plan`/`keys` already accept, and `payload` is for callers
    // that want the fields directly.
    async fromOrder(request = {}) {
      return await payloadFromOrder(request);
    },

    // BUILD THE WITHDRAWAL WALLET from the library namespace the caller has. The page used to pass a `createWallet`
    // callback that mapped the enum itself; that mapping is here now, so a caller passes `moneroTs` and the keys.
    wallet(request = {}) {
      const moneroTs = request.moneroTs;
      if (!moneroTs || typeof moneroTs !== "object") throw new SdkError("bad-input", { field: "moneroTs" });
      if (typeof moneroTs.createWalletFull !== "function") throw new SdkError("bad-input", { field: "moneroTs.createWalletFull" });
      const network = String(request.network || "").trim().toLowerCase();
      const enumName = NETWORK_ENUM[network] || null;
      const enumValue = enumName && moneroTs.MoneroNetworkType ? moneroTs.MoneroNetworkType[enumName] : undefined;
      if (enumValue === undefined || enumValue === null) {
        throw new SdkError("bad-input", { field: "network", known: Object.keys(NETWORK_ENUM), got: request.network });
      }
      if (typeof request.serverUri !== "string" || !request.serverUri) throw new SdkError("bad-input", { field: "serverUri" });
      return moneroWalletAdapter({
        createWallet: (config) => moneroTs.createWalletFull({ ...config, networkType: enumValue }),
        network,
        serverUri: request.serverUri,
        password: request.password,
        keys: request.keys || {},
        restoreHeight: request.restoreHeight,
        expectedAddress: request.expectedAddress || null,
      });
    },

    // WHERE THE WITHDRAWAL GOES. The file names the recipient the swap was made for; this compares the address the
    // person typed with that promise and with the file's network. `matches` is null when the file named nobody -
    // that is not a failure, it is an absence the caller can phrase.
    async destination(request = {}) {
      const contents = contentsOf(request.file);
      if (!contents) throw new SdkError("bad-input", { field: "file" });
      if (typeof request.passphrase !== "string") throw new SdkError("bad-input", { field: "passphrase" });
      if (typeof request.dest !== "string" || !request.dest.trim()) throw new SdkError("bad-input", { field: "dest" });
      let payload = null;
      try { payload = await engine.recoveryFile.decryptFile(JSON.parse(contents), request.passphrase); }
      catch { throw new SdkError("recovery-failed", { step: "decrypt" }); }
      try { engine.recoveryFile.validatePayload(payload); }
      catch { throw new SdkError("recovery-failed", { step: "validate" }); }
      return checkDestination(payload, request.dest);
    },

    async plan(request) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      const contents = contentsOf(request.file);
      if (!contents) throw new SdkError("bad-input", { field: "file" });
      // EMPTY IS ALLOWED: it opens an unencrypted file. A non-empty one keeps the floor.
      if (typeof request.passphrase !== "string" || (request.passphrase.length > 0 && request.passphrase.length < MIN_PASSPHRASE)) {
        throw new SdkError("bad-input", { field: "passphrase", min: MIN_PASSPHRASE });
      }

      let envelope = null;
      try { envelope = JSON.parse(contents); } catch { throw new SdkError("recovery-failed", { step: "parse" }); }
      let payload = null;
      try { payload = await engine.recoveryFile.decryptFile(envelope, request.passphrase); } catch { throw new SdkError("recovery-failed", { step: "decrypt" }); }
      // We check the composition BEFORE the work: a file that does not pass its own check is not good for withdrawal.
      try { engine.recoveryFile.validatePayload(payload); } catch { throw new SdkError("recovery-failed", { step: "validate" }); }

      const wallet = payload.moneroWallet || {};
      const address = wallet.address || null;
      if (!address) throw new SdkError("recovery-failed", { step: "address" });

      const missing = [];
      // WHAT WE CAN DISPOSE OF: our own half of the spend key. Without it the withdrawal is impossible under any
      // circumstances, and that must be said before syncing, not after.
      const spendable = !!wallet.spendHalf;
      if (!spendable) missing.push("spendable");

      // THE RESTORE HEIGHT COMES FROM THE FILE OR THE CHAIN. The SDK does not ask a service by address: a static
      // page and a widget must not tell their own host which deal they are recovering. A missing height is named in
      // `missing`; the caller can pass one from `findSwaps` or the person can type it.
      let restoreHeight = Number(wallet.restoreHeight) || 0;
      if (!(restoreHeight > 0)) missing.push("restore-height");

      // THE COUNTERPARTY'S REVEALED HALF - FROM THE CALLER FIRST, THEN THE CHAIN. A caller that already read the
      // public half from `HalfRevealed` passes `revealedHalf`; the SDK must not name an escrow to its RPC just to
      // read the same value. Without it, the old chain read remains the fallback for a caller that has one.
      let revealed = false;
      let revealedValue = null;
      const escrowAddress = wallet.escrowAddress || (payload.escrow && payload.escrow.address) || null;
      const suppliedHalf = request.revealedHalf;
      if (suppliedHalf !== undefined && suppliedHalf !== null) {
        const half = revealedHalfWord(suppliedHalf);
        if (half === null) throw new SdkError("bad-input", { field: "revealedHalf", why: "not-a-half" });
        revealed = true;
        revealedValue = half;
      } else if (escrowAddress && typeof call === "function") {
        try {
          const word = String((await call({ to: escrowAddress, data: REVEALED_HALF_SELECTOR })) || "");
          const half = revealedHalfWord(word);
          if (half !== null) {
            revealed = true;
            revealedValue = half;
          }
        } catch { revealed = false; }
      }
      if (!revealed) missing.push("revealed-half");

      return {
        swapId: payload.swapId || null,
        address,
        // The Monero network is part of the destination check: a file's address and a recipient typed for another
        // network must not be treated as interchangeable.
        network: wallet.network || null,
        spendable,
        restoreHeight,
        steps: STEPS,
        // Whether the counterparty's half is revealed: this is a separate flag, not "absent from the missing list".
        revealedHalf: revealed,
        half: revealedValue,
        missing,
      };
    },

    // THE WITHDRAWAL KEYS. They are computed here and checked here too - for the reason that the contract cannot do
    // it: it will check the hash of the revealed half, but not the link "half and the point in the address" - there
    // is no ed25519 in EVM. So before syncing we must make sure that (s_a + s_b)*G matched the order's spend key. It
    // did not match - we must not send: the XMR would go nowhere, while it would look like success.
    async keys(request) {
      const plan = await api.plan(request);
      if (!plan.half) throw new SdkError("bad-input", { field: "revealedHalf", why: "not-revealed" });
      const contents = contentsOf(request.file);
      let payload = null;
      try { payload = await engine.recoveryFile.decryptFile(JSON.parse(contents), request.passphrase); }
      catch { throw new SdkError("recovery-failed", { step: "decrypt" }); }
      const wallet = payload.moneroWallet || {};
      const need = ["spendHalf", "viewHalf", "otherSpendPoint", "otherViewHalf"];
      const missingFields = need.filter((k) => wallet[k] === undefined || wallet[k] === null || wallet[k] === "");
      if (missingFields.length) throw new SdkError("bad-input", { field: "payload", missing: missingFields });
      try {
        const halves = engine.halves.createHalves(primitives);
        const keys = engine.halvesSweep.spendKeysFromRevealedHalf({
          halves,
          ownSpendHalf: wallet.spendHalf, ownViewHalf: wallet.viewHalf,
          otherSpendPoint: wallet.otherSpendPoint, otherViewHalf: wallet.otherViewHalf,
          revealedHalf: plan.half,
        });
        return { privateSpendKey: keys.privateSpendKey, privateViewKey: keys.privateViewKey, address: plan.address };
      } catch {
        // THE CHECK DID NOT PASS: the half is from another order or was substituted. This is a refusal with a code,
        // not an engine exception with text inside.
        throw new SdkError("bad-input", { field: "revealedHalf", step: "verify" });
      }
    },

    // THE KEY IMAGES OF THE VERIFIED FUNDING OUTPUTS. This is the wallet-free half of the spent check: the page
    // already has the spend key and the outputs from `verifyArrival` / `verifyRecovery`; a full monero-ts wallet
    // would have to download the block-hash history before it could answer the same question.
    //
    // EVERY OUTPUT MUST ALREADY BE VERIFIED. An amount the Pedersen commitment did not confirm is not a funding
    // output, and a key image for it would be a guess. Missing derivations are refused too: an older caller can
    // pass an arrival from a build before this field existed, and an empty answer would look like "nothing spent".
    async keyImages(request = {}) {
      const keys = request && request.keys;
      const arrival = request && request.arrival;
      if (!keys || typeof keys !== "object" || typeof keys.privateSpendKey !== "string") {
        throw new SdkError("bad-input", { field: "keys" });
      }
      if (!arrival || typeof arrival !== "object" || !Array.isArray(arrival.outputs) || !arrival.outputs.length) {
        throw new SdkError("bad-input", { field: "arrival.outputs" });
      }
      const seen = new Set();
      return arrival.outputs.map((output, position) => {
        if (!output || typeof output !== "object" || !Number.isSafeInteger(Number(output.index)) || Number(output.index) < 0) {
          throw new SdkError("bad-input", { field: "arrival.outputs", why: "index", position });
        }
        if (output.amountVerified !== true || output.amountAtomic === null || output.amountAtomic === undefined) {
          throw new SdkError("bad-input", { field: "arrival.outputs", why: "unverified", position });
        }
        if (typeof output.key !== "string" || typeof output.derivation !== "string") {
          throw new SdkError("bad-input", { field: "arrival.outputs", why: "derivation", position });
        }
        const id = String(output.key).replace(/^0x/i, "").toLowerCase() + ":" + Number(output.index);
        if (seen.has(id)) throw new SdkError("bad-input", { field: "arrival.outputs", why: "duplicate", position });
        seen.add(id);
        let keyImage;
        try {
          keyImage = keyImageFromOutput({
            outputKey: output.key, derivation: output.derivation, index: Number(output.index),
            privateSpendKey: keys.privateSpendKey,
          });
        } catch {
          throw new SdkError("bad-input", { field: "arrival.outputs", why: "key-image", position });
        }
        return { outputKey: String(output.key).replace(/^0x/i, "").toLowerCase(),
          amountAtomic: String(output.amountAtomic), keyImage };
      });
    },

    // THE PASS BEFORE SIGNING: set the height, rescan, sync, read the balance, and - when coins exist but none is
    // spendable - re-check the spent status once. The wallet is the same withdrawal adapter `sign` takes; the page
    // no longer decides when a second pass is needed.
    async restore(request) {
      const merged = { ...(request || {}) };
      if (merged.fetchImpl !== undefined && merged.fetchImpl !== null && typeof merged.fetchImpl !== "function") {
        throw new SdkError("bad-input", { field: "fetchImpl" });
      }
      // THE INSTANCE TRANSPORT REACHES THE WINDOW AND KEY-IMAGE READS TOO. A per-call `fetchImpl` still wins;
      // without this fallback a Tor/proxy caller's restore would silently use the page's global fetch.
      if (typeof merged.fetchImpl !== "function" && typeof fetchImpl === "function") merged.fetchImpl = fetchImpl;
      const result = await restoreWallet(merged);
      // A PARTIAL SCAN IS STILL RECORDED: `sign` must name why it refuses, not pretend no restore ever happened.
      // COPY THE VERDICT. The returned object belongs to the caller; keeping that reference would let a page flip
      // `scanComplete` after the fact and turn the guard off.
      if (merged.wallet && result && typeof result === "object") {
        scans.set(merged.wallet, {
          scanComplete: result.scanComplete === true,
          ...(result.scanIncompleteReason ? { scanIncompleteReason: result.scanIncompleteReason } : {}),
          walletHeight: result.walletHeight ?? null,
          nodeHeight: result.nodeHeight ?? null,
        });
      }
      return result;
    },

    // THE WITHDRAWAL ITSELF. The wallet arrives as an adapter (the WASM and the worker live with whoever builds the
    // page), while the core holds the order: open -> sync -> look at the free remainder -> SIGN (relay: false) ->
    // send -> close.
    //
    // SIGNING AND SENDING ARE DELIBERATELY SPLIT: between them the interface has time to show the person what will
    // leave, rather than telling them about it after sending. An empty remainder stops the withdrawal BEFORE
    // signing - otherwise the wallet would sign a transaction for zero and the refusal would look like success.

    // SIGNING WITHOUT SENDING - AS A SEPARATE STEP. The core HOLDS the signed transaction until the person's
    // decision: otherwise the interface could not show what exactly will leave, and would tell about it only after
    // sending. Here is the whole order UP TO AND INCLUDING SIGNING: plan -> wallet -> open -> free remainder
    // (an empty one STOPS the withdrawal with a code) -> sign (relay: false). The wallet stays open until `relay`,
    // and the session token is the only handle to it.
    //
    // THE FREE REMAINDER IS READ AND JUDGED BEFORE ANY INPUT SELECTION, AND A SYNC PASS IS NOT THE VERDICT.
    // The wallet library fails low-level while scanning a chain it cannot read (measured: monero-ts `sync()` against
    // a regtest node answering "failed to get hashes"), and that bare error used to escape BEFORE the remainder was
    // read - an empty wallet was refused by a raw exception (`code: null`) instead of `insufficient-funds`. A failed
    // pass is not fatal by itself: the remainder below decides, and anything still blocking the signature is refused
    // WITH A CODE from the dictionary (see `walletStep`).
    async sign(request) {
      const plan = await api.plan(request);
      if (!request || typeof request.to !== "string" || !request.to) throw new SdkError("bad-input", { field: "to" });
      // THE ADDRESS IS CHECKED BEFORE THE WALLET IS OPENED. A typo or a destination for another Monero network is
      // refused here, not discovered by the wallet after it has already built a transaction.
      await checkAddressOrThrow(request.to, plan.network, "to");
      // THE UNSPENT SET IS REQUIRED. Without it there is nothing to compare the signature with; a missing list is
      // not an empty wallet, and an empty list would make every signed input look foreign.
      const expectedImages = normalizeKeyImages(request.keyImages);
      // ONE ADAPTER FOR RESTORE AND SIGN. A caller that already holds the opened and synced wallet passes it as
      // `wallet`; a caller that wants the SDK to build one passes `connectWallet`.
      const wallet = request.wallet !== undefined && request.wallet !== null
        ? request.wallet
        : (typeof request.connectWallet === "function"
          ? await request.connectWallet(plan)
          : (() => { throw new SdkError("bad-input", { field: "connectWallet" }); })());
      const role = ["open", "sync", "unlockedBalance", "sweepUnlocked", "relay", "close"];
      const missing = role.filter((name) => !wallet || typeof wallet[name] !== "function");
      if (missing.length) throw new SdkError("bad-input", { field: "wallet", missing });

      // NO COMPLETE SCAN, NO SIGNATURE. The check is tied to this exact wallet adapter because `restore` stored its
      // answer against that object; a restore for another wallet or another node is not evidence for this one.
      const scan = scans.get(wallet);
      if (!scan || scan.scanComplete !== true) {
        throw new SdkError("sweep-scan-incomplete", {
          reason: scan && scan.scanIncompleteReason ? scan.scanIncompleteReason : "no-complete-scan",
          walletHeight: scan && scan.walletHeight !== undefined ? scan.walletHeight : null,
          nodeHeight: scan && scan.nodeHeight !== undefined ? scan.nodeHeight : null,
        });
      }

      await wallet.open(plan);
      try {
        // A SYNC PASS - BEST-EFFORT, NOT THE VERDICT. A node whose chain the wallet cannot scan makes the library
        // throw; that must not pre-empt the funds verdict below, and it must not leave as raw text.
        try { await wallet.sync(); } catch { /* the remainder below decides; a real blocker is refused by a code */ }
        const unlocked = BigInt(await walletStep("unlockedBalance", () => wallet.unlockedBalance()));
        // AN EMPTY REMAINDER STOPS THE WITHDRAWAL BEFORE SIGNING: otherwise the wallet would sign a transaction for
        // zero, and the refusal would look like success.
        if (unlocked <= 0n) throw new SdkError("insufficient-funds", { unlocked: unlocked.toString() });
        const signed = await walletStep("sweepUnlocked", () => wallet.sweepUnlocked({ address: request.to, relay: false }));
        // ONE SWAP ADDRESS, ONE TRANSACTION. A wallet that had to split the sweep pays a fee on every part and the
        // page cannot present one withdrawal as several; refuse before the signed set can reach `relay`.
        if (Array.isArray(signed) && signed.length > 1) {
          throw new SdkError("sweep-split", { count: signed.length });
        }
        // THE SIGNED INPUTS ARE THE UNSPENT SET, NOT A SUPERSET AND NOT A DIFFERENT SET. The comparison reads the
        // library's transaction inputs; an opaque signed object is `sweep-inputs-unknown`, never a pass.
        const signedImages = signedKeyImages(signed);
        assertSameKeyImages(expectedImages, signedImages, "sign");
        // WHAT THE TRANSFER COSTS, WHEN THE WALLET CAN SAY. A withdrawal moves the whole free remainder, so the fee
        // is not extra money on top - it is taken out of it, and the recipient receives the remainder MINUS the fee.
        // An adapter that cannot report a fee answers null; publishing 0 there would be a claim the package cannot
        // support, and the interface would show a free transfer.
        const fee = await feeOf(wallet, signed);
        const feeValue = fee === null ? null : BigInt(fee);
        const feeVerdict = sweepFeeVerdict({
          feeAtomic: fee,
          amountAtomic: unlocked,
          ...(request.maxFeeAtomic === undefined || request.maxFeeAtomic === null ? {} : { maxFeeAtomic: request.maxFeeAtomic }),
        });
        if (!feeVerdict.ok) throw new SdkError(feeVerdict.code, { fee: feeVerdict.fee, limit: feeVerdict.limit, amount: feeVerdict.amount, why: feeVerdict.why });
        const token = "sweep-" + (++sessionSeq);
        sessions.set(token, { wallet, plan, signed, expectedImages, signedImages, relayAttempted: false, txids: [] });
        return {
          token,
          amount: unlocked.toString(),
          // The fee in atomic units, or null when the wallet could not report it.
          fee,
          // What the recipient receives: the remainder minus the fee. Null whenever the fee is unknown, and null
          // rather than a negative number when a fee claims more than the remainder (that is a broken report, not
          // a transfer).
          receive: feeValue === null || feeValue >= unlocked ? null : (unlocked - feeValue).toString(),
          to: request.to,
          swept: plan.address,
        };
      } catch (error) {
        // There is no signature - we do not leave an open wallet. Closing must not hide the refusal's reason.
        try { await wallet.close(); } catch { /* the reason matters more than closing */ }
        throw error;
      }
    },

    // SENDING THE SIGNED AND MARKING THE WITHDRAWAL. Sending is split from signing by the same seam as the session:
    // the person has time to see the transfer before it leaves.
    //
    // A LOST ANSWER IS NOT A LOST SIGNATURE. The session stays open when the wallet throws or answers without a
    // transaction id: the signed set may already be on the Monero network, and deleting the handle would make it
    // impossible to check. The same token never sends that set again; a later call reports the same unknown state.
    async relay(request) {
      if (!request || typeof request.token !== "string" || !request.token) throw new SdkError("bad-input", { field: "token" });
      const session = sessions.get(request.token);
      if (!session) throw new SdkError("bad-input", { field: "token", why: "no-open-session" });
      if (session.relayAttempted) {
        throw new SdkError("sweep-relay-unknown", { token: request.token, why: "already-attempted",
          outcome: "unknown", txids: session.txids, swept: session.plan.address });
      }
      // A FRESH UNSPENT SET IS CHECKED AGAIN BEFORE THE SEND. The signed bytes cannot change, so this comparison is
      // about the caller's new observation: if the set it just verified no longer equals the signed inputs, nothing
      // leaves and the session stays open for a correct retry.
      assertSameKeyImages(session.signedImages, normalizeKeyImages(request.keyImages), "relay");
      session.relayAttempted = true;
      const { wallet, plan, signed } = session;
      let txids;
      try {
        txids = await wallet.relay(signed);
      } catch {
        session.txids = txidsOf(signed);
        throw new SdkError("sweep-relay-unknown", { token: request.token, why: "answer-lost",
          outcome: "unknown", txids: session.txids, swept: plan.address });
      } finally {
        // Closing must not hide the relay outcome. The session still holds the signed set when the answer is unknown.
        try { await wallet.close(); } catch { /* the close result is not the transfer result */ }
      }
      const list = Array.isArray(txids) ? txids.filter((txid) => typeof txid === "string" && txid) : [];
      if (!list.length) {
        session.txids = txidsOf(signed);
        throw new SdkError("sweep-relay-unknown", { token: request.token, why: "answer-txid",
          outcome: "unknown", txids: session.txids, swept: plan.address });
      }
      sessions.delete(request.token);
      // NO SERVICE REPORT. The transfer is on the Monero network; the SDK does not ask the page's own host to
      // record it, so the host cannot link the visitor's IP to the escrow and the withdrawal.
      return { outcome: "sent", txids: list, swept: plan.address };
    },

    // A LATER LOOK AFTER THE TOKEN IS GONE. The signed bytes and their hash are the caller's; this only reads the
    // swap address through the same recovery read and says whether those bytes may be sent again. It never
    // signs: `absent` with `resend: true` is the only answer that permits the same bytes, and every incomplete or
    // positive answer forbids a resend.
    async reconcile(request) {
      if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
      const txid = String(request.txid == null ? "" : request.txid).replace(/^0x/i, "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) throw new SdkError("bad-input", { field: "txid" });
      if (request.node === undefined || request.node === null) throw new SdkError("bad-input", { field: "node" });
      if (!Array.isArray(request.keyImages) || !request.keyImages.length) {
        throw new SdkError("bad-input", { field: "keyImages", why: "empty" });
      }
      const keyImages = request.keyImages;
      // THE NODE ANSWERS TWO FACTS, NOT THE WHOLE CHAIN. `readWithdrawalState` asks for this exact hash and for the
      // spent status of these inputs. A start height is no longer part of the call: the block walk was the cost
      // that kept a returning client from getting an answer.
      const read = await readWithdrawalState({
        node: request.node,
        txid,
        keyImages,
        fetch: typeof request.fetch === "function" ? request.fetch
          : (typeof fetchImpl === "function" ? fetchImpl : undefined),
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      return reconcileVerdict({ read, txid, keyImages });
    },

    // THE WITHDRAWAL AS A WHOLE - THE SAME ORDER, ONE CALL. This is a WRAPPER over sign and relay, NOT a second
    // step order: otherwise an edit in one place would diverge from the other.
    async run(request) {
      const opened = await api.sign(request);
      return await api.relay({ token: opened.token, keyImages: request.keyImages });
    },
  };
  return api;
}
