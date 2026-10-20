// DECLARATIONS FOR THE `./networks` ENTRY.
//
// src/public/networks.mjs only NAMES what engine/core/config.js already exports. The declarations cover the fields
// a consumer of the registry reads; the engine's objects carry more (explorers, price feeds, gas hints) and a
// consumer is free to read them, but nothing here invents a field the engine does not have.

/** A token the network accepts. `address` is a 20-byte hex string; `decimals` is what its own contract reports. */
export interface ChainToken {
  symbol: string;
  address: string;
  decimals: number;
  hidden?: boolean;
}

/** The DEX deployment on a network, when there is one. */
export interface ChainUniswap {
  factory?: string;
  quoter?: string;
  /** WETH: the wrapped form of the native coin, used when a route needs an ERC-20. */
  wrapped?: { address: string; decimals: number };
  [field: string]: unknown;
}

export interface Chain {
  id: string;
  name: string;
  vm: string;
  chainId: number;
  caip2?: string;
  testnet?: boolean;
  native: { symbol: string; decimals: number };
  rpcUrl?: string;
  tokens?: ChainToken[];
  uniswap?: ChainUniswap;
  [field: string]: unknown;
}

/** One entry per async route provider (CoWSwap, UniswapX, ...): what it settles and the networks it serves. */
export interface AsyncRouteProvider {
  venue?: string;
  shape?: string;
  settles?: string;
  networks?: Record<string, unknown>;
  [field: string]: unknown;
}

export declare const CHAINS: readonly Chain[];
export declare const DEX_CHAINS: readonly string[];
export declare const DEFAULT_CHAIN: string;
export declare const ASYNC_ROUTE_PROVIDERS: Readonly<Record<string, AsyncRouteProvider>>;
