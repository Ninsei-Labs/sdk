# @ninsei-labs/sdk — the XMR ↔ EVM swap engine

The package is responsible for keys, proofs, halves, the recovery file, quotes, guards, contracts and talking to
the service. The interface is responsible for screens, layout and texts. The boundary is drawn by code, not by
agreement: there is nothing to lay out here, and nothing to compute there.

The package **knows nothing about the DOM**: neither `document`, nor `window`, nor `localStorage` (checked by
machine). The wallet arrives as an EIP-1193 provider, storage as an adapter, and the interface opens the windows.

## Coverage

The security-invariant map and the V8 line-coverage command are described in [`docs/coverage.md`](docs/coverage.md).

## Action decision

`actionDecision({ side, escrow, arrival, deviceTimeSec })` is the one pure rule for `refund`, `claim`, `markReady`,
`sendXmr`, `later`, `none` and `unknown`. The escrow cut, the #388 arrival verdict and both clocks are inputs; the
function never calls `Date.now()`. It returns the action allowed now, `untilSec` and a stable `reason`. The protective
margins are exported as `ACTION_DECISION_DEFAULTS`; a sale must pass the node's own send lead. The signing paths, the
site and the recovery page use this answer rather than carrying their own copies of the rule.

## Integration

The seam table, buy/sell/claim/recovery flows, retry and idempotency rules, cancellation semantics and the support
matrix are in [`docs/integration.md`](docs/integration.md). The declarations remain the source of truth for types.

## Security

Report suspected vulnerabilities through GitHub's private **Report a vulnerability** flow, not a public issue.
The supported versions, scope, response targets, safe-harbor rules and disclosure process are in
[`SECURITY.md`](SECURITY.md).

## State (0.62.0)

| Surface | State |
|---|---|
| `config` — networks, tokens, limits, codes | works |
| `wallet` — EIP-1193 from outside, address, network, network switching, subscription | works |
| `preflight` — the engine's guards, answering with codes | works |
| `recovery.open` — parsing the recovery file | works |
| `sim` — sandbox scenarios and time | works (applying to a swap — stage 2) |
| `quotes.firmRelay` | works: a firm quote through a relay, built from one recovery key; the node half is DLEQ-checked |
| `swaps.list` / `swaps.get` | read state from storage (and after a page reload) |
| `swaps.start` | holds the order: guards → recovery file and the person's confirmation → order → locking funds → **watching the Monero address**; no backend is required; returns the named state `step: "xmr-incoming"` |
| `swaps.watch` | waits for XMR at the joint address with the CLIENT's own check: `verify` carries the joint address, view secret, spend public key and witness nodes, and is mandatory — without it the watch refuses with `bad-input`. Arrived — returns the fact (amount, confirmations, txid) and the joint address; did not wait — a refusal with `xmr-timeout`; funds barred by `unlock_time` — `xmr-locked`; the maker DECLINED — `SwapDeclinedWatch` (`declined: true`, `terminal: "declined"`), every action off; with expectations and a wallet, places the ready mark after the arrival against the escrow, never against the Monero address |
| `swaps.verifyArrivalShadow` | the staging path for witness-v1: runs the exact walk and the fixed-slice walk side by side, without changing ready or refund. The slice request carries only the grid and slice; a node must name `protocol: "witness-v1"` |
| `swaps.startSell` / `swaps.sellClaim` / `swaps.claimViaRelay` | a sell is recorded from the verified relay offer; `sellClaim` claims from the claimer's own wallet, `claimViaRelay` claims with no wallet through the client's ordered sender list, paid by the signed `claimTip` |
| `wallet.balances` | works: the native coin and tokens, in minimal units |

What is not ready names itself with the code `not-implemented` with the fields `surface` and `stage`: an empty
value that looks like data is more dangerous than a refusal.

## Settlement legs and VM profiles

The settlement side is a driver, not a chain id switch. A VM profile says what that side looks like. The profile is
metadata: it does not make a network runnable, and it does not carry a finality claim - finality is a chain policy,
not a VM shape.

| VM | Address form | Settlement | Ref | Driver today |
|---|---|---|---|---|
| `evm` | `hex-20` | contract | address | yes |
| `tron` | `base58check` | contract | address | profile only |
| `solana` | `base58` | program | PDA | profile only |
| `bitcoin` | `base58check-or-bech32-or-bech32m` | UTXO script | script | profile only |

The planned order is Tron, Solana, then Bitcoin. Dogecoin is not on that list and has no profile. A profile is not
a driver: `LEGS` still holds only `evm`, so Tron, Solana and Bitcoin are refused by name until their own work lands.

`chainConfig(...).settlementProfile` returns the profile for the network, or `null` for an unknown VM. The check
`tools/check.mjs --only=settlement-profiles` guards the table, the absence of Dogecoin and the absence of a finality
claim. A future driver adds its own settlement methods; the profile alone never authorizes a fund, claim or refund.

## The contract

