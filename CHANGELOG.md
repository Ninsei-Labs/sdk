## 0.38.0 — 2026-10-02

XMR that is ON the address but BARRED by the transaction's `unlock_time` is not an arrival, and the ready mark is
not signed under it (issue #84).

- **A third answer with its own code.** `swaps.watch` already named two answers - the arrival (a fact) and the
  expired wait (`xmr-timeout`). Money that is on the address but cannot be spent until a height or a date is a
  THIRD one: the refusal `xmr-locked`, with `params.lockedXmr` and `params.untilHeight`/`untilTime` (numbers and
  their kind, never text). A `xmr_locked` session status is enough - the core does not re-derive arrival from the
  amount.
- **ONE rule, read from its owner.** "Has the XMR arrived" is decided by the service, which alone reads the
  chain's outputs (`app/indexer.mjs`, `unlockStateOf`: `0` - arrival; below 500 000 000 - a block height; at or
  above - a unix time). The core and the page consume the NAMED state instead of writing a second rule.
- **The dictionary says until WHEN.** `www/js/sdk/codes.js` carries the phrase for `xmr-locked` on both languages
  and renders `untilTime` as a UTC date.
- Checks: SDK 231 (was 229), the code dictionary 29, the order flow 26, the guard 257 - all green; the new
  `tools/check-xmr-unlock.mjs` holds the rule, the store, the core and the dictionary, plus a live section that
  feeds a REAL chain transaction (with its `unlock_time` changed in one field) through the indexer's own scan.

## 0.37.0 — 2026-10-02

The package is SELF-SUFFICIENT: `import "@ninsei-labs/sdk"` works from a directory OUTSIDE the repository — it
creates a client and answers calls.

- **The engine seam no longer reaches outside the package.** `sdk/src/engine.mjs` re-exported the engine through
  `../../www/js/...`; inside a tarball those files do not exist, so a consumer's import died with
  `ERR_MODULE_NOT_FOUND` while the types still compiled. The modules the core depends on now live under
  `sdk/engine/` and the seam points there.
- **Why a verified mirror and not a move.** The same modules are loaded by the demo page in the browser, and the
  production web root is `www/` alone — the `sdk/` directory is not served there. Lifting the files out of `www/js`
  would 404 every engine import on the live site, and dozens of repository checks read those sources by their
  `www/js` path. So the single source of truth stays `www/js`; `tools/build-sdk-engine.mjs` generates the copy and
  `tools/check-sdk-engine.mjs` verifies it byte-for-byte (the rule `build-sweep` already uses for `sweep/lib` and
  `rfq/lib`).
- **37 modules are mirrored**: the 16 seam roots plus everything they import statically or dynamically inside
  `www/js`. The heavy vendor bundles stay external (`assets/vendors/...`), loaded dynamically inside functions.
- **Two check expectations moved to the new location.** `tools/check-sdk.mjs` shares module state with the core
  through `store.js`/`auth.js`; those imports now point at `sdk/engine/...`, the modules the SDK actually loads —
  the assertion kept its meaning, only the path followed the module. `tools/check-sdk-package.mjs` scans
  `sdk/engine` for bare imports too, and `tools/validate.mjs` fails if the mirror drifts from `www/js`.
- **Proven** (outside the repository): `npm pack` -> install -> import creates a client and answers six calls;
  `tsc --noEmit` on the consumer is green; and removing one mirrored file makes the same import fail with
  `ERR_MODULE_NOT_FOUND` naming that exact file. The rebuilt browser bundle is byte-identical to one built from the
  `www/js` sources.
- Checks: SDK 229, the package 17, the engine mirror 8 (new), the guard 257, the sell page 42, the book 41, the code
  dictionary 28, assets 13, the order flow 26, browser ones 21/6/18, the live lock run 32 — all green.

## 0.36.0 — 2026-10-02

The indicative quote book on the form comes FROM THE CORE: the form migration is on the bridge.

- **`quotes.watch` asks the book for the size the caller named.** A new optional field `QuoteRequest.size` (in units
  of `unit`: buy — XMR, sell — token). Whoever has already aligned the volume to the provider's grid hands it here —
  the core asks for EXACTLY it, rather than deriving the size from `amount` anew. Without `size` the behaviour is as
  before: the size is derived from the amount and refined on the next tick.
