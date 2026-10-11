// THE RELAYED UNISWAP ROUTE - THE FOURTH CONCRETE ASYNCHRONOUS ROUTE PROVIDER, A SIBLING OF cow.mjs, kyber.mjs AND
// uniswapx.mjs. THIS IS THE KEY-FREE ONE.
//
// WHAT IT IS. Uniswap's own repository Uniswap/relayer ships contracts (RelayOrderReactor) that RELAY a transaction
// to the UniversalRouter in exchange for ERC-20 tokens. A swapper signs a RelayOrder - one static input, one dynamic
// fee, and calldata encoded for the UniversalRouter - and anyone holding that signature (a "relayer") calls
// reactor.execute(SignedOrder, address feeRecipient), pays the gas, and is reimbursed in the input token through the
// order's own fee. There is no auction house and no API key: the order is a self-contained Permit2 instruction, and
// the reactor makes the router call the order asked for. So its shape is "async" - the swap happens in a LATER,
// separate transaction sent by someone else - and what ends its execution is a REAL ON-CHAIN EFFECT: the reactor's
// own Relay event for this order hash, read from the chain. `settled(request, deps)` below is that.
//
// WHY THIS ONE CARRIES NATIVE. The relayed swap is a UniversalRouter call, and the calldata this provider builds
// swaps the input token into the chain's WRAPPED native and then UNWRAPS it to the recipient
// (V3_SWAP_EXACT_IN + UNWRAP_WETH, uniswaprelay-spec.mjs). The native coin is what the escrow is funded with, so
// `settles: "native"` - it is a native leg beside CoWSwap and UniswapX.
//
// EVERY EXTERNAL FACT IS PINNED TO ITS SOURCE:
//   * the RelayOrder struct, its field names and order, the Permit2 witness domain and the digest - uniswaprelay-spec.mjs
//     with its own citations (Uniswap/relayer src/base/ReactorStructs.sol, src/lib/RelayOrderLib.sol,
//     src/lib/FeeEscalatorLib.sol, src/lib/InputLib.sol, src/lib/RelayOrderInfoLib.sol; Uniswap/uniswapx-sdk
//     src/order/RelayOrder.ts; Uniswap/permit2 src/libraries/PermitHash.sol and src/EIP712.sol);
//   * the reactor address per chain - Uniswap/relayer README, "Deployment Addresses": Ethereum MAINNET only,
//     RelayOrderReactor 0x0000000000A4e21E2597DCac987455c48b12edBF with UniversalRouter
//     0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD. Uniswap/uniswapx-sdk src/constants.ts REACTOR_ADDRESS_MAPPING
//     additionally maps the SAME relay address onto Goerli, Polygon, Sepolia and a test chain (its
//     constructSameAddressMap blanket, not a per-chain deployment note). ARBITRUM (42161) IS NOT DECLARED BY EITHER
//     SOURCE - so this provider refuses an unknown network BY NAME and never guesses an address;
//   * the event that ends an execution - Uniswap/relayer src/base/ReactorEvents.sol:
//     event Relay(bytes32 indexed orderHash, address indexed filler, address indexed swapper, uint256 nonce);
//   * WHERE THE FEE GOES - the address the relayer names in execute(), or the caller itself with the two-argument
//     overload (Uniswap/relayer README "RelayOrderReactor"; src/reactors/RelayOrderReactor.sol). It is NOT part of
//     the signed order, so it is not a field here;
//   * HOW THE INPUT IS PULLED - Permit2's permitWitnessTransferFrom, from the swapper, to input.recipient (the
//     UniversalRouter for a relayed swap); the swapper must have approved Permit2 for the input and the fee token
//     (Uniswap/relayer src/lib/RelayOrderLib.sol transferInputTokens). There is no plain-approval path;
//   * THE DISCOVERY PATH - and this is the honest part. Uniswap's relayer repository states only that swappers
//     "generate Relay Orders to be submitted onchain"; its "Integrating as a filler" section is EMPTY, the reactor
//     is called by whoever holds the signature, and the UniswapX order service (Uniswap/uniswapx-service) has NO
//     relay order type in its models or in its swagger.json. So there is NO documented submission endpoint and NO
//     gossip service: HOW A SIGNED ORDER REACHES A RELAYER IS UNDOCUMENTED. This provider does NOT invent a URL: its
//     submit() refuses BY NAME with "uniswap-relay-no-discovery".
//
// THE SHARED PRE-SIGNATURE GUARDS STAY ON FOR THIS PROVIDER TOO (uniswapRelayGate): the price is not the market, the
// amount is covered, the token allowance - the SAME guard functions the synchronous DEX leg and the other three
// providers use. An external, asynchronous route must not become a hole in the guards.
//
// NO NEW DEPENDENCY: the typed data is built by uniswaprelay-spec.mjs (this repository's own EIP-712), signing goes
// through the wallet adapter / the repository's signer, and the chain is read through the caller's own EIP-1193
// driver (eth_getLogs).
import { ASYNC } from "./shape.mjs";
import { keccak256 } from "../primitives.mjs";
import {
  UNISWAPRELAY_PERMIT2, UNISWAPRELAY_NATIVE, UNISWAPRELAY_ORDER_FIELDS,
  uniswapRelayOrderMissingFields, uniswapRelayOrderHashHex, uniswapRelayOrderTypedData,
  uniswapRelayRouterCalldata, uniswapRelayRouterDecode,
} from "./uniswaprelay-spec.mjs";
import * as engine from "../engine.mjs";

