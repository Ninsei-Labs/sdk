// ONE PREDICTION FOR THE THREE SDK PATHS. The escrow address is a factory read of the signed quote plus the
// depositor's half; the quote check, the swap start and the pending retry all need exactly the same calldata.
// Keeping the assembly here leaves one place to change when the signed term set grows.
import * as engine from "./engine.mjs";

/** The quote the factory receives: signed terms plus the depositor's own half and the resolved factory. */
export function predictTerms({ quote, order = null, lockerHalf = null, factory = null } = {}) {
  if (!quote || typeof quote !== "object") throw new Error("a signed quote is required for predict()");
  const resolvedFactory = factory || (order && order.factory) || quote.factory;
  if (!resolvedFactory) throw new Error("the quote names no factory");
  const half = lockerHalf || {
    commitHalfLocker: (order && order.commitHalfLocker) ?? quote.commitHalfLocker,
    edPointLocker: (order && order.edPointLocker) ?? quote.edPointLocker,
    edViewPointLocker: (order && order.edViewPointLocker) ?? quote.edViewPointLocker,
  };
  return { ...quote, ...half, factory: resolvedFactory };
}

/** Read the factory's predicted escrow. The caller maps a failed read; no address is guessed here. */
export async function predictEscrow({ quote, order = null, lockerHalf = null, factory = null, call } = {}) {
  if (typeof call !== "function") throw new Error("a chain read is required for predict()");
  const terms = predictTerms({ quote, order, lockerHalf, factory });
  const raw = await call({ to: terms.factory, data: engine.evm.encodePredict(terms) });
  return engine.evm.decodeAddress(raw);
}