- **The snapshot carries the fields the screen draws.** For an offer and for a refusal — the pair's sides
  (`asset`/`currency`), both networks and the "named" marker (`assetNetwork`/`currencyNetwork`/`networkStated`),
  `networksDerived`/`networksUnnamed`, the provider's reason `why`, the package's signature `signature`/`keyId`, the
  age `ageMs` and the maturity level `finality`; a REFUSAL is returned as a whole row (the range, the price and the
  mark are not trimmed — the screen has something to name the provider's boundary with). The previous assembled view
  of the networks (`networks`) is kept. The selection and priority rules did not change: they stay in `readBook`.
- **`QuoteSnapshot.best`** — the best for the requested volume and side, AS THE SERVICE NAMED IT (pair and node).
  The core does not recompute the price: the interface confirms its own "best" mark with it.
- **A named coarsening:** a connection refusal in the snapshot is called by a CODE (`quote-unavailable`), not by the
  transport's text; the words for a person are made by the interface's dictionary (`www/js/sdk/codes.js`).
- Checks: SDK 229, the guard 257, the sell page 42, the book-at-the-core 14 (a new probe
  `tools/check-quotes-core.mjs`), rfq-ui 41, the code dictionary 28, assets 13, the order flow 26, browser ones
  21/6/18.

## 0.32.0 — 2026-10-01

The "server" step: the swap is recorded with us, the XMR arrival is watched, and the wait names itself.

- `swaps.start` NO LONGER runs into `not-implemented {step:"server"}`: after the lock the swap is recorded with our
  service BY THE SAME request as the interface's — `POST /api/evm-swaps`, body
  `{ id, network, escrow, quoteId, providerId, hashlock, amount, t0, t1 }` (www/js/evm/auth.js:111-125;
  accepted by `app/server.mjs:1230`, a pass is mandatory — `app/server.mjs:1232`) — and a watch is opened on the
  joint Monero address: `POST /api/swaps` with the address, the VIEW key and the expected amount
  (www/js/ui/views/confirm.js:581-588, www/js/core/chainSource.js:178). The NAMED state `step: "xmr-incoming"` is
  returned with the fields `server` and `watch`, not "success".
- A new `swaps.watch({ id, escrow?, pollMs?, timeoutMs?, expect?, wallet?, onStep? })`: it polls
  `GET /api/swaps/{id}` — the same path as the page — and either returns the FACT of the arrival (the amount, the
  confirmations, the txid) or refuses with a SEPARATE code `xmr-timeout`. An empty response is not counted as an
  arrival (`server-unavailable { why: "bad-response" }`, answers immediately); a zero at the address is "we are
  waiting" (the timeout). When `expect` and `wallet` are passed, after the arrival the ready mark
  (`actions.markReady`) is called WITH THESE expectations: the slot check against the chain stands in it before the
  signature. Expectations without a wallet (and vice versa) — `bad-input`.
- New codes: `server-refused` (the service answered and did not accept: the status and its reason in `params`) and
  `xmr-timeout`. "Did not answer", "answered and refused" and "the wait expired" are three different states with
  three codes.
- New options: `serverAuth` — a pass to our service (only a wallet can sign the sign-in message, so the sign-in
  remains the interface's: www/js/evm/auth.js, `signIn`; an empty pass gives a named 401 refusal, not silence) and
  `watch: { pollMs, timeoutMs }` — the rate and the timeout of the watch polling; the defaults are taken from the
  engine's settings (`API.pollMs`; `blockTimeReal x confirmTarget`), not hardcoded.
- The "server" step's paths are named BY NAMES and declared in the routes table: `swap` (`/swaps/{id}`) and
  `evmSwaps` (`/evm-swaps`) next to the previous `swaps`, `orderQuote`, `revealedHalf`, `swept`.
- The escrow address FROM THE RECEIPT and the funding height (`birthHeight`) are written into the swap record:
  previously, after the lock, the record remained with the predicted address and the watch went out with height 0.
- Checks: 226 (was 200), 0 failures. New cases: the mark's path/method/body, the pass in `Authorization`, the
  service's refusal and its unavailability by separate codes, the arrival seen as a fact, emptiness not counted as an
  arrival, the timeout actually waited out, the ready mark signed only after the arrival and only with expectations.
  Breaking runs: "an empty response is an arrival" (a copy with weakened parsing), a substituted mark body field, a
  substituted mark path — all three go red; `sdk/src/swaps.mjs` was restored byte for byte.
- **A live run on the local contour** (`node tools/live-lock-run.mjs`, the key only from the environment/file): the
  mark went to the same path and with the same body (`POST /api/evm-swaps -> 201, saved: true`), the watch was opened
  (`POST /api/swaps -> 201`, a real stagenet address), the state was named "waiting for XMR at the address", and the
  wait ended with the code `xmr-timeout` after the assigned timeout. The run's result: 32, 0 failures. There was no
  XMR arrival at the address — that is NAMED by the waiting step, not passed off as completion.

# Changelog

Format: version — date. Before 1.0 a breaking change bumps the minor version and is accompanied by a migration
instruction. Entries are not deleted.

## 0.35.0 — 2026-10-02

Words instead of codes and the XMR withdrawal page on the core — the interface migration is closed.

- **The refusal dictionary**: `www/js/sdk/codes.js` — the single place where a core code becomes a phrase (en+ru),
  with detail from the params (the step, the field, the status, what was lacking). **An unknown code is shown as is**
  — swallowing it would mean hiding future errors. The check `tools/check-error-words.mjs` (28) requires a phrase
  for EVERY core code and breaks if an unknown code is replaced with the word "unknown". The copy for the withdrawal
  page is verified by sha256: there cannot be a second revision of the phrases.
- **The XMR withdrawal page on the core**: parsing the file — `recovery.open`, the plan — `sweep.plan`, the keys —
  `sweep.keys`, the wallet — the Monero adapter, the balance and height — from the node, the withdrawal —
  `sweep.sign` (signing WITHOUT sending) and `sweep.relay`, the repeat report — `sweep.report`. The order and the
  rule "an empty remainder stops the withdrawal" are counted by the core; the page does not repeat them.
- The core grew for this: `sweep.sign`/`relay`/`report` (the "sign without sending" point is separated from sending —
  otherwise the page would have to repeat the step order), the `SweepApi` contract, the XMR networks from one list
  (`STANDARD_XMR_NETWORKS` — previously the contract promised three networks, but only one was accepted).
- Defects found and closed along the way: the browser bundle did not return ready-made Monero adapters; a
  discrepancy in the XMR network list; a missing path for the repeat report.
- **A named incompleteness (not patched in place)**: `recovery.open` and `sweep.plan` do not carry the DISPLAY fields
  (the receive address, the network, the date), so the page additionally parses the file with the same shared module;
  on the withdrawal page's origin `recovery.open` does not open an old file with a mnemonic (it needs a monero-js
  build that is not there) — the page says this aloud.
- Checks: SDK 229, the code dictionary 28, assets 13, the order flow 26, the guard 257, the sell page 42, the browser
  one 21, the core in the browser 6, the deal in the browser 18.
## 0.34.0 — 2026-10-02

The swap path in the interface goes through the core — from the quote to waiting for the XMR.

- `www/js/ui/views/confirm.js`: the record, the order side (DLEQ, deadlines, halves, points), the lock, the mark on
  our server and the watch — all done by the CORE through `swaps.start`. The page lost `createSwap`,
  `runAtomicOrder`, the manual assembly of the record fields, `saveServerSwap`, the manual registration of the watch
  and the re-issuing of the recovery file after the lock. The core hands out the recovery file BEFORE the lock via
  `onRecoveryFile`, and the person saves it before signing — AND NOT after: a file that appears after the lock
  promises what did not exist at the moment of signing.
- The bridge (`www/js/sdk/bridge.js`) is the one that knows about the core; the page gained `sdkOrderTerms`,
  `sdkStartSwap`, `sdkWatchSwap`.
- **Core defects found and fixed that made the live path fail:** the firm quote rejected a claimer that came from
  the provider; `acceptCounterparty` did not know the facade's own quote fields; the record lost the receive address
  and the order-quote identifier.
- A new probe `tools/check-deal-browser.mjs` (18 checks, a real browser): it walks the path ALONG THE SCREEN —
  connecting the wallet, the form, the quote, the sign screen, the password and both checkboxes, the signature — and
  confirms that the wallet sent EXACTLY ONE transaction, the hash was taken FROM THE NODE, the escrow address — from
  the receipt, and the mark and the watch were accepted by our app.
- Checks: SDK 229, assets 13, the order flow 26, the guard 257, the sell page 42, the browser one 21, the core in the
  browser 6. A named incompleteness: `swapForm.js` (the indicative quote book) is NOT migrated — the book's snapshot
  has a different shape, and that is separate display work.
## 0.33.0 — 2026-10-02

The core is built for the browser, the facade performs the start itself — the swap path is open.

- **Building the core for the browser**: `tools/build-sdk.mjs` + `tools/sdk-browser-entry.mjs` (esbuild, ESM,
  261 KB) → `www/assets/vendors/sdk/sdk-browser.js` with the version `?v=<hash>` in the asset registry. The heavy
  vendor bundles (WalletConnect, monero-js, atomic) are left EXTERNAL: without this the output was 3.9 MB, and they
  are loaded only when needed. The bundle returns the whole facade (`createNinsei`) — start, quotes, actions,
  recovery and the browser adapters; the test-contour and Monero (WASM) adapters are not included in it — and this is
  named at the entry point.
- **The facade brings the swap to the lock itself**: the order side is built by the core ONCE and used both for the
  record and for the lock terms (previously the record and the order could diverge, so a record injection was
  required). The injection remains a CAPABILITY for whoever needs their own side. The contract was brought into
  line: `StartRequest` gained the terms and the counterparty's side, `Ninsei` — the `actions` namespace.
- **The live run was moved onto the facade path** (without a record injection) and passes: the lock transaction
  `0xcbe282bc…` in block 29, the escrow address taken from the `OrderCreated` event, the mark accepted by our app
  (201), the core reached the XMR wait — 32 checks, 0 failures.
- **The page really loads the core**: `tools/check-sdk-browser.mjs` (6 checks, a real browser): the core loads as a
  module, the bundle returns the facade, the swap start in the browser reaches the lock, the bridge goes into the
  facade's `swaps.start` and answers with a CODE, not `null`. Teeth: without the bundle file — 5 failures.
- Why this matters: previously only the surfaces that did not drag the primitives were migrated to the core; now
  everything is available to the page, and the swap path can be migrated as a whole.
- Checks: SDK 229 (was 226), assets 13, the order flow 26, the guard 257, the sell page 42, the browser one 21.
## 0.31.0 — 2026-10-01

The Monero wallet became a full wallet-adapter.

- A new `sdk/src/adapters/monero-wallet.mjs`: `vm`, `connect`, `disconnect`, `close`, `address`, `chainId`,
  `unlockedBalance`, `sync`, `subscribe`, `driver`. The existing XMR withdrawal adapter is untouched: the withdrawal
  and the leg wallet are different roles, and mixing them would mean giving the withdrawal the right to sign anything.
- **A live run against a local stagenet node** (not a substitution): its own address was derived by the library and
  checked against the keys; the restore height = the node's height minus one and **read back from the wallet**; the
  wallet reads EXACTLY this node (its height matched an independent `get_info`); the new wallet's free remainder is
  zero FROM THE NODE — we put no money in for this, so the zero is honest.
- A negative control that makes the check a check: the same adapter with a dead node fails
  ("Wallet is not connected to daemon") — so the numbers are not substituted but come from the node.
- The key and the height are constructor fields, not `connect` arguments: the core calls `connect({})` for Monero.
  This is named, because it departs from the common shape.
- `send`/`receipt` on this adapter REFUSE with a code: sending XMR is the XMR withdrawal's business
  (`sweepUnlocked`/`relayTxs`), not the leg wallet's.
- A known limitation: `XMR_NETWORKS` in the registry declares only stagenet, so the adapter rejects mainnet (the type
  in the contract names it). When the registry declares it — the adapter will pick it up with no edits.
- Checks: 200 (was 191). Breaking run: a removed guard in `address()` reddens two checks; the file was restored byte
  for byte. The live part is skipped if there is no local node — the skip is printed, not passed off as success.
## 0.30.0 — 2026-10-01

A live run by the direct path — and a blind token substitution found along the way.

- **`swaps.start` reaches the signature by the direct path.** The guards get what the core has (the order amount in
  wei, the native-coin marker, the test contour), and the decision is taken by `blocks === true` — the engine's rule
  — and not by `ok === false`. Previously the start ran into "the amount to fund is unknown" before any chain.
- `preflight`: the `escrow-points` and `slots` checks are turned on only when their data has been brought. At the
  order-creation step there is nothing to compare against by construction — previously the unconditional check locked
  the signature on an empty input.
- `lock.factoryOf` takes the factory address from the network registry (and refuses with a code if there is none),
  not from the module where such a function never existed.
- `lock.send` no longer hides the refusal reason under `server-unavailable`: the reason is named briefly and without
  keys.
- **The receipt's shape is normalised at the core's boundary** (`{hash} -> hash`): the strict browser adapter
  declares `receipt(txHash: string)`, while the engine passes an object. Previously this gave a silent substitution
  of the PREDICTED escrow address instead of the one from the receipt.
- `order.acceptCounterparty`: the point of an explicitly passed side is normalised symmetrically to the proven one —
  the same number in two forms no longer gives a false refusal.
- The Node test wallet gained **an explicit whitelist of test networks** (the local anvil): the engine's "production
  network" rule today does not trigger on any recorded network, because all have `escrow.mode: simulated`.
- **A BLIND TOKEN SUBSTITUTION** (`sdk/src/config.mjs`): there was a call `tokensOf(chain.chainId)` — a number where
  the engine expects a slug. The network was never found, and the engine silently returned the default network's
  tokens: ANY network got the `arbitrum-sepolia` list, while its own identifier stood in the response. The error was
  invisible — the list looked plausible. Now the network is looked up by number honestly, absence is a refusal, and
  the list is checked against the record of the network ITSELF.
- Checks: 191 (was 179). Breaking runs: substituting the escrow address instead of the receipt reddens the run;
  returning the previous tokens call reddens the check "no network gets the tokens of ANOTHER network" (the refusal
  report shows: `local-anvil` got `eth|usdc|weth` when its own were `eth`).
- A live run by the direct path: transaction `0x639b3657…5e06`, block 17, escrow `0x13d0da53…e9b1` taken from the
  receipt, and exactly the order amount lies on the escrow.
## 0.29.0 — 2026-10-01

The first LIVE run: the lock really goes on-chain.

- A new test-contour tool: `sdk/src/adapters/node-test-evm-wallet.mjs` — an EVM wallet for Node. The key comes ONLY
  from the environment or a file (never read from arguments), refusal on an unknown network, signing with its own key
  and reading the chain. This is a verification tool, not a path for production use.
- A new scenario `tools/live-lock-run.mjs` (23 checks): it runs a swap through the core, but with a REAL anvil — the
  node and the wallet are not substituted. Exactly two seams are substituted, both named: the recovery file's
  confirmation and the counterparty's side (the engine's builder builds it).
