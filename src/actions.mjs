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
import { ERROR_CODES } from "./codes.mjs";
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

// A WALLET ERROR IS NOT A CONTRACT REVERT. EIP-1193 providers report a refusal, a missing permission, another
// chain or a busy request with numeric codes; the old wrapper turned all of them into `contract-reverted`. The
// interface then told the person the escrow had refused a transaction it never saw. A real revert is recognised
// by the receipt, a revert-shaped error, or the message - and only then leaves as `contract-reverted`.
const codeOfError = (error) => error && (error.code || (error.data && error.data.originalError && error.data.originalError.code));
const messageOfError = (error) => String((error && error.message) || error || "");
const isProviderError = (error) => {
  const code = codeOfError(error);
  return typeof code === "number" || (typeof code === "string" && !ERROR_CODES.includes(code));
};
const actionFailure = (error, step) => {
  // ERRORS ALREADY NAMED BY THE SDK KEEP THEIR CODE. The flow and the chain guards speak the same vocabulary;
  // wrapping them a second time would erase `why` and turn a named refusal into a generic one.
  if (error instanceof SdkError) throw error;
  if (typeof (error && error.code) === "string" && ERROR_CODES.includes(error.code)) {
    throw new SdkError(error.code, { ...(error.params || {}), step });
  }
  const code = codeOfError(error);
  const message = messageOfError(error);
  const receiptStatus = error && error.receipt && error.receipt.status;
  const explicitReject = code === 4001 || code === "ACTION_REJECTED"
    || /user rejected|user denied|rejected by user|denied by user|action_rejected/i.test(message);
  // A NAMED REVERT WINS OVER A MESSAGE THAT MENTIONS "revert"; a wallet's own 4001 wins over generic
  // revert-shaped text, so a localized "cannot be reverted" refusal is not blamed on the escrow.
  const namedRevert = code === "contract-reverted" || code === 3
    || receiptStatus === 0 || receiptStatus === "0x0" || receiptStatus === "0";
  if (namedRevert) throw new SdkError("contract-reverted", { step, why: "revert" });
  // 4001 IS THE PERSON'S DECISION, not a chain answer. A textual rejection is accepted as the same event
  // because some injected providers send no numeric code.
  if (explicitReject) throw new SdkError("wallet-rejected", { step });
  // REVERT DATA ONLY COUNTS AFTER A REFUSAL. A 4001/ACTION_REJECTED error may carry arbitrary provider data;
  // it is still the person's decision, not an escrow answer.
  if ((error && typeof error.data === "string" && error.data.startsWith("0x")) || /execution reverted|revert/i.test(message)) {
    throw new SdkError("contract-reverted", { step, why: "revert" });
  }
  // A DETERMINISTIC WALLET REFUSAL HAS ITS OWN CODE. No gas is a wallet-side state, not a transport failure:
  // retrying the same transaction will fail the same way until the account is funded.
  if (code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(message)) {
    throw new SdkError("insufficient-funds", { step });
  }
  // 4902 IS A WALLET THAT DOES NOT KNOW THE CHAIN. It is a wallet-side refusal with its own existing code, not
  // a wrong contract answer.
  if (code === 4902 || /unrecognized chain|not added|unknown chain/i.test(message)) {
    throw new SdkError("wrong-chain", { vm: "evm", step, why: "unknown-chain" });
  }
  // THE WALLET IS NOT USABLE FOR THIS REQUEST. 4100 has no permission for the account, -32002 already has a
  // request open, and a transport failure never reached a node. Keep one wallet-side code and name the reason.
  if (code === 4100) throw new SdkError("wallet-not-connected", { step, why: "unauthorized" });
  if (code === -32002 || /already pending|already processing/i.test(message)) {
    throw new SdkError("wallet-not-connected", { step, why: "request-pending" });
  }
  if (isProviderError(error)) {
    throw new SdkError("wallet-not-connected", { step, why: "transport", providerCode: code ?? null });
  }
  // AN UNCLASSIFIED FAILURE IS NOT A REVERT. The old fallback claimed the escrow refused; that is a statement
  // about the chain we cannot make from an error we did not classify.
  throw new SdkError("unknown", { step, why: "unclassified" });
};

// THE SAME CLASSIFIER FOR THE FUNDING PATH. `actionFailure` throws because the actions wrapper wants that shape;
// funding needs the named error as a value so it can rethrow it after its own pending-record cleanup.
export const walletError = (error, step) => {
  try { actionFailure(error, step); }
  catch (named) { return named; }
  return new SdkError("unknown", { step, why: "unclassified" });
};

const withCodes = async (step, work) => {
  try { return await work(); }
  catch (error) { actionFailure(error, step); }
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
        // A MALFORMED `eth_call` ANSWER IS A NODE FAILURE, NOT A WALLET STATE. `unknown` keeps it out of both
        // `contract-reverted` and the wallet-side codes; the reason names what was wrong.
        throw new SdkError("unknown", { surface: "actions.read", why: "bad-answer" });
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
