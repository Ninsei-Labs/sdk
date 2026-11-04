# Integration contract

This guide is for a host application that embeds `@ninsei-labs/sdk`. It describes the seams the host must provide,
the order in which the SDK uses them, and the failure semantics the host must preserve. The declarations in
`index.d.ts` remain the source of truth for exact types; this document explains how to use them safely.

## 1. What the SDK owns

The SDK owns the swap state machine, quote checks, DLEQ and recovery derivation, calldata construction, the
sender/chain guards and the recovery file. The host owns screens, layouts, copy, the wallet UI and the decision to
show a confirmation.

The host must not recompute halves, proofs, order terms, EIP-712 payloads or calldata. Use the SDK methods and pass
their results through unchanged.

## 2. Install and construct one client

```js
import { createNinsei } from "@ninsei-labs/sdk";

const sdk = createNinsei({
  settlement: { chain: "arbitrum-sepolia" },
  xmrNetwork: "stagenet",
  mode: "live",
  // apiBase: "https://your-service", // only when the host provides a backend
});
```

One client owns one storage adapter and one wallet session. Two clients with different storage adapters are
isolated; do not reuse a storage adapter between tenants.

## 3. Required seams

| Seam | Required for | Contract |
| --- | --- | --- |
| `storage` | Persisting swaps and the recovery key | `get` / `set` / `remove`, all synchronous. The core store is synchronous; a promise-returning adapter is not supported. A failed read/write is `storage-unavailable`, never an empty state. |
| wallet adapter | Any action that signs or reads the wallet | `vm`, `connect`, `disconnect`, `address`, `chainId`, `subscribe`, `driver`, plus `send` / `receipt` for actions. `evmWallet(provider)` is the EVM implementation. |
| `evmCall` | Quote policy, order slots, contract state | `({ to, data }) => Promise<hex>`. If absent, action guards read through the wallet adapter's `driver()` provider. |
| `evmCode` | Factory/implementation code checks | `(address: string) => Promise<hex>`; without it the code-hash policy cannot be applied. |
| `evmBlock` | Quote tip and block-time checks | `(tag?) => Promise<{ timestamp, ... }>`; an unread block is a named refusal, not zero. |
| `evmLogs` | Decline and order event reads | `({ address, topics, fromBlock, toBlock }) => Promise<logs>`. |
| `fetch` | HTTP and Monero-node probes | `fetch`-compatible function. Required only for paths that perform network reads. |
| `serverAuth` | Authenticated service routes | `() => Promise<string>` or a ready bearer token, depending on the route. Missing auth is a named service refusal. |
| `createRecord` | A host-owned swap record | Optional capability. The default record builder is part of the SDK. |

`driver()` on an EVM wallet must return the same EIP-1193 provider that signs. The SDK uses it for action reads and
for the latest block; a different provider would let the guard read a different chain than the wallet signs on.

## 4. Buy flow

The host normally follows this sequence:

1. Build the offer or choose the provider.
2. Call the quote method for the flow (`quotes.firm`, `quotes.firmRelay` or `quotes.sale`).
3. Show the signed terms and the recovery key to the person.
4. Call `swaps.start` with the quote, the wallet and the confirmation that the recovery key is saved.
5. Watch the Monero arrival with `swaps.watch`.
6. Mark ready only after the arrival is confirmed; claiming and refunding are separate actions.

The SDK refuses to lock funds until the host confirms that the recovery key is saved. Do not reorder these steps in
the UI: the recovery file is the only way to recover the XMR if the tab is lost.

For the bid side, the relay path returns the signed quote and the maker view half; pass the verified answer to
`swaps.startSell`, which records the one-time address and the escrow. Do not build the order context or the
encryption envelope in the host, and do not pass a bid answer to `swaps.start` (it refuses a sell).

## 5. Sell flow

`swaps.startSell` records the one-time address, the escrow, our half and the expectations. It sends no transaction.
The same offer retried returns the same record with `resumed: true`; a changed commitment is refused rather than
silently resumed. Use `swaps.sellClaim` with the record and the wallet when the time comes to claim.

## 6. Claim, refund and ready

