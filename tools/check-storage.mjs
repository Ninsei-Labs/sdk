#!/usr/bin/env node
// STORAGE IS A REFUSAL, NOT A SILENT EMPTY STATE (sdk#113, item 10).
//
// A failed write used to return the record and log a warning; a failed or corrupt read became an empty state,
// which the next write saved over. A second client with another adapter also replaced the process-wide store.
import { memoryStorage, setStorage, bindStorage, loadState, saveState, reset } from "../engine/core/store.js";
import { createNinsei } from "../src/index.mjs";
import { RECOVERY_KEY_STORE, importRecoveryKey, loadRecoveryKey, saveRecoveryKey } from "../src/recovery-key.mjs";

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const codeOf = (fn) => {
  try { fn(); return null; } catch (error) { return error && error.code ? { code: error.code, params: error.params } : { code: null }; }
};

console.log("=== 1) NOTHING STORED IS NOT AN UNREADABLE STORE ===");
{
  const store = memoryStorage();
  setStorage(store);
  const empty = loadState();
  if (empty && empty.swaps && Object.keys(empty.swaps).length === 0) ok("a missing value returns the empty state");
  else bad("missing value -> " + JSON.stringify(empty));
}

console.log("=== 2) A FAILED READ IS NAMED ===");
{
  setStorage({ get() { throw new Error("denied"); }, set() {}, remove() {} });
  const got = codeOf(() => loadState());
  if (got && got.code === "storage-unavailable" && got.params && got.params.step === "read") ok("a throwing get -> storage-unavailable read");
  else bad("throwing get -> " + JSON.stringify(got));
}

console.log("=== 3) A CORRUPT RECORD IS A REFUSAL, NOT EMPTY ===");
{
  const store = memoryStorage(new Map([["ninsei.demo.v1", "{not json"]]));
  setStorage(store);
  const got = codeOf(() => loadState());
  if (got && got.code === "storage-unavailable" && got.params && got.params.step === "parse") ok("invalid JSON -> storage-unavailable parse");
  else bad("invalid JSON -> " + JSON.stringify(got));
}

console.log("=== 4) A FAILED WRITE IS NAMED ===");
{
  setStorage({ get() { return null; }, set() { throw new Error("quota"); }, remove() {} });
  const got = codeOf(() => saveState({ version: 1 }));
  if (got && got.code === "storage-unavailable" && got.params && got.params.step === "write") ok("a throwing set -> storage-unavailable write");
  else bad("throwing set -> " + JSON.stringify(got));
  const removed = codeOf(() => reset());
  if (removed === null) ok("a working remove is unchanged");
  else bad("working remove -> " + JSON.stringify(removed));
}

console.log("=== 5) A SECOND DIFFERENT STORE IS REFUSED ===");
{
  const a = memoryStorage();
  const b = memoryStorage();
  setStorage(a);
  bindStorage(a);
  const got = codeOf(() => bindStorage(b));
  if (got && got.code === "storage-unavailable" && got.params && got.params.step === "conflict") ok("a second different store -> storage-unavailable conflict");
  else bad("second store -> " + JSON.stringify(got));
  setStorage(a);
  const rebound = codeOf(() => bindStorage(b));
  if (rebound === null) ok("setStorage releases the binding for a later instance");
  else bad("reset binding -> " + JSON.stringify(rebound));
}

console.log("=== 5b) THE RECOVERY-KEY STORE HAS THE SAME SPLIT ===");
{
  const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const key = importRecoveryKey(words);
  const absent = memoryStorage();
  if (loadRecoveryKey(absent) === null) ok("no recovery key stored is not an error");
  else bad("absent recovery key did not return null");

  const corrupt = memoryStorage(new Map([[RECOVERY_KEY_STORE, "{not json"]]));
  const parse = codeOf(() => loadRecoveryKey(corrupt));
  if (parse && parse.code === "storage-unavailable" && parse.params.step === "parse") ok("corrupt recovery key -> storage-unavailable parse");
  else bad("corrupt recovery key -> " + JSON.stringify(parse));

  const shape = memoryStorage(new Map([[RECOVERY_KEY_STORE, JSON.stringify({ version: 999, mnemonic: words })]]));
  const wrongShape = codeOf(() => loadRecoveryKey(shape));
  if (wrongShape && wrongShape.code === "storage-unavailable" && wrongShape.params.step === "parse") ok("an unknown recovery-key record -> storage-unavailable parse");
  else bad("unknown recovery-key shape -> " + JSON.stringify(wrongShape));

  const unreadable = { get() { throw new Error("denied"); }, set() {}, remove() {} };
  const read = codeOf(() => loadRecoveryKey(unreadable));
  if (read && read.code === "storage-unavailable" && read.params.step === "read") ok("a throwing recovery-key read -> storage-unavailable read");
  else bad("throwing recovery-key read -> " + JSON.stringify(read));

  const unwritable = { get() { return null; }, set() { throw new Error("quota"); }, remove() {} };
  const write = codeOf(() => saveRecoveryKey(unwritable, key));
  if (write && write.code === "storage-unavailable" && write.params.step === "write") ok("a throwing recovery-key write -> storage-unavailable write");
  else bad("throwing recovery-key write -> " + JSON.stringify(write));
}

console.log("=== 6) A SECOND CLIENT CANNOT TAKE OVER THE FIRST ONE'S STORE ===");
{
  setStorage(memoryStorage());
  const config = { settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet", mode: "sim" };
  const first = createNinsei({ ...config, storage: memoryStorage() });
  const got = codeOf(() => createNinsei({ ...config, storage: memoryStorage() }));
  if (first && got && got.code === "storage-unavailable" && got.params && got.params.step === "conflict") {
    ok("a second client with another store is refused");
  } else bad("second client -> " + JSON.stringify(got));
  setStorage(memoryStorage());
}

console.log("=== 7) A LATER EXPLICIT STORE CANNOT TAKE OVER A DEFAULT CLIENT ===");
{
  setStorage(memoryStorage());
  const config = { settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet", mode: "sim" };
  const first = createNinsei(config);
  const got = codeOf(() => createNinsei({ ...config, storage: memoryStorage() }));
  if (first && got && got.code === "storage-unavailable" && got.params && got.params.step === "conflict") {
    ok("a default-store client keeps its store when a later client brings another");
  } else bad("default-store takeover -> " + JSON.stringify(got));
  setStorage(memoryStorage());
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "storage: " + pass + " checks passed.");
if (fails.length) process.exit(1);
