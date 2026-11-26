#!/usr/bin/env node
// THE "UNKNOWN, NEVER EMPTY" RULE IS LOAD-BEARING.
//
// The shipped reader must throw when every provider refuses both the log read and the block receipts. This check
// mutates a copy of the fallback so it returns `[]`, then compares the two readers on the same fake providers.
// Without that reddening run, the assertion in check-settlement-logs.mjs would be decoration.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SdkError } from "../src/errors.mjs";
import { createSettlementLogReader } from "../src/public/recovery.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src", "recovery-logs.mjs");
const TOPIC = "0x" + "11".repeat(32);
const RPC = "https://one.example";
const dir = mkdtempSync(join(tmpdir(), "sdk-settlement-logs-teeth-"));

let checks = 0;
const problems = [];
const ok = (name) => {
  checks += 1;
  console.log(`  ok    ${name}`);
};
const bad = (name, why) => {
  problems.push(`${name}: ${why}`);
  console.log(`  FAIL  ${name}: ${why}`);
};

const response = (body) => ({ ok: true, status: 200, json: async () => body });
const fakeFetch = async (url, init) => {
  const request = JSON.parse(init.body);
  if (request.method === "eth_getLogs") {
    return response({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "query returned more than 10000 results" } });
  }
  return response({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } });
};

try {
  const real = createSettlementLogReader({ rpcs: [RPC], fetchImpl: fakeFetch });
  let realError = null;
  try {
    await real({ topics: [[TOPIC]], fromBlock: 200, toBlock: 200 });
  } catch (error) {
    realError = error;
  }
  if (realError instanceof SdkError && realError.code === "recovery-failed" && realError.params.why === "block-receipts") {
    ok("the shipped reader throws when both the logs and the receipts are refused");
  } else {
    bad("shipped unknown", `got ${realError ? realError.code : "an empty answer"}`);
  }

  const source = readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
  const guard = 'throw failed("block-receipts");';
  if (!source.includes(guard)) throw new Error("the receipts fallback moved; update this teeth check");
  const mutantSource = source
    .replace('from "./errors.mjs"', `from "${pathToFileURL(join(ROOT, "src", "errors.mjs")).href}"`)
    .replace(guard, "return [];");
  if (mutantSource === source) throw new Error("the mutation changed nothing");
  const mutantPath = join(dir, "recovery-logs.mjs");
  writeFileSync(mutantPath, mutantSource, "utf8");
  const mutantModule = await import(pathToFileURL(mutantPath).href + "?v=" + process.pid);
  const mutant = mutantModule.createSettlementLogReader({ rpcs: [RPC], fetchImpl: fakeFetch });
  const mutantLogs = await mutant({ topics: [[TOPIC]], fromBlock: 200, toBlock: 200 });
  if (Array.isArray(mutantLogs) && mutantLogs.length === 0) {
    ok("removing the receipts error makes an incomplete block look empty (the guard is load-bearing)");
  } else {
    bad("receipts fallback mutation", "the mutant did not produce the empty answer");
  }
} catch (error) {
  bad("teeth setup", String(error && error.message ? error.message : error));
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (problems.length) {
  console.log(`FAILED: ${problems.length} (passed ${checks})`);
  process.exit(1);
}
console.log(`settlement logs teeth: ${checks} checks passed.`);
