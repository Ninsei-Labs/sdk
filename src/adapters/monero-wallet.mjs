// THE MONERO WALLET ADAPTER FOR THE SDK CORE: network, its own address, free remainder, sync, stop.
//
// WHAT THIS IS AND HOW IT DIFFERS FROM ITS NEIGHBOUR. Next to it lies `monero.mjs` - it plays a DIFFERENT role: it
// is the XMR WITHDRAWAL wallet for `sweep.run` (open / sync / unlockedBalance / sweepUnlocked / relay / close).
// Here is a wallet connected to the core through THE SAME interface as the EVM wallet (`vm`, `connect`,
// `disconnect`, `address`, `chainId`, `subscribe`, `driver`) plus `unlockedBalance` - the method the core reads
// the free remainder with (sdk/src/wallet.mjs). The roles differ, and they must not be mixed: a withdrawal and a
// wallet have different surfaces.
//
// THE LIBRARY COMES FROM OUTSIDE - THERE IS NO WALLET BUILD OF ITS OWN HERE. The wallet is built BY THE SAME CALL
// the withdrawal page builds it with (sweep/sweep.js): `createWalletFull({ networkType, server: { uri }, password,
// restoreHeight, seed | privateSpendKey/privateViewKey/primaryAddress })`, then `getAddress(0, 0)`,
// `setRestoreHeight`, `getRestoreHeight`, `sync`, `getUnlockedBalance`, `close`. The names were taken from the page
// and verified by a run against the installed monero-ts 0.11.17 build, not chosen from memory. The function is
// brought through the `createWallet` parameter (in the browser - `api.createWalletFull` from the bundle, in node -
// from monero-ts): the core drags in neither WASM nor the page's 3.6 MB worker. The same technique as
// `moneroWallet` for withdrawal.
//
// THE NETWORK IS NOT INVENTED. The network name is checked against the core's registry (www/js/core/config.js,
// XMR_NETWORKS) through the sdk/src/engine.mjs seam, and the SHAPE of its own address - by the same address module
// as the demo's (www/js/monero/address.js, networkFromShape): an address of another network is rejected with a
// CODE, not returned as a balance of the wrong chain.
//
// REFUSALS - WITH CODES. No library, no network, no node, no key, no height, wallet not connected: an SdkError
// with a code and params. Neither `null` nor a zero in place of the answer: an empty address and a zero balance
// look like real data, and that is exactly why they are not returned.
import { SdkError } from "../errors.mjs";
import { config as engineConfig, xmrAddress } from "../engine.mjs";

const XMR_VM = "monero";
// The wallet session label - the same as the withdrawal page's. This is not a secret and not an address, but a session name.
const DEFAULT_PASSWORD = "arrakis-wallet-session";

/** Monero network names declared by the core's registry. The adapter keeps no table of its own. */
const knownNetworks = () => {
  const declared = engineConfig.XMR_NETWORKS || {};
  return [...new Set(Object.values(declared).filter((v) => typeof v === "string" && v))].sort();
};

/**
 * The Monero wallet as an SDK wallet adapter.
 *
 * createWallet - the library function (`createWalletFull`): without it there is nothing to build the wallet with,
 *   and `connect` answers with a code rather than trying to guess the library;
 * network      - a network name from the core's registry (`stagenet`/`mainnet`/`testnet`), as monero-ts accepts it;
 * serverUri    - the node (in production - a proxy, on the stand - your own node);
 * keys         - `{ seed }` or `{ privateSpendKey, privateViewKey, primaryAddress }` - the page's shape;
 * restoreHeight- the restore height: without it a scan of the whole Monero history takes tens of hours;
 * expectedAddress - if set, the derived address must match (otherwise the file/key is wrong).
 */
