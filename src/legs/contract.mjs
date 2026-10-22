// THE SETTLEMENT-LEG CONTRACT, NOT A DRIVER.
//
// A driver may implement a base role (wallet identity and balances) before it can settle anything. The contract is
// split by capability for exactly that reason: EVM can quote and read balances today, while its settlement side is
// still the only implementation. A future Tron or Solana driver must not be mistaken for a complete settlement leg
// merely because it is present in the registry.
//
// `settlement: true` is a promise: the driver has the whole settlement role and can be used for fund/claim/refund.
// `settlement: false` means the driver may be used only for the capabilities it declares; the caller still refuses
// a settlement action by name.
export const LEG_ROLE_METHODS = Object.freeze({
  identity: Object.freeze(["walletChainId", "sameChain"]),
  balances: Object.freeze(["balances"]),
  refs: Object.freeze(["normalizeRef", "sameRef"]),
  finality: Object.freeze(["finality"]),
  settlement: Object.freeze(["fund", "markReady", "claim", "refund", "readOrder"]),
});

const has = (object, name) => object && typeof object[name] === "function";

/**
 * The verdict is a value, not an exception: `{ ok: true, capabilities }` or a named list of missing methods.
 * `require` may ask for a subset of capabilities; the default checks only the base role.
 */
export function legVerdict(leg, { require = ["identity", "balances", "refs", "finality"] } = {}) {
  if (!leg || typeof leg !== "object") return { ok: false, reason: "leg-absent" };
  const missing = [];
  for (const capability of require) {
    for (const method of LEG_ROLE_METHODS[capability] || []) {
      if (!has(leg, method)) missing.push({ capability, method });
    }
  }
  if (missing.length) return { ok: false, reason: "leg-incomplete", missing };
  const capabilities = leg.capabilities && typeof leg.capabilities === "object" ? leg.capabilities : {};
  const settlement = capabilities.settlement === true;
  if (settlement) {
    for (const method of LEG_ROLE_METHODS.settlement) {
      if (!has(leg, method)) return { ok: false, reason: "settlement-incomplete", missing: [{ capability: "settlement", method }] };
    }
  }
  return { ok: true, capabilities: { ...capabilities, settlement } };
}

/** The methods a settlement driver must add when it flips `capabilities.settlement` to true. */
export const SETTLEMENT_METHODS = LEG_ROLE_METHODS.settlement;
