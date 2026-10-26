#!/usr/bin/env node
// A REAL CONTRACT ROUND TRIP ON A LOCAL FORK, WITHOUT REAL MONEY.
//
// Anvil forks Arbitrum Sepolia, so the factory, registry, cashier and implementation are the deployed ones. Two of
// Anvil's unlocked accounts stand in for a provider and a user; the quote is signed locally with the provider key.
// The script then does what the SDK does on the money path: predict, createOrderAndFund, markReady, claim - and
// verifies the event, the escrow address and the revealed half.
//
// It starts nothing itself: CI starts `anvil --fork-url ...` and waits for the port. Run locally with:
//   anvil --fork-url https://sepolia-rollup.arbitrum.io/rpc
//   ANVIL_RPC=http://127.0.0.1:8545 node tools/check-anvil-fork.mjs
import { randomBytes } from "node:crypto";
import { halfCommitmentHex } from "../engine/atomic/orderHalfCommit.js";
import { encodeCreateOrderAndFund, encodePredict, decodeAddress, ORDER_CREATED_TOPIC } from "../engine/evm/factory.js";
import { ed25519, keccak256, secp256k1 } from "../src/primitives.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";

const RPC = process.env.ANVIL_RPC || "http://127.0.0.1:8545";
const FACTORY = (process.env.ANVIL_FACTORY || "0x69b5a6878b542960af4d239ecc60ad1c9e3e6932").toLowerCase();
const REGISTRY = (process.env.ANVIL_REGISTRY || "0x4707a6684b654fbd74372ec624efc0f825af0537").toLowerCase();
const CASHIER = (process.env.ANVIL_CASHIER || "0x05b7433f66f2b75cc7ece9ec00af0fb810f9c9e0").toLowerCase();
// Anvil's default accounts: the provider signs the quote, the locker sends the deposit.
const PROVIDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const PROVIDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LOCKER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const AMOUNT = 1_000_000_000_000_000_000n; // 1 ETH, no fee
const XMR_AMOUNT = 1_000_000_000_000n; // 1 XMR in atomic units

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const selector = (signature) => "0x" + Buffer.from(keccak256(new TextEncoder().encode(signature))).subarray(0, 4).toString("hex");

let nextId = 1;
async function rpc(method, params = []) {
  const answer = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await answer.json();
  if (body.error) throw new Error(method + ": " + JSON.stringify(body.error));
  return body.result;
}
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const send = (from, to, data, value = 0) => rpc("eth_sendTransaction", [{ from, to, data, value: "0x" + BigInt(value).toString(16), gas: "0xc3500" }]);
async function receipt(hash) {
  for (let i = 0; i < 40; i += 1) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no receipt after 10s: " + hash);
}
async function statusOf(address) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  if (!code || code === "0x") throw new Error("no code at " + address);
}

const setRegistry = selector("set(string,bytes32,uint32,address)");
const providerOf = selector("providerOf(address)");

async function registerProvider(factory) {
  // set("", bytes32(0), 1, factory): an empty endpoint is valid; the record is what makes providerOf answer.
  const data = setRegistry + word(0x80) + word(0) + word(1) + addrWord(factory) + word(0);
  await receipt(await send(PROVIDER, REGISTRY, data));
  const answer = await call(REGISTRY, providerOf + addrWord(PROVIDER));
  return "0x" + answer.slice(-40).toLowerCase();
}

