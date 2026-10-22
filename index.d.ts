// THE SDK CONTRACT: what the protocol and the interface agree on.
//
// This is the SINGLE source of truth about the API shape. The implementation must match it, and this is checked by
// machine (tools/check-sdk.mjs): the list of exports is compared against this file, and the check codes against the
// list that occurs in the engine's guards.
//
// THE RULES THE SDK HOLDS (and which are checked):
//   1) not a single user-facing string: only codes and params. Texts, wording and translations are the interface's;
//   2) not a single DOM access: `document`, `window`, `localStorage` do not occur in the SDK. Storage and the wallet
//      come from outside: as an adapter and an EIP-1193 provider;
//   3) the SDK opens no windows: the interface shows the wallet modal, the SDK accepts a ready provider;
//   4) funds are not locked until the interface has confirmed the recovery file is saved (onRecoveryFile);
//   5) the guards cannot be bypassed: preflight is part of the same path, not a separate button.
//
// Naming language: the values are data. `step` and `code` are stable strings from the tables below; they are
// translated, shown and coloured as one sees fit. They change only with a package version bump (see CHANGELOG).

/** One log as a node answers it: an emitter, its topics and its data. Only what the decline is read from is named. */
export interface EvmLog {
  readonly address?: string;
  readonly topics?: readonly string[];
  readonly data?: string;
  readonly blockNumber?: string;
  readonly transactionHash?: string;
}

/** The log read a caller may bring: the seam the decline is read through. */
export type EvmLogReader = (
  request: {
    readonly address: string;
    readonly topics?: readonly string[];
    readonly fromBlock?: string | number;
    readonly toBlock?: string | number;
  },
) => Promise<readonly EvmLog[]>;

export interface NinseiOptions {
  /** The service's HTTP API base. Default is "/api" (the interface proxies it to our server). */
  apiBase?: string;
  /**
   * The settlement network. `chain` is an identifier from `sdk.config.chains` (e.g. "arbitrum-sepolia", "solana").
   * `vm` may be omitted: it is taken from the network registry, and a foreign one cannot be substituted - a network
   * without a driver answers with the code `not-implemented`, rather than being assumed EVM by default.
   */
  settlement: { chain: string; vm?: string };
  /**
   * The Monero network. A value from `sdk.config.xmrNetworks`. Besides mainnet/stagenet/testnet it names
   * `fakechain` - the official network name monerod reports in regtest mode, which the withdrawal page picks up
   * from the node on the CI contour.
   */
  xmrNetwork: "mainnet" | "stagenet" | "testnet" | "fakechain";
  /** Where to load workers and WASM from (order-worker, the Monero bundles). Default "/". */
  assetsBase?: string;
  /** Storage for unfinished swaps and sessions. Default - a localStorage adapter, if present. */
  storage?: StorageAdapter;
  /** "live" - real nodes and chain; "sim" - a sandbox (mocks, accelerated time, failure scenarios). */
  mode?: "live" | "sim";
  /** An injected fetch function (SSR, tests, your own transport). */
  fetch?: FetchLike;
  /** The clock. In "sim" the SDK uses it to accelerate time. */
  now?: () => number;
  /**
   * Route providers (the DEX/aggregator leg) and the order of preference. An unknown identifier is `bad-input`:
   * the order is set explicitly, not by whoever answered over the network first.
   * A provider's record also DECLARES THE SHAPE OF ITS SWAP: "sync" - the router runs in the user's own
   * transaction, so the swap and the escrow funding are one transaction (Uniswap, SushiSwap); "async" - the
   * settlement arrives later as a separate action, and then the record must also say what ends execution
   * (CoWSwap). A path that assumes "one transaction" refuses an asynchronous provider BY NAME, not silently.
   * The registered identifiers are `declared` (our own router routes, "sync") and `cowswap` (the CoWSwap intent
   * auction, "async") - see `sdk.config.routing.providers`.
   */
  routing?: { prefer?: readonly string[] };
  /**
   * ADDRESSES AND PATHS SUPPLIED FROM OUTSIDE. The default is our service and our explorers; the options are for
   * whoever runs the swap themselves. ADDRESSES ARE CONFIGURABLE, NOT CHECKS: the pre-signature guards stay enabled
   * under any configuration.
   */
  endpoints?: {
    readonly explorer?: { readonly evmTx?: string; readonly evmAddr?: string; readonly evmName?: string; readonly xmrTx?: string };
    readonly rpc?: { readonly evm?: string; readonly monero?: string };
  };
  /**
   * Renaming API paths by name: { swaps, swap, evmSwaps, orderQuote, orderSell, revealedHalf, swept }.
   * An unknown name is bad-input (a typo must not silently fall back to the default).
   */
  routes?: Readonly<Record<string, string>>;
  /**
   * READING THE CHAIN FROM OUTSIDE - a seam for whoever runs the SDK outside a browser. By default the chain is read
   * by the page's wallet (the engine's readContract), and in Node there is no such wallet: predict, the order state
   * and the fee cannot be read, so a live run from Node was impossible. Your own function ({ to, data }) -> hex goes
   * both into the lock step and into the swap start. THIS IS A READ, NOT A NODE SUBSTITUTION: the addresses and the
   * network are still taken from the registry and the options, and the pre-signature guards stay enabled under any
   * configuration.
   */
  evmCall?: (request: { readonly to: string; readonly data: string }) => Promise<string>;
  /**
   * READING THE CONTRACT CODE FROM OUTSIDE (issue #103): ({ address }) -> hex code. Needed for the factory-code
   * check - `extcodehash` is keccak256 of this code, and the factory a provider names in its registry record is
   * matched against the interface's known builds. Same rule as evmCall: a read, not a node substitution.
   */
  evmCode?: (request: { readonly address: string }) => Promise<string>;
  /**
   * READING THE ESCROW'S LOGS FROM OUTSIDE (issue #40): `({ address, topics, fromBlock, toBlock }) -> logs`, for
   * the MAKER'S DECLINE. The escrow emits `Declined(claimer)` and keeps NO getter that names it, while `status()`
   * reads a decline and an ordinary refund the same way - so the event is the only on-chain fact that tells them
   * apart. By default the logs are read through the page's wallet, the same provider `evmCall` uses, so the wallet
   * that reads is the wallet that signs. Same rule as `evmCall`: a READ, not a node substitution - the address is
   * the order's escrow and the topic is the package's own.
   */
  evmLogs?: EvmLogReader;
  /**
   * READING A SETTLEMENT BLOCK FROM OUTSIDE (`(tag) => block`): the claim-tip check needs the chain's current
   * `baseFeePerGas`. A missing seam is `quote-tip-unchecked` when a quote carries a non-zero tip; zero tips (the
   * buy side) never call it.
   */
  evmBlock?: (tag?: string) => Promise<{ readonly baseFeePerGas?: string | number | bigint | null;
    readonly baseFeeWei?: string | number | bigint | null }>;
  /**
   * THE INTERFACE'S OWN ADMISSION LIST - policy, not proof. The chain (maker registry, providerOf, taken from the
   * quote) proves whose key signed; this says whom THIS interface trades with at all. An array of provider
   * addresses (or providerIds) or a predicate `(provider) => boolean`. A provider the chain confirms but the list
   * excludes is refused with `quote-provider-not-allowed`.
   */
  allowedProviders?: readonly string[] | ((provider: string) => boolean);
  /**
   * THE INTERFACE'S FACTORY POLICY (issue #103) - policy, not proof, and sitting next to allowedProviders. The
   * factory is taken from the provider's REGISTRY RECORD (`factoryOf`), the signed quote must name the same one, and
   * its CODE is matched against this list of build hashes (`extcodehash` = keccak256 of the runtime code). A factory
   * whose code is not on the list is refused with `quote-factory-code-unknown`. An empty/absent list means "no
   * policy": the record's factory must still be named and agree with the quote.
   */
  knownFactoryCodes?: readonly string[];
  /**
   * THE INTERFACE'S ESCROW-IMPLEMENTATION POLICY (issue #114) - policy, not proof, next to knownFactoryCodes and
   * allowedProviders. Since #114 every order's escrow is an EIP-1167 clone of ONE shared implementation, and the
   * factory carries the pair (`implementation()`, `implementationCodeHash()`). The factory checks that pair at
   * creation; the core checks the SAME pair on chain - it reads the pair off the factory, reads the code at the
   * implementation's address, re-hashes it and matches it against this list of known build hashes (`keccak256` of
   * the implementation's runtime code, a protocol constant: the implementation has no immutables). An implementation
   * whose code is not a known build (or has no code at all) is refused with `quote-factory-code-unknown`; a pair
   * that cannot be read at all (an older factory without those getters) is refused with `quote-factory-unchecked`.
   * An empty/absent list means "no policy": the pair is still read and the implementation's code must be non-empty.
   */
  knownImplementationCodes?: readonly string[];
  /**
   * THE INTERFACE'S ADDRESS DENYLIST (issue #16) - policy, not proof, next to allowedProviders. Addresses the
   * interface will not trade to or from, compared WITHOUT CASE. The SDK fetches nothing: the interface brings the
   * list in. An empty/absent list means "no check".
   * Before `quotes.firm` the order's `locker` is checked (on a purchase the claimer is the node's own address, so
   * it is deliberately not checked), and before `swaps.start` the ACTUAL sender - the address the funding will be
   * sent from (`eth_accounts[0]` read from the wallet adapter at the moment of sending on demand; the person may
   * have switched accounts). A barred address is refused with `address-denied` BEFORE any request. A node's own
   * `denied-address` refusal reaches the app under the same code, WITHOUT the node's `why` text and WITHOUT the
   * address: the interface shows its own neutral message.
   */
  denylist?: readonly string[];
  /**
   * A PASS TO OUR SERVICE for the "server" step (recording the swap with us). Only a wallet can sign the sign-in
   * message, and the wallet's role in the SDK is an adapter: windows and message signatures remain the interface's,
   * and the core receives a READY pass through the same seam the interface obtains it with today
   * (www/js/evm/auth.js, signIn).
   * A missing option is not an error: the "server" step then names the app's refusal with a code (`server-refused`,
   * 401), rather than going in blind.
   */
  serverAuth?: () => Promise<string | null> | string | null;
  /**
   * POLLING THE MONERO ADDRESS: the rate and the timeout for the XMR arrival. The defaults come from the engine's
   * settings (the page's rate `API.pollMs`; the timeout - `blockTimeReal x confirmTarget`, that is, the time to
   * gather the target's confirmations). Zero and negative values are `bad-input`: "wait zero" is a typo, not a
   * setting.
   */
  watch?: { readonly pollMs?: number; readonly timeoutMs?: number };
  /**
   * YOUR OWN SWAP RECORD AND YOUR OWN ORDER SIDE - A CAPABILITY, NOT A REQUIREMENT. By default the core builds the
   * record and the order side (halves, points, the DLEQ proof) ITSELF and ONCE: this same side goes both into the
   * record and into the lock terms. The function is for whoever wants to bring their own side (for example, to know
   * it in advance and predict the escrow address before signing). Then the core does not build the side itself and
   * takes `side` from the result; the lock terms must then carry this side's points and commitments.
   */
  createRecord?: (request: StartRequest) => Promise<SwapRecord> | SwapRecord;
}

