// THE BROWSER FACADE OF THE PACKAGE.
//
// The page cannot load `src/` directly: `src/primitives.mjs` imports @noble/curves and @noble/hashes by bare
// package name. esbuild turns this entry into one ESM file; the bridge in `engine/sdk/bridge.js` imports that file.
// The exports are the surfaces the page already uses: the facade, the four factories, the EVM wallet adapter and
// the two storage adapters. No Node-only adapter is included.
export { createNinsei, SdkError, ERROR_CODES, STEP_CODES, CHECK_CODES } from "../src/index.mjs";
export { createSwaps } from "../src/swaps.mjs";
export { createQuotes } from "../src/quotes.mjs";
export { createActions } from "../src/actions.mjs";
export { createRecovery } from "../src/recovery.mjs";
export { evmWallet } from "../src/adapters/evm-wallet.mjs";
export { localStorageAdapter, memoryAdapter } from "../src/adapters/local-storage.mjs";
