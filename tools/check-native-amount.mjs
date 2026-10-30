#!/usr/bin/env node
// THE TWO AMOUNTS OF A TOKEN-FUNDED BUY, AND THE ONE XMR FIGURE THE ARRIVAL CHECK COMPARES.
//
// 1. The escrow holds the network's native coin. A quote paid in USDC/USDT carries a different number in the
//    token; the native figure is the quote's own `payNative`. A missing figure is a named refusal, never a
//    rescale of the payment amount (the 10^12 defect on a 6-decimal token).
// 2. The arrival check compares the signed integer, not the rounded display number. That integer must survive
//    the swap record and the recovery file unchanged.
//
// Run: node tools/check-native-amount.mjs
import * as engine from "../src/engine.mjs";
import { createRecord } from "../src/record.mjs";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

console.log("=== 1) THE NATIVE AMOUNT COMES FROM THE QUOTE ===");
{
  const usdc = engine.evm.escrowNativeWei({ quote: { payNative: "0.0004" }, nativeDecimals: 18 });
  const dai = engine.evm.escrowNativeWei({ quote: { payNative: "0.0004" }, nativeDecimals: 18 });
  if (usdc.ok && usdc.wei === "400000000000000" && dai.ok && dai.wei === usdc.wei) {
    ok("USDC and DAI quotes with the same native amount give the same wei");
  } else bad("native equality: " + JSON.stringify({ usdc, dai }));

  const small = engine.evm.escrowNativeWei({ quote: { payNative: "1e-7" }, nativeDecimals: 18 });
  if (small.ok && small.wei === "100000000000") ok("an exponent form is scaled, not rejected");
  else bad("exponent form: " + JSON.stringify(small));

  const six = engine.evm.escrowNativeWei({ quote: { payNative: "0.0004" }, nativeDecimals: 6 });
  if (six.ok && six.wei === "400") ok("the native decimals are respected");
  else bad("six decimals: " + JSON.stringify(six));
}

console.log("=== 2) AN UNREADABLE NATIVE AMOUNT IS A NAMED REFUSAL ===");
{
  for (const quote of [null, {}, { payNative: null }, { payNative: "" }, { payNative: "0" }, { payNative: "-1" },
    { payNative: "not a number" }, { payNative: "0x10" }]) {
    const answer = engine.evm.escrowNativeWei({ quote, nativeDecimals: 18 });
    if (!answer.ok && answer.code === "native-amount-unread") ok("refused " + JSON.stringify(quote));
    else bad("not refused: " + JSON.stringify({ quote, answer }));
  }
  for (const nativeDecimals of [1.5, -1, "eighteen"]) {
    const answer = engine.evm.escrowNativeWei({ quote: { payNative: "0.1" }, nativeDecimals });
    if (!answer.ok && answer.code === "native-amount-unread") ok("refused decimals " + JSON.stringify(nativeDecimals));
    else bad("decimals not refused: " + JSON.stringify({ nativeDecimals, answer }));
  }
}

console.log("=== 3) THE SIGNED XMR INTEGER SURVIVES THE RECORD ===");
{
  const side = {
    half: 1n, viewHalf: 2n,
    pub: { ed: "0x" + "11".repeat(32) }, viewPub: "0x" + "22".repeat(32),
  };
  const input = {
    side: "buy", chainMode: "live", network: "arbitrum-sepolia", xmrAmount: 0.4,
    payToken: "USDC", payAmount: 100, rate: 0.004, fee: 0.001,
    expectedAtomic: "400000000000",
  };
  const made = createRecord(input, { side });
  if (made.swap.escrow.expectedAtomic === "400000000000") ok("the exact signed integer is stored");
  else bad("record expectedAtomic: " + JSON.stringify(made.swap.escrow.expectedAtomic));

  for (const value of ["0", "-1", "not an integer"]) {
    let answer = null;
    try { createRecord({ ...input, expectedAtomic: value }, { side }); }
    catch (error) { answer = error; }
    if (answer && answer.code === "bad-input" && answer.params && answer.params.field === "expectedAtomic") {
      ok("refused expectedAtomic " + JSON.stringify(value));
    } else bad("expectedAtomic not refused: " + JSON.stringify({ value, code: answer && answer.code }));
  }
}

if (fails.length) {
  console.log("\n" + fails.length + " failure(s)");
  process.exit(1);
}
console.log("\n" + pass + " checks passed");