- Proof of the live run: transaction `0x11642a1a…47eb5`, block 9, status 0x1, input with the selector
  `createOrderAndFund`; the escrow address `0x35f4421e…c9f606` IS VISIBLE IN THE RECEIPT'S LOGS and matched the one
  the core named. Balances were checked against anvil before and after.
- A chain-read seam for Node: the `evmCall` option; without it the success path is unverifiable, because the engine's
  read requires the page's wallet.
- Fixed along the way: the guards were failing with a `TypeError` without a code — `preflight.mjs` reads the network
  as `config.evmNetwork`, while the configuration returns it as `settlement.chain`; the names were brought together
  in `index.mjs`.

### What the live run revealed (substitutions did not show this)

- **The receipt flows past the adapter contract:** `funding.js` calls `receipt({hash})` with an object, while the
  contract declares `receipt(txHash: string)`. A strict browser adapter would answer with a refusal, the refusal
  would be swallowed by the wait, and the escrow address would be SILENTLY substituted with the predicted one. That
  is, the declared guarantee "the address from the receipt" does not work in the browser today — and that is exactly
  why in the live run the adapter accepts both forms.
- **`acceptCounterparty` is asymmetric:** the proven point is normalised to the `0x` form, but the `edPub` of an
  explicitly passed side is not; the same number in different forms gives `quote-refused {step:"proof"}`.
- **The engine's points come without the `0x` prefix**, while the calldata encoder requires the prefix: the page
  normalises them at the boundary, the core does not.
- **The "production network" rule does not trigger on any recorded network:** all production networks have
  `escrow.mode: "simulated"`, so by the letter of the rule they are not production, and the test key would sign on
  them. The real line of defense today is the refusal on an unknown network.

### Core defects found by the run (not fixed in this PR, named)

