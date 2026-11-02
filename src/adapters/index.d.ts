// DECLARATIONS FOR THE `./adapters` ENTRY.
//
// This is the environment seam the interface wires in itself: an EIP-1193 wallet, browser or memory storage, and
// the two Monero wallet roles. The declarations name exactly what src/adapters/index.mjs re-exports; the test-only
// Node wallet is intentionally not exported here (it lives in tools/ and is not part of the package contract).

import type {
  Eip1193Provider,
  MoneroWalletAdapter,
  StorageAdapter,
  WalletAdapter,
} from "@ninsei-labs/sdk";

export interface EvmWalletOptions {
  /** A short adapter name for the interface; not user-facing text. */
  id?: string;
}

/** Wrap an EIP-1193 provider as the SDK's EVM wallet adapter. */
export declare function evmWallet(provider: Eip1193Provider, options?: EvmWalletOptions): WalletAdapter;

/** Browser storage adapter; the scope prefix is the interface's namespace. */
export declare function localStorageAdapter(scope?: string): StorageAdapter;

/** In-memory storage, used by tests and non-browser hosts. */
export declare function memoryAdapter(initial?: Record<string, string>): StorageAdapter;

export interface MoneroWalletOptions {
  /** The monero-ts wallet factory (`createWalletFull` in the browser bundle). */
  createWallet?: (config: Record<string, unknown>) => Promise<unknown>;
  /** A network name accepted by the core: mainnet, stagenet, testnet or fakechain. */
  networkType?: string;
  /** The Monero node or proxy URI. */
  serverUri?: string;
  /** Session password; it protects the in-memory wallet session, not the keys. */
  password?: string;
  /** Extra fields passed to the wallet factory. */
  fields?: Record<string, unknown>;
}

/** The XMR withdrawal role: sign separately from relay. */
export interface MoneroWithdrawalWallet {
  open(plan: { readonly address?: string; readonly restoreHeight?: number; readonly networkType?: string } | unknown): Promise<void>;
  sync(): Promise<void>;
  unlockedBalance(): Promise<bigint | number | string>;
  sweepUnlocked(request: { readonly address: string; readonly relay: boolean }): Promise<unknown>;
  fee?(signed: unknown): Promise<string | null>;
  relay(signed: unknown): Promise<readonly string[]>;
  close(): Promise<void>;
}

/** Build the XMR withdrawal wallet over the caller's monero-ts factory. */
export declare function moneroWallet(options?: MoneroWalletOptions): MoneroWithdrawalWallet;

export interface MoneroWalletAdapterOptions {
  createWallet?: (config: Record<string, unknown>) => Promise<unknown> | null;
  network?: string | null;
  serverUri?: string | null;
  password?: string;
  keys?: Record<string, unknown>;
  restoreHeight?: number;
  expectedAddress?: string | null;
}

/** Build the SDK wallet adapter over a Monero wallet; it also carries the withdrawal methods. */
export declare function moneroWalletAdapter(options?: MoneroWalletAdapterOptions): WalletAdapter & Partial<MoneroWalletAdapter>;
