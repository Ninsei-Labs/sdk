#!/usr/bin/env node
// THE WALLET MUST BE ON THE ORDER'S NETWORK BEFORE ANY TRANSACTION.
//
// `assertWalletChain` is called by funding, markReady, claim and refund. A wallet left on another chain signs a
// transaction the contract cannot accept; an adapter that cannot answer its chain cannot prove the network and is
// refused as well.
import { assertWalletChain } from "../src/chainGuard.mjs";
import { evmWallet } from "../src/adapters/evm-wallet.mjs";
import { createActions } from "../src/actions.mjs";
import * as engine from "../src/engine.mjs";

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
    const make = (chainHex, account = "0x" + "11".repeat(20)) => {
      const calls = [];
      const p = {
        request: async (request) => {
          if (request.method === "eth_accounts") return [account];
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

    // THE ACCOUNT BOUNDARY. The action captured account A; the wallet now serves account B. The claim half must not
    // reach eth_sendTransaction: a reverted transaction would still publish the calldata.
    const accountA = "0x" + "11".repeat(20);
    const accountB = "0x" + "44".repeat(20);
    const accountGood = make("0x1", accountA);
    try {
      await accountGood.wallet.send({ to: "0x" + "33".repeat(20), data: "0x", chainId: 1, from: accountA });
      check(accountGood.calls.length === 1 && accountGood.calls[0].from.toLowerCase() === accountA,
        "send did not put the fresh account into the transaction");
    } catch (error) { check(false, "a matching account send was refused: " + (error && error.code)); }
    const accountWrong = make("0x1", accountB);
    try {
      await accountWrong.wallet.send({ to: "0x" + "33".repeat(20), data: "0x", chainId: 1, from: accountA });
      check(false, "send from another account passed");
    } catch (error) {
      check(error && error.code === "wrong-account" && error.params && error.params.got === accountB && error.params.want === accountA,
        "send wrong-account shape: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
    }
    check(accountWrong.calls.length === 0, "a mismatched account reached eth_sendTransaction");
  }

  // THE ACTION SEAM MUST PASS THE CAPTURED SENDER INTO THE ADAPTER. The adapter test above proves the refusal;
  // this test proves that markReady actually hands the action's account to it.
  {
    const sender = "0x" + "55".repeat(20);
    const slot = "0x" + "11".repeat(32);
    const word = (value) => BigInt(value).toString(16).padStart(64, "0");
    const state = "0x" + [1, 0, 0, 0].map(word).join("");
    const call = async ({ data }) => {
      if (data === engine.escrow.encodeStatus()) return state;
      if (data === engine.escrow.encodeRead("ready")) return "0x" + word(0);
      if (data === engine.escrow.encodeRead("readyBy")) return "0x" + word(9999999999);
      if (data === engine.escrow.encodeT1()) return "0x" + word(99999999999);
      return slot;
    };
    const sent = [];
    const wallet = {
      address: async () => sender,
      chainId: async () => 1,
      send: async (tx) => { sent.push(tx); return "0x" + "ab".repeat(32); },
      receipt: async () => ({}),
    };
    const expect = { chainId: 1, edPointLocker: slot, edPointClaimer: slot, edViewPointLocker: slot,
      commitHalfLocker: slot, commitHalfClaimer: slot };
    try {
      await createActions({ call, blockTime: async () => 1000 })
        .markReady({ escrow: "0x" + "aa".repeat(20), expect }, wallet);
      check(sent.length === 1 && sent[0].from === sender, "markReady did not pass its captured sender to the wallet");
    } catch (error) { check(false, "markReady sender seam failed: " + (error && error.code)); }
  }

  notes.push("funding, markReady, claim and refund read the wallet chain before signing");
  notes.push("the EVM adapter reads eth_chainId again at the send boundary and puts chainId into the transaction");
  notes.push("the EVM adapter reads eth_accounts at the send boundary and refuses an account other than the action's sender");
  return { note: "the wallet must be on the order's chain and account before any transaction and at the send boundary", problems, notes };
};

if (import.meta.main) {
  const result = await chainGuardCheck();
  for (const problem of result.problems) console.log("  FAIL  " + problem);
  console.log(result.problems.length ? "FAILED" : "chain guard: " + result.note);
  if (result.problems.length) process.exit(1);
}
