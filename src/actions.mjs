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
import * as engine from "./engine.mjs";
// THE DEAL FLOW IS NOW A PACKAGE MODULE, NOT AN ENGINE FILE (#32, wave 3): www/js/core/swap-flow.js moved to
// sdk/src/swap-flow.mjs. The actions therefore call the module directly instead of reaching it through the
// mirror - there is exactly one implementation, and it lives here.
import * as flow from "./swap-flow.mjs";

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

export function createActions({ call = null } = {}) {
  // WHAT READS THE CHAIN IS ALSO A SEAM, and not only for the checks: the slot check and the signature must go
  // ONE way, otherwise part of the check goes past the wallet and part does not. By default - the engine's read.
  const reader = call || engine.evm.readContract;
  const deps = (wallet) => ({ call: reader, send: (tx) => wallet.send(tx), receipt: (h) => wallet.receipt(h) });
  return {
    /** Marking "I saw the XMR on the shared address". Without it, claiming is forbidden by the contract. */
    async markReady(request, wallet) {
      requestOrFail(request, []);
      walletOrFail(wallet);
      const { escrow, expect, onStep } = request;
      return await withCodes("mark-ready", () => flow.markReadyOrder({ escrow, expect, onStep, deps: deps(wallet) }));
    },
    /** Claiming: it reveals your own half, so expectations are mandatory. */
    async claim(request, wallet) {
      requestOrFail(request, ["halfClaimer"]);
      walletOrFail(wallet);
      const { escrow, halfClaimer, expect, onStep } = request;
      const sender = typeof wallet.address === "function" ? await wallet.address() : null;
      const verdict = claimSenderVerdict({ sender, claimer: request.claimer || (expect && expect.claimer) });
      if (!verdict.ok) throw new SdkError(verdict.code, { field: verdict.field, why: verdict.why, surface: "actions.claim" });
      return await withCodes("claim", () => flow.claimOrder({ escrow, halfClaimer, expect, onStep, deps: deps(wallet) }));
    },
    /** Refunding: it also reveals a half. The core passes the expectations ALWAYS, though the engine does not require them. */
    async refund(request, wallet) {
      requestOrFail(request, ["halfLocker"]);
      walletOrFail(wallet);
      const { escrow, halfLocker, expect, onStep } = request;
      return await withCodes("refund", () => flow.refundOrder({ escrow, halfLocker, expect, onStep, deps: deps(wallet) }));
    },
  };
}
