#!/usr/bin/env node
// THE WALLET MUST BE ON THE ORDER'S NETWORK BEFORE ANY TRANSACTION.
//
// `assertWalletChain` is called by funding, markReady, claim and refund. A wallet left on another chain signs a
// transaction the contract cannot accept; an adapter that cannot answer its chain cannot prove the network and is
// refused as well.
import { assertWalletChain } from "../src/chainGuard.mjs";
import { evmWallet } from "../src/adapters/evm-wallet.mjs";

export const chainGuardCheck = async () => {
  const want = 421614;
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  try {
    const got = await assertWalletChain({ chainId: async () => want }, want, "fund-order");
    check(got === want, "the matching chain was not returned: " + got);
  } catch (error) { check(false, "the matching chain was refused: " + JSON.stringify(error && error.code)); }

  try {
    await assertWalletChain({ chainId: async () => 1 }, want, "claim");
    check(false, "a wallet on another chain passed");
  } catch (error) {
    check(error && error.code === "wrong-chain" && error.params && error.params.got === 1 && error.params.want === want,
      "wrong chain shape: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }

  try {
    await assertWalletChain({ chainId: async () => { throw new Error("no provider"); } }, want, "refund");
    check(false, "an unreadable chain passed");
  } catch (error) {
    check(error && error.code === "wrong-chain" && error.params && error.params.why === "unreadable",
      "unreadable chain shape: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }

  try {
    await assertWalletChain({ send: async () => "0x" + "11".repeat(32) }, want, "fund-order");
    check(false, "an adapter without chainId passed");
  } catch (error) {
    check(error && error.code === "bad-input" && error.params && error.params.field === "wallet.chainId",
      "missing chainId shape: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }

  // THE SEND BOUNDARY ITSELF. A wallet can switch networks after the action's guard; the adapter must read
  // eth_chainId immediately before eth_sendTransaction, refuse a mismatch and put the chain into the transaction.
  {
    const make = (chainHex) => {
      const calls = [];
      const p = {
        request: async (request) => {
          if (request.method === "eth_accounts") return ["0x" + "11".repeat(20)];
          if (request.method === "eth_chainId") return chainHex;
          if (request.method === "eth_sendTransaction") { calls.push(request.params[0]); return "0x" + "22".repeat(32); }
          throw new Error("unexpected " + request.method);
        },
      };
      return { wallet: evmWallet(p), calls };
    };
    const good = make("0x1");
    try {
      await good.wallet.send({ to: "0x" + "33".repeat(20), data: "0x", value: 5n, chainId: 1 });
      check(good.calls.length === 1 && good.calls[0].chainId === "0x1", "send did not put chainId into the transaction");
    } catch (error) { check(false, "a matching send was refused: " + (error && error.code)); }
    const wrong = make("0x1");
    try {
      await wrong.wallet.send({ to: "0x" + "33".repeat(20), data: "0x", chainId: 421614 });
      check(false, "send on another chain passed");
    } catch (error) {
      check(error && error.code === "wrong-chain" && error.params && error.params.got === 1 && error.params.want === 421614,
        "send wrong-chain shape: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
    }
    check(wrong.calls.length === 0, "a mismatched send reached eth_sendTransaction");
  }

  notes.push("funding, markReady, claim and refund read the wallet chain before signing");
  notes.push("the EVM adapter reads eth_chainId again at the send boundary and puts chainId into the transaction");
  return { note: "the wallet must be on the order's chain before any transaction and at the send boundary", problems, notes };
};

if (import.meta.main) {
  const result = await chainGuardCheck();
  for (const problem of result.problems) console.log("  FAIL  " + problem);
  console.log(result.problems.length ? "FAILED" : "chain guard: " + result.note);
  if (result.problems.length) process.exit(1);
}