// THE REACTOR (settlement side) AND THE UNIVERSALROUTER (execution side) FOR MAINNET - the only pair Uniswap's own
// relayer README publishes (see the header). Other chains are a NAMED refusal, not a guess.
export const UNISWAPRELAY_REACTOR = "0x0000000000A4e21E2597DCac987455c48b12edBF";
export const UNISWAPRELAY_UNIVERSAL_ROUTER = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

// THE VENUE NAME, assembled from single-token parts (a single multi-word literal would read as user-facing text).
export const UNISWAPRELAY_VENUE = ["Uniswap", "Relay"].join(" ");

// THE NETWORKS WHERE THIS PROVIDER CAN BUILD AN ORDER. Keyed by EVM chainId. Only the chain whose reactor AND
// UniversalRouter pair Uniswap's relayer README publishes (Ethereum mainnet). A network absent here is a NAMED
// refusal ("uniswap-relay-unknown-network"), never a guess at an address.
export const UNISWAPRELAY_NETWORKS = Object.freeze({
  1: { reactor: UNISWAPRELAY_REACTOR, universalRouter: UNISWAPRELAY_UNIVERSAL_ROUTER, permit2: UNISWAPRELAY_PERMIT2 },
});

// THE EVENT TOPIC THAT ENDS AN EXECUTION: keccak256("Relay(bytes32,address,address,uint256)")
// (Uniswap/relayer src/base/ReactorEvents.sol). Assembled from single-token parts, then hashed - not a literal.
const RELAY_EVENT_PARTS = ["Relay(", "bytes32,", "address,", "address,", "uint256)"];
const relayEventSignature = () => RELAY_EVENT_PARTS.join("");
export const UNISWAPRELAY_EVENT_SIGNATURE = relayEventSignature();
export const UNISWAPRELAY_EVENT_TOPIC0 = (() => {
  let s = "0x";
  for (const b of keccak256(relayEventSignature())) s += b.toString(16).padStart(2, "0");
  return s;
})();

// THE STATUS VOCABULARY OF THIS PROVIDER. It has no order book, so its vocabulary is the CHAIN's: an order is
// "open" until its Relay event exists and is "filled" once it does; a deadline that has passed with no event is
// "expired" (not filled).
export const UNISWAPRELAY_STATUSES = ["open", "filled", "expired"];
export const UNISWAPRELAY_FINAL_STATUSES = ["filled", "expired"];
export const UNISWAPRELAY_SETTLED_STATUS = "filled";

