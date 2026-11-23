// DECLARATIONS FOR THE `./evm` ENTRY: factory calldata and the arithmetic of a claim.
//
// src/public/evm.mjs only NAMES what the engine already offers; these declarations NAME the same thing for a
// TypeScript consumer. Every signature is copied from the modules the barrel re-exports
// (`../../engine/evm/factory.js`, `../../engine/evm/claimGas.js`), and a symbol the barrel does not re-export is
// not declared here.

/** The factory's calldata selectors, computed from the contract's own signatures. */
export declare const FACTORY_METHODS: {
  readonly predict: string;
  readonly createOrderAndFund: string;
};

/** The factory getters read to check the single shared escrow implementation every clone runs. */
export declare const FACTORY_READS: {
  readonly implementation: string;
  readonly implementationCodeHash: string;
};

/** The OrderCreated event topic: the same value the contract declares. */
export declare const ORDER_CREATED_TOPIC: string;

/** The signed quote fields IN CONTRACT ORDER. The order is part of the ABI: a rearrangement is another call. */
export declare const QUOTE_FIELDS: readonly string[];

/**
 * Everything `predict` and `createOrderAndFund` encode: the signed quote, the provider's signature, and the three
 * depositor fields that travel as separate arguments (they go into the escrow's init code).
 */
export interface FactoryQuote {
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
  /** The tip `claim` pays to a third-party sender out of the payout; zero means none. */
  readonly claimTip: string | number | bigint;
  /** r || s || v over the quote digest, 65 bytes, with or without the `0x` prefix. */
  readonly signature: string;
  readonly commitHalfLocker: string;
  readonly edPointLocker: string;
  readonly edViewPointLocker: string;
}

/**
 * One calldata word: the value right-aligned to `bytes` (32 unless another width is asked for). Decimal digits are
 * turned into hex as a NUMBER, so padding cannot change the value. Refuses anything that is neither.
 */
export declare function word(value: string | number | bigint, bytes?: number): string;

/** The `predict` call: the argument set matches `encodeCreateOrderAndFund` byte for byte. */
export declare function encodePredict(quote: FactoryQuote): string;

/** The `createOrderAndFund` call: creation and deposit in one transaction. */
export declare function encodeCreateOrderAndFund(quote: FactoryQuote): string;

/** `predict()`'s answer - one address in a 32-byte word. */
export declare function decodeAddress(returnedHex: string): string;

/** `implementation()`'s answer. */
export declare function decodeImplementation(returnedHex: string): string;

/** `implementationCodeHash()`'s answer - one bytes32 word. */
export declare function decodeImplementationCodeHash(returnedHex: string): string;

/** The getter's calldata by name: it takes no arguments, so the selector is the whole call. */
export declare function encodeFactoryRead(name: "implementation" | "implementationCodeHash"): string;

/**
 * The verdict on the escrow implementation, by the same three conditions the factory applies at order creation:
 * the address is named and its code is non-empty, the recorded hash matches, and the hash is in the interface
 * policy if one is set. Refusals are named, never silent.
 */
export type FactoryImplementationVerdict =
  | {
      readonly ok: false;
      readonly why: string;
      readonly codeHash?: string;
      readonly got?: string;
      readonly want?: string;
    }
  | { readonly ok: true; readonly codeHash: string };

/**
 * What the verdict is read from. `code` is the implementation's on-chain code; `hashCode` recomputes it when the
 * carrier can hash bytes. An unreadable base is not zero: the reason names what was missing.
 */
export interface FactoryImplementationRequest {
  readonly implementation?: string;
  readonly implementationCodeHash?: string;
  readonly code?: string | null;
  readonly hashCode?: ((code: string) => string) | null;
  /** The interface's own list of known builds. An empty or absent list means "no policy". */
  readonly policy?: readonly string[] | null;
}

/** The verdict on the implementation, from the fields alone. */
export declare function verifyFactoryImplementation(request?: FactoryImplementationRequest): FactoryImplementationVerdict;

/**
 * The verdict read at the factory itself: `implementation()`/`implementationCodeHash()` and the code at the
 * implementation's address, then the same three conditions. The chain is injected - `read` is
 * `eth_call({to, data}) -> hex` and `code` is `eth_getCode(address) -> hex` - so the module performs no call of
 * its own. An unreadable pair or code is a named refusal, because an old factory without these getters reverts.
 */
export type FactoryImplementationOnChainVerdict =
  | {
      readonly ok: false;
      readonly why: string;
      readonly factory?: string;
      readonly implementation?: string;
      readonly codeHash?: string;
      readonly got?: string;
      readonly want?: string;
    }
  | { readonly ok: true; readonly codeHash: string; readonly implementation: string; readonly implementationCodeHash: string };

export interface FactoryImplementationOnChainRequest {
  readonly factory?: string;
  readonly read?: (request: { readonly to: string; readonly data: string }) => Promise<string>;
  readonly code?: (address: string) => Promise<string>;
  readonly policy?: readonly string[] | null;
  readonly hashCode?: ((code: string) => string) | null;
}

/** The pair read at the factory, with the same verdict the factory applies. */
export declare function verifyFactoryImplementationOnChain(
  request?: FactoryImplementationOnChainRequest,
): Promise<FactoryImplementationOnChainVerdict>;

/**
 * The claim gas limit, MEASURED on a live chain with a margin: an honest claim costs 120 721 gas. The same
 * number on both sides of the reverse swap.
 */
export declare const CLAIM_GAS_LIMIT: bigint;

/** The network's tip floor. Zero where the network needs no tip, which is policy and not a constant here. */
export declare const CLAIM_TIP_FLOOR_WEI: bigint;

/** Margin for base-fee growth between the ticket and the claim, in basis points, as a node setting. */
export declare const DEFAULT_GIFT_RESERVE_BPS: bigint;

