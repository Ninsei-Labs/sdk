#!/usr/bin/env node
// DEPLOY THE CONTRACTS FROM THEIR REPOSITORY, THEN CHECK THE RESULT.
//
// A contract vector copied into the SDK can agree with an old ABI for ever. This check takes a contracts
// checkout, runs the repository's own Deploy.s.sol against anvil and reads the addresses and code back. The
// caller names the checkout; in CI the private conformance job checks out the release tag and passes it here.
//
// Run locally:
//   CONTRACTS_DIR=../router-escrow-evm ANVIL_RPC=http://127.0.0.1:8545 node tools/check-contracts-release.mjs
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CONTRACTS = resolve(process.env.CONTRACTS_DIR || "../router-escrow-evm");
const RPC = process.env.ANVIL_RPC || "http://127.0.0.1:8545";
const SENDER = process.env.ANVIL_SENDER || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const FORGE = process.env.FORGE
  || (process.env.FOUNDRY_DIR ? join(process.env.FOUNDRY_DIR, process.platform === "win32" ? "forge.exe" : "forge") : "")
  || (process.platform === "win32" && existsSync("C:/tmp/foundry/forge.exe") ? "C:/tmp/foundry/forge.exe" : "forge");

const problems = [];
const ok = (message) => console.log("  ok    " + message);
const bad = (message) => { problems.push(message); console.log("  FAIL  " + message); };

if (!existsSync(join(CONTRACTS, "script", "Deploy.s.sol"))) {
  bad("no Deploy.s.sol at " + CONTRACTS);
} else {
  const run = spawnSync(FORGE, ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--unlocked", "--sender", SENDER], {
    cwd: CONTRACTS, encoding: "utf8", windowsHide: true, env: { ...process.env, DEPLOY_REGISTRY: "true" },
  });
  if (run.status !== 0) bad("forge deploy failed: " + String(run.stdout || "") + String(run.stderr || ""));
  else ok("the repository's Deploy.s.sol ran against anvil");
}

const file = join(CONTRACTS, "broadcast", "Deploy.s.sol", "31337", "run-latest.json");
let addresses = {};
if (!existsSync(file)) bad("the broadcast file is missing: " + file);
else {
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const tx of data.transactions || []) {
    if (tx.contractName && tx.contractAddress) addresses[tx.contractName] = tx.contractAddress;
  }
  for (const name of ["NinseiEscrowFactory", "NinseiFeeVault", "NinseiMakerRegistry"]) {
    if (addresses[name]) ok(name + " deployed at " + addresses[name]);
    else bad(name + " has no address in the broadcast");
  }
}

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(method + ": " + JSON.stringify(body.error));
  return body.result;
}
for (const [name, address] of Object.entries(addresses)) {
  if (!["NinseiEscrowFactory", "NinseiFeeVault", "NinseiMakerRegistry"].includes(name)) continue;
  try {
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (typeof code === "string" && code !== "0x") ok(name + " has code on chain");
    else bad(name + " has no code at " + address);
  } catch (error) { bad(name + " code read failed: " + String((error && error.message) || error)); }
}

console.log("");
if (problems.length) {
  console.log("FAILED: " + problems.length + " problem(s)");
  process.exit(1);
}
console.log("contracts release: deployed and readable");
