// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/order-client.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Клиент воркера: превращает обмен сообщениями в обычный вызов с колбэком прогресса.
//
// Отдельный модуль нужен, чтобы страница не знала ничего про postMessage и идентификаторы запросов:
// она вызывает buildSide(...) и получает обещание плюс этапы.
export function createOrderWorker() {
  if (typeof Worker === "undefined") throw new Error("воркеры недоступны в этом окружении");
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
    else entry.reject(new Error(msg.message || "воркер вернул ошибку"));
  };
  worker.onerror = (event) => {
    const err = new Error("воркер упал: " + (event.message || "без сообщения"));
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
    // Обязательство на половину. Считается в воркере, потому что там же живёт криптография: наружу
    // уходит только хеш, половина остаётся внутри и в главный поток не попадает.
    halfCommitment: (ownHalf) => call("commit", { ownHalf }),
    // Точка по половине: половина контрагента приходит из котировки, а для адреса нужна точка.
    pointOf: (ownHalf) => call("pointOf", { ownHalf }),
    // Общий адрес Monero из половин - в воркере, потому что там же криптография.
    jointAddress: (joint) => call("jointAddress", { joint }),
    // МАТЕРИАЛ МЕЙКЕРА ОБРАТНОЙ ЗАЯВКИ: обе половины, их точки и обязательство. Доказательства здесь нет и
    // быть не может: в обратном направлении привязку ордера назначает нода, и до билета доказывать нечего
    // (order-worker.js, newMakerMaterial). Публичная часть уходит ноде в заявке, приватная остаётся у
    // мейкера - ею забирают выплату и видят приход XMR.
    makerMaterial: () => call("newMakerMaterial"),
    stop: () => worker.terminate(),
  };
}
