// THE WITNESS-V1 SLICE ANSWER. The parser lives apart from the arrival check so the wire format can be tested
// against a real witness service without importing the wallet engine.
import { SdkError } from "./errors.mjs";

export const WITNESS_SLICE_BLOCKS = 20;

export function witnessSliceIndex(height) {
  const value = Number(height);
  if (!Number.isSafeInteger(value) || value < 0) throw new SdkError("bad-input", { field: "height" });
  return Math.floor(value / WITNESS_SLICE_BLOCKS);
}

export function witnessSliceStart(index) {
  const value = Number(index);
  if (!Number.isSafeInteger(value) || value < 0) throw new SdkError("bad-input", { field: "slice" });
  return value * WITNESS_SLICE_BLOCKS;
}

export function witnessSliceEnd(index) {
  return witnessSliceStart(index) + WITNESS_SLICE_BLOCKS - 1;
}

const witnessHash = (value) => {
  const text = String(value || "").replace(/^0x/, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
};

/**
 * A full slice below the tip has `grid` blocks. The tip slice ends at the top block, sets `complete: false`, and
 * names that block in `tip`. A partial answer is accepted when its last block is at or above the top the caller
 * read: a newer tip is a block that arrived during the walk, while a tip below it shows a witness that is behind.
 */
export function parseWitnessSliceBody(body, { network, index, tipHeight = null }) {
  if (!body || typeof body !== "object") throw new SdkError("xmr-no-nodes", { why: "bad-witness-slice" });
  if (Number(body.version) !== 1) throw new SdkError("xmr-no-nodes", { why: "bad-witness-version" });
  if (String(body.network) !== String(network)) throw new SdkError("xmr-no-nodes", { why: "witness-network" });
  if (Number(body.grid) !== WITNESS_SLICE_BLOCKS) throw new SdkError("xmr-no-nodes", { why: "witness-grid" });
  if (Number(body.slice) !== index) throw new SdkError("xmr-no-nodes", { why: "witness-slice" });
  const start = witnessSliceStart(index);
  const sliceEnd = witnessSliceEnd(index);
  const to = Number(body.to);
  if (Number(body.from) !== start || !Number.isSafeInteger(to) || to < start || to > sliceEnd) {
    throw new SdkError("xmr-no-nodes", { why: "witness-bounds" });
  }
  if (typeof body.complete !== "boolean" || body.complete !== (to === sliceEnd)) {
    throw new SdkError("xmr-no-nodes", { why: "witness-complete" });
  }
  const count = to - start + 1;
  if (!Array.isArray(body.blocks) || body.blocks.length !== count) {
    throw new SdkError("xmr-no-nodes", { why: "witness-block-count" });
  }
  const blocks = body.blocks.map((block, i) => {
    if (!block || Number(block.height) !== start + i) {
      throw new SdkError("xmr-no-nodes", { why: "witness-height" });
    }
    const hash = witnessHash(block.hash);
    if (!hash) throw new SdkError("xmr-no-nodes", { why: "witness-hash" });
    if (!Array.isArray(block.txids)) throw new SdkError("xmr-no-nodes", { why: "witness-txids" });
    const txids = block.txids.map((txid) => {
      const value = witnessHash(txid);
      if (!value) throw new SdkError("xmr-no-nodes", { why: "witness-txid" });
      return value;
    });
    // THE NEW SLICE HEADER IS OPTIONAL ON THE WIRE, REQUIRED BY THE SLICE RECOVERY PATH. An older witness that
    // returns only height/hash/txids still serves the arrival shadow; a recovery read refuses to guess a parent
    // or a transaction count it was not given.
    const hasParent = block.prev_hash !== undefined && block.prev_hash !== null;
    const prevHash = hasParent ? witnessHash(block.prev_hash) : null;
    if (hasParent && !prevHash) throw new SdkError("xmr-no-nodes", { why: "witness-prev-hash" });
    const hasCount = block.num_txes !== undefined && block.num_txes !== null;
    const numTxes = hasCount ? Number(block.num_txes) : null;
    if (hasCount && (!Number.isSafeInteger(numTxes) || numTxes < 0)) {
      throw new SdkError("xmr-no-nodes", { why: "witness-num-txes" });
    }
    if (numTxes !== null && numTxes !== txids.length) {
      throw new SdkError("xmr-no-nodes", { why: "witness-txid-count" });
    }
    if (i > 0 && prevHash) {
      const previousHash = witnessHash(body.blocks[i - 1] && body.blocks[i - 1].hash);
      if (!previousHash || previousHash !== prevHash) {
        throw new SdkError("xmr-no-nodes", { why: "witness-chain" });
      }
    }
    return { height: Number(block.height), hash, prev_hash: prevHash, num_txes: numTxes, txids };
  });
  let tip = null;
  if (body.complete) {
    if (body.tip !== null && body.tip !== undefined) throw new SdkError("xmr-no-nodes", { why: "witness-tip" });
  } else {
    const value = body.tip;
    if (!value || typeof value !== "object" || Number(value.height) !== to || !witnessHash(value.hash)
      || String(value.hash).toLowerCase() !== blocks[count - 1].hash) {
      throw new SdkError("xmr-no-nodes", { why: "witness-tip" });
    }
    // A TIP AT OR ABOVE THE TOP IS A BLOCK THAT ARRIVED DURING THE WALK. A tip below it is a witness that is
    // behind the chain the caller already read, and that cannot be evidence of absence.
    if (tipHeight !== null && Number(value.height) < Number(tipHeight)) {
      throw new SdkError("xmr-no-nodes", { why: "witness-tip-height" });
    }
    tip = { height: Number(value.height), hash: witnessHash(value.hash) };
  }
  return { version: 1, network: String(network), grid: WITNESS_SLICE_BLOCKS, slice: index,
    from: start, to, complete: body.complete, blocks, tip };
}
