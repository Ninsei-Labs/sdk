export declare const RELAY_FEATURES_TYPE_NAME: "NodeFeatures";
export declare const RELAY_DOMAIN_NAME: "Ninsei Relay";
export declare const RELAY_DOMAIN_VERSION: "1";
export declare const FIRM_WINDOW_TYPE: string;
export declare const NODE_FEATURES_TYPE: string;
export declare const FIRM_WINDOW_FIELDS: ReadonlyArray<readonly [string, string]>;
export declare const NODE_FEATURES_FIELDS: ReadonlyArray<readonly [string, string]>;

export interface RelayFirmWindow {
  market: string;
  side: "ask" | "bid";
  xmrNetwork: string;
  readyMinSeconds: number;
  readyMaxSeconds: number;
  settlementMinSeconds: number;
  settlementMaxSeconds: number;
  quoteTtlSeconds: number;
}

export interface RelayNodeFeatures {
  type: "node_features";
  version: 1;
  relayId: string;
  provider: string;
  quoteKey: string;
  registry: string;
  capabilities: string[];
  hpkeKey: string;
  firmWindows: RelayFirmWindow[];
  time: number;
  nonce: string;
  signature: string;
}

export interface RelayVerifyTerms {
  market: string;
  side: "ask" | "bid";
  maker: string;
  registry: string;
  xmrNetwork: string;
}

export declare function nodeFeaturesStructHash(features: RelayNodeFeatures): Uint8Array;
export declare function nodeFeaturesDomainSeparator(): Uint8Array;
export declare function nodeFeaturesDigest(features: RelayNodeFeatures): Uint8Array;
export declare function verifyNodeFeatures(input: { features: RelayNodeFeatures; terms?: RelayVerifyTerms | null }): {
  featuresHash: string;
  hpkeKey: string;
  window: RelayFirmWindow | null;
};
export declare function nodeFeaturesMissingFields(features: Partial<RelayNodeFeatures>): string[];

export declare function firmTermsDigest(input: { crypto: { keccak256(bytes: Uint8Array): Uint8Array }; terms: Record<string, unknown> }): Uint8Array;
export declare function firmTermsMissingFields(terms: Record<string, unknown>): string[];

export declare const RELAY_VIEW_INFO_PREFIX: string;
export declare function relayViewInfo(input: {
  termsDigest: string;
  commitHalf: string;
  edPoint: string;
  edViewPointClient: string;
  edViewPointNode: string;
}): Uint8Array;
export declare function sealViewEnvelope(input: { hpkeKey: string; info: Uint8Array; plaintext: Uint8Array }): Promise<{ enc: string; ciphertext: string }>;
export declare function openViewEnvelope(input: { privateKey: string; enc: string; ciphertext: string; info: Uint8Array }): Promise<Uint8Array>;

export declare const RELAY_QUOTE_TYPE: string;
export declare function relayQuoteStructHash(answer: Record<string, unknown>): Uint8Array;
export declare function relayQuoteDomainSeparator(): Uint8Array;
export declare function relayQuoteDigest(answer: Record<string, unknown>): Uint8Array;
export declare function verifyRelayQuoteFrame(answer: Record<string, unknown>, quoteKey: string): Record<string, unknown>;
export declare function verifyFirmAnswer(input: {
  answer: Record<string, unknown>;
  features: RelayNodeFeatures;
  request: { terms: Record<string, unknown>; edViewPointClient: string; edViewPointNode: string };
  now?: number | null;
}): Record<string, unknown>;
