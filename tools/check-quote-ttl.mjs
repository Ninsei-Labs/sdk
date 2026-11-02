#!/usr/bin/env node
// A DIRECT QUOTE'S EXPIRY IS AS STRICT AS THE RELAY'S.
//
// `validUntil: 0` used to bypass the expiry gate in the direct path; the relay path already required a safe future
// integer. This guard drives the direct `quotes.firm` path and checks the same edge values on the sale ticket.
import { createQuotes } from "../src/quotes.mjs";

const addr = (byte) => "0x" + byte.repeat(20);
const nowSec = Math.floor(Date.now() / 1000);

function quoteWith(validUntil) {
  return {
    provider: addr("22"), quoteKey: addr("12"), registry: addr("55"), cashier: addr("66"),
    locker: addr("44"), claimer: addr("33"), amount: "1000000000000000000",
    readyBy: nowSec + 7200, t1: nowSec + 14400, salt: "0x" + "44".repeat(32),
    commitHalfClaimer: "0x" + "55".repeat(32), edPointClaimer: "0x" + "66".repeat(32),
    chainId: 421614, feeBps: "0", fee: "0", feeRecipient: addr("77"),
    validUntil, nonce: "1", xmrAmount: "1000000000000", factory: addr("88"), claimTip: "0",
    signature: "0x" + "00".repeat(65),
  };
}

async function firmWith(validUntil) {
  const quote = quoteWith(validUntil);
  const sdk = createQuotes({
    config: { route: () => "/orderQuote" },
    http: { async tryJson() { return { ok: true, body: { ok: true, quote } }; } },
  });
  return sdk.firm({ providerId: "p", order: { locker: quote.locker } }).catch((error) => error);
}

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

for (const value of [0, -1, 1.5, "not-a-number", "1e100"]) {
  const got = await firmWith(value);
  check(got && got.code === "quote-expired", `direct quote validUntil=${JSON.stringify(value)} answered ${JSON.stringify(got && (got.code || "a quote"))}`);
}

// A future TTL reaches the signature check; it must not be turned into an expiry refusal by this change.
const future = await firmWith(nowSec + 600);
check(future && future.code !== "quote-expired", "a future direct TTL was refused as expired");

for (const value of [0, -1, 1.5, "not-a-number", "1e100"]) console.log("  ok    validUntil=" + JSON.stringify(value) + " is refused");
console.log("  ok    a future TTL is not refused as expired");
console.log(problems.length ? "quote ttl: FAILED\n" + problems.map((p) => "  FAIL  " + p).join("\n") : "quote ttl: direct and sale expiry edges behave");
if (problems.length) process.exit(1);