/** The result of assembling the swap record: the record itself, your own side and what is missing. */
export interface SwapRecord {
  readonly swap: Readonly<Record<string, unknown>>;
  /** Our side of the order: halves, points, the proof and the encryption key. The shape is set by the builder. */
  readonly side: unknown;
  /** What the record is missing: for a start that is the counterparty's half (`counterparty-half`). */
  readonly missing: readonly string[];
  /** The next step the record names (for a start - `order`). */
  readonly nextStep: string;
}

export interface StorageAdapter {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: unknown) => Promise<HttpResponse>;

/** EIP-1193: the minimum the SDK requires of a wallet. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export interface Ninsei {
  /** Networks, tokens, limits, thresholds. The interface takes the lists from here, not hardcoded. */
  readonly config: SdkConfig;
  readonly wallet: WalletApi;
  readonly quotes: QuotesApi;
  /** Pre-signature checks. Returns codes, not text: showing is the interface's job. */
  preflight(offer: QuoteLike, options?: PreflightOptions): Promise<PreflightResult>;
  readonly swaps: SwapsApi;
  /** The XMR withdrawal (what the sweep page does): parsing the file, requesting data and the withdrawal itself. */
  readonly sweep: SweepApi;
  /** Order checks: the counterparty's side and the joint address. */
  readonly order: OrderApi;
  /**
   * Actions on an ALREADY created escrow: marking ready, claiming, refunding. They go through the same chain-read
   * seam as the lock. The slot check against the chain stands in them BEFORE the signature, and without
   * expectations (`expect`) they sign nothing.
   */
  readonly actions: ActionsApi;

  readonly recovery: RecoveryApi;
  /** Only in "sim" mode: failure scenarios and sandbox time control. */
  readonly sim: SimApi | null;
}

export interface SdkConfig {
  /** The settlement network chosen in the options, and its virtual machine. */
  readonly settlement: { readonly chain: ChainConfig; readonly vm: string };
  readonly chains: readonly ChainConfig[];
  readonly xmrNetworks: readonly string[];
  /** The witness nodes per Monero network: the built-in defaults merged with the `nodes` and `addNodes` options. */
  readonly xmrNodes: Readonly<Record<string, readonly (XmrNode | string)[]>>;
  /** The witness nodes for one Monero network; a network with no nodes answers an empty list. */
  nodesFor(network: string): readonly (XmrNode | string)[];
  readonly assetsBase: string;
  readonly apiBase: string;
  readonly mode: "live" | "sim";
  /** Addresses already resolved: the default from the network registry, the override from the options. */
  readonly endpoints: {
    readonly explorer: { readonly evmTx: string | null; readonly evmAddr: string | null; readonly evmName: string | null; readonly xmrTx: string | null };
    readonly rpc: { readonly evm: string | null; readonly monero: string | null };
  };
  /** Named API paths: name -> template, already with the overrides from the options. */
  readonly routes: Readonly<Record<string, string>>;
  /** Assemble a path by name and params (route("swept", { id })). An unknown name is bad-input. */
  route(name: string, params?: Readonly<Record<string, string>>): string;
  /** The protocol's thresholds (windows, confirmations, limits) - data, not interface constants. */
  readonly limits: {
    readonly minAmount: number | null;
    readonly maxAmount: number | null;
    readonly stepAmount: number | null;
    readonly xmrConfirmTarget: number | null;
    readonly readyLeadWarnSec: number | null;
    /** How often the SDK polls the market (from the engine's settings). */
    readonly quotePollMs: number;
    /** The timeout of a single request to the service. */
    readonly httpTimeoutMs: number;
    /** How often the SDK polls the watch on the Monero address (an engine setting or the `watch` option). */
    readonly watchPollMs: number;
    /** How long the SDK waits for the XMR to arrive before answering with the code `xmr-timeout`. */
    readonly watchTimeoutMs: number;
  };
  /** The available route providers and the order of preference chosen in the options. */
  readonly routing: { readonly providers: readonly string[]; readonly prefer: readonly string[] };
  /** The step, check and error codes the SDK works with: a table for the interface and translations. */
  readonly codes: {
    readonly steps: readonly string[];
    readonly checks: readonly string[];
    readonly errors: readonly string[];
  };
}

export interface ChainConfig {
  readonly id: string;
  /** The network's virtual machine: "evm" today; "tron" and "solana" - when their leg drivers appear. */
  readonly vm: string;
  readonly chainId: number;
  readonly name: string;
  readonly nativeSymbol: string;
  readonly tokens: readonly TokenConfig[];
  readonly dex: { readonly routes: readonly unknown[] } | null;
  /** The escrow deployment on this network, when there is one. `deploymentBlock` is the block that holds the factory's creation. */
  readonly escrow: {
    readonly address: string | null;
    readonly mode: string | null;
    readonly deploymentBlock: number | null;
  } | null;
}

export interface TokenConfig {
  readonly id: string;
  readonly symbol: string;
  readonly address: string | null;
  readonly decimals: number;
}

// --- The wallet ---------------------------------------------------------------------------------

export interface WalletApi {
  /**
   * Connect a wallet adapter. The SDK opens no windows - the adapter is brought by the interface
   * (`evmWallet(provider)` from `@ninsei-labs/sdk/adapters`; another VM will have its own adapter).
   * The adapter must be for the same vm as the settlement network: otherwise `bad-input`.
   */
  use(adapter: WalletAdapter): void;
  /** Whether a wallet is connected and on which network. */
  status(): WalletStatus;
  connect(options?: { chainId?: number }): Promise<WalletStatus>;
  disconnect(): Promise<void>;
  address(): string | null;
  /** Switch the wallet's network. Returns the state after the attempt. */
  switchChain(chainId: number): Promise<WalletStatus>;
  /**
   * Balances of the settlement network's native and ERC-20 tokens, in minimal units as a string. For a Monero
   * wallet - one XMR balance in atomic units (piconero): it is read by the wallet itself, with the method
   * `unlockedBalance`. What is not read is not replaced with zero: a refusal comes as a code.
   */
  balances(tokens?: readonly string[]): Promise<readonly Balance[]>;
  /** Subscribe to wallet changes. Returns an unsubscribe function. */
  subscribe(handler: (status: WalletStatus) => void): () => void;
  /**
   * What the adapter signs and reads the chain with: for EVM - an EIP-1193 provider. Needed by the settlement-leg
   * driver; by the interface - only if it wants to hand it to its own extension. The shape depends on the vm.
   */
  driver(): unknown;
}

/**
 * THE WALLET ADAPTER - the only thing the SDK knows about a wallet. The core knows neither EIP-1193 nor the Solana
 * wallet-standard: it requires this interface and the `vm` matching the settlement network. That is how a new VM's
 * wallet is added by an adapter rather than by editing the core.
 */
export interface WalletAdapter {
  /**
   * The adapter's virtual machine: "evm" (the settlement network) today; "monero" - the wallet of the swap's other
   * side. Any other vm is not accepted: substituting a foreign one means reading the balance and signing on the
   * wrong chain.
   */
  readonly vm: string;
  /** A short name for the interface (not a user-facing text). */
  readonly id?: string;
  connect(options?: { chainId?: number | string }): Promise<void>;
  disconnect(): Promise<void>;
  /** The address or public key: the string this VM uses to name an account. */
  address(): string | null | Promise<string | null>;
  /** What this VM calls the network: for EVM - a chainId number, for others - their identifier. */
  chainId(): number | string | null | Promise<number | string | null>;
  /**
   * THE FREE REMAINDER OF THE MONERO WALLET in atomic units (piconero; 1 XMR = 10^12 - 12 decimal places). The same
   * method the XMR withdrawal calls (on the sweep page - `getUnlockedBalance` in monero-ts), so the adapter sits on
   * top of it without an adapter. Declared only on the Monero adapter: for the others the balance is read by the leg
   * driver.
   */
  unlockedBalance?(): Promise<bigint | number | string>;
  /** Subscribe to wallet changes. Returns an unsubscribe function. */
  subscribe(handler: () => void): () => void;
  /**
   * SYNCING WITH THE NODE, if this wallet can (Monero: `wallet.sync()`, the name from the sweep page). Declared
   * optional: EVM has no syncing - the chain is read by the leg driver. No method - `not-implemented`, not silence.
   * For Monero, after the pass the `subscribe` subscribers are notified.
   */
  sync?(): Promise<void>;
  /**
   * STOP THE WALLET. The name is taken from the page (sweep/sweep.js calls `wallet.close()`); `disconnect` is the
   * interface's name. On the Monero adapter both lead to one: the library wallet is closed. Optional - on EVM there
   * is nothing to stop.
   */
  close?(): Promise<void>;
  /**
   * Send a leg transaction (lock, marking ready, claim, refund). The request shape is what this VM calls a transfer;
   * for EVM it is `{ to, data, value }` and the transaction hash in response.
   */
  send(request: { readonly to: string; readonly data?: string; readonly value?: bigint | number | string }): Promise<string>;
  /**
   * The transaction receipt: asked ONCE, returns the receipt or null (not in a block yet). The waiting policy is set
   * by the caller, not the adapter - otherwise two calls would wait differently.
   */
  receipt(txHash: string): Promise<unknown>;
  /**
   * SIGN TYPED DATA (EIP-712). Not a transaction: no gas, no money moves, so a person without their own coin can
   * give it. What is signed is decided by the CALLER (ready typed data arrives here). Optional - a wallet that
   * cannot sign typed data leaves it out, and a caller sees `not-implemented`, not silence.
   */
  signTypedData?(typedData: unknown): Promise<string>;
  /** Switching the network, if this VM can do it from the SDK. No method - `not-implemented`, not silence. */
  switchChain?(chainId: number | string): Promise<void>;
  driver(): unknown;
}

export interface WalletStatus {
  readonly connected: boolean;
  readonly address: string | null;
  readonly chainId: number | null;
  /** Does the wallet's network match the settlement network. */
  readonly chainMatches: boolean;
}

export interface Balance {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  /**
   * Minimal units as a string: numbers of this size do not fit in a number. For XMR these are atomic units
   * (piconero): 1 XMR = 10^12 at decimals = 12 - the same ones the XMR withdrawal carries; the core does not
   * reconvert them.
   */
  readonly amount: string;
}

// --- Quotes -------------------------------------------------------------------------------------

export interface FirmQuoteRequest {
  /** Who gives the quote. Without it there is no one to ask - this is not "the first one at hand". */
  readonly providerId: string;
  /** The order terms: how much, to whom, the deadlines, the salt. The context the signature is bound to is assembled from them. */
  readonly order: Readonly<Record<string, unknown>>;
  /**
   * THE TAKER'S MAKER VIEW HALF, when the order was built from a recovery key. Sent top-level to the node; the quote
   * must echo it, so the joint view key can be rebuilt from the twelve words.
   */
  readonly viewHalfClaimer?: string;
}

