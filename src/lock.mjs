// LOCKING THE FUNDS: TERMS FIRST, THEN SENDING.
//
// The first half of the step is here - assembling and CHECKING the order terms BEFORE anything goes on-chain. The
// rules are not ours: the contract sets them, and the engine already checks them (`www/js/evm/escrow.js`,
// `orderTerms`). The core will not hold a copy of the rules: a copy would drift from the contract right where the
// error shows up only as a rejected transaction.
//
// WHAT IS HERE: both the assembly of the terms and the sending itself - it goes through the engine's EVM layer
// (`fundOrder`), and the EVM wallet (the `send`/`receipt` role) comes from outside. What reads the chain is also a
// seam: by default the engine's read, but the caller can substitute its own (as in actions.mjs).
import { SdkError } from "./errors.mjs";
import * as engine from "./engine.mjs";
// THE DEAL FLOW IS A PACKAGE MODULE NOW (#32, wave 3): the registry address is read through it, exactly as
// the actions read the order flow.
import * as flow from "./swap-flow.mjs";

// THE ORDER'S WORD-ADDRESSES ARE BROUGHT TO 0x HERE, AT THE BOUNDARY, NOT AT EVERY CALLER.
//
// The engine returns the points and commitments WITHOUT the 0x prefix (that is how www/js/atomic/halves.js stores
// them), while the calldata encoder (www/js/evm/factory.js, word) REQUIRES the prefix and refuses "not a number
// and not hex" on 64 digits without one. The page normalises them on its side (sdk/src/swap-flow.mjs, with0x)
// for exactly this reason. The core must do the same ITSELF: otherwise every caller would repeat the
// normalisation, and one forgetful one would break the signature with the encoder's raw error. The list is
// exactly the fields encoded as bytes32 that do NOT enter the order context string (otherwise the normalisation
// would drift from the proof, which is bound to the context): two half commitments and three ed25519 points.
const HEX_POLICY_FIELDS = ["commitHalfLocker", "commitHalfClaimer", "edPointLocker", "edPointClaimer", "edViewPointLocker"];
const with0x = (v) => (typeof v === "string" && v && !/^0x/i.test(v) ? "0x" + v : v);

/**
 * The order terms in canonical form: points and commitments - with the 0x prefix. One form for the check and for
 * sending - otherwise one thing would be checked and another encoded.
 */
export function canonicalTerms(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const out = { ...request };
  for (const key of HEX_POLICY_FIELDS) out[key] = with0x(out[key]);
  return out;
}

/**
 * The order terms for the contract. They are assembled by the engine, and its refusal (the deadlines the wrong
 * way, readyBy in the past) is turned into a CODE: texts are the interface's business, the core speaks in codes.
 */
export function terms(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const need = ["locker", "claimer", "commitHalfLocker", "commitHalfClaimer", "edPointLocker", "edPointClaimer", "amount", "readyBy", "t1"];
  const missing = need.filter((k) => request[k] === undefined || request[k] === null || request[k] === "");
  if (missing.length) throw new SdkError("bad-input", { field: "terms", missing });
  try {
    return engine.escrow.orderTerms(canonicalTerms(request));
  } catch (error) {
    // We will not parse ANOTHER's text: we name what the contract's rules check, and only if the deadlines are
    // actually violated. Otherwise - a general refusal on the terms.
    const seconds = Math.floor(Date.now() / 1000);
    if (Number(request.readyBy) <= seconds) throw new SdkError("bad-input", { field: "readyBy", why: "not-in-future" });
    if (Number(request.t1) <= Number(request.readyBy)) throw new SdkError("bad-input", { field: "t1", why: "not-after-readyBy" });
    throw new SdkError("bad-input", { field: "terms" });
  }
}

// SANITISING THE REASON. The engine's messages carry no keys, but sanitising costs one line and covers the case
// where the engine starts printing a value: 0x + 64 hex is a private key, and it never goes out.
const sanitizeWhy = (value) =>
  String(value === undefined || value === null ? "" : value).replace(/0x[0-9a-fA-F]{64}/g, "0x<redacted>").slice(0, 200);
// A NETWORK REFUSAL IS CALLED A NETWORK ONE, rather than being fitted to a data error: transport and order
// validation are different things, and the caller needs an answer to "retry or fix".
const TRANSPORT_WHY = /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timeout|HTTP \d|status \d|non-ok/i;
const transportish = (why) => TRANSPORT_WHY.test(why);

