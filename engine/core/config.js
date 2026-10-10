// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/config.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Demo configuration. Every number a user sees lives here. Values come from the litepaper and are marked as demo data in the UI.
//
// Networks and tokens are one CHAINS structure: each network has its own native token, its own accepted tokens and
// its own decimals. Not decoration: USDT and USDC have DIFFERENT decimals on different networks (6 on
// Ethereum/Arbitrum/Base, 18 on BSC), and "ETH" does not exist on BSC - the native is BNB. So a token id in the
// swap state is composite: "<chainId>:<SYMBOL>", e.g. "42161:USDC". Addresses and decimals are verified on chain by a check.
//
// THREE MARKS ON RECORDS, none meaning "unsupported":
//   hidden (network) - alive and selected by id, but not in the network list;
//   hidden (token)   - alive and in the swap list, but not in the network showcase (header);
//   peg: "native"    - the price comes from native (WETH = ETH); no demo price of its own.
// Token hidden means: the showcase decides what to show next to the network name, while all accepted can be traded.
// So WETH is in the swap list but does not bloat the network caption in the header.
//
// THE DEX LEG (Uniswap v3). A network may have a uniswap block: QuoterV2 and UniswapV3Factory addresses, the wrapped
// native (WETH/WBNB) and fee tiers. The addresses are NOT invented: they come from the official Uniswap deployment
// list (github.com/Uniswap/contracts, deployments/json/<chainId>.json) and are confirmed by a chain CALL - code
// present, symbol()/decimals(), getPool's answer and a live quote. A network without this block means "addresses not
// confirmed by a call", not "no DEX": the interface must say so in words.

// DEPLOYMENT ENDPOINTS. THE ONE PLACE a deployment names node addresses; nothing else in the code hard-codes a host,
// and no production domain is invented. ONE source, read by BOTH environments by the SAME names:
//   * in the browser - window.NINSEI_DEPLOY = { moneroNode, evmRpc, sweepOrigin } set at deploy;
//   * in Node (checks, tools) - the environment: NINSEI_MONERO_NODE, NINSEI_EVM_RPC, NINSEI_SWEEP_ORIGIN.
// With nothing set, the LOCAL CONTOUR is the honest default (our own Monero node, our own anvil, our own sweep
// page): checks then run in Node with no live stand, and no production address lives in the code. A deployment
// overrides all three.
const BROWSER_DEPLOY = (typeof window !== "undefined" && window.NINSEI_DEPLOY) ? window.NINSEI_DEPLOY : null;
const NODE_ENV = (typeof process !== "undefined" && process.env) ? process.env : null;
const LOCAL_ENDPOINTS = Object.freeze({
  moneroNode: "http://127.0.0.1:38081",
  evmRpc: "http://127.0.0.1:8545",
  sweepOrigin: "http://localhost:5195",
});
export const ENDPOINTS = Object.freeze({
  moneroNode: (BROWSER_DEPLOY && BROWSER_DEPLOY.moneroNode) || (NODE_ENV && NODE_ENV.NINSEI_MONERO_NODE) || LOCAL_ENDPOINTS.moneroNode,
  evmRpc: (BROWSER_DEPLOY && BROWSER_DEPLOY.evmRpc) || (NODE_ENV && NODE_ENV.NINSEI_EVM_RPC) || LOCAL_ENDPOINTS.evmRpc,
  sweepOrigin: (BROWSER_DEPLOY && BROWSER_DEPLOY.sweepOrigin) || (NODE_ENV && NODE_ENV.NINSEI_SWEEP_ORIGIN) || LOCAL_ENDPOINTS.sweepOrigin,
});

// THE PAGE'S OWN ADDRESS comes from the environment, not from a constant: WalletConnect compares the metadata url
// with the page's actual origin, so a hard-coded host breaks the session on any other host.
const PAGE_ORIGIN = typeof location !== "undefined" ? location.origin : "";

// THE EIP-712 SIGNING DOMAIN (name/version) for the depositor signature. It is NOT a brand literal in the signer: it
// belongs to the registry contract (it returns DOMAIN_SEPARATOR()), so it is taken from the config here. The defaults
// reproduce today's result byte for byte.
export const SIGNING_DOMAIN = Object.freeze({ name: "NinseiEscrowFactory", version: "1" });

export const APP = {
  name: "NinseiSwap",
  version: "0.1.0",
  demo: true,
  storageKey: "ninsei.demo.v1",
};

// ---------------------------------------------------------------------------
// Networks. rpcUrl is needed ONLY as a wallet_addEthereumChain parameter (the user's wallet uses it, not our page),
// so CSP and our server have nothing to do with these addresses. Balances are read through the wallet provider.
// ---------------------------------------------------------------------------

// The escrow field answers one question: can one SETTLE on this network.
//
// A swap ends where the contract lies, so a network without a contract is listed but not selectable (grey, "coming
// soon"). While no contract is deployed anywhere the demo runs in simulation: mode "simulated" - escrow funding is
// faked (simulateEscrowFunding), no real money moves, and the UI says so.
//
//   escrow: { address: null, mode: "simulated" }  - demo mode, selectable
//   escrow: { address: "0x…", mode: "live" }       - deployed; the network is tied to it
//   escrow: null                                   - no contract and none planned: "coming soon"
//
// NETWORKS WHERE THE DEX LEG IS ON AND MEASURED (DEX_CHAINS below). It is in DATA, not decoration: the whole registry
// cannot be walked, as most networks are coming soon. The next network is added with ONE line in DEX_CHAINS and a
// uniswap block of its own - and lands both in the interface and in the measurement.
//
// WHY THESE: arbitrum-sepolia (421614) - the demo network with our escrow and all runs;
// arbitrum (42161) and mainnet (1) - live networks where the route is alive on real liquidity.
export const DEX_CHAINS = ["arbitrum-sepolia", "arbitrum", "mainnet"];

// THE SWAP SET IS FIXED HERE - A DECISION, NOT A MEASUREMENT. Read as is: the code adds and drops nothing, the
// measurement does not filter it. A token without a pool STILL stays in the list, and the absence is reported -
// liquidity is a person's call, not a tool's.
// A NETWORK MAY NOT OFFER PART OF THE SET, which is ANOTHER state than "no route": the asset is then in neither
// the network's tokens nor its DEX_ROUTES, and it must NOT have a why-stub. Example - USDS and PyUSD on Arbitrum
// One (the owner's decision). Contradictions go red: a route for an asset the network does not offer, and a token
// in the network list that is not in the swap set.
export const DEX_ASSETS = ["USDT", "USDC", "DAI", "USDS", "USDe", "PyUSD"];

// REFERENCE FOR THE TOOL, NOT A SWAP MECHANISM: which stables may serve as intermediaries. When a detour is needed
// it is declared as a route in DEX_ROUTES below - by a person, not by brute force. The DEX leg is one-way and
// brings the input to the NETWORK'S NATIVE token (the escrow is funded with it); routes ending in a stable do not
// exist by design and cannot be declared (the tool would notice).
export const DEX_HUBS = ["USDC", "USDT", "DAI"];

// THE PRICE-CHECK THRESHOLDS - NUMBERS IN DATA, NOT IN LOGIC (www/js/evm/dex.js: priceGateVerdict). The check
// answers ONE question: is the route's price like the market, or is the deal wrong. Not liquidity scoring (still a
// person's call) but a guard like amount coverage: a wrong price means the deal will not settle and must not start.
//   maxDeviationPct - how far the implied native price FROM THE LAST STEP'S QUOTE may diverge from the native price
//                     reference (Chainlink, evm/prices.js) before "not market". 2% is the boundary between ordinary
//                     spread and a wrong price;
//   stableBandPct   - the "stable to stable" band (USDe→USDC, USDS→USDC, PyUSD→USDC): the price must be near 1:1,
//                     checked BY THE QUOTE ITSELF with no oracle. 1% covers the step fee (0.3%) and ordinary spread;
//   stables         - which assets count as stables for this band: THE SAME as in the swap set (DEX_ASSETS), all
//                     stables by definition, so no second list.
export const DEX_PRICE_GATE = {
  maxDeviationPct: 2,
  stableBandPct: 1,
  stables: DEX_ASSETS,
};

