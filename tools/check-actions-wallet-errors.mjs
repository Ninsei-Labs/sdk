// WALLET REFUSALS STAY WALLET REFUSALS.
//
// The old action wrapper rethrew only errors whose `code` was a string and turned every numeric EIP-1193 error
// into `contract-reverted`. A person pressing Reject, a wallet on another chain, a busy wallet and a dropped RPC
// all looked like the escrow refusing a transaction it never saw.
//
// This check runs the three actions through the real flow with a fake chain and a wallet whose send throws each
// error. The guards have to pass first, so the refusal is exercised at the send boundary rather than at input
// validation. A caller's own string refusal is `caller-refused` with `params.callerCode`; provider string codes
// remain transport answers.
import * as engine from "../src/engine.mjs";
import { createActions, walletError } from "../src/actions.mjs";
import { halfCommitmentHex } from "../engine/atomic/orderHalfCommit.js";
import { keccak256, secp256k1 } from "../src/primitives.mjs";

const ADDRESS = "0x" + "11".repeat(20);
const CHAIN_ID = 421614;
const ESCROW = "0x" + "22".repeat(20);
const HALF = 123456789n;
const COMMIT = "0x" + halfCommitmentHex(HALF, secp256k1, keccak256).replace(/^0x/i, "").padStart(64, "0");
const POINT = "0x" + "cd".repeat(32);
const TERMS = "0x" + "ef".repeat(32);

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const words = (...values) => "0x" + values.map(word).join("");

const walletFor = (failure) => ({
  address: async () => ADDRESS,
  chainId: async () => CHAIN_ID,
  send: async () => { throw failure; },
  receipt: async () => null,
});

const chainFor = ({ now, ready }) => {
  const t1 = now + 10_000;
  const readyBy = now + 5_000;
  return async ({ data }) => {
    if (data === engine.escrow.encodeStatus()) return words(1, 0, 0, 0);
    if (data === engine.escrow.encodeT1()) return words(t1);
    if (data === engine.escrow.encodeTermsHash()) return TERMS;
    if (data === engine.escrow.encodeRead("readyBy")) return words(readyBy);
    if (data === engine.escrow.encodeRead("ready")) return words(ready ? 1 : 0);
    if (data === engine.escrow.encodeMarkReady()) return "0x";
    if (data === engine.escrow.encodeRead("edPointLocker")) return POINT;
    if (data === engine.escrow.encodeRead("edPointClaimer")) return POINT;
    if (data === engine.escrow.encodeRead("edViewPointLocker")) return POINT;
    if (data === engine.escrow.encodeRead("commitHalfLocker")) return COMMIT;
    if (data === engine.escrow.encodeRead("commitHalfClaimer")) return COMMIT;
    throw new Error("unexpected call " + data);
  };
};

const expect = {
  chainId: CHAIN_ID,
  edPointLocker: POINT,
  edPointClaimer: POINT,
  edViewPointLocker: POINT,
  commitHalfLocker: COMMIT,
  commitHalfClaimer: COMMIT,
};

const actions = [
  ["mark-ready", "markReady", { now: 1_000, ready: 0 }, { escrow: ESCROW, expect }],
  ["claim", "claim", { now: 1_000, ready: 1 }, { escrow: ESCROW, halfClaimer: HALF, claimer: ADDRESS, expect }],
  ["refund", "refund", { now: 20_000, ready: 0 }, { escrow: ESCROW, halfLocker: HALF, expect }],
];