- `swaps.start` calls `preflight(quote, {})` without the interface's data and counts `ok === false` as a refusal,
  whereas the engine locks the signature only at `blocks === true`. The start runs into "the amount is unknown"
  before any chain.
- `lock.factoryOf()` always returns `null`: it looks into a module where such a function does not exist.
- `lock.send` turns ANY error without a code into `server-unavailable`, so the real reason does not get through.
## 0.28.0 — 2026-10-01

The Monero balance and switching the wallet's network — the last two named gaps.

- `wallet.balances` for a Monero wallet takes the balance from the adapter (`unlockedBalance`) and returns **atomic
  units** (1 XMR = 10¹² piconero) with the named precision. There is no unit arithmetic of its own: the source is the
  same method the XMR withdrawal uses.
- `wallet.switchChain` goes **by the same path as the page**: `wallet_switchEthereumChain`, and on an unknown network
  (4902) — `wallet_addEthereumChain`, the network parameters taken from the engine's registry through the seam, not
  from a private table; a user refusal — `wallet-rejected`. **After the switch the network is re-read:** "switched" is
  the wallet's assertion, not a fact, and it cannot be trusted.
- The reason the switch is reproduced in the adapter, rather than taken from the engine: the engine's `switchChain` is
  bound to the page's provider, into which the adapter's provider cannot be substituted. Taking it as is would mean
  breaking both the SDK usage and the switching that works in the interface today.
- The virtual-machine name for Monero is `monero` (`XMR_VM`). There is no such name in the network registry (there it
  is evm, bitcoin, solana, tron), so it is declared in `wallet.mjs` as a constant and explained in a comment.
- Checks: 179 (was 172). Breaking run: removing the network check after the switch reddens the check
  "'switched' without a network change"; the file was restored byte for byte (the hash matched).
- A known gap, named plainly: **the Monero wallet as a full wallet-adapter is not done** — `moneroWallet` (for the XMR
  withdrawal) does not implement the wallet interface (connect/address/chainId/subscribe/driver). The checks use a
  substituted adapter. Working from the browser needs an adapter over monero-ts.
## 0.27.0 — 2026-10-01

The lock: the core really locks funds.

- `swaps.start` no longer throws `not-implemented { step: "lock" }`: the wallet comes from outside (`request.wallet`),
  the core calls the finished `lock.send`, waits for the receipt and takes **the escrow address from the receipt**,
  not from a prediction. After that the next step is named — `server` (stage 4).
- **Without a wallet — a refusal with a code, and nothing goes on-chain.** Without a confirmed recovery file the lock
  is not done either: a file with nothing to open it with is worse than no money on the escrow.
- `lock.send(request, wallet, deps)` gained the `deps.call` seam — without it the success path is unverifiable at
  all: the engine's chain read requires a connected provider, which bare Node does not have. Backward compatible.
- The lock terms are taken from `request.order` (eight fields the DLEQ proof is bound to), not from the record: at
  this point the record has no commitments and no claimer point. `amount` is already in wei.
- Checks: 172 (was 164). New: a lock without a wallet and without a file sends nothing; with a wallet — exactly one
  send, and **the escrow address is taken from the receipt, even when the prediction gives a different address**.
- An API-contract decision, said aloud: the wallet at `start` is passed inside the request itself (`request.wallet`),
  not as a second argument as in `lock.send`/`actions`. That way the request stays one object together with
  `onRecoveryFile`. If you want a uniform shape — it is a pinpoint edit.
## 0.26.0 — 2026-10-01

Checking the slots before signing — and the check that breaks it.

- `createActions({ call })`: what reads the chain is also a seam. This is not only for the checks: **the slot check
  and the signature must go one way**, otherwise part of the check goes past the wallet and part does not. Default —
  the engine's read.
- The check by a run covers THE VERY case that was named unclosed: **the slots on the chain are not the ones we
  assembled**. The composition matches, the values differ — so the order is foreign or substituted, and it must not be
  signed. The run confirms: there is no signature (`contract-reverted`), and nothing went on-chain.
- Why this is a separate check and not "obvious anyway": the check compares the order's points and commitments with
  what lies on the chain, and its refusal is the only thing between the signature and a foreign order. A mark on a
  foreign order allows a foreign address to take the settlement; claiming and refunding reveal your own half, and
  that is irreversible.
- The number of checks became 143.
## 0.26.1 — 2026-10-01

Fixing the signing-guards tooth after the extended seam.

- The `check-signing-guards` check looks in the flow's source for the SLOT CHECK before the claim and before the
  ready mark and makes sure its removal goes red. After the call gained a fourth argument (`deps`), the guard stopped
  finding the call and rightly cried out: "NOT FOUND in the source" and "removal does not go red".
- The expectation was updated and remained strict: the call must be a separate `await` line, and the seam (`deps`) is
  allowed. Otherwise the guard would go red from exactly what we were after — from the fact that the check went
  through the adapter.
- The run: `check-signing-guards` — 257 checks, 0 failed.
- A lesson for the future worth keeping: the guard has expectations about the TEXT of the call, and any signature
  edit must be accompanied by a run of exactly this guard, not just the profile suites.
## 0.25.0 — 2026-10-01

Order actions: marking ready, claiming, refunding — all through one wallet seam.

- `actions.markReady/claim/refund` — wrappers over the engine: the wallet comes as an adapter (`send`/`receipt`), the
  chain read is the engine's, refusals come as CODES (`bad-input`, `contract-reverted`), and the texts remain the
  interface's.
- **`expect` IS MANDATORY.** The slot check compares the order we assembled with what lies on the chain; without
  expectations there is nothing to compare against, and the signature goes out under an order whose commitments
  nobody checked. For the mark that is granting a foreign address the right to take the settlement; for the claim and
  the refund it is revealing your own half (irreversible). In all three cases the transaction still looks successful.
- The halves are also mandatory where they are revealed: `halfClaimer` on the claim, `halfLocker` on the refund.
- The engine's seam (`swapFlow`) was added to `engine.mjs` — the core keeps no path of its own to the order flow.
- The number of checks became 141. The check by a run also makes sure that none of the refusals REACHED sending.
- What the check does not yet do, and this is named: the case "the slots on the chain did not match the expectations"
  (a refusal before the signature when the slots match in composition but differ in value). This is the next step:
  there a stand-in chain reader with an exact slot composition is needed, and I do not want to pick it at random.
## 0.24.0 — 2026-10-01

The wallet seam was extended to the order actions (steps 1+2 of the plan).

- `orderLiveSlots`, `assertOrderSlots`, `markReadyOrder`, `claimOrder`, `refundOrder` accept `deps` with `call` and
  `send` (the defaults are as before). Now **all four steps** — lock, ready mark, claim, refund — can go through ONE
  wallet seam rather than partly past it.
- **The slot check was added to the refund** (`refundOrder`, when expectations are given). A refund REVEALS a half,
  that is, it is as irreversible as a claim: signing it under an order whose commitments we did not check is not
  allowed for the same reason as a claim. The expectations are optional for the sake of the previous calls; the core
  always passes them.
