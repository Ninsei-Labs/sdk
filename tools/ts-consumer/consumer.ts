// A MINIMAL CONSUMER: the declarations must be usable, not only parseable.
//
// This file is type-checked with `tsc --noEmit` against the package's own `exports` map. It deliberately touches
// the root, the XMR subpath and the recovery subpath, and it assigns concrete values to the public interfaces.
import {
  createNinsei,
  type Ninsei,
  type NinseiOptions,
  type StartRequest,
  type SwapsApi,
} from "@ninsei-labs/sdk";
import { moneroFeeEstimate, type FeeEstimateOk, type FeeEstimateRefusal } from "@ninsei-labs/sdk/xmr";
import { createRecoveryKey, type RecoveryKey } from "@ninsei-labs/sdk/recovery";
import {
  evmWallet,
  localStorageAdapter,
  memoryAdapter,
  moneroWallet,
  moneroWalletAdapter,
  type EvmWalletOptions,
  type MoneroWalletAdapterOptions,
} from "@ninsei-labs/sdk/adapters";
import type { Eip1193Provider, StorageAdapter, WalletAdapter } from "@ninsei-labs/sdk";

const options: NinseiOptions = {
  settlement: { chain: "arbitrum-sepolia" },
  xmrNetwork: "stagenet",
};
const sdk: Ninsei = createNinsei(options);
const swaps: SwapsApi = sdk.swaps;

export async function startOne(request: StartRequest) {
  return swaps.start(request);
}

export async function fee(url: string): Promise<FeeEstimateOk | FeeEstimateRefusal> {
  return moneroFeeEstimate({ url });
}

export function recoveryKey(): RecoveryKey {
  return createRecoveryKey({ createdAt: "2026-10-26" });
}

const provider: Eip1193Provider = { request: async () => null };
const walletOptions: EvmWalletOptions = { id: "typed-consumer" };
export const evm: WalletAdapter = evmWallet(provider, walletOptions);
export const browserStorage: StorageAdapter = localStorageAdapter("typed");
export const testStorage: StorageAdapter = memoryAdapter();
export const withdrawal = moneroWallet({ networkType: "stagenet", serverUri: "http://127.0.0.1:38081" });
const moneroOptions: MoneroWalletAdapterOptions = { network: null, serverUri: null };
export const monero: WalletAdapter = moneroWalletAdapter(moneroOptions);
