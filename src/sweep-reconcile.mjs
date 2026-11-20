// A LATER LOOK AT A SIGNED WITHDRAWAL. The session token is gone; only the signed bytes, their hash and the inputs
// that were verified before signing remain. This is a decision over ONE read of the swap address, never a relay:
// a present hash sends nothing, an incomplete read keeps the bytes and signs nothing, and only a complete read that
// shows both the hash absent and every input unspent permits the very same bytes to be sent again.
import { SdkError } from "./errors.mjs";

const HASH64 = /^[0-9a-f]{64}$/;

const normalizedTxid = (value) => String(value == null ? "" : value).replace(/^0x/i, "").toLowerCase();

/**
 * Turn one recovery read into the reconcile answer. `read.target` is filled by `readRecovery` when the signed hash
 * was found in a block or in the pool; `read.spends` names the key images the same read saw spent.
 */
export function reconcileVerdict({ read, txid, keyImages }) {
  const hash = normalizedTxid(txid);
  if (!HASH64.test(hash)) throw new SdkError("bad-input", { field: "txid" });
  if (!read || typeof read !== "object") throw new SdkError("bad-input", { field: "read" });
  const wanted = new Set((keyImages || []).map((image) => normalizedTxid(image && image.keyImage !== undefined ? image.keyImage : image)));
  const spent = (read.spends || []).filter((spend) => wanted.has(normalizedTxid(spend.keyImage)));
  if (read.target) {
    return {
      outcome: "present",
      resend: false,
      txid: hash,
      height: read.target.height === undefined ? null : read.target.height,
      blockHash: read.target.blockHash === undefined ? null : read.target.blockHash,
      pool: read.target.pool === true,
      complete: read.complete === true,
      failed: read.failed || [],
    };
  }
  if (spent.length) {
    return {
      outcome: "inputs-spent",
      resend: false,
      txid: hash,
      height: null,
      blockHash: null,
      pool: spent.some((spend) => spend.pool === true),
      complete: read.complete === true,
      failed: read.failed || [],
    };
  }
  // A START ABOVE THE TIP READ NO BLOCKS. The pool is read by readRecovery, but an absent hash there is not proof
  // that the hash is absent from the chain: the caller named a range that never reached a block.
  const noBlockRange = read.through === null && Number.isFinite(read.fromHeight) && Number.isFinite(read.tip)
    && read.fromHeight > Math.max(0, read.tip - 1);
  if (read.complete !== true || noBlockRange) {
    return {
      outcome: "unknown",
      resend: false,
      txid: hash,
      height: null,
      blockHash: null,
      pool: false,
      complete: read.complete === true && !noBlockRange,
      failed: read.failed || [],
    };
  }
  return {
    outcome: "absent",
    resend: true,
    txid: hash,
    height: null,
    blockHash: null,
    pool: false,
    complete: true,
    failed: read.failed || [],
  };
}
