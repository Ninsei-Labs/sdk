// DECLARATIONS FOR THE `./xmr` ENTRY: the Monero side for a consumer that is not the browser.
//
// src/public/xmr.mjs only NAMES what the engine already offers; these declarations NAME the same thing for a
// TypeScript consumer. Every signature is copied from the modules the barrel re-exports
// (`../../engine/monero/address.js`, `../../engine/atomic/halves.js`, `../../engine/atomic/dleq2.js`,
// `../../engine/monero/halvesSweep.js`, `../../engine/core/sellWindow.js`), and a symbol the barrel does not
// re-export is not declared here.
//
// THE PRIMITIVES ARE HANDED IN, NOT IMPORTED. These modules pull no dependencies of their own: the curve and hash
// libraries arrive as arguments, so the types below describe the MEMBERS THE ENGINE CALLS. A real
// `@noble/curves`/`@noble/hashes` object satisfies them.

/** The Monero networks this package can build an address for, and check one against. */
export type MoneroNetwork = "mainnet" | "stagenet" | "testnet";

/** The three shapes of a Monero address. */
export type MoneroAddressKind = "primary" | "integrated" | "subaddress";

/**
 * Network and kind -> prefix byte, the reverse table an address is assembled from.
 *
 * `fakechain` (monerod's own name for regtest) is deliberately absent: the withdrawal page picks that network up
 * from the node, and there is no prefix byte to build an address with.
 */
export declare const PREFIX_BY_NETWORK: Readonly<Record<MoneroNetwork, Readonly<Record<MoneroAddressKind, number>>>>;

/** The prefix byte of one network and kind. An unknown network or kind is refused, not guessed. */
export declare function prefixFor(network: MoneroNetwork, kind?: MoneroAddressKind): number;

/**
 * The quick SHAPE check: base58 alphabet, 95 (plain) or 106 (integrated) characters, and a first letter that
 * belongs to a Monero prefix. It does NOT verify the checksum - any typo inside passes here. The real check is
 * `checkAddress`; this one only screens out obvious garbage before the heavy decode.
 */
export declare function formatCheck(addr: string | null | undefined): boolean;

/** The network an address's first letter names, or null when the shape is not a Monero address at all. */
export declare function networkFromShape(addr: string | null | undefined): MoneroNetwork | null;

/** Whether the address is shaped as a stagenet one. */
export declare function isStagenetShaped(addr: string | null | undefined): boolean;

/**
 * Block-based Monero base58: a block is a NUMBER, full 8-byte blocks come first (11 characters each) and the
 * partial remainder goes LAST, so this is not bitcoin-base58 and `bs58` does not fit.
 */
export declare function decodeMoneroBase58(str: string): Uint8Array;

/** The inverse of `decodeMoneroBase58`: bytes to a Monero base58 string. */
export declare function encodeMoneroBase58(bytes: Uint8Array | readonly number[]): string;

/** The address payload without its checksum: prefix + public spend + public view [+ payment id]. */
export interface AddressPayloadRequest {
  readonly network: MoneroNetwork;
  readonly kind?: MoneroAddressKind;
  /** The 32-byte public spend key, hex. */
  readonly spendPub: string;
  /** The 32-byte public view key, hex. */
  readonly viewPub: string;
  /** The 8-byte payment id, hex: required for `kind: "integrated"`. */
  readonly paymentId?: string;
}

/** The address payload: prefix, both public keys, and the payment id when the address is integrated. */
export declare function addressPayload(request: AddressPayloadRequest): Uint8Array;

/** keccak256 over bytes. The address checksum is its first four bytes, as in Monero itself. */
export type Keccak256Bytes = (bytes: Uint8Array) => Uint8Array;

/** What assembling an address needs: keccak256, and a Buffer shim for implementations taking only their own. */
export interface AddressKeysDeps {
  readonly keccak256: Keccak256Bytes;
  readonly Buffer?: { readonly from: (bytes: Uint8Array) => Uint8Array };
}

/** The address string built from public keys, with the checksum appended. */
export declare function addressFromKeys(request: AddressPayloadRequest, deps: AddressKeysDeps): string;

/**
 * The full check: format, block decode, keccak256 checksum and network.
 *
 * `verified` says whether the checksum could be verified at all: without the Monero bundle the answer is
 * `ok: true, verified: false` with the reason named, never a false "checked". A refusal always names WHY.
 */
export type AddressCheck =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly verified: false; readonly network: MoneroNetwork | null; readonly reason: string }
  | { readonly ok: true; readonly verified: true; readonly network: MoneroNetwork; readonly kind: MoneroAddressKind; readonly bytes: number };

