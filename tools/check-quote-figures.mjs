#!/usr/bin/env node
// #393: one place for the firm window's deadlines, the fee and payout arithmetic, the funding reserve and the
// exact balance formats. Every case is a worked example; no network is read.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { firmRequest, firmDeadlines, firmWindowFor } from "../src/firmRequest.mjs";
import { MAX_FEE_BPS, feeWeiFor, principalForTotal, salePayoutBeforeClaim, salePayoutAfterClaim } from "../engine/evm/fees.js";
import { claimMaxFeePerGasWei } from "../engine/evm/claimGas.js";
import { GAS_CREATE_ORDER_AND_FUND } from "../engine/evm/funding.js";
import { fundingGasReserveWei, orderGasReserveWei } from "../engine/evm/gasReserve.js";
import { balances } from "../src/legs/evm.mjs";
import * as evmPublic from "../src/public/evm.mjs";
import * as sdk from "../src/index.mjs";

const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (condition) console.log("  ok    " + message); else problems.push(message); };
const equal = (actual, expected, message) => check(actual === expected, `${message} (got ${actual}, want ${expected})`);

const window = (xmrNetwork) => ({
  market: "421614:ETH", side: "ask", xmrNetwork,
  readyMinSeconds: 1200, readyMaxSeconds: 1800,
  settlementMinSeconds: 3600, settlementMaxSeconds: 7200, quoteTtlSeconds: 30,
});
const features = { type: "node_features", typeString: "x", firmWindows: [window("mainnet"), window("stagenet")] };
const now = 1_000_000;

// --- 1. Firm request: network selection and the two margin rules ------------------------------------------------
{
  const result = firmRequest({ features, side: "ask", market: "421614:ETH", xmrNetwork: "stagenet", chainNow: now });
  equal(result.xmrNetwork, "stagenet", "the request picks the window for its own Monero network");
  equal(result.readyBy, now + 1350, "readyBy keeps 150 s from the lower readiness edge");
  equal(result.t1, now + 1350 + 3660, "t1 keeps 60 s from both settlement edges");
  check(result.window.xmrNetwork === "stagenet", "the returned window is the selected signed one");
}
{
  // The same market and side on two networks, with the wanted window last: order on the list must not decide.
  const reversed = { firmWindows: [window("mainnet"), window("stagenet")] };
  const result = firmRequest({ features: reversed, side: "ask", market: "421614:ETH", xmrNetwork: "mainnet", chainNow: now });
  equal(result.xmrNetwork, "mainnet", "the first listed network is not chosen by accident");
  equal(result.readyBy, now + 1350, "the mainnet window gives the same deadline rule");
}
{
  // A window narrower than twice the upper margin gets its middle, not an edge.
  const narrow = { firmWindows: [{ ...window("stagenet"), readyMinSeconds: 100, readyMaxSeconds: 200,
    settlementMinSeconds: 3600, settlementMaxSeconds: 7200 }] };
  const result = firmDeadlines(narrow.firmWindows[0], now);
  equal(result.readyBy, now + 150, "a narrow readiness window gets its middle");
}
{
  let error = null;
  try { firmWindowFor({ features, side: "ask", market: "421614:ETH", xmrNetwork: "testnet" }); } catch (caught) { error = caught; }
  check(error && error.code === "bad-input" && error.params.field === "features.firmWindows",
    "a missing network window is refused, not replaced by another network");
}