export interface QuotesApi {
  /**
   * Live indicative quotes. Returns an unsubscribe function.
   * A snapshot arrives on every tick and contains only data. The last one to unsubscribe stops the polling.
   */
  watch(request: QuoteRequest, onSnapshot: (snapshot: QuoteSnapshot) => void): () => void;
  /** The last snapshot without waiting: needed by whoever subscribed later than the first poll. */
  snapshot(): QuoteSnapshot | null;
  /** A binding quote with a TTL. A refusal comes as a code, not text. */
  firm(offer: FirmOffer): Promise<Quote>;
  /**
   * A reverse-mode ticket: the maker sells XMR. The request is the node's `request` object; the answer carries the
   * signed order quote and its claim tip, which is checked against the gas price before it is returned.
   */
  sale(request: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

export interface QuoteRequest {
  readonly direction: "buy" | "sell";
  /** A token identifier from config ("usdc", "usdt", "dai", ...). For a sell - what the user receives. */
  readonly token?: string;
  /** The size on the user's side: for a buy - how much they pay, for a sell - how much XMR they give. */
  readonly amount?: number;
  /**
   * THE EXPLICIT REQUEST SIZE in units of `unit` (buy - XMR, sell - token). Needed by whoever has already aligned
   * the volume to the provider's grid themselves: the core asks for EXACTLY this number rather than deriving the
   * size from `amount` anew.
   * Not set - the size is derived from `amount`, as before.
   */
  readonly size?: number;
}

export interface QuoteSnapshot {
  readonly direction: "buy" | "sell";
  readonly token: string;
  /** The amount on the user's side, as they entered it: for a buy - in the token, for a sell - in XMR. */
  readonly amount: number | null;
  /** The size asked of the provider, in units of `unit`. The price does not depend on it: it is needed so the
   * provider says whether it takes such a size. */
  readonly size: number;
  /** The unit of the size: XMR for a buy, the token for a sell. */
  readonly unit: string | null;
  /** The best offer's price: non-XMR coins per 1 XMR. null - there is no offer (and then it is not zero). */
  readonly rate: number | null;
  /** How much XMR for this size (buy) or how much XMR the person gives (sell). null - not computed. */
  readonly xmr: number | null;
  /** When the snapshot was received, milliseconds of the epoch. */
  readonly at: number;
  /** The provider node whose price is in the snapshot. */
  readonly providerId: string | null;
  /** The best offer for the requested volume and side, AS THE SERVICE NAMED IT. The core does not recompute it:
   * these are response data by which the interface confirms its own "best" mark by pair and provider. */
  readonly best: QuoteBest | null;
  /** Is the size ready: the node's grid and range are data, not an interface check. */
  readonly sizeOk: boolean;
  /** Why the size is not ready: `bad-size`, `below-min`, `above-max`, `no-offer`. `null` - ready. */
  readonly sizeCode: QuoteSizeCode;
  /** The provider's packet number: liveness of the market is counted by it, not by the clock. */
  readonly seq: number | null;
  /** All offers for this size. Indicative: only `quotes.firm` binds. */
  readonly offers: readonly QuoteOffer[];
  /** Book rows that did not become offers, with the reason as a code: `malformed`, `disabled`, `stale`. */
  readonly refused: readonly QuoteRefusal[];
  /** Reference rates (the price benchmark), as the service returned them. Not a swap offer. */
  readonly references: readonly QuoteReference[];
  /** Are there offers and is the service's response alive. */
  readonly ok: boolean;
  /** Why there is no market: a code, no text. */
  readonly error?: { readonly code: ErrorCode };
}

export type QuoteSizeCode = "bad-size" | "below-min" | "above-max" | "no-offer" | null;

/** The best, as the service named it: the pair and the node. The core does not recompute the price. */
export interface QuoteBest {
  readonly providerId: string;
  readonly pair: string;
}

export interface QuoteOffer {
  readonly providerId: string;
  readonly displayName: string | null;
  readonly pair: string;
  readonly asset: string | null;
  readonly currency: string | null;
  readonly rate: number;
  readonly rateQuote: number;
  /** The claim tip in native-token wei; a sale is ranked by the payout AFTER it. */
  readonly claimTip: string;
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
  readonly ttlMs: number | null;
  readonly at: number | null;
  readonly seq: number | null;
  readonly finality: string | null;
  /** The network of the XMR side and of the settlement side, as the quote named them. Not named - null, not our network. */
  readonly assetNetwork: string | null;
  readonly currencyNetwork: string | null;
  readonly networkStated: boolean;
  /** The networks were filled in by the receiver / not named at all - this is a fact about the quote, not "matched". */
  readonly networksDerived: boolean;
  readonly networksUnnamed: boolean;
  /** The reason named by the provider, as is; the package's signature and key; the age by its own mark. */
  readonly why: string | null;
  readonly signature: string | null;
  readonly keyId: string | null;
  readonly ageMs: number | null;
  readonly networks: { readonly asset: string | null; readonly currency: string | null; readonly stated: boolean };
}

/**
 * Every code a route provider of this package refuses with.
 *
 * The providers already name them in their own tables (`COW_REFUSAL_CODES` and its three siblings), and the
 * battery proves each of those is reachable; what was missing was the TYPE, so an interface could enumerate
 * them instead of meeting a string it cannot switch on. `broken` is shared by all four: it is the code for a
 * case a provider could not classify. `RouteRefusalTables` below declares what those tables ARE - each of them a
 * `readonly RouteRefusalCode[]` - so the union is the tables' TYPE and not a comment standing beside them.
 *
 * These are OUR codes, and they are what a person's message should be phrased from. A provider's OWN reason
 * stays opaque on purpose (`QuoteRefusal.why`): that is data the provider sent, not a name of ours, so it is
 * deliberately NOT part of this union.
 */
export type RouteRefusalCode =
  // cow
  | "cow-bad-order"
  | "cow-bad-response"
  | "cow-not-settled"
  | "cow-order-unknown"
  | "cow-refused"
  | "cow-sign-failed"
  | "cow-unknown-network"
  | "cow-unreachable"
  // kyber
  | "kyber-bad-order"
  | "kyber-bad-response"
  | "kyber-not-settled"
  | "kyber-order-unknown"
  | "kyber-refused"
  | "kyber-sign-failed"
  | "kyber-unknown-network"
  | "kyber-unreachable"
  // uniswapx
  | "uniswapx-bad-order"
  | "uniswapx-bad-response"
  | "uniswapx-no-submitter"
  | "uniswapx-not-settled"
  | "uniswapx-order-unknown"
  | "uniswapx-refused"
  | "uniswapx-sign-failed"
  | "uniswapx-unknown-network"
  | "uniswapx-unreachable"
  // uniswap-relay
  | "uniswap-relay-bad-order"
  | "uniswap-relay-bad-response"
  | "uniswap-relay-no-discovery"
  | "uniswap-relay-not-settled"
  | "uniswap-relay-sign-failed"
  | "uniswap-relay-unknown-network"
  | "uniswap-relay-unreachable"
  // shared
  | "broken";

/**
 * WHAT THE FOUR REFUSAL TABLES *ARE*. Each route provider names its own refusals in one table - `COW_REFUSAL_CODES`
 * (src/legs/cow.mjs), `KYBER_REFUSAL_CODES` (src/legs/kyber.mjs), `UNISWAPX_REFUSAL_CODES` (src/legs/uniswapx.mjs) and
 * `UNISWAPRELAY_REFUSAL_CODES` (src/legs/uniswaprelay.mjs) - and every one of those tables is a
 * `readonly RouteRefusalCode[]`. The dependency runs ONE WAY on purpose: a table answers to the union (a code that is
 * not declared above cannot enter a table), while the union answers to no single table, so the same vocabulary is
 * met in four modules.
 *
 * THEY ARE NOT ON THIS ENTRY'S SURFACE, and this is deliberately NOT a value: the package re-exports no provider and
 * no table (src/index.mjs), the tables travel in the shipped source (`files` in package.json) and they are the
 * VOCABULARY, not an API. A `declare const` here that the runtime does not export would be a lie, and the `surface`
 * check refuses exactly that - so the tables are declared as their TYPE. That is what keeps the union from being a
 * comment beside the tables: this declaration says what they are, and the `refusals` check says the same thing from
 * the other side - a table declared here as a plain `readonly string[]` is a named problem there.
 */
export interface RouteRefusalTables {
  readonly COW_REFUSAL_CODES: readonly RouteRefusalCode[];
  readonly KYBER_REFUSAL_CODES: readonly RouteRefusalCode[];
  readonly UNISWAPX_REFUSAL_CODES: readonly RouteRefusalCode[];
  readonly UNISWAPRELAY_REFUSAL_CODES: readonly RouteRefusalCode[];
}

export interface QuoteRefusal {
  readonly providerId: string;
  readonly displayName: string | null;
  readonly pair: string;
  readonly asset: string | null;
  readonly currency: string | null;
  readonly rate: number | null;
  readonly rateQuote: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
  readonly ttlMs: number | null;
  readonly at: number | null;
  readonly seq: number | null;
  readonly ageMs: number | null;
  readonly assetNetwork: string | null;
  readonly currencyNetwork: string | null;
  readonly networkStated: boolean;
  readonly code: "malformed" | "disabled" | "stale";
  /** The reason named by the provider, as is: this is data, not our wording. */
  readonly why: string | null;
}

export interface QuoteReference {
  readonly source: string;
  readonly value: number | null;
  readonly at: number | null;
}

export interface FirmOffer {
  readonly direction: "buy" | "sell";
  readonly token: string;
  readonly amount: number;
  readonly receiveTo: string;
  readonly providerId?: string;
}

/**
 * A binding quote. The SDK does not reassemble the signature body: the signed fields are passed on as is - otherwise
 * the signature stops matching.
 */
export interface Quote {
  readonly id: string;
  readonly direction: "buy" | "sell";
  readonly providerId: string;
  readonly chain: string;
  readonly token: string;
  readonly amount: number;
  readonly xmr: number;
  readonly rate: number;
  /** The moment after which the quote must not be signed, milliseconds of the epoch. */
  readonly expiresAt: number;
  readonly receiveTo: string;
  readonly signedPayload: unknown;
}

// --- Pre-signature checks -----------------------------------------------------------------------

export interface PreflightOptions {
  readonly payBalanceWei?: string;
  readonly payAmountWei?: string;
  readonly nativeBalanceWei?: string;
  readonly requiredNativeWei?: string;
  readonly gasReserveWei?: string;
  /** Consent to the token allowance (approve). Without it the allowance check blocks the signature. */
  readonly allowanceConsent?: boolean;
  readonly allowanceWei?: string;
  readonly nowMs?: number;
}

export interface PreflightResult {
  /** Whether it can be signed right now. */
  readonly ok: boolean;
  /** The codes of what stands in the way. Empty if ok. */
  readonly blockedBy: readonly CheckCode[];
  /** What was checked and with what verdict - in the order of passage. */
  readonly checks: readonly Check[];
}

export interface Check {
  /** A stable check code (the table in README). */
  readonly code: CheckCode;
  readonly ok: boolean;
  /** Was the check run at all: `false` means "not measured", not "good". */
  readonly checked: boolean;
  /** Does it stand in the way of signing. */
  readonly blocks: boolean;
  /** The check's original name in the engine: for reports and debugging, not for showing the user. */
  readonly kind: string;
  /** The numbers and names the verdict was taken from: need/have/symbol/min/max/at/expiresAt etc. */
  readonly params: Readonly<Record<string, unknown>>;
}

export type CheckCode =
  | "balance"
  | "gas"
  | "allowance"
  | "consent"
  | "network"
  | "settlement-network"
  | "stale"
  | "deadline"
  | "range"
  | "size"
  | "escrow-state"
  | "escrow-points"
  | "counterparty"
  | "slots"
  | "unchecked"
  | "unknown";

/** The same as Quote, but a node response body is allowed too: the SDK does not reassemble the signed fields. */
export type QuoteLike = Quote | (Record<string, unknown> & { signedPayload?: unknown });

// --- Swaps --------------------------------------------------------------------------------------

export interface SwapsApi {
  /**
   * Start a swap. The SDK holds the step order, not the screen:
   *   1) guards (preflight); 2) the swap record (createSwap); 3) the order - it GENERATES the key halves;
   *   4) the recovery file / one key and the interface's confirmation that it is saved; 5) locking the funds (signature);
   *   6) saving on the server; 7) opening the watch on the Monero address.
   * HALVES DO NOT EXIST BEFORE THE ORDER: the recovery file carries MY half of the spend key and the counterparty's
   * open points, and they are taken from the signed order (www/js/atomic/order-worker.js, createOrderBuilder; in the
   * engine they are fetched by halvesWalletOf). So the file is assembled AFTER the order, but BEFORE locking the
   * funds.
   * FUNDS ARE NOT LOCKED UNTIL onRecoveryFile ALLOWS IT: the order is like this not for convenience, but because a
   * lock without a recovery file is a lock with nothing to open it with if the browser is lost.
   */
  start(request: StartRequest): Promise<SwapStart>;
  /**
   * WAIT FOR THE XMR TO ARRIVE at the order's joint address. The polling uses the same request as the page's
   * (GET /swaps/{id}), the rate and the timeout - from `config.limits` and overridable here.
   * It arrived - the FACT is returned (the amount, the confirmations, the txid); we did not wait - a refusal with
   * the CODE `xmr-timeout`, separate from the others: "the wait expired" is a state of the money, not a breakdown.
   * XMR ON THE ADDRESS BUT LOCKED BY `unlock_time` is a THIRD answer with its own code `xmr-locked` (the boundary,
   * a height or a date, is in `params.until`): locked funds are NOT an arrival, and nothing is signed under them.
   * IF `expect` AND `wallet` ARE PASSED, then after the arrival the ready mark (actions.markReady) is called with
   * THESE expectations: the slot check against the chain stands in it before the signature. Without them the step
   * names the next one (`next: "mark-ready"`) and signs nothing.
   * THE MAKER DECLINED - THE WAIT STOPS AT ONCE (issue #40): the escrow's `Declined` event and the service's
   * `declined` + `compliance` status are BOTH asked on every tick, and either one ends the wait with
   * `SwapDeclinedWatch` instead of running to `xmr-timeout` about an order whose ETH is already back. Nothing is
   * signed, and the decline is written into the record, so every later read of the swap reports the same state.
   */
  watch(request: SwapWatchRequest): Promise<SwapWatch | SwapDeclinedWatch>;
  /**
   * THE XMR ARRIVAL CHECK WITHOUT THE WATCH LOOP (issue #85). The client reads the chain itself with its own view
   * key and `ready` opens only when at least two nodes of DIFFERENT operators see the transaction IN THE SAME BLOCK
   * (the block hash matches) with the required confirmations. Refusals come as CODES: `xmr-nodes-disagree` (a synced
   * node has no such transaction there or a different block hash), `xmr-no-nodes` (nothing reachable),
   * `xmr-underpaid`, `xmr-locked`, `xmr-too-late`. A waiting state is RETURNED as `state` (`pending` | `one-node`),
   * never a silent success.
   */
  verifyArrival(request: XmrArrivalRequest): Promise<XmrArrivalVerdict>;
  /** Fewer seconds before the ready deadline than the confirmations take - a named refusal (`xmr-too-late`). */
  assertTimeForConfirmations(request: XmrDeadlineRequest): number | null;
  /**
   * THE CLIENT'S OWN EARLY REFUND WHEN THE XMR DID NOT ARRIVE (issue #88). While the interface is open, a depositor
   * who sees no XMR on the joint address takes the ETH back BEFORE `readyBy` - after it the maker may claim even
   * without the ready mark, and the early window is gone. The arrival is decided by THE SAME check as the watch
   * (`verifyArrival`). Only a positive `pending`/`one-node` verdict refunds; an `arrived` verdict does not; a failure
   * to check (no nodes, a disagreement) throws its own code and signs nothing. It fires only when less than the
   * confirmations' time is left before `readyBy` (`minConfirmations * blockTimeSec`, overridable with `leadSec`).
   */
  refundIfXmrMissing(request: AutoRefundRequest, deps?: AutoRefundDeps): Promise<AutoRefundVerdict>;
  /** Unfinished swaps after a page reload. */
  list(): Promise<readonly SwapState[]>;
  get(id: string): Promise<SwapState | null>;
  /**
   * THE SERVICE'S SWAP LIST, MERGED INTO THE LOCAL ONE. The path is the page's (www/js/evm/auth.js,
   * loadServerSwaps: GET /api/evm-swaps), and the merge rule is the ENGINE'S (core/swap.js, addServerSwaps): a
   * local record always wins, the service only adds what this browser does not have, and a record that came
   * from the service is marked `source: "server"`. The pass is obtained by the interface and only presented by
   * the core (the `serverAuth` seam): without it the service's own refusal comes as a code. `added` says how
   * many records the merge brought in - the interface decides by it whether the list changed, instead of
   * guessing.
   */
  sync(): Promise<SwapSync>;
  /**
   * REMOVE A RECORD FROM THE LOCAL LIST. The record leaves THIS store alone: on the service and in the
   * contract everything stays, so this is a tidy-up of the list, not a cancellation of the swap. `false` means
   * there was no such record.
   */
  forget(id: string): Promise<boolean>;
  /**
   * THE DEAL-PROGRESS SNAPSHOT: the record's own facts, the wallet rebuilt from the halves and the DERIVED deal
   * view (phase, allowed actions, deadlines, steps, the Monero leg, the two amounts). The progress screen draws
   * this snapshot; it does not read the record or derive the state itself, so the deal's rules live in one place.
   * `null` - there is no such record (this is NOT an empty state).
   */
  progress(id: string): Promise<SwapProgress | null>;
  /**
   * THE DEMONSTRATION RECORD'S ACTIONS (mode `sim`): confirm readiness, refund the ETH, sweep the XMR. In a live
   * swap the same steps go through `actions` (a real escrow and the wallet adapter); these are the sandbox's record
   * mutations, kept in the core rather than on the screen.
   */
  confirmReady(id: string): Promise<unknown>;
  refundEth(id: string, by?: string): Promise<unknown>;
  sweepNow(id: string): Promise<unknown>;
  /**
   * WHERE TO WITHDRAW THE XMR: writes the record's `receiveAddress` (it is part of the recovery file). The order
   * and the chain are untouched. `null` - there is no such record.
   */
  setDestination(id: string, address: string): Promise<unknown>;
  /**
   * THE MONERO NETWORK OF AN ADDRESS, BY ITS SHAPE (`mainnet` | `stagenet` | `testnet`), or `null`. The format and
   * the prefixes live in one module - the same one the Monero wallet adapter uses - so no interface keeps its own
   * prefix table.
   */
  addressNetwork(address: string): Promise<string | null>;
}

/**
 * THE DEAL-PROGRESS SNAPSHOT. `swap` carries the record's own fields (what the interface shows and hands back as
 * order expectations); `swapWallet` is the wallet rebuilt from the halves (the recovery file is assembled from it);
 * `view` is the DERIVED deal state. The names in `view` are the engine's derive output: `phase`/`phaseLabel`,
 * `can` (the allowed actions), `deadlines`, `steps`, `xmr`/`xmrAmount`, `sellWindow`, `readyDeadline`, `terminal`.
 */
export interface SwapProgress {
  readonly id: string;
  readonly swap: Readonly<Record<string, unknown>>;
  readonly swapWallet: unknown;
  readonly view: SwapProgressView;
}

/** The derived deal state the progress screen draws. Loose by design: the fields are the engine's derive output. */
export interface SwapProgressView {
  readonly swap: unknown;
  readonly phase: string;
  readonly phaseLabel: string;
  readonly note: string | null;
  readonly sim: number;
  readonly simWallTime: number;
  readonly conf: number;
  readonly confTarget: number;
  readonly confProgress: number;
  readonly can: Readonly<Record<string, unknown>>;
  readonly deadlines: Readonly<Record<string, unknown>>;
  readonly steps: readonly Readonly<Record<string, unknown>>[];
  readonly xmr: Readonly<Record<string, unknown>>;
  /** The amount promised by the quote and the one seen at the address: the interface shows both. */
  readonly xmrAmount: { readonly expected: number | null; readonly seen: number | null };
  readonly sellWindow: unknown;
  readonly readyDeadline: Readonly<Record<string, unknown>>;
  readonly xmrReclaimed: boolean;
  readonly simulated: { readonly evm: boolean; readonly xmr: boolean };
  /** The terminal state (the record's settlement), or null while the swap is live. */
  readonly terminal: unknown;
}

/** The outcome of merging the service's list: how many rows the service gave, how many were new locally. */
export interface SwapSync {
  readonly ok: true;
  readonly added: number;
  readonly seen: number;
}

/** ONE WITNESS NODE: the address, and whose node it is (two nodes of one operator are one opinion). */
export interface XmrNode {
  readonly url: string;
  readonly operator?: string;
}

/**
 * THE ARRIVAL CHECK'S INPUTS. The joint address, the joint view SECRET and the joint SPEND PUBLIC key - all of them
 * the client has and the backend does not need. `txid` is only a HINT from the maker's node (a fabricated one fails
 * the check); without it blocks are walked from `fromHeight`.
 */
export interface XmrArrivalRequest {
  readonly nodes: readonly (XmrNode | string)[];
  readonly address: string;
  readonly viewSecret: string | bigint;
  readonly spendPub: string;
  readonly expectedAtomic: string | number | bigint;
  readonly minConfirmations?: number;
  readonly txid?: string | null;
  readonly fromHeight?: number | null;
  readonly nowSec?: number;
  readonly timeoutMs?: number;
}

/** The XMR state the watch hands to the interface: the fact, the waiting state, or a refusal with a code. */
export interface XmrArrivalVerdict {
  readonly seen: boolean;
  readonly state: "arrived" | "pending" | "one-node";
  readonly txid: string | null;
  readonly height?: number;
  readonly blockHash?: string;
  readonly amountAtomic?: string;
  readonly confirmations?: number;
  readonly needConfirmations?: number;
  readonly operators?: readonly string[];
  readonly agreedBy?: readonly { readonly url: string; readonly operator: string; readonly blockHash: string; readonly confirmations: number }[];
}

/** What the client's own check established on the agreed block. */
export interface XmrArrivalFact {
  readonly height: number;
  readonly blockHash: string;
  readonly operators: readonly string[];
  readonly agreedBy: readonly { readonly url: string; readonly operator: string; readonly blockHash: string; readonly confirmations: number }[];
}

export interface XmrDeadlineRequest {
  readonly readyBySec?: number | null;
  readonly nowSec?: number;
  readonly minConfirmations?: number;
  readonly blockTimeSec?: number;
}

/**
 * THE INPUTS OF THE CLIENT'S OWN EARLY REFUND. The joint address, the joint view secret, the joint spend public key
 * and the expected sum are taken from `swap` when it is given (the same derivation as the watch), or passed
 * explicitly. `expect` (the order expectations) and a wallet are mandatory: the refund reveals the depositor's half
 * and checks the order's slots before signing.
 */
export interface AutoRefundRequest {
  /** The swap record; the joint address, view secret, spend point, half and XMR amount are read from it. */
  readonly swap?: unknown;
  readonly escrow?: string;
  readonly halfLocker?: string;
  readonly expect?: unknown;
  readonly wallet?: unknown;
  readonly address?: string;
  readonly viewSecret?: string | bigint;
  readonly spendPub?: string;
  readonly expectedAtomic?: string | number | bigint;
  readonly nodes: readonly (XmrNode | string)[];
  readonly readyBySec?: number;
  readonly fromHeight?: number | null;
  readonly txid?: string | null;
  readonly minConfirmations?: number;
  readonly blockTimeSec?: number;
  /** How long before `readyBy` the refund becomes due. Defaults to `minConfirmations * blockTimeSec`. */
  readonly leadSec?: number;
  readonly timeoutMs?: number;
  readonly nowSec?: number;
  readonly onStep?: (step: string) => void;
}

/** The seams the checks substitute; in production they are the real arrival check and the real refund. */
export interface AutoRefundDeps {
  readonly verify?: (request: unknown) => Promise<{ seen: boolean }>;
  readonly refund?: (request: unknown, wallet: unknown) => Promise<{ hash?: string | null }>;
  readonly now?: () => number;
}

/** What the client's own refund decided: refunded, waiting, still time, or the XMR is there. */
export interface AutoRefundVerdict {
  readonly refunded: boolean;
  readonly state: "refunded" | "waiting" | "claim-window" | "arrived";
  readonly hash?: string | null;
  readonly leftSec: number;
  readonly needSec?: number;
  readonly readyBy?: number;
  readonly nowSec?: number;
}

/**
 * THE OUTCOME OF A START: funds locked, the swap recorded with us, the address watch opened.
 * There is NO XMR arrival here YET - the state is named (`step: "xmr-incoming"`), not passed off as completion.
 */
export interface SwapStart {
  readonly id: string | null;
  /** The escrow address FROM THE RECEIPT, not from a prediction. */
  readonly escrow: string | null;
  /** The order's joint Monero address - the one the XMR arrives at. */
  readonly address: string;
  readonly step: "xmr-incoming";
  readonly server: {
    readonly marked: boolean;
    /** The service's response code to the mark. */
    readonly httpStatus: number;
    /** What the service said about tying the quote to the escrow (its refusal does not abort the swap). */
    readonly orderBinding: unknown;
  };
  readonly watch: {
    readonly registered: boolean;
    readonly httpStatus: number;
    /** The watch record's identifier at the service: the state is queried by it. */
    readonly id: string | null;
    readonly address: string;
    readonly status: string | null;
    readonly expectedXmr: number;
    readonly receivedXmr: number;
    readonly confirmations: number;
    readonly txids: readonly string[];
  };
  /** The named next step: wait for the arrival. */
  readonly next: "watch";
}

export interface SwapWatchRequest {
  /** The watch record's identifier at the service (from SwapStart.watch.id). */
  readonly id: string;
  /** The escrow address for the ready mark (mandatory when `expect` and `wallet` are passed). */
  readonly escrow?: string;
  /** How often to ask the state. Default - `config.limits.watchPollMs`. */
  readonly pollMs?: number;
  /** How long to wait for the arrival. Default - `config.limits.watchTimeoutMs`. */
  readonly timeoutMs?: number;
  /** The order expectations for the slot check: passed TOGETHER with `wallet`, or not passed at all. */
  readonly expect?: Readonly<Record<string, unknown>>;
  /** The wallet for the ready mark. */
  readonly wallet?: WalletAdapter;
  /** Messages about the signing stage (codes, not user-facing texts). */
  readonly onStep?: (stage: string, detail?: string) => void;
  /**
   * CLIENT-SIDE ARRIVAL CHECK (issue #85). With this the CLIENT decides: it reads the chain itself and `ready`
   * opens only when two operators agree. The backend's `seen` is then only a notification and does not open the
   * button. Without it the watch keeps the service's answer.
   */
  readonly verify?: Omit<XmrArrivalRequest, "minConfirmations">;
  /** The confirmation target before `ready`. Default - `config.limits.xmrConfirmations` (10). */
  readonly minConfirmations?: number;
  /** The ready deadline in unix seconds; with less time left than the confirmations take it refuses with a code. */
  readonly readyBySec?: number;
}

/**
 * THE WATCH'S ANSWER WHEN THE MAKER DECLINED (issue #40). There is no arrival to wait for, so `seen` is false and
 * there is no `marked`, no `next` and no `txids` - and NO field naming a reason, a category or a provider, because
 * the node names none. `code` is the node's own single token, unchanged; `terminal` is the state the interface
 * draws its own neutral sentence from; `source` says WHICH reader saw it (provenance, not a reason).
 */
export interface SwapDeclinedWatch {
  readonly id: string;
  /** The escrow the decline was read on, or null when the record did not know it. */
  readonly escrow: string | null;
  readonly address: string | null;
  /** Never true here: a decline is not an arrival. */
  readonly seen: false;
  readonly declined: true;
  readonly terminal: "declined";
  readonly code: "compliance";
  /** `event` - the escrow's `Declined` log; `status` - the service's status; `record` - already written down. */
  readonly source: "event" | "status" | "record";
  readonly at: number;
  readonly waitedMs: number;
  /**
   * WHAT THE CHAIN READ DID. `checked: false` means the escrow's event could not be read at all (no reader, an
   * unreachable node) - which is NOT "the escrow declined nothing" - and `error` carries the refusal's own code.
   */
  readonly chain: { readonly checked: boolean; readonly error: string | null };
}

/** THE OUTCOME OF THE WATCH: the arrival is seen as a FACT, not assumed. */
export interface SwapWatch {
  readonly seen: true;
  readonly id: string;
  readonly address: string | null;
  /** The watch state at the service (awaiting_funding | funded | ready | ...). */
  readonly status: string | null;
  readonly expectedXmr: number | null;
  readonly receivedXmr: number;
  readonly confirmations: number;
  readonly txids: readonly string[];
  readonly at: number;
  /** What the ready mark returned, if it was passed. */
  readonly marked?: unknown;
  /** The next step, when the mark was not passed. */
  readonly next?: "mark-ready";
  /** THE CLIENT'S OWN EVIDENCE, when the arrival was checked on two nodes (issue #85). */
  readonly verified?: XmrArrivalFact;
  /** Who decided: "client" when the two-node check was used. */
  readonly source?: "client";
}

export interface StartRequest {
  readonly quote: Quote;
  /**
   * THE ORDER TERMS - the context the DLEQ proof and the firm quote's signature are bound to
   * (`orderContext`, fields: chainId, factory, locker, claimer, amount, readyBy, t1, salt). The core ALSO builds our
   * order side from them and takes the points and commitments for the lock terms, so without them the start refuses,
   * naming the field `order`, rather than substituting empty values.
   */
  readonly order: Readonly<Record<string, unknown>>;
  /**
   * THE COUNTERPARTY'S SIDE, if it already exists. In the sandbox the engine builds it as a stand-in (standIn); on a
   * live chain a stand-in would mean money against a non-existent side - there its absence is a refusal. The core's
   * own side does not depend on this: the core builds it.
   */
  readonly counterparty?: unknown;
  /**
   * THE SIGNED ORDER QUOTE - the provider's binding commitment (www/js/sdk/bridge.js, sdkOrderQuote). It is a
   * DIFFERENT thing from `quote`: `quote` is the indicative book quote used by the guards (freshness, deadlines),
   * while this one is the SIGNED SET the factory takes - the fee, its recipient, the registry address and the
   * provider. The lock step reads it as `request.orderQuote` (sdk/src/swaps.mjs → lockRequest.quote) and refuses
   * without it (`bad-input { step: "fund-order" }`): the factory takes a signed quote, not bare order terms.
   */
  readonly orderQuote?: QuoteLike;
  /** The swap direction for the record. Default - `buy`. */
  readonly side?: "buy" | "sell";
  /** Where to receive: for a purchase - the Monero address, for a sale - the EVM address. */
  readonly receiveTo: string;
  /** The recovery file's passphrase. In memory; the interface puts it on disk if it deems fit. */
  readonly passphrase?: string;
  /**
   * The EVM wallet for LOCKING THE FUNDS: an adapter with `send` and `receipt` (the same role as WalletAdapter).
   * It comes from outside and is NOT substituted by default: without it the lock step answers with a code
   * (`bad-input`), rather than going in blind. The recovery file has by now been confirmed by the person.
   */
  readonly wallet?: WalletAdapter;
  /**
   * Hand the OLD per-swap recovery file to the interface and wait for the person's decision.
   * `true` - the person confirmed the file is saved; `false` - the swap is not started.
   * Not used when `recoveryKey` is present: that path has one key, saved once.
   */
  onRecoveryFile?(file: RecoveryFile): Promise<boolean>;
  /**
   * THE ONE RECOVERY KEY (sdk#76). A BIP39 mnemonic, or a key object from `@ninsei-labs/sdk/recovery`.
   * When present, the swap's spend and view halves are derived from it instead of being generated, and no
   * per-swap recovery file is written. The key is kept through the SDK's storage adapter.
   */
  recoveryKey?: string | { readonly mnemonic: string };
  /** The swap number, when the caller already reserved one. Absent - the SDK reserves the next free number. */
  recoveryIndex?: number;
  /** The first block for the on-chain number check. Absent - the chain registry's escrow deployment block, and
   * zero only when the registry has no height. */
  fromBlock?: string | number;
  /** The Monero height the swap starts at. Absent - the SDK asks the configured nodes (`get_info`) and refuses
   * the start if none answers on the swap's network. */
  restoreHeight?: number;
  /** Monero nodes for that one measurement; absent - the configured nodes for the swap's network. */
  xmrNodes?: readonly (string | { readonly url: string })[];
  /** The fetch used for the height measurement (tests); absent - the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Hand the key backup to the interface, ONCE, when this call created the key. `true` - the person saved it;
   * `false` - the swap is not started. A key already in the store is not shown again.
   */
  onRecoveryKey?(file: RecoveryFile): Promise<boolean>;
}

export interface RecoveryFile {
  readonly name: string;
  /** The file's contents as a string: the interface decides how to hand it to the user. */
  readonly contents: string;
}

export interface SwapState {
  readonly id: string;
  readonly direction: "buy" | "sell";
  readonly pay: { readonly token: string; readonly amount: number };
  readonly get: { readonly xmr: number };
  /** The current step's code. The texts are the interface's. */
  readonly step: StepCode;
  /** All steps in the order of passage: what is done, what is running now, what failed. */
  readonly steps: readonly StepState[];
  /** The deadlines from the chain, seconds of the epoch. null - the contract has not reported them yet. */
  readonly deadlines: { readonly readyBy: number | null; readonly t1: number | null };
  readonly xmr: {
    readonly confirmations: number;
    readonly target: number;
    readonly txid: string | null;
    /** The amount promised by the quote and the one seen at the address: the interface shows both. */
    readonly amount: { readonly expected: number | null; readonly seen: number | null };
  };
  /**
   * THE COUNTERPARTY'S SETTLEMENT LEG. Named by the role, not the chain: for EVM `leg` is the escrow, for Tron and
   * Solana it will be their contract, for Bitcoin - a script. The field `vm` says what to expect in `leg`.
   */
  readonly counterparty: {
    readonly chain: string;
    readonly vm: string;
    /** The address of whatever secures the leg (the escrow on EVM), null - not created yet or not read. */
    readonly leg: string | null;
    readonly status: string | null;
    readonly txs: readonly string[];
  };
  /** What is currently allowed to be done. The interface draws the buttons by these flags. */
  readonly actions: { readonly markReady: boolean; readonly sweep: boolean; readonly refund: boolean };
  /** What in this state is simulated and what is real. */
  readonly simulated: { readonly evm: boolean; readonly xmr: boolean };
  /** The refusal reason, if any: a code and params, no text. */
  readonly error?: { readonly code: ErrorCode; readonly params?: Readonly<Record<string, unknown>> };
  /**
   * The terminal state, if the swap has ended. `declined` (issue #40) is the maker's refusal of a funded order:
   * the ETH, the fee included, is already back in the wallet, every flag in `actions` is OFF, and there is nothing
   * to recover. The interface owes the person a NEUTRAL sentence and no reason, category or provider - the node
   * names none, and the package forwards none.
   */
  readonly terminal: TerminalCode | null;
  /**
   * WHEN THE RECORD WAS CREATED (the record's own `createdAt`, an ISO string). null - an old record without
   * one: the list shows a dash rather than a date it does not have.
   */
  readonly createdAt: string | null;
  /** WHO GAVE THE PRICE. Either field may be absent: an old record or a swap without a provider. */
  readonly maker: { readonly id: string | null; readonly name: string | null };
  /**
   * The engine's phase code and its human name: the list shows the name, the CODE is what an interface branches on.
   * `xmr_reclaimed` is the maker taking the XMR back before the ready mark - a LIVE state, not a terminal: the
   * depositor's ETH is still in the escrow, `terminal` stays null and the swap ends later as `refunded_eth`. It is
   * told apart by that code from the other situation that opens a refund, the maker who never locked the XMR.
   */
  readonly phase: string | null;
  readonly phaseLabel: string | null;
  /** The swap has a settlement record: the list splits live from settled by THIS flag, not by the phase's text. */
  readonly settled: boolean;
  /** WHAT HAS ALREADY MOVED: the sum seen at the address and whether the record holds a lock or a secret. */
  readonly funds: { readonly receivedXmr: number; readonly escrowLocked: boolean };
}

export interface StepState {
  readonly code: StepCode;
  readonly done: boolean;
  readonly active: boolean;
  /** The step failed (e.g. the maker did not lock the XMR): the interface draws a failure, not "still running". */
  readonly failed?: boolean;
  readonly at?: number | null;
}

export type StepCode =
  | "awaiting_funding"
  | "funded"
  | "maker_locking"
  | "xmr_locked"
  | "ready"
  | "claimed"
  | "swept";

/**
 * THE ORDER'S TERMINAL STATE. `declined` is THE MAKER'S REFUSAL OF A FUNDED ORDER (issue #40): the whole balance,
 * the fee included, is already back in the depositor's wallet and NO half was revealed, so there is nothing to
 * recover and nothing left to do. It is deliberately NOT `refunded_eth`: that one is the depositor taking the ETH
 * back, and it DOES reveal the depositor's half. The words a person reads are the interface's, not the package's.
 *
 * `xmr_returned` WAS A MEMBER AND IS GONE: it named the maker taking the XMR back, which does NOT end a swap - the
 * depositor's ETH is still in the escrow - so it is a PHASE of a live swap (`SwapState.phase`, the code
 * `xmr_reclaimed`), never a terminal. A member with no writer reads as coverage.
 */
export type TerminalCode = "success" | "refunded_eth" | "closed" | "declined";

// --- The XMR withdrawal (the sweep page) --------------------------------------------------------

/**
 * The XMR withdrawal. Parsing and preparation do not move funds: these are reads. The withdrawal itself requires a
 * Monero wallet, which arrives as an adapter (like the EVM wallet), because syncing and signing live where there is
 * WASM - while the core stays DOM-free.
 */
export interface SweepApi {
  /**
   * BUILD THE WITHDRAWAL WALLET from the caller's monero-ts namespace. The page used to pass a `createWallet`
   * callback that translated the network name into the library's enum; that translation is the package's now, so a
   * caller passes the namespace, the network, the node and the keys.
   */
  wallet(request: SweepWalletRequest): SweepWallet;

   * COMPARE A DESTINATION WITH THE FILE'S PROMISE. `ok` is "usable address on the file's network", `matches` is
   * "the promised one" and is null when the file named nobody. Sending XMR elsewhere is a different payment, so the
   * comparison is not presentation.
   */
  destination(request: SweepDestinationRequest): Promise<SweepDestination>;
  /** What is known about the withdrawal from the recovery file: the address, the restore height, what we can dispose of. */
  plan(request: SweepPlanRequest): Promise<SweepPlan>;
  /**
   * Build the same withdrawal material from the 12 words and an order found by `findSwaps`, without a recovery file.
   * The checks are the same: the side, the person's points against the key, the joint address.
   */
  fromOrder(request: SweepFromOrderRequest): Promise<SweepFromOrderResult>;
  /**
   * RESTORE THE WALLET FROM A HEIGHT AND REPORT WHAT IT HOLDS. Sets the restore height a little below the one given,
   * rescans, syncs and reads the total and the spendable balance. Coins that exist but are locked get ONE more pass
   * with a spent-status re-check - the page used to decide that itself, and the rule belongs to wallet2, not to an
   * interface. A failed sync is not the verdict: the remainder is.
   */
  restore(request: SweepRestoreRequest): Promise<SweepRestoreResult>;
  /**
   * Assemble the spend and view keys from the revealed half - with the mandatory check `(s_a + s_b)*G` against the
   * order's public key. It did not match - a refusal, not "let us try to send".
   */
  keys(request: SweepPlanRequest): Promise<SweepKeys>;
  /**
   * SIGN WITHOUT SENDING. Holds everything up to and including signing (the free remainder -> sign with
   * `relay: false`), and HOLDS the signed transaction, returning the open session's token. An empty remainder stops
   * the withdrawal here with the code `insufficient-funds`. `relay` sends it - so the interface has a place to show
   * the person what will leave, BEFORE sending.
   */
  sign(request: SweepRunRequest): Promise<SweepSignResult>;
  /** Send what `sign` signed, close the wallet and return the transaction hashes. */
  relay(request: SweepRelayRequest): Promise<SweepRunResult>;
  /** Perform the withdrawal as a whole (`sign` + `relay`). */
  run(request: SweepRunRequest): Promise<SweepRunResult>;
}

/** What `restore` needs: the withdrawal adapter and the height named by the file. */
export interface SweepRestoreRequest {
  /** The withdrawal adapter: `sync`, `unlockedBalance`, `driver`. The wallet is built by the caller. */
  readonly wallet: {
    sync(): Promise<void>;
    unlockedBalance(): Promise<bigint | number | string>;
    driver(): unknown;
  };
  /** The height from the recovery file. The scan starts `scanBack` blocks below it. */
  readonly fromHeight: number;
  /** How far below the named height the scan starts. Default 10. */
  readonly scanBack?: number;
  /** Run the second pass when coins exist but none is spendable. Default true. */
  readonly rescanWhenLocked?: boolean;
  /**
   * THE BLOCK WINDOW AROUND THE LOCK. When present, the wallet is set at the node tip and only these blocks are
   * scanned. An empty window falls back to the full scan unless `fallback` is false. A window read that fails
   * (429, timeout, 5xx) is retried; if it still fails, the full scan runs and `fallbackWhy` names the read.
   * `txHashes` may be supplied by the caller; otherwise the SDK reads `get_block` from `nodeUrl`.
   */
  readonly window?: {
    readonly nodeUrl?: string;
    readonly txHashes?: readonly string[];
    readonly toHeight: number;
    readonly tipHeight: number;
    readonly fallback?: boolean;
  };
  /** The fetch used for `get_block`; absent - the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** What `restore` found. Amounts are atomic units as strings; heights are numbers when the driver can read them. */
export interface SweepRestoreResult {
  readonly total: string;
  readonly unlocked: string;
  /** The height the scan actually started from. */
  readonly scanHeight: number;
  readonly walletHeight: number | null;
  readonly nodeHeight: number | null;
  /** How many sync passes ran: 1, or 2 when the locked pass ran. */
  readonly passes: number;
  /** Whether the second pass RAN - not whether it helped. */
  readonly lockedPass: boolean;
  /** Present when a window was requested: whether it was used, and why it was skipped. */
  readonly window?: {
    readonly used: boolean;
    /** Whether the full scan ran because the window found nothing, could not scan, or could not be read. */
    readonly fallback: boolean;
    /** Why the fallback ran: `empty-window`, `window-read`, or a named skip. */
    readonly fallbackWhy?: string;
    /** The node's answer when the window read failed; absent when the window was read. */
    readonly error?: {
      readonly code: string;
      readonly surface: string;
      readonly status: number | null;
      readonly height: number | null;
      readonly why: string | null;
    };
    readonly skipped: string | null;
    readonly fromHeight: number;
    readonly toHeight: number;
    readonly blocks: number;
    readonly txs: number;
    readonly spent?: number | null;
    readonly keyImages?: number;
    readonly spentWhy?: string;
  } | null;
}

/** What `wallet` needs: the library namespace and the facts the wallet is built from. */
export interface SweepWalletRequest {
  /** The monero-ts namespace (the browser bundle's default export, or the module in Node). */
  readonly moneroTs: {
    readonly MoneroNetworkType?: Record<string, unknown>;
    readonly createWalletFull: (config: Record<string, unknown>) => Promise<unknown>;
  };
  /** `mainnet`, `stagenet` or `testnet` - what a node says. */
  readonly network: string;
  /** The node (in production - a proxy). */
  readonly serverUri: string;
  readonly password?: string;
  /** `{ seed }` or `{ privateSpendKey, privateViewKey, primaryAddress }`. */
  readonly keys?: Record<string, unknown>;
  readonly restoreHeight?: number;
  /** When set, the derived address must match, or the wallet refuses to open. */
  readonly expectedAddress?: string | null;
}

/** The wallet `sweep.wallet` returns: the SDK wallet adapter with the Monero surface on top. */
export interface SweepWallet {
  readonly vm: "monero";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  address(): string;
  chainId(): string;
  unlockedBalance(): Promise<bigint | number | string>;
  sync(): Promise<void>;
  /** The withdrawal role: no-op when this wallet is already open on the plan's address. */
  open(plan: SweepPlan): Promise<void>;
  sweepUnlocked(request: { readonly address: string; readonly relay: boolean }): Promise<unknown>;
  relay(signed: unknown): Promise<readonly string[]>;
  fee?(signed: unknown): Promise<string | null>;
  close(): Promise<void>;
  driver(): unknown;
}

export interface SweepFromOrderRequest {
  /** The 12 words of the recovery key. */
  readonly mnemonic: string;
  readonly chainId: number;
  /** The settlement network slug, e.g. `arbitrum-sepolia`. */
  readonly network: string;
  /** The Monero network the joint address belongs to, e.g. `stagenet`. */
  readonly moneroNetwork: string;
  /** One entry from `findSwaps`. */
  readonly order: {
    readonly escrow: string;
    readonly locker: string;
    readonly claimer: string;
    readonly edPointLocker: string;
    readonly edPointClaimer: string;
    readonly edViewPointLocker: string;
    readonly index: number;
    readonly side: "locker" | "claimer";
    readonly startHeight?: number | null;
    readonly blockTime?: number | null;
    readonly readyBy?: number;
    readonly t1?: number;
    readonly [field: string]: unknown;
  };
  /** Optional encryption boundary for the generated file; empty means an unencrypted file. */
  readonly passphrase?: string;
}

export interface SweepFromOrderResult {
  /** The payload `buildPayload` produced; the same fields a recovery file carries. */
  readonly payload: unknown;
  /** The same file `plan`/`keys` accept, so a caller can keep using the file-based API. */
  readonly contents: string;
  /** The joint Monero address built from the key and the order. */
  readonly address: string;
}

export interface SweepPlanRequest {
  readonly file: { readonly contents: string } | string;
  readonly passphrase: string;
}

export interface SweepPlan {
  readonly swapId: string | null;
  /** The joint Monero address the XMR arrived at. */
  readonly address: string;
  /** Whether there is enough data to dispose of the funds (whether our own spend-key half is present). */
  readonly spendable: boolean;
  /** The restore height: 0 - unknown. */
  readonly restoreHeight: number;
  /** The order of the withdrawal steps. The texts are the interface's. */
  readonly steps: readonly SweepStep[];
  /** What is missing for the withdrawal to go. Codes, no texts. */
  readonly missing: readonly SweepMissing[];
  /** The counterparty's revealed half, if the app returned it. This is a public value: it lies on the chain. */
  readonly half: string | null;
}

/**
 * The withdrawal keys. THEY ARE COMPUTED HERE AND CHECKED HERE TOO: the contract only makes sure the hash of the
 * revealed half matched the commitment, but cannot check the link "revealed half and the point in the address" -
 * there is no ed25519 in EVM. So we check it, and before any syncing.
 */
export interface SweepKeys {
  /** The spend key: 64 hexadecimal characters, byte order as in Monero (little-endian). */
  readonly privateSpendKey: string;
  readonly privateViewKey: string;
  /** The joint Monero address the keys were assembled for. */
  readonly address: string;
}

export type SweepStep = "unlock" | "sync" | "sweep" | "relay";
export type SweepMissing = "restore-height" | "spendable" | "revealed-half";

export interface SweepRunRequest extends SweepPlanRequest {
  /** Where to withdraw the XMR to. */
  readonly to: string;
  /** An already opened and synced adapter, the same one `restore` used. */
  readonly wallet?: MoneroWalletAdapter;
  /** Returns a Monero wallet: the core does not drag in WASM. */
  readonly connectWallet?: (plan: SweepPlan) => Promise<MoneroWalletAdapter>;
}

/**
 * THE ROLE OF A MONERO WALLET, not a library. The method names are the ones the sweep page already calls on monero-ts
 * (`sync`, `getUnlockedBalance`, `sweepUnlocked`, `relayTxs`, `close`), so the adapter can be assembled over it or over
 * anything else, and the core needs neither WASM nor a 3.6 MB worker.
 */
export interface MoneroWalletAdapter {
  /** Open the wallet by the withdrawal plan (address, restore). */
  open(plan: SweepPlan): Promise<void>;
  /** Sync with the node. */
  sync(): Promise<void>;
  /** The free remainder in atomic units. */
  unlockedBalance(): Promise<bigint | number | string>;
  /** Prepare the withdrawal: relay: false - sign only, no sending. */
  sweepUnlocked(request: { readonly address: string; readonly relay: boolean }): Promise<unknown>;
  /** Send what was signed. Returns the transaction identifiers. */
  relay(signed: unknown): Promise<readonly string[]>;
  /** Close the wallet. */
  close(): Promise<void>;
}

/** What signing returned: the open session's token and what lies under it. */
/** What `destination` needs: the file, its passphrase, and the address the person typed. */
export interface SweepDestinationRequest {
  readonly file: { readonly contents: string };
  readonly passphrase: string;
  /** The address the person typed. Empty is refused (`bad-input`, field `dest`). */
  readonly dest: string;
}

export interface SweepDestination {
  /** True when the address is usable on the file's network. */
  readonly ok: boolean;
  readonly dest: string;
  /** The recipient the file promised, or null when it named none. */
  readonly promised: string | null;
  /** True/false against the promise; null when the file named nobody. */
  readonly matches: boolean | null;
  /** The file's Monero network (stagenet, mainnet, testnet), or null. */
  readonly network: string | null;
  /** True when the checksum was actually checked; false when the library was not available. */
  readonly verified: boolean;
  /** The library's phrase when the shape or the network is wrong. */
  readonly reason: string | null;
}

export interface SweepSignResult {
  /** The open session's token for `relay`. It contains no keys - they are owned by the library wallet. */
  readonly token: string;
  /** The free remainder at the moment of signing, in atomic units (string). */
  readonly amount: string;
  /**
   * THE FEE OF THE SIGNED TRANSFER, in atomic units, or null when the wallet could not report one. A withdrawal
   * moves the whole remainder, so the fee comes out of it - `receive` is what the recipient gets.
   */
  readonly fee: string | null;
  /** The remainder minus the fee. Null when the fee is unknown, or when a reported fee claims more than the remainder. */
  readonly receive: string | null;
  /** Where the transfer was signed to. */
  readonly to: string;
  /** The address the XMR leaves from (the swap's joint address). */
  readonly swept: string;
}

/** Sending what was signed: the session token `sign` returned. */
export interface SweepRelayRequest {
  readonly token: string;
}

export interface SweepRunResult {
  readonly txids: readonly string[];
  readonly swept: string;
}

// --- Recovery// --- Recovery ------------------------------------------------------------------------------

/** Order checks. Both are BEFORE the signature: after it there is nothing to fix. */
export interface OrderApi {
  /** The order context string the proof and the quote signature are bound to. */
  context(terms: Readonly<Record<string, unknown>>): string;
  /** The counterparty's side: the proof in the context of THIS order and the proven ed25519 point matching. */
  verifyCounterparty(request: { readonly side: unknown; readonly order: Readonly<Record<string, unknown>>; readonly sealed?: unknown; readonly ownEncPriv?: unknown }): unknown;
  /** The joint Monero address from your own spend half and the other's point. */
  jointAddress(request: { readonly ownSpendHalf: string; readonly ownViewHalf: string; readonly otherSpendPoint: string; readonly otherViewPoint: string; readonly network?: string }): unknown;
  /**
   * The order state, READ FROM THE CHAIN (escrow status()): which of the four states the order is in. The state is
   * read by a call, not guessed from logs. It is read by the same chain-read seam as the actions (`evmCall`), so
   * the wallet that reads is the wallet that will sign.
   */
  status(escrow: string): Promise<OrderStatus>;
  /**
   * The order deadlines from the chain: t1 (the settlement boundary), readyBy (the ready-mark boundary) and the
   * terms hash the recovery file is bound to. The screen uses them to say whether the person is in the dead zone.
   */
  deadlines(escrow: string): Promise<OrderDeadlines>;
  /**
   * THE MAKER'S DECLINE, READ FROM THE ESCROW (issue #40): the `Declined` event THE ESCROW EMITTED. It is a
   * separate read because `status()` cannot answer it - the escrow has no `declined()` getter, and a decline sets
   * the same `refunded` flag an ordinary refund does. Read through the same seam as the state (`evmLogs`, or the
   * `logs` argument), so the wallet that reads is the wallet that signs.
   *
   * THE ANSWER CARRIES THE STATE AND NOTHING ELSE: no reason, no category, no provider. `checked: false` says the
   * chain was NOT read, which is not the same as "the escrow did not decline".
   */
  decline(escrow: string, deps?: OrderDeclineDeps): Promise<OrderDecline>;
}

/**
 * WHAT IS KNOWN ABOUT A DECLINE: exactly these fields, and the SHORTNESS IS THE POINT. Anything else would be a
 * reason, a category or a provider, and the node names none of those on purpose.
 */
export interface OrderDecline {
  readonly declined: boolean;
  /** The state the interface draws from (`declined`), or null when this is not a decline. */
  readonly terminal: "declined" | null;
  /** The node's own single token, UNCHANGED (`compliance`), or null. It is a token, not a reason. */
  readonly code: "compliance" | null;
  /** `event` - the escrow's log was read; `status` - the node's status was read; null - neither. */
  readonly source: "event" | "status" | null;
  /** When it was seen (epoch ms), or null. */
  readonly at: number | null;
  /** Whether the reading happened at all: `false` is "not measured", NOT "no decline". */
  readonly checked: boolean;
}

/** The seams of the decline read: the log reader and where the scan starts. */
export interface OrderDeclineDeps {
  readonly logs?: EvmLogReader;
  /** The first block to scan (the escrow's birth height when it is known). Default: the whole chain. */
  readonly fromBlock?: string | number;
}

/** THE ORDER STATE, READ FROM THE CHAIN (escrow status()): three flags and the remainder. */
export interface OrderStatus {
  readonly isFunded: boolean;
  readonly isClaimed: boolean;
  readonly isRefunded: boolean;
  readonly balance: bigint;
}

/** THE ORDER DEADLINES FROM THE CHAIN: the settlement boundary t1, the ready-mark boundary readyBy and termsHash. */
export interface OrderDeadlines {
  readonly t1: number;
  readonly readyBy: number;
  readonly termsHash: string;
}

/** Order actions on a ready escrow. The slot check against the chain stands in them BEFORE the signature. */
export interface ActionsApi {
  /** The "I saw the XMR at the joint address" mark. Without it claiming is forbidden by the contract. */
  markReady(request: ActionsRequest, wallet: WalletAdapter): Promise<unknown>;
  /** Claiming: it reveals your own half, so expectations are mandatory. */
  claim(request: ActionsRequest & { readonly halfClaimer: string }, wallet: WalletAdapter): Promise<unknown>;
  /** Refunding: it also reveals a half. */
  refund(request: ActionsRequest & { readonly halfLocker: string }, wallet: WalletAdapter): Promise<unknown>;
}

/** The shared part of an action request: the escrow address and the slot expectations checked against the chain before signing. */
export interface ActionsRequest {
  readonly escrow: string;
  readonly expect: Readonly<Record<string, unknown>>;
  /** The claimer whose half is revealed by `claim`; absent - `expect.claimer` is used. A claim without one is
   * refused: the package sends it only from the claimer's own wallet, never from a third-party sender. */
  readonly claimer?: string;
  readonly onStep?: (stage: string, detail?: string) => void;
}

export interface RecoveryApi {
  /** Parse the recovery file. Without the right passphrase - a refusal with a code, not an exception. */
  open(file: { readonly contents: string } | string, passphrase?: string): Promise<RecoveredWallet>;
  /**
   * WHICH HEIGHT TO SCAN FROM, AND WHERE IT CAME FROM. The service's height wins when it knows one (it watches
   * the address), the file's is the fallback, and no height is a named state - the person can type one.
   */
  restoreHeight(request: RestoreHeightRequest): Promise<RestoreHeightResult>;
}

export interface RestoreHeightRequest {
  readonly file: { readonly contents: string } | string;
  readonly passphrase: string;
}

export interface RestoreHeightResult {
  readonly address: string | null;
  /** 0 when no source knows a height. */
  readonly height: number;
  readonly source: "app" | "file" | "none";
  readonly fileHeight: number;
  readonly appHeight: number;
  /** Whether the service was asked at all (it is absent in a package without a service). */
  readonly appAsked: boolean;
  /** When `source` is "none": "unreachable" | "no-row" | "no-height". Null when a height was found. */
  readonly appProblem: string | null;
}

export interface RecoveredWallet {
  /** The wallet address that is restored from the file. */
  readonly address: string;
  /** Whether there is enough data to dispose of the funds, or this is observation only. */
  readonly spendable: boolean;
  /** The swap the file relates to, if the file names it. */
  readonly swapId: string | null;
}

// --- The sandbox ("sim" mode) -------------------------------------------------------------------

export interface SimApi {
  /** Failure scenarios the interface lays out failure screens for. */
  scenarios(): readonly string[];
  /** Enable a scenario by code. */
  apply(scenario: string): void;
  /** Accelerate the sandbox time: a multiplier to the real one. */
  speed(multiplier: number): void;
  /** Move the sandbox time forward, milliseconds. */
  advance(ms: number): void;
  /** What is chosen now: the scenario, the speed, the time shift. This is NOT the swap state. */
  debug(): { scenario: string | null; speed: number; advancedMs: number };
}

// --- Error codes --------------------------------------------------------------------------------

export type ErrorCode =
  | "not-implemented"
  | "bad-input"
  | "wallet-not-connected"
  | "wallet-rejected"
  | "wrong-chain"
  | "quote-unavailable"
  | "quote-refused"
  /**
   * An address on the interface's `denylist` refused BEFORE any request - the order's `locker` before `quotes.firm`,
   * or the actual sender before `swaps.start` (issue #16). Also names the node's own `denied-address` refusal as it
   * reaches the app: WITHOUT the node's `why` text and WITHOUT the address, so the interface shows its own message.
   */
  | "address-denied"
  | "quote-stale"
  /** The order-quote signature (EIP-712, v6) did not recover to any address. */
  | "quote-signature-invalid"
  /** The signature is valid but belongs to a key other than the one the quote names. */
  | "quote-key-mismatch"
  /** A field the signature must cover is absent: the quote is not verifiable at all. */
  | "quote-field-unbound"
  /** The quote's own `validUntil` has passed. */
  | "quote-expired"
  /** There was no chain read to ask the registry whose key it is: the claim stays unproven. */
  | "quote-registry-unchecked"
  /** The registry has no provider for this key: nobody owns it. */
  | "quote-key-unknown"
  /** The registry maps the key to a different provider than the quote names. */
  | "quote-provider-mismatch"
  /** The chain confirms the provider, but this interface's allow-list does not admit it (policy). */
  | "quote-provider-not-allowed"
  /** There was no way to read the factory or its code: the claim stays unproven (issue #103). */
  | "quote-factory-unchecked"
  /** The provider's registry record names no factory (zero). */
  | "quote-factory-unknown"
  /** The signed quote names a different factory than the registry record. */
  | "quote-factory-mismatch"
  /** The factory's runtime code is not a build this interface knows (`extcodehash`). */
  | "quote-factory-code-unknown"
  | "recovery-declined"
  | "recovery-failed"
  | "storage-unavailable"
  | "server-unavailable"
  /** The service answered and did not accept: the connection got through, the request did not (status and reason in params). */
  | "server-refused"
  /** The wait for the XMR to arrive expired: a separate code, because this is a state of the money, not a breakdown. */
  | "xmr-timeout"
  /**
   * XMR is on the address but BARRED by the transaction's `unlock_time` (issue #84): the funds cannot be spent
   * until a height or a date, which arrives in `params.until`. Distinct from `xmr-timeout` - money is there, and
   * the ready mark must not be signed under it.
   */
  | "xmr-locked"
  /** A synced witness node disagrees about the block or the transaction (issue #85). */
  | "xmr-nodes-disagree"
  /** Every witness node is unreachable, so nothing can be confirmed. */
  | "xmr-no-nodes"
  /** The amount that arrived is below the expected one. */
  | "xmr-underpaid"
  /** Less time remains before the ready deadline than the required confirmations take. */
  | "xmr-too-late"
  | "contract-reverted"
  | "insufficient-funds"
  /** The maker declines to pay the claim gas; the refusal is shown before the deal (issue #78). */
  | "gas-refused-by-maker"
  /** The claim gas was ordered but the recipient's balance did not grow. */
  | "gas-not-arrived"
  /** Gas arrived, but below what a claim costs. */
  | "gas-too-little"
  | "unknown";

/**
 * An SDK refusal or breakdown, raised with a code and params and NO human-facing text: the wording is the
 * interface's. `message` is deliberately equal to `code`, so it reads cleanly in logs.
 */
export declare class SdkError extends Error {
  readonly code: ErrorCode;
  readonly params: Readonly<Record<string, unknown>>;
  constructor(code: ErrorCode, params?: Readonly<Record<string, unknown>>);
  toJSON(): { readonly code: ErrorCode; readonly params: Readonly<Record<string, unknown>> };
}

/** The step codes the SDK works with (`state.step`): the same list as the `StepCode` type. */
export declare const SDK_VERSION: string;
export declare const STEP_CODES: readonly StepCode[];
/** The check codes a preflight verdict names (`checks[].code`): the same list as the `CheckCode` type. */
export declare const CHECK_CODES: readonly CheckCode[];
/** The error codes the SDK refuses with (`error.code`, `SdkError.code`): the same list as the `ErrorCode` type. */
export declare const ERROR_CODES: readonly ErrorCode[];

/** WHO CAN ACT on a refusal, and whether another attempt has a chance. */
export type ErrorSide = "caller" | "wallet" | "chain" | "provider" | "service" | "unknown";

export interface ErrorMeta {
  /** Whether another attempt has a chance. Not permission to retry a payment. */
  readonly retryable: boolean;
  readonly side: ErrorSide;
}

/** What each refusal means: the interface's advice, kept beside the vocabulary and checked by machine. */
export declare const ERROR_META: Readonly<Record<ErrorCode, ErrorMeta>>;

export declare const ERROR_SIDES: readonly ErrorSide[];

export declare function createNinsei(options: NinseiOptions): Ninsei;

// --- The maker's level set: the level walk the node and the client agree on ------------------------

/**
 * THE LEVEL WALK. A maker publishes a LEVEL SET - chunks of volume with their own prices - and both the node and
 * the client compute a firm price by WALKING it, before anything is signed. `levelsWalkSpec.mjs` is the ONE
 * implementation, taken from the package entry by the node rather than copied, and it is exported so a
 * consumer reaches the same price: the maker's set in, the walk's answer out.
 *
 * NUMBERS ARE INTEGERS, BigInt ONLY. XMR is in atomic units (1 XMR = 1e12); a price is in the asset's atomic units
 * per 1 WHOLE XMR. A refusal comes back as a NAMED `reason` token, never as an exception.
 */

/** One level: the NEXT chunk of volume, not a running total. Amounts are parsed with {@link toBigInt}. */
export interface Level {
  /** The chunk's volume in XMR atomic units. */
  readonly amount: bigint | number | string;
  /** The chunk's price in the asset's atomic units per 1 whole XMR. */
  readonly price: bigint | number | string;
}

/** The orientation of a set: `ask` - the best price is the LOWEST; `bid` - the HIGHEST. */
export type LevelOrientation = "ask" | "bid";

/** The side the taker is on: `buy` pays the asset, `sell` receives it. */
export type LevelRole = "buy" | "sell";

/**
 * A NAMED refusal over a level set (returned, not thrown). `index` is the guilty level in the ORIGINAL numbering.
 * `side-off` is not an error: an empty set means the side is disabled.
 */
export type LevelReason =
  | "levels-not-array"
  | "levels-bad-orientation"
  | "levels-bad-level"
  | "levels-not-integer"
  | "levels-not-positive"
  | "levels-not-best-first"
  | "levels-bad-role"
  | "levels-fee-beyond-budget"
  | "levels-exceed-side"
  | "levels-below-minimum"
  | "side-off";

/** The verdict on a level set: the side off, a valid set with its volume and full cost, or a named refusal. */
export type LevelVerdict =
  | { readonly ok: true; readonly enabled: false; readonly count: 0; readonly minAtomic: 0n; readonly totalAtomic: 0n }
  | { readonly ok: true; readonly enabled: true; readonly count: number; readonly minAtomic: bigint; readonly totalAtomic: bigint }
  | { readonly ok: false; readonly reason: LevelReason; readonly index?: number };

/** A walk answer: how much XMR and how much asset, or a named refusal. */
export type LevelWalkResult =
  | { readonly ok: true; readonly role: LevelRole; readonly xmrAtomic: bigint; readonly assetWei: bigint }
  | { readonly ok: false; readonly reason: LevelReason; readonly role: LevelRole; readonly index?: number };

/** XMR atomic units per 1 whole XMR. */
export declare const XMR_ATOMIC_PER_ONE: bigint;

/** Parse an integer into BigInt. Fractional / NaN / garbage -> null (the caller names the refusal, it does not guess). */
export declare function toBigInt(value: bigint | number | string): bigint | null;

/** Check a set: the side off, the set valid, or a NAMED reason. Equal prices are allowed; a worse price is not. */
export declare function checkLevels(levels: readonly Level[], orientation?: LevelOrientation): LevelVerdict;

/**
 * DIRECTION 1 - "I give/take ASSET": how much XMR the asset buys or sells. The fee is ADDED for `buy` and
 * SUBTRACTED for `sell`.
 */
export declare function xmrForAsset(request: { readonly levels: readonly Level[]; readonly role: LevelRole;
  readonly feeWei?: bigint | string; readonly assetWei: bigint | string; readonly orientation?: LevelOrientation }): LevelWalkResult;

/**
 * DIRECTION 2 - "I give/want XMR": how much asset the XMR costs. The fee is ADDED for `buy` and SUBTRACTED for
 * `sell`.
 */
export declare function assetForXmr(request: { readonly levels: readonly Level[]; readonly role: LevelRole;
  readonly feeWei?: bigint | string; readonly xmrAtomic: bigint | string; readonly orientation?: LevelOrientation }): LevelWalkResult;
