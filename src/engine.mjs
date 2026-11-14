// THE ENGINE SEAM.
//
// The engine modules live under engine/. This file is the only place that knows where they live; no other SDK
// module does. The SDK is the source of truth for these modules: do not regenerate them from another repository.
//
// The page reaches the same protocol rules through its own bridge, but the package does not depend on the page's
// source tree. A rule that would be copied into both places must live here, in the package, and the bridge must
// read it from the package.
export * as config from "../engine/core/config.js";
export * as guards from "../engine/core/preSignGuards.js";
export * as restore from "../engine/recovery/restore.js";
// STORES - THROUGH THIS SAME SEAM. Both modules take an adapter from outside (get/set/remove), and by default
// use web storage if it is present: without an adapter they run in memory rather than fail on a missing DOM.
export * as store from "../engine/core/store.js";
export * as auth from "../engine/evm/auth.js";
export * as swap from "../engine/core/swap.js";
export * as recoveryFile from "../engine/recovery/recoveryFile.js";
export * as halves from "../engine/atomic/halves.js";
export * as orderContext from "../engine/atomic/orderContext.js";
export * as order from "../engine/atomic/order.js";
// HALF TRANSFER: the byte format and opening are the very same ones the engine's order builder uses. The core
// keeps no copy of the format: the commitment is computed over those exact bytes, and a second copy would
// silently drift from the calldata.
export * as halfenc from "../engine/atomic/halfenc.js";
// The engine's EVM layer: talking to the chain (order terms, sending, reading) - through this seam.
export * as evm from "../engine/evm/index.js";
// THE DEX LEG'S OWN GUARDS - THROUGH THE SAME SEAM. priceGateVerdict ("the price is not the market") and
// dexLegVerdict (amount coverage + price) live in engine/evm/dex.js and are re-exported here so a route provider
// that is NOT the declared Uniswap path (CoWSwap, an aggregator) applies THE SAME guards rather than lookalikes.
export * as dex from "../engine/evm/dex.js";
// THE DEAL ENGINE LIVES IN THE PACKAGE: the order flow is sdk/src/swap-flow.mjs and is declared in sdk/index.d.ts.
// The page reaches it through the bridge. What stays in the seam is the ORDER QUOTE source and the shared CLAIM
// GAS LIMIT that the flow reads through this same seam. The order side is built by engine/atomic/order.js.

export * as rfqSource from "../engine/core/rfqSource.js";
export * as claimGas from "../engine/evm/claimGas.js";
export * as escrow from "../engine/evm/escrow.js";
export * as halvesSweep from "../engine/monero/halvesSweep.js";
// MONERO ADDRESSES. The format, the network prefixes and the address check live in engine/monero/address.js
// (checkAddress: base58 + keccak256 + network); the page uses the same module through its bridge. The wallet
// adapter needs exactly networkFromShape: its own address must belong to the network named by the core, and that
// is checked by the same code, not by a private prefix table.
export * as xmrAddress from "../engine/monero/address.js";
// THE unlock_time RULE AND THE BLOCK READER. A second copy of "the output is barred until a boundary" would be a
// second truth about money, so the rule lives in engine/monero/unlock.js together with the Monero block parser
// (engine/monero/scan.js), and the SDK reads them through the engine seam. There is no external source to drift from.
export * as xmrUnlock from "../engine/monero/unlock.js";
export * as xmrScan from "../engine/monero/scan.js";
// THE ADDRESS AND ITS PUBLIC KEYS, for the arrival check: the view secret and spend key are bound to the address,
// not merely used as labels.
export * as xmrArrivalRead from "../engine/monero/arrivalRead.js";
