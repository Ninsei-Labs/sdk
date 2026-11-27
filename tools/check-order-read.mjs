#!/usr/bin/env node
// ONE-BLOCK ORDER READS, TERMS HISTORY, LOOKUP, FUNDING AND THE SHARED SEARCH START.
// These checks use the same log and block seams the page has: no wallet and no live chain.
import { createNinsei } from "../src/index.mjs";
import { orderRead } from "../src/swap-flow.mjs";
import { orderHistory, orderLookup, orderFunding } from "../src/order-read.mjs";
import { findSwaps, recoverySearchStart, recoveryStartBlock, takerHalvesV2 } from "../src/recovery-key.mjs";
import { ESCROW_METHODS, ORDER_TERMS_TOPIC } from "../engine/evm/escrow.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ORDER_CREATED_TOPIC } from "../engine/evm/factory.js";
import { ESCROW_EVENT_TOPICS } from "../src/recovery-key.mjs";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CHAIN = 421614;
const FACTORY = "0x" + "dd".repeat(20);
const ESCROW = "0x" + "aa".repeat(20);
const LOCKER = "0x" + "bb".repeat(20);
const CLAIMER = "0x" + "cc".repeat(20);
const word = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");
const pad = (value) => "0x" + String(value).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
const words = (...values) => "0x" + values.map((value) => {
  const raw = typeof value === "number" || typeof value === "bigint"
    ? BigInt(value).toString(16) : String(value).replace(/^0x/, "");
  return raw.padStart(64, "0");
}).join("");
const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (condition) console.log("  ok    " + message); else problems.push(message); };

const termsLog = ({ escrow = ESCROW, blockNumber = 7, removed = false, fee = "3", claimTip = "5" } = {}) => ({
  address: escrow,
  topics: [ORDER_TERMS_TOPIC, pad(escrow), pad(LOCKER), pad(CLAIMER)],
  data: words(
    "0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32),
    "0x" + "04".repeat(32), "0x" + "05".repeat(32),
    1000, 2000, 3000, pad("0x" + "66".repeat(20)), pad("0x" + "77".repeat(20)), pad("0x" + "88".repeat(20)),
    30, fee, pad("0x" + "99".repeat(20)), claimTip,
  ),
  blockNumber, blockHash: H(blockNumber), transactionHash: H(blockNumber + 100), logIndex: 0, removed,
});

const settlementLog = (topic, blockNumber, data = "0x", topics = [topic]) => ({
  address: ESCROW, topics, data, blockNumber, blockHash: H(blockNumber), transactionHash: H(blockNumber + 200), logIndex: 1,
});

const createdLog = ({ removed = false, blockNumber = 100, salt = "0x" + "ab".repeat(32) } = {}) => {
  const halves = takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory: FACTORY, salt });
  return {
    address: FACTORY,
    topics: [ORDER_CREATED_TOPIC, pad(ESCROW), pad(LOCKER), pad(CLAIMER)],
    data: words(
      halves.spendCommitment, "0x" + "02".repeat(32), "0x" + "03".repeat(32), "0x" + "04".repeat(32),
      "0x" + "05".repeat(32), 1000, 5000000000000, 2000, 3000, salt,
      pad("0x" + "66".repeat(20)), pad("0x" + "77".repeat(20)), pad("0x" + "88".repeat(20)),
    ),
    blockNumber, blockHash: H(blockNumber), transactionHash: H(blockNumber + 300), logIndex: 0, removed,
  };
};

// THE TOPIC IS A LITERAL AND AN INDEPENDENT HASH, not two copies of the same constant.
{
  const signature = "OrderTerms(address,address,address,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint64,uint64,address,address,address,uint16,uint256,address,uint256)";
  const computed = "0x" + Buffer.from(keccak_256(Buffer.from(signature))).toString("hex");
  check(ORDER_TERMS_TOPIC === "0x968d16f7aa0670aadba259292b76e013a5c6de0188362017569f55852e90ec72",
    "the OrderTerms topic literal changed");
  check(computed === ORDER_TERMS_TOPIC, "the OrderTerms topic does not hash to its signature");
}