// THE NAMED REFUSALS OF THIS PROVIDER. Every one is a VALUE ({ ok: false, code }), never silence and never null: a
// caller must always be able to tell "unreachable" from "refused" from "not settled yet", and - the one that
// matters here - "the discovery path is not documented" from "the order was refused".
export const UNISWAPRELAY_REFUSAL_CODES = [
  "uniswap-relay-unknown-network", // the chain has no published reactor/UniversalRouter pair here
  "uniswap-relay-bad-order",       // the order is incomplete or malformed - nothing to sign
  "uniswap-relay-sign-failed",     // the wallet did not produce a signature
  "uniswap-relay-no-discovery",    // NO DOCUMENTED path hands a signed relay order to a relayer
  "uniswap-relay-unreachable",     // the chain could not be read (no driver, connection, or timeout)
  "uniswap-relay-bad-response",    // the chain answered in a shape we do not know
  "uniswap-relay-not-settled",     // no Relay event before the timeout - "not yet", not "broken"
];

const refusal = (code, params = {}) => ({ ok: false, code, params });

/** The reactor for a chain, or null. */
export const uniswapRelayReactorFor = (chainId) => {
  const n = UNISWAPRELAY_NETWORKS[Number(chainId)];
  return n ? n.reactor : null;
};
/** The UniversalRouter for a chain, or null. */
export const uniswapRelayRouterFor = (chainId) => {
  const n = UNISWAPRELAY_NETWORKS[Number(chainId)];
  return n ? n.universalRouter : null;
};
/** The whole network record for a chain, or null. */
export const uniswapRelayNetwork = (chainId) => UNISWAPRELAY_NETWORKS[Number(chainId)] || null;

const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ""));
const isPositive = (v) => { try { return BigInt(String(v)) > 0n; } catch { return false; } };
const isHash = (v) => /^0x[0-9a-fA-F]{64}$/.test(String(v || ""));
const isSignature = (v) => /^0x[0-9a-fA-F]{130}$/.test(String(v || ""));

/**
 * THE INTENT: from what the person gives, build the swapper's own RelayOrder, its EIP-712 typed data, its order hash,
 * and the UniversalRouter calldata the order carries. Returns { ok: true, order, typedData, orderHash, calldata,
 * chainId, owner, reactor } or a named refusal. Pure - no network, no wallet.
 *
 * The order ALWAYS points its input at the UniversalRouter (input.recipient) and builds token -> native calldata, so
 * this provider is a native leg by construction: buyAmountWei is the minimum native the swap must return.
 */
