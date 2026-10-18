// DECLARATIONS FOR THE `./order` ENTRY: what a signature commits to, and the quote types it commits under.
//
// src/public/order.mjs only NAMES what the engine already offers; these declarations NAME the same thing for a
// TypeScript consumer. Every signature is copied from the modules the barrel re-exports
// (`../../engine/atomic/orderContext.js`, `../../engine/atomic/orderHalfCommit.js`,
// `../quoteEip712Spec.mjs`), and a symbol the barrel does not re-export is not declared here.

/** The order conditions a context is built from. Numbers may be decimal text, hex text or a bigint: one order. */
export interface OrderContextFields {
  /** The network: the same order on another network is another order. */
  readonly chainId: string | number | bigint;
  /** The factory that creates the escrow. */
  readonly factory: string;
  /** The address that deposits the settlement coin. */
  readonly locker: string;
  /** The address the contract pays. */
  readonly claimer: string;
  /** The amount in wei. */
  readonly amount: string | number | bigint;
  /** The readiness deadline. */
  readonly readyBy: string | number | bigint;
  /** The settlement deadline. */
  readonly t1: string | number | bigint;
  /** The order salt. */
  readonly salt: string | number | bigint;
}

/**
 * The prefix that separates the order context from any other signature or proof, and the version of its field
 * set. It moves only together with that set, so a proof made under an older prefix never verifies under this one.
 */
export declare const ORDER_CONTEXT_VERSION: string;

/**
 * The canonical context string the DLEQ proof binds to, built from the order fields alone and identically in
 * every implementation, so the proof can be checked from the on-chain order.
 *
 * Refuses (throws) an object without the fields: a partial set is not a context.
 */
export declare function orderContextString(order: OrderContextFields): string;

/** The secp256k1 members the half commitment calls: the base point and its uncompressed encoding. */
export interface Secp256k1BasePoint {
  readonly multiply: (scalar: bigint) => { readonly toBytes: (isCompressed: boolean) => Uint8Array };
}

/** The secp256k1 primitive, as the engine and the SDK's own `primitives` module hand it in. */
export interface Secp256k1Primitive {
  readonly Point: { readonly BASE: Secp256k1BasePoint };
}

/** keccak256 over bytes - the same function Solidity's `keccak256` computes. */
export type Keccak256 = (bytes: Uint8Array) => Uint8Array;

/**
 * The commitment to a half: `keccak256(x || y)` of the secp256k1 point `half*G`, taken UNCOMPRESSED (64 bytes,
 * big-byte-first, like Ethereum key coordinates). The chain compares the presented half against the POINT behind
 * this hash, not against a hash of the number, so this formula must match everywhere it is computed.
 */
export declare function halfCommitmentHex(
  half: bigint | string | number,
  secp256k1: Secp256k1Primitive,
  keccak256: Keccak256,
): string;

/**
 * The crypto the quote spec is bound to. The spec signs nothing itself: it is handed keccak256 and secp256k1 -
 * the same two the SDK's `primitives` module exports.
 */
export interface QuoteCrypto {
  readonly keccak256: (bytes: Uint8Array) => Uint8Array;
  readonly secp256k1: {
    /** A signature over the digest, `format: "recovered"`, as 65 bytes [recovery, r, s]. */
    readonly sign: (
      message: Uint8Array,
      privateKey: Uint8Array,
      options?: { readonly format?: string; readonly prehash?: boolean },
    ) => Uint8Array;
    readonly Signature: {
      readonly fromBytes: (bytes: Uint8Array) => {
        readonly addRecoveryBit: (bit: number) => {
          readonly recoverPublicKey: (message: Uint8Array) => { readonly toBytes: (isCompressed: boolean) => Uint8Array };
        };
      };
    };
  };
}

/**
 * A signed quote: the fields the provider's signature covers, the factory the EIP-712 domain names, and the
 * signature itself. Field names and values are the protocol's; a missing field is refused, never read as zero.
 */
export interface OrderQuote {
  readonly provider: string;
  readonly quoteKey: string;
  readonly registry: string;
  readonly cashier: string;
  readonly locker: string;
  readonly claimer: string;
  readonly amount: string | number | bigint;
  readonly readyBy: string | number | bigint;
  readonly t1: string | number | bigint;
  readonly salt: string;
  readonly commitHalfClaimer: string;
  readonly edPointClaimer: string;
  readonly chainId: string | number | bigint;
  readonly feeBps: string | number | bigint;
  readonly fee: string | number | bigint;
  readonly feeRecipient: string;
  readonly validUntil: string | number | bigint;
  readonly nonce: string | number | bigint;
  readonly xmrAmount: string | number | bigint;
  /** The escrow factory the domain names as `verifyingContract`. */
  readonly factory: string;
  /** r || s || v over the digest, 65 bytes, with or without the `0x` prefix; v is normalised to 27/28. */
  readonly signature: string;
}

/** The EIP-712 domain type string, assembled from its parts. */
export declare const EIP712_DOMAIN_TYPE: string;

/** The domain name and its version string: the domain's identity, not the message shape. */
export declare const ORDER_QUOTE_DOMAIN_NAME: string;
export declare const ORDER_QUOTE_DOMAIN_VERSION: string;

/** The request-shape generation label. It moves WITH the signed field set; the domain identity does not. */
export declare const ORDER_QUOTE_VERSION: number;

/** `[name, type]` pairs IN CONTRACT ORDER. The order is the protocol: a rearrangement moves every digest. */
export declare const ORDER_QUOTE_FIELDS: readonly (readonly [string, string])[];

/** The message type string, assembled from `ORDER_QUOTE_FIELDS`. */
export declare const ORDER_QUOTE_TYPE: string;

/**
 * Names of the signed-set fields (`factory` and `signature` included) the quote does not carry. A non-empty
 * answer means the quote is not verifiable at all.
 */
export declare function quoteMissingFields(quote: Partial<OrderQuote> | null | undefined): string[];

/** The EIP-712 domain separator, with `chainId` and the factory taken live from the quote. */
export declare function quoteDomainSeparator(request: { readonly crypto: QuoteCrypto; readonly quote: OrderQuote }): Uint8Array;

/** The hash of the message struct. */
export declare function quoteStructHash(request: { readonly crypto: QuoteCrypto; readonly quote: OrderQuote }): Uint8Array;

/** The digest the provider's key signs: `0x1901` || domain separator || struct hash. */
export declare function quoteDigest(request: { readonly crypto: QuoteCrypto; readonly quote: OrderQuote }): Uint8Array;

/** The signature on the wire: r || s || v with v in {27, 28}, `0x`-prefixed. */
export declare function signQuoteDigest(request: {
  readonly crypto: QuoteCrypto;
  readonly digest: Uint8Array;
  readonly privateKey: string;
}): string;

/**
 * The address that signed the quote, recovered without knowing it beforehand, or null when the quote cannot be
 * verified at all. Null is a refusal for the caller to name, never consent.
 */
export declare function recoverQuoteKey(request: { readonly crypto: QuoteCrypto; readonly quote: OrderQuote }): string | null;

/**
 * Names of the signed-set fields the quote does not carry, bound to the SDK's own primitives: the same answer as
 * `quoteMissingFields`, offered so a verifier does not have to pass crypto it already trusts twice.
 */
export declare function orderQuoteMissingFields(quote: Partial<OrderQuote> | null | undefined): string[];

/**
 * The address that signed the quote, recovered with the SDK's own primitives, or null when the quote cannot be
 * verified at all. Null is a refusal for the caller to name, never consent.
 */
export declare function recoverOrderQuoteKey(quote: OrderQuote): string | null;
