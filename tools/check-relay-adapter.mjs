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
import { relayQuoteDigest } from "../src/relayQuote.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";
import { createQuotes } from "../src/quotes.mjs";
import * as engine from "../src/engine.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { createRecoveryKey, takerHalvesV2 } from "../src/recovery-key.mjs";

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
const provider = "0x" + "a1".repeat(20);
const registry = "0x" + "c3".repeat(20);
const user = "0x" + "b2".repeat(20);
const factory = "0x" + "11".repeat(20);
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
const features = (() => {
  const base = {
    type: "node_features", version: 1, relayId: "test-relay", provider, quoteKey, registry,
    hpkeKey: hpkePublic, firmWindows: [window("ask"), window("bid")],
    time: nowSec - 10, nonce: "0x" + "07".repeat(32),
  };
  const sig = secp256k1.sign(nodeFeaturesDigest(base), quotePrivate, { format: "recovered", prehash: false });
  return {
    ...base,
    signature: "0x" + Buffer.from(sig.slice(1, 33)).toString("hex")
      + Buffer.from(sig.slice(33, 65)).toString("hex")
      + (27 + sig[0]).toString(16),
  };
})();

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
function answerFor(payload, { tamperProof = false } = {}) {
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
    cashier: "0x" + "55".repeat(20),
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
    validUntil: String(nowSec + 3600),
    nonce: "1",
    xmrAmount: payload.terms.xmrAmount,
    claimTip: payload.terms.claimTip,
    factory: orderTerm.factory,
  };
  quote.quoteSignature = signQuoteDigest({
    crypto: { keccak256, secp256k1 },
    digest: quoteDigest({ crypto: { keccak256, secp256k1 }, quote }),
    privateKey: hex(quotePrivate),
  });
  const inner = {
    factory: orderTerm.factory,
    quoteVersion: 9,
    contextVersion: "ninsei-order-v3",
    context,
    quote,
    quoteSignature: quote.quoteSignature,
    nodeHalf,
    edViewPointLocker: ask ? payload.edViewPointClient : nodeSide.viewPoint,
    edViewPointClaimer: ask ? nodeSide.viewPoint : payload.edViewPointClient,
  };
  const answer = {
    type: "quote", version: 1, relayId: "test-relay", provider: payload.terms.maker,
    session: "0x" + "01".repeat(32), requestId: "0x" + "02".repeat(32), counter: "7",
    requestHash: "0x" + "03".repeat(32), payload: JSON.stringify(inner), time: nowSec,
  };
  answer.signature = signRelay(answer);
  return {
    version: 1, relay: "test-relay", offered: 1, forwarded: { relayId: "test-relay" },
    answer,
  };
}

function relayFetch({ tamperProof = false } = {}) {
  const bodies = [];
  return {
    bodies,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const payload = JSON.parse(body.payload);
      return { ok: true, status: 200, json: async () => answerFor(payload, { tamperProof }) };
    },
  };
}

function makeQuotes({ providerWord = provider, factoryWord = factory } = {}) {
  return createQuotes({
    config: {},
    now: () => nowSec * 1000,
    evmCall: async ({ data }) => {
      if (data.startsWith(providerSelector)) return word(providerWord);
      if (data.startsWith(factorySelector)) return word(factoryWord);
      if (data.startsWith(engine.evm.FACTORY_METHODS.predict)) return word(predictedEscrow);
      throw new Error("unexpected chain call");
    },
    evmBlock: async () => ({ baseFeePerGas: "0" }),
  });
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
} catch (error) { bad("valid adapter call failed: " + JSON.stringify(error && (error.code || error.message)) + " " + JSON.stringify(error && error.params)); }

console.log("=== 2) THE BID SIDE KEEPS THE PROVIDER AS LOCKER ===");
const bidOrder = { ...order, locker: provider, claimer: user };
try {
  const result = await call(makeQuotes(), { order: bidOrder, side: "bid", fetchImpl: relayFetch().fetchImpl });
  if (result.quote.locker === provider && result.quote.claimer === user) ok("the bid quote carries the provider as locker");
  else bad("unexpected bid roles: " + JSON.stringify({ locker: result.quote.locker, claimer: result.quote.claimer }));
  if (result.viewHalfClaimer === derived.makerViewHalf) ok("the bid uses the same derived maker view half");
  else bad("the bid maker view half is not derived");
} catch (error) { bad("valid bid call failed: " + JSON.stringify(error && (error.code || error.message)) + " " + JSON.stringify(error && error.params)); }

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
const refusal = { fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ version: 1, code: "price_changed" }) }) };
try {
  await call(makeQuotes(), refusal);
  bad("a refusal passed");
} catch (error) {
  if (error && error.code === "quote-refused" && error.params && error.params.code === "price_changed") ok("the relay refusal keeps its code");
  else bad("wrong refusal: " + JSON.stringify(error && (error.code || error.message)));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "relay adapter: " + pass + " checks passed.");
if (fails.length) process.exit(1);
