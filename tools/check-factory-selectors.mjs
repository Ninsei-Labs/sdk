#!/usr/bin/env node
// THE FACTORY SELECTORS FOLLOW THE SIGNED TUPLE, NOT THE RELEASE NOTES.
//
// Adding a field to OrderQuote.Quote changes the ABI of both factory functions. The unit checks can stay green
// while `FACTORY_METHODS` still names the previous tuple: the calldata is well formed, but it calls a function the
// new factory does not have and the first node call reverts after a few hundred gas. That is exactly how claimTip
// shipped stale selectors in 0.46.0.
//
// WHAT IS PROVEN:
//   1) every field of QUOTE_FIELDS has a known ABI type and the tuple is built from the list itself;
//   2) the selectors computed from that tuple equal FACTORY_METHODS;
//   3) a copy of the module with one selector changed reddens the same check (the breaking run).
//
// Run: node tools/check-factory-selectors.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FACTORY_METHODS, QUOTE_FIELDS } from "../engine/evm/factory.js";
import { keccak256 } from "../src/primitives.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FACTORY = join(ROOT, "engine", "evm", "factory.js");

// The ABI type of every quote field, in contract order. A field without a type is a refusal, not a default.
const FIELD_TYPES = {
  provider: "address",
  quoteKey: "address",
  registry: "address",
  cashier: "address",
  locker: "address",
  claimer: "address",
  amount: "uint256",
  readyBy: "uint64",
  t1: "uint64",
  salt: "bytes32",
  commitHalfClaimer: "bytes32",
  edPointClaimer: "bytes32",
  chainId: "uint256",
  feeBps: "uint256",
  fee: "uint256",
  feeRecipient: "address",
  validUntil: "uint64",
  nonce: "uint256",
  xmrAmount: "uint256",
  claimTip: "uint256",
};

const SUFFIX = "bytes32,bytes32,uint8,bytes32,bytes32,bytes32";
const selector = (signature) => "0x" + Buffer.from(keccak256(signature)).subarray(0, 4).toString("hex");

function selectorsFor(fields) {
  const problems = [];
  for (const name of fields) {
    if (!FIELD_TYPES[name]) problems.push("no ABI type for quote field " + name);
  }
  if (problems.length) return { problems };
  const tuple = "(" + fields.map((name) => FIELD_TYPES[name]).join(",") + ")";
  const predictSignature = "predict(" + tuple + "," + SUFFIX + ")";
  const createSignature = "createOrderAndFund(" + tuple + "," + SUFFIX + ")";
  return { predict: selector(predictSignature), createOrderAndFund: selector(createSignature), tuple };
}

function judge(methods, fields) {
  const computed = selectorsFor(fields);
  const problems = [...(computed.problems || [])];
  if (computed.predict !== methods.predict) {
    problems.push("predict is " + methods.predict + ", the tuple computes " + computed.predict);
  }
  if (computed.createOrderAndFund !== methods.createOrderAndFund) {
    problems.push("createOrderAndFund is " + methods.createOrderAndFund + ", the tuple computes " + computed.createOrderAndFund);
  }
  return problems;
}

let passed = 0;
const failures = [];
const ok = (m) => { passed += 1; console.log("  ok    " + m); };
const bad = (m) => { failures.push(m); console.log("  FAIL  " + m); };

console.log("=== 1) THE TUPLE AND THE SELECTORS ===");
{
  const problems = judge(FACTORY_METHODS, QUOTE_FIELDS);
  if (problems.length === 0) ok("FACTORY_METHODS follows the " + QUOTE_FIELDS.length + "-field quote");
  else bad(problems.join(" | "));
}

console.log("=== 2) THE BREAKING RUN ===");
{
  const dir = mkdtempSync(join(tmpdir(), "ninsei-selectors-"));
  const copy = join(dir, "factory.mjs");
  try {
    const source = readFileSync(FACTORY, "utf8");
    const mutated = source.replace(/predict:\s*"0x[0-9a-fA-F]{8}"/, 'predict: "0x00000000"');
    if (mutated === source) throw new Error("the mutation anchor was not found");
    writeFileSync(copy, mutated);
    const broken = await import(pathToFileURL(copy).href + "?run=" + Date.now());
    const brokenProblems = judge(broken.FACTORY_METHODS, broken.QUOTE_FIELDS);
    if (brokenProblems.length > 0) ok("a changed selector reddens the same check");
    else bad("the mutated copy still passed");
  } catch (e) {
    bad("breaking run failed to load: " + String((e && e.message) || e));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.log("\nFAILED: " + failures.length + " case(s)");
  process.exit(1);
}
console.log("\npassed: " + passed + " case(s)");