- Why this matters at all: the slot check goes in two stages (`assertOrderSlots` → `orderLiveSlots` → reading from the
  chain), and without the extended seam the read would keep going to the chain by its own path — half of the step
  through the adapter, half past it.
- The checks covering this already existed: `tools/check-atomic-flow.mjs` (26 checks) and the SDK suite (137). Both
  runs are green — the behaviour for the previous calls did not change.
## 0.23.0 — 2026-10-01

Sending the lock: the deadlines are checked before it, the wallet is an adapter.

- `lock.send(request, wallet)` — sending the lock. The chain work is done by the engine (`fundOrder`), and the wallet
  comes as an adapter: signing is possible only in it, and the core keeps no path into the chain of its own.
- **THE DEADLINES ARE CHECKED BEFORE SENDING, and the refusal names exactly the deadline**
  (`bad-input { field: "readyBy" }`). The point here is not tidiness: a transaction with violated deadlines LOOKS
  successful until the contract rejects it — and it will reject it later and more expensively. The check by a run
  makes sure that on such a refusal NOTHING went on-chain.
- The order terms and the sending name the same field differently (`amount` versus `amountWei`): the rules are checked
  on the sending form, the core normalises the names, and the rules stay with the engine.
- **The escrow address is taken from the receipt, not from a prediction:** a prediction could diverge from what was
  actually created, and it would diverge silently.
- The EVM wallet role accepts `gas`: every contract call (lock, ready mark, claim, refund) has its own estimate, and
  it comes from the engine's EVM layer together with the calldata.
- The number of checks became 137.
## 0.22.0 — 2026-10-01

The lock terms: assembled and checked BEFORE sending.

- `lock.terms(request)` — the order terms for the contract. They are assembled by the ENGINE
  (`www/js/evm/escrow.js`, `orderTerms`), because the contract sets the rules; the core has no copy of the rules — a
  copy would drift from the contract right where the error is visible only as a rejected transaction.
- Refusals come as CODES: `bad-input { field: "readyBy", why: "not-in-future" }`, `{ field: "t1",
  why: "not-after-readyBy" }`, and incomplete terms name the missing fields. The interface need not parse foreign
  texts, and we need not repeat their wording.
- `lock.factoryOf(chainSlug)` — the escrow factory address by the same path as the engine's: the core keeps no address
  list of its own.
- What is NOT here, and this is named: the sending itself. It needs an EVM wallet (the `send`/`receipt` role already
  exists) and a call to `fundOrderLive` from the engine's EVM layer — the next step, not covered by a stub.
- The number of checks became 135.
## 0.21.0 — 2026-10-01

Sending a transaction and the receipt — what is indispensable for locking funds.

- `WalletAdapter.send({ to, data, value })` — sending a leg transaction. For EVM this is `eth_sendTransaction` with
  `{ from, to, data, value }` (the amount in wei, hexadecimal), the response — the transaction hash. Without a
  connected wallet — the refusal `wallet-not-connected`, not sending "into the void".
- `WalletAdapter.receipt(txHash)` — the receipt by hash (`eth_getTransactionReceipt`).
- **THERE IS DELIBERATELY NO POLLING INSIDE THE ADAPTER:** `receipt` asks ONCE and returns the receipt or `null` if
  the transaction is not in a block yet. The waiting policy (how long, how often, what on refusal) is set by the
  caller: a policy of its own inside the adapter would mean two calls wait differently.
- The check by a run: the adapter calls EXACTLY those methods and with those arguments — the sender, the recipient,
  the data and the amount in wei; the receipt by hash is returned as is; a receipt without a hash — a data error.
- The number of checks became 131.
## 0.20.0 — 2026-10-01

The heavy run of the counterparty's side with a real DLEQ proof.

- `tools/check-sdk-order-proof.mjs` — a SEPARATE run, not part of the shared suite: the proof computation takes
  seconds (the measurement in the output: ~3.6 s and ~3.2 s), and in the battery it would slow down every edit.
- Three things are checked, and all three are about money: a real side for THESE terms is accepted; **a real side for
  OTHER terms is rejected** (the proof is bound to the order context); **a substituted half with a foreign proof is
  rejected** (the proven point must match the one that will go into the contract).
- All three checks go through the SDK facade (`sdk.order.verifyCounterparty`), that is, the path the interface uses is
  checked, not the engine's internals.
- The shared suite still has 127 checks: the heavy run is deliberately not part of it and is started separately
  (`node tools/check-sdk-order-proof.mjs`).
## 0.19.0 — 2026-10-01

The counterparty's side and the joint address — what is checked BEFORE signing.

- `order.context(terms)` — the order context string (`arrakis-order-v3`, the fields and order taken from the engine
  module). The same context the quote signature is bound to.
- `order.verifyCounterparty({ side, order, sealed?, ownEncPriv? })` — TWO mandatory checks in one engine call: the
  proof stands in the context of THIS order and the proven ed25519 point matches the one that will go into the
  contract. It did not pass — `quote-refused { step: "proof" }`, not a string.
  Why the second one: without it the counterparty could prove one point and substitute another. On our side
  everything would look sound, and the discrepancy would surface when claiming the XMR, with nothing left to fix.
- `order.jointAddress({ ownSpendHalf, ownViewHalf, otherSpendPoint, otherViewPoint, network })` — the joint Monero
  address by the same encoder as the wallet's: a second one would drift from the first right where the error is
  visible only by sending XMR.
- There is no cryptography of the core's own: the engine does everything, the core passes the primitives and turns
  the verdict into a CODE.
- What is deliberately ABSENT from the checks: a positive case with a real DLEQ proof. It takes seconds and would
  slow the whole suite; its place is a separate run on the live contour. Here is checked what must be cheap and
  breaks silently: garbage is rejected with a code, not a crash; incomplete terms — a data error; the joint address
  needs both your half and the other's point.
- The number of checks became 127.
## 0.18.0 — 2026-10-01

Binding the quote to OUR order terms — the second half of the same rule.

- The signature confirms the provider signed THIS quote, but not that it is about our swap. We are responsible for
  the binding: `quotes.firm` computes the context string from OUR terms with the engine module (`orderContextString`,
  format `arrakis-order-v3`) and requires the provider to return exactly it. There is deliberately no copy of the
  format in the SDK: a copy would silently drift from the protocol — I already proved that on myself by guessing the
  field list.
- It did not match — `quote-refused { step: "context", why: "other-terms" }`. There is no context string at all —
  also a refusal (`why: "not-reported"`): there is nothing to check the binding with, and silence is not consent. The
  same rule as with the signature flag.
- Incomplete order terms — `bad-input { field: "order" }`: a data error, not a provider refusal.
- THE ORDER OF THE GATES: signature first, then binding — so a refusal names the nearest reason.
- The fields and their order are part of the protocol (`chainId, factory, locker, claimer, amount, readyBy, t1,
  salt`): rearranging them would change the context and instantly devalue all issued quotes.
- The number of checks became 122.
## 0.17.0 — 2026-10-01

A firm quote for an order — and why the backend's silence is not counted as consent.

- `quotes.firm({ providerId, order })` works: POST to `routes.orderQuote` (default `/order-quote`) with the body
  `{ providerId, order }` — the same path and body as the engine's (`requestOrderQuote`). Before this the facade
  answered `not-implemented`.