// --- order.read: every field at one tag, with the block identity ---
{
  const calls = [];
  const call = async ({ data, block }) => {
    calls.push({ data, block });
    if (data === ESCROW_METHODS.status) return words(1, 0, 0, 1000);
    if (data === ESCROW_METHODS.ready) return word(1);
    if (data === ESCROW_METHODS.t1) return word(3000);
    if (data === ESCROW_METHODS.readyBy) return word(2000);
    throw new Error("unexpected selector " + data);
  };
  const read = await orderRead(ESCROW, {
    call, blockTag: 42,
    block: async () => ({ number: 42, hash: H(42), timestamp: 1000 }),
  });
  check(read.status.isFunded === true && read.status.balance === 1000n, "read decoded the status");
  check(read.ready === true && read.readyBy === 2000 && read.t1 === 3000, "read decoded ready and both deadlines");
  check(read.block.number === 42 && read.block.hash === H(42) && read.block.timestamp === 1000, "read returned the block identity");
  check(calls.length === 4 && calls.every((entry) => entry.block === "0x2a"), "the four fields were not asked at the resolved block");
  let wrong = null;
  try {
    await orderRead(ESCROW, { call, blockTag: 42, block: async () => ({ number: 41, hash: H(41), timestamp: 1000 }) });
  } catch (error) { wrong = error; }
  check(wrong && wrong.code === "bad-input" && wrong.params.field === "block", "a block at another height was refused");
  let empty = null;
  try {
    await orderRead(ESCROW, { blockTag: 42,
      call: async ({ data }) => data === ESCROW_METHODS.ready ? "0x" : "0x" + "0".repeat(64),
      block: async () => ({ number: 42, hash: H(42), timestamp: 1000 }) });
  } catch (error) { empty = error; }
  check(empty && empty.code === "bad-input" && empty.params.field === "ready" && empty.params.why === "empty",
    "an empty ready answer was not a named refusal");
  let noContract = null;
  try {
    await orderRead(ESCROW, { blockTag: 42, call: async () => "0x",
      block: async () => ({ number: 42, hash: H(42), timestamp: 1000 }) });
  } catch (error) { noContract = error; }
  check(noContract && noContract.code === "bad-input" && noContract.params.field === "escrow"
    && noContract.params.why === "no-contract" && noContract.params.block.number === 42,
    "an address without code was not named with its block");
  let missing = null;
  try { await orderRead(ESCROW, { call }); } catch (error) { missing = error; }
  check(missing && missing.code === "bad-input" && missing.params.field === "block", "a read without a block seam was refused");
}

// --- the facade methods reach the same readers ---
{
  const call = async ({ data }) => {
    if (data === ESCROW_METHODS.status) return words(1, 0, 0, 1000);
    if (data === ESCROW_METHODS.ready) return word(1);
    if (data === ESCROW_METHODS.t1) return word(3000);
    if (data === ESCROW_METHODS.readyBy) return word(2000);
    return words(1, 0, 0, 1000);
  };
  const sdk = createNinsei({
    settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet", mode: "sim",
    evmCall: call, evmBlock: async (tag) => ({ number: typeof tag === "number" ? tag : 42, hash: H(42), timestamp: 1000 }),
    evmLogs: async () => [termsLog()],
  });
  const read = await sdk.order.read(ESCROW);
  const history = await sdk.order.history({ escrows: [ESCROW], fromBlock: 0, toBlock: 42 });
  const lookup = await sdk.order.lookup(ESCROW, { factory: FACTORY, toBlock: 42 });
  const funding = await sdk.order.funding({ escrow: ESCROW, validUntil: 100 });
  check(read.block.number === 42 && history.escrows[0].terms.amount === "1000" && funding.state === "landed",
    "the facade order methods read through the instance seams");
  check(lookup.found === false, "the facade lookup did not run its own log read");
}

// --- a key history finds the escrows first, then reads their terms ---
{
  const byKey = await orderHistory({
    mnemonic: WORDS, chainId: CHAIN, factory: FACTORY, fromBlock: 0, toBlock: 200,
    evmLogs: async () => [createdLog({ blockNumber: 100 }), termsLog({ blockNumber: 100 })],
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }),
  });
  check(byKey.swaps && byKey.swaps.length === 1 && byKey.escrows.length === 1,
    "a key history did not find the escrow before reading terms");
  check(byKey.escrows[0].terms && byKey.escrows[0].terms.fee === "3", "a key history did not join the terms");
}

