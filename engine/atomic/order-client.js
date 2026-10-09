// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/order-client.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Worker client: turns message passing into an ordinary call with a progress callback.
//
// A separate module is needed so the page knows nothing about postMessage and request ids:
// it calls buildSide(...) and gets a promise plus the stages.
export function createOrderWorker() {
  if (typeof Worker === "undefined") throw new Error("workers are unavailable in this environment");
  const worker = new Worker(new URL("./order-worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let seq = 0;

  worker.onmessage = (event) => {
    const msg = event.data || {};
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.kind === "progress") { entry.onProgress?.(msg.stage, msg.detail); return; }
    pending.delete(msg.id);
    if (msg.kind === "done") entry.resolve(msg.result);
    else entry.reject(new Error(msg.message || "worker returned an error"));
  };
  worker.onerror = (event) => {
    const err = new Error("worker crashed: " + (event.message || "no message"));
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
  };

  const call = (type, args = {}, onProgress) => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, type, ...args });
    });
  };

  return {
    buildSide: (orderContext, onProgress) => call("newSide", { orderContext }, onProgress),
    sealHalf: (orderContext, ownHalf, encPub, onProgress) => call("seal", { orderContext, ownHalf, counterparty: { encPub } }, onProgress),
    verifyCounterparty: (orderContext, counterparty, sealedBytes, onProgress) => call("verify", { orderContext, counterparty, sealedBytes }, onProgress),
    // Commitment to a half. Computed in the worker, because that is where the cryptography lives:
    // only the hash goes out, the half stays inside and never reaches the main thread.
    halfCommitment: (ownHalf) => call("commit", { ownHalf }),
    // Point from a half: the counterparty's half comes from the quote, and the address needs a point.
    pointOf: (ownHalf) => call("pointOf", { ownHalf }),
    // Joint Monero address from the halves - in the worker, because that is where the cryptography lives.
    jointAddress: (joint) => call("jointAddress", { joint }),
    // MAKER MATERIAL OF THE REVERSE REQUEST: both halves, their points and the commitment. There is no proof
    // here and there cannot be: in the reverse direction the node assigns the order binding, and there is
    // nothing to prove before the ticket (order-worker.js, newMakerMaterial). The public part goes to the node
    // in the request, the private part stays with the maker - it is used to claim the payout and see XMR arrival.
    makerMaterial: () => call("newMakerMaterial"),
    stop: () => worker.terminate(),
  };
}
