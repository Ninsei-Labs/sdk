// THE MAKER'S DECLINE: A STATE OF ITS OWN, TOLD APART FROM AN ORDINARY REFUND.
//
// WHAT HAPPENS ON THE CHAIN. A maker who refuses a funded purchase - after screening the deposited ETH, say -
// calls `decline()` on the escrow. The contract sets `refunded`, emits `Declined(claimer)` and sends the whole
// balance, the fee included, back to the locker. NO half is revealed: there is nothing to recover, and nobody
// assembles a Monero key from a declined order.
//
// WHY `status()` IS NOT ENOUGH TO SEE IT. `escrow.status()` answers four words - funded, claimed, refunded,
// balance - and a decline reads exactly like an ordinary refund there: `refunded` is set and the money is back.
// The two are not the same event, though. An ordinary refund is the depositor (or whoever holds their half)
// taking the ETH back when the maker did not claim; it REVEALS THE DEPOSITOR'S HALF (`HalfRevealed(half, false)`)
// so the maker can still take their XMR. A decline is the MAKER closing the order in the depositor's favour and
// reveals nothing. On screen the two want different things said and different buttons hidden, so the SDK tells
// them apart instead of reporting "refunded" for both.
//
// THE TWO SOURCES, AND EITHER ONE IS ENOUGH:
//   1) THE ESCROW'S `Declined` EVENT (the chain) - `declinedFromLogs`. The escrow has no getter for a decline
//      (there is no `declined()` view), so the event is the on-chain fact that names it; it is read through the
//      same read seam as every other chain read - an `eth_getLogs` over the escrow's address.
//   2) THE NODE'S SWAP STATUS `declined` WITH THE CODE `compliance` (the wire) - `declinedFromStatus`. Those ARE
//      the two fields the node returns and nothing else, so BOTH are required: the bare word without its code is
//      not the state the node names, and guessing at it would put a category on a refusal that carries none.
//
// WHAT IS DELIBERATELY NOT CARRIED: a reason, a category, a provider. The node returns only `compliance` on
// purpose - it does not name who declined or why - so the SDK reports the state, the node's own single token and
// which reader saw it, AND NOTHING ELSE (see DECLINE_FIELDS below). The sentence a person reads is the
// interface's: this package holds no user-facing string, and a decline is no exception.
import { SdkError } from "./errors.mjs";
import { keccak256 } from "./primitives.mjs";
import * as engine from "./engine.mjs";

// THE EVENT, AND ONLY IT. The signature is assembled from its parts and hashed HERE, once, exactly as Solidity
// does it: keccak256("Declined(address)"). The topic is exported so a caller filters logs with it rather than
// deriving it a second time - a second copy of the same event would be a second truth about it.
export const DECLINE_EVENT_NAME = "Declined";
export const DECLINE_EVENT_SIGNATURE = () => `${DECLINE_EVENT_NAME}(${["address"].join(",")})`;

