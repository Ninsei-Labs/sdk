#!/usr/bin/env node
// A LIVE RUN OF THE DECLINE READ AGAINST A REAL LOCAL CHAIN. NOT PART OF `npm run check`: it needs a chain, and
// the battery runs without one.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT. The guard in tools/check.mjs drives the two sources with a scripted
// chain and a stand-in service, so the package's own battery stays runnable anywhere. This run adds the one thing
// a scripted chain cannot: THE SDK'S OWN LOG READ AGAINST A REAL NODE - a real `eth_getLogs`, a real transaction
// that emitted `Declined(address)`, and the answer the SDK gives from it.
//
// The chain and the escrow come from the environment, so no address of anybody's is baked in here:
//   NINSEI_TEST_EVM_RPC   the node to read (the same name the test wallet adapter uses)
//   NINSEI_DECLINE_ESCROW the escrow that has ALREADY declined (an order funded and then closed by its claimer)
//   NINSEI_DECLINE_FROM_BLOCK  optional: the first block to scan (the funding block), a hex or decimal number
// With either of the first two missing the run says so and exits 0 - a skip is named, never silent.
//
// Run: NINSEI_TEST_EVM_RPC=http://127.0.0.1:8545 NINSEI_DECLINE_ESCROW=0x... node tools/live-decline-run.mjs
import { envValue, evmRpcProvider } from "../src/adapters/node-test-evm-wallet.mjs";
import { orderDecline } from "../src/swap-flow.mjs";
import { DECLINED_TERMINAL, DECLINED_CODE, DECLINED_TOPIC0, DECLINE_FIELDS } from "../src/decline.mjs";
import { createNinsei } from "../src/index.mjs";

const RPC = envValue("NINSEI_TEST_EVM_RPC");
const ESCROW = envValue("NINSEI_DECLINE_ESCROW");
const FROM = envValue("NINSEI_DECLINE_FROM_BLOCK");

if (!RPC || !ESCROW) {
  console.log(`SKIPPED: the decline read was not run against a chain - ${!RPC ? "NINSEI_TEST_EVM_RPC" : "NINSEI_DECLINE_ESCROW"} is not set`);
  console.log("         set both to an escrow that has declined, and this run reads its Declined event from a real node.");
  process.exit(0);
}

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };

/** The chain read, as the adapter hands it out: a plain JSON-RPC read (this provider refuses to sign). */
const provider = evmRpcProvider(RPC);
const logs = (request) => provider.request({ method: "eth_getLogs", params: [{ ...request }] });

console.log(`escrow ${ESCROW} on ${RPC}`);
console.log(`the Declined topic this run filters by: ${DECLINED_TOPIC0}`);

// 1) THE LOG, AS THE NODE ACTUALLY STORES IT: asked for by hand first, so a failure below can be told apart from
// "the node has no such log".
const raw = await provider.request({ method: "eth_getLogs", params: [{ address: ESCROW, topics: [DECLINED_TOPIC0], fromBlock: FROM || "earliest", toBlock: "latest" }] });
if (!Array.isArray(raw) || raw.length === 0) {
  bad(`the node returned no Declined log for ${ESCROW}: there is nothing to read (was the order actually declined?)`);
} else {
  ok(`the node has ${raw.length} Declined log(s) for this escrow, from block ${raw[0].blockNumber}, tx ${String(raw[0].transactionHash).slice(0, 18)}...`);
}

// 2) THE READ THE FLOW USES (`orderDecline`), through the very same seat the rest of the core uses.
const verdict = await orderDecline(ESCROW, { logs, fromBlock: FROM || undefined });
console.log("        orderDecline -> " + JSON.stringify(verdict));
if (verdict.declined === true && verdict.terminal === DECLINED_TERMINAL && verdict.source === "event" && verdict.code === DECLINED_CODE && verdict.checked === true) {
  ok("the escrow's Declined event is read from the live chain as the state `declined`");
} else {
  bad(`the live chain did not read as a decline: ${JSON.stringify(verdict)}`);
}

// 3) THE READ THE APP USES (`sdk.order.decline`), with the same seam the facade wires.
const sdk = createNinsei({
  settlement: { chain: "local-anvil" },
  xmrNetwork: "stagenet",
  mode: "live",
  evmLogs: logs,
});
const viaFacade = await sdk.order.decline(ESCROW, FROM ? { fromBlock: NUMBER_OF(FROM) } : {});
if (viaFacade.declined === true && viaFacade.terminal === DECLINED_TERMINAL) {
  ok("sdk.order.decline reports the same state through the facade");
} else {
  bad(`sdk.order.decline did not report the decline: ${JSON.stringify(viaFacade)}`);
}

// 4) AND WHAT IT DELIBERATELY DOES NOT CARRY. The node names no reason, no category and no provider, so neither
// may this answer: one key that would let the app say WHY is a failure here.
const forbidden = ["reason", "why", "category", "provider", "detail", "message", "cause"];
const leaked = Object.keys(verdict).filter((key) => forbidden.includes(key.toLowerCase()));
if (leaked.length === 0 && Object.keys(verdict).sort().join(",") === [...DECLINE_FIELDS].sort().join(",")) {
  ok(`the answer carries exactly ${DECLINE_FIELDS.join(", ")} - no reason, category or provider`);
} else {
  bad(`the answer carries ${JSON.stringify(leaked)} or an undeclared field: ${JSON.stringify(Object.keys(verdict))}`);
}

/** A number written as text (a hex or decimal block boundary) as a number; anything unreadable is left alone. */
function NUMBER_OF(value) {
  const text = String(value).trim();
  const parsed = /^0x/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
  return Number.isFinite(parsed) ? parsed : value;
}

console.log("");
console.log(fails.length
  ? `FAILED: ${fails.length} (passed ${pass})`
  : `the maker's decline read from a live chain: ${pass} checks passed.`);
if (fails.length) process.exit(1);
