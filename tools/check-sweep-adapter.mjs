// ONE WALLET ADAPTER FOR RESTORE AND SIGN (sdk#92, item 8).
//
// The same object the page opens and syncs is passed to `sweep.restore` and to `sweep.sign`. This guard checks
// that it really carries both roles: the connected wallet, the no-op `open`, and the withdrawal calls.
import { moneroWalletAdapter } from "../src/adapters/monero-wallet.mjs";

const ADDRESS = "55naYi3LrxM6gXXwcSE4MugfkAPPNuzNfe9vPDPHi5apfNuzpzLVQxih3F2TCjS3eWYaR5pddFVfh8dX6jKnYXGtEWJTFHM";

export const sweepAdapterCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const calls = [];
  const library = {
    async getAddress() { return ADDRESS; },
    async setRestoreHeight(height) { calls.push(["height", height]); },
    async getUnlockedBalance() { return 5n; },
    async sync() { calls.push(["sync"]); },
    async sweepUnlocked(request) { calls.push(["sweep", request]); return [{ getFee: () => 3n }]; },
    async relayTxs(signed) { calls.push(["relay", signed]); return ["tx-1"]; },
    async close() { calls.push(["close"]); },
  };
  const adapter = moneroWalletAdapter({
    createWallet: async () => library,
    network: "stagenet",
    serverUri: "https://node.example",
    keys: { seed: "check seed" },
    restoreHeight: 100,
  });
  await adapter.connect();
  check(adapter.driver() === library, "the adapter does not expose the same wallet it opened");
  await adapter.open({ address: ADDRESS, restoreHeight: 100 });
  let wrong = null;
  try { await adapter.open({ address: "55" + "A".repeat(94), restoreHeight: 100 }); } catch (error) { wrong = error; }
  check(wrong && wrong.code === "recovery-failed" && wrong.params && wrong.params.step === "address",
    "open accepted a plan for another address");
  const signed = await adapter.sweepUnlocked({ address: ADDRESS, relay: false });
  check(calls.some((call) => call[0] === "sweep" && call[1].relay === false), "sweepUnlocked did not sign only");
  check((await adapter.fee(signed)) === "3", "the fee was not read from the signed transaction");
  check(JSON.stringify(await adapter.relay(signed)) === JSON.stringify(["tx-1"]), "relay did not send the signed transaction");
  notes.push("the wallet adapter carries the restore and the withdrawal surface");

  return { note: "one wallet adapter serves restore and sign", problems, notes };
};
