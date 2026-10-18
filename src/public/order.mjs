// THE ORDER SIDE: what a signature commits to, and the quote types it commits under.
//
// The canonical context string, the commitment on a half key, the EIP-712 quote types and digests. Same rule
// as ./xmr: names only, no second implementation, no browser.

export { ORDER_CONTEXT_VERSION, orderContextString } from "../../engine/atomic/orderContext.js";
export { halfCommitmentHex } from "../../engine/atomic/orderHalfCommit.js";

export {
  EIP712_DOMAIN_TYPE,
  ORDER_QUOTE_DOMAIN_NAME,
  ORDER_QUOTE_DOMAIN_VERSION,
  ORDER_QUOTE_FIELDS,
  ORDER_QUOTE_TYPE,
  ORDER_QUOTE_VERSION,
  quoteDigest,
  quoteDomainSeparator,
  quoteMissingFields,
  quoteStructHash,
  recoverQuoteKey,
  signQuoteDigest,
} from "../quoteEip712Spec.mjs";

// THE BOUND VERIFICATION HELPERS. The spec above is handed crypto by the caller; these two bind it to the SDK's
// own primitives, so a consumer verifies a maker's quote without assembling the binding itself. Verification
// only: the provider's signing key never enters this package.
export { orderQuoteMissingFields, recoverOrderQuoteKey } from "../quoteEip712.mjs";