`index.d.ts` is the single source of truth about the API shape, and this is checked: `tools/check-sdk.mjs`
compares the list of what the SDK returns with what is declared in the contract (both ways).

EVERY PUBLISHED SUBPATH CARRIES ITS OWN DECLARATIONS: `.` (`index.d.ts`), `./xmr`, `./order`, `./evm`,
`./core`, `./networks`, `./recovery`, `./provider`, `./relay` (`src/public/<entry>.d.ts`) and `./adapters`
(`src/adapters/index.d.ts`). Each of them declares exactly the symbols its barrel re-exports, so a typed consumer sees
the same surface the runtime has, and nothing else.
`tools/check.mjs --only=types` keeps the two sides equal (a subpath without a `types` target, a declarations
file that does not read as declarations, or a symbol declared on one side only is red), and
`tools/check-types-teeth.mjs` is its breaking run.

```js
import { createNinsei } from "@ninsei-labs/sdk";

const sdk = createNinsei({
  settlement: { chain: "arbitrum-sepolia" },  // from sdk.config.chains; vm is taken from the registry
  xmrNetwork: "stagenet",
  assetsBase: "/sdk/",
  mode: "live",                     // or "sim"
});

sdk.config.evmNetwork.tokens        // the token list: the interface does not hardcode it
import { evmWallet } from "@ninsei-labs/sdk/adapters";
sdk.wallet.use(evmWallet(eip1193Provider));   // the adapter is brought by the interface, the SDK opens no windows
await sdk.wallet.connect({ chainId: sdk.config.settlement.chain.chainId });
const verdict = await sdk.preflight(quote, { payBalanceWei, payAmountWei });
if (!verdict.ok) render(verdict.blockedBy);   // codes, not phrases
```

A local anvil deployment is supplied by the caller, because a fresh `Deploy.s.sol` changes the factory and cashier
addresses:

```js
const sdk = createNinsei({
  settlement: { chain: "local-anvil", escrow: { address: factory, cashier, implementationCodeHash } },
  xmrNetwork: "fakechain",
});
```

The override is refused for a public network. `testnet` and `fakechain` have an empty node map by default; pass
`nodes: { testnet: [...] }` or `addNodes: [...]` to name the nodes that witness the arrival.

## Code tables

It is the interface that must show the person anything based on these codes: the SDK has not a single
user-facing string.

### Steps (`state.step`)

| Code | What it means |
|---|---|
| `awaiting_funding` | nothing has arrived at the Monero address yet |
| `funded` | ETH is in escrow, waiting for XMR |
| `maker_locking` | the maker is depositing XMR |
| `xmr_locked` | XMR is at the address, confirmations are coming in |
| `ready` | the "checked by you" mark has been placed |
| `claimed` | the maker took the ETH |
| `swept` | the XMR has been sent to the recipient's address |

Terminal states (`state.terminal`): `success`, `refunded_eth`, `closed`, `declined`.

`xmr_returned` WAS HERE AND IS GONE, AND SO IS THE STATE IT NAMED AS A TERMINAL. When the depositor does not place
the ready mark in time the maker takes the XMR back — and the swap does NOT end there: the depositor's ETH is still
in the escrow, so it is a PHASE of a live swap, not a terminal. `state.phase` is then `xmr_reclaimed` (the code an
interface branches on, while `state.terminal` stays `null`), and the swap ends later as `refunded_eth` when the ETH
goes back. The code exists because that phase used to be the shared `refund_available`, which the "maker never
locked the XMR" situation sets too: the two could only be told apart by comparing a label.

`declined` — THE MAKER REFUSED A FUNDED ORDER (issue #40). The escrow sets `refunded` and emits
`Declined(claimer)`, so `status()` alone reads it exactly like any other refund; the SDK tells the two apart by
that EVENT (the chain, read through `evmLogs`) or by the node's status `declined` with the code `compliance` (the
wire). Either source stops the wait for XMR at once and ends the swap as `declined` with EVERY action off: the
whole balance, the fee included, is already back in the wallet and no half was revealed, so there is nothing to
recover — no recovery file is needed and no manual refund is offered. NO reason, category or provider travels
with it (the node returns only `compliance`, on purpose), and the neutral sentence a person reads is the
interface's: this package holds no user-facing string.

### Checks (`preflight().checks[].code`)