/** The full check of one address. Refuses an address of another network when `expectNetwork` names one. */
export declare function checkAddress(addr: string, options?: { readonly expectNetwork?: MoneroNetwork }): Promise<AddressCheck>;

/** An address of the right network, built from the wallet's own keys. Needs the Monero bundle for keccak256. */
export declare function addressForNetwork(request: AddressPayloadRequest): Promise<string>;

/** A curve point, as the halves and the DLEQ modules call it. */
export interface CurvePoint {
  readonly multiply: (scalar: bigint) => CurvePoint;
  readonly add: (other: CurvePoint) => CurvePoint;
  readonly toHex: () => string;
}

/** The curve members the halves module calls. */
export interface CurvePrimitive {
  readonly Point: {
    readonly BASE: CurvePoint;
    /** The group order: the smaller of the two is the limit a half must fit into. */
    readonly Fn: { readonly ORDER: bigint };
    readonly fromHex: (hex: string) => CurvePoint;
  };
}

/** The five primitives the halves module is handed. */
export interface HalvesPrimitives {
  readonly ed25519: CurvePrimitive;
  readonly secp256k1: CurvePrimitive;
  readonly keccak256: Keccak256Bytes;
  readonly randomBytes: (length: number) => Uint8Array;
}

/** The halves module: one half of a key per side, public on both curves. */
export interface Halves {
  /** The smaller of the two group orders: a half must fit into both groups. */
  readonly LIMIT: bigint;
  readonly ED_ORDER: bigint;
  readonly SECP_ORDER: bigint;
  /** The domain strings of the spend half and the view half: quoting and payout take them from here. */
  readonly HALF_DOMAIN: string;
  readonly VIEW_HALF_DOMAIN: string;
  /** A uniform scalar below the limit, drawn by rejection sampling. */
  readonly newHalf: () => bigint;
  /**
   * The half derived from a secret and the order binding, so the same order always gives the same half and only
   * the secret holder can compute it.
   */
  readonly halfFromSeed: (seedBytes: Uint8Array, binding: string | number | bigint, domain?: string) => bigint;
  /** The public halves on both curves. */
  readonly publicHalves: (half: bigint | string | number) => { readonly ed: string; readonly secp: string };
  /** The sum of two halves, privately. */
  readonly combineHalves: (a: bigint | string | number, b: bigint | string | number) => bigint;
  /** The sum of two halves, publicly (point addition). */
  readonly combinePublic: (edHexA: string, edHexB: string) => string;
}

/** Creates the halves module from the five primitives. Each one is required, and its absence is named. */
export declare function createHalves(primitives: HalvesPrimitives): Halves;

/** A curve point, as the DLEQ module calls it. */
export interface Dleq2Point {
  readonly multiply: (scalar: bigint) => Dleq2Point;
  readonly add: (other: Dleq2Point) => Dleq2Point;
  readonly subtract: (other: Dleq2Point) => Dleq2Point;
  readonly equals: (other: Dleq2Point) => boolean;
  readonly toHex: () => string;
  /** True when the point is in the prime-order subgroup (`[l]*P = 0`), not merely free of a small component. */
  readonly isTorsionFree: () => boolean;
  /** Builds the multiplication table of the given window size at the first multiplication. */
  readonly precompute: (windowSize: number) => void;
}

/** The curve members the DLEQ module calls. */
export interface Dleq2CurvePrimitive {
  readonly Point: {
    readonly BASE: Dleq2Point;
    readonly Fn: { readonly ORDER: bigint };
    readonly fromHex: (hex: string) => Dleq2Point;
  };
}

/** The primitives the DLEQ module is handed. SHA3-512 is mandatory: the challenge is its wide reduction. */
export interface Dleq2Primitives {
  readonly ed25519: Dleq2CurvePrimitive;
  readonly secp256k1: Dleq2CurvePrimitive;
  readonly keccak256: Keccak256Bytes;
  /** SHA3-512, NOT keccak256: the challenge is a 64-byte hash read least-significant byte first. */
  readonly sha3_512: (bytes: Uint8Array) => Uint8Array;
  readonly randomBytes: (length: number) => Uint8Array;
}

/** The OR proof of one bit on both curves. Scalars and points travel as hex, so the proof survives JSON. */
export interface Dleq2Signature {
  readonly eA: string;
  readonly eB: string;
  readonly a0: string;
  readonly a1: string;
  readonly b0: string;
  readonly b1: string;
}

