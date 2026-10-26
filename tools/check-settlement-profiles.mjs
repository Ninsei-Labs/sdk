// THE VM PROFILES: METADATA FOR A SETTLEMENT SIDE, NOT A DRIVER AND NOT A FINALITY CLAIM.
//
// The planned order is Tron, Solana, then Bitcoin. Dogecoin is not on that list, so it has no profile. A profile
// describes the shape of a settlement side; the driver registry decides what is runnable today. Finality is a
// chain policy, not a VM shape, and is deliberately absent: a generic block count is wrong for an L2 and invites a
// caller to trust a number nobody uses yet.

import { createNinsei } from "../src/index.mjs";
import { LEGS, VM_PROFILES, profileOf, profileOfChain, vmOfChain } from "../src/legs/index.mjs";

export const settlementProfilesCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  const expected = {
    evm: ["hex-20", "contract", "address", "hash"],
    tron: ["base58check", "contract", "address", "hash"],
    solana: ["base58", "program", "pda", "signature"],
    bitcoin: ["base58check-or-bech32-or-bech32m", "utxo-script", "script", "txid"],
  };
  const keys = Object.keys(VM_PROFILES).sort();
  check(JSON.stringify(keys) === JSON.stringify(Object.keys(expected).sort()), "profile keys are " + keys.join(", "));
  check(profileOf("dogecoin") === null, "dogecoin still has a profile");
  notes.push("profiles: " + keys.join(", "));

  for (const [vm, fields] of Object.entries(expected)) {
    const p = profileOf(vm);
    if (!p) { problems.push(`${vm}: no profile`); continue; }
    if (p.vm !== vm) problems.push(`${vm}: profile.vm is ${JSON.stringify(p.vm)}`);
    const actual = [p.addressFormat, p.settlementKind, p.refKind, p.txRef];
    if (JSON.stringify(actual) !== JSON.stringify(fields)) problems.push(`${vm}: profile is ${JSON.stringify(actual)}`);
    if ("finality" in p) problems.push(`${vm}: profile carries a finality claim`);
  }

  check(profileOf("unknown-vm") === null, "an unknown VM got a profile");
  check(vmOfChain("dogecoin") === null, "dogecoin is a network with a VM");
  check(profileOfChain("dogecoin") === null, "dogecoin is a network with a profile");
  check(profileOfChain("tron") !== null, "tron has no profile");
  check(profileOfChain("solana") !== null, "solana has no profile");
  check(profileOfChain("bitcoin") !== null, "bitcoin has no profile");
  check(profileOfChain("arbitrum") !== null, "arbitrum has no profile");
  notes.push("tron/solana/bitcoin are profiles, not drivers");

  const evm = LEGS.evm;
  check(Boolean(evm), "evm driver is absent");
  if (evm) {
    for (const method of ["walletChainId", "sameChain", "balances"]) {
      check(typeof evm[method] === "function", `evm: ${method} is missing`);
    }
    check(typeof evm.fund !== "function", "evm claims a settlement method before a settlement driver exists");
  }
  check(!("tron" in LEGS) && !("solana" in LEGS) && !("bitcoin" in LEGS), "a profile was registered as a driver");
  notes.push("only evm is a registered driver");

  const sdk = createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet", mode: "sim" });
  for (const chain of ["arbitrum-sepolia", "tron", "solana", "bitcoin"]) {
    const c = sdk.config.chains.find((x) => x.id === chain);
    if (!c) { problems.push(`${chain}: no chain config`); continue; }
    if (c.settlementProfile?.vm !== c.vm) problems.push(`${chain}: settlementProfile.vm is ${JSON.stringify(c.settlementProfile?.vm)}`);
    if (c.settlementProfile && "finality" in c.settlementProfile) problems.push(`${chain}: config carries finality`);
  }
  const doge = sdk.config.chains.find((x) => x.id === "dogecoin");
  check(!doge, "dogecoin is in the chain registry");
  notes.push("chainConfig carries the profile and no finality");

  return { note: "the VM profiles describe future settlement sides without claiming a driver", problems, notes };
};
