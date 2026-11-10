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
 * names that block in `tip`. A partial answer is accepted only when its last block is the top the caller read.
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
    return { height: Number(block.height), hash, txids };
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
    if (tipHeight !== null && Number(value.height) !== Number(tipHeight)) {
      throw new SdkError("xmr-no-nodes", { why: "witness-tip-height" });
    }
    tip = { height: Number(value.height), hash: witnessHash(value.hash) };
  }
  return { version: 1, network: String(network), grid: WITNESS_SLICE_BLOCKS, slice: index,
    from: start, to, complete: body.complete, blocks, tip };
}
