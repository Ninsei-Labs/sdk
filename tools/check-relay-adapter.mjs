#!/usr/bin/env node
// THE RECOVERY-KEY ADAPTER: ONE KEY, ONE REQUEST, A VERIFIED ANSWER.
//
// The fake relay signs a real answer for the exact payload it receives. The check drives `quotes.firmRelay`
// with a recovery key and follows the derived view half, then breaks the role, the salt, the market and the
// registry mapping one at a time.
//
// Run: node tools/check-relay-adapter.mjs
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { keccak256, secp256k1 } from "../src/primitives.mjs";
import { nodeFeaturesDigest } from "../src/relayFeatures.mjs";
import { relayQuoteDigest, relayRequestDigest } from "../src/relayQuote.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";
import { createQuotes } from "../src/quotes.mjs";
import { recordInputOf } from "../src/swaps.mjs";
import * as engine from "../src/engine.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { createRecoveryKey, takerHalvesV2 } from "../src/recovery-key.mjs";
import { createNinsei } from "../src/index.mjs";
import { deploymentFor } from "../engine/core/config.js";

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});
const hpke = await suite.kem.generateKeyPair(true);
const hpkePublic = "0x" + Buffer.from(await suite.kem.serializePublicKey(hpke.publicKey)).toString("hex");
const quotePrivate = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const quoteKey = (() => {
  const publicKey = secp256k1.Point.BASE.multiply(BigInt("0x" + Buffer.from(quotePrivate).toString("hex"))).toBytes(false);
  return "0x" + Buffer.from(keccak256(publicKey.slice(1)).slice(12)).toString("hex");
})();
const relayPrivate = Uint8Array.from({ length: 32 }, (_, i) => i + 33);
const relayKey = (() => {
  const publicKey = secp256k1.Point.BASE.multiply(BigInt("0x" + Buffer.from(relayPrivate).toString("hex"))).toBytes(false);
  return "0x" + Buffer.from(keccak256(publicKey.slice(1)).slice(12)).toString("hex");
})();
const provider = "0x" + "a1".repeat(20);
const registry = "0x" + "c3".repeat(20);
const user = "0x" + "b2".repeat(20);
const factory = "0x" + "11".repeat(20);
const cashier = deploymentFor("arbitrum-sepolia").escrow.cashier;
const predictedEscrow = "0x" + "dd".repeat(20);
const nowSec = Math.floor(Date.now() / 1000);
const mnemonic = createRecoveryKey().mnemonic;
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const utf8 = (value) => new TextEncoder().encode(value);
const selector = (signature) => "0x" + Buffer.from(keccak256(utf8(signature)).slice(0, 4)).toString("hex");
const providerSelector = selector("providerOf(address)");
const factorySelector = selector("factoryOf(address)");
const word = (address) => "0x" + "00".repeat(12) + address.replace(/^0x/, "");

const window = (side) => ({
  market: "421614:ETH",
  side,
  xmrNetwork: "stagenet",
  readyMinSeconds: 1200,
  readyMaxSeconds: 1800,
  settlementMinSeconds: 3600,
  settlementMaxSeconds: 7200,
  quoteTtlSeconds: 30,
});
// The node's features, signed by the maker key: a case that changes a signed field must sign the change, exactly
// as a real node would.
const nodeFeatures = (overrides = {}) => {
  const base = {
    type: "node_features", version: 1, relayId: "test-relay", provider, quoteKey, registry,
    hpkeKey: hpkePublic, firmWindows: [window("ask"), window("bid")],
    time: nowSec - 10, nonce: "0x" + "07".repeat(32),
    ...overrides,
  };
  const sig = secp256k1.sign(nodeFeaturesDigest(base), quotePrivate, { format: "recovered", prehash: false });
  return {
    ...base,
    signature: "0x" + Buffer.from(sig.slice(1, 33)).toString("hex")
      + Buffer.from(sig.slice(33, 65)).toString("hex")
      + (27 + sig[0]).toString(16),
  };
};
const features = nodeFeatures();

const order = {
  chainId: 421614,
  factory,
  locker: user,
  claimer: provider,
  amount: "1000",
  readyBy: nowSec + 1800,
  t1: nowSec + 3600,
  salt: "0x" + "44".repeat(32),
};
const derived = takerHalvesV2({ mnemonic, chainId: order.chainId, factory, salt: order.salt });