// --- history: removed logs dropped, terms and settlement state joined, checkpoint returned ---
{
  const zero = "0x" + "00".repeat(20);
  const deposit = await orderHistory({
    escrows: [ESCROW], fromBlock: 0, toBlock: 20,
    evmLogs: async () => [
      termsLog({ blockNumber: 7 }),
      settlementLog(ESCROW_EVENT_TOPICS.ready, 7, "0x", [ESCROW_EVENT_TOPICS.ready, pad(zero)]),
    ],
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }),
  });
  check(deposit.escrows[0].status.ready === false, "the deposit's Ready(0) marker was read as a locker mark");
  const marked = await orderHistory({
    escrows: [ESCROW], fromBlock: 0, toBlock: 20,
    evmLogs: async () => [
      termsLog({ blockNumber: 7 }),
      settlementLog(ESCROW_EVENT_TOPICS.ready, 8, "0x", [ESCROW_EVENT_TOPICS.ready, pad(LOCKER)]),
    ],
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }),
  });
  check(marked.escrows[0].status.ready === true, "the locker's Ready mark was not read as ready");
}
{
  const zero = "0x" + "00".repeat(20);
  const lookup = await orderLookup(ESCROW, {
    factory: FACTORY, deploymentBlock: 0, toBlock: 200,
    evmLogs: async () => [createdLog({ blockNumber: 100 }), termsLog({ blockNumber: 100 }),
      settlementLog(ESCROW_EVENT_TOPICS.ready, 100, "0x", [ESCROW_EVENT_TOPICS.ready, pad(zero)])],
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }),
  });
  check(lookup.found === true && lookup.status && lookup.status.ready === false,
    "lookup read the deposit's Ready(0) marker as a locker mark");
  const marked = await orderLookup(ESCROW, {
    factory: FACTORY, deploymentBlock: 0, toBlock: 200,
    evmLogs: async () => [createdLog({ blockNumber: 100 }), termsLog({ blockNumber: 100 }),
      settlementLog(ESCROW_EVENT_TOPICS.ready, 101, "0x", [ESCROW_EVENT_TOPICS.ready, pad(LOCKER)])],
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }),
  });
  check(marked.found === true && marked.status && marked.status.ready === true,
    "lookup did not read the locker's Ready mark");
  const cuts = [];
  await orderLookup(ESCROW, {
    factory: FACTORY, toBlock: "latest",
    evmLogs: async (request) => {
      cuts.push(request.toBlock);
      return [createdLog({ blockNumber: 100 }), termsLog({ blockNumber: 100 })];
    },
    evmBlock: async () => ({ number: 200, hash: H(200), timestamp: 1000 }),
  });
  check(cuts.length === 2 && cuts.every((block) => block === 200),
    "lookup read its creation and terms at different blocks");
}
{
  const requests = [];
  const history = await orderHistory({
    escrows: [ESCROW], fromBlock: 0, toBlock: 20,
    evmLogs: async (request) => {
      requests.push(request);
      return [
        termsLog({ blockNumber: 7 }),
        settlementLog(ESCROW_EVENT_TOPICS.ready, 8, "0x", [ESCROW_EVENT_TOPICS.ready, pad(LOCKER)]),
        settlementLog(ESCROW_EVENT_TOPICS.halfRevealed, 9, words("0x" + "11".repeat(32), 1)),
        termsLog({ escrow: "0x" + "ee".repeat(20), blockNumber: 10, removed: true }),
      ];
    },
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 + Number(tag) }),
  });
  const row = history.escrows[0];
  check(row && row.terms && row.terms.amount === "1000" && row.terms.fee === "3" && row.terms.claimTip === "5",
    "history decoded amount, fee and claim tip");
  check(row.status.isFunded === true && row.status.ready === true && row.status.isClaimed === true,
    "history joined the settlement events");
  check(history.checkpoint && history.checkpoint.number === 20 && history.checkpoint.hash === H(20), "history returned its block checkpoint");
  check(requests.length === 1 && requests[0].address[0] === ESCROW.toLowerCase(), "history did not use one address-filtered request");
  check(history.escrows.length === 1, "history returned an escrow that was not requested");
  let noStart = null;
  try { await orderHistory({ escrows: [ESCROW], evmLogs: async () => [] }); } catch (error) { noStart = error; }
  check(noStart && noStart.code === "bad-input" && noStart.params.field === "fromBlock",
    "an explicit list was refused without fromBlock");
}
{
  const calls = [];
  const history = await orderHistory({
    escrows: [ESCROW], fromBlock: 0, toBlock: 20,
    checkpoint: { number: 10, hash: H(10) },
    evmLogs: async (request) => { calls.push(request.fromBlock); return []; },
    evmBlock: async (tag) => ({ number: Number(tag), hash: tag === 10 ? H(10) : H(Number(tag)), timestamp: 1000 }),
  });
  check(calls[0] === 11 && history.replayed === false, "a matching checkpoint resumed after its block");
  let replayFrom = null;
  const replayed = await orderHistory({
    escrows: [ESCROW], fromBlock: 0, toBlock: 20,
    checkpoint: { number: 10, hash: H(10) },
    evmLogs: async (request) => { replayFrom = request.fromBlock; return []; },
    evmBlock: async (tag) => ({ number: Number(tag), hash: tag === 10 ? H(99) : H(Number(tag)), timestamp: 1000 }),
  });
  check(replayed.replayed === true && replayFrom === 0, "a moved checkpoint did not replay from the range start");
}