/** The proof of one bit: the bit's commitments on both curves and the ring signature over them. */
export interface Dleq2ProofPart {
  readonly cA: string;
  readonly cB: string;
  readonly sig: Dleq2Signature;
}

/** The proof: the point X on both curves, and one part per bit of the smaller group order. */
export interface Dleq2Proof {
  readonly XA: string;
  readonly XB: string;
  readonly proofs: readonly Dleq2ProofPart[];
}

/** One bit prepared for proving: the bit, its commitments and its randomness. The half is NOT here. */
export interface Dleq2PreparedBit {
  readonly i: number;
  readonly bit: 0 | 1;
  readonly cA: string;
  readonly cB: string;
  readonly rA: string;
  readonly rB: string;
}

/** Step 1's output: the points and one prepared bit per bit. Depends on the running sum, so it is one piece. */
export interface Dleq2Prepared {
  readonly XA: string;
  readonly XB: string;
  readonly context: string;
  readonly bits: readonly Dleq2PreparedBit[];
}

/** The verifier's answer. A refusal NAMES the bit and the reason; it never throws. */
export interface Dleq2Verdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/** One of the two curves the module holds, with the alternate base point its ring signature uses. */
export interface Dleq2Curve {
  readonly name: string;
  readonly P: Dleq2CurvePrimitive["Point"];
  readonly order: bigint;
  readonly G: Dleq2Point;
  readonly Galt: Dleq2Point;
}

/** The DLEQ module: proving is assembled from three steps, and the steps can be run apart. */
export interface Dleq2 {
  /** The bit length of the smaller order: the number of proof parts an honest proof carries. */
  readonly BITS: number;
  readonly curves: { readonly A: Dleq2Curve; readonly B: Dleq2Curve };
  /** The whole proof. `onBit` reports progress every 16 bits and at the last. */
  readonly prove: (x: bigint | string | number, context: string, onBit?: (done: number, total: number) => void) => Dleq2Proof;
  /** Verifies a proof of untrusted shape: form is checked before counting, and every refusal is named. */
  readonly verify: (proof: unknown, context: string) => Dleq2Verdict;
  /** Step 1: the commitments. Sequential by construction. */
  readonly prepareProof: (x: bigint | string | number, context: string) => Dleq2Prepared;
  /** Step 2: one bit, on the prepared data alone - it needs neither the half nor the other bits. */
  readonly proveBit: (part: Dleq2PreparedBit, context: string) => Dleq2ProofPart;
  /** Step 3: the parts are put in bit order, and a missing bit is refused. */
  readonly assembleProof: (prepared: Dleq2Prepared, parts: readonly Dleq2ProofPart[]) => Dleq2Proof;
  /** The strict subgroup check. secp256k1 has cofactor 1 and passes without a check. */
  readonly torsionFree: (curve: Dleq2Curve, point: Dleq2Point) => boolean;
}

/** Creates the DLEQ module from the five primitives. Without SHA3-512 it refuses immediately. */
export declare function createDleq2(primitives: Dleq2Primitives): Dleq2;

/**
 * What sweeping from a revealed half is handed: the half maths, this side's two halves as the file carries them,
 * the counterparty's public spend key and view half, and the half the counterparty revealed.
 */
export interface SpendKeysFromRevealedHalfRequest {
  readonly halves: Halves;
  /** This side's spend half, from the file: it arrives as a string and is converted before any arithmetic. */
  readonly ownSpendHalf: string | number | bigint;
  /** This side's view half, from the file. */
  readonly ownViewHalf: string | number | bigint;
  /** The counterparty's public spend key, hex: the point the order carried. */
  readonly otherSpendPoint: string;
  /** The counterparty's view half, hex. */
  readonly otherViewHalf: string | number | bigint;
  /** The revealed half, hex. */
  readonly revealedHalf: string | number | bigint;
}

/** The two private keys a sweep writes with, in Monero notation: 64 hex, least significant byte first. */
export interface SpendKeys {
  readonly privateSpendKey: string;
  readonly privateViewKey: string;
}

/**
 * The spend and view keys a revealed half yields, or a THROW when the half does not belong to this order.
 *
 * The commitment only proves that the HASH of the revealed half matched the order, and ed25519 does not exist in
 * the EVM, so the check that `(s_a + s_b)*G` equals the order's public spend key happens HERE, before any
 * synchronisation: a half from another order, or a substituted one, yields no keys.
 */
export declare function spendKeysFromRevealedHalf(request: SpendKeysFromRevealedHalfRequest): SpendKeys;