function signRelay(answer) {
  const sig = secp256k1.sign(relayQuoteDigest(answer), quotePrivate, { format: "recovered", prehash: false });
  return "0x" + Buffer.from(sig.slice(1, 33)).toString("hex")
    + Buffer.from(sig.slice(33, 65)).toString("hex")
    + (27 + sig[0]).toString(16);
}
function signRelayRequest(request) {
  const sig = secp256k1.sign(relayRequestDigest(request), relayPrivate, { format: "recovered", prehash: false });
  return "0x" + Buffer.from(sig.slice(1, 33)).toString("hex")
    + Buffer.from(sig.slice(33, 65)).toString("hex")
    + (27 + sig[0]).toString(16);
}
function answerFor(payload, { tamperProof = false, cashierAddress = cashier, validUntil = null } = {}) {
  const orderTerm = payload.terms.order;
  const context = engine.orderContext.orderContextString(orderTerm);
  const ask = payload.terms.side === "ask";
  const nodeSide = buildOwnSideFromHalves(orderTerm, { spendHalf: "0x05", viewHalf: derived.makerViewHalf });
  const nodeProofPoint = secp256k1.Point.fromHex(nodeSide.side.proof.XA.replace(/^0x/, ""));
  const nodeHalf = {
    commitHalf: "0x" + Buffer.from(keccak256(nodeProofPoint.toBytes(false).slice(1))).toString("hex"),
    edPoint: nodeSide.spendPoint,
    proof: tamperProof ? { ...nodeSide.side.proof, proofs: [] } : nodeSide.side.proof,
  };
  const quote = {
    provider: payload.terms.maker,
    quoteKey,
    registry: payload.terms.registry,
    cashier: cashierAddress,
    locker: orderTerm.locker,
    claimer: orderTerm.claimer,
    amount: orderTerm.amount,
    readyBy: orderTerm.readyBy,
    t1: orderTerm.t1,
    salt: orderTerm.salt,
    commitHalfClaimer: ask ? nodeHalf.commitHalf : "0x" + "aa".repeat(32),
    edPointClaimer: ask ? nodeHalf.edPoint : "0x" + "bb".repeat(32),
    chainId: orderTerm.chainId,
    feeBps: "0",
    fee: "0",
    feeRecipient: "0x" + "99".repeat(20),
    validUntil: String(validUntil === null ? orderTerm.readyBy - 60 : validUntil),
    nonce: "1",
    xmrAmount: payload.terms.xmrAmount,
    claimTip: payload.terms.claimTip,
    commitHalfLocker: "0x" + "a1".repeat(32),
    edPointLocker: "0x" + "a2".repeat(32),
    edViewPointLocker: "0x" + "a3".repeat(32),
    factory: orderTerm.factory,
  };
  quote.quoteSignature = signQuoteDigest({
    crypto: { keccak256, secp256k1 },
    digest: quoteDigest({ crypto: { keccak256, secp256k1 }, quote }),
    privateKey: hex(quotePrivate),
  });
  const inner = {
    factory: orderTerm.factory,
    quoteVersion: 10,
    contextVersion: "ninsei-order-v3",
    context,
    quote,
    quoteSignature: quote.quoteSignature,
    nodeHalf,
    edViewPointLocker: ask ? payload.edViewPointClient : nodeSide.viewPoint,
    edViewPointClaimer: ask ? nodeSide.viewPoint : payload.edViewPointClient,
  };
  const forwarded = {
    type: "quote_request", version: 1, relayId: "test-relay", provider: payload.terms.maker,
    session: "0x" + "01".repeat(32), requestId: "0x" + "02".repeat(32), counter: "1",
    expiry: nowSec + 600, payload: payload._raw || JSON.stringify(payload), feeBps: "0",
    feeRecipient: "0x" + "99".repeat(20),
  };
  forwarded.signature = signRelayRequest(forwarded);
  const answer = {
    type: "quote", version: 1, relayId: "test-relay", provider: payload.terms.maker,
    session: "0x" + "01".repeat(32), requestId: "0x" + "02".repeat(32), counter: "7",
    requestHash: "0x" + Buffer.from(relayRequestDigest(forwarded)).toString("hex"),
    payload: JSON.stringify(inner), time: nowSec,
  };
  answer.signature = signRelay(answer);
  return {
    version: 1, relay: "test-relay", offered: 1, forwarded, answer,
  };
}