/**
 * SEND THE LOCK. The deadlines and the composition are checked BEFORE sending (see `terms`), the chain work is
 * done by the engine (`fundOrder`), and the wallet arrives as an adapter: signing is possible only in it, and the
 * core keeps no path into the chain of its own.
 *
 * TWO THINGS ARE DELIBERATELY NOT OURS: reading from the chain is taken from the engine, and the escrow address -
 * FROM THE RECEIPT, not from a prediction. A prediction could diverge from what was actually created, and it
 * would diverge silently.
 */
export async function send(request, wallet, deps = {}) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  if (!wallet || typeof wallet.send !== "function" || typeof wallet.receipt !== "function") {
    throw new SdkError("bad-input", { field: "wallet", missing: ["send", "receipt"] });
  }
  // THE TERMS ARE BROUGHT TO CANONICAL FORM BEFORE EVERYTHING, and go in one form both into the check and into
  // sending.
  // THE DEADLINES - HERE, BEFORE ANY SENDING, and on the form funding expects (`amountWei`, not `amount`: the
  // order terms and the sending have different names for the same field, and they must not be confused).
  const canonical = canonicalTerms(request);
  terms({ ...canonical, amount: canonical.amountWei });
  const evm = engine.evm;
  // WHAT READS THE CHAIN IS ALSO A SEAM (as in actions.mjs): by default it is the engine's read, but the caller
  // can substitute its own. Without this capability the lock step could not be checked beyond predicting the
  // address - and then "the address from the receipt" would remain an argument on trust, not a verified property.
  const reader = typeof deps.call === "function" ? deps.call : evm.readContract;
  try {
    return await evm.fundOrder({
      ...canonical,
      call: reader,
      send: (tx) => wallet.send(tx),
      // NORMALISING THE RECEIPT ARGUMENT'S SHAPE - HERE, AT THE CORE'S BOUNDARY, NOT AT EVERY CALLER.
      //
      // www/js/evm/funding.js calls the receipt with an OBJECT { hash } (waitReceipt), while the adapter contract
      // declares receipt(txHash: string). A strict adapter (sdk/src/adapters/evm-wallet.mjs) answers bad-input to
      // an object, the refusal is SWALLOWED by the receipt wait, and the escrow address is silently replaced with
      // the PREDICTED one - that is, the "address from the receipt" check stops working without saying so. We
      // normalise the argument to a string here: funding.js is foreign code and must not be edited, and every
      // adapter should not repeat the normalisation.
      receipt: (arg) => wallet.receipt(typeof arg === "string" ? arg : (arg && typeof arg.hash === "string" ? arg.hash : arg)),
    });
  } catch (error) {
    // AN ALREADY-NAMED REASON PASSES AS IS: the adapter's and the reader's codes (wrong-chain, server-unavailable,
    // contract-reverted, bad-input) ARE the answer, and it must not be overridden.
    if (error && typeof error.code === "string") throw error;
    // THE REST USED TO HIDE BEHIND server-unavailable { step: "fund-order" }, and the real reason (the first live
    // run: "locker and claimer cannot coincide") never reached the caller. Now the reason is NAMED as a string
    // (briefly, without keys), and the code is chosen by it: transport - server-unavailable, order/data
    // validation - bad-input.
    const why = sanitizeWhy((error && error.message) || error);
    throw new SdkError(transportish(why) ? "server-unavailable" : "bad-input", { step: "fund-order", why });
  }
}

/**
 * The escrow factory address for a network: FROM THE NETWORK REGISTRY, by the same path as the rest of the core.
 * The registry is read through the deal-flow module (sdk/src/swap-flow.mjs, escrowFactoryAddress) - the core
 * keeps no SECOND table of addresses.
 *
 * PREVIOUSLY THE FUNCTION LOOKED IN THE WRONG MODULE (www/js/evm/escrow.js, which has no such function) and
 * ALWAYS returned null - that is, the seam stayed silent about the factory's absence, and the caller took the
 * address elsewhere. Now the absence of a factory for a network is a REFUSAL WITH A CODE naming the network, not
 * null.
 */
export function factoryOf(chainSlug) {
  let address = null;
  try { address = flow.escrowFactoryAddress(chainSlug); } catch { address = null; }
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new SdkError("bad-input", { field: "factory", chain: typeof chainSlug === "string" ? chainSlug : null });
  }
  return address;
}
