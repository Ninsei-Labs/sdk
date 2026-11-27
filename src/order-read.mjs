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
  const tagged = typeof tag === "number" ? tag
    : (typeof tag === "string" && /^0x[0-9a-f]+$/i.test(tag) ? Number.parseInt(tag, 16) : null);
  if (tagged !== null && tagged !== height) throw bad("block", "wrong-height");
  return { number: height, hash: "0x" + hash, timestamp };
};

/**
 * Read the state and terms of a list of escrows, or of every order made with a key, from logs. A key search finds
 * the escrows with `findSwaps`, then reads terms and settlement events by topic without naming the escrows; an
 * explicit list keeps its address filter because the caller named the escrows.
 */
export async function orderHistory(request = {}) {
  if (!request || typeof request !== "object") throw bad("request");
  const evmLogs = request.evmLogs;
  if (typeof evmLogs !== "function") throw bad("evmLogs");
  let escrows = request.escrows;
  let found = null;
  let fromBlock = request.fromBlock;
  let privateRead = false;
  const explicit = escrows !== undefined && escrows !== null;
  if (explicit && (fromBlock === undefined || fromBlock === null)) {
    // AN EXPLICIT LIST HAS NO SEARCH START OF ITS OWN. Starting at genesis would turn one call into a full-chain
    // read and would be a default the caller never chose; the range must be named.
    throw bad("fromBlock");
  }
  if (escrows === undefined || escrows === null) {
    if (typeof request.mnemonic !== "string") throw bad("escrows");
    // THE SEARCH START DOES NOT DEPEND ON THE FOUND ORDERS. The same key and chain conditions must send the same
    // range whether the key has two orders, one or none; deriving it from the earliest creation block would leak
    // that block through the RPC request and make an empty key look different.
    if (fromBlock === undefined || fromBlock === null) {
      fromBlock = (await recoveryStartBlock({ madeBlock: request.madeBlock,
        deploymentBlock: Number(request.deploymentBlock) || 0, startAt: request.startAt, head: request.head,
        blockAt: request.blockAt })).block;
    }
    found = await findSwaps({ ...request, fromBlock, evmLogs,
      // A HISTORY NEEDS NAMES, NOT PER-ORDER ENRICHMENT. These seams name an escrow or its block; the history path
      // must not use them, even when the caller supplied them for a normal recovery search.
      evmCode: null, evmBlockTime: null, evmBlockTimes: null });
    escrows = found.swaps.map((order) => order.escrow);
    privateRead = true;
  }
  if (!Array.isArray(escrows)) throw bad("escrows");
  const history = await readEscrowHistory({
    escrows, evmLogs, fromBlock: fromBlock === undefined || fromBlock === null ? 0 : fromBlock,
    toBlock: request.toBlock === undefined ? "latest" : request.toBlock,
    checkpoint: request.checkpoint || null, previous: request.previous || null, evmBlock: request.evmBlock || null,
    privateRead,
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
    // A NUMERIC TAG IS A CLAIM ABOUT THE BLOCK, exactly as in order.read. A provider that answers another height
    // must not silently replace the caller's stated cut.
    const tagged = typeof toBlock === "number" ? toBlock
      : (typeof toBlock === "string" && /^0x[0-9a-f]+$/i.test(toBlock) ? Number.parseInt(toBlock, 16) : null);
    if (tagged !== null && tagged !== height) throw bad("block", "wrong-height");
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
 * no code is `pending` through `validUntil` and `expired` only after it. The status and the block timestamp come
 * from one fixed height, and a missing status answer is a named refusal.
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
  // THE ANSWER NAMES THE FINALITY IT ACTUALLY READ. A `blockTag` of `finalized` is a different read from the
  // network default `safe`; reporting the default would describe another cut than the one used.
  const reportedFinality = ["latest", "safe", "finalized"].includes(tag) ? tag : finality;
  // A FINALITY TAG IS A MOVING TARGET. `safe` can advance between the status call and the block read, which would
  // judge a code-less address at one block with another block's timestamp. Resolve the tag once, ask the escrow at
  // that concrete height, then read the same height again. A replaced block is re-read; a block that never settles
  // is a named refusal, never a mixed verdict.
  let current = await blockOf(readBlock, tag);
  let raw;
  let block;
  let stable = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const at = "0x" + current.number.toString(16);
    raw = await call({ to: escrow, data: engine.escrow.encodeStatus(), block: at });
    block = await blockOf(readBlock, current.number);
    if (block.hash === current.hash) { stable = true; break; }
    current = block;
  }
  if (!stable) throw new SdkError("bad-input", { field: "block", why: "unstable", block });
  // A MISSING ANSWER IS NOT "NO CODE". Only an explicit empty bytes answer means the address has no contract; null,
  // undefined and an empty string are refusals.
  if (typeof raw !== "string" || raw === "") {
    throw new SdkError("bad-input", { field: "answer", why: "missing", block });
  }
  const body = raw.replace(/^0x/i, "");
  if (body.length === 0) {
    // THE CONTRACT TAKES A DEPOSIT AT EXACTLY `validUntil`; expiry starts in the next second. Use `>` and name the
    // block that was read at the chosen finality.
    return { state: block.timestamp > validUntil ? "expired" : "pending", escrow,
      validUntil, finality: reportedFinality, block };
  }
  let status;
  try { status = engine.escrow.decodeStatus(raw); }
  catch { throw bad("status", "unreadable"); }
  if (status.isFunded !== true) {
    return { state: "pending", escrow, validUntil, finality: reportedFinality, block, status };
  }
  return { state: "landed", escrow, validUntil, finality: reportedFinality, block, status };
}