const cases = [
  ["4001", Object.assign(new Error("User rejected the request."), { code: 4001 }), "wallet-rejected"],
  ["4100", Object.assign(new Error("The requested account has not been authorized."), { code: 4100 }), "wallet-not-connected", "unauthorized"],
  ["4902", Object.assign(new Error("Unrecognized chain ID."), { code: 4902 }), "wrong-chain", "unknown-chain"],
  ["-32002", Object.assign(new Error("A request is already pending."), { code: -32002 }), "wallet-not-connected", "request-pending"],
  ["dropped RPC", Object.assign(new Error("fetch failed"), { code: -32603 }), "wallet-not-connected", "transport"],
  ["plain revert", Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: "0x08c379a0" }), "contract-reverted", "revert"],
  ["status-0 receipt", Object.assign(new Error("transaction failed"), { receipt: { status: 0 } }), "contract-reverted", "revert"],
  ["ACTION_REJECTED", Object.assign(new Error("Wallet declined"), { code: "ACTION_REJECTED" }), "wallet-rejected"],
  ["4001 with revert text", Object.assign(new Error("request cannot be reverted"), { code: 4001, data: "0x1234" }), "wallet-rejected"],
  ["insufficient funds", Object.assign(new Error("insufficient funds for gas * price + value"), { code: "INSUFFICIENT_FUNDS" }), "insufficient-funds"],
  ["nested 4100", Object.assign(new Error("not authorized"), { data: { originalError: { code: 4100 } } }), "wallet-not-connected", "unauthorized"],
  ["caller operation-changed", Object.assign(new Error("the recovery key changed"), { code: "operation-changed" }), "caller-refused", undefined, "operation-changed"],
  ["caller wallet-unsupported-testnet", Object.assign(new Error("the wallet cannot sign on this testnet"), { code: "wallet-unsupported-testnet" }), "caller-refused", undefined, "wallet-unsupported-testnet"],
  ["provider NETWORK_ERROR", Object.assign(new Error("network error"), { code: "NETWORK_ERROR" }), "wallet-not-connected", "transport"],
  ["provider INVALID_ARGUMENT", Object.assign(new Error("invalid argument"), { code: "INVALID_ARGUMENT" }), "wallet-not-connected", "transport"],
  ["provider ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "wallet-not-connected", "transport"],
  ["provider ETIMEDOUT", Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }), "wallet-not-connected", "transport"],
  ["provider UND_ERR_SOCKET", Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }), "wallet-not-connected", "transport"],
  ["ambiguous request rejected", new Error("Request rejected"), "unknown", "unclassified"],
  ["unclassified", new Error("boom"), "unknown", "unclassified"],
];

export const actionsWalletErrorsCheck = async () => {
  const problems = [];
  const ok = (message) => console.log("  ok    " + message);
  const bad = (message) => { problems.push(message); console.log("  FAIL  " + message); };

  console.log("=== EVERY ACTION KEEPS THE WALLET'S OWN REFUSAL ===");
  for (const [label, method, scenario, request] of actions) {
    for (const [errorLabel, failure, code, why, callerCode] of cases) {
      const api = createActions({ call: chainFor(scenario), blockTime: async () => scenario.now });
      let caught = null;
      try {
        await api[method](request, walletFor(failure));
      } catch (error) { caught = error; }
      const good = caught && caught.code === code
        && caught.params && caught.params.step === label
        && (why === undefined || caught.params.why === why)
        && (callerCode === undefined || caught.params.callerCode === callerCode);
      if (good) ok(`${label}: ${errorLabel} -> ${code}${why ? "/" + why : ""}`);
      else bad(`${label}: ${errorLabel} -> ` + JSON.stringify(caught && { code: caught.code, params: caught.params }));
    }
  }

  // THE READ PATH HAS ITS OWN ANSWER. A malformed `eth_call` result is not a wallet state and not a revert;
  // `unknown/bad-answer` is the honest code, and this path is exercised without an explicit `call` seam.
  const readWallet = {
    ...walletFor(new Error("send must not run")),
    driver: () => ({ request: async () => "not-hex" }),
  };
  let readCaught = null;
  try {
    await createActions({ blockTime: async () => 1_000 }).markReady(
      { escrow: ESCROW, expect }, readWallet,
    );
  } catch (error) { readCaught = error; }
  if (readCaught && readCaught.code === "unknown" && readCaught.params && readCaught.params.why === "bad-answer") {
    ok("a malformed eth_call answer is unknown/bad-answer");
  } else {
    bad("malformed read: " + JSON.stringify(readCaught && { code: readCaught.code, params: readCaught.params }));
  }

  // FUNDING USES THE SAME CLASSIFIER. `swaps.start` catches the lock send and rethrows this value; a numeric
  // provider failure must not become `server-unavailable` on the way out.
  const lockFailure = walletError(Object.assign(new Error("fetch failed"), { code: -32603 }), "lock");
  if (lockFailure && lockFailure.code === "wallet-not-connected" && lockFailure.params && lockFailure.params.step === "lock") {
    ok("the lock path reuses the wallet classifier");
  } else {
    bad("lock classifier: " + JSON.stringify(lockFailure && { code: lockFailure.code, params: lockFailure.params }));
  }

  return {
    note: "wallet refusals keep their wallet-side codes and caller refusals stay caller-refused",
    problems,
    notes: problems.length ? [] : ["4001, 4100, 4902, -32002, a dropped RPC, a plain revert and a caller refusal are distinguished at the send boundary"],
  };
};

if (import.meta.main) {
  const result = await actionsWalletErrorsCheck();
  for (const problem of result.problems) console.log("  FAIL  " + problem);
  console.log(result.problems.length ? "FAILED" : "action wallet errors: " + result.note);
  if (result.problems.length) process.exit(1);
}
