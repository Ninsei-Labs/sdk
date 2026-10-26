#!/usr/bin/env node
// THE DEPLOYED CONTRACT IS THE ORACLE, NOT A FIXTURE.
//
// This is the cheapest real check: no Anvil, no wallet, no transaction. It asks the configured RPC for the chain,
// the factory code and `implementation()`, and compares the implementation code hash with the SDK's registry. It
// catches a wrong network, a stale address, a replaced implementation and a deployment whose bytecode differs from
// the one the SDK was built against.
//
// Run:
//   RPC_URL=https://sepolia-rollup.arbitrum.io/rpc node tools/check-live-contract.mjs
//
// Environment:
//   RPC_URL       RPC endpoint (default: the public Arbitrum Sepolia endpoint)
//   FACTORY       factory address (default: the testnet release in the SDK config)
//   CASHIER       cashier address (default: the same release)
//   IMPLEMENTATION_CODEHASH  expected bytes32 (default: the same release)
import { keccak256 } from "../src/primitives.mjs";
import { decodeAddress } from "../engine/evm/factory.js";

const RPC = process.env.RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
const FACTORY = (process.env.FACTORY || "0x69b5a6878b542960af4d239ecc60ad1c9e3e6932").toLowerCase();
const CASHIER = (process.env.CASHIER || "0x05b7433f66f2b75cc7ece9ec00af0fb810f9c9e0").toLowerCase();
const EXPECTED_CODEHASH = (process.env.IMPLEMENTATION_CODEHASH
  || "0xc6cde36301b6551a6ca8bd2c47fbd5ffd01ffcdf22d2f6909be2b3b2dcf360b4").toLowerCase();
const CHAIN_ID = 421614;

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
let nextId = 1;
async function rpc(method, params = []) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const answer = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      });
      if (!answer.ok) throw new Error("HTTP " + answer.status);
      const body = await answer.json();
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body.result;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw last;
}
const codeOf = (address) => rpc("eth_getCode", [address, "latest"]);
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const selector = (signature) => "0x" + Buffer.from(keccak256(new TextEncoder().encode(signature))).subarray(0, 4).toString("hex");

console.log("=== 1) THE RPC IS THE CONFIGURED CHAIN ===");
try {
  const chainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (chainId === CHAIN_ID) ok("eth_chainId is " + chainId);
  else bad("eth_chainId is " + chainId + ", expected " + CHAIN_ID);
} catch (error) {
  bad("RPC chain id: " + String(error.message || error));
}

console.log("=== 2) THE FACTORY AND CASHIER HAVE CODE ===");
for (const [label, address] of [["factory", FACTORY], ["cashier", CASHIER]]) {
  try {
    const code = await codeOf(address);
    if (typeof code === "string" && code !== "0x" && code.length > 2) ok(`${label} ${address} has ${(code.length - 2) / 2} bytes of code`);
    else bad(`${label} ${address} has no code`);
  } catch (error) {
    bad(`${label} code: ` + String(error.message || error));
  }
}

console.log("=== 3) implementation() AND ITS CODE HASH ARE THE RELEASE ===");
try {
  const implementation = decodeAddress(await rpc("eth_call", [{ to: FACTORY, data: selector("implementation()") }, "latest"]));
  const code = await codeOf(implementation);
  if (typeof code !== "string" || code === "0x") throw new Error("implementation has no code: " + implementation);
  const digest = "0x" + Buffer.from(keccak256(Uint8Array.from(Buffer.from(code.slice(2), "hex")))).toString("hex");
  if (digest.toLowerCase() === EXPECTED_CODEHASH) ok(`implementation ${implementation} matches code hash ${digest}`);
  else bad(`implementation code hash is ${digest}, expected ${EXPECTED_CODEHASH}`);
} catch (error) {
  bad("implementation: " + String(error.message || error));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "live contract: " + pass + " checks passed.");
if (fails.length) process.exit(1);
