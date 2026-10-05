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

export interface NinseiOptions {
  /** The service's HTTP API base. Default is "/api" (the interface proxies it to our server). */
  apiBase?: string;
  /**
   * The settlement network. `chain` is an identifier from `sdk.config.chains` (e.g. "arbitrum-sepolia", "solana").
   * `vm` may be omitted: it is taken from the network registry, and a foreign one cannot be substituted - a network
   * without a driver answers with the code `not-implemented`, rather than being assumed EVM by default.
   */
  settlement: { chain: string; vm?: string };
  /** The Monero network. A value from `sdk.config.xmrNetworks`. */
  xmrNetwork: "mainnet" | "stagenet" | "testnet";
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
   * Renaming API paths by name: { swaps, swap, evmSwaps, orderQuote, revealedHalf, swept }.
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
   *   4) the recovery file and the interface's confirmation that the file is saved; 5) locking the funds (signature);
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
   */
  watch(request: SwapWatchRequest): Promise<SwapWatch>;
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
   * Hand the recovery file to the interface and wait for the person's decision.
   * `true` - the person confirmed the file is saved; `false` - the swap is not started.
   */
  onRecoveryFile(file: RecoveryFile): Promise<boolean>;
}

export interface RecoveryFile {
  readonly name: string;
  /** The file's contents as a string: the interface decides how to hand it to the user. */
  readonly contents: string;
}

export interface Swap {
  readonly id: string;
  /** The current state. Also arrives in the subscription. */
  state(): SwapState;
  /** Subscribe to changes. Returns an unsubscribe function. */
  on(event: "update", handler: (state: SwapState) => void): () => void;
  /** The "checked by you" mark: opens the claim to the maker. */
  markReady(): Promise<SwapState>;
  /** Withdraw the XMR to the recipient's address. */
  sweep(): Promise<SwapState>;
  /** Refund the ETH when the claim did not happen. */
  refund(): Promise<SwapState>;
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
  /** The terminal state, if the swap has ended. */
  readonly terminal: TerminalCode | null;
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

export type TerminalCode = "success" | "refunded_eth" | "xmr_returned" | "closed";

// --- The XMR withdrawal (the sweep page) --------------------------------------------------------

/**
 * The XMR withdrawal. Parsing and preparation do not move funds: these are reads. The withdrawal itself requires a
 * Monero wallet, which arrives as an adapter (like the EVM wallet), because syncing and signing live where there is
 * WASM - while the core stays DOM-free.
 */
export interface SweepApi {
  /** What is known about the withdrawal from the recovery file: the address, the restore height, what we can dispose of. */
  plan(request: SweepPlanRequest): Promise<SweepPlan>;
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
  /** Send what `sign` signed, close the wallet and tell the service about the withdrawal. */
  relay(request: SweepRelayRequest): Promise<SweepRunResult>;
  /**
   * TELL THE SERVICE ABOUT THE WITHDRAWAL. The mark does not affect the transfer - it is already on the network - so
   * it can be repeated: the interface calls this even after `relay` if the report did not go through then. A
   * connection refusal gives `reported: false`.
   */
  report(request: SweepReportRequest): Promise<SweepReportResult>;
  /** Perform the withdrawal as a whole (`sign` + `relay`). */
  run(request: SweepRunRequest): Promise<SweepRunResult>;
}

/** The withdrawal mark: the swap identifier and the transfer hash. */
export interface SweepReportRequest {
  readonly swapId: string;
  readonly txid: string;
}

export interface SweepReportResult {
  readonly reported: boolean;
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
  /** Returns a Monero wallet: the core does not drag in WASM. */
  readonly connectWallet: (plan: SweepPlan) => Promise<MoneroWalletAdapter>;
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
export interface SweepSignResult {
  /** The open session's token for `relay`. It contains no keys - they are owned by the library wallet. */
  readonly token: string;
  /** The free remainder at the moment of signing, in atomic units (string). */
  readonly amount: string;
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
  /**
   * Whether the service was told about the withdrawal. THE REPORT DOES NOT AFFECT THE TRANSFER - it is already on
   * the network - so a failed report does not make the withdrawal unsuccessful: it gives `reported: false`, so the
   * interface offers to report again.
   */
  readonly reported: boolean;
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
  readonly onStep?: (stage: string, detail?: string) => void;
}

export interface RecoveryApi {
  /** Parse the recovery file. Without the right passphrase - a refusal with a code, not an exception. */
  open(file: { readonly contents: string } | string, passphrase?: string): Promise<RecoveredWallet>;
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
export declare const STEP_CODES: readonly StepCode[];
/** The check codes a preflight verdict names (`checks[].code`): the same list as the `CheckCode` type. */
export declare const CHECK_CODES: readonly CheckCode[];
/** The error codes the SDK refuses with (`error.code`, `SdkError.code`): the same list as the `ErrorCode` type. */
export declare const ERROR_CODES: readonly ErrorCode[];

export declare function createNinsei(options: NinseiOptions): Ninsei;
