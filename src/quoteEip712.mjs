// EIP-712 ORDER-QUOTE SIGNATURE - THE SDK SIDE (VERIFICATION ONLY).
//
// The SDK verifies, it does not sign: the maker's wallet key never reaches the customer's machine. The spec
// (types, domain, digest, recovery) lives in quoteEip712Spec.mjs, byte-identical to the node's copy and pinned
// by tools/check-quote-eip712.mjs. Here it is only bound to the SDK's own crypto primitives.
//
// The rule the old flag carried is kept: a quote that cannot be verified is REFUSED. A missing field, a
// missing signature or an unusable domain is not "probably fine" - the caller names it with a code.
import { keccak256, secp256k1 } from "./primitives.mjs";
import {
  recoverQuoteKey as recover,
  quoteDigest as digest,
  quoteMissingFields,
  ORDER_QUOTE_FIELDS as FIELDS,
  ORDER_QUOTE_TYPE as TYPE,
  EIP712_DOMAIN_TYPE,
  ORDER_QUOTE_DOMAIN_NAME,
  ORDER_QUOTE_DOMAIN_VERSION,
  ORDER_QUOTE_VERSION,
} from "./quoteEip712Spec.mjs";

const crypto = { keccak256, secp256k1 };

export const ORDER_QUOTE_FIELDS = FIELDS;
export const ORDER_QUOTE_TYPE = TYPE;
export { EIP712_DOMAIN_TYPE, ORDER_QUOTE_DOMAIN_NAME, ORDER_QUOTE_DOMAIN_VERSION, ORDER_QUOTE_VERSION };

/** Names of the signed-set fields the quote does not carry. Not empty - the quote is not verifiable. */
export const orderQuoteMissingFields = (quote) => quoteMissingFields(quote);

/** The digest the provider signed, from the quote's own declared fields. */
export const orderQuoteDigest = (quote) => digest({ crypto, quote });

/** The address that signed the quote, or null when it cannot be recovered. */
export const recoverOrderQuoteKey = (quote) => recover({ crypto, quote });