// PRE-SIGNING GUARD THRESHOLDS - ALSO NUMBERS IN DATA, NOT IN LOGIC (www/js/core/preSignGuards.js).
// Only ORDER DEADLINES live here; the price and coverage thresholds are above, at the DEX leg.
//   minReadyLeadSec   - how far the readiness-mark deadline must be ahead of "now" before signing. The threshold is
//                       the SOFT sell window (600 s, www/js/core/sellWindow.js): how long the provider promises to
//                       hold the on-screen price. It used to be 1200 - the WHOLE confirmation window - which blocked
//                       the request ITSELF, because the node issues a reverse ticket with exactly the contract window
//                       of 1200 s while the page checks deadlines a second or two later. The threshold must be
//                       strictly below the contract window.
//   minClaimWindowSec - how far the settlement deadline (t1) must stand from the readiness deadline: the window in
//                       which the claimer claims the ETH cannot be "a few seconds". 10 minutes against the usual hour.
export const SIGNING_GUARDS = {
  minReadyLeadSec: 600,
  minClaimWindowSec: 600,
  // maxDeadlineSec - the deadline CEILING: `t1` is no farther than this from "now". Otherwise a deadline can be set
  // a year ahead and the deposited ETH cannot be returned before readyBy or after t1 - a whole year. 72 hours
  // (3 days) is the owner's decision; the usual windows (4 h + 1 h on a buy, 2 h + 1 h on a sell) fit with margin.
  maxDeadlineSec: 259200,
  // readyLeadWarnSec - how many seconds before the readiness boundary a side must warn the person. In DIRECT mode
  // an on-screen warning, in REVERSE the same threshold at the node's watchtower (its own RFQ_READY_LEAD_WARN_SEC
  // with the same default, since the node runs separately and reads no other config). The value is read here, not
  // repeated as a number in the code: two numbers in two places would diverge silently and the alarm would be late.
  readyLeadWarnSec: 600,
};

// THE DECLARED DEX-LEG ROUTES - THE OWNER'S DECISION, NOT A RUNTIME SEARCH. Owner's rule: "usually choose via USDT
// or USDC if there is no direct one". There is NO fee-tier search, no "direct / via a hub" comparison, no winner
// picked by output: the page quotes ONLY the path declared here and either shows its numbers or honestly says there
// is no quote (and why). A person chooses the route.
// Record: steps in order, each { to, fee, pool, verified }. The first token of the path is the asset.
//   to       - the token a step leads to (a symbol from this network's tokens or its wrapped native);
//   fee      - THIS step's fee tier;
//   pool     - this step's pool address (read from factory.getPool, confirmed by measurement);
//   verified - the date and block at which the step was confirmed by a live quote.
// Empty steps + why - the route is NOT declared: an honest "no route", and signing is blocked on it.
// The numbers in comments come from the 2026-09-23 measurement: output for 100 units, impact per the 100->1000 profile, gas.
export const DEX_ROUTES = {
  "arbitrum-sepolia": {
    // The demo network: one pool with sensible liquidity is declared. THE PRICE IN IT IS MEASURABLY WRONG
    // (+1738% against the Chainlink reference) - left as an observation, not a verdict: the owner decides.
    USDC: {
      steps: [{ to: "WETH", fee: 3000, pool: "0x66eeab70ac52459dd74c6ad50d578ef76a441bbf", verified: { at: "2026-09-23", block: 311900041 } }],
    },
  },
  arbitrum: {
    // Declared by the owner on 2026-09-23 from the same day's measurement (block 508125577).
    USDT: {
      steps: [{ to: "WETH", fee: 500, pool: "0x641c00a822e8b671738d32a431a4fb6074e5c79d", verified: { at: "2026-09-23", block: 508125577 } }], // 0.036707 WETH / 100 USDT, impact -0.004%, gas 93202
    },
    USDC: {
      steps: [{ to: "WETH", fee: 100, pool: "0x6f38e884725a116c9c7fbf208e79fe8828a2595f", verified: { at: "2026-09-23", block: 508125577 } }], // 0.036719 WETH / 100 USDC, impact -0.023%, gas 93921
    },
    DAI: {
      steps: [{ to: "WETH", fee: 3000, pool: "0xa961f0473da4864c5ed28e00fcc53a3aab056c1b", verified: { at: "2026-09-23", block: 508125577 } }], // 0.036601 WETH / 100 DAI, impact -0.373%, gas 95653
    },
    // USDe has no pool against WETH at all - a detour via USDC is declared (measurement: 99.931621 USDC / 100 USDe).
    USDe: {
      steps: [
        { to: "USDC", fee: 100, pool: "0x3223859e24d5413947761cb79d3094f21be69bfa", verified: { at: "2026-09-23", block: 508125577 } },
        { to: "WETH", fee: 100, pool: "0x6f38e884725a116c9c7fbf208e79fe8828a2595f", verified: { at: "2026-09-23", block: 508125577 } },
      ],
    },
    // USDS AND PyUSD ARE NOT DECLARED HERE AT ALL (the owner's decision): on Arbitrum One they are no longer
    // OFFERED - not "no route" but "this asset is not on this network", so no records and no why-stub. They are
    // absent from this network's tokens too; on Ethereum both stay and work.
    // WETH is not a swap but an unwrap at WETH9: 1:1. Gas depends on holder and amount: the 2026-09-23 measurement
    // gave 52793 (holder 0x278d…f8d2, blocks 508121467..508121667) and 52598 on another holder, so no gas figure is
    // shown in the interface (see evm/dex.js: unwrapLeg).
    WETH: { steps: [], unwrap: true },
  },
  mainnet: {
    // Declared by the owner on 2026-09-23 from the same day's measurement (block 26040283).
    USDT: {
      steps: [{ to: "WETH", fee: 500, pool: "0x11b815efb8f581194ae79006d24e0d814b7697f6", verified: { at: "2026-09-23", block: 26040283 } }], // 0.036714 WETH / 100 USDT, impact -0.002%, gas 81801
    },
    USDC: {
      steps: [{ to: "WETH", fee: 100, pool: "0xe0554a476a092703abdb3ef35c80e0d76d32939f", verified: { at: "2026-09-23", block: 26040283 } }], // 0.036717 WETH / 100 USDC, impact -0.002%, gas 87061
    },
    DAI: {
      steps: [{ to: "WETH", fee: 500, pool: "0x60594a405d53811d3bc4766596efd80fd545a270", verified: { at: "2026-09-23", block: 26040283 } }], // 0.036707 WETH / 100 DAI, impact -0.006%, gas 79908
    },
    // USDe: no direct pool against WETH - a detour via USDC is declared (measurement: 99.975800 USDC / 100 USDe).
    USDe: {
      steps: [
        { to: "USDC", fee: 100, pool: "0xe6d7ebb9f1a9519dc06d557e03c522d53520e76a", verified: { at: "2026-09-23", block: 26040283 } },
        { to: "WETH", fee: 100, pool: "0xe0554a476a092703abdb3ef35c80e0d76d32939f", verified: { at: "2026-09-23", block: 26040283 } },
      ],
    },
    // USDS: a direct pool against WETH exists but is plainly unusable (0.000867 WETH for 100 USDS), so a detour
    // via USDC is declared (measurement: 99.640880 USDC / 100 USDS at the 0.3% tier).
    USDS: {
      steps: [
        { to: "USDC", fee: 3000, pool: "0xa66a2770bc0e0c65b63b5a3bb4560e90f95d6146", verified: { at: "2026-09-23", block: 26040283 } },
        { to: "WETH", fee: 100, pool: "0xe0554a476a092703abdb3ef35c80e0d76d32939f", verified: { at: "2026-09-23", block: 26040283 } },
      ],
    },
    // PyUSD: a direct pool against WETH is plainly unusable - a detour via USDC is declared (99.989571 USDC / 100 PyUSD).
    PyUSD: {
      steps: [
        { to: "USDC", fee: 100, pool: "0x13394005c1012e708fce1eb974f1130fdc73a5ce", verified: { at: "2026-09-23", block: 26040283 } },
        { to: "WETH", fee: 100, pool: "0xe0554a476a092703abdb3ef35c80e0d76d32939f", verified: { at: "2026-09-23", block: 26040283 } },
      ],
    },
    // WETH is not a swap but an unwrap at WETH9: 1:1. Gas depends on the holder: the 2026-09-23 measurement gave
    // 36335 and 36277 on two holders, so no number is shown in the interface.
    WETH: { steps: [], unwrap: true },
  },
};