/**
 * A Monero-notation key read as a number: 64 hex, least significant byte first. A key that is not in that notation
 * is refused rather than reinterpreted - `BigInt("0x" + key)` silently reverses the byte order and gives another
 * scalar.
 */
export declare function scalarFromMoneroHex(hex: string): bigint;

/**
 * The XMR sell window: the SOFT on-screen promise (how long the provider holds the price) and the HARD contract
 * window, which goes into the order binding and can never be shorter than the contract's own.
 */
export declare const SELL_WINDOW: {
  /** The provider's on-screen promise, in seconds. */
  readonly softSec: number;
  /** The contract readiness window, in seconds: ten Monero confirmations, and the maximum that goes on chain. */
  readonly hardSec: number;
};

/**
 * How long the sell window lasts, given the named pool state: while the FULL expected amount is not visible in
 * the pool the promise is extended to the contract maximum, and the contract window is a CEILING on it.
 */
export declare function sellWindowSec(request?: {
  readonly poolSeen?: boolean;
  readonly soft?: number;
  readonly hard?: number;
}): number;

/**
 * WHAT NETWORK A NODE SAYS IT IS ON, from its `get_info` answer. The wallet must be built from this value: a
 * mainnet wallet against a stagenet node looks like a broken withdrawal. An answer that is none of `mainnet`,
 * `stagenet`, `testnet` comes back as null - a default would build a wallet for a chain the node may not serve.
 */
export declare function networkFromNode(info: unknown): "mainnet" | "stagenet" | "testnet" | "fakechain" | null;

/** An address read as its network and its public keys. An integrated address's payment id is not returned. */
export interface AddressKeys {
  readonly network: "mainnet" | "stagenet" | "testnet" | null;
  /** The first payload byte, kept for callers that meet a prefix the table does not know. */
  readonly netByte: number;
  readonly spendPub: string;
  readonly viewPub: string;
}

/** AN ADDRESS -> ITS NETWORK AND PUBLIC KEYS. Throws when the text is not a Monero address. */
export declare function decodeAddressKeys(address: string): AddressKeys;

/** A SCALAR AS LITTLE-ENDIAN HEX, low byte first - the form the daemon expects. */
export declare function scalarToLeHex(scalar: bigint | number | string, bytes?: number): string;

/**
 * WHETHER A VIEW KEY IS THE ONE THE ADDRESS NAMES: true / false, or null when there is no public key to compare.
 * `halves` is what `createHalves` returns, so the comparison uses the same arithmetic as the address build.
 */
export declare function viewKeyMatchesAddress(
  viewScalar: bigint | number | string,
  expectedViewPubHex: string,
  halves: { publicHalves(scalar: bigint | number | string): { ed: string } },
): boolean | null;

/** A boundary up to this value is a block height; from it on, a unix time. */
export declare const UNLOCK_TIME_BLOCK_MAX: number;

export interface UnlockState {
  readonly code: "unlocked" | "locked_height" | "locked_time";
  readonly locked: boolean;
  readonly untilHeight: number | null;
  readonly untilTime: number | null;
}

/**
 * WHETHER A COIN IS SPENDABLE. A height that is unknown does not open the coin: without the height there is no
 * fact that would. `nowSec` defaults to the wall clock.
 */
export declare function unlockStateOf(
  unlockTime: number | bigint | string,
  options?: { height?: number | null; nowSec?: number | null },
): UnlockState;

/** The names that count as loopback: 127.0.0.1, ::1, localhost - not all of 127.0.0.0/8. */
export declare const LOOPBACK_HOSTS: ReadonlySet<string>;
export declare function isLoopbackHost(host: string): boolean;

/** An address read as scheme and host, or null when the text is not a URL. */
export declare function hostOfUrl(url: string): { scheme: string; host: string } | null;

export type DaemonCode = "daemon-not-https" | "daemon-address-unreadable" | "daemon-scheme-unknown";
export declare const DAEMON_CODES: Readonly<{ notHttps: DaemonCode; unreadable: DaemonCode; schemeUnknown: DaemonCode }>;
export declare const DAEMON_PLAIN_HTTP_NETWORKS: readonly string[];
export declare const DAEMON_NETWORK_MAINNET: string;

/** A setting in one shape: 0/false/no/off switches it off; anything else, a typo included, leaves it on. */
export declare function plainLoopbackAllowed(raw: unknown): boolean;