| Code | What is checked | From which guard kinds |
|---|---|---|
| `balance` | is there enough to pay | `balance-enough`, `balance-short`, `balance-unchecked` |
| `gas` | is anything left for gas | `gas-enough`, `gas-short`, `reserve-unstated`, `native-unchecked` |
| `allowance` | the token allowance | `allowed`, `not-needed`, `allowance-short`, `allowance-unchecked` |
| `consent` | the person's consent to the allowance | `consent-missing` |
| `network` | the wallet's network against the settlement network | `network-match`, `wallet-network`, `wallet-unknown`, `network-unknown` |
| `settlement-network` | on which settlement network the swap is counted | `settlement-network` |
| `stale` | is the quote's deadline alive | `fresh`, `stale`, `no-ttl`, `untimed`, `expired` |
| `deadline` | the mark and claim windows from the chain | `deadlines-ok`, `deadlines-unstated`, `ready-by-in-past`, `t1-not-after-ready-by`, `ready-window-too-short`, `claim-window-too-short` |
| `range` | the size within the node's range | `in-range`, `above-max`, `below-min`, `range-unstated`, `unit-mismatch` |
| `size` | is the size named at all | `size-unstated`, `amount-unstated` |
| `escrow-state` | the escrow state on the chain | `new`, `already-funded`, `already-claimed`, `already-refunded`, `state-unchecked`, `off-step` |
| `escrow-points` | points and halves against the chain | `points-match`, `point-mismatch`, `commit-mismatch`, `points-unchecked` |
| `counterparty` | the counterparty is real, not a stand-in | `real-provider`, `standin-on-production` |
| `slots` | slots in the order book | `slots-match`, `slots-unchecked` |
| `unchecked` | could not be computed | `unchecked` |
| `unknown` | a kind not in the table | — |

`checked: false` means "not measured", not "good": the interface must show this separately from green.
`params` carries the numbers the verdict was taken from (`need`, `have`, `symbol`, `min`, `max`, `expiresAt`, ...).

### Errors (`error.code`, `SdkError.code`)

`not-implemented`, `bad-input`, `wallet-not-connected`, `wallet-rejected`, `caller-refused`, `wrong-chain`, `quote-unavailable`,
`quote-refused`, `quote-too-short`, `quote-recipient-unreceivable`, `quote-expired`, `address-denied`, `quote-stale`, `recovery-declined`,
`recovery-failed`, `storage-unavailable`, `xmr-address-mismatch`, `server-unavailable`, `server-refused`,
`claim-unknown`, `xmr-timeout`, `xmr-locked`, `contract-reverted`, `insufficient-funds`, `unknown`.