// ASYNCHRONOUS ROUTE PROVIDERS - A NETWORK IS SERVED OR IT IS NOT, AND THAT IS DATA, NOT A GUESS.
//
// The declared routes above are ROUTER swaps: the swap runs INSIDE the person's own transaction (shape "sync").
// A person coming from USDC who holds NO native coin of their own cannot pay for that transaction at all - there
// is nothing to pay the gas with. So a second kind of route is declared here: an INTENT AUCTION, where the person
// SIGNS an intent and the settlement arrives LATER as a separate transaction sent by someone else (shape "async";
// CoWSwap is the first such provider, see the step-1 package layer sdk/src/legs/cow.mjs). The wallet's own
// balance then decides the path (www/js/evm/permit.js: usdcWithoutEthVerdict) and the asynchronous one is taken
// when the wallet cannot cover the gas - the swap settles first, and the escrow deposit (and its gas) comes after.
// STEP 4 ADDS A SECOND ONE (kyberswap, below): an intent auction is a KIND, not a single venue, so the table is keyed
// by provider id and each provider declares its own networks and book. CoW is unchanged.
// STEP 5 ADDS WHAT A PROVIDER SETTLES (`settles`): the escrow is funded with NATIVE coin, so the choice must only
// pick a provider able to carry the route ALL THE WAY there. CoW settles native; KyberSwap settles the WRAPPED
// native, so it is a LIQUIDITY leg and is usable only inside a composition (see www/js/evm/asyncRoute.js:
// asyncRouteChoice) - never as the sole provider for a native need.
//
// KEYED BY EVM chainId. A network ABSENT here is NOT served asynchronously: the path choice must refuse BY NAME
// (www/js/evm/asyncRoute.js: asyncRouteVerdict, reason "no-async-provider") rather than pretend. The order book
// base URLs are the provider's own public endpoints (the CoWSwap order book OpenAPI `servers` list), the same
// ones pinned in sdk/src/legs/cow.mjs; tools/check-buy-async-route.mjs cross-checks the two tables so the engine
// and the package cannot drift apart silently.
export const ASYNC_ROUTE_PROVIDERS = {
  cowswap: {
    venue: "CoWSwap",
    shape: "async",
    // WHAT IT SETTLES: native coin. A CoW order can buy native directly (buyToken = the BUY_ETH_ADDRESS marker,
    // sdk/src/legs/cow-spec.mjs), so this provider can carry the route ALL THE WAY to the escrow, which is funded
    // with native coin. tools/check-buy-async-route.mjs cross-checks this against cowProvider.settles.
    settles: "native",
    networks: {
      1: { slug: "mainnet", orderbook: "https://api.cow.fi/mainnet" },
      100: { slug: "xdai", orderbook: "https://api.cow.fi/xdai" },
      42161: { slug: "arbitrum_one", orderbook: "https://api.cow.fi/arbitrum_one" },
      8453: { slug: "base", orderbook: "https://api.cow.fi/base" },
      56: { slug: "bnb", orderbook: "https://api.cow.fi/bnb" },
      11155111: { slug: "sepolia", orderbook: "https://api.cow.fi/sepolia" },
    },
  },
  // KYBERSWAP LIMIT ORDER - THE SECOND SUCH PROVIDER (step 4). Same shape as CoW (an intent auction: the person signs
  // an off-chain order, a taker settles it on chain later), so it is declared HERE the same way. ONE order book base
  // URL serves every chain (docs.kyberswap.com "Base URL: https://limit-order.kyberswap.com"), and the settlement
  // contract is the same DSLOProtocol 0xcab2... on each chain (docs.kyberswap.com, "Contracts & Addresses"); there is
  // no per-chain slug, so the record carries `contract` instead of `slug`. The networks are the chains KyberSwap
  // Limit Order serves (Ethereum, Optimism, BSC, Polygon, Fantom, zkSync, Mantle, Base, Arbitrum, Avalanche, Linea,
  // Scroll, Blast). SCOPE: this provider settles WETH, not native coin - it is the LIQUIDITY leg, see the scope note
  // in sdk/src/legs/kyber.mjs; reaching native is a second order on a native-capable provider (CoW above). The guard
  // tools/check-buy-async-route.mjs cross-checks this table against sdk/src/legs/kyber.mjs so the two cannot drift.
  kyberswap: {
    venue: "KyberSwap Limit Order",
    shape: "async",
    // WHAT IT SETTLES: the WRAPPED native (WETH), not native coin - its orders trade ERC20 against ERC20 and its
    // API refuses native as an order asset (error 4004). So it is a LIQUIDITY leg: it can never be the sole provider
    // for a native need; reaching native is a SECOND order on a native-capable provider (CoW above). See the scope
    // note in sdk/src/legs/kyber.mjs.
    settles: "wrapped",
    networks: {
      1: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      10: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      56: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      137: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      250: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      324: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      5000: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      8453: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      42161: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      43114: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      59144: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      534352: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
      81457: { orderbook: "https://limit-order.kyberswap.com", contract: "0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C" },
    },
  },
};