function relayFetch({ tamperProof = false, cashierAddress = cashier, validUntil = null } = {}) {
  const bodies = [];
  return {
    bodies,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/v1/relay")) {
        return { ok: true, status: 200, json: async () => ({ version: 1, relayId: "test-relay", relayKey, feeRecipient: "0x" + "99".repeat(20), feeBps: "0" }) };
      }
      const body = JSON.parse(init.body);
      bodies.push(body);
      const payload = JSON.parse(body.payload);
      payload._raw = body.payload;
      return { ok: true, status: 200, json: async () => answerFor(payload, { tamperProof, cashierAddress, validUntil }) };
    },
  };
}

function makeQuotes({ providerWord = provider, factoryWord = factory, cashierPin = cashier, registryPin = null, denylist = null, now = null } = {}) {
  return createQuotes({
    denylist,
    config: { settlement: { chain: { escrow: { ...(cashierPin ? { cashier: cashierPin } : {}), ...(registryPin ? { registry: registryPin } : {}) } } } },
    now: now || (() => nowSec * 1000),
    evmCall: chainReads({ providerWord, factoryWord }),
    evmBlock: async () => ({ baseFeePerGas: "0" }),
  });
}

// The registry and the factory entry point a real chain would answer, reduced to the three reads this path makes.
function chainReads({ providerWord = provider, factoryWord = factory } = {}) {
  return async ({ data }) => {
    if (data.startsWith(providerSelector)) return word(providerWord);
    if (data.startsWith(factorySelector)) return word(factoryWord);
    if (data.startsWith(engine.evm.FACTORY_METHODS.predict)) return word(predictedEscrow);
    throw new Error("unexpected chain call");
  };
}

const baseRequest = {
  relayUrl: "https://relay.example",
  features,
  side: "ask",
  xmrAmount: "1000000000000",
  recoveryKey: mnemonic,
  market: "421614:ETH",
  xmrNetwork: "stagenet",
};

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };
const call = (quotes, overrides = {}) => quotes.firmRelay({ ...baseRequest, order, ...overrides });

console.log("=== 1) A RECOVERY KEY PRODUCES A VERIFIED QUOTE ===");
const wire = relayFetch();
try {
  const result = await call(makeQuotes(), { fetchImpl: wire.fetchImpl });
  if (result.quote.claimer === provider && result.orderQuote.factory === factory) ok("the ask quote carries the provider as claimer");
  else bad("unexpected roles: " + JSON.stringify({ claimer: result.quote.claimer, factory: result.orderQuote.factory }));
  // THE RECORD TAKES THE SIGNED AMOUNT FROM THE ORDER TERMS, NOT FROM A DISPLAY SIZE.
  if (result.order.xmrAmount === baseRequest.xmrAmount && result.quote.xmrAmount === baseRequest.xmrAmount) {
    ok("the signed XMR amount travels with the order terms");
  } else bad("the signed XMR amount did not reach the order: " + JSON.stringify({ order: result.order, quote: result.quote }));
  // THE SEAM THE PARTNER'S PROBE FOUND: the record must take the signed figure from exactly the object `swaps.start`
  // receives, not from a rounded display size and not from a field the relay answer never carries.
  const recordInput = recordInputOf({ side: "buy", quote: result.quote, order: result.order, orderQuote: result.orderQuote });
  if (recordInput.expectedAtomic === baseRequest.xmrAmount) ok("the record input keeps the signed XMR amount");
  else bad("the record input lost the signed XMR amount: " + JSON.stringify(recordInput.expectedAtomic));
  if (result.viewHalfClaimer === derived.makerViewHalf && result.viewHalfPoint === derived.makerViewPoint) {
    ok("the maker view half is derived from the same recovery key");
  } else bad("the maker view half is not the derived one");
  if (wire.bodies.length === 1 && wire.bodies[0].payload && JSON.parse(wire.bodies[0].payload).terms.order.salt === order.salt) {
    ok("one request with the order salt was sent");
  } else bad("the request did not carry the order salt");
  if (result.recovery && result.recovery.kind === "salt-v2" && result.recovery.salt === order.salt) {
    ok("the adapter reports the salt-v2 derivation");
  } else bad("the derivation was not returned");
  if (result.counterparty.proof === result.nodeHalf.proof
    && result.counterparty.commitHalfClaimer === result.quote.commitHalfClaimer
    && result.counterparty.viewHalfClaimer === derived.makerViewHalf) {
    ok("the counterparty shape carries the proof and the maker view half");
  } else bad("the counterparty shape is incomplete");
  if (typeof result.jointAddress === "string" && result.jointAddress.length >= 95) {
    ok("the one-time XMR address is assembled from both sides");
  } else bad("the one-time XMR address is missing or short: " + JSON.stringify(result.jointAddress));
  if (result.escrow === predictedEscrow) ok("the escrow address comes from the signed quote");
  else bad("the escrow address is not the predicted one: " + JSON.stringify(result.escrow));
  if (result.quote.asset === "ETH" && result.quote.token === "eth" && result.quote.id) {
    ok("the relay answer carries the paying asset and a start id");
  } else bad("start fields: " + JSON.stringify({ asset: result.quote.asset, token: result.quote.token, id: result.quote.id }));
  if (result.startRequest && result.startRequest.quote === result.quote
    && result.startRequest.order === result.order
    && result.startRequest.orderQuote === result.orderQuote && result.startRequest.recoverySalt === order.salt) {
    ok("the relay answer exposes a start request");
  } else bad("start request: " + JSON.stringify(result.startRequest));
} catch (error) { bad("valid adapter call failed: " + JSON.stringify(error && (error.code || error.message)) + " " + JSON.stringify(error && error.params)); }

