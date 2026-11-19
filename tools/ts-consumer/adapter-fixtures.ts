// Implementations use only the exported contracts: the declared block carries the chain number and timestamp, and
// the declared storage is synchronous. `asyncStorage` is deliberately outside StorageAdapter: it is the refusal
// fixture for a promise-returning store, not an adapter the interface promises to accept.
import type { NinseiOptions, StorageAdapter } from "@ninsei-labs/sdk";

export const declaredBlock: NonNullable<NinseiOptions["evmBlock"]> = async () => ({
  number: "0x10",
  timestamp: 1_900_000_000,
  baseFeePerGas: "0x1",
});

export function syncStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return {
    get(key) { return values.get(key) ?? null; },
    set(key, value) { values.set(key, value); },
    remove(key) { values.delete(key); },
  };
}

export function asyncStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return {
    async get(key: string) { return values.get(key) ?? null; },
    async set(key: string, value: string) { values.set(key, value); },
    async remove(key: string) { values.delete(key); },
  } as unknown as StorageAdapter;
}