const hexOf = (bytes) => {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

/**
 * keccak256("Declined(address)") - topic0 of a decline's log. The escrow indexes `claimer`, so a log emitted by the
 * current contracts also carries it in topic1; the event signature (and therefore topic0) does not change. Logs from
 * escrows deployed before the indexing carry the claimer in data instead, which is why this module matches only
 * topic0 and does not assume a claimer position.
 */
export const DECLINED_TOPIC0 = hexOf(keccak256(DECLINE_EVENT_SIGNATURE()));

// THE NODE'S OWN TWO FIELDS for a declined swap: `{ status: "declined", code: "compliance" }`. The code is the
// node's single token, deliberately opaque: it says "a screening decision was taken", not by whom or on what.
export const DECLINED_STATUS = "declined";
export const DECLINED_CODE = "compliance";

// THE STATE'S OWN CODE - a `TerminalCode` (`index.d.ts`). The interface draws the decline screen from THIS, and
// phrases the sentence itself; the package contributes the state and the code, not the words.
export const DECLINED_TERMINAL = "declined";

/**
 * THE WHOLE SET OF FIELDS A DECLINE IS REPORTED WITH - and the list is short ON PURPOSE. Everything else would be
 * a reason, a category or a provider, and the node names none of those:
 *   `declined`  - what happened (true/false);
 *   `terminal`  - the state the interface draws from (`declined`, or null);
 *   `code`      - the node's own token, UNCHANGED, or null;
 *   `source`    - which reader saw it: `event` (the escrow) or `status` (the node). PROVENANCE, NOT A REASON:
 *                 it says where the SDK learned it, not why the maker refused;
 *   `at`        - when it was seen (epoch ms), or null;
 *   `checked`   - whether the chain was read at all. `false` means "not measured", which is NOT "no decline" - a
 *                 caller that blurs the two would read a maker's refusal as an ordinary refund.
 */
export const DECLINE_FIELDS = ["declined", "terminal", "code", "source", "at", "checked"];

// Every verdict is built through this, so no field can creep in beside the list above: the reporter is the shape.
const verdictOf = (fields) => {
  const out = {};
  for (const key of DECLINE_FIELDS) out[key] = fields[key] === undefined ? null : fields[key];
  return out;
};

/** A DECLINE, AS THE SDK REPORTS IT: the state, the node's token and where it was seen - and nothing more. */
export const declineSeen = ({ source = null, at = null } = {}) =>
  verdictOf({ declined: true, terminal: DECLINED_TERMINAL, code: DECLINED_CODE, source, at, checked: true });

/**
 * NO DECLINE. `checked: false` says the reading did not happen (no chain reader, no status body): the two are
 * kept apart on purpose, because "we could not look" and "we looked and it was not a decline" are different
 * states of knowledge, and only one of them lets a caller treat a closed escrow as an ordinary refund.
 */
export const declineNone = ({ source = null, at = null, checked = true } = {}) =>
  verdictOf({ declined: false, terminal: null, code: null, source, at, checked });

/**
 * SOURCE 1 - THE ESCROW'S `Declined` EVENT. `logs` is what the log read answered: an ARRAY of log objects.
 * Anything that is not an array is a refusal (`bad-input`), never "no decline": an unread chain must not be
 * reported as an escrow that declined nothing.
 *
 * Only the FIRST TOPIC is compared (the event's own signature). A log from another address is skipped when the
 * answer carries one and the caller named the escrow; a log without an address is still matched, because the
 * request that produced it was filtered by address and dropping it would hide a real decline.
 */
export function declinedFromLogs(logs, { escrow = null, at = null } = {}) {
  if (!Array.isArray(logs)) throw new SdkError("bad-input", { field: "logs", why: "not-array" });
  const wanted = typeof escrow === "string" && escrow ? escrow.toLowerCase() : null;
  for (const log of logs) {
    if (!log || typeof log !== "object") continue;
    if (wanted && typeof log.address === "string" && log.address && log.address.toLowerCase() !== wanted) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (String(topics[0] || "").toLowerCase() === DECLINED_TOPIC0) return declineSeen({ source: "event", at });
  }
  return declineNone({ source: "event", at });
}

/**
 * SOURCE 2 - THE NODE'S SWAP STATUS. `{ status: "declined", code: "compliance" }`, in either of the two shapes
 * the wire carries it in: at the top level of the answer (the swap state a backend relays) or NESTED UNDER
 * `userStatus` (the field the maker API names it by). BOTH fields must be there and must be exactly these tokens;
 * anything else is not the state the node names, and a partial match is NOT a decline.
 *
 * A body that is not an object at all answers `checked: false` - there was nothing to read, which is not the same
 * as having read it and found no decline.
 */
export function declinedFromStatus(body, { at = null } = {}) {
  if (!body || typeof body !== "object") return declineNone({ source: "status", at, checked: false });
  for (const candidate of [body, body.userStatus]) {
    if (!candidate || typeof candidate !== "object") continue;
    if (String(candidate.status || "") === DECLINED_STATUS && String(candidate.code || "") === DECLINED_CODE) {
      return declineSeen({ source: "status", at });
    }
  }
  return declineNone({ source: "status", at });
}

/**
 * BOTH SOURCES AT ONCE, AND EITHER ONE IS ENOUGH - the form the flow uses. The chain is asked first (the escrow's
 * own event is the stronger fact) and the wire second; a source that was not read is named as such (its own
 * verdict stays, with `source: null` when neither was read), and a body without the node's two fields does not
 * cancel a chain answer.
 */
export function declineOf({ logs = undefined, status = undefined, escrow = null, at = null } = {}) {
  const fromChain = Array.isArray(logs) ? declinedFromLogs(logs, { escrow, at }) : null;
  if (fromChain && fromChain.declined) return fromChain;
  const fromWire = status && typeof status === "object" ? declinedFromStatus(status, { at }) : null;
  if (fromWire && fromWire.declined) return fromWire;
  if (fromChain) return fromChain;                       // the chain was read: it answered "not declined"
  if (fromWire) return fromWire;                         // only the wire was read, and it was not a decline
  return declineNone({ checked: false, at });            // nothing was read, which is NOT "no decline"
}

/**
 * THE DEFAULT CHAIN LOG READER: `eth_getLogs` THROUGH THE PAGE'S WALLET - the same provider the engine's
 * `readContract` uses, so the wallet that reads is the wallet that will sign (the rule the whole chain-read seam
 * follows). It is a READ, not a node substitution: the address is the caller's escrow and the filter is the
 * decline's own topic.
 *
 * `fromBlock` is the caller's: a watch that knows the escrow's birth height scans from there instead of walking
 * the chain's whole history. An answer that is not an array is a REFUSAL - a node that answered something else
 * did not answer "no decline", and a caller must not read it as one.
 */
export async function readDeclinedLogs({ address, topics = [DECLINED_TOPIC0], fromBlock = "earliest", toBlock = "latest" } = {}) {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new SdkError("bad-input", { field: "logs.address" });
  let provider = null;
  try { provider = typeof engine.evm.currentProvider === "function" ? engine.evm.currentProvider() : null; } catch { provider = null; }
  if (!provider || typeof provider.request !== "function") throw new SdkError("bad-input", { field: "evmLogs", why: "no-provider" });
  const answer = await provider.request({ method: "eth_getLogs", params: [{ address, topics, fromBlock, toBlock }] });
  if (!Array.isArray(answer)) throw new SdkError("server-unavailable", { step: "logs", why: "bad-response" });
  return answer;
}

/** The log reader a call was given: the caller's seam, or the default above. */
export const logReaderOf = (logs) => (typeof logs === "function" ? logs : readDeclinedLogs);

/**
 * A BLOCK BOUNDARY AS THE NODE WANTS IT (hex quantity), for a caller that knows where its escrow was born.
 * A value that is not a whole, non-negative number is the fallback - the safe end of the chain, not an invented
 * block: scanning too far is slow, scanning too little misses the event.
 */
export const blockBoundaryOf = (height, fallback = "earliest") => {
  const value = Number(height);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return "0x" + Math.trunc(value).toString(16);
};
