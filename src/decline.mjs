// THE MAKER'S DECLINE.
//
// A decline is a maker closing a funded order. The escrow sets `refunded`, emits `Declined(claimer)` and returns the
// balance to the locker. No half is revealed.
//
// `status()` shows the same `refunded` state as an ordinary refund. The SDK reads the `Declined` event or the node's
// `declined` status with code `compliance` to tell them apart.
//
// The SDK reports the state, the node's token and the reader. It does not invent a reason, a category or a provider.
import { SdkError } from "./errors.mjs";
import { keccak256 } from "./primitives.mjs";
import * as engine from "./engine.mjs";

// The event signature is assembled once and hashed as Solidity does. Callers filter logs with the exported topic.
export const DECLINE_EVENT_NAME = "Declined";
export const DECLINE_EVENT_SIGNATURE = () => `${DECLINE_EVENT_NAME}(${["address"].join(",")})`;

const hexOf = (bytes) => {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};

/**
 * The `Declined(address)` topic. The current escrow indexes `claimer` in topic1. Older escrows put the claimer in
 * data, so this module matches topic0 only.
 */
export const DECLINED_TOPIC0 = hexOf(keccak256(DECLINE_EVENT_SIGNATURE()));

// The node's two fields for a declined swap: `{ status: "declined", code: "compliance" }`. The code is opaque.
export const DECLINED_STATUS = "declined";
export const DECLINED_CODE = "compliance";

// The terminal state the interface draws from. The package supplies the state and the code, not the words.
export const DECLINED_TERMINAL = "declined";

/**
 * The fields of a decline report. Keep this list short. `source` is provenance, not a reason. `checked: false` means
 * the chain was not read, which is not the same as "no decline".
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
 * The escrow's `Declined` event. `logs` must be an array. A log from another address is skipped when the caller named
 * the escrow. A log without an address still matches because the read was filtered by address.
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
 * The node's status. It accepts `{ status: "declined", code: "compliance" }` at the top level or under `userStatus`.
 * Both fields must match. A body that is not an object answers `checked: false`.
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
 * Both sources. Either one is enough. The chain is read first and the wire second. A body without the node's fields
 * does not cancel a chain answer.
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
 * The default log reader: `eth_getLogs` through the page wallet, so the reader and the signer use the same provider.
 * `fromBlock` is the caller's. An answer that is not an array is a refusal, not "no decline".
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
 * A block boundary as the node wants it. A value that is not a whole, non-negative number falls back to the safe end
 * of the chain. Scanning too far is slow. Scanning too little misses the event.
 */
export const blockBoundaryOf = (height, fallback = "earliest") => {
  const value = Number(height);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return "0x" + Math.trunc(value).toString(16);
};
