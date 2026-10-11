// THE EVM WALLET: a wrapper over an EIP-1193 provider.
//
// The SDK core knows only the adapter interface (vm, connect, address, chainId, subscribe, driver). The provider is
// brought by the interface - injected, WalletConnect, anything: the SDK does not look for wallets itself and does
// not open windows.
//
// The EVM leg driver gets the provider through `driver()` and makes eth_* calls through it. For another VM its own
// adapter will appear (`tronWallet`, `solanaWallet`), and the core will not need to change for it.
const hexToInt = (value) => (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? Number.parseInt(value, 16) : null);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

import { SdkError } from "../errors.mjs";
// THE NETWORK REGISTRY - THROUGH THE ENGINE'S SEAM. Adding a network to the wallet (wallet_addEthereumChain)
// requires the network's name, native coin, rpc and explorer, and all of that is already in the registry the page
// uses (www/js/evm/session.js, switchChain). The adapter keeps no network table of its own and invents no
// addresses.
import { config as engineConfig } from "../engine.mjs";

const hexChainId = (id) => "0x" + Number(id).toString(16);
// 4902 - the wallet does not know such a network; older wallets answer with text, so we check that too.
const CHAIN_UNKNOWN = 4902;
const isUnknownChain = (error) => {
  const code = error && (error.code || (error.data && error.data.originalError && error.data.originalError.code));
  return code === CHAIN_UNKNOWN || /unrecognized chain|not added/i.test(String((error && error.message) || ""));
};
const isRejected = (error) => (error && error.code === 4001) || /rejected|denied/i.test(String((error && error.message) || ""));

export function evmWallet(provider, { id = "evm" } = {}) {
  const handoff = [];
  return {
    vm: "evm",
    id,
    async connect({ chainId = null } = {}) {
      try {
        await provider.request({ method: "eth_requestAccounts" });
      } catch (error) {
        const rejected = error && (error.code === 4001 || error.code === "ACTION_REJECTED");
        const failure = new Error(rejected ? "wallet-rejected" : "wallet-not-connected");
        failure.code = rejected ? "wallet-rejected" : "wallet-not-connected";
        throw failure;
      }
      if (Number.isFinite(chainId)) {
        const current = hexToInt(await provider.request({ method: "eth_chainId" }).catch(() => null));
        if (current !== Number(chainId)) await this.switchChain(chainId);
      }
    },
    async disconnect() {
      while (handoff.length) {
        const [event, handler] = handoff.pop();
        if (typeof provider.removeListener === "function") provider.removeListener(event, handler);
      }
    },
    async address() {
      const accounts = await provider.request({ method: "eth_accounts" }).catch(() => null);
      const first = Array.isArray(accounts) ? accounts[0] : null;
      return typeof first === "string" && ADDRESS_RE.test(first) ? first : null;
    },
    async chainId() {
      return hexToInt(await provider.request({ method: "eth_chainId" }).catch(() => null));
    },
    subscribe(handler) {
      if (typeof provider.on !== "function") return () => {};
      for (const event of ["accountsChanged", "chainChanged"]) {
        const wrapped = () => handler();
        provider.on(event, wrapped);
        handoff.push([event, wrapped]);
      }
      return () => {};
    },
    // THE SAME PATH AS THE PAGE (www/js/evm/session.js, switchChain): first wallet_switchEthereumChain, and if the
    // wallet does not know such a network - offer to add it via wallet_addEthereumChain. The data for adding is
    // taken from the engine's registry, not from a private table.
    async switchChain(chainId) {
      const target = Number(chainId);
      const hex = hexChainId(target);
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      } catch (error) {
        if (!isUnknownChain(error)) throw new SdkError(isRejected(error) ? "wallet-rejected" : "wrong-chain", { vm: "evm" });
        const chain = typeof engineConfig.chainByChainId === "function" ? engineConfig.chainByChainId(target) : null;
        // The network is not in the registry - there is nothing to add it with, and the rpc/explorer must not be
        // invented: we name the refusal with a code.
        if (!chain) throw new SdkError("wrong-chain", { vm: "evm", chainId: target });
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hex,
              chainName: chain.name,
              nativeCurrency: { name: chain.native.symbol, symbol: chain.native.symbol, decimals: chain.native.decimals },
              rpcUrls: [chain.rpcUrl],
              blockExplorerUrls: [chain.explorerAddr],
            }],
          });
        } catch (error2) {
          throw new SdkError(isRejected(error2) ? "wallet-rejected" : "wrong-chain", { vm: "evm" });
        }
      }
    },
    // SENDING A TRANSACTION AND THE RECEIPT. Without them the funds cannot be locked: signing is possible only in
    // the wallet, and confirmation of execution arrives as a receipt.
    //
    // THERE IS DELIBERATELY NO POLLING HERE: `receipt` asks once and returns the receipt, or null if the transaction
    // is not in a block yet. The waiting policy (how long, how often, what on refusal) is set by the caller: a
    // policy of its own inside the adapter would mean two calls wait differently.
    async send({ to, data = "0x", value = 0n, gas = null }) {
      if (typeof to !== "string" || !to) throw new SdkError("bad-input", { field: "send.to" });
      const accounts = await provider.request({ method: "eth_accounts" });
      const from = Array.isArray(accounts) ? accounts[0] : null;
      if (!from) throw new SdkError("wallet-not-connected", { step: "send" });
      const hex = (v) => "0x" + BigInt(v).toString(16);
      // GAS IS PASSED IF THE CALLER SET IT: every contract call has its own estimate (marking ready, claiming,
      // refunding), and it comes from the same place as the calldata - the engine's EVM layer.
      const tx = { from, to, data, value: hex(value) };
      if (gas !== null && gas !== undefined) tx.gas = hex(gas);
      return await provider.request({ method: "eth_sendTransaction", params: [tx] });
    },
    async receipt(txHash) {
      if (typeof txHash !== "string" || !txHash) throw new SdkError("bad-input", { field: "receipt.txHash" });
      return await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    },
    // SIGNING TYPED DATA (EIP-712) - the same call the page makes (www/js/evm/session.js, signTypedData). This is not
    // a transaction: no gas, no money moves, so a person without their own ETH can give it. What is signed is DECIDED
    // BY THE CALLER (ready typed data arrives here - e.g. a CoWSwap order from src/legs/cow.mjs); the shape is not
    // assembled here, else there would be a second record of the protocol.
    async signTypedData(typedData) {
      if (!typedData || typeof typedData !== "object") throw new SdkError("bad-input", { field: "signTypedData" });
      const accounts = await provider.request({ method: "eth_accounts" });
      const from = Array.isArray(accounts) ? accounts[0] : null;
      if (!from) throw new SdkError("wallet-not-connected", { step: "signTypedData" });
      // The argument order [address, JSON] is as EIP-712 requires and as MetaMask and WalletConnect accept.
      const signature = await provider.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] });
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new SdkError("wallet-rejected", { step: "signTypedData", why: "bad-signature-shape" });
      }
      return signature;
    },
    driver() {
      return provider;
    },
  };
}
