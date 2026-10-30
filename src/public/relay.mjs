// THE RELAY EXCHANGE FOR A NODE THAT EMBEDS THE SDK.
//
// A maker needs the other half of the same rules a client uses: the public features digest it signs, the terms
// digest, the HPKE view envelope it opens, and the answer verifier. Names only; no second implementation.

export {
  RELAY_FEATURES_TYPE_NAME,
  RELAY_DOMAIN_NAME,
  RELAY_DOMAIN_VERSION,
  FIRM_WINDOW_TYPE,
  NODE_FEATURES_TYPE,
  FIRM_WINDOW_FIELDS,
  NODE_FEATURES_FIELDS,
  nodeFeaturesStructHash,
  nodeFeaturesDomainSeparator,
  nodeFeaturesDigest,
  verifyNodeFeatures,
  nodeFeaturesMissingFields,
} from "../relayFeatures.mjs";

export { firmTermsDigest, firmTermsMissingFields } from "../relayTerms.mjs";

export {
  RELAY_VIEW_INFO_PREFIX,
  relayViewInfo,
  sealViewEnvelope,
  openViewEnvelope,
} from "../relayView.mjs";

export {
  RELAY_QUOTE_TYPE,
  relayQuoteStructHash,
  relayQuoteDomainSeparator,
  relayQuoteDigest,
  verifyRelayQuoteFrame,
  verifyFirmAnswer,
} from "../relayQuote.mjs";
