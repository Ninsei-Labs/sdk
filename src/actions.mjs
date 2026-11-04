// ORDER ACTIONS: MARKING READY, CLAIMING, REFUNDING.
//
// All three go through ONE wallet seam (the `send`/`receipt` role) and through the slot check that in the engine
// stands BEFORE signing. What is added here is exactly what the engine cannot do: `expect` is MANDATORY.
//
// Why it is mandatory. The slot check compares the order we assembled with the one lying on the chain. Without
// expectations there is nothing to compare against, and the signature goes out under an order whose commitments
// nobody checked: for marking ready that is granting a foreign address the right to take the settlement, for
// claiming it is revealing your own half (irreversible), for refunding the same reveal. The transaction still
// looks successful.
import { SdkError } from "./errors.mjs";
// THE DEAL FLOW IS NOW A PACKAGE MODULE, NOT AN ENGINE FILE (#32, wave 3): www/js/core/swap-flow.js moved to
// sdk/src/swap-flow.mjs. The actions therefore call the module directly instead of reaching it through the
// mirror - there is exactly one implementation, and it lives here.
import * as flow from "./swap-flow.mjs";
import { assertWalletChain } from "./chainGuard.mjs";

const missingFields = (object, fields) =>
  fields.filter((k) => object[k] === undefined || object[k] === null || object[k] === "");

const walletOrFail = (wallet) => {
  const role = ["send", "receipt"];
  const missing = wallet ? role.filter((k) => typeof wallet[k] !== "function") : role;
  if (missing.length) throw new SdkError("bad-input", { field: "wallet", missing });
  return wallet;
};

// THE CLAIM'S HALF IS REVEALED BY WHOEVER SENDS IT. The package sends a claim only from the claimer's own wallet:
// a third-party sender would see the half before the claim is mined, and the only reason to use one is the tip -
// not a reason to hand the half to another party. A caller with no claimer is refused, not sent blind.
export function claimSenderVerdict({ sender = null, claimer = null } = {}) {
  const from = typeof sender === "string" ? sender.trim().toLowerCase() : "";
  const to = typeof claimer === "string" ? claimer.trim().toLowerCase() : "";
  if (!to) return { ok: false, code: "bad-input", field: "claimer" };
  if (!from) return { ok: false, code: "bad-input", field: "wallet.address" };
  if (from !== to) return { ok: false, code: "bad-input", field: "wallet", why: "not-the-claimer" };
  return { ok: true };
}

const requestOrFail = (request, extra) => {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const missing = missingFields(request, ["escrow", "expect", ...extra]);
  if (missing.length) throw new SdkError("bad-input", { field: "request", missing });
  return request;
};

// The engine's refusal arrives as text; a CODE goes out. Texts are the interface's business, the core speaks in codes.
const withCodes = async (step, work) => {
  try { return await work(); }
  catch (error) {
    if (error && typeof error.code === "string") throw error;
    throw new SdkError("contract-reverted", { step });
  }
};

export function createActions({ call = null, blockTime = null } = {}) {
  // WHAT READS THE CHAIN IS ALSO A SEAM, and not only for the checks: the slot check and the signature must go
  // ONE way, otherwise part of the check goes past the wallet and part does not. The caller's seam wins; otherwise
  // the action reads through the provider of THE WALLET IT WAS GIVEN, never through the process-wide engine
  // provider of another client.
  const providerOf = (wallet) => {
    try { return wallet && typeof wallet.driver === "function" ? wallet.driver() : null; }
    catch { return null; }
  };
  const readerFor = (wallet) => {
    if (typeof call === "function") return call;
    const provider = providerOf(wallet);
    if (!provider || typeof provider.request !== "function") {
      return async () => { throw new SdkError("wallet-not-connected", { surface: "actions.read" }); };
    }
    return async ({ to, data, from }) => {
      // The simulation needs the same sender as the transaction: mark-ready and claim are sender-bound. For a
      // plain read the field is simply absent.
      const tx = from ? { to, data, from } : { to, data };
      const result = await provider.request({ method: "eth_call", params: [tx, "latest"] });
      if (typeof result !== "string" || !result.startsWith("0x")) {
        throw new SdkError("contract-reverted", { surface: "actions.read" });
      }
      return result;
    };
  };
  // THE LATEST BLOCK TIMESTAMP IS THE CLOCK THE CONTRACT USES. It comes from the same provider as the contract
  // reads; an absent provider or an unreadable block leaves it null, and the half-revealing action refuses with
  // `clock-unreadable` rather than signing without a time verdict.
  const clockFor = (wallet) => typeof blockTime === "function" ? blockTime : async () => {
    try {
      const provider = providerOf(wallet);
      if (!provider || typeof provider.request !== "function") return null;
      const block = await provider.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
      const at = Number(block && block.timestamp);
      return Number.isSafeInteger(at) && at > 0 ? at : null;
    } catch { return null; }
  };
  // THE SENDER IS CAPTURED WITH THE OTHER ACTION INPUTS. The adapter reads eth_accounts again at the send boundary,
  // so a wallet switch between this guard and the transaction is a refusal rather than a claim from a foreign
  // account. A wallet that cannot name its account cannot prove which key will reveal the half.
  const senderOf = async (wallet, step) => {
    const sender = typeof wallet.address === "function" ? await wallet.address() : null;
    if (typeof sender !== "string" || !sender.trim()) throw new SdkError("bad-input", { field: "wallet.address", step });
    return sender;
  };
  const deps = (wallet, chainId, from) => ({ call: readerFor(wallet), from, send: (tx) => wallet.send({ ...tx, chainId, from }), receipt: (h) => wallet.receipt(h), blockTime: clockFor(wallet) });
  return {
    /** Marking "I saw the XMR on the shared address". Without it, claiming is forbidden by the contract. */
    async markReady(request, wallet) {
      requestOrFail(request, []);
      walletOrFail(wallet);
      const { escrow, expect, onStep } = request;
      const sender = await senderOf(wallet, "mark-ready");
      await assertWalletChain(wallet, expect.chainId, "mark-ready");
      return await withCodes("mark-ready", () => flow.markReadyOrder({ escrow, expect, onStep, deps: deps(wallet, expect.chainId, sender) }));
    },
    /** Claiming: it reveals your own half, so expectations are mandatory. */
    async claim(request, wallet) {
      requestOrFail(request, ["halfClaimer"]);
      walletOrFail(wallet);
      const { escrow, halfClaimer, expect, onStep } = request;
      const sender = await senderOf(wallet, "claim");
      const verdict = claimSenderVerdict({ sender, claimer: request.claimer || (expect && expect.claimer) });
      if (!verdict.ok) throw new SdkError(verdict.code, { field: verdict.field, why: verdict.why, surface: "actions.claim" });
      await assertWalletChain(wallet, expect.chainId, "claim");
      return await withCodes("claim", () => flow.claimOrder({ escrow, halfClaimer, expect, onStep, deps: deps(wallet, expect.chainId, sender) }));
    },
    /** Refunding: it also reveals a half. The core passes the expectations ALWAYS, though the engine does not require them. */
    async refund(request, wallet) {
      requestOrFail(request, ["halfLocker"]);
      walletOrFail(wallet);
      const { escrow, halfLocker, expect, onStep } = request;
      const sender = await senderOf(wallet, "refund");
      await assertWalletChain(wallet, expect.chainId, "refund");
      return await withCodes("refund", () => flow.refundOrder({ escrow, halfLocker, expect, onStep, deps: deps(wallet, expect.chainId, sender) }));
    },
  };
}
