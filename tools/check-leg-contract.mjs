// THE SETTLEMENT-LEG CONTRACT AND THE VM PROFILES (the compatibility groundwork for Tron, Solana and UTXO chains).
//
// No Tron or Solana driver is registered here on purpose: a profile says what a side LOOKS like, a driver is what
// can actually move money. This check keeps the two apart, and makes a future driver declare the whole settlement
// role before it can claim `settlement: true`.

import { LEGS, legVerdict, ACCOUNT_VMS, UTXO_VMS, profileOf, profileOfChain, normalizeSettlementRef } from "../src/legs/index.mjs";

export const legContractCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const baseMethods = ["walletChainId", "sameChain", "balances", "normalizeRef", "sameRef", "finality"];
  const settlementMethods = ["fund", "markReady", "claim", "refund", "readOrder"];

  for (const [name, leg] of Object.entries(LEGS)) {
    if (leg.vm !== name) problems.push(`${name}: vm is ${JSON.stringify(leg.vm)}`);
    for (const method of baseMethods) if (typeof leg[method] !== "function") problems.push(`${name}: ${method} is missing`);
    const verdict = legVerdict(leg);
    if (!verdict.ok) problems.push(`${name}: ${JSON.stringify(verdict)}`);
  }
  check(Object.keys(LEGS).length > 0, "no driver is registered");
  notes.push("every registered driver has the base role: " + Object.keys(LEGS).join(", "));

  const evm = LEGS.evm;
  check(Boolean(evm), "evm driver is absent");
  if (evm) {
    check(!(evm.capabilities && evm.capabilities.settlement === true), "evm claims settlement before the escrow reads/writes are here");
    const incomplete = legVerdict(evm, { require: ["identity", "balances", "refs", "finality", "settlement"] });
    check(!incomplete.ok, "an incomplete settlement driver passed");
    check(incomplete.missing && incomplete.missing.some((m) => m.capability === "settlement"), "the missing settlement methods are not named");
  }
  const complete = {
    vm: "test", capabilities: { settlement: true },
    walletChainId() {}, sameChain() {}, balances() {}, normalizeRef() {}, sameRef() {}, finality() {},
    ...Object.fromEntries(settlementMethods.map((name) => [name, () => {}])),
  };
  const verdict = legVerdict(complete, { require: ["identity", "balances", "refs", "finality", "settlement"] });
  check(verdict.ok, "a complete settlement driver did not pass: " + JSON.stringify(verdict));
  notes.push("settlement is a declared capability, not a driver name");

  for (const vm of ["evm", "tron", "solana", "bitcoin", "dogecoin"]) {
    const p = profileOf(vm);
    if (!p) { problems.push(`${vm}: no profile`); continue; }
    if (p.vm !== vm) problems.push(`${vm}: profile.vm is ${JSON.stringify(p.vm)}`);
    for (const field of ["addressFormat", "settlementKind", "refKind", "txRef", "finality"]) {
      if (p[field] === undefined || p[field] === null || p[field] === "") problems.push(`${vm}: ${field} is empty`);
    }
    if (!p.finality || !p.finality.kind) problems.push(`${vm}: finality kind is empty`);
  }
  for (const vm of ACCOUNT_VMS) if (profileOf(vm)?.settlementKind === "utxo-script") problems.push(`${vm}: account VM marked as UTXO`);
  for (const vm of UTXO_VMS) if (profileOf(vm)?.settlementKind !== "utxo-script") problems.push(`${vm}: UTXO VM not marked as UTXO`);
  if (profileOf("unknown-vm") !== null) problems.push("an unknown VM got a profile");
  notes.push("profiles cover evm/tron/solana and bitcoin/dogecoin");

  if (LEGS.tron || LEGS.solana || LEGS.bitcoin || LEGS.dogecoin) problems.push("a profile was registered as a driver");
  if (profileOfChain("tron") === null) problems.push("the tron network has no profile");
  if (profileOfChain("solana") === null) problems.push("the solana network has no profile");
  if (profileOfChain("bitcoin") === null) problems.push("the bitcoin network has no profile");
  notes.push("tron/solana/bitcoin are profiles, not drivers");

  const ref = normalizeSettlementRef("arbitrum", "0xABCDEF0123456789abcdef0123456789ABCDEF01");
  check(ref.vm === "evm" && ref.ref === "0xabcdef0123456789abcdef0123456789abcdef01", "the EVM ref is not canonical");
  let bad = null;
  try { normalizeSettlementRef("arbitrum", "TXYZ"); } catch (e) { bad = e; }
  check(bad && bad.code === "bad-input", "a non-EVM ref was not refused");
  let unsupported = null;
  try { normalizeSettlementRef("tron", "TXYZ"); } catch (e) { unsupported = e; }
  check(unsupported && unsupported.code === "not-implemented", "a Tron ref was not refused as not implemented");
  notes.push("the leg owns the reference format");

  return { note: "the settlement-leg contract and the VM profiles behave", problems, notes };
};
