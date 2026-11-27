// ORDER READS THAT NEED ONE CONSISTENT CUT. `order.read` lives beside the escrow calls in swap-flow; this module
// holds the bulk history, the lookup by escrow and the funding verdict. They share one rule: an incomplete read is
// a refusal or a named unknown, never a zero or an absence.
import { SdkError } from "./errors.mjs";
import * as engine from "./engine.mjs";
import { finalityFor } from "../engine/core/finality.js";
import { findOrderByEscrow, findSwaps, readEscrowHistory, recoveryStartBlock } from "./recovery-key.mjs";

const bad = (field, why = null) => new SdkError("bad-input", why ? { field, why } : { field });
const address = (value, field = "escrow") => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw bad(field);
  return value.toLowerCase();
};
const number = (value, field) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw bad(field);
  return n;
};
const blockOf = async (readBlock, tag) => {
  let block;
  try { block = await readBlock(tag); }
  catch { throw bad("block", "unreadable"); }
  const height = Number(block && block.number);
  const timestamp = Number(block && block.timestamp);
  const hash = String((block && block.hash) || "").replace(/^0x/i, "").toLowerCase();
  if (!Number.isSafeInteger(height) || height < 0 || !Number.isSafeInteger(timestamp) || timestamp <= 0
      || !/^[0-9a-f]{64}$/.test(hash)) throw bad("block", "incomplete");
  return { number: height, hash: "0x" + hash, timestamp };
};

/**
 * Read the state and terms of a list of escrows, or of every order made with a key, from logs. A key search first
 * finds the escrows with `findSwaps`, then reads the same terms and settlement events as an explicit list would.
 */
export async function orderHistory(request = {}) {
  if (!request || typeof request !== "object") throw bad("request");
  const evmLogs = request.evmLogs;
  if (typeof evmLogs !== "function") throw bad("evmLogs");
  let escrows = request.escrows;
  let found = null;
  let fromBlock = request.fromBlock;
  const explicit = escrows !== undefined && escrows !== null;
  if (explicit && (fromBlock === undefined || fromBlock === null)) {
    // AN EXPLICIT LIST HAS NO SEARCH START OF ITS OWN. Starting at genesis would turn one call into a full-chain
    // read and would be a default the caller never chose; the range must be named.
    throw bad("fromBlock");
  }
  if (escrows === undefined || escrows === null) {
    if (typeof request.mnemonic !== "string") throw bad("escrows");
    found = await findSwaps({ ...request, evmLogs });
    escrows = found.swaps.map((order) => order.escrow);
    // A key history starts where its search started, not at block zero. With orders the earliest creation block is
    // enough (terms and settlement follow it); an empty key uses the same shared start rule as findSwaps.
    if (fromBlock === undefined || fromBlock === null) {
      const blocks = found.swaps.map((order) => Number(order.blockNumber)).filter((value) => Number.isSafeInteger(value) && value >= 0);
      fromBlock = blocks.length ? Math.min(...blocks)
        : (await recoveryStartBlock({ madeBlock: request.madeBlock, deploymentBlock: Number(request.deploymentBlock) || 0,
          startAt: request.startAt, head: request.head, blockAt: request.blockAt })).block;
    }
  }
  if (!Array.isArray(escrows)) throw bad("escrows");
  const history = await readEscrowHistory({
    escrows, evmLogs, fromBlock: fromBlock === undefined || fromBlock === null ? 0 : fromBlock,
    toBlock: request.toBlock === undefined ? "latest" : request.toBlock,
    checkpoint: request.checkpoint || null, previous: request.previous || null, evmBlock: request.evmBlock || null,
  });
  return { ...history, ...(found ? { swaps: found.swaps } : {}) };
}

