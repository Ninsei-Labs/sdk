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
| `evmBlock` | Quote tip and block-time checks | `(tag?) => Promise<{ timestamp, baseFeePerGas?, baseFeeWei?, priorityFeePerGas?, maxPriorityFeePerGas?, gasPrice?, ... }>`; the priority fee may be explicit or derived from `gasPrice - baseFee`; an unread block is a named refusal, not zero. |
| `evmLogs` | Decline and order event reads | `({ address, topics, fromBlock, toBlock }) => Promise<logs>`. |
| `fetch` | HTTP and Monero-node probes | `fetch`-compatible function. Required only for paths that perform network reads. |
| `createRecord` | A host-owned swap record | Optional capability. The default record builder is part of the SDK. |

`driver()` on an EVM wallet must return the same EIP-1193 provider that signs. The SDK uses it for action reads and
for the latest block; a different provider would let the guard read a different chain than the wallet signs on.

## 4. Buy flow

The host normally follows this sequence:

1. Build the offer or choose the provider.
2. Call `quotes.firmRelay` for the flow; there is no direct quote route in the SDK.
3. Show the signed terms and the recovery key to the person.
4. Call `swaps.start` with the quote, the wallet and the confirmation that the recovery key is saved. A relay answer
   carries `startRequest` with the quote, order, orderQuote, counterparty, recovery salt and predicted escrow; add
   your wallet, `receiveTo` and height and pass it through.
5. Watch the Monero arrival with `swaps.watch`.
6. Mark ready only after the arrival is confirmed; claiming and refunding are separate actions.

A buy quote must keep `LOCK_START_MARGIN_SEC` (30 s) plus `START_PREP_SEC` (15 s) of life after the relay answer has
been verified. If less is left, `quotes.firmRelay` refuses with `quote-too-short` before the host shows a confirmation.
The answer also carries `remainingSec` and `confirmBySec`, so the host can show the time left and disable its confirm
button at the deadline. A sell quote is checked only against its own expiry: the node has already funded the escrow
and the client opens no wallet. The lock step then checks only the 30 s margin, because the preparation was already
spent between the answer and the send.

The SDK refuses to lock funds until the host confirms that the recovery key is saved. Do not reorder these steps in
the UI: the recovery file is the only way to recover the XMR if the tab is lost.

For the bid side, the relay path returns the signed quote and the maker view half; pass the verified answer to
`swaps.startSell`, which records the one-time address and the escrow. Do not build the order context or the
encryption envelope in the host, and do not pass a bid answer to `swaps.start` (it refuses a sell).

## 5. Sell flow

`swaps.startSell` records the one-time address, the escrow, our half, the chosen `claimSender`, the expectations and
the relay origin that answered the quote. It sends no transaction. The same offer retried returns the same record
with `resumed: true`; a changed commitment, claim sender or relay origin is refused rather than silently resumed.

There are two claim paths, and the host picks by what the seller holds:

- `swaps.sellClaim({ id }, wallet)` - the own-wallet path. The claimer signs the claim, so the wallet must hold
  enough native coin for gas. This path is unchanged, and `actions.claim` still refuses a sender that is not the
  claimer.
- `swaps.claimViaRelay({ id })` - the no-wallet path. The seller has XMR and no ETH; the escrow pays the signed
  `claimTip` to the sender, so the relay that answered the quote submits the half. The sender is a listed maker
  OTHER than the deal's maker, chosen by the client and stored by `startSell` as `claimSender`; no wallet is created
  or used and the client signs no chain transaction.

`claimViaRelay` requires a sell record with a positive `claimTip` and the stored sender, escrow and half. A record
made before the sender was stored may pass `claimSender` once; it is stored on the record then. A sender naming the
deal's maker or its quote key owner is refused before the half leaves the client. It does not take a relay from the
caller after the quote: an optional `relayUrl` may repeat the stored origin, and any other origin is refused with
`bad-input`. The node's refusal keeps its own code under `quote-refused.params.code`. A timeout, a reset or a body
without a real transaction hash is `claim-unknown`: the claim may already be sent, so read the escrow before acting
again, and never treat the lost answer as a success. Only a validated txid is returned. The half is never logged or
written by this path.

