// SECURITY INVARIANTS -> THE CHECKS THAT EXERCISE THEM.
//
// A percentage of lines is not a security argument. This map is the reviewable half: every invariant names the
// files it constrains and the scripts that exercise it. tools/check-security-invariants.mjs refuses an invariant
// with no check, a dangling script path or a critical file that no invariant names.

export const SECURITY_INVARIANTS = [
  {
    id: "SEND-01",
    statement: "A signing action re-reads the account and chain at the send boundary and refuses a mismatch before eth_sendTransaction.",
    files: ["src/actions.mjs", "src/chainGuard.mjs", "src/adapters/evm-wallet.mjs"],
    checks: ["tools/check-chain-guard.mjs", "tools/check-claim-sender.mjs"],
  },
  {
    id: "QUOTE-POLICY-01",
    statement: "Factory and implementation code policy has one explicit semantic for absent, null, empty and populated lists.",
    files: ["src/quotes.mjs", "src/index.mjs", "src/factoryPolicy.mjs"],
    checks: ["tools/check-relay-adapter.mjs", "tools/check.mjs"],
  },
  {
    id: "QUOTE-TTL-01",
    statement: "A relay quote expiry is a safe integer in the future; an expired quote is refused with its own code.",
    files: ["src/quotes.mjs", "src/relayFirmClient.mjs"],
    checks: ["tools/check-relay-http.mjs", "tools/check-relay-adapter.mjs"],
  },
  {
    id: "QUOTE-TIP-01",
    statement: "A signed claim tip is bounded by the measured claim cost; a non-zero tip without a block read and a tip above the ceiling are named refusals.",
    files: ["src/quotes.mjs"],
    checks: ["tools/check-claim-tip.mjs", "tools/check-relay-adapter.mjs"],
  },
  {
    id: "DLEQ-01",
    statement: "A cross-curve proof carries knowledge proofs for both curves and a pure-multiple witness is refused.",
    files: ["engine/atomic/dleq2.js", "src/relayRequest.mjs"],
    checks: ["tools/check-dleq-vectors.mjs", "tools/check-dleq-oracle.mjs", "tools/check-relay-request.mjs"],
  },
  {
    id: "RECOVERY-01",
    statement: "Recovery halves are bound to chain, factory, role and public salt; the mnemonic never leaves the client.",
    files: ["src/recovery-key.mjs", "src/recovery.mjs", "src/public/recovery.mjs"],
    checks: ["tools/check-recovery-key.mjs", "tools/check-recovery-open.mjs"],
  },
  {
    id: "STORE-01",
    statement: "A failed or corrupt store is a named refusal, and two clients with different stores cannot read or delete each other's records.",
    files: ["engine/core/store.js", "src/swaps.mjs"],
    checks: ["tools/check-storage.mjs"],
  },
  {
    id: "RELAY-01",
    statement: "The relay transcript, fee, answer and retry path are checked; a retry preserves the request bytes.",
    files: ["src/relayFirmClient.mjs", "src/relayQuote.mjs", "src/relayRequest.mjs"],
    checks: ["tools/check-relay-request.mjs", "tools/check-relay-answer.mjs", "tools/check-relay-http.mjs", "tools/check-relay-features.mjs", "tools/check-relay-terms.mjs", "tools/check-relay-view.mjs"],
  },
  {
    id: "STATE-01",
    statement: "A swap cannot claim before readiness, cannot settle twice, and a terminal refusal is not reported as success.",
    files: ["src/swaps.mjs", "src/swap-flow.mjs", "src/actions.mjs"],
    checks: ["tools/check-terminal-teeth.mjs", "tools/check-action-state.mjs", "tools/check-funding-receipt.mjs"],
  },
  {
    id: "ARRIVAL-01",
    statement: "An XMR arrival is counted only against the signed amount and the agreed confirmation rule; locked funds are not an arrival.",
    files: ["src/xmr-arrival.mjs", "src/swaps.mjs", "engine/monero/scan.js"],
    checks: ["tools/check-arrival-consensus.mjs", "tools/check-arrival-real.mjs", "tools/check-arrival-extra-keys.mjs"],
  },
  {
    id: "ADAPTER-01",
    statement: "The production adapter barrel exposes only the documented adapters, and its public subpath carries declarations.",
    files: ["src/adapters/index.mjs", "src/adapters/evm-wallet.mjs"],
    checks: ["tools/check-chain-guard.mjs", "tools/check.mjs"],
  },
];

export const SECURITY_CRITICAL_FILES = [
  "src/actions.mjs",
  "src/chainGuard.mjs",
  "src/quotes.mjs",
  "src/factoryPolicy.mjs",
  "src/recovery-key.mjs",
  "src/relayFirmClient.mjs",
  "src/relayQuote.mjs",
  "src/relayRequest.mjs",
  "src/swaps.mjs",
  "src/swap-flow.mjs",
  "src/xmr-arrival.mjs",
  "engine/atomic/dleq2.js",
  "engine/core/store.js",
  "src/adapters/index.mjs",
  "src/adapters/evm-wallet.mjs",
  "src/index.mjs",
];