console.log("=== 1b) A BUY QUOTE MUST KEEP THE START MARGIN AND THE PREPARATION TIME ===");
// A FIXED CLOCK, NOT A SECOND Date.now(). The quote's lifetime and the adapter's answer must be measured from the
// same instant; otherwise a slow run can turn a 60 s case into a 44 s one and the check fails on timing, not logic.
const lifeNowMs = Math.floor(Date.now() / 1000) * 1000;
for (const [left, expected] of [[30, "quote-too-short"], [31, "quote-too-short"], [45, "quote-too-short"], [60, null]]) {
  const until = Math.floor(lifeNowMs / 1000) + left;
  try {
    const result = await call(makeQuotes({ now: () => lifeNowMs }), { fetchImpl: relayFetch({ validUntil: until }).fetchImpl });
    if (expected === null && result.remainingSec > 45 && result.confirmBySec === until - 45) {
      ok("a buy with " + left + " s left is accepted and reports its confirm deadline");
    } else bad("a buy with " + left + " s left was accepted without the expected life: " + JSON.stringify({ remainingSec: result.remainingSec, confirmBySec: result.confirmBySec }));
  } catch (error) {
    if (expected && error && error.code === expected && error.params && error.params.side === "ask") {
      ok("a buy with " + left + " s left is refused before confirmation");
    } else bad("a buy with " + left + " s left gave " + JSON.stringify(error && (error.code || error.message)) + " " + JSON.stringify(error && error.params));
  }
}