The sell record also keeps the node's signed `readyWindow`. `sellWatch`, the late-arrival boundary and
`refundIfXmrMissing` use its `readyMinSeconds`/`readyMaxSeconds`; a record without the window is refused with
`bad-input` and `field: "readyWindow"` instead of falling back to the retired local constants.

## 6. Claim, refund and ready

`actions.markReady`, `actions.claim` and `actions.refund` require the order expectations. They read the escrow slots
before signing and then pass the expected sender to the wallet adapter. The adapter reads `eth_accounts` and
`eth_chainId` again immediately before `eth_sendTransaction`; a changed account or chain is a refusal and the
transaction is not sent.

A claim reveals the claimer's half. `actions.claim` and `swaps.sellClaim` send a claim only from the claimer's own
wallet. A seller with no wallet uses `swaps.claimViaRelay`; it returns only a real txid, refuses a foreign relay
origin and reports a lost answer as `claim-unknown`, never as success.

## 7. Recovery

The recovery key is one BIP39 key, saved once. The v2 binding includes the chain, factory, role and public order
salt, so a different factory produces a different half. The host must never log, send or persist the mnemonic in
analytics, crash reports or a backend.

`recovery.open` parses the file with a passphrase. `recovery.restoreHeight` reports the height and where it came
from; a missing height is a named state, not zero. The host may use the public log search from the recovery
subpath, but only public order data leaves the client.

## 7a. The arrival shadow

Production arrival still uses `swaps.verifyArrival`: first operator walks from the order's start height, and every
witness is asked for the located block so the observations can be compared. Before slice-only verification is
enabled, `swaps.verifyArrivalShadow` runs that exact check and a `witness-v1` slice check side by side:

```js
const shadow = await sdk.swaps.verifyArrivalShadow({
  ...arrivalRequest,
  witnessNodes: [{ url: "https://witness.example", operator: "partner", protocol: "witness-v1" }],
});
```

The slice request is `{ version: 1, network, grid: 20, slice }`. It contains no start height, payout block, txid or
order id; a URL without `protocol: "witness-v1"` is refused rather than guessed. A slice below the tip has 20 blocks;
the slice that contains the tip ends at the top and sets `complete: false` with `tip: {height, hash}`. A tip above the
top the client read is accepted because a block can arrive during the walk; a tip below it is refused. A walk counts as
complete only when it reached the highest top any source reported: a witness behind the exact nodes cannot complete an
absence for the blocks it did not see. Only synchronized exact nodes raise that target; a stale or down node's height
is ignored. The same witness must answer `get_info` and the slice's `get_transactions` reads;
the node-side contract describes those routes.
`shadow.exact` still decides; `shadow.agrees` and `shadow.problems` exist for staging and logs. A shadow mismatch must
never be turned into a refund or a ready mark. `shadow.witness.quorum` names the required two distinct operators,
the completed ones, the independent ones and whether the quorum is met; two instances of one operator count once.
On mainnet the Ninsei walker is not one of the two votes, so only `independent` counts. The quorum is evidence
for the refund path and does not change `agrees` while the shadow is read-only.

## 8. Retry and idempotency

| Operation | Retry rule |
| --- | --- |
| Quote | A retry is a new quote unless the host reuses the same signed answer. Do not treat a timeout as a successful quote. |
| `swaps.start` | Reuse the same quote and recovery salt. The SDK resumes an existing record when the terms match; a changed offer is refused. |
| `swaps.startSell` | The same offer resumes the same record; a changed commitment is `quote-refused`. |
| `swaps.claimViaRelay` | A `claim-unknown` answer means the claim MAY have been sent. Read the escrow before calling again; do not resend the half on a guess. |
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
`wrong-account`, `storage-unavailable`, `claim-unknown`, `xmr-timeout`, `xmr-locked`, `xmr-address-mismatch`,
`quote-too-short`, `contract-reverted`, `wallet-rejected` and `not-implemented`.

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