/** The creation block, the order and its terms for one escrow; null when the creation event is not in the range. */
export async function orderLookup(escrow, request = {}) {
  const target = address(escrow);
  if (typeof request.factory !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(request.factory)) throw bad("factory");
  if (typeof request.evmLogs !== "function") throw bad("evmLogs");
  // ONE CUT FOR THE LOOKUP TOO: the creation event and the terms/state are two log reads. When the caller brings a
  // block reader, fix the end height first; otherwise `latest` would let the second request see a different chain
  // than the first one.
  let toBlock = request.toBlock === undefined ? "latest" : request.toBlock;
  if (typeof request.evmBlock === "function") {
    let block;
    try { block = await request.evmBlock(toBlock); }
    catch { throw bad("block", "unreadable"); }
    const height = Number(block && block.number);
    if (!Number.isSafeInteger(height) || height < 0) throw bad("block", "incomplete");
    toBlock = height;
  }
  const found = await findOrderByEscrow({
    escrow: target, factory: request.factory, deploymentBlock: number(request.deploymentBlock || 0, "deploymentBlock"),
    evmLogs: request.evmLogs, toBlock,
  });
  if (!found) return { escrow: target, found: false, creationBlock: null, creationBlockHash: null, terms: null };
  const history = await readEscrowHistory({
    escrows: [target], evmLogs: request.evmLogs,
    fromBlock: found.creationBlock === null || found.creationBlock === undefined ? 0 : found.creationBlock,
    toBlock,
    evmBlock: request.evmBlock || null,
  });
  const row = history.escrows.find((entry) => entry.escrow === target) || null;
  return {
    escrow: target, found: true, creationBlock: found.creationBlock,
    creationBlockHash: found.creationBlockHash, order: found.order,
    terms: row ? row.terms : null, status: row ? row.status : null,
  };
}

/**
 * The funding verdict for a predicted escrow at a named finality. An existing escrow is `landed`; an address with
 * no code is `pending` until the signed `validUntil` and `expired` from it. The block timestamp and the contract
 * answer come from the same tag.
 */
export async function orderFunding(request = {}) {
  if (!request || typeof request !== "object") throw bad("request");
  const escrow = address(request.escrow);
  const validUntil = number(request.validUntil, "validUntil");
  if (validUntil <= 0) throw bad("validUntil");
  // THE SDK'S OWN FINALITY TABLE NAMES THE TAG. On Arbitrum that is `safe`, not `finalized`; a caller can still name
  // `finalized` explicitly when its screen already waited for that level.
  const policy = typeof request.network === "string" && request.network ? finalityFor(request.network) : null;
  const named = request.finality !== undefined && request.finality !== null;
  // A DEPTH NETWORK HAS NO HONEST TAG. bsc, monad, hyperevm and an unknown network answer `safe`/`finalized` at
  // practically the same block as `latest`; calling that final would be the protection the table warns about. The
  // caller must name a finality explicitly (or use a network whose table names a meaningful tag).
  if (!named && policy && policy.mode === "depth") throw bad("finality", "depth-not-tag");
  const finality = named ? request.finality : (policy && policy.mode === "tag" ? policy.tag : "safe");
  if (!["latest", "safe", "finalized"].includes(finality)) throw bad("finality");
  const call = request.call || engine.evm.readContract;
  const readBlock = request.block || request.evmBlock;
  if (typeof call !== "function") throw bad("call");
  if (typeof readBlock !== "function") throw bad("block");
  const tag = request.blockTag === undefined || request.blockTag === null ? finality : request.blockTag;
  const [raw, block] = await Promise.all([
    call({ to: escrow, data: engine.escrow.encodeStatus(), block: tag }),
    blockOf(readBlock, tag),
  ]);
  const body = String(raw || "").replace(/^0x/, "");
  if (body.length === 0) {
    return { state: block.timestamp >= validUntil ? "expired" : "pending", escrow,
      validUntil, finality, block };
  }
  let status;
  try { status = engine.escrow.decodeStatus(raw); }
  catch { throw bad("status", "unreadable"); }
  if (status.isFunded !== true) {
    return { state: "pending", escrow, validUntil, finality, block, status };
  }
  return { state: "landed", escrow, validUntil, finality, block, status };
}