export interface DaemonAddressJudgement {
  readonly ok: boolean;
  /** False for an empty value: nothing to judge, not a refusal. */
  readonly configured: boolean;
  readonly scheme: string | null;
  readonly host: string | null;
  readonly loopback: boolean;
  readonly plainLoopbackAllowed: boolean;
  /** True when a remote plain-http daemon was accepted because the network is stagenet or testnet. */
  readonly plainHttpAccepted: boolean;
  readonly network: string;
  readonly code: DaemonCode | null;
  readonly reason: string | null;
}

/**
 * MAY THIS DAEMON ADDRESS BE USED. https anywhere; http on loopback; http to a remote host only on stagenet and
 * testnet. An unknown network is judged as mainnet.
 */
export declare function judgeDaemonAddress(
  raw: string | null | undefined,
  options?: { network?: string; allowPlainLoopback?: boolean },
): DaemonAddressJudgement;

/** A per-byte price -> the fee for a transaction of `bytes`/weight. Exact integer multiplication. */
export declare function feeForBytes(feePerByte: bigint | number | string, bytes: bigint | number | string): string;

export interface FeeEstimateOk {
  readonly ok: true;
  readonly url: string;
  /** The price per byte for the next block, in atomic units, or null when the daemon did not send it. */
  readonly feePerByte: string | null;
  /** The daemon's own priority list, per byte and in its order, or null. */
  readonly perPriority: readonly string[] | null;
  /** The unit the final fee is rounded to, or null when the daemon did not send it. */
  readonly quantizationMask: string | null;
}

export interface FeeEstimateRefusal {
  readonly ok: false;
  /** no-url | no-fetch | timeout | unreachable | http | not-json | rpc | no-estimate */
  readonly why: string;
  readonly status?: number | null;
  readonly rpc?: number | null;
}

/**
 * ASK A NODE WHAT A TRANSACTION WILL COST (`get_fee_estimate`). The exact sum needs the assembled transaction, so
 * this is a price per byte; `feeForBytes` is the only arithmetic that turns it into a fee. Never throws.
 */
export declare function moneroFeeEstimate(options: {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<FeeEstimateOk | FeeEstimateRefusal>;

/** The answer to a preflight: usable, or the named reason it is not. */
export interface NodeProbeOk {
  readonly ok: true;
  readonly url: string;
  readonly height: number;
  readonly network: "mainnet" | "stagenet" | "testnet";
  readonly nettype: string | null;
  readonly synchronized: boolean;
  readonly version: string | null;
  readonly status: string | null;
  readonly ms: number;
}

export interface NodeProbeRefusal {
  readonly ok: false;
  /** no-url | no-fetch | timeout | unreachable | http | not-json | rpc | no-height | nettype */
  readonly why: string;
  readonly status?: number | null;
  readonly nettype?: string | null;
  readonly rpc?: number | null;
  readonly ms?: number;
}

/**
 * ASK A NODE FOR `get_info`: the height, the network it names, whether it is synchronized. Never throws - the
 * answer names the problem (`unreachable`, `timeout`, `nettype`, ...). `fetchImpl` is injected so a Node consumer
 * or a test can pass its own; `timeoutMs` abandons the request (8 seconds by default).
 */
export declare function probeMoneroNode(options: {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<NodeProbeOk | NodeProbeRefusal>;

/** The watch key form that matches the address's view public key, or null when none does. */
export declare function viewKeyFormForAddress(viewSecret: string, expectedViewPubHex: string): string | null;

/** A boundary height derived from a later unlock_time, or null when the time names no height. */
export declare function laterBoundary(...args: unknown[]): unknown;

/** One transaction that carries an output for a watched address. */
export interface ScannedMatch {
  [field: string]: unknown;
}

/** A range scan's answer: the per-address totals and whether every block was read. */
export interface ScanRangeResult {
  readonly fromHeight: number;
  readonly toHeight: number;
  readonly results: ScannedMatch[];
  /** False when at least one block or its transactions could not be read. */
  readonly complete: boolean;
  /** The heights that failed; empty when `complete` is true. */
  readonly missingHeights: number[];
  /** `blocks-unreadable` when `complete` is false. */
  readonly incompleteReason?: "blocks-unreadable";
}

/** Walk a block range and return the transactions that pay a watched address. */
export declare function scanRange(options: {
  daemonUrl: string;
  fromHeight: number;
  toHeight: number;
  watched: unknown;
  log?: (event: unknown) => void;
  concurrency?: number;
  nowSec?: number | null;
  /** The chain tip used to judge a height lock; defaults to `toHeight`. Inclusion height still drives confirmations. */
  tipHeight?: number | null;
  /** The fetch used for the daemon requests; absent - the global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<ScanRangeResult>;
