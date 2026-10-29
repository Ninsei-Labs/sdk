#!/usr/bin/env node
// THE ONE HTTP HOP: BUILD, POST, VERIFY.
//
// A fake transport returns a real answer signed by a test quote key. The check covers the success path, a
// relay refusal, a malformed envelope, an expired quote and a transport failure. The request is built by the
// production builder, so the payload that goes over the wire is the exact one the relay would verify.
//
// Run: node tools/check-relay-http.mjs
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keccak256, secp256k1 } from "../src/primitives.mjs";
import { nodeFeaturesDigest } from "../src/relayFeatures.mjs";
import { buildFirmRequest } from "../src/relayRequest.mjs";
import { relayQuoteDigest } from "../src/relayQuote.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";
import * as engine from "../src/engine.mjs";
import { requestFirmQuote } from "../src/relayFirmClient.mjs";
import { takerHalves } from "../src/recovery-key.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";

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
const nowSec = Math.floor(Date.now() / 1000);
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");

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
  type: "node_features", version: 1, relayId: "test-relay", provider, quoteKey, registry,
  capabilities: ["firm/1"], hpkeKey: hpkePublic, firmWindows: [window("ask"), window("bid")],
  time: nowSec - 10, nonce: "0x" + "07".repeat(32),
};
function signedFeatures() {
  const features = { ...baseFeatures };
  const sig = secp256k1.sign(nodeFeaturesDigest(features), quotePrivate, { format: "recovered", prehash: false });
  return {
    ...features,
    signature: "0x" + Buffer.from(sig.slice(1, 33)).toString("hex")
      + Buffer.from(sig.slice(33, 65)).toString("hex")
      + (27 + sig[0]).toString(16),
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
  readyBy: nowSec + 1800,
  t1: nowSec + 3600,
  salt: "0x" + "44".repeat(32),
};
const askOrder = { ...order, claimer: provider };
const askSide = (() => {
  const side = buildOwnSideFromHalves(askOrder, { spendHalf: halves.spendHalf, viewHalf: halves.viewHalf }).side;
  const xa = secp256k1.Point.fromHex(side.proof.XA);
  return {
    side,
    clientHalf: { commitHalf: hex(keccak256(xa.toBytes(false).slice(1))), edPoint: side.pub.ed, proof: side.proof },
  };
})();
const features = signedFeatures();
const terms = {
  market: "421614:ETH",
  side: "ask",
  maker: provider,
  registry,
  featuresHash: hex(nodeFeaturesDigest(features)),
  xmrNetwork: "stagenet",
  order: {
    chainId: String(order.chainId), factory: order.factory, locker: order.locker, claimer: provider,
    amount: order.amount, readyBy: order.readyBy, t1: order.t1, salt: order.salt,
  },
  xmrAmount: "1000000000000",
  claimTip: "0",
};
const built = await buildFirmRequest({
  features,
  terms,
  clientHalf: askSide.clientHalf,
  edViewPointClient: askSide.side.viewPub,
  edViewPointNode: halves.makerViewPoint,
  nodeViewScalar: halves.makerViewHalf,
  side: "ask",
});

const bidSide = (() => {
  const bidOrder = { ...order, locker: provider };
  const side = buildOwnSideFromHalves(bidOrder, { spendHalf: halves.spendHalf, viewHalf: halves.viewHalf }).side;
  const xa = secp256k1.Point.fromHex(side.proof.XA);
  return {
    side,
    clientHalf: { commitHalf: hex(keccak256(xa.toBytes(false).slice(1))), edPoint: side.pub.ed, proof: side.proof },
  };
})();
const bidTerms = {
  ...terms,
  side: "bid",
  order: { ...terms.order, locker: provider, claimer: order.claimer },
};
const bidBuilt = await buildFirmRequest({
  features,
  terms: bidTerms,
  clientHalf: bidSide.clientHalf,
  edViewPointClient: bidSide.side.viewPub,
  edViewPointNode: halves.makerViewPoint,
  nodeViewScalar: halves.makerViewHalf,
  clientViewScalar: bidSide.side.viewHalf.toString(),
  side: "bid",
});

const crypto = { keccak256, secp256k1 };
function signRelay(answer) {
  const sig = secp256k1.sign(relayQuoteDigest(answer), quotePrivate, { format: "recovered", prehash: false });
  return "0x" + Buffer.from(sig.slice(1, 33)).toString("hex")
    + Buffer.from(sig.slice(33, 65)).toString("hex")
    + (27 + sig[0]).toString(16);
}
function makeAnswer(source, { validUntil = nowSec + 3600 } = {}) {
  const nodeHalf = { commitHalf: "0x" + "77".repeat(32), edPoint: "0x" + "88".repeat(32), proof: { synthetic: true } };
  const ask = source.terms.side === "ask";
  const quote = {
    provider: source.terms.maker,
    quoteKey,
    registry: source.terms.registry,
    cashier: "0x" + "55".repeat(20),
    locker: source.terms.order.locker,
    claimer: source.terms.order.claimer,
    amount: source.terms.order.amount,
    readyBy: source.terms.order.readyBy,
    t1: source.terms.order.t1,
    salt: source.terms.order.salt,
    commitHalfClaimer: ask ? nodeHalf.commitHalf : "0x" + "aa".repeat(32),
    edPointClaimer: ask ? nodeHalf.edPoint : "0x" + "bb".repeat(32),
    chainId: source.terms.order.chainId,
    feeBps: "0",
    fee: "0",
    feeRecipient: "0x" + "99".repeat(20),
    validUntil: String(validUntil),
    nonce: "1",
    xmrAmount: source.terms.xmrAmount,
    claimTip: source.terms.claimTip,
    factory: source.terms.order.factory,
  };
  quote.quoteSignature = signQuoteDigest({
    crypto,
    digest: quoteDigest({ crypto, quote }),
    privateKey: hex(quotePrivate),
  });
  const payload = {
    factory: source.terms.order.factory,
    quoteVersion: 9,
    contextVersion: "ninsei-order-v3",
    context: engine.orderContext.orderContextString(source.terms.order),
    quote,
    quoteSignature: quote.quoteSignature,
    nodeHalf,
    edViewPointLocker: ask ? source.edViewPointClient : source.edViewPointNode,
    edViewPointClaimer: ask ? source.edViewPointNode : source.edViewPointClient,
  };
  const answer = {
    type: "quote", version: 1, relayId: "test-relay", provider: source.terms.maker,
    session: "0x" + "01".repeat(32), requestId: "0x" + "02".repeat(32), counter: "7",
    requestHash: "0x" + "03".repeat(32), payload: JSON.stringify(payload), time: nowSec,
  };
  answer.signature = signRelay(answer);
  return answer;
}

function fakeFetch({ ok = true, status = 200, body = null, error = null } = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (error) throw error;
      return { ok, status, json: async () => body };
    },
  };
}

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };
const requestBase = {
  features,
  terms,
  clientHalf: askSide.clientHalf,
  edViewPointClient: askSide.side.viewPub,
  edViewPointNode: halves.makerViewPoint,
  nodeViewScalar: halves.makerViewHalf,
  side: "ask",
};
const call = (overrides = {}) => requestFirmQuote({
  relayUrl: "https://relay.example/",
  partner: "partner-a",
  ...requestBase,
  ...overrides,
});

