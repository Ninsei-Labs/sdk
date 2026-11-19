#!/usr/bin/env node
// THE NON-ZERO FEE PATH AGAINST THE DEPLOYED CONTRACTS. This runs on an anvil fork pinned by the caller; the
// external RPC is an optional CI dependency, so this check is a separate, non-blocking job.
//
// The provider is the claimer, so the funding is a BUY: the locker sends amount + fee. At birth the escrow holds
// both; the fee reaches the fee vault only on the claim. The test asserts the sent value and all three balances,
// instead of reading the fee formula back from the SDK.
import { randomBytes } from "node:crypto";
import { halfCommitmentHex } from "../engine/atomic/orderHalfCommit.js";
import { encodeCreateOrderAndFund, encodePredict, decodeAddress, ORDER_CREATED_TOPIC } from "../engine/evm/factory.js";
import { ed25519, keccak256, secp256k1 } from "../src/primitives.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";
import { deploymentFor } from "../engine/core/config.js";

const RPC = process.env.ANVIL_RPC || "http://127.0.0.1:8547";
const PIN = deploymentFor("arbitrum-sepolia").escrow;
const FACTORY = (process.env.ANVIL_FACTORY || PIN.address).toLowerCase();
const REGISTRY = (process.env.ANVIL_REGISTRY || PIN.registry).toLowerCase();
const CASHIER = (process.env.ANVIL_CASHIER || PIN.cashier).toLowerCase();

const PROVIDER_KEY = "0x" + randomBytes(32).toString("hex");
const PROVIDER = "0x" + Buffer.from(keccak256(secp256k1.getPublicKey(Buffer.from(PROVIDER_KEY.slice(2), "hex"), false).slice(1))).subarray(-20).toString("hex");
const LOCKER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const RELAYER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const FEE_RECIPIENT = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const AMOUNT = 1_000_000_000_000_000_000n; // 1 ETH principal
const FEE_BPS = 30;
const FEE = (AMOUNT * BigInt(FEE_BPS)) / 10_000n; // 0.003 ETH
const DEPOSIT = AMOUNT + FEE;
const XMR_AMOUNT = 1_000_000_000_000n;

let nextId = 1;
async function rpc(method, params = []) {
  const answer = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  const body = await answer.json();
  if (body.error) throw new Error(method + ": " + JSON.stringify(body.error));
  return body.result;
}
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const balance = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"]));
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addrWord = (address) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const selector = (signature) => "0x" + Buffer.from(keccak256(new TextEncoder().encode(signature))).subarray(0, 4).toString("hex");
const send = (from, to, data, value = 0n) => rpc("eth_sendTransaction", [{ from, to, data,
  value: "0x" + BigInt(value).toString(16), gas: "0xc3500" }]);

async function receipt(hash) {
  for (let i = 0; i < 60; i += 1) {
    const answer = await rpc("eth_getTransactionReceipt", [hash]);
    if (answer) return answer;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no receipt after 15s: " + hash);
}

async function requireCode(address, name) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  if (!code || code === "0x") throw new Error(name + " has no code at " + address);
}

async function registerProvider() {
  const setRegistry = selector("set(string,bytes32,uint32,address)");
  // set("", bytes32(0), 1, factory): an empty endpoint is valid; the record is what makes providerOf answer.
  const data = setRegistry + word(0x80) + word(0) + word(1) + addrWord(FACTORY) + word(0);
  const hash = await send(PROVIDER, REGISTRY, data);
  const result = await receipt(hash);
  if (Number(result.status) !== 1) throw new Error("registry set reverted: " + hash);
}

async function main() {
  await requireCode(FACTORY, "factory");
  await requireCode(REGISTRY, "registry");
  await requireCode(CASHIER, "cashier");

  for (const address of [PROVIDER, LOCKER, RELAYER]) {
    await rpc("anvil_impersonateAccount", [address]);
    await rpc("anvil_setBalance", [address, "0x" + (100n * 10n ** 18n).toString(16)]);
  }
  await registerProvider();

  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const now = Number(BigInt(latest.timestamp));
  const salt = "0x" + randomBytes(32).toString("hex");
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
    readyBy: now + 3600, t1: now + 7200, salt, chainId: 421614,
    feeBps: FEE_BPS, fee: FEE.toString(), feeRecipient: FEE_RECIPIENT,
    validUntil: now + 600, nonce: 1,
    xmrAmount: XMR_AMOUNT.toString(), claimTip: "0",
    factory: FACTORY, ...halves,
  };
  quote.signature = signQuoteDigest({ crypto: { secp256k1 },
    digest: quoteDigest({ crypto: { secp256k1, keccak256 }, quote }), privateKey: PROVIDER_KEY });

  const predicted = decodeAddress(await call(FACTORY, encodePredict(quote)));
  const createHash = await send(LOCKER, FACTORY, encodeCreateOrderAndFund(quote), DEPOSIT);
  const createReceipt = await receipt(createHash);
  if (Number(createReceipt.status) !== 1) throw new Error("createOrderAndFund reverted: " + createHash);
  const log = createReceipt.logs.find((entry) => String(entry.topics[0]).toLowerCase() === ORDER_CREATED_TOPIC);
  if (!log) throw new Error("no OrderCreated in " + createHash);
  const escrow = "0x" + String(log.topics[1]).slice(26).toLowerCase();
  if (escrow !== predicted) throw new Error("event escrow " + escrow + " != predicted " + predicted);

  const escrowAfterBirth = await balance(escrow);
  const feeBeforeClaim = BigInt(await call(CASHIER, "0x70a08231" + addrWord(FEE_RECIPIENT)));
  if (escrowAfterBirth !== DEPOSIT) throw new Error("escrow holds " + escrowAfterBirth + ", expected " + DEPOSIT);
  if (feeBeforeClaim !== 0n) throw new Error("fee credited before claim: " + feeBeforeClaim);

  const mark = selector("markReady()");
  const markReceipt = await receipt(await send(LOCKER, escrow, mark));
  if (Number(markReceipt.status) !== 1) throw new Error("markReady reverted");
  const beforeClaim = await balance(PROVIDER);
  const claimReceipt = await receipt(await send(RELAYER, escrow, selector("claim(bytes32)") + word(7n)));
  if (Number(claimReceipt.status) !== 1) throw new Error("claim reverted");
  const afterClaim = await balance(PROVIDER);
  const feeAfterClaim = BigInt(await call(CASHIER, "0x70a08231" + addrWord(FEE_RECIPIENT)));
  const escrowAfterClaim = await balance(escrow);

  if (afterClaim - beforeClaim !== AMOUNT) throw new Error("claimer delta " + (afterClaim - beforeClaim) + ", expected " + AMOUNT);
  if (feeAfterClaim !== FEE) throw new Error("fee vault credit " + feeAfterClaim + ", expected " + FEE);
  if (escrowAfterClaim !== 0n) throw new Error("escrow retained " + escrowAfterClaim);

  console.log("PASSED: feeBps 30 sent " + DEPOSIT + " wei, escrow held principal+fee at birth, " +
    "the claimer received " + AMOUNT + " and the fee vault credited " + FEE + " wei");
}

main().catch((error) => {
  console.error("ERROR: the non-zero fee fork check could not run: " + String((error && error.message) || error));
  process.exit(1);
});
