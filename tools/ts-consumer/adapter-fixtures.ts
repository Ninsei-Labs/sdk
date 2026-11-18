// Implementations use only the exported contracts; no extra block fields or synchronous storage helpers.
import type { NinseiOptions, StorageAdapter } from "@ninsei-labs/sdk";

export const feeOnlyBlock: NonNullable<NinseiOptions["evmBlock"]> = async () => ({ baseFeePerGas: "0x1" });
export function asyncStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
}