Several refusals that are easy to merge into one are named DIFFERENTLY, because the advice differs:
`server-unavailable` — the service did not answer (retry); `server-refused` — it answered and did not accept (its
reason and status are in `params`; investigate); `xmr-timeout` — the wait for the XMR to arrive expired (this is a
state of the money, not a breakdown); `xmr-locked` — XMR is on the address but the transaction's `unlock_time`
barred it until a height or a date (`params.until`), so the funds are not an arrival and the ready mark is not
signed (issue #84). `caller-refused` — the caller's own `wallet.send` threw a string code the SDK does not own; the
original is in `params.callerCode`, and the person is not told to reconnect.
`address-denied` (issue #16) - the address is on the interface's `denylist` (refused before any
request) or the node's own `denied-address` refusal, WITHOUT the node's `why` text and WITHOUT the address: the
interface shows its own neutral message.

## Quotes

The SDK has one quote path: a relay. `quotes.firmRelay` derives the client half and both view points from one
recovery key, sends one request, verifies the relay answer and the on-chain registry/factory binding, and returns
the signed `orderQuote` with its `startRequest`. There is no direct node client, no quote book and no route table
in the package; a host that needs an indicative book keeps it in the host.

```js
const offer = await sdk.quotes.firmRelay({ relayUrl, features, order, side: "ask", recoveryKey, xmrAmount });
offer.orderQuote;   // the signed quote the factory takes
offer.startRequest; // quote, order, orderQuote, counterparty, recovery salt and predicted escrow for swaps.start
```

A buy quote must keep `LOCK_START_MARGIN_SEC` (30 s) plus `START_PREP_SEC` (15 s) after the relay answer has been
verified. `quotes.firmRelay` refuses a shorter one with `quote-too-short` before a confirmation is shown, and returns
`remainingSec` / `confirmBySec` so the host can show the time left and disable its button. A bid quote is checked only
for its own expiry: the node has already funded the escrow and the client opens no wallet. The lock step then checks only
the 30 s margin: the preparation was already spent between the answer and the send.

`quotes.firmRequest({ features, side, market, xmrNetwork, chainNow })` selects the one signed window for that market,
side and Monero network and places `readyBy` and `t1` inside it on the chain's clock. `firmRelay` uses the same
selection; two windows for one market on different networks are refused unless `xmrNetwork` names the one to use.

The money arithmetic is exported from `@ninsei-labs/sdk/evm`: `feeWeiFor` and `principalForTotal` for a buy,
`salePayoutBeforeClaim` for the guaranteed minimum (null when the tip was left out or unreadable) and the seller-sent
figure, and `salePayoutAfterClaim` for the amount actually paid (judged by the contract's `msg.sender`, not `tx.from`).
For a direct claim the caller may pass
the transaction's `{ to, from }` and the `escrow`: `from` is used only when `to` is that escrow, while a claim routed
through another contract stays unknown. A fee rate is a whole number from 0 to
200; a missing, empty, fractional or out-of-range rate is refused rather than read as zero, while an explicit `0` is
valid. `fundingGasReserveWei` is the Max reserve: `GAS_CREATE_ORDER_AND_FUND × maxFeePerGas`; `orderGasReserveWei`
remains the mark/refund reserve. Balance answers are accepted only as an ETH JSON-RPC quantity or one 32-byte ABI
word; anything else is `null` (unknown) and never zero. The sale's `monero:` URI amount comes from `formatXmr` in
`@ninsei-labs/sdk/core`, not a second formatter.

## Selling and claiming

A bid is a sale of XMR. `quotes.firmRelay({ side: "bid", claimTip, ... })` returns the signed quote, the escrow,
the one-time address, the `relayUrl` that answered and the node's `readyWindow`. `swaps.startSell` stores all of
them, including the relay origin and the window, and sends nothing. The window's `readyMinSeconds` and
`readyMaxSeconds` drive the sale watch, the late-arrival boundary and the refund lead; a record without it is
refused by name when the watch or the refund needs it. The send-xmr gate still uses its confirmation lead
(`xmrConfirmations * xmrBlockTimeSec`, or `limits.sellReadyLeadSec` when set).

A seller who has their own EVM wallet uses the own-wallet path. It signs the claim from that wallet and therefore
needs ETH for gas:

```js
await sdk.swaps.sellClaim({ id }, wallet);
```

A seller who has XMR but no ETH uses the relay path. The escrow pays the signed `claimTip` to the sender, so the
relay submits the half and is paid from the claim itself. No wallet is created or used, and no chain transaction is
signed by the client:

```js
const sell = await sdk.swaps.startSell({ offer });
const relaySender = offer.claimSender; // GET /v1/relay; the relay origin that answered
const claimed = await sdk.swaps.claimViaRelay({ id: sell.id,
  claimSenders: [...(relaySender ? [relaySender] : []), ...otherListedMakers] });
if (claimed.state === "claimed") {
  claimed.txid;         // the claim transaction, or null when the escrow itself showed claimed
  claimed.from;         // the sender node's claim sender
  claimed.tipWei;       // null: a relay answer or the status alone does not prove the tip was paid
  claimed.promisedTipWei; // the tip signed in the order
} else if (claimed.state === "claim-window") {
  claimed.reason;  // not-ready | window-closed | settlement-margin | not-funded | unreadable | escrow-refused | escrow-refunded
} else {
  claimed.secondsLeft; // no sender landed it: claim yourself before t1
}
```

`tipWei` is the tip the chain actually paid, not the signed tip. `claimViaRelay` has no claimer fact: the escrow
status alone does not name one, and a relay's answer is not proof that its transaction is the one that landed.
Under the #409 rule only a confirmed direct claim with `{ to, from }` proves the sender, so this method reports
`tipWei: null` and names the signed value separately as `promisedTipWei`. A seller's own claim pays none.

`claimSenders` is the client's ordered list: the relay's own sender first, then other listed makers. `startSell`
stores a list only when the caller passes `claimSenders`; otherwise the offer's published `claimSender` becomes a
one-element list. An explicit list replaces that published sender; it is never prepended. `claimViaRelay({ id })`
uses the stored list, while a request `claimSenders` replaces it. The old scalar `claimSender` is retired and
refused by name; the claim result names the sender that landed it as `provider`. The SDK tries one sender at a
time for a 15-30 s slot. A refusal moves on at once; a txid is not success - the SDK reads the escrow until it
says `claimed` or the slot ends. The deal's maker and its quote-key owner are refused before the half leaves the
client. When the list is exhausted the result is `state: "claim-yourself"` with `t1` and `secondsLeft`.

The claim window is the escrow's, not the relay's. Before every sender the SDK reads `ready`, `readyBy` and `t1`
from the chain. Without the ready mark before `readyBy`, at or after `t1`, or inside the 120 s settlement margin
(plus the sender's slot and time for the seller's own claim), it returns `state: "claim-window"` with a named
`reason` and posts nothing. An escrow read that fails before any send is `claim-window` / `unreadable`; if an earlier
attempt may already have sent the half, it is `claim-unknown` with `why: "escrow-unread"`. It is never reported as
`claim-yourself`. A relay answer such as `claim-not-ready` or `claim-window-closed` stops the list instead of
passing the half to the next sender. Relay-level answers (`rate_limited`, `bad_request`, `unsupported_version`,
`no_quote`) are `claim-unknown`, not a sender refusal; the sender keeps its slot and the list continues.

`claimViaRelay` reads the sell record made by `startSell` and requires a positive `claimTip`, the escrow and the
half. It posts to the relay origin stored with the record; an optional `relayUrl` may repeat that origin but a
different one is refused. A node refusal keeps its code under `quote-refused.params.code`. A timeout or a body
without a real transaction hash is `claim-unknown`: the claim may have been sent, so the SDK reads the escrow and
moves on only after the slot. Only an escrow that reads `claimed` is success.

Each sender is written to the record before its POST. The log is diagnostic, not a skip list: a later call starts
at the first sender again. The latest attempt is waited out for its slot and then retried, whatever its outcome;
a `refused` or `unconfirmed` entry is retried after that slot, not before it. This is what makes a temporary relay failure, a restart or
a closed tab recoverable. A sender's slot starts when it is entered, not when its POST returns; `pollMs` has a
250 ms floor and `timeoutMs` a 120 s ceiling. The relay gate also reserves the settlement margin, so `sellWatch` can
still report its own-wallet `claim-open` while `claimViaRelay` has already stopped. A refunded escrow is
`claim-window` with `reason: "escrow-refunded"`, not a request to claim; recovery is the next step.

`claimAttempts` is append-only and the SDK does not prune it: a long-lived record can grow with every retry. The
journal is diagnostic, not a spendable state. A host may trim older entries, but it must keep the latest
`sending` or `unknown` entry: that slot is waited out before the sender is tried again. Do not use the journal as
proof that a sender is finished.

The claim window uses the escrow's chain time, read with `evmBlock` (or the wallet's block provider), not the
device clock. If neither clock is available, the client refuses with `claim-window` / `unreadable` before the half
leaves; it does not fall back to `Date.now()`. `secondsLeft` is derived from that same chain time.

`actions.claim` is unchanged: it still sends only from the claimer's own wallet, because the half is revealed by
whoever sends the claim.

## Order reads: one block, terms, lookup and funding

`order.read(escrow, deps)` asks four questions at one block tag: `status()`, the ready mark and both deadlines.
It returns the decoded values plus `{ number, hash, timestamp }` from that same tag. A block reader that answers
another height, or a missing one, is `bad-input`; the result never mixes a latest value with a newer block header.

`order.history` reads terms and settlement events from logs in one address-filtered request. Supply `escrows` with a
`fromBlock`, or a recovery key and let `findSwaps` name them first; an explicit list without a range is refused. Terms come from `OrderTerms`, so `amount`, `feeBps`, `fee`,
`feeRecipient` and `claimTip` are present; state comes from `HalfRevealed`, `Ready` and `Declined`. Removed logs are
dropped. The result carries a `checkpoint` of `{ number, hash }`; pass the previous result's `escrows` as
`previous` to resume, and the read merges the events above the checkpoint. It resumes only when that block still has
the same hash; otherwise it drops `previous`, replays from `fromBlock` and says `replayed: true`.

`order.lookup(escrow, request)` starts from the escrow address, returns its creation block and hash, and joins the
terms. `found: false` means the creation event was not in the requested range, not that the escrow is unknown.

`order.funding({ escrow, validUntil, finality })` returns `pending`, `landed` or `expired`. An address with code and a
funded status is `landed`; an address with no code is `pending` until the signed `validUntil` and `expired` from it.
The contract answer and the block timestamp are read at the same finality tag. With `network`, the default is the
SDK's own table for that network (Arbitrum: `safe`); a caller can name `latest`, `safe` or `finalized` explicitly.
A depth network without a named finality is refused: its tags are formal and calling one final would overstate it.

The recovery search start is one rule for every client. `recoverySearchStart` returns the shared 360,000-block day
grid line below a key made at `madeBlock`, never below the factory deployment. `recoveryStartBlock` applies the whole
rule: that day line when the node's head has reached it, otherwise the block at the key's UTC month start less one
day (`startAt` and the caller's `blockAt`), otherwise the deployment. `findSwaps` accepts `madeBlock`, `startAt`,
`head` and `blockAt`, so the RPC sees the same range every client would use. `findSwaps` also accepts `madeBlock`
alone for the common day-grid case.

## Found orders and the paying token

`findSwaps` returns the orders whose commitment came from the recovery key. An order is found from the public `salt`
in its own `OrderCreated`: the binding is `ninsei-taker-v2|<chain>|<factory>|taker|<salt>`, so the same words on
another device or at another factory produce a different half and no number is reserved. The result says
`derivation: "salt-v2"` and has no index. There is no index range scan and no `max-index` result: every order in the logs is
read once, and an unreadable log request is a refusal, not a partial answer. `madeBlock` moves the shared
`recoverySearchStart` line, not a per-key range.

`readEscrowEventsByTopic` reads the same three settlement events (`HalfRevealed`, `Ready` and `Declined`) without
an address filter: the caller receives every event in the block range and filters by `escrow`. This is the
privacy-preserving path for a recovery page, because the RPC does not learn which escrows belong to the visitor.
`readEscrowEvents` keeps only the escrows named in its request, and both readers drop logs marked `removed`.

The transport is separate from the decoder. `createSettlementLogReader({ rpcs, fetchImpl?, timeoutMs?, maxWindow? })`
returns the `evmLogs` seam: it tries the caller's RPCs in order, splits a refused numeric range down to one block, and
for a single block that every RPC refuses it reads `eth_getBlockReceipts` by block number only and applies the address
and topic filters locally. A tag range cannot be subdivided, so a refusal there is the named unknown. If the evidence
cannot be completed the reader throws `recovery-failed` with `stage: "logs"`; an incomplete read is unknown, never an
empty list. The caller owns the RPC list, so the SDK does not bake in public endpoints or a browser CORS policy.

`sweep.relay` returns `outcome: "sent"` with the transaction ids. If the wallet throws or returns no transaction id,
the answer is `sweep-relay-unknown`: the session token, the signed set and any known txids stay in the open session.
The same token never relays that set again. Check the chain before signing a new withdrawal.

`sweep.reconcile` is the later answer when the token is gone and only the signed bytes remain. It asks the chosen
trusted node two direct questions, with no block walk: `/get_transactions` for the signed hash and
`/is_key_image_spent` for its verified inputs. `present` means the hash is in a block or in the pool; `inputs-spent`
means the hash is absent but an input moved; `unknown` means the node could not answer completely and the bytes stay;
only `absent` with `resend: true` permits the same bytes, with the same hash, to be sent once. A partial, malformed
or substituted answer is `unknown`, never an absence. A present hash is answered without sending the key images.
On the absent branch those inputs go to that node; key images are linkable, so the node must be one the caller trusts.

`sweep.sign` refuses with `sweep-scan-incomplete` unless `sweep.restore` first completed a full scan on that same
wallet adapter; a behind-node, failed rescan or missing spent status is not a zero balance. A public node that refuses
the optional `rescanSpent` pass no longer fails the restore: the full scan is kept and the result names
`spent-status-unavailable`. A sweep that needs more than one transaction is refused with `sweep-split`; it is never
split silently. Both `sweep.sign` and `swaps.start` check the destination with `checkAddress`, so a bad checksum or an
address for another Monero network is refused before a wallet or a funding send.

`sweep.sign` also requires the verified unspent `keyImages` (strings or records from `sweep.keyImages`). It reads the
signed transaction's inputs from the wallet library and refuses `sweep-inputs-changed` unless that set is exactly the
verified one; an opaque signed transaction that cannot expose its inputs is `sweep-inputs-unknown`. `sweep.relay`
requires a fresh `keyImages` list and checks it again before sending; a changed set leaves the session open and sends
nothing. `sweep.run` passes the same list it used for signing, so a fresh post-sign read is a `sign` → `relay` pair.

A window spent check counts status `2` as spent in the pool. A short, long or non-integer `spent_status` list is not a
spent count: `spent` is null and `scanComplete` is false with `scanIncompleteReason: "spent-status-unavailable"`.
A window with a valid trusted-node answer is complete even when the wallet's height is below the node's: a block that
landed after the sync does not unscan the lock's blocks. Without that valid answer the window stays incomplete.

- `amount` — the escrow's **native** amount in wei;
- `settlementToken: "native"` — what the escrow receives;
- `xmrAmount` — the XMR side, read from the clone's condition word 18 when an `evmCode` reader is passed;
- `payToken: null` and `payTokenReason: "not-on-chain"` — the asset the person actually paid before the DEX leg.

The reason is structural, not an omission. `OrderCreated` and the clone carry no token field, and the current escrow is
native-only. A user may have paid USDC, USDT or DAI, but that happened in the DEX leg and lives in the quote/order
record, not in the settlement contract. Inventing a token from the pair or the UI would be a claim the chain cannot
support.

When a token is needed, the order can be joined with an off-chain quote record by the caller. A future ERC-20 escrow
would have to put the token into the signed quote and the clone (and therefore a new order format and factory); only
then can `findSwaps` return it from the chain and set `payTokenReason` to something other than `not-on-chain`.

`swaps.start` takes the client-owned `recoverySalt` when the signed quote already carries that salt; it must equal
`order.salt`. `newRecoverySalt()` draws a fresh 32-byte value, and `takerHalvesV2()` derives the halves without
touching the index allocator.

The found order also carries the Monero start height and the reason it is absent. `no-block-time`,
`monero-nodes-unreachable` and `monero-network-mismatch` are different answers: a missing settlement timestamp is not
a dead node, and a node on another network is not an absent reader. A page that starts swaps without the SDK's start
path must use the order's own public salt; there is no number to reserve or check.

A revealed half published as `h + n` (the alias the escrow accepts) is reduced modulo the secp256k1 order before the
sweep key check, so it rebuilds the same key and remains withdrawable.

`recovery.open` accepts the file as text or `{ contents }`: the envelope is parsed at the boundary, so a valid file
opens and a non-JSON one fails with its own `parse` stage.

The per-swap recovery file start path is gone: a start requires the one recovery key, shown and confirmed before
funding, and a file that could not name the escrow is no longer produced.

`moneroFeeEstimate` reports the daemon's per-byte `fee`/`fees` and its `quantization_mask`; `feeForBytes` multiplies
the price by the transaction size (1024 bytes at 20000/byte is 20,480,000).

A range scan says whether it was complete: `scanRange` returns `complete: false`, `missingHeights` and
`incompleteReason: "blocks-unreadable"` when a block, a BUSY transaction answer or a missing transaction hash leaves
the range partial.

A height lock is judged at the witnessing node's tip, not at the block that mined the transfer; confirmations still
use the inclusion height.

A split sweep reports the sum of every signed transaction's fee, not only the first; one unreadable fee makes the
total unknown.

A failed settlement block-time read keeps the matched order: `findSwaps` returns `blockTime: null` with
`startHeightReason: "block-time-read"` instead of throwing away every row.

Pass `evmBlockTimes` to read the timestamps for every distinct matched block in one request. It receives the block
numbers in first-seen order and returns a map; a `null` or missing entry is `no-block-time`, while an `Error` entry
is `block-time-read`. When the batch seam is supplied it is the only timestamp reader: `evmBlockTime` is not called,
even after a failed batch. Without the seam, the older `evmBlockTime` path stays in use.

The retired backend no longer decides a swap: its watch row may observe money, but it cannot declare readiness or
a decline; the client's two-node check and the escrow's own `Declined` event do.

Storage is a refusal, not a silent empty state: a failed read, corrupt JSON, a failed write or remove is
`storage-unavailable` with a step. Every SDK instance gets its own store over the adapter it was given, so two
clients with different adapters keep separate records and neither takes over the other's.

Funding is reported from the receipt, not from the send. A status-0 receipt is `contract-reverted`; a missing
receipt, a receipt without `OrderCreated`, or an event from another factory is `funding-pending` with the transaction
hash, and `swaps.start` does not save an escrow or retire a recovery number in that state.

The predicted escrow and its salt are written to the pending record before the funding transaction is sent. A retry
after a late receipt or a process restart finds that record by the salt, the chain, the factory and the predicted
escrow, and reads the same transaction; it does not build a second side or send a second deposit. An explicit wallet
rejection clears the pending mark so the person can sign again. A transaction that was already mined is stopped by
the escrow state guard; one still in the mempool can make the resend revert and cost gas, but cannot create a second
deposit.

The wallet adapter accepts the standard Monero network names (`mainnet`, `stagenet`, `testnet`, `fakechain`) and
still checks the address shape, so a mainnet withdrawal is not refused because the demo registry lists only
stagenet. The withdrawal window retries a `429`, a timeout or a `5xx` before it gives up. If the window still cannot be read,
`restoreWallet` falls back to the full scan and reports `window.fallback: true` with `fallbackWhy: "window-read"` and
the node's status; a withdrawal is not refused because the node was busy. In a full scan, when the wallet cannot reach
the node's height, the result says `scanComplete: false` with `scanIncompleteReason: "sync-failed"`,
`"rescan-failed"`, `"behind-node"`, `"no-heights"` or `"spent-status-unavailable"`; a zero balance in that state is not
an empty wallet. A window uses its bounded scope instead: a valid trusted-node answer makes it complete even after a
later block, while an unreadable answer stays `spent-status-unavailable`.

## Extending to other networks (Tron, Solana and beyond)

The package name is deliberately common: the shared part — the quote client, the Monero leg, the state machine,
recovery, the codes — stays the same for any settlement chain. The extension is done through three seams, and none
of them requires edits in the core:

| Seam | What it is | What a new network adds |
|---|---|---|
| `sdk/src/legs/` | the leg driver registry: `vm → driver` | a driver file (`vm`, `walletChainId`, `sameChain`, then — deposit/mark/claim/refund/read state) and one registration line |
| `sdk/src/adapters/` | wallet and storage | `tronWallet(...)`, `solanaWallet(...)` next to `evmWallet(...)` |
| the contract | `settlement.vm`, `counterparty.{chain,vm,leg}`, the check codes | nothing: the names already name a role, not a chain |

What is already ready for this now: a network without a driver answers `not-implemented` and **names** the vm,
rather than being assumed EVM by default; an adapter must be for the same vm as the settlement network; the driver
registry is checked for completeness (a half-added driver reddens the check).

Separately, about what is already in place:

- **The authorization method** is set by the adapter, not the core: `evmWallet(provider)` accepts any EIP-1193
  provider (injected, WalletConnect, your own broker), and for another VM its own adapter will stand next to it.
  The core needs only `connect`, `address`, `chainId`, `subscribe` and `driver()`. If a signer without a provider
  appears (a local key, a hardware wallet, MPC), the adapter will gain a "sign" capability — that is an edit of one
  interface, not a rewrite of the swap.
- **Executing the DEX leg and aggregators.** The route-provider registry already exists in the EVM driver:
  `routeProviders()` and `routeProviderFor(id)`, a requirement for a provider — `id`, `kind`, `shape`, `plan(...)` and, for `shape: "async"`, `settled(...)`.
  One provider is declared: `declared` (our routes; execution — stage 3). An external aggregator (1inch and the
  like) is added **by a file and a line in the registry**, and the order of preference is set by options
  (`routing: { prefer: [...] }`) and checked against the registry: an unknown identifier is `bad-input`, not
  "we'll try and see". The pre-signature guards (the price is not market, the amount is covered, the token
  allowance) stay shared by all providers: otherwise an external route would become a hole in those very guards.

Bitcoin is a separate case and, most likely, a separate SDK: it has no contract in the EVM-contract sense, the leg
is done by a script (HTLC or a signature adapter), and the wallet needs PSBT rather than a provider. The shared
core is reused in that case: quotes, the Monero leg, states and recovery do not depend on the settlement chain.

The check codes tied to EVM are named plainly: `allowance` (token allowances) and `gas` (the network-fee margin)
trigger where those exist; on another VM they simply do not appear, rather than turning into "all good".

## Pull requests

Open a pull request as a draft. The CI battery, license check, house-rules check and dependency scan stay skipped
while the pull request is a draft, so an intermediate push does not spend runner minutes. Run the local checks
while you work. Mark the pull request ready only when the branch is final; that starts the full battery. A push
after that runs it again, so keep the work in draft until the last commit.

## Rules

1. **No DOM.** There is exactly one exception, and it is named: the `src/adapters` directory (the `localStorage`
   adapter is wired in explicitly, `@ninsei-labs/sdk/adapters`). The core loads in bare Node — this is checked.
2. **No texts.** Not a single user-facing phrase: only codes and params.
   Network -> virtual machine -> driver: the SDK takes networks from the engine's registry (`CHAINS`) rather than
   keeping its own list; a network without a driver is rejected by name (`not-implemented` with `vm` and the list
   of supported ones), rather than being assumed EVM.
   Storage arrives through the `storage` option and becomes THAT INSTANCE'S swap store: the state of unfinished
   swaps lives where the interface decided. Without the option the instance takes the default — web storage if it
   is present in the environment, otherwise process memory. Actions read the chain through the provider of the
   wallet adapter they were given, not through a process-wide provider.
3. **The wallet is outside.** The SDK opens no windows and does not look for injected providers itself.
4. **The step order and the guards are inside `swaps.start`** (stage 2): funds are not locked until the interface
   has confirmed the recovery file is saved; retrying after an error or a reload is safe.
5. **WalletConnect is the host's connector.** The SDK ships no vendor bundle and loads no connector at runtime; a page that wants mobile wallets loads `@walletconnect/ethereum-provider` itself (from its own lock or a pinned CDN asset), draws the QR, and passes the resulting EIP-1193 provider to `evmWallet(provider)`. A page without it works with injected wallets only. Monero mnemonic, key and address code is part of the package core: it needs no separate file and no vendored browser bundle.
6. **Strict CSP.** The package is designed for a policy without `eval` and inline.
7. **Few dependencies, all permissive.** Every production dependency is checked in CI against an allowlist: MIT, MIT-0,
   ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, Unlicense, 0BSD, CC0-1.0 and BlueOak-1.0.0. Copyleft,
   source-available, unknown or missing licences fail `pnpm run check:licenses`; the licence texts travel in
   [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and the policy is in [LICENSE-POLICY.md](LICENSE-POLICY.md).

## Releases and prereleases

Every published version rides on an npm dist-tag, and the tag is **derived from the version** - never left to
npm's default:

| Version | npm dist-tag | What it is |
|---|---|---|
| `X.Y.Z` | `latest` | a release - a separate decision, and the only thing that moves `latest` |
| `X.Y.Z-develop.N` | `develop` | a build for ourselves |
| `X.Y.Z-preview.N` | `preview` | a build to show |

The loop this serves: build a version for yourself (`0.40.0-develop.1`), publish it under `develop`, and have the
demo pin the **exact** version (`"@ninsei-labs/sdk": "0.40.0-develop.1"`) rather than a tag. `latest` does not
move, so `npm install @ninsei-labs/sdk` keeps serving the last real release. Shipping a release is then its own
decision: a plain `X.Y.Z`, the only shape that publishes under `latest`.

Every publish, a prerelease too, comes from a commit on `main` whose CI run on the push to `main` passed. The release
workflow checks both before it builds, for a tag and for a manual run that publishes, and refuses any other commit; a
CI run still going is waited for, at most 60 minutes. A dry run builds any branch.

The tag is passed to `npm publish` explicitly (`--tag <tag>`), and `tools/npm-tag.mjs` refuses the two ways this
can go wrong **by name** - a prerelease that would take `latest`, and a plain version that would slide into a
channel someone else owns. A manual run of the release workflow may override the tag with an input; when it does,
the log says so. The derivation and its refusals are covered by `node tools/npm-tag.test.mjs`.

Before the tag, the version constant moves with the version: `npm run sync:version` writes `src/version.mjs` from
`package.json`. The number is BAKED into the code on purpose - a page cannot fetch `package.json`, and the file
need not be served beside a bundle - so `npm run check` refuses both a mismatch and a runtime read of it.
