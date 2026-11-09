// THE ONE PLACE THE QUOTE LIFETIME AND ITS START MARGIN ARE NAMED.
//
// A firm quote is signed with `validUntil`, and the SDK refuses to start a swap when less than the start margin is left.
// A node that signs a shorter life than that margin is refusing its own quotes before the wallet is opened. The node
// imports this default and may override it with its own setting; the SDK keeps the value here so the two cannot drift.
export const LOCK_START_MARGIN_SEC = 30;

/** The default firm quote lifetime, in seconds. A node may override it, but the default is this value. */
export const DEFAULT_ORDER_QUOTE_TTL_SEC = 60;
