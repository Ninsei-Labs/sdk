// THE NETWORK READER FOR SETTLEMENT LOGS.
//
// A recovery page asks a public RPC for settlement events WITHOUT naming the escrows it cares about: the request
// carries only the event topics and a block range, and the caller filters the answer locally. That privacy goal
// makes provider limits a correctness problem: a broad range, or one very dense block, can be refused or truncated,
// and an empty answer must not look like "there are no events".
//
// This module owns that reader. Callers supply the RPC list (the page has its own CORS-checked endpoints), the
// fetch implementation and the limits; the module owns range splitting, provider fallthrough, the block-receipts
// fallback for one refused block, and the rule that an incomplete read is an error, never [].

import { SdkError } from "./errors.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_BLOCK_RE = /^0x[0-9a-f]+$/i;
const TAG_RE = /^(?:earliest|latest)$/;

/** The default block window for one log request. */
export const SETTLEMENT_LOG_WINDOW = 9_000_000;
/** The default per-RPC timeout. */
export const SETTLEMENT_LOG_TIMEOUT_MS = 8_000;

const bad = (field) => new SdkError("bad-input", { field });
const failed = (why) => new SdkError("recovery-failed", { stage: "logs", why });

// A range refusal is an internal signal only. It is deliberately not an `SdkError`: it never crosses the public
// boundary, so it cannot become an unregistered error code. `readRange` turns it into a split or a named
// `recovery-failed`.
class RangeTooWide extends Error {
  constructor() {
    super("range-too-wide");
    this.name = "RangeTooWide";
  }
}

const isHexBlock = (value) => typeof value === "string" && HEX_BLOCK_RE.test(value);

const blockTag = (value, fallback, field) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return "0x" + value.toString(16);
  if (typeof value === "string" && (HEX_BLOCK_RE.test(value) || TAG_RE.test(value))) return value;
  throw bad(field);
};

const matchesFilter = (log, filter) => {
  if (filter.address !== undefined) {
    const wanted = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((entry) => entry.toLowerCase());
    if (!wanted.includes(String(log.address || "").toLowerCase())) return false;
  }
  const topics = Array.isArray(log.topics) ? log.topics : [];
  for (let index = 0; index < filter.topics.length; index++) {
    const wanted = filter.topics[index];
    if (wanted === null) continue;
    const actual = String(topics[index] || "").toLowerCase();
    if (Array.isArray(wanted)) {
      if (!wanted.some((entry) => entry.toLowerCase() === actual)) return false;
    } else if (wanted.toLowerCase() !== actual) {
      return false;
    }
  }
  return true;
};

async function readBlockReceipts({ rpcs, fetchImpl, timeoutMs, block, filter }) {
  for (const url of rpcs) {
    let body;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockReceipts", params: [block] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) continue;
      body = await response.json();
    } catch {
      continue;
    }
    if (!body || body.error || !Array.isArray(body.result)) continue;
    const logs = [];
    for (const receipt of body.result) {
      for (const log of Array.isArray(receipt && receipt.logs) ? receipt.logs : []) {
        if (matchesFilter(log, filter)) logs.push(log);
      }
    }
    return logs;
  }
  throw failed("block-receipts");
}

/**
 * Build the `evmLogs` seam used by `readEscrowEventsByTopic`.
 *
 * `rpcs` are tried in order. A range refused as too wide is split down to one block; a single block refused by
 * every RPC falls back to `eth_getBlockReceipts`, requested by block number only, and the same address/topic
 * filters are applied locally. If no provider can complete the evidence, the reader throws: an incomplete answer
 * is unknown, never an empty list.
 */
