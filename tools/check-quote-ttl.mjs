#!/usr/bin/env node
// THE DIRECT AND SALE QUOTE PATHS APPLY THE SAME STRICT EXPIRY RULE.
//
// `validUntil: 0` used to bypass the expiry gate in the direct path; the relay path already required a safe future
// integer. This guard drives both `quotes.firm` and `quotes.sale` with the same edge table. The positive case names
// the step AFTER the expiry gate, so an unrelated `bad-input` or transport failure cannot stand in for success.
import { createQuotes } from "../src/quotes.mjs";
import { primitives } from "../src/primitives.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";

const addr = (byte) => "0x" + byte.repeat(20);
const nowSec = 1_700_000_000;
const now = () => nowSec * 1000;
const signerKey = "0x" + "11".repeat(32);
const signerPub = primitives.secp256k1.getPublicKey(Uint8Array.from(Buffer.from(signerKey.slice(2), "hex")), false);
const quoteKey = "0x" + Buffer.from(primitives.keccak256(signerPub.slice(1))).subarray(12).toString("hex");

function quoteWith(validUntil) {
  return {
    provider: addr("22"), quoteKey, registry: addr("55"), cashier: addr("66"),
    locker: addr("44"), claimer: addr("33"), amount: "1000000000000000000",
    readyBy: nowSec + 7200, t1: nowSec + 14400, salt: "0x" + "44".repeat(32),
    commitHalfClaimer: "0x" + "55".repeat(32), edPointClaimer: "0x" + "66".repeat(32),
    chainId: 421614, feeBps: "0", fee: "0", feeRecipient: addr("77"),
    validUntil, nonce: "1", xmrAmount: "1000000000000", factory: addr("88"), claimTip: "0", commitHalfLocker: "0x" + "a1".repeat(32), edPointLocker: "0x" + "a2".repeat(32), edViewPointLocker: "0x" + "a3".repeat(32),
    signature: "0x" + "00".repeat(65),
  };
}

function signedQuote(validUntil) {
  const quote = quoteWith(validUntil);
  quote.signature = signQuoteDigest({
    crypto: primitives,
    digest: quoteDigest({ crypto: primitives, quote }),
    privateKey: signerKey,
  });
  return quote;
}

async function firmWith(validUntil) {
  const quote = quoteWith(validUntil);
  const sdk = createQuotes({
    config: { route: () => "/orderQuote" },
    now,
    http: { async tryJson() { return { ok: true, body: { ok: true, quote } }; } },
  });
  return sdk.firm({ providerId: "p", order: { locker: quote.locker } }).catch((error) => error);
}

async function saleWith(validUntil, signed = false) {
  const quote = signed ? signedQuote(validUntil) : quoteWith(validUntil);
  const ticket = { ok: true, handoff: { quote }, claimTip: { wei: quote.claimTip, signed: true } };
  let reads = 0;
  const sdk = createQuotes({
    config: { route: () => "/order-sell" },
    now,
    http: { async tryJson() { return { ok: true, body: ticket }; } },
    evmBlock: async () => ({ baseFeePerGas: 100_000_000n, gasPrice: 100_000_000n }),
    evmCall: async () => "0x" + "0".repeat(24) + (reads++ === 0 ? quote.provider.slice(2) : quote.factory.slice(2)),
  });
  return sdk.sale({ claimer: quote.claimer, xmr: 1 }).catch((error) => error);
}

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

// Every value below must stop at the shared expiry gate. null/undefined are added because Number(null) is 0 and
// Number(undefined) is NaN: neither may become an eternal quote.
const invalid = [0, -1, 1.5, "not-a-number", "1e100", Number.MAX_SAFE_INTEGER + 1];
for (const value of invalid) {
  const direct = await firmWith(value);
  check(direct && direct.code === "quote-expired",
    `direct quote validUntil=${JSON.stringify(value)} answered ${JSON.stringify(direct && (direct.code || "a quote"))}`);
  const sale = await saleWith(value);
  check(sale && sale.code === "quote-expired",
    `sale quote validUntil=${JSON.stringify(value)} answered ${JSON.stringify(sale && (sale.code || "a ticket"))}`);
}

// A MISSING SIGNED FIELD IS ITS OWN REFUSAL. null/undefined must never become an eternal quote; the same
// named `quote-field-unbound` gate runs before expiry in both paths.
for (const value of [null, undefined]) {
  const direct = await firmWith(value);
  check(direct && direct.code === "quote-field-unbound",
    `direct quote validUntil=${JSON.stringify(value)} answered ${JSON.stringify(direct && (direct.code || "a quote"))}`);
  const sale = await saleWith(value);
  check(sale && sale.code === "quote-field-unbound",
    `sale quote validUntil=${JSON.stringify(value)} answered ${JSON.stringify(sale && (sale.code || "a ticket"))}`);
}

// A future TTL must pass the expiry gate and fail at the NEXT named step. The direct fixture has no valid
// signature, so the expected sentinel is `quote-signature-invalid`; the signed sale ticket must be accepted.
const future = nowSec + 600;
{
  const direct = await firmWith(future);
  check(direct && direct.code === "quote-signature-invalid",
    "a future direct TTL did not reach the signature check: " + JSON.stringify(direct && (direct.code || "a quote")));
  const sale = await saleWith(future, true);
  check(sale && sale.ok === true, "a future signed sale TTL was refused: " + JSON.stringify(sale && (sale.code || "a ticket")));
}

if (problems.length) {
  console.log("quote ttl: FAILED\n" + problems.map((p) => "  FAIL  " + p).join("\n"));
  process.exit(1);
}
// PRINT `ok` ONLY AFTER THE ASSERTIONS PASSED. The old lines printed every case as ok even when `problems` held
// failures; the exit code was right, but the log told a different story.
for (const value of [...invalid, null, undefined]) console.log("  ok    validUntil=" + JSON.stringify(value) + " is refused by both paths");
console.log("  ok    a future TTL reaches the next gate on both paths");
console.log("quote ttl: direct and sale expiry edges behave");