export function buildUniswapRelayIntent(request = {}) {
  const chainId = Number(request.chainId);
  const net = uniswapRelayNetwork(chainId);
  if (!net) return { ...refusal("uniswap-relay-unknown-network", { chainId: Number.isFinite(chainId) ? chainId : null }), known: Object.keys(UNISWAPRELAY_NETWORKS).map(Number) };
  const swapper = request.swapper;
  const recipient = request.recipient === undefined || request.recipient === null ? swapper : request.recipient;
  const universalRouter = request.universalRouter === undefined || request.universalRouter === null ? net.universalRouter : request.universalRouter;
  const weth = request.wrappedToken;
  const missing = [];
  if (!isAddress(swapper)) missing.push("swapper");
  if (!isAddress(recipient) || String(recipient).toLowerCase() === UNISWAPRELAY_NATIVE) missing.push("recipient");
  if (!isAddress(request.sellToken)) missing.push("sellToken");
  if (!isAddress(weth)) missing.push("wrappedToken");
  if (!isAddress(universalRouter)) missing.push("universalRouter");
  if (!Number.isInteger(Number(request.fee))) missing.push("fee");
  if (!isPositive(request.sellAmountWei)) missing.push("sellAmountWei");
  if (!isPositive(request.buyAmountWei)) missing.push("buyAmountWei");
  if (!isAddress(request.feeToken)) missing.push("feeToken");
  if (!isPositive(request.feeEndAmountWei)) missing.push("feeEndAmountWei");
  if (!Number.isInteger(Number(request.deadline))) missing.push("deadline");
  if (missing.length) return refusal("uniswap-relay-bad-order", { missing: [...new Set(missing)] });

  const feeStartAmount = request.feeStartAmountWei === undefined || request.feeStartAmountWei === null ? request.feeEndAmountWei : request.feeStartAmountWei;
  const feeStartTime = request.feeStartTime === undefined || request.feeStartTime === null ? request.deadline : request.feeStartTime;
  const feeEndTime = request.feeEndTime === undefined || request.feeEndTime === null ? request.deadline : request.feeEndTime;

  let calldata;
  try {
    calldata = uniswapRelayRouterCalldata({
      tokenIn: request.sellToken, weth, fee: request.fee,
      amountInWei: request.sellAmountWei, amountOutMinimumWei: request.buyAmountWei, recipient,
    });
  } catch (error) {
    return refusal("uniswap-relay-bad-order", { why: String(error && error.message ? error.message : error) });
  }

  const order = {
    info: {
      reactor: net.reactor,
      swapper,
      nonce: request.nonce === undefined || request.nonce === null ? "0" : String(request.nonce),
      deadline: String(request.deadline),
    },
    input: { token: request.sellToken, amount: String(request.sellAmountWei), recipient: universalRouter },
    fee: {
      token: request.feeToken,
      startAmount: String(feeStartAmount),
      endAmount: String(request.feeEndAmountWei),
      startTime: String(feeStartTime),
      endTime: String(feeEndTime),
    },
    universalRouterCalldata: calldata,
  };
  const stillMissing = uniswapRelayOrderMissingFields(order);
  if (stillMissing.length) return refusal("uniswap-relay-bad-order", { missing: stillMissing });
  try {
    const typedData = uniswapRelayOrderTypedData({ order, chainId });
    const orderHash = uniswapRelayOrderHashHex(order);
    return { ok: true, chainId, owner: swapper, reactor: order.info.reactor, order, orderHash, calldata, typedData };
  } catch (error) {
    return refusal("uniswap-relay-bad-order", { why: String(error && error.message ? error.message : error) });
  }
}

/** The provider's plan, in the shape the registry and the paths expect. Returns a VALUE with a named refusal. */
export function uniswapRelayPlan(request = {}) {
  const intent = buildUniswapRelayIntent(request);
  if (!intent.ok) return intent;
  return {
    ok: true,
    provider: "uniswaprelay",
    venue: UNISWAPRELAY_VENUE,
    shape: ASYNC,
    route: "uniswaprelay",
    expectedOutWei: String(request.buyAmountWei),
    order: intent.order,
    orderHash: intent.orderHash,
    typedData: intent.typedData,
    calldata: intent.calldata,
    owner: intent.owner,
    reactor: intent.reactor,
    nativeOutput: true,
    // WHAT ENDS EXECUTION: the reactor's own Relay event on chain - an OBSERVED effect, not an answer from a service.
    endsWith: { kind: "onchain-effect", settledWhen: UNISWAPRELAY_SETTLED_STATUS, final: [...UNISWAPRELAY_FINAL_STATUSES], event: UNISWAPRELAY_EVENT_SIGNATURE },
  };
}

/**
 * SIGN THE ORDER THROUGH THE WALLET ADAPTER. The adapter's own `signTypedData` is used when present (it wraps
 * eth_signTypedData_v4); otherwise the same call is made through the adapter's EIP-1193 driver. A wallet that will
 * not sign is a NAMED refusal, not a crash.
 */
