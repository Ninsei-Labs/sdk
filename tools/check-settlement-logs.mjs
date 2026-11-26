#!/usr/bin/env node
// THE SETTLEMENT LOG READER: PRIVACY SHAPE, RANGE SPLIT, PROVIDER FALLOUT AND THE INCOMPLETE ANSWER.
//
// The reader is the network boundary of the recovery page. These checks drive it with fake providers and assert
// the request that leaves the client, the fallback that completes one hard block, and the rule that an incomplete
// read is an error rather than an empty list.

import assert from "node:assert/strict";
import { SdkError } from "../src/errors.mjs";
import { ESCROW_EVENT_TOPICS, createSettlementLogReader, readEscrowEventsByTopic } from "../src/public/recovery.mjs";

const RPCS = ["https://one.example", "https://two.example", "https://three.example"];
const TOPIC = "0x" + "11".repeat(32);
const OTHER_TOPIC = "0x" + "22".repeat(32);
const ESCROW = "0x" + "33".repeat(20);
const OTHER_ESCROW = "0x" + "44".repeat(20);
const BLOCK = "0xc8";

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`  ok    ${name}`);
};

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const requestOf = (init) => JSON.parse(init.body);

const log = (address, topic, data = "0x") => ({
  address,
  topics: [topic],
  data,
  blockNumber: BLOCK,
  transactionHash: "0x" + "55".repeat(32),
  logIndex: "0x0",
  removed: false,
});

// A wide range is split; both one-block reads complete. Every provider refuses the two-block request, so this
// exercises the split rather than a provider failover.
{
  const calls = [];
  const reader = createSettlementLogReader({
    rpcs: RPCS,
    fetchImpl: async (url, init) => {
      const request = requestOf(init);
      calls.push(request);
      const [filter] = request.params;
      if (request.method === "eth_getLogs") {
        if (filter.fromBlock !== filter.toBlock) {
          return response({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "query returned more than 10000 results" } });
        }
        return response({ jsonrpc: "2.0", id: 1, result: [log(ESCROW, TOPIC)] });
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });
  const logs = await reader({ topics: [[TOPIC]], fromBlock: 100, toBlock: 101 });
  assert.equal(logs.length, 2, "the split did not return both blocks");
  assert.ok(calls.some((request) => request.params[0].fromBlock === "0x64" && request.params[0].toBlock === "0x64"));
  assert.ok(calls.some((request) => request.params[0].fromBlock === "0x65" && request.params[0].toBlock === "0x65"));
  ok("a wide range is split into one-block reads");
}

// A single block refused through the log-result cap falls back to block receipts. The request carries no address;
// the receipt request carries only the block, and the address/topic filters are applied locally.
{
  const requests = [];
  const receiptLogs = [log(ESCROW, TOPIC), log(OTHER_ESCROW, TOPIC), log(ESCROW, OTHER_TOPIC)];
  const reader = createSettlementLogReader({
    rpcs: RPCS,
    fetchImpl: async (url, init) => {
      const request = requestOf(init);
      requests.push(request);
      if (request.method === "eth_getLogs") {
        return response({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "more than 10000 results" } });
      }
      if (request.method === "eth_getBlockReceipts") {
        return response({ jsonrpc: "2.0", id: 1, result: [{ logs: receiptLogs }] });
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });
  const logs = await reader({ topics: [[TOPIC]], fromBlock: 200, toBlock: 200 });
  assert.equal(logs.length, 2, "the receipts fallback did not filter by topic");
  assert.ok(logs.every((entry) => entry.topics[0] === TOPIC), "the receipts fallback kept the wrong topic");
  const logRequest = requests.find((request) => request.method === "eth_getLogs");
  assert.equal(logRequest.params[0].address, undefined, "the log request named an address");
  const receipt = requests.find((request) => request.method === "eth_getBlockReceipts");
  assert.ok(receipt, "the receipts fallback was not requested");
  assert.deepEqual(receipt.params, [BLOCK], "the receipt request must carry only the block");
  ok("a capped single block falls back to address-free block receipts");
}

// When every provider refuses both the log read and the receipts read, the answer is a thrown unknown, never [].
{
  const reader = createSettlementLogReader({
    rpcs: RPCS,
    fetchImpl: async (url, init) => {
      const request = requestOf(init);
      if (request.method === "eth_getLogs") {
        return response({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "more than 10000 results" } });
      }
      return response({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
    },
  });
  await assert.rejects(
    () => reader({ topics: [[TOPIC]], fromBlock: 300, toBlock: 300 }),
    (error) => error instanceof SdkError && error.code === "recovery-failed" && error.params.why === "block-receipts",
    "an incomplete read must throw recovery-failed",
  );
  ok("an incomplete single block is unknown, not an empty list");
}

// A failed provider does not end the read while another provider answers the same filter.
{
  let calls = 0;
  const reader = createSettlementLogReader({
    rpcs: RPCS,
    fetchImpl: async (url) => {
      calls += 1;
      if (url === RPCS[0]) return response({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "rate limited" } });
      if (url === RPCS[1]) return response({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "backend unavailable" } });
      return response({ jsonrpc: "2.0", id: 1, result: [log(ESCROW, TOPIC)] });
    },
  });
  const logs = await reader({ topics: [[TOPIC]], fromBlock: 400, toBlock: 400 });
  assert.equal(logs.length, 1, "the last provider was not used");
  assert.ok(calls >= 3, "the provider list was not tried");
  ok("the reader falls through the configured providers");
}

// The public seam decodes the events the reader returned; the page does not need a second decoder.
{
  const addressTopic = "0x" + "00".repeat(12) + ESCROW.slice(2);
  const reader = createSettlementLogReader({
    rpcs: [RPCS[0]],
    fetchImpl: async () => response({
      jsonrpc: "2.0",
      id: 1,
      result: [{ ...log(ESCROW, ESCROW_EVENT_TOPICS.ready), topics: [ESCROW_EVENT_TOPICS.ready, addressTopic] }],
    }),
  });
  const events = await readEscrowEventsByTopic({ evmLogs: reader, fromBlock: 500, toBlock: 500 });
  assert.equal(events.length, 1, "the event was not decoded");
  assert.equal(events[0].event, "Ready");
  assert.equal(events[0].escrow, ESCROW);
  assert.equal(events[0].by, ESCROW);
  ok("the reader feeds the public settlement decoder");
}

// A missing RPC list is a named input error, not a reader that silently has nowhere to go.
{
  assert.throws(
    () => createSettlementLogReader({ rpcs: [] }),
    (error) => error instanceof SdkError && error.code === "bad-input" && error.params.field === "rpcs",
  );
  ok("an empty RPC list is refused");
}

console.log("");
console.log(`settlement log reader: ${checks} checks passed.`);
