# @ninsei-labs/sdk — the XMR ↔ EVM swap engine

The package is responsible for keys, proofs, halves, the recovery file, quotes, guards, contracts and talking to
the service. The interface is responsible for screens, layout and texts. The boundary is drawn by code, not by
agreement: there is nothing to lay out here, and nothing to compute there.

The package **knows nothing about the DOM**: neither `document`, nor `window`, nor `localStorage` (checked by
machine). The wallet arrives as an EIP-1193 provider, storage as an adapter, and the interface opens the windows.

## State (0.1.0)

| Surface | State |
|---|---|
| `config` — networks, tokens, limits, codes | works |
| `wallet` — EIP-1193 from outside, address, network, network switching, subscription | works |
| `preflight` — the engine's guards, answering with codes | works |
| `recovery.open` — parsing the recovery file | works |
| `sim` — sandbox scenarios and time | works (applying to a swap — stage 2) |
| `quotes.watch` | works: live indicative quotes, its own client; a snapshot carries the display fields (sides, networks, `why`, signature, age, maturity), and the size can be NAMED (`size`) |
| `quotes.firm` | answers `not-implemented` (stage 2: signing with a key and the order protocol) |
| `swaps.list` / `swaps.get` | read state from storage (and after a page reload) |
| `swaps.start` | holds the order: guards → recovery file and the person's confirmation → order → locking funds → **recording with us and watching the Monero address**; returns the named state `step: "xmr-incoming"` |
| `swaps.watch` | waits for XMR to arrive at the joint address with the same request as the page (`GET /swaps/{id}`): arrived — returns the fact (amount, confirmations, txid); did not wait — a refusal with the code `xmr-timeout`; already on the address but barred by `unlock_time` — a refusal with the code `xmr-locked` (the boundary is in `params.until`), and NO ready mark; with expectations and a wallet, places the ready mark after the arrival |
| `wallet.balances` | works: the native coin and tokens, in minimal units |

What is not ready names itself with the code `not-implemented` with the fields `surface` and `stage`: an empty
value that looks like data is more dangerous than a refusal.

## The contract

`index.d.ts` is the single source of truth about the API shape, and this is checked: `tools/check-sdk.mjs`
compares the list of what the SDK returns with what is declared in the contract (both ways).

```js
import { createNinsei } from "@ninsei-labs/sdk";

const sdk = createNinsei({
  settlement: { chain: "arbitrum-sepolia" },  // from sdk.config.chains; vm is taken from the registry
  xmrNetwork: "stagenet",
  apiBase: "/api",
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

Terminal states (`state.terminal`): `success`, `refunded_eth`, `xmr_returned`, `closed`.

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

`not-implemented`, `bad-input`, `wallet-not-connected`, `wallet-rejected`, `wrong-chain`, `quote-unavailable`,
`quote-refused`, `quote-stale`, `recovery-declined`, `recovery-failed`, `storage-unavailable`,
`server-unavailable`, `server-refused`, `xmr-timeout`, `xmr-locked`, `contract-reverted`, `insufficient-funds`, `unknown`.

Three refusals that are easy to merge into one are named DIFFERENTLY, because the advice differs:
`server-unavailable` — the service did not answer (retry); `server-refused` — it answered and did not accept (its
reason and status are in `params`; investigate); `xmr-timeout` — the wait for the XMR to arrive expired (this is a
state of the money, not a breakdown); `xmr-locked` — XMR is on the address but the transaction's `unlock_time`
barred it until a height or a date (`params.until`), so the funds are not an arrival and the ready mark is not
signed (issue #84).

## Quotes

```js
const stop = sdk.quotes.watch({ direction: "buy", token: "eth", amount: 1 }, (s) => render(s));
s.rate;        // the best offer's price: non-XMR coins per 1 XMR; null - there is no offer (this is not zero)
s.xmr;         // how much XMR for the entered amount (buy) or how much the person gives (sell)
s.sizeOk;      // does the size fall within the node's grid and range
s.sizeCode;    // why it does not: below-min | above-max | bad-size | no-offer
s.offers;      // all offers for the size; s.refused - rows that did not become offers
s.best;        // the best for the requested volume and side, AS THE SERVICE NAMED IT (pair and node)
stop();        // the last one to unsubscribe stops the polling
```

The size can be NAMED rather than derived: `watch({ direction, token, size }, cb)` — if the caller has already
aligned the volume to the provider's grid, the core asks for EXACTLY that size. An offer row and a refusal row
carry the pair's sides, both networks and the "named" marker, the provider's reason (`why`), the package's
signature, the age (`ageMs`) and the maturity level (`finality`) — display fields, not a second computation.

The price does not depend on volume: the volume is needed by the provider to say whether it takes such a size. So
the size is computed from the person's amount and is snapped to the node's grid **down**, and a size outside the
range is not aligned: it is the provider's refusal, and it arrives as a code. Indicative quotes commit to nothing;
`quotes.firm` commits (stage 2).

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

## Rules

1. **No DOM.** There is exactly one exception, and it is named: the `src/adapters` directory (the `localStorage`
   adapter is wired in explicitly, `@ninsei-labs/sdk/adapters`). The core loads in bare Node — this is checked.
2. **No texts.** Not a single user-facing phrase: only codes and params.
   Network -> virtual machine -> driver: the SDK takes networks from the engine's registry (`CHAINS`) rather than
   keeping its own list; a network without a driver is rejected by name (`not-implemented` with `vm` and the list
   of supported ones), rather than being assumed EVM.
   Storage arrives through the `storage` option and becomes the core's storage: the state of unfinished swaps and
   the agent session live where the interface decided. Without the option the core takes its default — web storage
   if it is present in the environment, otherwise process memory.
3. **The wallet is outside.** The SDK opens no windows and does not look for injected providers itself.
4. **The step order and the guards are inside `swaps.start`** (stage 2): funds are not locked until the interface
   has confirmed the recovery file is saved; retrying after an error or a reload is safe.
5. **Workers and WASM are separate files** from `assetsBase`, so the interface's bundler (Astro/Vite) does not
   touch them: `atomic/order-worker.js`, the Monero bundles.
6. **Strict CSP.** The package is designed for a policy without `eval` and inline.
7. **Zero dependencies.**