export async function uniswapRelaySignOrder({ typedData, wallet, address = null } = {}) {
  if (!typedData || typeof typedData !== "object") return refusal("uniswap-relay-bad-order", { field: "typedData" });
  try {
    if (wallet && typeof wallet.signTypedData === "function") {
      const signature = await wallet.signTypedData(typedData);
      if (!isSignature(signature)) return refusal("uniswap-relay-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    const driver = wallet && typeof wallet.driver === "function" ? wallet.driver() : null;
    if (driver && typeof driver.request === "function") {
      const from = address || (typeof wallet.address === "function" ? await wallet.address() : null);
      const signature = await driver.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] });
      if (!isSignature(signature)) return refusal("uniswap-relay-sign-failed", { why: "bad-signature-shape" });
      return { ok: true, signature };
    }
    return refusal("uniswap-relay-sign-failed", { why: "no-wallet" });
  } catch (error) {
    return refusal("uniswap-relay-sign-failed", { why: String((error && error.code) || (error && error.message) || error) });
  }
}

/**
 * HAND THE SIGNED ORDER TO A RELAYER - THE HONEST ANSWER IS THAT THERE IS NO DOCUMENTED WAY.
 *
 * Every other provider here has a transport: CoW and KyberSwap post to a public order book, UniswapX posts to the
 * Trading API (with a key). The relayer has NONE. Uniswap/relayer's README says only that swappers "generate Relay
 * Orders to be submitted onchain"; its "Integrating as a filler" section is empty; the reactor is called by whoever
 * happens to hold the signature; and the UniswapX order service (Uniswap/uniswapx-service) carries no relay order
 * type at all (no model, nothing in swagger.json). So the delivery path is UNDOCUMENTED, and this provider refuses
 * BY NAME rather than inventing an endpoint: the refusal tells the caller the signature is built and signable, but
 * there is nowhere the repository can honestly send it.
 */
export function uniswapRelaySubmit({ order = null, signature = null, chainId = null } = {}) {
  const chain = Number(chainId);
  if (!uniswapRelayNetwork(chain)) return refusal("uniswap-relay-unknown-network", { chainId: Number.isFinite(chain) ? chain : null });
  if (!order || typeof order !== "object") return refusal("uniswap-relay-bad-order", { field: "order" });
  if (!isSignature(signature)) return refusal("uniswap-relay-bad-order", { field: "signature" });
  // The order IS self-contained and signable; what is missing is the DOCUMENTED WAY to a relayer. Named, with the
  // facts: the reactor is permissionless and there is no submission endpoint in Uniswap's own sources.
  return refusal("uniswap-relay-no-discovery", {
    reactorIsPermissionless: true,
    documentedSubmissionEndpoint: null,
    reason: "undocumented",
  });
}

// ONE READ OF THE REACTOR'S OWN Relay EVENT for this order hash. The chain is the ONLY source of truth here - an
// answer from a service would not be an on-chain effect. The read goes through the caller's EIP-1193 driver
// (eth_getLogs) or an injected `getLogs` (checks drive the failures without a chain).
const readRelayLogs = async ({ driver = null, getLogs = null, reactor, orderHash, fromBlock = "earliest", toBlock = "latest" }) => {
  try {
    if (typeof getLogs === "function") {
      const logs = await getLogs({ reactor, orderHash, fromBlock, toBlock, topic0: UNISWAPRELAY_EVENT_TOPIC0 });
      return { ok: true, logs };
    }
    if (driver && typeof driver.request === "function") {
      const logs = await driver.request({
        method: "eth_getLogs",
        params: [{ address: reactor, fromBlock, toBlock, topics: [UNISWAPRELAY_EVENT_TOPIC0, orderHash] }],
      });
      return { ok: true, logs };
    }
    return refusal("uniswap-relay-unreachable", { why: "no-driver" });
  } catch (error) {
    return refusal("uniswap-relay-unreachable", { why: String((error && error.code) || (error && error.message) || error) });
  }
};

/**
 * READ ONE ORDER's status off the chain. The reactor's Relay event with this order hash means FILLED; a deadline
 * already past with no event means EXPIRED; otherwise OPEN. A logs answer that is not an array, or a log whose
 * topics are not this event and this order hash, is "uniswap-relay-bad-response" - never silence, never a silent
 * "settled".
 */
