#!/usr/bin/env node
// THE REAL UNISWAP PATH, ON A MAINNET FORK.
//
// The escrow fork proves our contract; this proves the DEX calldata the SDK builds. It forks Ethereum mainnet,
// impersonates a USDC holder, moves USDC to the UniversalRouter (the relay shape pays from the router's own
// balance), then executes the SDK's `uniswapRelayRouterCalldata` and checks that native ETH reached the recipient.
//
// It starts nothing itself. Run locally with:
//   anvil --fork-url https://ethereum-rpc.publicnode.com --port 8546
//   ANVIL_RPC=http://127.0.0.1:8546 node tools/check-anvil-uniswap.mjs
import { uniswapRelayRouterCalldata, uniswapRelayRouterDecode, uniswapRelayDecodePath } from "../src/legs/uniswaprelay-spec.mjs";
import { keccak256 } from "../src/primitives.mjs";

const RPC = process.env.ANVIL_RPC || "http://127.0.0.1:8546";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const ROUTER = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
const USDC_HOLDER = "0x28c6c06298d514db089934071355e5743bf21d60"; // a funded mainnet account; fork-only
const RECIPIENT = "0x0000000000000000000000000000000000001234"; // a plain EOA: no 7702 delegation
const SENDER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"; // Anvil account 3: pays gas, receives nothing
const FEE = 500;
const AMOUNT_IN = 100_000_000n; // 100 USDC

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
const codeOf = (a) => rpc("eth_getCode", [a, "latest"]);
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const balanceOf = async (token, owner) => BigInt(await call(token, selector("balanceOf(address)") + addrWord(owner)));
const ethBalance = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
async function send(from, to, data, value = 0) {
  const hash = await rpc("eth_sendTransaction", [{ from, to, data, value: "0x" + BigInt(value).toString(16), gas: "0x1e8480" }]);
  for (let i = 0; i < 60; i += 1) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (Number(receipt.status) !== 1) throw new Error("transaction reverted: " + hash);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no receipt: " + hash);
}

console.log("=== 0) THE FORK HAS THE REAL UNISWAP CONTRACTS AND USDC ===");
try {
  for (const [label, address] of [["USDC", USDC], ["WETH", WETH], ["UniversalRouter", ROUTER]]) {
    const code = await codeOf(address);
    if (!code || code === "0x") throw new Error(label + " has no code");
  }
  const held = await balanceOf(USDC, USDC_HOLDER);
  if (held >= AMOUNT_IN) ok("USDC, WETH and UniversalRouter have code; the holder has USDC");
  else bad("the USDC holder has only " + held);
} catch (error) {
  bad("fork state: " + String(error.message || error));
  console.log(""); console.log("FAILED: " + fails.length + " (passed " + pass + ")");
  process.exit(1);
}

console.log("=== 1) THE SDK CALLDATA DECODES TO THE FIELDS WE MEAN ===");
const data = uniswapRelayRouterCalldata({
  tokenIn: USDC, weth: WETH, fee: FEE, amountInWei: AMOUNT_IN, amountOutMinimumWei: 0n, recipient: RECIPIENT,
});
const decoded = uniswapRelayRouterDecode(data);
const path = decoded ? uniswapRelayDecodePath(decoded.swap.path) : null;
if (decoded && decoded.swap.payerIsUser === false && decoded.swap.amountInWei === AMOUNT_IN
  && decoded.swap.recipient.toLowerCase() === "0x0000000000000000000000000000000000000002"
  && decoded.unwrap.recipient.toLowerCase() === RECIPIENT.toLowerCase()) {
  ok("payerIsUser is false, the swap pays the router, and the unwrap pays the recipient");
} else bad("calldata decode: " + JSON.stringify(decoded));
if (path && path.tokens.length === 2 && path.tokens[0].toLowerCase() === USDC && path.tokens[1].toLowerCase() === WETH
  && path.fees.length === 1 && path.fees[0] === FEE) {
  ok("the path is USDC -> WETH at fee 500");
} else bad("path: " + JSON.stringify(path));

console.log("=== 2) THE REAL ROUTER EXECUTES THE SDK CALLDATA ===");
try {
  // The relay shape moves the input token to the router first; impersonate a holder to do it on the fork.
  await rpc("anvil_impersonateAccount", [USDC_HOLDER]);
  await rpc("anvil_setBalance", [USDC_HOLDER, "0x" + (10n * 10n ** 18n).toString(16)]);
  const transfer = selector("transfer(address,uint256)") + addrWord(ROUTER) + word(AMOUNT_IN);
  await send(USDC_HOLDER, USDC, transfer);
  const atRouter = await balanceOf(USDC, ROUTER);
  if (atRouter >= AMOUNT_IN) ok("the router holds the input token before the swap");
  else bad("router USDC balance: " + atRouter);

  await rpc("anvil_setBalance", [RECIPIENT, "0x" + (10n * 10n ** 18n).toString(16)]);
  await rpc("anvil_setBalance", [SENDER, "0x" + (10n * 10n ** 18n).toString(16)]);
  const before = await ethBalance(RECIPIENT);
  await send(SENDER, ROUTER, data);
  const after = await ethBalance(RECIPIENT);
  if (after > before) ok(`the recipient received ${(after - before).toString()} wei of native coin`);
  else bad(`recipient balance did not grow: ${before} -> ${after}`);
} catch (error) {
  bad("router execution: " + String(error.message || error));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "anvil uniswap: " + pass + " checks passed.");
if (fails.length) process.exit(1);
