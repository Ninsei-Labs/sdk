#!/usr/bin/env node
// THE WALLET MUST BE ON THE ORDER'S NETWORK BEFORE ANY TRANSACTION.
//
// `assertWalletChain` is called by funding, markReady, claim and refund. A wallet left on another chain signs a
// transaction the contract cannot accept; an adapter that cannot answer its chain cannot prove the network and is
// refused as well.
import { assertWalletChain } from "../src/chainGuard.mjs";
import { evmWallet } from "../src/adapters/evm-wallet.mjs";
import { createActions } from "../src/actions.mjs";
import { send as fund } from "../src/lock.mjs";
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

  // THE CLAIM SEAM USES THE SAME CAPTURED SENDER AND REFUSES A FOREIGN ACCOUNT BEFORE SENDING. The half is
  // revealed by the sender, so a wallet switch after the claimer check must not produce calldata at all.
  {
    const claimer = "0x" + "55".repeat(20);
    const slot = "0x" + "11".repeat(32);
    const word = (value) => BigInt(value).toString(16).padStart(64, "0");
    const state = "0x" + [1, 0, 0, 0].map(word).join("");
    const call = async ({ data }) => {
      if (data === engine.escrow.encodeStatus()) return state;
      if (data === engine.escrow.encodeRead("ready")) return "0x" + word(1);
      if (data === engine.escrow.encodeRead("readyBy")) return "0x" + word(9999999999);
      if (data === engine.escrow.encodeT1()) return "0x" + word(99999999999);
      return slot;
    };
    const expect = { chainId: 1, claimer, edPointLocker: slot, edPointClaimer: slot, edViewPointLocker: slot,
      commitHalfLocker: slot, commitHalfClaimer: slot };
    const sent = [];
    const wallet = {
      address: async () => claimer,
      chainId: async () => 1,
      send: async (tx) => { sent.push(tx); return "0x" + "ab".repeat(32); },
      receipt: async () => ({}),
    };
    try {
      await createActions({ call, blockTime: async () => 1000 })
        .claim({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, claimer, expect }, wallet);
      check(sent.length === 1 && sent[0].from === claimer, "claim did not pass its captured sender to the wallet");
    } catch (error) { check(false, "claim sender seam failed: " + (error && error.code)); }

    const foreign = { ...wallet, address: async () => "0x" + "66".repeat(20), send: async (tx) => { sent.push(tx); return "0x" + "ab".repeat(32); } };
    sent.length = 0;
    try {
      await createActions({ call, blockTime: async () => 1000 })
        .claim({ escrow: "0x" + "aa".repeat(20), halfClaimer: slot, claimer, expect }, foreign);
      check(false, "a claim from a foreign account passed");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.why === "not-the-claimer",
        "a claim from a foreign account did not name the sender refusal");
    }
    check(sent.length === 0, "a foreign-account claim reached eth_sendTransaction");
  }

  // THE FUNDING SEND BOUNDARY USES THE SAME ADAPTER, NOT A TEST DOUBLE. The locker names the depositor; the
  // provider serves it while the action is being assembled and switches to another account before the transaction.
  // The adapter must refuse before eth_sendTransaction, and a matching account must carry `from: locker`.
  {
    const locker = "0x" + "11".repeat(20);
    const claimer = "0x" + "22".repeat(20);
    const factory = "0x" + "33".repeat(20);
    const escrow = "0x" + "44".repeat(20);
    const slot = "0x" + "55".repeat(32);
    const point = "0x" + "66".repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const quote = {
      provider: locker, quoteKey: "0x" + "77".repeat(20), registry: "0x" + "88".repeat(20),
      cashier: "0x" + "99".repeat(20), locker, claimer, amount: "1000000000000000000",
      readyBy: now + 3600, t1: now + 7200, salt: "0x" + "aa".repeat(32),
      commitHalfClaimer: slot, edPointClaimer: point, chainId: 1,
      feeBps: "0", fee: "0", feeRecipient: "0x" + "bb".repeat(20), validUntil: now + 600,
      nonce: "1", xmrAmount: "1000000000000", claimTip: "0", signature: "0x" + "00".repeat(65),
    };
    const request = {
      factory, locker, claimer, commitHalfLocker: slot, commitHalfClaimer: slot,
      edPointLocker: point, edPointClaimer: point, edViewPointLocker: point,
      amountWei: quote.amount, readyBy: quote.readyBy, t1: quote.t1, salt: quote.salt,
      chainId: 1, quote,
    };
    const call = async ({ to }) => (String(to).toLowerCase() === factory.toLowerCase()
      ? "0x" + "0".repeat(24) + escrow.slice(2)
      : "0x");
    const makeWallet = (account, sent) => {
      const provider = {
        request: async ({ method, params }) => {
          if (method === "eth_chainId") return "0x1";
          if (method === "eth_accounts") return [account];
          if (method === "eth_sendTransaction") { sent.push(params[0]); return "0x" + "cc".repeat(32); }
          if (method === "eth_getTransactionReceipt") return null;
          throw new Error("unexpected " + method);
        },
      };
      return evmWallet(provider);
    };

    const sent = [];
    try {
      await fund(request, makeWallet(locker, sent), { call });
      check(sent.length === 1 && sent[0].from.toLowerCase() === locker,
        "funding did not put the order's locker into the transaction");
    } catch (error) {
      check(false, "a matching funding send was refused: " + (error && error.code));
    }

    const foreignSent = [];
    try {
      await fund(request, makeWallet("0x" + "dd".repeat(20), foreignSent), { call });
      check(false, "funding from another account passed");
    } catch (error) {
      check(error && error.code === "wrong-account",
        "funding from another account did not name wrong-account");
    }
    check(foreignSent.length === 0, "a foreign-account funding reached eth_sendTransaction");
  }

  // THE ACTION READS THROUGH ITS OWN WALLET, NOT THE PROCESS-WIDE ENGINE PROVIDER. No `call` seam is passed:
  // the only allowed source is wallet.driver(). The provider must see the reads.
  {
    const slot = "0x" + "11".repeat(32);
    let reads = 0;
    const provider = {
      request: async (request) => {
        if (request.method === "eth_call") { reads += 1; return "0x" + "00".repeat(32); }
        if (request.method === "eth_getBlockByNumber") return { timestamp: "0x3e8" };
        throw new Error("unexpected " + request.method);
      },
    };
    const wallet = {
      address: async () => "0x" + "55".repeat(20),
      chainId: async () => 1,
      driver: () => provider,
      send: async () => "0x" + "ab".repeat(32),
      receipt: async () => ({}),
    };
    const expect = { chainId: 1, edPointLocker: slot, edPointClaimer: slot, edViewPointLocker: slot,
      commitHalfLocker: slot, commitHalfClaimer: slot };
    try {
      await createActions({}).markReady({ escrow: "0x" + "aa".repeat(20), expect }, wallet);
    } catch { /* the zeroed chain answer is refused after the reads; the provider is the assertion */ }
    check(reads > 0, "markReady did not read through the wallet adapter's driver()");
  }

  notes.push("funding, markReady, claim and refund read the wallet chain before signing");
  notes.push("the EVM adapter reads eth_chainId again at the send boundary and puts chainId into the transaction");
  notes.push("the EVM adapter reads eth_accounts at the send boundary and refuses an account other than the action's sender");
  notes.push("funding sends from the order's locker and refuses an account switch before eth_sendTransaction");
  return { note: "the wallet must be on the order's chain and account before any transaction and at the send boundary", problems, notes };
};

if (import.meta.main) {
  const result = await chainGuardCheck();
  for (const problem of result.problems) console.log("  FAIL  " + problem);
  console.log(result.problems.length ? "FAILED" : "chain guard: " + result.note);
  if (result.problems.length) process.exit(1);
}