console.log("=== 1a) THE REGISTRY IS PINNED TO THE NETWORK ===");
{
  const foreign = makeQuotes({ registryPin: "0x" + "aa".repeat(20) });
  try {
    await call(foreign, { fetchImpl: relayFetch().fetchImpl });
    bad("a foreign registry passed the pin");
  } catch (error) {
    if (error && error.code === "bad-input" && error.params && error.params.field === "features.registry") {
      ok("a registry different from the network pin is refused");
    } else bad("foreign registry gave " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }
  const pinned = makeQuotes({ registryPin: registry });
  try {
    await call(pinned, { fetchImpl: relayFetch().fetchImpl });
    ok("the network's own registry is accepted");
  } catch (error) {
    bad("the pinned registry was refused: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }
}

console.log("=== 2) THE BID SIDE KEEPS THE PROVIDER AS LOCKER ===");
const bidOrder = { ...order, locker: provider, claimer: user };
try {
  const result = await call(makeQuotes(), { order: bidOrder, side: "bid", fetchImpl: relayFetch().fetchImpl });
  if (result.quote.locker === provider && result.quote.claimer === user) ok("the bid quote carries the provider as locker");
  else bad("unexpected bid roles: " + JSON.stringify({ locker: result.quote.locker, claimer: result.quote.claimer }));
  if (result.viewHalfClaimer === derived.makerViewHalf) ok("the bid uses the same derived maker view half");
  else bad("the bid maker view half is not derived");
} catch (error) { bad("valid bid call failed: " + JSON.stringify(error && (error.code || error.message)) + " " + JSON.stringify(error && error.params)); }

console.log("=== 2b) A SELL QUOTE IS NOT BOUND BY THE BUY START MARGIN ===");
try {
  const until = Math.floor(Date.now() / 1000) + 30;
  const result = await call(makeQuotes({ now: () => Date.now() }), { order: bidOrder, side: "bid", fetchImpl: relayFetch({ validUntil: until }).fetchImpl });
  if (result.remainingSec > 0 && result.remainingSec <= 30) ok("a sell quote with a short life is accepted and reports its life");
  else bad("a short sell quote was accepted without its life: " + JSON.stringify({ remainingSec: result.remainingSec }));
} catch (error) {
  bad("a short sell quote was refused by the buy margin: " + JSON.stringify(error && (error.code || error.message)) + " " + JSON.stringify(error && error.params));
}

console.log("=== 2a) THE DENYLIST CHECKS THE CLIENT ON A BID ===");
try {
  await call(makeQuotes({ denylist: new Set([user]) }), { order: bidOrder, side: "bid", fetchImpl: relayFetch().fetchImpl });
  bad("a denied bid claimer passed");
} catch (error) {
  if (error && error.code === "address-denied") ok("the client's own claimer is denied on a bid");
  else bad("bid denylist returned " + JSON.stringify(error && (error.code || error.message)));
}

console.log("=== 3) THE ROLE, THE KEY AND THE SALT ARE NOT GUESSED ===");
for (const [label, overrides, field] of [
  ["a foreign claimer", { order: { ...order, claimer: "0x" + "01".repeat(20) } }, "order.claimer"],
  ["a missing recovery key", { recoveryKey: null }, "recoveryKey"],
  ["a missing amount", { xmrAmount: null }, "xmrAmount"],
  ["a mismatched recovery salt", { recoverySalt: "0x" + "aa".repeat(32) }, "recoverySalt"],
]) {
  try {
    await call(makeQuotes(), overrides);
    bad(label + " passed");
  } catch (error) {
    if (error && error.code === "bad-input" && error.params && error.params.field === field) ok(label + " is refused");
    else bad(label + " got " + JSON.stringify(error && (error.code || error.message)));
  }
}

console.log("=== 4) A CHAIN MAPPING THAT CONTRADICTS THE ANSWER IS REFUSED ===");
try {
  await call(makeQuotes({ providerWord: "0x" + "02".repeat(20) }), { fetchImpl: relayFetch().fetchImpl });
  bad("a foreign provider mapping passed");
} catch (error) {
  if (error && error.code === "quote-provider-mismatch") ok("a foreign provider mapping is refused");
  else bad("wrong provider-mapping code: " + JSON.stringify(error && (error.code || error.message)));
}
try {
  await call(makeQuotes({ factoryWord: "0x" + "03".repeat(20) }), { fetchImpl: relayFetch().fetchImpl });
  bad("a foreign factory mapping passed");
} catch (error) {
  if (error && error.code === "quote-factory-mismatch") ok("a foreign factory mapping is refused");
  else bad("wrong factory-mapping code: " + JSON.stringify(error && (error.code || error.message)));
}

console.log("=== 5) A TAMPERED NODE PROOF IS REFUSED ===");
try {
  await call(makeQuotes(), { fetchImpl: relayFetch({ tamperProof: true }).fetchImpl });
  bad("a tampered node proof passed");
} catch (error) {
  if (error && error.code === "quote-refused" && error.params && error.params.step === "proof") ok("a tampered node proof is refused");
  else bad("wrong tampered-proof code: " + JSON.stringify(error && (error.code || error.message)));
}

console.log("=== 6) THE ADAPTER DOES NOT TAKE A REFUSAL AS A QUOTE ===");
const refusal = { fetchImpl: async (url) => String(url).endsWith("/v1/relay")
  ? { ok: true, status: 200, json: async () => ({ version: 1, relayId: "test-relay", feeRecipient: "0x" + "99".repeat(20), feeBps: "0" }) }
  : { ok: false, status: 409, json: async () => ({ version: 1, code: "price_changed" }) } };
try {
  await call(makeQuotes(), refusal);
  bad("a refusal passed");
} catch (error) {
  if (error && error.code === "quote-refused" && error.params && error.params.code === "price_changed") ok("the relay refusal keeps its code");
  else bad("wrong refusal: " + JSON.stringify(error && (error.code || error.message)));
}

console.log("=== 7) A FOREIGN CASHIER IS REFUSED ===");
try {
  await call(makeQuotes(), { fetchImpl: relayFetch({ cashierAddress: "0x" + "66".repeat(20) }).fetchImpl });
  bad("a quote with a foreign cashier passed");
} catch (error) {
  if (error && error.code === "quote-cashier-mismatch") ok("a quote with a foreign cashier is refused");
  else bad("wrong foreign-cashier code: " + JSON.stringify(error && (error.code || error.message)));
}

console.log("=== 8) A CHAIN PROFILE WITHOUT A VAULT IS REFUSED ===");
try {
  await call(makeQuotes({ cashierPin: null }), { fetchImpl: relayFetch().fetchImpl });
  bad("a profile without a pinned cashier passed");
} catch (error) {
  if (error && error.code === "quote-cashier-mismatch" && error.params && error.params.why === "no-pinned-cashier") {
    ok("a profile without a pinned cashier is refused");
  } else bad("wrong missing-cashier code: " + JSON.stringify(error && (error.code || error.message)));
}

// sdk#291: THE PIN MUST COME FROM THE PROJECTION, NOT FROM A HAND-BUILT CONFIG. Cases 7 and 8 pass a config that
// already names the vault; a client built from the NETWORK NAME is the shape a library caller uses, and it had no
// vault at all, so every relay quote ended as `no-pinned-cashier`.
console.log("=== 8b) A CLIENT BUILT FROM THE NETWORK NAME CARRIES THE NETWORK'S VAULT ===");
{
  const deployed = deploymentFor("arbitrum-sepolia").escrow;
  const facade = createNinsei({
    settlement: { chain: "arbitrum-sepolia" },
    xmrNetwork: "stagenet",
    evmCall: chainReads(),
    // THE FACTORY AND IMPLEMENTATION POLICY IS NOT THIS CASE'S SUBJECT: an explicit empty list means "no policy"
    // on purpose, so the vault pin is the only thing the answer is judged by here.
    knownFactoryCodes: [],
    knownImplementationCodes: [],
  });
  const projected = (facade.config.settlement.chain.escrow || {}).cashier;
  if (String(projected || "").toLowerCase() === String(deployed.cashier).toLowerCase()) {
    ok("the network projection carries the deployed vault");
  } else {
    bad("a client built from the chain name has cashier " + JSON.stringify(projected));
  }
  const networkFeatures = nodeFeatures({ registry: deployed.registry });
  const relayCall = (fetchImpl) => facade.quotes.firmRelay({ ...baseRequest, features: networkFeatures, order, fetchImpl });
  try {
    await relayCall(relayFetch().fetchImpl);
    ok("a valid relay answer is accepted by a client built from the chain name");
  } catch (error) {
    bad("a client built from the chain name refused a valid answer: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }
  try {
    await relayCall(relayFetch({ cashierAddress: "0x" + "66".repeat(20) }).fetchImpl);
    bad("a quote naming another vault passed on a client built from the chain name");
  } catch (error) {
    if (error && error.code === "quote-cashier-mismatch") ok("a quote naming another vault is refused on a client built from the chain name");
    else bad("wrong foreign-vault code on a client built from the chain name: " + JSON.stringify(error && (error.code || error.message)));
  }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "relay adapter: " + pass + " checks passed.");
if (fails.length) process.exit(1);
