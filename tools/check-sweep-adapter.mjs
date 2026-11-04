// ONE WALLET ADAPTER FOR RESTORE AND SIGN (sdk#92, item 8).
//
// The same object the page opens and syncs is passed to `sweep.restore` and to `sweep.sign`. This guard checks
// that it really carries both roles: the connected wallet, the no-op `open`, and the withdrawal calls.
import { moneroWalletAdapter } from "../src/adapters/monero-wallet.mjs";
import { MAX_SWEEP_FEE_ATOMIC, sweepFeeVerdict } from "../src/sweep.mjs";

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
    async sweepUnlocked(request) { calls.push(["sweep", request]); return [{ getFee: () => 3n }, { getFee: () => 4n }]; },
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
  check((await adapter.fee(signed)) === "7", "the fee was not summed over every signed transaction");
  check(JSON.stringify(await adapter.relay(signed)) === JSON.stringify(["tx-1"]), "relay did not send the signed transaction");
  notes.push("the wallet adapter carries the restore and the withdrawal surface");

  // A NODE'S FEE IS NOT TRUSTED. 0.01 XMR is the absolute ceiling; a percentage-sized charge must be refused
  // before the confirmation screen, not presented as a normal withdrawal.
  const normalFee = sweepFeeVerdict({ feeAtomic: 100_000n, amountAtomic: 2_000_000_000_000n });
  check(normalFee.ok === true && normalFee.checked === true, "a normal withdrawal fee was refused");
  const extortion = sweepFeeVerdict({ feeAtomic: 1_800_000_000_000n, amountAtomic: 2_000_000_000_000n });
  check(extortion.ok === false && extortion.code === "sweep-fee-too-high" && extortion.limit === String(MAX_SWEEP_FEE_ATOMIC),
    "a fee near the whole balance was not refused as sweep-fee-too-high");
  const atCeiling = sweepFeeVerdict({ feeAtomic: MAX_SWEEP_FEE_ATOMIC, amountAtomic: 2_000_000_000_000n });
  check(atCeiling.ok === true, "the fee exactly at the ceiling was refused");
  const unknown = sweepFeeVerdict({ feeAtomic: null, amountAtomic: 2_000_000_000_000n });
  check(unknown.ok === false && unknown.code === "sweep-fee-unknown", "an unreported fee was not refused");

  // A MAINNET WALLET IS A WALLET. The adapter used to accept only the networks declared by the demo's engine
  // registry (stagenet/fakechain), so a production withdrawal was refused as bad-input before the library was even
  // called. The address below is stagenet, so the shape check must still refuse it as wrong-chain - but only AFTER
  // the name mainnet passed and createWallet was called.
  let mainnetConfig = null;
  const mainnet = moneroWalletAdapter({
    createWallet: async (config) => { mainnetConfig = config; return library; },
    network: "mainnet",
    serverUri: "https://node.example",
    keys: { seed: "check seed" },
    restoreHeight: 100,
  });
  let wrongChain = null;
  try { await mainnet.connect(); } catch (error) { wrongChain = error; }
  check(wrongChain && wrongChain.code === "wrong-chain", "a stagenet address under mainnet is not refused as wrong-chain: " + JSON.stringify(wrongChain && wrongChain.code));
  check(mainnetConfig && mainnetConfig.networkType === "mainnet", "mainnet did not reach createWallet");
  notes.push("mainnet and testnet are valid Monero networks, not demo-only names");

  return { note: "one wallet adapter serves restore and sign", problems, notes };
};