/** The fee of a claim in EIP-1559 terms: `2 x baseFee + tip`, tip not below the floor. */
export interface ClaimMaxFeeRequest {
  readonly baseFeeWei?: string | number | bigint | null;
  readonly priorityFeeWei?: string | number | bigint | null;
  readonly minTipWei?: string | number | bigint | null;
}

/** `maxFeePerGas`, or null when the base fee is unreadable or zero (no fee fields is not a zero fee). */
export declare function claimMaxFeePerGasWei(request?: ClaimMaxFeeRequest): bigint | null;

/** What the balance needs for the claim. */
export interface ClaimRequiredRequest {
  readonly gasLimit?: string | number | bigint | null;
  readonly maxFeePerGasWei?: string | number | bigint | null;
}

/** `gasLimit x maxFeePerGas`, or null when either factor is unmeasured. */
export declare function claimRequiredWei(request?: ClaimRequiredRequest): bigint | null;

/** The gift the node sends to a claimer who holds no native coin. */
export interface ClaimGasGiftRequest {
  readonly baseFeeWei?: string | number | bigint | null;
  readonly priorityFeeWei?: string | number | bigint | null;
  readonly minTipWei?: string | number | bigint | null;
  readonly gasLimit?: string | number | bigint | null;
  readonly reserveBps?: string | number | bigint | null;
}

/** The claim cost the client requires, plus the reserve margin. The ONE computation of the gift size. */
export declare function claimGasGiftWei(request?: ClaimGasGiftRequest): bigint | null;

/** The contract's fee ceiling: 200 basis points (2%). */
export declare const MAX_FEE_BPS: number;

/** `floor(amount * bps / 10000)`, the contract's fee formula. A rate is a whole number from 0 to 200; an invalid or missing rate is refused. */
export declare function feeWeiFor(amountWei: string | number | bigint, feeBps: string | number | bigint): bigint;

/** The largest principal whose principal plus fee fits a buy's total. A rate is a whole number from 0 to 200; an invalid or missing rate is refused. */
export declare function principalForTotal(totalWei: string | number | bigint, feeBps: string | number | bigint): bigint;

export interface FeeTerms {
  readonly bps: number;
  readonly feeWei: bigint;
  readonly totalWei: bigint;
  readonly recipient: string | null;
  readonly feeOnTop: boolean;
  readonly legacy: false;
}

/** The signed quote's fee: rate, amount, recipient and direction, cross-checked against the formula. */
export declare function feeTermsFromQuote(quote: Readonly<Record<string, unknown>>): FeeTerms;

export interface SalePayoutBeforeClaimRequest {
  readonly amountWei: string | number | bigint;
  readonly feeWei: string | number | bigint;
  readonly claimTipWei?: string | number | bigint;
}

export interface SalePayoutBeforeClaim {
  readonly amountWei: bigint;
  readonly feeWei: bigint;
  readonly claimTipWei: bigint;
  /** `amount - fee - claimTip`, when another address sends the claim. */
  readonly guaranteedMinimumWei: bigint;
  /** `amount - fee`, when the seller sends the claim. */
  readonly sellerClaimWei: bigint;
}

/** The two labelled figures before the claim; null when the signed amounts do not add up. */
export declare function salePayoutBeforeClaim(request: SalePayoutBeforeClaimRequest): SalePayoutBeforeClaim | null;

export interface SalePayoutAfterClaimRequest extends SalePayoutBeforeClaimRequest {
  readonly claimed?: boolean;
  readonly claimSucceeded?: boolean;
  /** The contract's actual `msg.sender`, not `tx.from`. Takes precedence over the transaction fields. */
  readonly sender?: string | null;
  /** The claim transaction's `to`; used only when `sender` is absent. */
  readonly to?: string | null;
  /** The claim transaction's `from`; it is `msg.sender` only when `to` is `escrow`. */
  readonly from?: string | null;
  /** The escrow the claim targets. Required to trust `from` from a direct transaction. */
  readonly escrow?: string | null;
  readonly claimer?: string | null;
}

export interface SalePayoutAfterClaim {
  readonly outcome: "claimed" | "unknown";
  /** The seller's amount actually paid; null when the outcome is not determined. */
  readonly payoutWei: bigint | null;
}

/** The seller's payout after a claim, judged by the contract's `msg.sender`. */
export declare function salePayoutAfterClaim(request: SalePayoutAfterClaimRequest): SalePayoutAfterClaim;

/** The gas limit of `createOrderAndFund`, the funding deposit. */
export declare const GAS_CREATE_ORDER_AND_FUND: bigint;

export declare const ORDER_READY_GAS_LIMIT: bigint;
export declare const ORDER_REFUND_GAS_LIMIT: bigint;
export declare const ORDER_GAS_LIMIT: bigint;
export declare const ORDER_DEPOSIT_GAS_LIMIT: bigint;

/** What the mark and possible refund reserve; the deposit is opt-in through `depositGasLimit`. */
export interface OrderGasReserveRequest {
  readonly gasPriceWei?: string | number | bigint | null;
  readonly readyGasLimit?: string | number | bigint | null;
  readonly refundGasLimit?: string | number | bigint | null;
  readonly depositGasLimit?: string | number | bigint | null;
  readonly extraFeeWei?: string | number | bigint | null;
}

export declare function orderGasReserveWei(request?: OrderGasReserveRequest): bigint | null;

/** The funding deposit's reserve: its gas limit times the maximum fee per gas. */
export interface FundingGasReserveRequest {
  readonly gasLimit?: string | number | bigint | null;
  readonly maxFeePerGasWei?: string | number | bigint | null;
}

export declare function fundingGasReserveWei(request?: FundingGasReserveRequest): bigint | null;