export function moneroWalletAdapter({
  createWallet = null,
  network = null,
  serverUri = null,
  password = DEFAULT_PASSWORD,
  keys = {},
  restoreHeight = 0,
  expectedAddress = null,
} = {}) {
  let wallet = null;
  let address = null;
  const listeners = new Set();

  const notify = () => {
    for (const handler of listeners) {
      try { handler(); } catch { /* a subscriber must not break the wallet */ }
    }
  };

  const need = (surface) => {
    if (wallet === null) throw new SdkError("wallet-not-connected", { vm: XMR_VM, surface });
    return wallet;
  };

  // THE KEY SHAPE - the same one the page passes to createWalletFull. The primary address is required when a view
  // key is set: the page caught this with the message "must provide primary address if providing private view key".
  const keyFields = () => {
    if (typeof keys.seed === "string" && keys.seed) return { seed: keys.seed };
    if (keys.privateSpendKey || keys.privateViewKey) {
      if (!keys.primaryAddress) throw new SdkError("bad-input", { field: "primaryAddress", why: "required-with-private-keys" });
      const fields = {};
      if (keys.privateSpendKey) fields.privateSpendKey = keys.privateSpendKey;
      if (keys.privateViewKey) fields.privateViewKey = keys.privateViewKey;
      fields.primaryAddress = keys.primaryAddress;
      return fields;
    }
    throw new SdkError("bad-input", { field: "keys", missing: ["seed", "privateSpendKey"] });
  };

  const close = async () => {
    if (wallet === null) return undefined;
    const current = wallet;
    wallet = null;
    address = null;
    try { await current.close(); } catch { /* stopping must not break the report */ }
    return undefined;
  };

  return {
    vm: XMR_VM,
    id: XMR_VM,

    // CREATING THE WALLET - BY THE SAME PATH AS THE PAGE. The order of checks: library -> network -> node -> key ->
    // height. Each missing item is its OWN code with a named field, not a general refusal.
    async connect() {
      if (typeof createWallet !== "function") throw new SdkError("bad-input", { field: "createWallet" });
      const declared = knownNetworks();
      if (typeof network !== "string" || !network) throw new SdkError("bad-input", { field: "network", known: declared });
      if (declared.length && !declared.includes(network)) throw new SdkError("bad-input", { field: "network", known: declared, got: network });
      if (typeof serverUri !== "string" || !serverUri) throw new SdkError("bad-input", { field: "serverUri" });
      // THE KEY AND THE HEIGHT ARE A CONDITION OF WORK, NOT A SETTING: without the key the wallet cannot be built,
      // without the height a scan of the whole Monero history takes tens of hours (the page's measurement: the height
      // is not an optimization but a condition of work).
      const fields = keyFields();
      const height = Number(restoreHeight);
      if (!Number.isFinite(height) || height <= 0) throw new SdkError("bad-input", { field: "restoreHeight", got: restoreHeight });

      await close();
      const created = await createWallet({
        networkType: network,
        server: { uri: serverUri },
        password,
        restoreHeight: height,
        ...fields,
      });
      wallet = created;
      // THE ADDRESS AND THE NETWORK. The address is derived from the keys and is available before syncing; its
      // network must match the named one. The check is done by the page's code (www/js/monero/address.js), not by a
      // private prefix form.
      address = String(await wallet.getAddress(0, 0));
      const shape = typeof xmrAddress.networkFromShape === "function" ? xmrAddress.networkFromShape(address) : null;
      if (shape && shape !== network) { await close(); throw new SdkError("wrong-chain", { got: shape, want: network }); }
      if (expectedAddress && address !== expectedAddress) { await close(); throw new SdkError("recovery-failed", { step: "address" }); }
      // THE HEIGHT IS SET EXPLICITLY AND READ BACK: on a live run the height passed when the wallet was created was
      // not applied (the page set it with a second call). We set it - so that the restore height becomes a FACT that
      // can be read (`driver().getRestoreHeight()`), not a promise.
      await wallet.setRestoreHeight(height);
      notify();
      return undefined;
    },

    async disconnect() { return await close(); },

    // THE NAME FROM THE PAGE: sweep/sweep.js stops the wallet via close(). The same action, the same name.
    async close() { return await close(); },

    address() {
      need("address");
      return address;
    },

    // THE MONERO NETWORK IS NAMED BY A WORD (stagenet/mainnet), not by the settlement network's chainId: there is
    // nothing to compare against - Monero has no leg contract (sdk/src/wallet.mjs, XMR_VM).
    chainId() { return network; },

    // THE FREE REMAINDER - the same method as the XMR withdrawal (the page: getUnlockedBalance), and the same
    // atomic units (1 XMR = 10^12). Zero comes as zero ONLY when the wallet is connected and the node answered so.
    async unlockedBalance() { return await need("unlockedBalance").getUnlockedBalance(); },

    // SYNCING - a separate call (the page calls wallet.sync()). Subscribers are notified AFTER the pass.
    async sync() {
      await need("sync").sync();
      notify();
      return undefined;
    },

    // THE MONERO WALLET HAS NO EVENTS (monero-ts has no on/removeListener): a subscriber receives a notification
    // after connect and after sync, and the subscription promises nothing more. Unsubscribing is the same as the EVM
    // adapter's.
    subscribe(handler) {
      if (typeof handler !== "function") throw new SdkError("bad-input", { field: "handler" });
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    // SENDING A LEG TRANSACTION IS NOT THE MONERO WALLET'S BUSINESS. The XMR withdrawal can transfer XMR
    // (sweepUnlocked / relayTxs, see monero.mjs). Here is a refusal with a NAMED surface, not a silent null.
    async send() { throw new SdkError("not-implemented", { surface: "adapter.send", vm: XMR_VM }); },
    async receipt() { throw new SdkError("not-implemented", { surface: "adapter.receipt", vm: XMR_VM }); },

    // WHAT THE ADAPTER WORKS WITH: the library's wallet itself (it has getHeight, getDaemonHeight, sweepUnlocked and
    // the like). Before connecting - null: there is no wallet yet, and pretending there is one is not allowed.
    driver() { return wallet; },
  };
}