// --- an empty key is an empty history, not a refusal ---
{
  const empty = await orderHistory({
    mnemonic: WORDS, chainId: CHAIN, factory: FACTORY, madeBlock: 100, deploymentBlock: 1, toBlock: 20,
    evmLogs: async () => [],
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }),
  });
  check(Array.isArray(empty.escrows) && empty.escrows.length === 0 && empty.swaps.length === 0,
    "an empty key did not return an empty history");
  check(empty.checkpoint && empty.checkpoint.number === 20, "an empty history did not return its checkpoint");
}

// --- a resumed history is the same as a full history, and a moved checkpoint is not mixed ---
{
  const all = [
    termsLog({ blockNumber: 7 }),
    settlementLog(ESCROW_EVENT_TOPICS.ready, 8, "0x", [ESCROW_EVENT_TOPICS.ready, pad(LOCKER)]),
    settlementLog(ESCROW_EVENT_TOPICS.halfRevealed, 9, words("0x" + "11".repeat(32), 1)),
    settlementLog(ESCROW_EVENT_TOPICS.ready, 12, "0x", [ESCROW_EVENT_TOPICS.ready, pad(LOCKER)]),
    settlementLog(ESCROW_EVENT_TOPICS.halfRevealed, 13, words("0x" + "12".repeat(32), 0)),
  ];
  const read = async (logs, extra = {}) => orderHistory({
    escrows: [ESCROW], fromBlock: 0, toBlock: 20, evmLogs: async () => logs,
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }), ...extra,
  });
  const full = await read(all);
  const first = await read(all.slice(0, 3), { toBlock: 10 });
  const resumed = await read(all.slice(3), { checkpoint: first.checkpoint, previous: first.escrows });
  const shape = (result) => ({ terms: result.escrows[0].terms && { amount: result.escrows[0].terms.amount, fee: result.escrows[0].terms.fee },
    status: result.escrows[0].status, events: result.escrows[0].events.length });
  check(JSON.stringify(shape(resumed)) === JSON.stringify(shape(full)), "a resumed history was not the full history");
  let replayLogs = null;
  const moved = await read([], { checkpoint: { number: 10, hash: H(99) }, previous: first.escrows,
    evmLogs: async (request) => { replayLogs = request.fromBlock; return all; } });
  check(replayLogs === 0 && JSON.stringify(shape(moved)) === JSON.stringify(shape(full)),
    "a moved checkpoint did not replay and match the full history");
}

// --- lookup: creation block and the terms event ---
{
  const lookup = await orderLookup(ESCROW, {
    factory: FACTORY, deploymentBlock: 0, toBlock: 200,
    evmLogs: async () => [termsLog({ blockNumber: 7 }), createdLog({ blockNumber: 100 })],
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }),
  });
  check(lookup.found === true && lookup.creationBlock === 100 && lookup.order.escrow.toLowerCase() === ESCROW,
    "lookup found the creation block");
  check(lookup.terms && lookup.terms.fee === "3" && lookup.terms.claimTip === "5", "lookup joined the terms");
  const absent = await orderLookup(ESCROW, {
    factory: FACTORY, toBlock: 200,
    evmLogs: async () => [createdLog({ removed: true })],
    evmBlock: async (tag) => ({ number: Number(tag), hash: H(Number(tag)), timestamp: 1000 }),
  });
  check(absent.found === false && absent.creationBlock === null, "a removed creation log was not an order");
}