// --- 2. Fee and principal ----------------------------------------------------------------------------------------
{
  equal(MAX_FEE_BPS, 200, "the contract fee ceiling is 200 bps");
  equal(feeWeiFor(100_000n, 0), 0n, "bps 0 gives no fee");
  equal(feeWeiFor(100_000n, 200), 2_000n, "bps 200 gives exactly 2%");
  equal(principalForTotal(100_000n, 0), 100_000n, "at bps 0 the total is the principal");
  // 982 + floor(982*200/10000) = 1001; 983 would be 1002.
  equal(principalForTotal(1001n, 200), 982n, "a total that does not divide evenly keeps the floor rule");
  equal(982n + feeWeiFor(982n, 200), 1001n, "the inverse and the fee recombine to the total");
}
{
  // A missing or invalid rate is NOT zero. Explicit zero and the string form of a whole rate are valid.
  equal(feeWeiFor(100_000n, "0"), 0n, "a zero rate as a string is explicit zero");
  equal(feeWeiFor(100_000n, 0n), 0n, "a zero bigint rate is explicit zero");
  const invalid = [undefined, null, "", "abc", "1.5", NaN, Infinity, -1, 201, 1.5, true, false];
  for (const rate of invalid) {
    let feeError = null;
    try { feeWeiFor(100_000n, rate); } catch (error) { feeError = error; }
    check(feeError !== null, `feeWeiFor refuses the invalid rate ${String(rate)}`);
    let principalError = null;
    try { principalForTotal(100_000n, rate); } catch (error) { principalError = error; }
    check(principalError !== null, `principalForTotal refuses the invalid rate ${String(rate)}`);
  }
}

