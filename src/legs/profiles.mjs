// WHAT A SETTLEMENT SIDE LOOKS LIKE, WITHOUT ASSERTING THAT A DRIVER EXISTS.
//
// The profile is metadata, not an implementation. It tells the SDK and the interface which address and transaction
// shapes a VM uses, and whether settlement is a contract, a program or a UTXO script. The driver registry
// (./index.mjs) stays the source of truth for what is RUNNABLE today.
//
// Bitcoin is listed because the planned order is Tron, Solana, then Bitcoin; a UTXO settlement side is a
// script/HTLC, not an account with an escrow contract. A profile is not a promise that the chain is selectable:
// `escrow: null` and the driver registry decide that. Finality is not here: it is a chain policy, not a VM shape,
// and a generic "12 confirmations" is wrong for an L2. Add it to the chain that first needs it.
export const VM_PROFILES = Object.freeze({
  // EVM: 20-byte hex addresses, a contract escrow, a transaction hash.
  evm: Object.freeze({
    vm: "evm",
    addressFormat: "hex-20",
    settlementKind: "contract",
    refKind: "address",
    txRef: "hash",
  }),
  // TVM: base58check addresses on the wire (with a 0x41 hex form internally), a contract escrow and energy/bandwidth
  // instead of gas.
  tron: Object.freeze({
    vm: "tron",
    addressFormat: "base58check",
    settlementKind: "contract",
    refKind: "address",
    txRef: "hash",
  }),
  // SVM: base58 addresses, a program with PDA accounts, a transaction signature.
  solana: Object.freeze({
    vm: "solana",
    addressFormat: "base58",
    settlementKind: "program",
    refKind: "pda",
    txRef: "signature",
  }),
  // UTXO: no account and no escrow contract. Settlement is an HTLC/adaptor-script output, addressed by a script
  // or an address, and identified by a txid. A future Bitcoin-family chain uses the same shape with its own
  // network parameters. Taproot outputs (the likely shape of an adaptor-signature leg) are bech32m (BIP350), so
  // that format is named here next to the legacy bech32 (v0) and base58check forms.
  bitcoin: Object.freeze({
    vm: "bitcoin",
    addressFormat: "base58check-or-bech32-or-bech32m",
    settlementKind: "utxo-script",
    refKind: "script",
    txRef: "txid",
  }),
});

/** The profile for a VM, or null. An unknown VM is never silently treated as EVM. */
export const profileOf = (vm) => VM_PROFILES[vm] || null;
