// SETTLEMENT-LEG DRIVERS BY VIRTUAL MACHINE (VM).
//
// Why the seam was introduced right away, though one leg is implemented. Every VM has its own settlement side: for
// EVM it is a contract with an ABI and eth_* calls, for Tron its own contracts and its own resource model, for
// Solana a program and accounts. What they share is only the ROLE: deposit, mark ready, claim, refund, read
// state. So a "vm -> driver" map lives here, and the leg knows about this role, not about EVM: adding Tron or
// Solana means putting another file next to it and registering it HERE, touching neither the quotes, nor the
// Monero leg, nor the state machine.
//
// What must not be in a driver: no user strings, no DOM. A driver is chain reads and writes plus knowing what the
// network is measured in for this VM.
import * as evm from "./evm.mjs";
export { profileOf, VM_PROFILES, ACCOUNT_VMS, UTXO_VMS } from "./profiles.mjs";
export { LEG_ROLE_METHODS, SETTLEMENT_METHODS, legVerdict } from "./contract.mjs";
import { profileOf } from "./profiles.mjs";

export const LEGS = { evm };

/** VMs for which a driver already exists. The list is needed by the check and by the "this network is not supported yet" error. */
export const implementedVms = () => Object.keys(LEGS).sort();

/** The leg driver or null. The caller must decide what to do with null: EVM must not be silently substituted. */
export const legFor = (vm) => LEGS[vm] || null;

// --- NETWORK -> VIRTUAL MACHINE -> DRIVER ------------------------------------------------------------
// The SDK keeps no network table: the source of truth is the engine's registry (www/js/core/config.js). A copy
// here would silently drift from it, and the swap would go to the wrong network.
import * as engine from "../engine.mjs";
import { fail } from "../errors.mjs";

/** A registry network by id, or null. */
export const chainOf = (chainId) => (engine.config.CHAINS || []).find((c) => c && c.id === chainId) || null;

/**
 * The network's virtual machine. An unknown network is null: "evm" must not be substituted by default, otherwise a
 * network without a driver would travel the EVM path and refuse somewhere deep inside foreign code.
 */
export const vmOfChain = (chainId) => {
  const chain = chainOf(chainId);
  return chain && chain.vm ? chain.vm : null;
};

/** The VM profile for a network, or null when the network or the profile is unknown. */
export const profileOfChain = (chainId) => {
  const vm = vmOfChain(chainId);
  return vm ? profileOf(vm) : null;
};

/**
 * A canonical settlement reference for a network. The leg owns the format; an unsupported VM is refused by name,
 * never compared as if it were an EVM address.
 */
export const normalizeSettlementRef = (chainId, ref) => {
  const chain = chainOf(chainId);
  if (!chain) fail("bad-input", { field: "chain", chain: typeof chainId === "string" ? chainId : null });
  const leg = legForChain(chain.id);
  if (typeof leg.normalizeRef !== "function") fail("not-implemented", { surface: "settlement-ref", vm: chain.vm });
  const normalized = leg.normalizeRef(ref);
  if (normalized === null) fail("bad-input", { field: "settlementRef", vm: chain.vm });
  return { vm: chain.vm, chain: chain.id, ref: normalized };
};

/**
 * The leg driver for a network. A network without a driver is a NAMED refusal: you can see which vm is not
 * supported and which are. This is exactly the rule "no network is silently assumed to be EVM".
 */
export const legForChain = (chainId) => {
  const vm = vmOfChain(chainId);
  if (!vm) fail("bad-input", { field: "chain", chain: typeof chainId === "string" ? chainId : null });
  const driver = legFor(vm);
  if (!driver) fail("not-implemented", { surface: "legs", vm, implemented: implementedVms() });
  return driver;
};