`actions.markReady`, `actions.claim` and `actions.refund` require the order expectations. They read the escrow slots
before signing and then pass the expected sender to the wallet adapter. The adapter reads `eth_accounts` and
`eth_chainId` again immediately before `eth_sendTransaction`; a changed account or chain is a refusal and the
transaction is not sent.

A claim reveals the claimer's half. The SDK sends a claim only from the claimer's own wallet. A host that needs a
third-party sender must use the relay flow, not `actions.claim`.

## 7. Recovery

The recovery key is one BIP39 key, saved once. The v2 binding includes the chain, factory, role and public order
salt, so a different factory produces a different half. The host must never log, send or persist the mnemonic in
analytics, crash reports or a backend.

`recovery.open` parses the file with a passphrase. `recovery.restoreHeight` reports the height and where it came
from; a missing height is a named state, not zero. The host may use the public log search from the recovery
subpath, but only public order data leaves the client.

## 8. Retry and idempotency

| Operation | Retry rule |
| --- | --- |
| Quote | A retry is a new quote unless the host reuses the same signed answer. Do not treat a timeout as a successful quote. |
| `swaps.start` | Reuse the same quote and recovery salt. The SDK resumes an existing record when the terms match; a changed offer is refused. |
| `swaps.startSell` | The same offer resumes the same record; a changed commitment is `quote-refused`. |
| `actions.markReady` / `claim` / `refund` | Do not send a second transaction while the first outcome is unknown. Keep the transaction hash and re-read the receipt; a repeated call is not a substitute for an unknown receipt. |
| `swaps.watch` | The wait may be repeated; it reads the same Monero address and does not create an order. |
| `recovery.open` | Pure local parsing; safe to repeat. |

An HTTP timeout means the request outcome is unknown. It does not mean the service did nothing. Preserve the same
bytes on an idempotent retry where the SDK provides one, and never turn a timeout into an empty success.

## 9. Timeouts, cancellation and unknown outcomes

- A local timeout or `AbortSignal` stops waiting; it does not cancel an on-chain transaction that was already sent.
- A missing receipt is `not yet`, not `failed`. Keep the hash and ask again later.
- A revert is a terminal refusal for that transaction; it does not prove that no earlier transaction was mined.
- On restart, reconstruct state from the SDK records and the chain, not from a screen-local variable.

## 10. Errors and codes

Every refusal carries a stable code and parameters; the host maps codes to its own copy. Never display a raw
exception or a code as a user-facing sentence. Important groups include quote refusals, `wrong-chain`,
`wrong-account`, `storage-unavailable`, `xmr-timeout`, `xmr-locked`, `contract-reverted`, `wallet-rejected` and
`not-implemented`.

See `src/codes.mjs` and `index.d.ts` for the current unions. Code values are part of the integration contract; a
new code is a compatibility event and should be called out in the release notes.

## 11. Support matrix

- ESM only.
- Node.js 24.22.1 or newer for the package build and Node consumers.
- Browser use requires a bundler that understands the package `exports` map and the `assetsBase` path.
- EVM wallets must expose EIP-1193 `request`, `eth_accounts`, `eth_chainId`, `eth_sendTransaction` and
  `eth_getTransactionReceipt`. WalletConnect is supported through the same adapter shape.
- Monero signing is supplied by the host's monero-ts wallet factory; the SDK does not bundle WASM in the core.

## 12. Security rules for integrators

- Do not log mnemonics, private keys, recovery-file plaintext or raw signing payloads.
- Do not send recovery words to a service, analytics provider or error tracker.
- Do not substitute the wallet provider between the guard and the send; the adapter's boundary checks are there
  for a reason.
- Do not retry a claim or refund after an unknown outcome with a new transaction without first checking the
  existing hash and state.
- Use a local chain or testnet for integration tests; never test against other people's funds.
- Report vulnerabilities through the private process in `SECURITY.md`.

## 13. Migration notes

The public surface is pre-1.0 and may still change, but changes to recovery derivation, quote policy, error codes
and action semantics are compatibility events. Read the release notes for the affected version and update the host
before moving a live deployment. In particular, do not assume that a v1 recovery file and a v2 salt binding are
interchangeable.
