#!/usr/bin/env node
// THE SIGNED ANSWER, CHECKED AGAINST THE RELAY'S OWN VECTOR.
//
// The outer frame and the inner OrderQuote are signed by different keys. This check verifies both, the request
// correlation, the fee arithmetic, the context and the view points, then breaks one field at a time.
//
// Run: node tools/check-relay-answer.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256, secp256k1 } from "../src/primitives.mjs";
import { relayQuoteDigest, verifyFirmAnswer, verifyRelayQuoteFrame } from "../src/relayQuote.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "relay-answer.json"), "utf8"));
const answer = fixture.answer;
const quoteKey = (() => {
  const privateKey = String(fixture.keys.quote).replace(/^0x/, "");
  const publicKey = secp256k1.Point.BASE.multiply(BigInt("0x" + privateKey)).toBytes(false);
  return "0x" + Buffer.from(keccak256(publicKey.slice(1)).slice(12)).toString("hex");
})();
const request = {
  terms: fixture.request.terms,
  edViewPointClient: fixture.request.edViewPointClient,
  edViewPointNode: fixture.request.edViewPointNode,
};
const features = { quoteKey };

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");

console.log("=== 1) THE OUTER FRAME MATCHES THE VECTOR ===");
if (hex(relayQuoteDigest(answer)) === fixture.answerExpected.digest) ok("the outer digest matches the relay vector");
else bad("outer digest: " + hex(relayQuoteDigest(answer)));
try {
  verifyRelayQuoteFrame(answer, quoteKey);
  ok("the outer signature recovers the quote key");
} catch (error) { bad("outer signature: " + JSON.stringify(error && (error.code || error.message))); }

console.log("=== 2) THE ANSWER BINDS THE REQUEST ===");
try {
  const verified = verifyFirmAnswer({ answer, features, request, now: fixture.now });
  if (verified.quote.xmrAmount === fixture.request.terms.xmrAmount
    && verified.orderQuote.quoteSignature === JSON.parse(answer.payload).quoteSignature) {
    ok("the inner quote is bound to the terms and its signature");
  } else bad("verified quote: " + JSON.stringify(verified.quote));
} catch (error) { bad("valid answer refused: " + JSON.stringify(error && (error.code || error.params || error.message))); }

console.log("=== 3) A CHANGED FIELD IS REFUSED ===");
for (const [label, change] of [
  ["a changed provider", { provider: "0x" + "01".repeat(20) }],
  ["a changed signature", { signature: "0x" + "00".repeat(65) }],
  ["a changed payload", { payload: answer.payload + " " }],
]) {
  try { verifyRelayQuoteFrame({ ...answer, ...change }, quoteKey); bad(label + " passed the outer check"); }
  catch { ok(label + " is refused by the outer signature"); }
}
const changedQuote = JSON.parse(answer.payload);
changedQuote.quote.amount = "1";
try {
  verifyFirmAnswer({ answer: { ...answer, payload: JSON.stringify(changedQuote) }, features, request, now: fixture.now });
  bad("a changed inner amount passed");
} catch { ok("a changed inner amount is refused"); }
const changedContext = JSON.parse(answer.payload);
changedContext.context = "other";
try {
  verifyFirmAnswer({ answer: { ...answer, payload: JSON.stringify(changedContext) }, features, request, now: fixture.now });
  bad("a changed context passed");
} catch { ok("a changed context is refused"); }

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "relay answer: " + pass + " checks passed.");
if (fails.length) process.exit(1);