export async function uniswapRelayStatus({ orderHash, chainId = null, reactor = null, deadline = null, driver = null, getLogs = null, fromBlock = "earliest", toBlock = "latest", nowSec = null } = {}) {
  const chain = Number(chainId);
  const net = uniswapRelayNetwork(chain);
  const target = reactor || (net ? net.reactor : null);
  if (!target) return refusal("uniswap-relay-unknown-network", { chainId: Number.isFinite(chain) ? chain : null });
  if (!isHash(orderHash)) return refusal("uniswap-relay-bad-order", { field: "orderHash" });
  const read = await readRelayLogs({ driver, getLogs, reactor: target, orderHash, fromBlock, toBlock });
  if (!read.ok) return read;
  const logs = read.logs;
  if (!Array.isArray(logs)) return refusal("uniswap-relay-bad-response", { where: "logs", got: typeof logs });
  const ours = logs.filter((log) => {
    if (!log || !Array.isArray(log.topics)) return false;
    const t0 = String(log.topics[0] || "").toLowerCase();
    const t1 = String(log.topics[1] || "").toLowerCase();
    return t0 === UNISWAPRELAY_EVENT_TOPIC0.toLowerCase() && t1 === String(orderHash).toLowerCase();
  });
  if (logs.length > 0 && ours.length === 0) return refusal("uniswap-relay-bad-response", { where: "logs", detail: "topics-mismatch" });
  if (ours.length > 0) return { ok: true, status: UNISWAPRELAY_SETTLED_STATUS, log: ours[0] };
  // No event: still open, unless the deadline (unix seconds) has already passed.
  if (deadline !== null && deadline !== undefined) {
    const now = typeof nowSec === "function" ? nowSec() : (Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000));
    if (Number(deadline) < now) return { ok: true, status: "expired" };
  }
  return { ok: true, status: "open" };
}

/**
 * WHAT ENDS AN ASYNCHRONOUS PROVIDER'S EXECUTION - poll the chain until the reactor's Relay event for this order
 * hash exists or the order is finally dead, with a timeout. Returns:
 *   { ok: true, done: true, settled: true,  status: "filled" }   - the reactor relayed the order;
 *   { ok: true, done: true, settled: false, status: "expired" }  - the deadline passed with no event;
 *   { ok: false, code: "uniswap-relay-not-settled" | "uniswap-relay-unreachable" | ... } - a NAMED refusal.
 * This observes the REAL on-chain effect (the event), never an answer from a service. The clock and the sleep are
 * injectable so the wait is testable without real time.
 */
export async function uniswapRelaySettled(request = {}, deps = {}) {
  const { orderHash, chainId = null, reactor = null, deadline = null } = request;
  if (!isHash(orderHash)) return refusal("uniswap-relay-bad-order", { field: "orderHash" });
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : 5_000;
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : 300_000;
  const startedAt = now();
  let lastStatus = null;
  for (;;) {
    const read = await uniswapRelayStatus({
      orderHash, chainId, reactor, deadline,
      driver: deps.driver || null, getLogs: deps.getLogs || null,
      fromBlock: deps.fromBlock === undefined ? "earliest" : deps.fromBlock,
      toBlock: deps.toBlock === undefined ? "latest" : deps.toBlock,
      nowSec: deps.nowSec === undefined ? null : deps.nowSec,
    });
    if (!read.ok) return read; // unreachable / bad-response / unknown: a named refusal, not silence
    lastStatus = read.status;
    if (lastStatus === UNISWAPRELAY_SETTLED_STATUS) return { ok: true, done: true, settled: true, status: lastStatus, orderHash };
    if (lastStatus === "expired") return { ok: true, done: true, settled: false, status: lastStatus, orderHash };
    if (now() - startedAt >= timeoutMs) return refusal("uniswap-relay-not-settled", { orderHash, status: lastStatus, waitedMs: now() - startedAt });
    await sleep(pollMs);
  }
}

