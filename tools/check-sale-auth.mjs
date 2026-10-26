#!/usr/bin/env node
// A SALE TICKET IS A SIGNED QUOTE, NOT A PRICE WITH A FLAG.
//
// `quotes.firm` recovered the EIP-712 signer and checked expiry, registry, provider and the interface's policy.
// `quotes.sale` used to return the ticket after checking only its own tip. A ticket signed with 65 zero bytes,
// expired long ago, for a denied claimer and a provider the interface refuses was accepted.
//
// Run: node tools/check-sale-auth.mjs
import { createQuotes } from "../src/quotes.mjs";
import { primitives } from "../src/primitives.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";

const addr = (b) => "0x" + b.repeat(20);
const signerKey = "0x" + "11".repeat(32);
const signerPub = primitives.secp256k1.getPublicKey(Uint8Array.from(Buffer.from(signerKey.slice(2), "hex")), false);
const quoteKey = "0x" + Buffer.from(primitives.keccak256(signerPub.slice(1))).subarray(12).toString("hex");
const nowSec = Math.floor(Date.now() / 1000);

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

function makeQuote(overrides = {}) {
  const quote = {
    provider: addr("22"), quoteKey, registry: addr("55"), cashier: addr("66"),
    locker: addr("44"), claimer: addr("33"), amount: "1000000000000000000",
    readyBy: nowSec + 7200, t1: nowSec + 14400, salt: "0x" + "44".repeat(32),
    commitHalfClaimer: "0x" + "55".repeat(32), edPointClaimer: "0x" + "66".repeat(32),
    chainId: 421614, feeBps: "0", fee: "0", feeRecipient: addr("77"),
    validUntil: nowSec + 600, nonce: "1", xmrAmount: "1000000000000",
    factory: addr("88"), claimTip: "0", ...overrides,
  };
  quote.signature = signQuoteDigest({ crypto: primitives, digest: quoteDigest({ crypto: primitives, quote }), privateKey: signerKey });
  return quote;
}

async function callSale({ quote = makeQuote(), denylist = null, allowed = null } = {}) {
  const ticket = { ok: true, handoff: { quote }, claimTip: { wei: quote.claimTip, signed: true } };
  let reads = 0;
  const sdk = createQuotes({
    config: { route: () => "/order-sell" },
    http: { async tryJson() { return { ok: true, body: ticket }; } },
    evmBlock: async () => ({ baseFeePerGas: 100_000_000n, gasPrice: 100_000_000n }),
    evmCall: async () => "0x" + "0".repeat(24) + (reads++ === 0 ? quote.provider.slice(2) : quote.factory.slice(2)),
    denylist,
    providerAllowed: allowed,
  });
  return sdk.sale({ claimer: quote.claimer, xmr: 1 });
}

console.log("=== 1) A VALID SIGNED TICKET PASSES ===");
{
  const got = await callSale().catch((e) => e);
  if (got && got.ok === true) ok("the signed ticket is returned");
  else bad("a valid ticket was refused: " + (got && got.code));
}

console.log("=== 2) A TICKET SIGNED BY NOBODY IS REFUSED ===");
{
  const quote = makeQuote();
  quote.signature = "0x" + "00".repeat(65);
  const got = await callSale({ quote }).catch((e) => e);
  if (got && got.code === "quote-signature-invalid") ok("the zero signature is refused as invalid");
  else bad("a zero signature returned " + (got && (got.code || "a ticket")));
}

console.log("=== 3) AN EXPIRED TICKET IS REFUSED ===");
{
  const got = await callSale({ quote: makeQuote({ validUntil: 1 }) }).catch((e) => e);
  if (got && got.code === "quote-expired") ok("the expired ticket is refused");
  else bad("an expired ticket returned " + (got && (got.code || "a ticket")));
}

console.log("=== 4) A DENIED CLAIMER IS REFUSED ===");
{
  const got = await callSale({ denylist: new Set([addr("33").toLowerCase()]) }).catch((e) => e);
  if (got && got.code === "address-denied") ok("the denylisted claimer is refused");
  else bad("a denied claimer returned " + (got && (got.code || "a ticket")));
}

console.log("=== 5) A PROVIDER THE INTERFACE DOES NOT ADMIT IS REFUSED ===");
{
  const got = await callSale({ allowed: () => false }).catch((e) => e);
  if (got && got.code === "quote-provider-not-allowed") ok("the disallowed provider is refused");
  else bad("a disallowed provider returned " + (got && (got.code || "a ticket")));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "sale auth: " + pass + " checks passed.");
if (fails.length) process.exit(1);
