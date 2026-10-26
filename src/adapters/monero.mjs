// THE MONERO WALLET AS AN ADAPTER. The core does not drag in WASM or a worker: the library is provided by whoever
// builds the page.
//
// The method names are the ones the sweep page already calls on monero-ts (sweep/sync/getUnlockedBalance/
// sweepUnlocked/relayTxs/close), so the adapter sits on top of it without adapters, and the core stays DOM-free.
//
// IMPORTANT ABOUT WITHDRAWAL SAFETY: signing and sending are split. sweepUnlocked({ relay: false }) only signs;
// sending is a separate call. That way the interface has a point where it can show the person what exactly will
// leave, BEFORE sending rather than after.
import { SdkError } from "../errors.mjs";
import { signedFeeTotal } from "../sweep-fees.mjs";

export function moneroWallet({ createWallet, networkType, serverUri, password = "ninsei-sweep-session", fields = {} }) {
  const build = typeof createWallet === "function" ? createWallet : null;
  // Refusals - with CODES, as everywhere in the core: the phrase for a person is said by the interface, not the adapter.
  const need = () => { if (!wallet) throw new SdkError("bad-input", { field: "wallet", state: "closed" }); };
  let wallet = null;

  return {
    async open(plan) {
      if (!build) throw new SdkError("bad-input", { field: "createWallet" });
      wallet = await build({
        networkType: plan.networkType || networkType,
        server: { uri: serverUri },
        password,
        restoreHeight: Number(plan.restoreHeight) || 0,
        address: plan.address,
        ...fields,
      });
      return undefined;
    },
    async sync() {
      need();
      await wallet.sync();
    },
    async unlockedBalance() {
      need();
      return await wallet.getUnlockedBalance();
    },
    async sweepUnlocked({ address, relay }) {
      need();
      return await wallet.sweepUnlocked({ address, relay });
    },
    // THE FEE OF WHAT WAS SIGNED, when the library reports one. `sweepUnlocked` answers with the signed
    // transactions; monero-ts puts the fee on each transaction and a split sweep pays every one of them. Optional
    // by contract - the core treats a missing method as "unknown", so this adapter says what it can and nothing
    // more; one unreadable fee makes the total unknown, not partial.
    async fee(signed) {
      need();
      return signedFeeTotal(signed);
    },

    async relay(signed) {
      need();
      return await wallet.relayTxs(signed);
    },
    async close() {
      if (wallet) { try { await wallet.close(); } catch { /* closing must not break the report */ } wallet = null; }
    },
  };
}