- **A quote is accepted ONLY with a confirmed signature.** It carries a commitment under keys, so an unverified
  signature is not "probably fine". The backend verifies the signature (it holds the provider's key) and reports the
  result in a field; on our side it remains not to mistake silence for consent: **a missing flag counts as an
  unverified signature** just like `false`.
- The different refusal reasons are named differently: `why: "not-verified"` — the backend checked and it did not
  match; `why: "not-reported"` — nothing was said about a check. For the interface these are different pieces of
  advice.
- The number of checks became 119.
## 0.16.0 — 2026-10-01

The swap record and our order side — the start of the second half of the work (the swap).

- `sdk/src/record.mjs`: `createRecord` creates the swap record (the engine's `createSwap`) and puts OUR order side
  into it — a spend-key half, a view-key half and their points. The field names are the ones the engine reads them by
  (`half`, `viewHalf`, `ownSpendPoint`, `ownViewPoint`): otherwise the recovery file would end up without halves, and
  its own validator would reject it — rightly.
- `swaps.start` creates the record itself if the interface did not bring its own, and **goes further not into the file
  but into the order**. This is not a rearrangement for convenience: the counterparty's halves and the open points,
  without which the file is empty, appear exactly at the order step (clarified against the engine's code in 0.8.1).
- Naming honestly: the DLEQ proof is bound to the ORDER CONTEXT (the terms, deadlines, salt, escrow address,
  chainid), and the terms do not exist before a firm quote. So `start` reaches the order step and names it
  (`not-implemented`, `step: "order"`, `missing: ["counterparty-half"]`, `swapId`).
- The first run of the new check went red twice, and both times for a reason: the checks were written for the previous
  behaviour, and the code itself was failing with "Cannot access 'record' before initialization" — the module import
  was named the same as a variable inside `start`. This is visible only by a run.
- The number of checks became 111.
## 0.15.0 — 2026-10-01

The withdrawal mark — and why it cannot declare the withdrawal unsuccessful.

- `sweep.run`, after sending, tells the service about the withdrawal: POST to `routes.swept` (default
  `/swaps/{id}/swept`) with the body `{ txid }` — the same path and body as the sweep page. As a result the `reported`
  flag appeared.
- **THE REPORT DOES NOT AFFECT THE TRANSFER.** The XMR is already on the network; a failed report gives
  `reported: false`, so the interface offers to report again. Declaring such a withdrawal unsuccessful would mean
  lying about money, so the check by a run watches exactly this: on a service refusal the withdrawal stays successful
  and the transactions are returned.
- The report is made only when there is both a swap and a transfer hash: there is nothing to report — we do not
  report.
- The number of checks became 111.
## 0.14.0 — 2026-10-01

The withdrawal keys from the revealed half — with the check the contract cannot do.

- `sweep.keys({ file, passphrase })` assembles the spend key and the view key: 64 hexadecimal characters, byte order
  as in Monero (little-endian — the same way the engine returns them).
- **The check is mandatory and is done before any syncing**: `(s_a + s_b)*G` must match the order's public spend key.
  The contract cannot check this — it only makes sure the hash of the revealed half matched the commitment, and there
  is no ed25519 in EVM. A half from another order — the refusal `bad-input { step: "verify" }`, not an attempt to
  send. The check by a run builds REAL halves and makes sure a foreign one is rejected.
- "Not revealed yet" is a state: `bad-input { field: "revealedHalf", why: "not-revealed" }`. No one has the spend key
  before the reveal.
- The halves' math is taken through the engine's seam (`halves`, `halvesSweep`), and the primitives — from the core:
  it is verified by a run that `(a+b)G == aG + bG` on these primitives.
- The number of checks became 108.
## 0.13.0 — 2026-10-01

The counterparty's revealed half — from the chain via the app.

- `sweep.plan` asks the app for the half **by the same path and body as the sweep page**: POST to
  `routes.revealedHalf` (default `/escrow/revealed-half`) with the body `{ network, address }`, where `address` is the
  **escrow** address, not the Monero address (verified by reading the page's code). The `revealedHalf` flag appeared
  in the plan.
- **"Not revealed yet" is a state, not an error.** The half is published by the settlement that moves the ETH (a
  claim or a refund); before that no one has the spend key. So the app's refusal and "not revealed" both give
  `revealedHalf: false` and `missing: ["revealed-half"]`, not an exception.
- The transport was taught the method and the body: `json(path, { method, headers, body })`. Without this a POST with
  a body would silently leave as a GET, and the app would answer with a refusal to a request it did not understand —
  the check catches this.
- What is not there yet, and this is named: the derivation of the spend key from the half itself
  (`spendKeysFromRevealedHalf`, together with the mandatory check `(s_a + s_b)*G` against the order's key) — the next
  step.
- The number of checks became 104.
## 0.12.1 — 2026-10-01

The "refusal, not a breakdown" check — in the wake of a manual merge.

- A manual branch merge left an unnamed object in `sweep.mjs`, and `sweep.run` was failing with a `ReferenceError`
  (`api is not defined`) — that is a **breakdown, not a refusal**. The neighbouring check then went red not for its
  own reason, and the cause had to be reached separately.
- A new check walks EVERY public method (18 calls) with deliberately invalid arguments and requires the answer to be
  a value or an `SdkError` with a code. Any other error (`TypeError`, `ReferenceError`) is a breakdown and is named
  aloud, with the method's name.
- Along the way the check asserts that the surface was really walked (not "a couple of methods"): otherwise the check
  would silently degenerate into an empty one.
- The number of checks became 98.
## 0.12.0 — 2026-10-01

Addresses and paths are set from outside. The default is our service and our explorers.

- `endpoints: { explorer: { evmTx, evmAddr, evmName, xmrTx }, rpc: { evm, monero } }`: the defaults are taken from
  the network registry (`explorerTx`, `explorerAddr`, `explorerName`, `rpcUrl`), the options override them.
- `routes: { swaps, revealedHalf, swept }` — **the paths are named by names, not by strings in code**:
  `config.route("swept", { id })` substitutes and encodes the parameter. An unknown name — `bad-input`: a typo must
  not silently fall back to the default.
- A RULE: **addresses are configurable, not checks**. Your own API, your own node, your own explorer, foreign paths —
  fine; the pre-signature guards (the price, the amount coverage, the token allowance, the deadlines from the chain)
  stay enabled under any configuration. Otherwise "maximum configurability" would become a way to switch the checks
  off with a single field. The check by a run watches exactly this: the list of checks does not change on an override.
- `sweep.plan` goes by the named path, so changing the host or using a third-party server is an edit of an object, not
  a fork of the core.
- The number of checks became 88.
## 0.11.0 — 2026-10-01

The XMR withdrawal as a whole: the wallet comes as an adapter, the core holds the order.

- `sweep.run({ file, passphrase, to, connectWallet })` works: plan -> wallet -> sync ->
  free remainder -> **sign WITHOUT sending** (`sweepUnlocked({ relay: false })`) -> sending (`relayTxs`) -> closing.
  The order is checked by a run against a substituted wallet.
- **An empty remainder stops the withdrawal BEFORE signing** (`insufficient-funds`): otherwise the wallet would sign a
  transaction for zero, and the refusal would look like success. The check watches both this and the fact that there
  was no signature-with-sending at zero at all.
- `moneroWallet` in `@ninsei-labs/sdk/adapters`: the Monero wallet role over the library the page provides. The method
  names are the ones the sweep page already calls on monero-ts (`sync`, `getUnlockedBalance`, `sweepUnlocked`,
  `relayTxs`, `close`), so the core stays without DOM and without a 3.6 MB worker.
- A half-adapter is rejected BEFORE opening the wallet and names which methods are missing.
- Adapter refusals — with codes, without user-facing phrases (this is checked by machine across all of `sdk/src`).
- The number of checks became 89.
## 0.10.0 — 2026-10-01

The XMR withdrawal (what the sweep page does) — the surface in the core. The user's requirement: the SDK must make
it possible to run the whole swap fully and programmatically, including the withdrawal.

- `sweep.plan({ file, passphrase })` works: it decrypts the recovery file, checks the composition, takes the joint
  Monero address, asks the app for the restore height BY ADDRESS (exactly as the sweep page does — `GET /swaps`, the
  field `restoreHeight`) and says with codes what is missing: `restore-height`, `spendable`, `revealed-half`. The
  withdrawal steps are named: `unlock`, `sync`, `sweep`, `relay`.
- An unavailable app is not a refusal: the plan is returned, and the missing height is named in `missing`. Silent
  emptiness here would be worse than a refusal: the person would not know the withdrawal will not go.
- `sweep.run(...)` is named honestly: it needs a Monero wallet adapter (`moneroWallet`), because syncing,
  `sweepUnlocked` and `relayTxs` live where there is WASM. The core stays without DOM and without the 3.6 MB worker.
- The number of checks became 83.
## 0.9.0 — 2026-10-01

Atomic swap primitives — from the same npm packages as the page bundle (the user's decision: do not drag a hashed
build artefact into the core).

- `sdk/src/primitives.mjs`: `ed25519`, `secp256k1`, `keccak256`, `sha3_512`, `randomBytes` and the `primitives` set
  in the shape `createOrderBuilder` expects. The order-side build modules do not import the primitives — they arrive
  as parameters, so the core can return its own.
- **keccak_256 is taken from the curves-and-hashes package, not from the separate `keccak256`.** That one accepts only
  a Buffer of its own instance and refuses `invalid type` on bytes from another module (verified by a run). The value
  is checked against a known one: keccak256 of the empty string =
  c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470.
- The check distinguishes keccak256 and SHA3-512 on values: the commitment for a half is computed with keccak256 (as
  in Solidity), the proof — SHA3-512. Swapping one for the other looks like a typo and costs a swap.
- The number of checks became 75. What this check does NOT assert, and this is said aloud: the compatibility of the
  set with the side builder (`createOrderBuilder`/`newSide`) — the next step, not a claimed property.
## 0.8.1 — 2026-10-01

The start step order was corrected against the engine. The key halves (`spendHalf`, `viewHalf`, the counterparty's
open points) are generated by the ORDER (`www/js/atomic/order-worker.js`, `createOrderBuilder`; in the engine they are
fetched by `halvesWalletOf`), so the recovery file cannot be assembled before the order. The order: guards -> swap
record -> order -> recovery file and confirmation -> LOCKING THE FUNDS -> server -> watch. The property "funds are not
locked before the file's confirmation" did not change.

## 0.8.0 — 2026-10-01

The recovery file and the confirmation gate — for real, not with a stub.

- `swaps.start` performs steps 2 and 3 for real: it assembles the file's passport (`buildPayload`), CHECKS it before
  the person (`validatePayload`), encrypts it with the passphrase (`createRecoveryFile`) and hands the interface
  `{ name, contents }`. A file that will not open is worse than no file: it will be relied upon.
- A passphrase shorter than 12 characters is not accepted (`bad-input` with `{ field: "passphrase", min: 12 }`): a
  file with a weak passphrase is a file strangers will open.
- THE GATE: until `onRecoveryFile` returns `true`, no action that locks funds is performed. The person's refusal and
  silence are `recovery-declined`, not consent.
- There is no swap record yet: only the interface with a browser wallet can do it. It arrives in `createSwaps` from
  outside (`createRecord`), so the whole path AFTER it is written and checked already now.
- The number of checks became 69. The key new one: the file handed to the person is decrypted back with its own
  passphrase and carries the halves (version 3) — that is, the file really is a file, not a string of plausible
  length.

## 0.7.0 — 2026-10-01

Network -> virtual machine -> driver.

- The SDK keeps no network table: the source of truth is the engine's registry (`CHAINS` in
  `www/js/core/config.js`). `vmOfChain(chainId)` returns the network's `vm`, `legForChain(chainId)` — the leg driver
  for it.
- A network without a driver is a NAMED refusal `not-implemented` with `{ surface: "legs", vm, implemented: [...] }`:
  you can see which virtual machine is not supported and which are. "Silently assumed EVM" is forbidden, and this is
  checked across the WHOLE registry: every network either gets a driver or is refused with the vm named. Right now the
  registry has 11 networks: the EVM ones are supported, bitcoin/tron/solana are refused by name.
- An unknown network — a separate code `bad-input` (this is a data error, not an unfinished capability).
- In the swap state `counterparty.vm` is taken from the registry; for an unknown network — `"unknown"`, not the
  network's name and not a guess "probably EVM".
- The number of checks became 63. Along the way: the SDK copy in the breaking runs gained the engine seam with
  absolute paths (otherwise relative imports from the copy's directory do not find `www/js`) — exactly why the seam is
  made as a single file.

## 0.6.0 — 2026-10-01

Swap state outwards and the start order. The first step of stage 2.

- `swaps.list()` and `swaps.get(id)` work: swaps are raised from the core's storage, that is, after a page reload, not
  from memory. The engine's record is translated into contract names (`toState`): the direction, the amounts, the
  steps, the deadlines, the counterparty's leg, the allowed actions, what is simulated, the terminal state.
- The steps in the contract begin with `awaiting_funding`, which is not in the engine (the engine considers the swap
  already created from the `funded` step) — waiting for payment is a state the interface must show.
- The step gained a `failed` flag (the maker did not lock the XMR): the interface draws a failure, not "still running".
- `swaps.start(request)` holds the step order: guards → record and recovery file → the person's confirmation → order
  and halves → server → watching the Monero address. It is checked that a guard's refusal stops the swap WITH ITS OWN
  CODE, that before the refusal the file is not shown to the person, that without the file handler the swap does not
  start at all (`bad-input`), and that on a clean guard report the start reaches exactly the record-creation step,
  naming the unclosed step (`not-implemented`, `step: "create-swap"`, stage 2).
- What is NOT in this release, and this is named: creating the swap record, the order and its halves, sending to the
  server and the watch — they require a browser wallet and are done in stage 2 in full.
- The number of checks became 57.

## 0.5.0 — 2026-10-01

Storages — outside, like everything else. The first DOM seams of the engine were removed.

- `www/js/core/store.js` (the state of unfinished swaps) and `www/js/evm/auth.js` (the agent session) accept a storage
  adapter (`get`/`set`/`remove`). By default — web storage, if it is present in the environment, otherwise process
  memory: the module must load both in Node and in the SDK, which promises "no DOM". Silently not saving is not
  allowed — an unfinished swap would be lost after a reload.
- `www/js/evm/session.js`: subscribing to window events (`pageshow`, `visibilitychange`) is done only where there is
  a window. Previously it stood without an environment check, and the module failed on load in Node — that is, it
  broke everything that pulls it in.
- The `storage` option in the SDK is no longer a promise in the types: the storage brought by the interface becomes
  the core's storage (both swaps and the agent session).
- The number of checks became 44: the core's storages load in Node without DOM, the state is saved to the substituted
  storage, clearing it wipes it, an incomplete adapter is rejected, a storage refusal on write does not break the
  engine, and the storage from the SDK's options reaches the core.

## 0.4.0 — 2026-10-01

Balances and the route-provider registry.

- `wallet.balances(tokens?)` works: the native coin via `eth_getBalance`, tokens via `balanceOf` in `eth_call`. The
  selector `0x70a08231` is not "from memory": it is checked against the node's registry (`rfq/evm.mjs`) by a check,
  and an SDK copy with a substituted selector reddens it. `decimals` are taken from the registry; the chain's answer
  carries only the number in minimal units.
- An unread balance comes as `null`, not zero (zero would look like an empty wallet). On a foreign network the balance
  is not read at all: the code `wrong-chain`. Without a wallet — `wallet-not-connected`, an unknown token in the list
  — `bad-input`.
- **The route-provider registry** in the EVM driver: `routeProviders()` / `routeProviderFor(id)`, a requirement for a
  provider — `id`, `kind`, `plan(...)`. One is declared today: `declared` (our declared routes; execution — stage 3).
  An external aggregator (1inch and the like) is added by a file and a line in the registry, and the pre-signature
  guards stay shared by all providers.
- The order of preference comes through options (`routing: { prefer: [...] }`) and is checked against the registry: an
  unknown identifier — `bad-input`, not "we'll try and see". One provider beating another is set explicitly, not by
  whoever answered over the network first.
- The number of checks became 38 (13 breaking runs): reading balances with a substituted provider, the address word
  in the calldata, refusals on a foreign network and an unknown token, the completeness of the provider registry, a
  refusal to an unknown provider, and a breaking run on a half-added aggregator.

## 0.3.0 — 2026-10-01

Live indicative quotes: `quotes.watch` works.

- The SDK's own quote client (the package must work without `www/js`): parsing the book in three envelope forms, the
  row's two rates, zero as "no direction", the lifetime from its own mark, snapping the size to the provider's grid
  down. For now the demo screen computes with its own copy: it is a test bench.
- `quotes.watch({ direction, token, amount }, onSnapshot)` — the subscription; the last one to unsubscribe stops the
  polling. `quotes.snapshot()` returns the last snapshot without waiting.
- The snapshot was extended: `size`, `unit`, `sizeCode` (`bad-size` | `below-min` | `above-max` | `no-offer`), `seq`,
  `offers`, `refused` (the codes `malformed` | `disabled` | `stale`), `references`, `ok`, `error.code`. A connection
  refusal is not replaced with past numbers: `ok` is cleared, `error.code` names the reason.
- `config.limits.quotePollMs` and `httpTimeoutMs` are taken from the engine's settings, not from numbers in the SDK.
- The number of checks became 25 (9 breaking runs), among the new ones: the book's rules and the derivation of numbers
  on fixtures, a removed division-by-zero guard (the copy goes red), a removed quote-lifetime check (the copy goes
  red), the absence of a market named by a code, not zero.

## 0.2.0 — 2026-10-01

The settlement network is named by the pair "network + virtual machine", the wallet is connected by an adapter, and
the swap state by a leg role. This is preparation for Tron and Solana (the first expected extensions) without
rewriting the core.

**Breaking changes (before 1.0 we bump the minor):**

- `evmNetwork: "arbitrum-sepolia"` → `settlement: { chain: "arbitrum-sepolia", vm?: "evm" }`. `vm` may be omitted —
  it is taken from the engine's network registry, but a foreign one cannot be substituted: a network that has no leg
  driver answers `not-implemented` with the fields `{ surface: "settlement.vm", vm, implemented }` instead of being
  silently assumed EVM.
- `wallet.use(eip1193Provider)` → `wallet.use(adapter)`. A ready-made EVM adapter: `evmWallet(provider)` from
  `@ninsei-labs/sdk/adapters`. A bare provider is no longer accepted: substituting the adapter with magic means
  hiding from the interface what exactly it connected. Another VM's adapter will be a separate export of the same
  directory.
- In the swap state the field `evm: { escrow, status, txs }` → `counterparty: { chain, vm, leg, status, txs }`. The
  word "escrow" is about the EVM implementation, not the role: Tron and Solana will have their contract, Bitcoin — a
  script.
- `sdk.config.evmNetwork` → `sdk.config.settlement.chain` (+ `sdk.config.settlement.vm`); every network in
  `sdk.config.chains` gained a `vm` field.

**New:**

- The leg driver registry `sdk/src/legs/` (`vm → driver`) and a requirement for a driver: `vm`, `walletChainId`,
  `sameChain`. Adding Tron or Solana — put a file next to it and register it; the quotes, the Monero leg and the state
  machine do not change.
- The `sdk/src/adapters/` directory — the only place allowed to know about the environment: `evmWallet` (EIP-1193),
  `localStorageAdapter`, `memoryAdapter`.
- `wallet.driver()` in the contract: what the adapter signs and reads the chain with (for EVM — the provider). Needed
  by the leg driver; by the interface — only if it wants to hand it to its own extension.

**Checks:** 18 (was 10), of which 7 breaking runs. Added: the completeness of the driver registry, a refusal of a
network without a driver with the vm named, a breaking run on a half-added driver, connecting an adapter of any origin
by interface, a refusal of a foreign-vm adapter, a refusal to a bare provider.

## 0.1.0 — 2026-10-01

The first release: the contract and the skeleton.

- `index.d.ts` — the API contract: options, configuration, wallet, quotes, checks, swap, recovery, sandbox, code
  tables. This is what the interface can lay out screens against.
- Implemented and works: `config` (networks, tokens, limits, codes), `wallet` (an EIP-1193 provider from outside),
  `preflight` (the engine's guards, codes instead of text), `recovery.open`, `sim` (sandbox scenarios and clock).
- Declared, but answering with the code `not-implemented`: `quotes.firm`, `swaps.*` — these are stages 2 and 3: they
  require the quote engine and the swap orchestration to move under `sdk/` (right now they live in `www/js` and are
  loaded by relative paths through `sdk/src/engine.mjs`).
- The invariants are checked by machine (`tools/check-sdk.mjs`): the SDK loads in bare Node without DOM, its exported
  surface matches `index.d.ts`, the check codes cover all the engine's guard kinds, and the SDK code has no
  user-facing strings.

## 0.0.1 — 2026-10-01

- The `sdk/` directory, created at the interface's request (issue #32).