console.log("=== 1) A SIGNED ANSWER GOES THROUGH THE WIRE ===");
const success = fakeFetch({ body: { version: 1, relay: "test-relay", offered: true, forwarded: true, answer: makeAnswer(built) } });
try {
  const result = await call({ fetchImpl: success.fetchImpl });
  if (result.quote.amount === built.terms.order.amount && result.answer.type === "quote") ok("the answer is verified and returned");
  else bad("the returned answer did not carry the quote");
  const sent = success.calls[0];
  if (sent && sent.url === "https://relay.example/v1/quote") ok("the endpoint is POST <relay>/v1/quote");
  else bad("unexpected endpoint: " + (sent && sent.url));
  const sentBody = JSON.parse(sent.init.body);
  const sentPayload = JSON.parse(sentBody.payload);
  if (sentBody.version === 1 && sentBody.partner === "partner-a"
    && JSON.stringify(sentPayload.terms) === JSON.stringify(built.terms)
    && sentPayload.viewEnvelope && sentPayload.clientHalf
    && typeof sentBody.payload === "string") {
    ok("the payload string and the partner label are sent exactly");
  } else bad("the request body changed: " + JSON.stringify(Object.keys(sentBody)));
} catch (error) { bad("valid answer refused: " + JSON.stringify(error && (error.code || error.message))); }

