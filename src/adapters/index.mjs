// ADAPTERS THE INTERFACE WIRES IN EXPLICITLY.
//
// Two different kinds of adapters, and both are here because both are about the environment, not the core:
//   wallet  - a wrapper over a concrete way to sign (today EVM/EIP-1193; later Tron, Solana);
//   storage - where unfinished swaps live (localStorage today, memory in tests).
//
// This directory is the only place in the SDK allowed to touch the DOM and to know about the browser
// environment (enforced by machine in tools/check-sdk.mjs).
export { evmWallet } from "./evm-wallet.mjs";
export { localStorageAdapter, memoryAdapter } from "./local-storage.mjs";
export { moneroWallet } from "./monero.mjs";
// THE MONERO WALLET FOR THE CORE - SEPARATE FROM THE WITHDRAWAL WALLET. `moneroWallet` above plays the XMR
// withdrawal role (open/sync/sweepUnlocked/relay); `moneroWalletAdapter` plays the SDK wallet role (vm/connect/
// address/chainId/unlockedBalance/subscribe/driver). One file for two roles would mix their surfaces.
export { moneroWalletAdapter } from "./monero-wallet.mjs";
// A TOOL OF THE TEST CONTOUR - SEPARATE FROM THE PAGE'S WALLET. It signs with its own key (the key comes only
// from the environment or a file) and refuses to sign on a production network by the engine's marker, so it is
// only good for local runs. A separate line here also because every file in the directory must be reachable
// through the package's map: otherwise the adapter exists but cannot be imported.
export { nodeTestEvmWallet, evmRpcReader, evmRpcProvider, testPrivateKeyFromEnv, isProductionChain, addressOfPrivateKey }
  from "./node-test-evm-wallet.mjs";
