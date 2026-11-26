#!/usr/bin/env node
// ONE BALANCE RESULT IS ONE ACCOUNT ON ONE NETWORK.
//
// A wallet can switch chains or accounts while the SDK reads the native balance and then a token balance. A value
// from the first account and a value from the second must never be presented as one row. This check drives the real
// wallet facade and the real EIP-1193 adapter with a mutable provider, so the refusal is exercised at the same seam
// the site uses.
import { createWallet } from "../src/wallet.mjs";
import { evmWallet } from "../src/adapters/evm-wallet.mjs";

const A = "0x" + "11".repeat(20);
const B = "0x" + "44".repeat(20);
const TOKEN = "0x" + "aa".repeat(20);
const settlement = {
  vm: "evm",
  chainId: 421614,
  tokens: [
    { id: "eth", symbol: "ETH", address: null, decimals: 18 },
    { id: "usdc", symbol: "USDC", address: TOKEN, decimals: 6 },
  ],
};
const hexChain = (id) => "0x" + Number(id).toString(16);

function fixture({ account = A, chain = 421614, during = null, zero = false } = {}) {
  let accounts = [account];
  let chainId = chain;
  const handlers = new Map();
  const provider = {
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return accounts;
      if (method === "eth_chainId") return hexChain(chainId);
      if (method === "wallet_switchEthereumChain") return null;
      if (method === "eth_getBalance") return "0x5";
      if (method === "eth_call") return "0x" + "65".padStart(64, "0");
      throw new Error("unexpected provider method " + method);
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    removeListener(event, handler) {
      const list = handlers.get(event) || [];
      handlers.set(event, list.filter((fn) => fn !== handler));
    },
    emit(event) {
      for (const handler of handlers.get(event) || []) handler();
    },
    setAccount(next) { accounts = [next]; },
    setChain(next) { chainId = next; },
  };
  const controls = {
    setAccount: (next) => provider.setAccount(next),
    setChain: (next) => provider.setChain(next),
    emit: (event) => provider.emit(event),
  };
  const calls = [];
  const leg = {
    walletChainId: (network) => Number(network.chainId),
    sameChain: (got, network) => Number(got) === Number(network.chainId),
    balances: async ({ address, tokens }) => {
      calls.push({ address, tokens: tokens.map((t) => t.id) });
      if (typeof during === "function") during(controls);
      return tokens.map((t) => ({ token: t.id, symbol: t.symbol, decimals: t.decimals,
        amount: zero ? "0" : (t.id === "eth" ? "5" : "101") }));
    },
  };
  const wallet = createWallet({ settlement, leg });
  wallet.use(evmWallet(provider));
  return { wallet, provider, calls };
}

export const walletBalancesCheck = async () => {
  const problems = [];
  const notes = [];
  const ok = (condition, message) => { if (!condition) problems.push(message); };
  const refusal = async (work, expected, label) => {
    try {
      const value = await work();
      problems.push(label + ": returned " + JSON.stringify(value));
    } catch (error) {
      ok(error && error.code === expected, `${label}: expected ${expected}, got ${error && error.code}`);
    }
  };

  // THE STABLE CASE: both rows come from one account and one chain.
  {
    const { wallet, calls } = fixture();
    await wallet.connect({ chainId: 421614 });
    const balances = await wallet.balances();
    ok(balances.length === 2 && balances[0].amount === "5" && balances[1].amount === "101",
      "a stable wallet did not return both exact balances: " + JSON.stringify(balances));
    ok(calls.length === 1 && calls[0].address === A && calls[0].tokens.join() === "eth,usdc",
      "the driver was not called once for the captured account");
  }

  // A measured zero is a number, not a refusal and not an absent row.
  {
    const { wallet } = fixture({ zero: true });
    await wallet.connect({ chainId: 421614 });
    const balances = await wallet.balances();
    ok(balances.length === 2 && balances.every((row) => row.amount === "0"),
      "a stable wallet with zero balances did not return measured zeros");
  }

  // A stable read after an earlier wallet event still returns numbers: the event belongs to the state before the
  // snapshot, not to the read.
  {
    const { wallet, provider } = fixture();
    await wallet.connect({ chainId: 421614 });
    provider.emit("chainChanged");
    const balances = await wallet.balances();
    ok(balances.length === 2 && balances[0].amount === "5" && balances[1].amount === "101",
      "an earlier chain event turned a stable read into a refusal");
  }

  // A provider that is already on another chain before the first reply is refused, and the driver is not called.
  {
    const { wallet, calls } = fixture({ chain: 1 });
    await refusal(() => wallet.balances(), "wrong-chain", "a provider on another chain");
    ok(calls.length === 0, "a foreign chain reached the balance driver");
  }

  // A chain event inside the read is a refusal even if the provider returns to the original chain.
  {
    const { wallet } = fixture({ during: ({ setChain, emit }) => {
      setChain(1);
      emit("chainChanged");
      setChain(421614);
      emit("chainChanged");
    } });
    await wallet.connect({ chainId: 421614 });
    await refusal(() => wallet.balances(), "wrong-chain", "a chain change and return during the read");
  }

  // An account event inside the read is a refusal, including a change to another account and back.
  {
    const { wallet } = fixture({ during: ({ setAccount, emit }) => {
      setAccount(B);
      emit("accountsChanged");
      setAccount(A);
      emit("accountsChanged");
    } });
    await wallet.connect({ chainId: 421614 });
    await refusal(() => wallet.balances(), "wrong-account", "an account change and return during the read");
  }

  // A mixed change names the chain when both sides moved: either refusal is safe, but the chain is the wider
  // statement and must not be hidden by the last event.
  {
    const { wallet } = fixture({ during: ({ setAccount, setChain, emit }) => {
      setChain(1);
      emit("chainChanged");
      setAccount(B);
      emit("accountsChanged");
      setChain(421614);
      emit("chainChanged");
      setAccount(A);
      emit("accountsChanged");
    } });
    await wallet.connect({ chainId: 421614 });
    await refusal(() => wallet.balances(), "wrong-chain", "both sides changed and returned during the read");
  }

  // A change made between the native and token replies, without an event, is caught by the final read.
  {
    const { wallet, calls } = fixture({ during: ({ setAccount }) => setAccount(B) });
    await wallet.connect({ chainId: 421614 });
    await refusal(() => wallet.balances(), "wrong-account", "an account change between the native and token replies");
    ok(calls.length === 1, "the mixed-account read did not reach the driver once");
  }

  if (problems.length) {
    for (const problem of problems) console.log("  FAIL  " + problem);
    return { note: `${problems.length} balance snapshot problem(s)`, problems };
  }
  notes.push("balances are one account on one network, or a named refusal");
  return { note: "the balance snapshot refuses a change of account or chain", problems, notes };
};
