// XMR WITHDRAWAL: PARSING THE FILE AND PREPARING. The withdrawal itself requires a Monero wallet - it arrives as
// an adapter.
//
// Here is exactly what the sweep page does before syncing: decrypt the recovery file, validate it, take the shared
// address, ask the app for the restore height (on the page it is taken by address) and say aloud what is missing
// so the withdrawal can go. Funds do not move at this step.
import { SdkError } from "./errors.mjs";
import { primitives } from "./primitives.mjs";
import * as engine from "./engine.mjs";
import { restoreWallet } from "./sweep-restore.mjs";
import { moneroWalletAdapter } from "./adapters/monero-wallet.mjs";
import { checkDestination } from "./destination.mjs";
import { revealedHalfWord } from "./sweep-half.mjs";

// The same boundary as when the file was issued: a passphrase shorter than twelve characters will not open the file.
const MIN_PASSPHRASE = 12;
const STEPS = ["unlock", "sync", "sweep", "relay"];
// `revealedHalf()` on the escrow. Public data: the function returns the half the settlement published.
const REVEALED_HALF_SELECTOR = "0x3f267bb6";

const contentsOf = (file) => (typeof file === "string" ? file : file && typeof file.contents === "string" ? file.contents : null);

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

export function createSweep({ http, config, call = null }) {
  // THE NAME IS NEEDED BY THE OBJECT ITSELF: `run` calls `api.plan(...)` - the step order is held by the plan and
  // the withdrawal living in one object, not in two copies. During a manual merge of branches the object was left
  // unnamed, and the withdrawal failed with "api is not defined": not a refusal, but a breakdown. `node --check`
  // misses this, there are no conflict markers in the file - only a run shows it.
  // AN OPEN SIGN SESSION: a token -> { wallet, plan, signed }. It lives until `relay`; it keeps no keys - they are
  // owned by the library's wallet.
  const sessions = new Map();
  let sessionSeq = 0;

  // THE NETWORK NAME MONERO-TS TAKES. The adapter speaks a string ("stagenet") because that is what a node says and
  // what a human reads; the library wants its own enum. That translation used to be a callback on the sweep page -
  // the last thing a caller had to know about the library to open a wallet.
  const NETWORK_ENUM = { mainnet: "MAINNET", stagenet: "STAGENET", testnet: "TESTNET" };

  const api = {
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

      // THE RESTORE HEIGHT: first from the file, then from the app BY ADDRESS - exactly as the sweep page does it.
      // An unavailable app is a lack of data, not a refusal: the plan is returned anyway, and `missing` shows what
      // is lacking.
      let restoreHeight = Number(wallet.restoreHeight) || 0;
      let row = null;
      try {
        // THE PATH BY NAME, not by a string: the override comes through the `routes` option.
        const answer = await http.json(config.route("swaps"));
        const rows = Array.isArray(answer) ? answer : ((answer && answer.swaps) || []);
        row = rows.find((x) => String((x && x.address) || "") === String(address)) || null;
      } catch { row = null; }
      const fromApp = Number(row && row.restoreHeight) || 0;
      if (fromApp > 0) restoreHeight = fromApp;
      if (!(restoreHeight > 0)) missing.push("restore-height");

      // THE COUNTERPARTY'S REVEALED HALF - FROM THE CHAIN, VIA THE APP. Exactly as the sweep page does it: POST to
      // the named path, body { network, address }, where address is the ESCROW ADDRESS (not the Monero address).
      // The half is published by the settlement that moves the ETH: a claim or a refund. Before that no one has the
      // spend key, so "not revealed yet" is not an error but a state, and that is exactly where it lands in `missing`.
      // THE COUNTERPARTY'S REVEALED HALF - FROM THE CHAIN WHEN THE CALLER HAS A CHAIN READ. The half is public:
      // `claim` and `refund` store it in `revealedHalf()` and emit `HalfRevealed`. A recovery page served from a
      // static host has no `/escrow/revealed-half` route, so asking the app was the only path and a static page
      // could never withdraw. The app route stays as the fallback for a caller that has no chain read and did
      // configure an API base.
      let revealed = false;
      let revealedValue = null;
      const escrowAddress = wallet.escrowAddress || (payload.escrow && payload.escrow.address) || null;
      if (escrowAddress && typeof call === "function") {
        try {
          const word = String((await call({ to: escrowAddress, data: REVEALED_HALF_SELECTOR })) || "");
          const half = revealedHalfWord(word);
          if (half !== null) {
            revealed = true;
            revealedValue = half;
          }
        } catch { revealed = false; }
      }
      if (!revealed && escrowAddress && config && config.apiBase) {
        try {
          const half = await http.json(config.route("revealedHalf"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ network: payload.network, address: escrowAddress }),
          });
          revealed = !!(half && half.ok && half.revealed && half.half);
          if (revealed) revealedValue = String(half.half);
        } catch { revealed = false; }
      }
      if (!revealed) missing.push("revealed-half");

      return {
        swapId: payload.swapId || null,
        address,
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

    // THE PASS BEFORE SIGNING: set the height, rescan, sync, read the balance, and - when coins exist but none is
    // spendable - re-check the spent status once. The wallet is the same withdrawal adapter `sign` takes; the page
    // no longer decides when a second pass is needed.
    async restore(request) {
      return await restoreWallet(request || {});
    },

    // THE WITHDRAWAL ITSELF. The wallet arrives as an adapter (the WASM and the worker live with whoever builds the
    // page), while the core holds the order: open -> sync -> look at the free remainder -> SIGN (relay: false) ->
    // send -> close.
    //
    // SIGNING AND SENDING ARE DELIBERATELY SPLIT: between them the interface has time to show the person what will
    // leave, rather than telling them about it after sending. An empty remainder stops the withdrawal BEFORE
    // signing - otherwise the wallet would sign a transaction for zero and the refusal would look like success.
    // TELLING THE SERVICE ABOUT THE WITHDRAWAL - SEPARATELY AND REPEATABLY. The mark does not affect the transfer
    // (it is already on the network), so it can be repeated: the interface calls this even after `relay` if the
    // report did not go through then.
    async report(request) {
      if (!request || typeof request.swapId !== "string" || !request.swapId) throw new SdkError("bad-input", { field: "swapId" });
      if (typeof request.txid !== "string" || !request.txid) throw new SdkError("bad-input", { field: "txid" });
      try {
        const answer = await http.json(config.route("swept", { id: request.swapId }), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ txid: request.txid }),
        });
        return { reported: !(answer && answer.ok === false) };
      } catch {
        // The service is unavailable - that is `reported: false`, not a withdrawal refusal: the money has already left.
        return { reported: false };
      }
    },

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
      if (typeof request.connectWallet !== "function") throw new SdkError("bad-input", { field: "connectWallet" });
      const wallet = await request.connectWallet(plan);
      const role = ["open", "sync", "unlockedBalance", "sweepUnlocked", "relay", "close"];
      const missing = role.filter((name) => !wallet || typeof wallet[name] !== "function");
      if (missing.length) throw new SdkError("bad-input", { field: "wallet", missing });

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
        // WHAT THE TRANSFER COSTS, WHEN THE WALLET CAN SAY. A withdrawal moves the whole free remainder, so the fee
        // is not extra money on top - it is taken out of it, and the recipient receives the remainder MINUS the fee.
        // An adapter that cannot report a fee answers null; publishing 0 there would be a claim the package cannot
        // support, and the interface would show a free transfer.
        const fee = await feeOf(wallet, signed);
        const feeValue = fee === null ? null : BigInt(fee);
        const token = "sweep-" + (++sessionSeq);
        sessions.set(token, { wallet, plan, signed });
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
    async relay(request) {
      if (!request || typeof request.token !== "string" || !request.token) throw new SdkError("bad-input", { field: "token" });
      const session = sessions.get(request.token);
      if (!session) throw new SdkError("bad-input", { field: "token", why: "no-open-session" });
      sessions.delete(request.token);
      const { wallet, plan, signed } = session;
      try {
        const txids = await wallet.relay(signed);
        const list = Array.isArray(txids) ? txids : [];
        // MARKING THE WITHDRAWAL - AFTER SENDING AND NOT AFFECTING IT. The transfer is already on the network; the
        // report merely tells the service that the XMR left. So a failed report does NOT make the withdrawal
        // unsuccessful: it gives `reported: false`, so the interface offers to report again - by the same path as
        // here (`report`).
        const reported = plan.swapId && list.length
          ? (await api.report({ swapId: plan.swapId, txid: list[0] })).reported
          : false;
        return { txids: list, swept: plan.address, reported };
      } finally {
        await wallet.close();
      }
    },

    // THE WITHDRAWAL AS A WHOLE - THE SAME ORDER, ONE CALL. This is a WRAPPER over sign and relay, NOT a second
    // step order: otherwise an edit in one place would diverge from the other.
    async run(request) {
      const opened = await api.sign(request);
      return await api.relay({ token: opened.token });
    },
  };
  return api;
}
