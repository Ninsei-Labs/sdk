// THE ENGINE SEAM, NOW SELF-CONTAINED.
//
// The engine modules the core depends on are mirrored under sdk/engine/ - byte-for-byte copies kept in
// sync by tools/build-sdk-engine.mjs and guarded by tools/check-sdk-engine.mjs. This file is the ONLY
// place that knows where the engine lives; no other SDK module does.
//
// WHY A VERIFIED MIRROR, NOT A MOVE. The very same modules are loaded by the demo page in the browser
// (www/js), and the production web root is www/ alone - the sdk/ directory is not served there (see
// tools/serve.mjs). Lifting the files out of www/js would 404 every engine import on the live site, and
// dozens of repository checks read those sources by their www/js path. So the single source of truth
// stays www/js and the SDK carries a copy: any drift reddens check-sdk-engine, so it cannot diverge
// silently (the same rule build-sweep uses for the sweep/rfq copies).
//
// The mirror is generated - never edit sdk/engine/ by hand. Change www/js, then run:
//   node tools/build-sdk-engine.mjs
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
// HALF TRANSFER: the byte format and opening are the very same ones the page worker uses
// (www/js/atomic/order-worker.js). The core keeps no copy of the format: the commitment is computed over those
// exact bytes, and a second copy would silently drift from the calldata.
export * as halfenc from "../engine/atomic/halfenc.js";
// The engine's EVM layer: talking to the chain (order terms, sending, reading) - through this seam.
export * as evm from "../engine/evm/index.js";
export * as swapFlow from "../engine/core/swap-flow.js";
export * as escrow from "../engine/evm/escrow.js";
export * as halvesSweep from "../engine/monero/halvesSweep.js";
// MONERO ADDRESSES - THROUGH THE SAME MODULE THE DEMO USES. The format, the network prefixes and the address
// check live in www/js/monero/address.js (checkAddress: base58 + keccak256 + network), and the page uses it
// too. The wallet adapter needs exactly networkFromShape: its own address must belong to the network named by
// the core, and that is checked by the same code, not by a private prefix table.
export * as xmrAddress from "../engine/monero/address.js";
// THE unlock_time RULE AND THE BLOCK READER - FROM THE SAME MIRROR, NOT A COPY. A second copy of "the output
// is barred until a boundary" would be a second truth about money, so the rule lives under www/js
// (monero/unlock.js) together with the Monero block parser (monero/scan.js), and the SDK reads them through
// the engine mirror. check-sdk-engine reddens on any drift, so the two cannot diverge silently.
export * as xmrUnlock from "../engine/monero/unlock.js";
export * as xmrScan from "../engine/monero/scan.js";