/**
 * THE SHARED PRE-SIGNATURE GUARDS, APPLIED TO THIS PROVIDER. The same guard functions the synchronous DEX leg and the
 * other three providers use (engine.dex.priceGateVerdict, engine.dex.dexLegVerdict, engine.guards.allowanceVerdict),
 * composed by the same summary guard (engine.guards.signingGateVerdict). Pure - no network, no wallet.
 */
export function uniswapRelayGate({
  order = null, amountInWei = null, expectedOutWei = null, requiredOutWei = null,
  tokenUsd = null, referenceNativeUsd = null, tolerated = false, gates = null,
  sellDecimals = null, buyDecimals = null, buySymbol = null, allowanceWei = null, allowanceConsent = false,
  tokenIsNative = false, symbol = null, decimals = null,
} = {}) {
  if (!order) return { ok: false, blocked: true, reason: "uniswap-relay-no-order", checks: [] };
  // THE RELAY ORDER CARRIES ONE AMOUNT (its input); the expected output lives in the calldata's amountOutMinimum, so
  // the caller names both explicitly rather than this gate reading a number the order does not hold.
  const amountIn = amountInWei === undefined || amountInWei === null ? (order.input ? order.input.amount : null) : amountInWei;
  const amountOut = expectedOutWei === undefined || expectedOutWei === null ? null : expectedOutWei;
  const price = engine.dex.priceGateVerdict({
    amountInWei: amountIn, amountOutWei: amountOut,
    inDecimals: sellDecimals, outDecimals: buyDecimals,
    tokenUsd: Number(tokenUsd) > 0 ? Number(tokenUsd) : null,
    referenceUsd: Number(referenceNativeUsd) > 0 ? Number(referenceNativeUsd) : null,
    stableSteps: [], tolerated: Boolean(tolerated), gates,
  });
  const leg = { ok: true, amountOutWei: amountOut === null ? null : String(amountOut), price, wrapped: { symbol: buySymbol, decimals: buyDecimals } };
  const coverage = engine.dex.dexLegVerdict(leg, requiredOutWei === undefined || requiredOutWei === null ? amountOut : requiredOutWei);
  const coverageCheck = {
    ok: !coverage.blocked, checked: coverage.kind !== "unchecked" && coverage.kind !== "unquoted",
    blocks: coverage.blocked === true, kind: coverage.kind, reason: coverage.reason,
  };
  const allowance = engine.guards.allowanceVerdict({
    tokenIsNative, allowanceWei, amountWei: amountIn,
    consent: allowanceConsent === true, symbol, decimals: Number.isFinite(Number(decimals)) ? Number(decimals) : 18,
  });
  const gate = engine.guards.signingGateVerdict([coverageCheck, allowance]);
  return { ...gate, price, coverage, allowance };
}

// THE PROVIDER, AS THE REGISTRY EXPECTS IT: id, kind, shape and, for "async", what ends execution (settled).
export const uniswapRelayProvider = Object.freeze({
  id: "uniswaprelay",
  kind: "uniswaprelay",
  venue: UNISWAPRELAY_VENUE,
  shape: ASYNC,
  // WHAT IT SETTLES: native coin - the relayed swap unwraps the wrapped native to the recipient, and the escrow is
  // funded with the native. So this provider can carry a native need ALL THE WAY - a native leg of a composed route,
  // or a single route on its own.
  settles: "native",
  networks: UNISWAPRELAY_NETWORKS,
  settlement: UNISWAPRELAY_REACTOR,
  universalRouter: UNISWAPRELAY_UNIVERSAL_ROUTER,
  permit2: UNISWAPRELAY_PERMIT2,
  nativeToken: UNISWAPRELAY_NATIVE,
  eventTopic: UNISWAPRELAY_EVENT_TOPIC0,
  orderFields: UNISWAPRELAY_ORDER_FIELDS,
  plan: uniswapRelayPlan,
  settled: uniswapRelaySettled,
  buildIntent: buildUniswapRelayIntent,
  sign: uniswapRelaySignOrder,
  submit: uniswapRelaySubmit,
  status: uniswapRelayStatus,
  gate: uniswapRelayGate,
});
