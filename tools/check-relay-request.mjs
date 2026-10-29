#!/usr/bin/env node
// ONE FIRM REQUEST BUILT AND OPENED AGAIN.
//
// The request builder is the join between the signed features, the client half and the HPKE envelope. The test
// signs a features object with a test quote key, builds the request for both sides, and opens the envelope with
// the recipient key. It also checks the connection between the envelope context and the signed terms.
//
// Run: node tools/check-relay-request.mjs
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { keccak256, secp256k1 } from "../src/primitives.mjs";
import { nodeFeaturesDigest } from "../src/relayFeatures.mjs";
import { buildFirmRequest } from "../src/relayRequest.mjs";
import { firmTermsDigest } from "../src/relayTerms.mjs";
import { openViewEnvelope, relayViewInfo } from "../src/relayView.mjs";
import { takerHalves } from "../src/recovery-key.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});
const hpke = await suite.kem.generateKeyPair(true);
const hpkePublic = hex(await suite.kem.serializePublicKey(hpke.publicKey));
const hpkePrivate = hex(await suite.kem.serializePrivateKey(hpke.privateKey));
const quotePrivate = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const quoteKey = (() => {
  const publicKey = secp256k1.Point.BASE.multiply(BigInt(hex(quotePrivate))).toBytes(false);
  return hex(keccak256(publicKey.slice(1)).slice(12));
})();
const provider = "0x" + "a1".repeat(20);
const registry = "0x" + "c3".repeat(20);

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
const baseFeatures = {
  type: "node_features",
  version: 1,
  relayId: "ninsei-1",
  provider,
  quoteKey,
  registry,
  hpkeKey: hpkePublic,
  firmWindows: [window("ask"), window("bid")],
  time: 1_800_000_000,
  nonce: "0x" + "07".repeat(32),
};
function signedFeatures(changes = {}) {
  const features = { ...baseFeatures, ...changes };
  const digest = nodeFeaturesDigest(features);
  const sig = secp256k1.sign(digest, quotePrivate, { format: "recovered", prehash: false });
  return {
    features: { ...features, signature: "0x" + Buffer.from(sig.slice(1, 33)).toString("hex") + Buffer.from(sig.slice(33, 65)).toString("hex") + (27 + sig[0]).toString(16) },
    digest: hex(digest),
  };
}

const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const halves = takerHalves({ mnemonic: words, chainId: 421614, index: 0 });
const order = {
  chainId: 421614,
  factory: "0x" + "11".repeat(20),
  locker: "0x" + "22".repeat(20),
  claimer: "0x" + "33".repeat(20),
  amount: "1000",
  readyBy: 2_000_000_000,
  t1: 2_000_003_600,
  salt: "0x" + "44".repeat(32),
};
const orderFor = (sideName) => ({ ...order, ...(sideName === "ask" ? { claimer: provider } : { locker: provider }) });
const sideFor = (sideName) => {
  const side = buildOwnSideFromHalves(orderFor(sideName), { spendHalf: halves.spendHalf, viewHalf: halves.viewHalf }).side;
  const xa = secp256k1.Point.fromHex(side.proof.XA);
  return {
    side,
    clientHalf: { commitHalf: hex(keccak256(xa.toBytes(false).slice(1))), edPoint: side.pub.ed, proof: side.proof },
  };
};
const askSide = sideFor("ask");
const bidSide = sideFor("bid");
const baseTerms = (sideName, featuresHash) => ({
  market: "421614:ETH",
  side: sideName,
  maker: provider,
  registry,
  featuresHash,
  xmrNetwork: "stagenet",
  order: {
    chainId: "421614",
    factory: order.factory,
    locker: sideName === "ask" ? order.locker : provider,
    claimer: sideName === "ask" ? provider : order.claimer,
    amount: order.amount,
    readyBy: order.readyBy,
    t1: order.t1,
    salt: order.salt,
  },
  xmrAmount: "1000000000000",
  claimTip: "0",
});

function open(payload, featuresDigest) {
  const termDigest = hex(firmTermsDigest({ crypto: { keccak256 }, terms: payload.terms }));
  const info = relayViewInfo({
    termsDigest: termDigest,
    commitHalf: payload.clientHalf.commitHalf,
    edPoint: payload.clientHalf.edPoint,
    edViewPointClient: payload.edViewPointClient,
    edViewPointNode: payload.edViewPointNode,
  });
  return openViewEnvelope({
    privateKey: hpkePrivate,
    enc: payload.viewEnvelope.enc,
    ciphertext: payload.viewEnvelope.ciphertext,
    info,
  });
}

console.log("=== 1) ASK: ONE VIEW SCALAR ===");
const askFeatures = signedFeatures();
const askRequest = await buildFirmRequest({
  features: askFeatures.features,
  terms: baseTerms("ask", askFeatures.digest),
  clientHalf: askSide.clientHalf,
  edViewPointClient: askSide.side.viewPub,
  edViewPointNode: halves.makerViewPoint,
  nodeViewScalar: halves.makerViewHalf,
  side: "ask",
});
if (askRequest.payload.length > 2 && JSON.parse(askRequest.payload).terms.featuresHash === askFeatures.digest) {
  ok("the ask payload carries the verified features hash");
} else bad("ask payload: " + askRequest.payload.slice(0, 200));
try {
  const opened = await open(JSON.parse(askRequest.payload), askFeatures.digest);
  if (opened.length === 32 && hex(opened) === halves.makerViewHalf.toLowerCase()) ok("the ask envelope opens to the node's view scalar");
  else bad("ask plaintext: " + hex(opened));
} catch (error) { bad("ask envelope: " + JSON.stringify(error && (error.code || error.message))); }

