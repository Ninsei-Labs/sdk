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

const missingFields = (object, fields) =>
  fields.filter((k) => object[k] === undefined || object[k] === null || object[k] === "");

const walletOrFail = (wallet) => {
  const role = ["send", "receipt"];
  const missing = wallet ? role.filter((k) => typeof wallet[k] !== "function") : role;
  if (missing.length) throw new SdkError("bad-input", { field: "wallet", missing });
  return wallet;
};

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
      return await withCodes("mark-ready", () => engine.swapFlow.markReadyOrder({ escrow, expect, onStep, deps: deps(wallet) }));
    },
    /** Claiming: it reveals your own half, so expectations are mandatory. */
    async claim(request, wallet) {
      requestOrFail(request, ["halfClaimer"]);
      walletOrFail(wallet);
      const { escrow, halfClaimer, expect, onStep } = request;
      return await withCodes("claim", () => engine.swapFlow.claimOrder({ escrow, halfClaimer, expect, onStep, deps: deps(wallet) }));
    },
    /** Refunding: it also reveals a half. The core passes the expectations ALWAYS, though the engine does not require them. */
    async refund(request, wallet) {
      requestOrFail(request, ["halfLocker"]);
      walletOrFail(wallet);
      const { escrow, halfLocker, expect, onStep } = request;
      return await withCodes("refund", () => engine.swapFlow.refundOrder({ escrow, halfLocker, expect, onStep, deps: deps(wallet) }));
    },
  };
}
