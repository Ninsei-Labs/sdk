// LOCKING THE FUNDS: TERMS FIRST, THEN SENDING.
//
// This module assembles and checks the order terms before anything goes on-chain. The contract sets the rules.
// The engine checks them; this module does not keep a second copy.
//
// The send goes through the engine's EVM layer and the external wallet adapter. The chain read is a seam: the engine
// read by default, or a caller substitute.
import { SdkError } from "./errors.mjs";
import * as engine from "./engine.mjs";
// The deal flow is a package module. The registry address is read through it, as the actions read the order flow.
import * as flow from "./swap-flow.mjs";
import { walletError } from "./actions.mjs";
import { assertWalletChain } from "./chainGuard.mjs";

// Bring these bytes32 fields to 0x form once, at the boundary. The encoder requires the prefix. These are the
// fields encoded as bytes32 that do not enter the order context string.
const HEX_POLICY_FIELDS = ["commitHalfLocker", "commitHalfClaimer", "edPointLocker", "edPointClaimer", "edViewPointLocker"];
const with0x = (v) => (typeof v === "string" && v && !/^0x/i.test(v) ? "0x" + v : v);

/**
 * The order terms in canonical form: points and commitments with the 0x prefix. One form for the check and for
 * sending.
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
export function terms(request, nowSec = null) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const need = ["locker", "claimer", "commitHalfLocker", "commitHalfClaimer", "edPointLocker", "edPointClaimer", "amount", "readyBy", "t1"];
  const missing = need.filter((k) => request[k] === undefined || request[k] === null || request[k] === "");
  if (missing.length) throw new SdkError("bad-input", { field: "terms", missing });
  try {
    return engine.escrow.orderTerms(canonicalTerms(request));
  } catch (error) {
    // We will not parse ANOTHER's text: we name what the contract's rules check, and only if the deadlines are
    // actually violated. Otherwise - a general refusal on the terms.
    const seconds = Number.isSafeInteger(Number(nowSec)) && Number(nowSec) > 0
      ? Number(nowSec) : Math.floor(Date.now() / 1000);
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
  terms({ ...canonical, amount: canonical.amountWei }, deps.nowSec);
  const evm = engine.evm;
  await assertWalletChain(wallet, canonical.chainId, "fund-order");
  // WHAT READS THE CHAIN IS ALSO A SEAM (as in actions.mjs): by default it is the engine's read, but the caller
  // can substitute its own. Without this capability the lock step could not be checked beyond predicting the
  // address - and then "the address from the receipt" would remain an argument on trust, not a verified property.
  const reader = typeof deps.call === "function" ? deps.call : evm.readContract;
  try {
    return await evm.fundOrder({
      ...canonical,
      call: reader,
      nowSec: Number.isSafeInteger(Number(deps.nowSec)) && Number(deps.nowSec) > 0 ? Number(deps.nowSec) : null,
      onPredicted: deps.onPredicted,
      send: (tx) => wallet.send({ ...tx, chainId: canonical.chainId, from: canonical.locker }),
      // NORMALISING THE RECEIPT ARGUMENT'S SHAPE - HERE, AT THE CORE'S BOUNDARY, NOT AT EVERY CALLER.
      //
      // funding.js calls the receipt with an OBJECT { hash } (waitReceipt), while the adapter contract declares
      // receipt(txHash: string). A strict adapter (sdk/src/adapters/evm-wallet.mjs) answers bad-input to an object,
      // the refusal is SWALLOWED by the receipt wait, and the address would silently fall back. We normalise the
      // argument to a string at this boundary so every adapter sees one shape.
      receipt: (arg) => wallet.receipt(typeof arg === "string" ? arg : (arg && typeof arg.hash === "string" ? arg.hash : arg)),
    });
  } catch (error) {
    // A named reason passes as is. The adapter and reader codes are the answer and must not be overridden.
    if (error && typeof error.code === "string") throw error;
    // A NUMERIC PROVIDER CODE IS A WALLET ANSWER, NOT BAD INPUT. The funding send runs through the same adapter as
    // markReady/claim/refund; 4001 is a person's rejection, 4100/-32002 are wallet state. Classify it before this
    // boundary turns every non-string code into `bad-input`.
    const nested = error && error.data && error.data.originalError;
    if (typeof (error && error.code) === "number" || (nested && typeof nested.code === "number")) {
      throw walletError(error, "lock");
    }
    // Name the reason and choose the code by it: transport is server-unavailable, order or data is bad-input.
    const why = sanitizeWhy((error && error.message) || error);
    throw new SdkError(transportish(why) ? "server-unavailable" : "bad-input", { step: "fund-order", why });
  }
}

/**
 * The escrow factory address for a network, read from the network registry through the deal-flow module. An unknown
 * network is a refusal with a code, not null.
 */
export function factoryOf(chainSlug) {
  let address = null;
  try { address = flow.escrowFactoryAddress(chainSlug); } catch { address = null; }
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new SdkError("bad-input", { field: "factory", chain: typeof chainSlug === "string" ? chainSlug : null });
  }
  return address;
}