console.log("=== 1b) A BID ANSWER PLACES THE NODE AS LOCKER ===");
const bidSuccess = fakeFetch({ body: { version: 1, answer: makeAnswer(bidBuilt) } });
try {
  const result = await requestFirmQuote({
    relayUrl: "https://relay.example",
    fetchImpl: bidSuccess.fetchImpl,
    features,
    terms: bidTerms,
    clientHalf: bidSide.clientHalf,
    edViewPointClient: bidSide.side.viewPub,
    edViewPointNode: halves.makerViewPoint,
    nodeViewScalar: halves.makerViewHalf,
    clientViewScalar: bidSide.side.viewHalf.toString(),
    side: "bid",
  });
  if (result.quote.locker === provider && result.quote.claimer === order.claimer && result.quote.amount === order.amount) {
    ok("the bid is verified with the node as locker and the client as claimer");
  } else bad("the bid roles changed: " + JSON.stringify({ locker: result.quote.locker, claimer: result.quote.claimer }));
} catch (error) { bad("valid bid answer refused: " + JSON.stringify(error && (error.code || error.message))); }

console.log("=== 2) REFUSALS KEEP THEIR CODE ===");
const refused = fakeFetch({ ok: false, status: 409, body: { code: "price_changed" } });
try {
  await call({ fetchImpl: refused.fetchImpl });
  bad("a price_changed refusal passed");
} catch (error) {
  if (error && error.code === "quote-refused" && error.params && error.params.code === "price_changed") {
    ok("price_changed is returned as quote-refused with its code");
  } else bad("wrong refusal: " + JSON.stringify(error && (error.code || error.message)));
}

console.log("=== 3) A MALFORMED ENVELOPE AND AN EXPIRED QUOTE ===");
const malformed = fakeFetch({ body: { version: 1 } });
try {
  await call({ fetchImpl: malformed.fetchImpl });
  bad("a missing answer passed");
} catch (error) {
  if (error && error.code === "quote-refused" && error.params && error.params.why === "envelope") ok("a missing answer is refused");
  else bad("wrong malformed-envelope code: " + JSON.stringify(error && (error.code || error.message)));
}
const expired = fakeFetch({ body: { version: 1, answer: makeAnswer(built, { validUntil: nowSec - 1 }) } });
try {
  await call({ fetchImpl: expired.fetchImpl });
  bad("an expired quote passed");
} catch (error) {
  if (error && error.code === "quote-expired") ok("an expired quote is refused");
  else bad("wrong expiry code: " + JSON.stringify(error && (error.code || error.message)));
}

console.log("=== 4) A TRANSPORT FAILURE IS NOT A REFUSAL ===");
const transport = fakeFetch({ error: new Error("connection reset") });
try {
  await call({ fetchImpl: transport.fetchImpl });
  bad("a transport failure passed");
} catch (error) {
  if (error && error.code === "server-unavailable" && error.params && error.params.why === "fetch") {
    ok("a transport failure is server-unavailable");
  } else bad("wrong transport code: " + JSON.stringify(error && (error.code || error.message)));
}

console.log("=== 5) BREAKING RUN: A DROPPED REFUSAL CODE IS CAUGHT ===");
{
  const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "relayFirmClient.mjs");
  const sourceDir = dirname(sourcePath);
  const temp = mkdtempSync(join(tmpdir(), "relay-http-"));
  try {
    const source = readFileSync(sourcePath, "utf8")
      .replace(/from "\.\/([^"]+)"/g, (_, name) => `from "${pathToFileURL(join(sourceDir, name)).href}"`);
    const mutated = source.replace(
      /const REFUSAL_CODES = new Set\([^)]*\);/,
      "const REFUSAL_CODES = new Set();",
    );
    if (mutated === source) throw new Error("mutation anchor missing");
    const copy = join(temp, "relayFirmClient.mjs");
    writeFileSync(copy, mutated);
    const broken = await import(pathToFileURL(copy).href + "?run=" + Date.now());
    const refusal = fakeFetch({ ok: false, status: 409, body: { code: "price_changed" } });
    try {
      await broken.requestFirmQuote({ relayUrl: "https://relay.example/", ...requestBase, fetchImpl: refusal.fetchImpl });
      bad("a dropped refusal code passed");
    } catch (error) {
      if (error && error.code === "server-unavailable") ok("dropping price_changed reddens the refusal mapping");
      else bad("a dropped refusal code was not caught: " + JSON.stringify(error && (error.code || error.message)));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "relay http: " + pass + " checks passed.");
if (fails.length) process.exit(1);