// --- funding: pending, expired at the signed deadline, landed when the escrow answered ---
{
  const callTags = [];
  const blockTags = [];
  const call = async ({ block: tag }) => { callTags.push(tag); return ""; };
  const block = async (tag) => { blockTags.push(tag); return { number: 1, hash: H(1), timestamp: 99 }; };
  const defaulted = await orderFunding({ escrow: ESCROW, validUntil: 100, network: "arbitrum-sepolia", call, block });
  check(defaulted.finality === "safe", "the network finality table did not name the default tag");
  const pending = await orderFunding({ escrow: ESCROW, validUntil: 100, finality: "safe", call, block });
  check(pending.state === "pending" && pending.finality === "safe", "an address without code was pending before expiry");
  check(callTags[0] === "safe" && blockTags[0] === "safe", "the contract and the block were not read at the same finality");
  const expired = await orderFunding({ escrow: ESCROW, validUntil: 99, finality: "safe", call, block });
  check(expired.state === "expired", "an address without code was expired at the signed deadline");
  const landed = await orderFunding({
    escrow: ESCROW, validUntil: 99, finality: "finalized",
    call: async () => words(1, 0, 0, 1000),
    block: async () => ({ number: 5, hash: H(5), timestamp: 1000 }),
  });
  check(landed.state === "landed" && landed.status.isFunded === true, "a funded escrow was landed");
  let depth = null;
  try { await orderFunding({ escrow: ESCROW, validUntil: 100, network: "bsc", call, block }); } catch (error) { depth = error; }
  check(depth && depth.code === "bad-input" && depth.params.field === "finality" && depth.params.why === "depth-not-tag",
    "a depth network silently used a formal tag");
  let invalid = null;
  try { await orderFunding({ escrow: ESCROW, validUntil: 100, finality: "head", call, block }); } catch (error) { invalid = error; }
  check(invalid && invalid.code === "bad-input" && invalid.params.field === "finality", "an unknown finality was accepted");
  let badStatus = null;
  try {
    await orderFunding({ escrow: ESCROW, validUntil: 100, finality: "safe",
      call: async () => "0x1234", block: async () => ({ number: 1, hash: H(1), timestamp: 99 }) });
  } catch (error) { badStatus = error; }
  check(badStatus && badStatus.code === "bad-input" && badStatus.params.field === "status",
    "an unreadable status was not a named refusal");
  let missing = null;
  try { await orderFunding({ escrow: ESCROW, validUntil: 100, call, block: null }); } catch (error) { missing = error; }
  check(missing && missing.code === "bad-input" && missing.params.field === "block", "funding without a block read was refused");
}

// --- one search start, and removed creation logs never become orders ---
{
  check(recoverySearchStart({ madeBlock: 720_000, deploymentBlock: 1 }) === 360_000, "the day-grid search start changed");
  check(recoverySearchStart({ madeBlock: 100, deploymentBlock: 50 }) === 50, "the search start went below deployment");
  const startAt = Date.UTC(2026, 9, 1) / 1000 - 86_400;
  const behind = await recoveryStartBlock({
    madeBlock: 720_000, deploymentBlock: 1, head: 100_000, startAt,
    blockAt: async () => 5_000,
  });
  check(behind.block === 5_000 && behind.source === "month", "a node behind the day line did not fall back to the month block");
  const noHead = await recoveryStartBlock({ madeBlock: 720_000, deploymentBlock: 1, startAt,
    blockAt: async () => 5_000 });
  check(noHead.block === 5_000 && noHead.source === "month", "a key with no head did not use its month date");
  const ahead = await recoveryStartBlock({ madeBlock: 720_000, deploymentBlock: 1, head: 900_000, startAt,
    blockAt: async () => 5_000 });
  check(ahead.block === 360_000 && ahead.source === "made", "a readable day line did not win over the month block");
  const bare = await recoveryStartBlock({ deploymentBlock: 77 });
  check(bare.block === 77 && bare.source === "deployment", "no key block and no start date did not fall back to deployment");
  const starts = [];
  const live = createdLog({ blockNumber: 100 });
  const removed = createdLog({ blockNumber: 90, removed: true });
  const found = await findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: FACTORY, madeBlock: 720_000, deploymentBlock: 1,
    evmLogs: async (request) => { starts.push(request.fromBlock); return [removed, live]; },
  });
  check(starts[0] === 360_000, `findSwaps did not use the shared search start: ${starts[0]}`);
  check(found.swaps.length === 1 && found.swaps[0].escrow.toLowerCase() === ESCROW, "a removed creation log was returned as an order");
}

if (problems.length) {
  console.error("FAILED:");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
console.log(`PASSED: ${checks} order read/history/lookup/funding checks`);