console.log("=== 2) BID: TWO VIEW SCALARS ===");
const bidFeatures = signedFeatures();
const clientViewHex = "0x" + bidSide.side.viewHalf.toString(16).padStart(64, "0");
const bidRequest = await buildFirmRequest({
  features: bidFeatures.features,
  terms: baseTerms("bid", bidFeatures.digest),
  clientHalf: bidSide.clientHalf,
  edViewPointClient: bidSide.side.viewPub,
  edViewPointNode: halves.makerViewPoint,
  nodeViewScalar: halves.makerViewHalf,
  clientViewScalar: clientViewHex,
  side: "bid",
});
try {
  const opened = await open(JSON.parse(bidRequest.payload), bidFeatures.digest);
  const want = Buffer.from(halves.makerViewHalf.replace(/^0x/, "") + clientViewHex.replace(/^0x/, ""), "hex");
  if (opened.length === 64 && Buffer.from(opened).equals(want)) ok("the bid envelope opens to both view scalars");
  else bad("bid plaintext: " + hex(opened));
} catch (error) { bad("bid envelope: " + JSON.stringify(error && (error.code || error.message))); }

console.log("=== 3) A DIFFERENT VIEW POINT OR FEATURES IS REFUSED ===");
for (const [label, request] of [
  ["a view point not derived from its scalar", () => buildFirmRequest({
    features: askFeatures.features, terms: baseTerms("ask", askFeatures.digest), clientHalf: askSide.clientHalf,
    edViewPointClient: askSide.side.viewPub, edViewPointNode: "0x" + "00".repeat(32),
    nodeViewScalar: halves.makerViewHalf, side: "ask",
  })],
  ["a features signature from another key", () => buildFirmRequest({
    features: { ...askFeatures.features, quoteKey: "0x" + "03".repeat(20) },
    terms: baseTerms("ask", askFeatures.digest), clientHalf: askSide.clientHalf,
    edViewPointClient: askSide.side.viewPub, edViewPointNode: halves.makerViewPoint,
    nodeViewScalar: halves.makerViewHalf, side: "ask",
  })],
  ["a features hash that does not match", () => buildFirmRequest({
    features: askFeatures.features, terms: baseTerms("ask", "0x" + "00".repeat(32)), clientHalf: askSide.clientHalf,
    edViewPointClient: askSide.side.viewPub, edViewPointNode: halves.makerViewPoint,
    nodeViewScalar: halves.makerViewHalf, side: "ask",
  })],
  ["a half whose point is not its proof", () => buildFirmRequest({
    features: askFeatures.features, terms: baseTerms("ask", askFeatures.digest),
    clientHalf: { ...askSide.clientHalf, edPoint: "0x" + "00".repeat(32) },
    edViewPointClient: askSide.side.viewPub, edViewPointNode: halves.makerViewPoint,
    nodeViewScalar: halves.makerViewHalf, side: "ask",
  })],
  ["an ask whose claimer is not the maker", () => buildFirmRequest({
    features: askFeatures.features,
    terms: { ...baseTerms("ask", askFeatures.digest), order: { ...baseTerms("ask", askFeatures.digest).order, claimer: order.claimer } },
    clientHalf: askSide.clientHalf, edViewPointClient: askSide.side.viewPub,
    edViewPointNode: halves.makerViewPoint, nodeViewScalar: halves.makerViewHalf, side: "ask",
  })],
  ["a bid whose locker is not the maker", () => buildFirmRequest({
    features: bidFeatures.features,
    terms: { ...baseTerms("bid", bidFeatures.digest), order: { ...baseTerms("bid", bidFeatures.digest).order, locker: order.locker } },
    clientHalf: bidSide.clientHalf, edViewPointClient: bidSide.side.viewPub,
    edViewPointNode: halves.makerViewPoint, nodeViewScalar: halves.makerViewHalf,
    clientViewScalar: clientViewHex, side: "bid",
  })],
  ["an ask with a claim tip", () => buildFirmRequest({
    features: askFeatures.features,
    terms: { ...baseTerms("ask", askFeatures.digest), claimTip: "1" },
    clientHalf: askSide.clientHalf, edViewPointClient: askSide.side.viewPub,
    edViewPointNode: halves.makerViewPoint, nodeViewScalar: halves.makerViewHalf, side: "ask",
  })],
]) {
  try { await request(); bad(label + " was accepted"); }
  catch (error) {
    if (error && (error.code === "bad-input" || error.code === "quote-refused")) ok(label + " is refused");
    else bad(label + " gave " + JSON.stringify(error && (error.code || error.message)));
  }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "relay request: " + pass + " checks passed.");
if (fails.length) process.exit(1);