export const CHAINS = [
  {
    id: "arbitrum-sepolia",
    name: "Arbitrum Sepolia",
    vm: "evm",
    chainId: 421614,
    caip2: "eip155:421614",
    testnet: true,
    native: { symbol: "ETH", decimals: 18, usd: 3212.4 },
    // Our own proxy rather than a public node directly: the escrow address (predict) comes along this path, and a
    // substituted or lying intermediary would mean locking the ETH against the wrong address. Details, including a
    // network check and CORS, are in the deploy notes.
    rpcUrl: ENDPOINTS.evmRpc,
    // The Chainlink feed for the native price. The addresses are confirmed by a chain CALL (description() matched
    // the pair, the value is fresh and within a sensible range). With no feed there is no price: the interface must
    // say "demo", not show yesterday's constant.
    priceFeed: { address: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165", pair: "ETH / USD", decimals: 8, min: 100, max: 20000 },
    explorerTx: "https://sepolia.arbiscan.io/tx/",
    explorerAddr: "https://sepolia.arbiscan.io/address/",
    explorerName: "arbiscan (sepolia)",
    gasUsd: 0.01,
    routeType: "atomic",
    // THE DEMO'S MAIN NETWORK: the escrow went here, and the FEE ROUTER IS DEPLOYED here - also the factory (it
    // spawns escrows, keeps the rate, holds the fee cashier). The address is a FACT, not an intention:
    // 0xaEB1c0455C76551dcEb2E6B1245B65F0458b0aE8 (height 314323871, transaction
    // 0x7a88c0249867b76b11c6cb678e6092fdc19404b51540a64c5fd03f5a32f74826, code 8223 bytes, keccak256
    // 0x90f26f641b48a2a630463195d4429b0818d29187563e09711a40811fcf08a0ba); it added EARLY REFUND in the dead
    // zone - with no mark, refund is open right after readyBy and it publishes the depositor's half. The code
    // matches the current repo build byte for byte.
    // `npm run check:deployed -- --address=0xaEB1c0455C76551dcEb2E6B1245B65F0458b0aE8`).
    // PREVIOUS (ceiling 3%, no early refund): 0xEa619bDC78989627093B7830990367B2ECE52CE5 (height 314309038,
    // code 8143 bytes). PREVIOUS live (router with a 10% ceiling): 0x9f856cd9c14fd9493961473b804039b09a4012ef
    // (height 313597131, code 8723 bytes). PREVIOUS before it (factory without a fee):
    // 0xcb54af9ec11344d448c7900ccb08530a23783259 (height 312222006, code 6035 bytes), and earlier ones still.
    // mode: "live" - the form sends REAL transactions: order creation TOGETHER WITH THE MONEY in one transaction
    // (createOrderAndFund; the escrow has no separate funding function - an order is born funded, see FACTORY_METHODS
    // in www/js/evm/factory.js and ESCROW_METHODS in escrow.js). The old lock(sealedHalf) and hashlock are gone: the
    // half is not sent but revealed by presentation. Switching back to "simulated" is one edit, to show a demo with
    // no money movement. cashier: the INTERFACE's fee cashier, named in quotes. The contracts on chain are still the
    // previous ones, so there is no cashier there: the field is filled in the same pass as the factory address.
    escrow: { address: "0xaEB1c0455C76551dcEb2E6B1245B65F0458b0aE8", mode: "live", cashier: null },
    tokens: [
      // Test USDC (Circle): decimals 6 and symbol "USDC" verified on chain by the same node.
      { symbol: "USDC", address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6, usd: 1, cls: "ar-token-usdc" },
      // WETH IS THE SAME ETH, JUST WRAPPED, so no pool is searched for it: WETH -> ETH is a withdraw at WETH9, one
      // to one and without a swap (see the DEX leg below). hidden: true means "do not show in the network showcase
      // (header)", NOT "unsupported": it is in the swap token list (that uses tokensOf; the header filters by hidden).
      // The address is DETERMINED BY MEASUREMENT, not from memory: token0/token1 of the USDC/WETH pool gave it, and
      // symbol()/decimals()/name() answered "WETH"/18/"Wrapped Ether" (checked 2026-09-23).
      // peg: "native" - WETH has no demo price of its own: its dollar price is the ETH price.
      { symbol: "WETH", address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", decimals: 18, cls: "ar-token-eth", peg: "native", hidden: true },
    ],
    // THIS NETWORK'S DEX LEG (Uniswap v3, read only: eth_call to QuoterV2). THE FACTORY IS NOT IN THE OFFICIAL LIST
    // FOR ARBITRUM SEPOLIA, so the address was OBTAINED BY MEASUREMENT: factory() was read from the pools named in
    // the same-chain ramp notes, and getPool(USDC, WETH, fee) was then checked to return the same addresses
    // (2026-09-23). IMPORTANT ABOUT THIS NETWORK: pools exist but liquidity is unusable. The 0.01% tier serves NO
    // size ("pool cannot serve this size"), 0.05% gives ZERO output at any size, and 0.3% answers at a price that
    // diverges from the Chainlink reference.
    // ONE NUMBER, NOT THREE. It used to read "30x" and "18x" here while the report said 94.54%: measurements AT
    // DIFFERENT SIZES ON DIFFERENT DAYS, each meaningless without a named size and method. Measurement 2026-09-24,
    // block 312238363, head size 100 USDC: the quote gave 0.116508 WETH, i.e. an implied native price of $858.31
    // against $2650.42 by the Chainlink feed - a 67.6% divergence against a 2% threshold, the pool 3.09x cheaper
    // than the reference. The method is THE SAME CODE AS IN THE INTERFACE (www/js/evm/dex.js: priceGateVerdict,
    // reference from www/js/evm/prices.js) and is rerunnable in one command.
    //   (rerun the DEX quote check against arbitrum-sepolia)
    // THE NUMBER DEPENDS ON SIZE (same block, same scale): 1 USDC = 77.5%, 10 USDC = 76.6%, 100 USDC = 67.6%,
    // 1000 USDC = -16.0%. So ONE number stands here WITH A NAMED SIZE. The tool also prints a "how many times
    // cheaper" observation (+208.6% for 100 USDC, i.e. the same 3.09x) - a RECOUNT of the same figure, not a second measurement.
    uniswap: {
      factory: "0x248ab79bbb9bc29bb72f7cd42f17e054fc40188e",
      quoter: "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B",
      // EXECUTION (unlike the quote above): the addresses are MEASURED, not taken from a deployment agreement, and
      // the measurement is rechecked by a run.
      //   router - SwapRouter02. Three INDEPENDENT signs of origin, all from the chain: (1) code at the address,
      //     24497 bytes; (2) its factory() EQUALS the Uniswap factory above; (3) its WETH9() EQUALS wrapped below.
      //     Plus the source is verified at the explorer: Arbiscan API V2 (chainid 421614) returned an ABI of 41
      //     entries, contract name SwapRouter02, compiler v0.7.6+commit.7338295f. An address returning EXACTLY these
      //     factory() and WETH9() cannot be guessed - it is the same contract.
      //     IMPORTANT: permit2() on THIS router REVERTS (checked by a run): it does not consume Permit2, and the
      //     allowance is given to it by an ordinary approve.
      //   permit2 - the canonical Uniswap Permit2: code 9152 bytes, its DOMAIN_SEPARATOR() matched one computed FROM
      //     SCRATCH for chainId 421614 and this address (domain name "Permit2"), and the source is verified at the
      //     explorer. Needed by the order's FUNDING path, NOT by this router.
      // UniversalRouter (0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2) is NOT included, on purpose: its origin on
      // this network is NOT confirmed (getabi and getsourcecode at the explorer answer NOTOK, i.e. the source is
      // unverified), and "the same address as in the report" is not proof. When needed - proof first, then the record.
      router: "0x101F443B4d1b059569D643917553c771E1b9663E",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      // The wrapped native token: the address matches WETH in tokens above - that is checked (check-front).
      wrapped: { symbol: "WETH", name: "Wrapped Ether", address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", decimals: 18 },
      feeTiers: [100, 500, 3000, 10000],
    },
    // THIS NETWORK'S PRICE IS WRONG BY NATURE, AND THAT IS A NETWORK MARK (like hidden/unsupported), not a
    // weakening of the check: the same measurement as in the uniswap block above (block 312238363, 100 USDC: implied
    // native price $858.31 against a $2650.42 reference - a 67.6% divergence against a 2% threshold). On a live
    // network such a price STOPS signing; here it is only marked in words: a testnet tests the FLOW, not the market,
    // else demo runs would stall on a price we did not choose. Live networks have no mark - there the price check
    // blocks, and that is the default (DEX_PRICE_GATE). The local-anvil sandbox is not covered at all: it has no
    // uniswap block and no tokens, so there is no DEX leg there - nothing to mark.
    dexPriceGate: "tolerated",
  },
  {
    // A LOCAL NETWORK FOR INTERNAL TESTS. This is anvil on this machine: a real chain with real transactions, but a
    // sandbox. In the demo it is not for showing - it is for runs needing full control. Its OWN chainId (31337), not
    // one of a public network: with a matching id the front end could not uniquely pick the sandbox - it found the
    // FIRST network with that id and fell back to the public one. 31337 is the usual local-chain id, matching no real network.
    id: "local-anvil",
    name: "Local (anvil)",
    // HIDDEN FROM THE NETWORK LIST BUT NOT OFF. hidden concerns only the rows the list draws
    // (see shownChains in www/js/ui/chainPicker.js): the sandbox is not for showing, but internal runs need it. The
    // mark does NOT mean "unsupported" (that is unsupported on Monad/Hyperliquid - those stay listed, grey, marked
    // "coming soon" like the other non-live networks): escrowState, isSelectable and settlementChain read the
    // registry itself and do not know about hidden, so the sandbox stays a live network with a live escrow, selected
    // by the id "local-anvil".
    hidden: true,
    vm: "evm",
    chainId: 31337,
    caip2: "eip155:31337",
    testnet: true,
    native: { symbol: "ETH", decimals: 18, usd: 3212.4 },
    rpcUrl: "http://127.0.0.1:8545",
    // There is no Chainlink feed in the sandbox - a NORMAL case: the interface must say "demo", not show
    // yesterday's constant.
    priceFeed: null,
    explorerTx: "",
    explorerAddr: "",
    explorerName: "",
    gasUsd: 0.0001,
    routeType: "atomic",
    // THE FACTORY DEPLOYED INTO THE LOCAL CHAIN. Its address is NOT CHOSEN BUT FOLLOWS FROM THE SENDER'S HISTORY:
    // CREATE builds it from the account and its transaction number, so on a FRESH chain it is always the same while
    // on a long-running one it differs - the account already has history. Here the address was MEASURED on chain
    // (code read + keccak) after a redeploy for the quote format with xmrAmount: account 0 of anvil, nonce 60, block
    // 74, 13188 bytes of code (keccak 0x9bffb62d50eef21bcfd4b59e1c3d6fb7cbb3e303257edb2f5ba9dc65b3e8719c -
    // matched the tree build). The deploy command comes from mvp/contracts, the same form the stack tool uses.
    // cashier is the second CREATE of the same pass (factory, then cashier, then registry): 573 bytes, keccak
    // 0xcca1d8bc53d1d1c98901570800e093d0933f84637c6cdc727153b3ef8d8c3c36 - exactly the hash the escrow checks
    // the cashier with. The registry is the third CREATE (DEPLOY_REGISTRY=true), 4557 bytes. PREVIOUS record:
    // factory 0x5fbdb2315678afecb367f032d93f642f64180aa3 and cashier 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512,
    // whose code did not match the canonical cashier - the escrow would have rejected such an order.
    // THE ESCROW IMPLEMENTATION CODE HASH: what executes each order's clone, which the interface must check itself
    // rather than trust the factory. The value is keccak256 of NinseiEscrow's runtime code from OUR OWN build (forge
    // inspect NinseiEscrow deployedBytecode --root mvp/contracts and keccak - matched keccak256(type(NinseiEscrow)
    // .runtimeCode) that the factory writes, and the out/ artifact). The implementation has NO immutables, so this is
    // a PROTOCOL CONSTANT - the same hash on any network with that build. It sits per network, not as one global
    // number, because the policy may be absent: a network with an OLD factory (no implementation()) must stay
    // WITHOUT a policy, else reading the pair fails and live quotes there stall. That is the case on
    // arbitrum-sepolia: its factory does not know the build (both getters revert), so it has NO field; it is enabled
    // in the same pass as the new deploy.
    escrow: { address: "0xcbEAF3BDe82155F56486Fb5a1072cb8baAf547cc", mode: "live", cashier: "0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f", implementationCodeHash: "0xfd1ef12c1d96d3ee7060bd5901e06108723783403fad00c9630dcdeb6193674b" },
    // There are no tokens in the sandbox: payment is native. An empty list is a fact about the sandbox, not an oversight.
    tokens: [],
    // Uniswap is not deployed in the sandbox and is not needed: this is a chain of its own for end-to-end runs, while
    // the DEX leg is checked on public networks (see DEX_CHAINS at the top). The network has no uniswap block.
  },
  {
    id: "arbitrum",
    name: "Arbitrum One",
    vm: "evm",
    chainId: 42161,
    caip2: "eip155:42161",
    native: { symbol: "ETH", decimals: 18, usd: 3212.4 },
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    // The Chainlink feed for the native price. The addresses are confirmed by a chain CALL (description() matched
    // the pair, the value is fresh and within a sensible range). With no feed there is no price: the interface must
    // say "demo", not show yesterday's constant.
    priceFeed: { address: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", pair: "ETH / USD", decimals: 8, min: 100, max: 20000 },
    explorerTx: "https://arbiscan.io/tx/",
    explorerAddr: "https://arbiscan.io/address/",
    explorerName: "arbiscan",
    gasUsd: 0.21, // a demo estimate of gas cost, like the rest of the demo numbers
    routeType: "atomic",
    // No escrow contract on any live network, so the demo simulates funding.
    escrow: { address: null, mode: "simulated" },
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, usd: 1, cls: "ar-token-usdc" },
      // The address is the one USDT had on Arbitrum, but the contract now answers symbol="USD₮0": Tether moved it
      // to USDT0 (the migration kept the address, 1:1 to USDT on Ethereum). The id stays USDT - a user switches on
      // "USDT", not "USD₮0".
      { symbol: "USDT", onChainSymbol: "USD₮0", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, usd: 1, cls: "ar-token-usdt" },
      // DAI and USDe: the addresses are the OWNER'S DECISION (they stood before). Each is confirmed by a chain read
      // on 2026-09-23, block 508109137: code present, symbol()/decimals()/name() read. The pool measurement (getPool
      // on tiers 100/500/3000/10000): USDe has pools at 500 and 3000 with ZERO reserves. This is REFERENCE for a
      // person, not a filter: the swap list is fixed (DEX_ASSETS) and the tool does not filter it.
      // USDS AND PyUSD ARE NOT OFFERED ON THIS NETWORK (the owner's decision). Their previous addresses were removed
      // here together with the routes: an asset the network does not offer must neither be drawn in the network's
      // asset row (ui/chainPicker.js) nor enter the swap list (ui/views/swapForm.js). On Ethereum both stay.
      { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, usd: 1, cls: "ar-token-dai" },
      { symbol: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18, usd: 1, cls: "ar-token-usde" },
      // WETH: as in arbitrum-sepolia (see the comment there) - no pool is searched, WETH->ETH is an unwrap at
      // WETH9. The address is measured: token0/token1 of the USDC/WETH pools, symbol()="WETH", decimals=18, name()="Wrapped Ether".
      { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, cls: "ar-token-eth", peg: "native", hidden: true },
    ],
    // DEX LEG: the addresses come from the official Uniswap deployment list (deployments/json/42161.json) and are
    // confirmed by chain calls on 2026-09-23: QuoterV2 code 8273 bytes, factory code 24535 bytes, getPool(
    // USDC|USDT|DAI|USDe, WETH, 100|500|3000|10000) answers, quotes are live. WHAT THIS NETWORK LACKS: USDe has a
    // pool but no liquidity (liquidity()=0), and the 10000 tier for DAI is tiny - a quote for 100000 DAI gives a
    // quarter of one for 1000. That is visible in the measurement, and it is exactly why the leg goes through a pool
    // rather than a mock.
    uniswap: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      wrapped: { symbol: "WETH", name: "Wrapped Ether", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
      feeTiers: [100, 500, 3000, 10000],
    },
  },
  {
    id: "mainnet",
    name: "Ethereum",
    vm: "evm",
    chainId: 1,
    caip2: "eip155:1",
    native: { symbol: "ETH", decimals: 18, usd: 3212.4 },
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    // The Chainlink feed for the native price. The addresses are confirmed by a chain CALL (description() matched
    // the pair, the value is fresh and within a sensible range). With no feed there is no price: the interface must
    // say "demo", not show yesterday's constant.
    priceFeed: { address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", pair: "ETH / USD", decimals: 8, min: 100, max: 20000 },
    explorerTx: "https://etherscan.io/tx/",
    explorerAddr: "https://etherscan.io/address/",
    explorerName: "etherscan",
    gasUsd: 3.4, // L1 gas is noticeably dearer - visible in the demo when choosing a network
    routeType: "atomic",
    escrow: { address: null, mode: "simulated" },
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, usd: 1, cls: "ar-token-usdc" },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, usd: 1, cls: "ar-token-usdt" },
      // DAI, USDe, USDS, PyUSD: USDS and PyUSD are the OWNER'S ADDRESSES, each confirmed by a chain read on
      // 2026-09-23, block 26039940: code present, symbol()/decimals()/name() read (USDS: "USDS"/18/"USDS Stablecoin";
      // PyUSD: "PYUSD"/6/"PayPal USD"). USDS and USDe differ by one letter, so they were confirmed separately. The
      // factory measurement (getPool(token, WETH, fee)) on the same block: USDS pools only at 500 (~2.1 USDS) and 3000
      // (empty); PyUSD at 500 (empty), 3000 (~33.8 PyUSD) and 10000 (~265.8 PyUSD); USDe has NO pool with WETH at any
      // tier. This is REFERENCE, not selection: the list is fixed (DEX_ASSETS).
      { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, usd: 1, cls: "ar-token-dai" },
      { symbol: "USDe", address: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", decimals: 18, usd: 1, cls: "ar-token-usde" },
      { symbol: "USDS", address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", decimals: 18, usd: 1, cls: "ar-token-usds" },
      { symbol: "PyUSD", address: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", decimals: 6, usd: 1, cls: "ar-token-pyusd" },
      // WETH: no pool searched - WETH->ETH is an unwrap at WETH9 (1:1). hidden: true = do not show in the network
      // showcase but keep in the swap list (see arbitrum-sepolia). The address is confirmed by measurement.
      { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, cls: "ar-token-eth", peg: "native", hidden: true },
    ],
    // DEX LEG: the addresses come from the official Uniswap deployment list (deployments/json/1.json), confirmed by
    // calls: QuoterV2 code 8273 bytes, factory 24535 bytes, USDC|USDT|DAI to WETH pools exist at all four tiers and
    // quotes are live. USDe has NO pool on any tier here - and that must be said in words, not shown as a zero.
    uniswap: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      wrapped: { symbol: "WETH", name: "Wrapped Ether", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
      feeTiers: [100, 500, 3000, 10000],
    },
  },
  {
    id: "base",
    name: "Base",
    vm: "evm",
    chainId: 8453,
    caip2: "eip155:8453",
    native: { symbol: "ETH", decimals: 18, usd: 3212.4 },
    rpcUrl: "https://mainnet.base.org",
    // The Chainlink feed for the native price. The addresses are confirmed by a chain CALL (description() matched
    // the pair, the value is fresh and within a sensible range). With no feed there is no price: the interface must
    // say "demo", not show yesterday's constant.
    priceFeed: { address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", pair: "ETH / USD", decimals: 8, min: 100, max: 20000 },
    explorerTx: "https://basescan.org/tx/",
    explorerAddr: "https://basescan.org/address/",
    explorerName: "basescan",
    gasUsd: 0.08,
    routeType: "atomic",
    escrow: { address: null, mode: "simulated" },
    tokens: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, usd: 1, cls: "ar-token-usdc" },
      { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, usd: 1, cls: "ar-token-usdt" },
      { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, usd: 1, cls: "ar-token-dai" },
      { symbol: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", decimals: 18, usd: 1, cls: "ar-token-usde" },
    ],
    // THERE IS NO DEX LEG ON THIS NETWORK, and that is NOT "we did not check" but the product state: the network is
    // coming soon, it has no uniswap block and no pools are searched here. What that means for the screen: it must
    // say so in words (see mock/market.js: dexRoute), not show a dummy pool.
  },
  {
    id: "bsc",
    name: "BNB Chain",
    vm: "evm",
    chainId: 56,
    caip2: "eip155:56",
    native: { symbol: "BNB", decimals: 18, usd: 612.5 },
    rpcUrl: "https://bsc-dataseed.binance.org",
    // The BNB price: the Chainlink feed is not confirmed by a call - so far the network shows "demo", not an
    // invented number. It is added here once the address is verified like the others.
    explorerTx: "https://bscscan.com/tx/",
    explorerAddr: "https://bscscan.com/address/",
    explorerName: "bscscan",
    gasUsd: 0.05,
    routeType: "atomic",
    escrow: { address: null, mode: "simulated" },
    tokens: [
      // Note: on BSC USDT and USDC have 18 decimals (not 6, as on Ethereum L1 and L2).
      // DAI and USDe are not added on BNB Chain: the demo does not have them there.
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, usd: 1, cls: "ar-token-usdt" },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, usd: 1, cls: "ar-token-usdc" },
    ],
    // THERE IS NO DEX LEG ON THIS NETWORK: it is coming soon, has no uniswap block, and no pools are searched here.
    // This network's wrapped native is WBNB (its native is BNB, not ETH), but while the network is off the registry
    // has none of its addresses: no point confirming what we do not use.
  },
  {
    id: "bitcoin",
    name: "Bitcoin",
    vm: "bitcoin",
    chainId: 0, // Bitcoin has no EVM chainId; 0 is the SLIP-44 coin type and does not clash with EVM networks
    caip2: "bip122:000000000019d6689c085ae165831e93", // bip122 + the first 32 chars of the zero block hash
    native: { symbol: "BTC", decimals: 8, usd: 96000 },
    // Bitcoin has no JSON-RPC: this is a block explorer's REST API. The demo does not call it.
    rpcUrl: "https://blockstream.info/api",
    explorerTx: "https://mempool.space/tx/",
    explorerAddr: "https://mempool.space/address/",
    explorerName: "mempool.space",
    gasUsd: 1.2,
    routeType: "atomic",
    // In Bitcoin there is one asset - BTC itself: the protocol has no contract tokens.
    tokens: [],
    // An escrow contract cannot exist here, and that is not a gap: Bitcoin uses a native atomic swap (HTLC/adaptor
    // signatures in the script) instead of a contract. So we say plainly what it settles with and do not pass the
    // absence of a contract off as "coming soon". The demo cannot do Bitcoin yet (it connects an EVM wallet), so
    // escrow: null - the network is listed but not selectable.
    escrow: null,
    settlement: "native-atomic-swap",
  },
  {
    id: "tron",
    name: "Tron",
    vm: "tron",
    chainId: 728126428, // network id: eth_chainId on TronGrid answers 0x2b6653dc
    caip2: "tron:0x2b6653dc",
    native: { symbol: "TRX", decimals: 6, usd: 0.28 },
    rpcUrl: "https://api.trongrid.io",
    explorerTx: "https://tronscan.org/#/transaction/",
    explorerAddr: "https://tronscan.org/#/address/",
    explorerName: "tronscan",
    gasUsd: 0.35,
    routeType: "atomic",
    // NOT EVM: today the demo connects only an EVM wallet (EIP-1193) and can neither read balances here nor sign.
    // So the network is listed but not selectable - escrow: null.
    escrow: null,
    tokens: [
      // TRC-20: symbol()/decimals() verified through TronGrid triggerconstantcontract (USDT, 6).
      { symbol: "USDT", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, usd: 1, cls: "ar-token-usdt" },
    ],
  },
  {
    id: "solana",
    name: "Solana",
    vm: "solana",
    chainId: 101, // Solana mainnet-beta id; below is the CAIP-2 with the genesis hash
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    native: { symbol: "SOL", decimals: 9, usd: 198.4 },
    rpcUrl: "https://api.mainnet-beta.solana.com",
    explorerTx: "https://solscan.io/tx/",
    explorerAddr: "https://solscan.io/account/",
    explorerName: "solscan",
    gasUsd: 0.002,
    routeType: "atomic",
    // NOT EVM: see the note at Tron.
    escrow: null,
    tokens: [
      // SPL mint: verified by getAccountInfo (owner Tokenkeg...) and getTokenSupply (decimals 6).
      { symbol: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, usd: 1, cls: "ar-token-usdc" },
      { symbol: "USDT", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6, usd: 1, cls: "ar-token-usdt" },
    ],
  },
  {
    id: "monad",
    name: "Monad",
    vm: "evm",
    // The demo cannot do this network yet: in the UI it behaves like Solana - grey and not selectable, with
    // "not supported yet" written honestly in the row. The network's plan is not cancelled - the mark comes off
    // when a contract and tokens appear.
    unsupported: true,
    chainId: 143,
    caip2: "eip155:143",
    native: { symbol: "MON", decimals: 18, usd: 0.03 },
    rpcUrl: "https://rpc.monad.xyz",
    explorerTx: "https://monadscan.com/tx/",
    explorerAddr: "https://monadscan.com/address/",
    explorerName: "monadscan",
    gasUsd: 0.01,
    routeType: "atomic",
    escrow: { address: null, mode: "simulated" },
    tokens: [
      // USDC (Circle) and USDT0: symbol()/decimals() verified by a call on the Monad network (chainId 143).
      { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6, usd: 1, cls: "ar-token-usdc" },
      { symbol: "USDT", onChainSymbol: "USDT0", address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", decimals: 6, usd: 1, cls: "ar-token-usdt" },
    ],
    // NO DEX LEG HERE: the network is coming soon, pools are not searched and addresses are not written into the
    // registry. No point keeping an address in the interface that cannot be used: what we measured earlier simply
    // stops being checked, and keeping it as "data" would be a lie.
  },
  {
    id: "hyperevm",
    name: "Hyperliquid EVM",
    vm: "evm",
    // The demo cannot do this network yet: in the UI it behaves like Solana - grey and not selectable, with
    // "not supported yet" written honestly in the row. The network's plan is not cancelled - the mark comes off
    // when a contract and tokens appear.
    unsupported: true,
    chainId: 999,
    caip2: "eip155:999",
    native: { symbol: "HYPE", decimals: 18, usd: 38.5 },
    rpcUrl: "https://rpc.hyperliquid.xyz/evm",
    explorerTx: "https://hyperevmscan.io/tx/",
    explorerAddr: "https://hyperevmscan.io/address/",
    explorerName: "hyperevmscan",
    gasUsd: 0.01,
    routeType: "atomic",
    escrow: { address: null, mode: "simulated" },
    tokens: [
      // USDC and USDT0 (the contract's symbol = "USD₮0"): verified by calls on the network itself (chainId 999).
      { symbol: "USDC", address: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", decimals: 6, usd: 1, cls: "ar-token-usdc" },
      { symbol: "USDT", onChainSymbol: "USD₮0", address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", decimals: 6, usd: 1, cls: "ar-token-usdt" },
    ],
    // NO DEX LEG HERE: the network is coming soon, pools are not searched and addresses are not written into the registry.
  },
];

export const DEFAULT_CHAIN = "arbitrum-sepolia";

// THE ALLOW-LIST OF PROVIDERS - INTERFACE POLICY, NOT A CHAIN CHECK.
//
// The chain answers a DIFFERENT question: whose key signed the quote (the maker registry, providerOf - the core
// reads it, sdk/src/quotes.mjs). THIS list is the interface's decision about whom it trades with at all. A provider
// whose address the chain confirms but who is not named here is refused (the code `quote-provider-not-allowed`), and
// the person sees that BEFORE signing: the quote shows the fee, but its issuance will not happen.
//
// WHY A SEPARATE LIST AND NOT A READ FROM THE BACKEND. Selection is the interface's business: it changes here,
// without redeploying contracts or editing someone else's node. The backend has the same kind of list
// (`ARRAKIS_ALLOWED_PROVIDERS`, in the backend env) - TWO independent steps of one decision, not a copy: the page
// guards itself even if the service is configured differently.
//
// THE ADDRESSES ARE LOWERCASE, as the quote gives them (field `provider`). A network with no entry here means
// "no list set" (the policy does not apply), NOT "let nobody in": otherwise a network without configuration would
// stall entirely. A network's list needs filling once a maker is registered there.
export const ALLOWED_PROVIDERS = {
  "local-anvil": ["0x60af2ad4963c738aa6ac16d6cb0af1982508ba21"],
};

// The allow-list for a network - or null if it is not set (no policy). The core accepts both an array and a
// predicate; here an array is returned in lowercase: the list is what is visible and changed in one place.
export function allowedProvidersFor(chainOrId) {
  const id = typeof chainOrId === "string" ? chainOrId : chainOrId && chainOrId.id;
  const list = ALLOWED_PROVIDERS[id];
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map((a) => String(a).toLowerCase());
}

// THE LIST OF KNOWN FACTORY BUILDS - INTERFACE POLICY, next to allowedProviders. The value is the extcodehash
// (keccak256 of the code) of a factory the interface will accept: the factory comes from the PROVIDER REGISTRY
// record, and its code is compared against this list. Empty for a network = no policy (the factory must still be
// named by the record and match the signed quote). Filled at deploy: the factory has no immutables, so one build
// gives the same hash to anyone who deployed it - a provider's own factory lands in the same list.
export const KNOWN_FACTORY_CODES = {};

export function knownFactoryCodesFor(chainOrId) {
  const id = typeof chainOrId === "string" ? chainOrId : chainOrId && chainOrId.id;
  const list = KNOWN_FACTORY_CODES[id];
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.map((h) => String(h).toLowerCase());
}

// THE LIST OF KNOWN ESCROW-IMPLEMENTATION BUILDS - INTERFACE POLICY, at the network where the factory address
// (escrow.address) lives. Its code hash is a PROTOCOL CONSTANT (the implementation has no immutables), but the
// policy may be unset: a network without an implementationCodeHash field has NONE (an old factory does not give the
// pair). Empty = no policy; non-empty = the interface trades only through factories leading to this build.
export function knownImplementationCodesFor(chainOrId) {
  const id = typeof chainOrId === "string" ? chainOrId : chainOrId && chainOrId.id;
  const chain = CHAINS.find((c) => c.id === id) || chainById(id);
  const pinned = chain && chain.escrow ? chain.escrow.implementationCodeHash : null;
  if (typeof pinned !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(pinned)) return null;
  return [pinned.toLowerCase()];
}

export function chainById(id) {
  return CHAINS.find((c) => c.id === id) || CHAINS.find((c) => c.id === DEFAULT_CHAIN) || CHAINS[0];
}

export function chainByChainId(chainId) {
  return CHAINS.find((c) => c.chainId === Number(chainId)) || null;
}

// A network's accepted tokens: native first, then contract ones.
export function tokensOf(chainId) {
  const c = chainById(chainId);
  return [nativeOf(chainId), ...c.tokens];
}

export function nativeOf(chainId) {
  const c = chainById(chainId);
  return {
    symbol: c.native.symbol,
    label: c.native.symbol,
    address: null,
    decimals: c.native.decimals,
    usd: c.native.usd,
    cls: "ar-token-eth",
    native: true,
  };
}

// A network's WRAPPED native token (WETH/WBNB...), or null. It is what the liquidity leg settles (KyberSwap Limit
// Order trades ERC20 against ERC20 and cannot deliver native) and what the native leg sells to buy native coin: the
// engine's composed route (www/js/evm/asyncExec.js) turns the token into this wrapped token first, then into native.
export function wrappedNativeOf(chainId) {
  const c = chainById(chainId);
  return (c.tokens || []).find((t) => t && t.peg === "native") || null;
}

// A token by its composite id "<chainId>:<SYMBOL>" or by two arguments.
export function tokenById(idOrChainId, symbolMaybe) {
  let chainId = idOrChainId;
  let symbol = symbolMaybe;
  if (typeof idOrChainId === "string" && idOrChainId.includes(":")) {
    [chainId, symbol] = idOrChainId.split(":");
  }
  const list = tokensOf(chainId);
  return list.find((t) => t.symbol === String(symbol).toUpperCase()) || list[0];
}


// The demo's Monero network. networkType=mainnet because monero-js (the vendored mnemonic/key/address library)
// supports only mainnet address prefixes (see the vendored readme). The monero-ts mode (WebAssembly wallet2) also
// handles stagenet.
// The order recipient (claimer) for TESTS on test networks.
//
// IMPORTANT: the contract requires locker and claimer to differ, so a payment address must not be given here -
// the transaction would be rejected. The connected wallet pays (anyone), while the funds are claimed by whoever is
// recorded here, presenting the order secret.
// This is a TEST stub: in production the recipient address comes from the maker's RFQ node with the quote.
export const TEST_CLAIMER = "0xc14C7841C7d6350859474dD6DF8dC9672047A6A0";

export const MONERO = {
  // The network in which the demo generates its demo wallet and recipient address. It must match XMR_NETWORKS
  // (below) and the chain the node is connected to: an address of another network in the recipient field means XMR
  // sent nowhere. A check verifies the match.
  networkType: "stagenet",
  confirmTarget: 10, // confirmations before claim (the litepaper example)
  blockTimeSim: 120_000, // 2 minutes per block, in sim time
  blockTimeReal: 120_000, // the real Monero mainnet target
  // The Monero node. Its address is set in ONE named place (see ENDPOINTS) and nowhere else: the demo has no
  // parameters (no ?rpc=, no localStorage) and no RPC switching is planned. The node is needed only for the network
  // status and live-confirmation mode; keys, balances and withdrawals are not requested through it.
  // A DEPLOYMENT sets the node address in ENDPOINTS; on the local stand the page must reach OUR node - the
  // production proxy may be unavailable (502), and the network height is one source of the recovery file's scan
  // height, i.e. without a node the file reaches its owner without a height.
  node: ENDPOINTS.moneroNode,
  nodePollMs: 30_000,
};

// ---------------------------------------------------------------------------
// The backend (app/): swap sessions and watching the Monero leg.
//
// The API lives on the same domain at /api/ (Angie proxies to 127.0.0.1:8787), so CSP needs no edit - connect-src
// 'self' covers it. Locally the same path is served with an --api flag - also without touching the policy.
// ---------------------------------------------------------------------------
export const API = {
  base: "/api",
  // The Monero-leg source: 'app' - the real backend over HTTP, 'mock' - the demo simulator with no network.
  xmrSource: "app",
  pollMs: 5_000, // how often the front end polls a swap session
  // HOW MANY PROVIDERS TO SHOW in the price block. A list of dozens of rows is unreadable, and a person cannot
  // compare more than five prices anyway - he picks the best. The rest are not silenced: a summary line ("and N
  // more") tells of their existence.
  maxProviders: 5,
  timeoutMs: 60_000, // One request's timeout: a hung backend must not hang the screen. 60 s, not 10: creating the
    // deal wallet is the only LONG path - it scans the chain from the restore height - and the old 10 s cut off a
    // WORKING request. From outside it looked like "Swap wallet unavailable". The deadline was raised twice
    // (8 -> 10 -> 60): a short timeout here is not a guard but a false refusal.
};

// The Monero network for each source. The backend on the server works with a stagenet wallet (monero-wallet-rpc is
// up on a stagenet node), so in 'app' mode the swap address must be a stagenet one: otherwise wallet-rpc cannot
// create a watch-only wallet for it. The demo's mock mode was historically mainnet - addresses from the demo examples.
// ONE CHAIN FOR THE WHOLE DEMO. The mock mode used to pretend to be mainnet, which only hurt: mock addresses looked
// like mainnet (prefix 4) while the live node is stagenet (prefix 5), and two chains sat side by side in one UI.
// Mixing chains in a swap means lost money (see monero/address.js), so now both mock and live are stagenet.
//
// PLUS THE FAMILIAR NAME REGTEST. The app/mock keys answer "which network this source's wallet is on". A third
// source entry has none: fakechain is the official name of monerod's regtest mode, which the CI contour node calls
// itself. It is needed so the network name is ACCEPTED: the core compares xmrNetwork against the engine's network
// list (sdk/src/config.mjs, STANDARD_XMR_NETWORKS), and the core's wallet adapter takes its network list FROM THIS
// registry (sdk/src/adapters/monero-wallet.mjs). The demo's wallet stays stagenet.
export const XMR_NETWORKS = { app: "stagenet", mock: "stagenet", fakechain: "fakechain" };

// The sweep page: a separate domain with its own (stricter) policy and a WASM wallet. The user makes the XMR
// withdrawal there, from his recovery file - the demo does not sign for him.
// Where the link to the withdrawal page leads. In production - the production domain, on the local stand - its own
// address (its own node and backend there). A separate function so the rule is one: the link and where the page is
// actually served must not diverge.
export function sweepOrigin() {
  const h = typeof location !== "undefined" ? location.hostname : "";
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h) || /\.local$/.test(h) ? SWEEP.localOrigin : SWEEP.origin;
}

export const SWEEP = {
  origin: ENDPOINTS.sweepOrigin,
  localOrigin: "http://localhost:5195",
};

// ---------------------------------------------------------------------------
// The EVM wallet: WalletConnect (Reown). projectId is the app's public identifier, visible to any site with
// WalletConnect (not a secret: it goes into the QR and the relay). The metadata is shown to the user in the wallet.
// ---------------------------------------------------------------------------
export const EVM = {
  projectId: "18c13c05b6c0ab011ffff7cee0700e2d",
  metadata: {
    name: "NinseiSwap",
    description: "Non-custodial XMR <-> EVM atomic swap. Demo build: real wallet, real balances, no real funds move.",
    url: PAGE_ORIGIN,
    icons: [],
  },
};

// THERE IS NO FEE RATE HERE - AND THERE MUST NOT BE. The only source of truth is the SIGNED QUOTE. The rate, amount
// and recipient of the fee are part of the order terms; the factory no longer has feeBps()/feeFor() (the router was
// removed), and the node does not compare its setting with the chain - it SIGNS it, while the amount comes in the
// quote and is checked by the formula mirror (www/js/evm/fees.js, rfq/fundEscrow.mjs). A copy in the config would
// diverge from the signed set - and it would surface at signing, not here. The record with a rate (0.003) was
// removed on 28 September 2026; the move to the quote was the fee-in-order stage.

// Mock makers. The spread is what a maker keeps; the Ninsei fee is counted separately.
// THE LIST OF INVENTED MAKERS IS REMOVED. It used to hold Makers A/B/C with a markup, uptime, reserve and delay -
// all of it reaching the interface as facts. We do not measure someone else's uptime, we do not know their reserve,
// and a provider forms its own markup and shows it only in its price. Now quotes come from a provider through the
// backend (/api/rate), and there is nothing to invent next to them.

// Timings. All in sim milliseconds (see js/core/clock.js): at speed=60 one real second equals one sim minute.
export const TIMING = {
  quoteValid: 12_000, // quote lifetime (12 s in sim)
  quoteRefresh: 5_000,
  fundingMined: 6_000, // the funding tx landed in a block
  makerLock: 30_000, // the maker locks the XMR
  xmrConfirm: MONERO.blockTimeSim,
  readyWindow: 60 * 60_000, // how long the user has to mark ready after the lock
  makerClaim: 45_000,
  sweep: 30_000,
  t0Refund: 20 * 60_000, // after this the ETH can be refunded if the maker did not lock the XMR
  t1Refund: 40 * 60_000, // after this the ETH can be refunded if the maker did not claim
  watchtowerGrace: 5 * 60_000, // the watchtower refunds if the user left
  makerReclaim: 10 * 60_000, // the maker takes the XMR back if the user did not mark ready
};

export const DEMO = {
  speeds: [1, 20, 60, 300],
  defaultSpeed: 60,
  scenarios: ["happy", "maker_no_lock", "user_no_ready", "maker_stall"],
  defaultScenario: "happy",
  // There is no wallet mode any more: keys in the demo are computed by monero-js, the only path (the WASM wallet
  // monero-ts moved to the separate sweep domain - its own policy and COOP/COEP).
  // mock - confirmations by a sim timer; live - by the real Monero mainnet height
  chainModes: ["mock", "live"],
  // LIVE HEIGHT BY DEFAULT. "mock" means confirmations by a sandbox timer - a demo mode, and it is no longer
  // substituted by itself: a deal must be counted by the real chain height, else "confirmed" on screen means
  // nothing. Demo mode remains a choice, not a default.
  defaultChainMode: "live",
  // The Monero-leg source: 'app' - the real backend (see API.xmrSource), 'mock' - the simulator.
  xmrSources: ["app", "mock"],
  defaultXmrSource: "app",
  defaultChain: DEFAULT_CHAIN,
};

export const SCENARIO_LABELS = {
  happy: "happy path",
  maker_no_lock: "maker never locks XMR",
  user_no_ready: "user never confirms",
  maker_stall: "maker stalls after ready",
};
