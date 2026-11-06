#!/usr/bin/env node
// REGENERATE THE RELAY-ANSWER WIRE VECTOR.
//
// The fixture carries real proofs, so it cannot be hand-edited: a changed point invalidates the inner quote, the outer
// frame and every expected digest. This generator uses a small seed file for the order terms, keys and quote scalars,
// then derives the context, quote fields, both sides, proofs, signatures and digests. `--check` compares the generated
// bytes with the committed fixture; any drift is a red check.
//
// Run: node tools/gen-relay-answer.mjs [--write|--check]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, primitives, secp256k1 } from "../src/primitives.mjs";
import { createOrderBuilder } from "../engine/atomic/order.js";
import { orderContextString } from "../engine/atomic/orderContext.js";
import { ORDER_QUOTE_TYPE, quoteDigest, quoteStructHash, signQuoteDigest } from "../src/quoteEip712Spec.mjs";
import { RELAY_QUOTE_TYPE, relayQuoteDigest, relayQuoteStructHash } from "../src/relayQuote.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "fixtures", "relay-answer.json");
const SEED_FILE = join(here, "fixtures", "relay-answer.seed.json");

// A deterministic byte source. The proof uses nonces, and without a fixed source two runs would produce different
// fixtures even with the same halves; the check would then be unable to distinguish a real edit from randomness.
function deterministicPrimitives() {
  let counter = 0;
  const randomBytes = (length) => {
    const out = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      const block = keccak256(new TextEncoder().encode("ninsei-relay-answer-fixture|" + counter++));
      const take = Math.min(block.length, length - at);
      out.set(block.subarray(0, take), at);
      at += take;
    }
    return out;
  };
  return { ...primitives, randomBytes };
}

function scalar(tag) { return BigInt("0x01" + tag.repeat(31)); }

export function buildRelayAnswerFixture({ seed: seedOverride = null } = {}) {
  const seed = seedOverride ?? JSON.parse(readFileSync(SEED_FILE, "utf8"));
  const terms = seed.terms;
  const context = orderContextString(terms.order);
  const builder = createOrderBuilder(deterministicPrimitives());
  const side = (tag) => {
    const half = scalar(tag + "1");
    const viewHalf = scalar(tag + "2");
    const pub = builder.halves.publicHalves(half);
    const view = builder.pointOf(viewHalf);
    const proof = builder.dleq.prove(half, context);
    if (String(proof.XB).toLowerCase() !== String(pub.ed).toLowerCase()) throw new Error("generated proof ed mismatch");
    return { half, pub, view, proof, commitHalf: builder.halfCommitment(half) };
  };
  const client = side("2");
  const node = side("3");
  const quoteKey = "0x" + Buffer.from(keccak256(secp256k1.Point.BASE.multiply(BigInt(seed.keys.quote)).toBytes(false).slice(1)).slice(12)).toString("hex");
  const quote = {
    provider: terms.maker,
    quoteKey,
    registry: terms.registry,
    cashier: seed.quote.cashier,
    locker: terms.order.locker,
    claimer: terms.order.claimer,
    amount: terms.order.amount,
    readyBy: terms.order.readyBy,
    t1: terms.order.t1,
    salt: terms.order.salt,
    commitHalfClaimer: node.commitHalf,
    edPointClaimer: node.pub.ed,
    chainId: terms.order.chainId,
    feeBps: seed.quote.feeBps,
    fee: (BigInt(terms.order.amount) * BigInt(seed.quote.feeBps) / 10000n).toString(),
    feeRecipient: seed.quote.feeRecipient,
    validUntil: seed.quote.validUntil,
    nonce: seed.quote.nonce,
    xmrAmount: terms.xmrAmount,
    claimTip: terms.claimTip,
    commitHalfLocker: client.commitHalf,
    edPointLocker: client.pub.ed,
    edViewPointLocker: client.view,
    factory: terms.order.factory,
  };
  const payload = {
    factory: terms.order.factory,
    quoteVersion: seed.quote.quoteVersion,
    contextVersion: seed.quote.contextVersion,
    context,
    quote,
    quoteSignature: "",
    nodeHalf: { commitHalf: node.commitHalf, edPoint: node.pub.ed, proof: node.proof },
    edViewPointLocker: client.view,
    edViewPointClaimer: node.view,
  };
  const answer = {
    type: "quote",
    version: 1,
    relayId: seed.relay.relayId,
    provider: terms.maker,
    session: seed.relay.session,
    requestId: seed.relay.requestId,
    counter: seed.relay.counter,
    requestHash: seed.relay.requestHash,
    payload: "",
    time: seed.now,
    signature: "",
  };
  const quoteSignature = signQuoteDigest({
    crypto: primitives,
    digest: quoteDigest({ crypto: primitives, quote }),
    privateKey: seed.keys.quote,
  });
  payload.quoteSignature = quoteSignature;
  answer.payload = JSON.stringify(payload);

  const relaySig = secp256k1.sign(relayQuoteDigest(answer),
    Buffer.from(String(seed.keys.quote).replace(/^0x/, ""), "hex"),
    { format: "recovered", prehash: false });
  answer.signature = "0x" + Buffer.from(relaySig.slice(1, 33)).toString("hex")
    + Buffer.from(relaySig.slice(33, 65)).toString("hex") + (27 + relaySig[0]).toString(16);

  const fixture = {
    about: seed.about,
    now: seed.now,
    keys: seed.keys,
    request: {
      terms,
      clientHalf: { commitHalf: client.commitHalf, edPoint: client.pub.ed, proof: client.proof },
      edViewPointClient: client.view,
      edViewPointNode: node.view,
      viewEnvelope: seed.viewEnvelope,
    },
    answer,
    requestExpected: seed.requestExpected,
    answerExpected: {
      typeString: RELAY_QUOTE_TYPE,
      structHash: "0x" + Buffer.from(relayQuoteStructHash(answer)).toString("hex"),
      digest: "0x" + Buffer.from(relayQuoteDigest(answer)).toString("hex"),
      signature: answer.signature,
    },
    quoteExpected: {
      typeString: ORDER_QUOTE_TYPE,
      structHash: "0x" + Buffer.from(quoteStructHash({ crypto: primitives, quote })).toString("hex"),
      digest: "0x" + Buffer.from(quoteDigest({ crypto: primitives, quote })).toString("hex"),
      signature: quoteSignature,
    },
  };
  return JSON.stringify(fixture, null, 2) + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const generated = buildRelayAnswerFixture();
  if (process.argv.includes("--check")) {
    const current = readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
    if (current !== generated) {
      console.error("relay-answer fixture is stale; run node tools/gen-relay-answer.mjs --write");
      process.exit(1);
    }
    console.log("relay-answer fixture is reproducible");
  } else if (process.argv.includes("--write")) {
    writeFileSync(FILE, generated);
    console.log("wrote " + FILE);
  } else {
    console.error("usage: node tools/gen-relay-answer.mjs [--write|--check]");
    process.exit(2);
  }
}