// --- 3. Sale payout: before and after the claim -----------------------------------------------------------------
const AMOUNT = 100_000_000_000_000_000n; // 0.1 ETH
const FEE = 300_000_000_000_000n;        // 0.0003 ETH
const TIP = 20_000_000_000_000n;         // 0.00002 ETH
const CLAIMER = "0x" + "11".repeat(20);
const OTHER = "0x" + "22".repeat(20);
{
  const before = salePayoutBeforeClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP });
  equal(before.guaranteedMinimumWei, 99_680_000_000_000_000n, "the guaranteed minimum is amount - fee - tip");
  equal(before.sellerClaimWei, 99_700_000_000_000_000n, "the seller-sent claim pays amount - fee");
  equal(before.amountWei, AMOUNT, "the escrow amount is a separate field");
  equal(before.feeWei, FEE, "the fee is a separate field");
  equal(before.claimTipWei, TIP, "the claim tip is a separate field");
}
{
  // THE TIP IS NOT ZERO WHEN IT IS NOT KNOWN. A caller that leaves the field out must not be shown the
  // no-tip figure; the seller's own claim still does not need the tip and stays known.
  const amount = 10_000n;
  const fee = 30n;
  const cases = [
    ["zero", 0n, 9_970n, 9_970n],
    ["five", 5n, 9_965n, 9_965n],
    ["left out", undefined, null, null],
    ["explicit null", null, null, null],
    ["empty", "", null, null],
  ];
  for (const [name, tip, guaranteed, thirdParty] of cases) {
    const expectedTip = tip === undefined || tip === null || tip === "" ? null : tip;
    const request = { amountWei: amount, feeWei: fee };
    if (tip !== undefined) request.claimTipWei = tip;
    const before = salePayoutBeforeClaim(request);
    check(before !== null, `the ${name} tip still leaves the seller figure measurable`);
    if (before !== null) {
      equal(before.sellerClaimWei, 9_970n, `the ${name} tip does not change the seller's own figure`);
      equal(before.guaranteedMinimumWei, guaranteed, `the ${name} tip gives the expected guaranteed minimum`);
      equal(before.claimTipWei, expectedTip, `the ${name} tip is reported as known or unknown`);
    }
    const seller = salePayoutAfterClaim({ amountWei: amount, feeWei: fee, ...(tip === undefined ? {} : { claimTipWei: tip }),
      claimed: true, claimSucceeded: true, sender: CLAIMER, claimer: CLAIMER });
    equal(seller.payoutWei, 9_970n, `the ${name} tip keeps the seller's receipt at amount - fee`);
    check(seller.outcome === "claimed", `the ${name} tip still names the seller's claim`);
    const other = salePayoutAfterClaim({ amountWei: amount, feeWei: fee, ...(tip === undefined ? {} : { claimTipWei: tip }),
      claimed: true, claimSucceeded: true, sender: OTHER, claimer: CLAIMER });
    equal(other.payoutWei, thirdParty, `the ${name} tip gives the expected third-party receipt`);
    const unknown = salePayoutAfterClaim({ amountWei: amount, feeWei: fee, ...(tip === undefined ? {} : { claimTipWei: tip }),
      claimed: true, claimSucceeded: true, sender: null, claimer: CLAIMER });
    equal(unknown.payoutWei, tip === 0n ? 9_970n : null, `the ${name} tip with an unknown caller is known only at zero`);
  }
}
{
  // BREAKING RUN: restoring the old zero default must make the omitted-tip cases red. This keeps the new
  // "unknown, not zero" rule load-bearing rather than a comment.
  const dir = mkdtempSync(join(tmpdir(), "sdk-quote-tip-"));
  try {
    const source = readFileSync(new URL("../engine/evm/fees.js", import.meta.url), "utf8");
    const anchor = "const tip = payoutBig(claimTipWei);";
    const mutated = source.replace(anchor, "const tip = claimTipWei === undefined ? 0n : payoutBig(claimTipWei);");
    check(mutated !== source, "the breaking run could not find the tip parser");
    if (mutated !== source) {
      const copy = join(dir, "fees.js");
      writeFileSync(copy, mutated);
      const broken = await import(pathToFileURL(copy).href + "?run=" + Date.now());
      const before = broken.salePayoutBeforeClaim({ amountWei: 10_000n, feeWei: 30n });
      equal(before && before.guaranteedMinimumWei, 9_970n, "restoring the zero default did not change the omitted tip");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
{
  const same = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
    claimed: true, claimSucceeded: true, sender: CLAIMER, claimer: CLAIMER });
  equal(same.payoutWei, 99_700_000_000_000_000n, "the claimer's own claim pays amount - fee");
  const other = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
    claimed: true, claimSucceeded: true, sender: OTHER, claimer: CLAIMER });
  equal(other.payoutWei, 99_680_000_000_000_000n, "another sender pays amount - fee - tip");
  const zeroTip = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: 0n,
    claimed: true, claimSucceeded: true, sender: null, claimer: CLAIMER });
  equal(zeroTip.payoutWei, 99_700_000_000_000_000n, "with no tip both claim paths pay amount - fee, even with an unknown sender");
  const unknownSender = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
    claimed: true, claimSucceeded: true, sender: null, claimer: CLAIMER });
  check(unknownSender.outcome === "unknown" && unknownSender.payoutWei === null,
    "a positive tip with an unknown actual sender gives no payout");
  const undetermined = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
    claimed: true, claimSucceeded: false, sender: CLAIMER, claimer: CLAIMER });
  check(undetermined.outcome === "unknown" && undetermined.payoutWei === null,
    "an outcome that is not determined gives no payout");
}
{
  // A DIRECT CLAIM'S TRANSACTION METADATA IS THE SENDER FACT. `to` must be the escrow; a claim routed through
  // another contract has a different `msg.sender` and must stay unknown.
  const escrow = "0x" + "33".repeat(20);
  const router = "0x" + "44".repeat(20);
  const direct = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
    claimed: true, claimSucceeded: true, claimer: CLAIMER, escrow, to: escrow.toUpperCase().replace("0X", "0x"), from: CLAIMER });
  equal(direct.payoutWei, 99_700_000_000_000_000n, "a direct claim by the seller reports amount - fee");
  const thirdParty = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
    claimed: true, claimSucceeded: true, claimer: CLAIMER, escrow, to: escrow, from: OTHER });
  equal(thirdParty.payoutWei, 99_680_000_000_000_000n, "a direct third-party claim reports amount - fee - tip");
  const routed = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
    claimed: true, claimSucceeded: true, claimer: CLAIMER, escrow, to: router, from: CLAIMER });
  check(routed.outcome === "unknown" && routed.payoutWei === null,
    "a claim routed through another contract does not claim the caller as msg.sender");
  const noEscrow = salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
    claimed: true, claimSucceeded: true, claimer: CLAIMER, to: escrow, from: CLAIMER });
  check(noEscrow.outcome === "unknown" && noEscrow.payoutWei === null,
    "transaction metadata without the escrow is not trusted as the sender");

  // BREAKING RUN: removing the `to === escrow` comparison must make the routed-claim case claim a payout. If it
  // stays unknown, this case proves something else and the trust boundary is not load-bearing.
  const dir = mkdtempSync(join(tmpdir(), "sdk-quote-figures-"));
  try {
    const source = readFileSync(new URL("../engine/evm/fees.js", import.meta.url), "utf8");
    const anchor = "text(to) === text(escrow)";
    const mutated = source.replace(anchor, "true");
    check(mutated !== source, "the breaking run could not find the escrow comparison");
    if (mutated !== source) {
      const copy = join(dir, "fees.js");
      writeFileSync(copy, mutated);
      const broken = await import(pathToFileURL(copy).href + "?run=" + Date.now());
      const result = broken.salePayoutAfterClaim({ amountWei: AMOUNT, feeWei: FEE, claimTipWei: TIP,
        claimed: true, claimSucceeded: true, claimer: CLAIMER, escrow, to: router, from: CLAIMER });
      check(result.outcome === "claimed" && result.payoutWei === 99_700_000_000_000_000n,
        "removing the escrow comparison did not change the routed claim");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- 4. Funding reserve for Max ----------------------------------------------------------------------------------
{
  const base = 1_000_000_000n;
  const priority = 2_000_000_000n;
  const maxFee = claimMaxFeePerGasWei({ baseFeeWei: base, priorityFeeWei: priority });
  const reserve = fundingGasReserveWei({ maxFeePerGasWei: maxFee });
  equal(GAS_CREATE_ORDER_AND_FUND, 700_000n, "the funding gas limit is the measured constant");
  equal(reserve, 700_000n * (2n * base + priority), "the Max reserve is the funding limit times the max fee");
  check(reserve !== orderGasReserveWei({ gasPriceWei: maxFee }), "it is not the mark/refund reserve");
}

// --- 5. Balance answers have exact formats ----------------------------------------------------------------------
const tokens = [
  { id: "eth", symbol: "ETH", decimals: 18, address: null },
  { id: "usdc", symbol: "USDC", decimals: 6, address: "0x" + "33".repeat(20) },
];
const read = async (eth, token) => balances({
  address: "0x" + "44".repeat(20), tokens,
  driver: { request: async ({ method }) => method === "eth_getBalance" ? eth : token },
});
{
  const zero = await read("0x0", "0x" + "0".repeat(64));
  equal(zero[0].amount, "0", "an ETH quantity 0x0 is zero");
  equal(zero[1].amount, "0", "a 32-byte zero word is zero");
  const value = await read("0x2a", "0x" + "0".repeat(62) + "2a");
  equal(value[0].amount, "42", "an ETH quantity 0x2a is 42");
  equal(value[1].amount, "42", "a 32-byte ABI word ending in 2a is 42");
}
for (const bad of ["", "0x", "0xzz", false, null]) {
  const result = await read(bad, bad);
  check(result[0].amount === null && result[1].amount === null, `the balance answer ${JSON.stringify(bad)} is unknown, not zero`);
}
for (const bad of ["0x" + "0".repeat(62), "0x" + "0".repeat(66)]) {
  const result = await read("0x0", bad);
  check(result[1].amount === null, "an ERC-20 answer that is not exactly 32 bytes is unknown");
}

{
  const names = ["MAX_FEE_BPS", "feeWeiFor", "principalForTotal", "salePayoutBeforeClaim", "salePayoutAfterClaim",
    "GAS_CREATE_ORDER_AND_FUND", "fundingGasReserveWei"];
  check(names.every((name) => evmPublic[name] !== undefined), "the EVM subpath exports the money arithmetic");
  check(sdk.firmWindowFor === firmWindowFor, "the package entry exports the firm-window selector");
}

if (problems.length) {
  console.error("FAILED:");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
console.log(`PASSED: ${checks} quote/money figure checks`);
