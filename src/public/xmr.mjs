// THE XMR SIDE, FOR A CONSUMER THAT IS NOT THE BROWSER.
//
// A node that quotes, signs and later reveals a half key needs the same arithmetic the page uses: an address
// built from two public points, the half keys, the DLEQ proof, the maker's sell window. All of it lives in the
// engine next to this file; this entry only NAMES it, so a node can depend on a released version of this
// package instead of reaching into another repository's source. Nothing is re-implemented here, and nothing
// here is browser-specific - these modules touch no window, document or storage.

export {
  PREFIX_BY_NETWORK,
  addressForNetwork,
  addressFromKeys,
  addressPayload,
  checkAddress,
  decodeMoneroBase58,
  encodeMoneroBase58,
  formatCheck,
  isStagenetShaped,
  networkFromShape,
  prefixFor,
} from "../../engine/monero/address.js";

export { createHalves } from "../../engine/atomic/halves.js";
export { createDleq2 } from "../../engine/atomic/dleq2.js";

// THE SWEEP SIDE: the spend keys a revealed half yields, and the scalar a Monero hex string carries.
export { scalarFromMoneroHex, spendKeysFromRevealedHalf } from "../../engine/monero/halvesSweep.js";

export { SELL_WINDOW, sellWindowSec } from "../../engine/core/sellWindow.js";

// WHAT NETWORK A NODE SAYS IT IS ON: the wallet must be built from that answer, and an unknown answer is null -
// a default here would build a wallet for a chain the node may not serve.
export { networkFromNode } from "../../engine/monero/nodeNetwork.js";

// READING AN ARRIVAL WITHOUT A WALLET: the address and its public keys, the little-endian scalar form the daemon
// expects, whether a view key matches the address, and whether the coin is still locked by unlock_time.
export {
  decodeAddressKeys,
  scalarToLeHex,
  viewKeyMatchesAddress,
  unlockStateOf,
  UNLOCK_TIME_BLOCK_MAX,
} from "../../engine/monero/arrivalRead.js";
