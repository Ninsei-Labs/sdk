// WHAT A SETTLEMENT SIDE LOOKS LIKE, WITHOUT ASSERTING THAT A DRIVER EXISTS.
//
// The profile is metadata, not an implementation. It tells the SDK and the interface which address and transaction
// shapes a VM uses, and whether settlement is a contract, a program or a UTXO script. The driver registry
// (./index.mjs) stays the source of truth for what is RUNNABLE today.
//
// Bitcoin and its forks are listed here on purpose: a UTXO settlement side is a script/HTLC, not an account with an
// escrow contract. Listing the profile now keeps that difference out of the account-based code later. A profile is
// not a promise that the chain is selectable: `escrow: null` and the driver registry decide that.
export const VM_PROFILES = Object.freeze({
  // EVM: 20-byte hex addresses, a contract escrow, transaction hash, confirmation depth.
  evm: Object.freeze({
    vm: "evm",
    addressFormat: "hex-20",
    settlementKind: "contract",
    refKind: "address",
    txRef: "hash",
    finality: Object.freeze({ kind: "confirmations", blocks: 12 }),
  }),
  // TVM: base58check addresses on the wire (with a 0x41 hex form internally), a contract escrow and energy/bandwidth
  // instead of gas. The finality policy is a chain setting; 19 block confirmations is the SR round convention.
  tron: Object.freeze({
    vm: "tron",
    addressFormat: "base58check",
    settlementKind: "contract",
    refKind: "address",
    txRef: "hash",
    finality: Object.freeze({ kind: "confirmations", blocks: 19 }),
  }),
  // SVM: base58 addresses, a program with PDA accounts, a transaction signature, and a commitment level rather
  // than a block count.
  solana: Object.freeze({
    vm: "solana",
    addressFormat: "base58",
    settlementKind: "program",
    refKind: "pda",
    txRef: "signature",
    finality: Object.freeze({ kind: "commitment", level: "finalized" }),
  }),
  // UTXO: no account and no escrow contract. Settlement is an HTLC/adaptor-script output, addressed by a script
  // or an address, and identified by a txid. A fork uses the same shape with its own network parameters.
  bitcoin: Object.freeze({
    vm: "bitcoin",
    addressFormat: "base58check-or-bech32",
    settlementKind: "utxo-script",
    refKind: "script",
    txRef: "txid",
    finality: Object.freeze({ kind: "confirmations", blocks: 6 }),
  }),
  dogecoin: Object.freeze({
    vm: "dogecoin",
    addressFormat: "base58check",
    settlementKind: "utxo-script",
    refKind: "script",
    txRef: "txid",
    finality: Object.freeze({ kind: "confirmations", blocks: 6 }),
  }),
});

/** The profile for a VM, or null. An unknown VM is never silently treated as EVM. */
export const profileOf = (vm) => VM_PROFILES[vm] || null;

/** The profiles whose settlement side is an account + contract/program (not a UTXO script). */
export const ACCOUNT_VMS = Object.freeze(["evm", "tron", "solana"]);

/** The profiles whose settlement side is a UTXO script. */
export const UTXO_VMS = Object.freeze(["bitcoin", "dogecoin"]);