export function createSettlementLogReader(options = {}) {
  const rpcs = options.rpcs;
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  const timeoutMs = options.timeoutMs === undefined ? SETTLEMENT_LOG_TIMEOUT_MS : options.timeoutMs;
  const maxWindow = options.maxWindow === undefined ? SETTLEMENT_LOG_WINDOW : options.maxWindow;

  if (!Array.isArray(rpcs) || rpcs.length === 0 || rpcs.some((url) => typeof url !== "string" || !url)) {
    throw bad("rpcs");
  }
  if (typeof fetchImpl !== "function") throw bad("fetchImpl");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw bad("timeoutMs");
  if (!Number.isSafeInteger(maxWindow) || maxWindow <= 0) throw bad("maxWindow");

  return async function readLogs(request) {
    if (!request || typeof request !== "object") throw bad("request");
    if (!Array.isArray(request.topics)) throw bad("topics");
    for (const topic of request.topics) {
      if (topic === null) continue;
      if (typeof topic === "string") continue;
      if (Array.isArray(topic) && topic.every((entry) => typeof entry === "string")) continue;
      throw bad("topics");
    }
    const address = request.address;
    if (address !== undefined) {
      const list = Array.isArray(address) ? address : [address];
      if (list.length === 0 || list.some((entry) => typeof entry !== "string" || !ADDRESS_RE.test(entry))) {
        throw bad("address");
      }
    }
    const from = blockTag(request.fromBlock, "earliest", "fromBlock");
    const to = blockTag(request.toBlock, "latest", "toBlock");
    const filter = { topics: request.topics };
    if (address !== undefined) filter.address = Array.isArray(address) ? address.map((entry) => entry.toLowerCase()) : address.toLowerCase();

    const windows = [];
    if (HEX_BLOCK_RE.test(from) && HEX_BLOCK_RE.test(to)) {
      const start = Number(BigInt(from));
      const end = Number(BigInt(to));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw bad("toBlock");
      for (let at = start; at <= end; at += maxWindow) {
        windows.push([blockTag(at, null, "fromBlock"), blockTag(Math.min(end, at + maxWindow - 1), null, "toBlock")]);
      }
    } else {
      windows.push([from, to]);
    }

    const readRange = async (fromBlock, toBlock) => {
      const providerFilter = { ...filter, fromBlock, toBlock };
      try {
        return await readFromProviders(providerFilter);
      } catch (error) {
        if (error instanceof RangeTooWide) {
          // ONLY NUMERIC HEX ENDPOINTS CAN BE SUBDIVIDED. `earliest`/`latest` are tags, not heights: calling
          // BigInt on them would throw a raw SyntaxError and hide the incomplete read. A tag range is returned as
          // the named unknown instead.
          if (!isHexBlock(fromBlock) || !isHexBlock(toBlock)) throw failed("range-too-wide");
          if (fromBlock !== toBlock) {
            const start = Number(BigInt(fromBlock));
            const end = Number(BigInt(toBlock));
            const middle = Math.floor((start + end) / 2);
            const left = await readRange(blockTag(start, null, "fromBlock"), blockTag(middle, null, "toBlock"));
            const right = await readRange(blockTag(middle + 1, null, "fromBlock"), blockTag(end, null, "toBlock"));
            return [...left, ...right];
          }
        }
        // A ONE-BLOCK READ THAT STILL FAILS IS THE HARD CASE. The receipts are a second, address-free view of the
        // same block; the caller's filters are applied locally after the provider answers.
        if (isHexBlock(fromBlock) && fromBlock === toBlock) {
          return readBlockReceipts({ rpcs, fetchImpl, timeoutMs, block: fromBlock, filter });
        }
        throw error;
      }
    };

    const logs = [];
    for (const [fromBlock, toBlock] of windows) logs.push(...(await readRange(fromBlock, toBlock)));
    return logs;
  };

  async function readFromProviders(filter) {
    let refusedWidth = false;
    for (const url of rpcs) {
      let body;
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) continue;
        body = await response.json();
      } catch {
        continue;
      }
      if (body && body.error) {
        const message = String(body.error.message || "");
        if (Number(body.error.code) === -32005 || message.match(/(?:block\s*range|range\s+too|too\s+many\s+(?:blocks|results)|more\s+than\s+\d+\s+results|too\s+wide|maximum.*(?:block|range)|max\s*results|response\s+size)/i)) {
          refusedWidth = true;
        }
        continue;
      }
      if (!body || !Array.isArray(body.result)) continue;
      return body.result;
    }
    throw refusedWidth ? new RangeTooWide() : failed("providers");
  }
}

export { ADDRESS_RE as SETTLEMENT_ADDRESS_RE, HEX_BLOCK_RE as SETTLEMENT_BLOCK_RE };