async function runOrder({ salt, nonce, label }) {
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const now = Number(BigInt(latest.timestamp));
  const readyBy = now + 3600;
  const t1 = readyBy + 3600;
  const halves = {
    commitHalfLocker: halfCommitmentHex(11n, secp256k1, keccak256),
    commitHalfClaimer: halfCommitmentHex(7n, secp256k1, keccak256),
    edPointLocker: ed25519.Point.BASE.multiply(11n).toHex(),
    edPointClaimer: ed25519.Point.BASE.multiply(7n).toHex(),
    edViewPointLocker: ed25519.Point.BASE.multiply(22n).toHex(),
  };
  const quote = {
    provider: PROVIDER, quoteKey: PROVIDER, registry: REGISTRY, cashier: CASHIER,
    locker: LOCKER, claimer: PROVIDER, amount: AMOUNT.toString(),
    readyBy, t1, salt, chainId: 421614,
    feeBps: 0, fee: "0", feeRecipient: PROVIDER, validUntil: now + 600, nonce,
    xmrAmount: XMR_AMOUNT.toString(), claimTip: "0",
    factory: FACTORY, ...halves,
  };
  quote.signature = signQuoteDigest({ crypto: { secp256k1 }, digest: quoteDigest({ crypto: { secp256k1, keccak256 }, quote }), privateKey: PROVIDER_KEY });

  const predicted = decodeAddress(await call(FACTORY, encodePredict(quote)));
  const hash = await send(LOCKER, FACTORY, encodeCreateOrderAndFund(quote), AMOUNT);
  const r = await receipt(hash);
  if (Number(r.status) !== 1) throw new Error(label + ": createOrderAndFund reverted: " + hash);
  const log = r.logs.find((entry) => String(entry.topics[0]).toLowerCase() === ORDER_CREATED_TOPIC);
  if (!log) throw new Error(label + ": no OrderCreated in " + hash);
  const escrow = "0x" + String(log.topics[1]).slice(26).toLowerCase();
  if (escrow !== predicted) throw new Error(label + ": event escrow " + escrow + " != predicted " + predicted);

  // markReady is the locker's statement that the XMR arrived; then the provider claims its own half.
  const mark = selector("markReady()");
  await receipt(await send(LOCKER, escrow, mark));
  const claim = selector("claim(bytes32)");
  await receipt(await send(PROVIDER, escrow, claim + word(7n)));

  const claimed = await call(escrow, selector("claimed()"));
  const revealed = await call(escrow, selector("revealedHalf()"));
  const locker = await call(escrow, selector("locker()"));
  const claimer = await call(escrow, selector("claimer()"));
  return {
    escrow, predicted, claimed: BigInt(claimed) === 1n,
    revealed: "0x" + revealed.slice(-64), locker: "0x" + locker.slice(-40).toLowerCase(),
    claimer: "0x" + claimer.slice(-40).toLowerCase(),
  };
}

console.log("=== 0) THE FORK HAS THE DEPLOYED CONTRACTS ===");
try {
  await statusOf(FACTORY); await statusOf(REGISTRY); await statusOf(CASHIER);
  ok("factory, registry and cashier have code on the fork");
} catch (error) {
  bad("fork contracts: " + String(error.message || error));
  console.log(""); console.log("FAILED: " + fails.length + " (passed " + pass + ")");
  process.exit(1);
}

// Make sure the two stand-in accounts can pay gas and the deposit. A fork usually carries balances, but a fresh
// fork at an old block may not.
await rpc("anvil_setBalance", [PROVIDER, "0x" + (100n * 10n ** 18n).toString(16)]);
await rpc("anvil_setBalance", [LOCKER, "0x" + (100n * 10n ** 18n).toString(16)]);

console.log("=== 1) REGISTER THE PROVIDER IN THE REAL REGISTRY ===");
try {
  const owner = await registerProvider(FACTORY);
  if (owner === PROVIDER.toLowerCase()) ok("providerOf(provider) answers the provider");
  else bad("providerOf(provider) = " + owner);
} catch (error) {
  bad("registry set: " + String(error.message || error));
}

console.log("=== 2) A REAL createOrderAndFund, markReady AND claim ===");
try {
  const salt = "0x" + randomBytes(32).toString("hex");
  // A snapshot taken AFTER provider registration and BEFORE the order. `evm_snapshot` / `evm_revert` is the
  // rollback pair: `anvil_loadState` restores a dump but leaves the forked cache in place, so it cannot prove that
  // the order disappeared. The dump is still taken and loaded below to prove the serialized state is readable.
  const snapshot = await rpc("evm_snapshot");
  const result = await runOrder({ salt, nonce: 1, label: "order-1" });
  if (result.claimed && result.revealed === "0x" + word(7n)) ok("claim moved the state and published half 7");
  else bad("claim result: " + JSON.stringify(result));
  if (result.locker === LOCKER.toLowerCase() && result.claimer === PROVIDER.toLowerCase()) ok("the escrow carries the signed locker and claimer");
  else bad("escrow roles: " + JSON.stringify(result));

  const dump = await rpc("anvil_dumpState");
  if (typeof dump === "string" && dump.length > 2) ok("the state dump is available for reuse");
  else bad("state dump: " + JSON.stringify(dump));
  await rpc("anvil_loadState", [dump]);

  // REWIND AND REPEAT: the first order must disappear, and a second order with a new salt must work without a
  // fresh fork. The deployed factory and the provider record stay (they were in the snapshot).
  await rpc("evm_revert", [snapshot]);
  const firstCode = await rpc("eth_getCode", [result.escrow, "latest"]);
  if (firstCode === "0x") ok("evm_revert removed the first escrow, so scenarios can be repeated");
  else bad("the first escrow survived the revert: " + firstCode.slice(0, 18));
  const second = await runOrder({ salt: "0x" + randomBytes(32).toString("hex"), nonce: 2, label: "order-2" });
  if (!second.claimed) bad("the second order did not claim");
  else ok("a second order ran after the revert with no new fork");
} catch (error) {
  bad("order round trip: " + String(error.message || error));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "anvil fork: " + pass + " checks passed.");
if (fails.length) process.exit(1);
