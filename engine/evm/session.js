// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/session.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// The EVM wallet: state, balances, network switching and the injected connector.

// A browser wallet (MetaMask, Rabby, Coinbase...) found by EIP-6963 connects directly over EIP-1193. The SDK
// accepts the provider through `evmWallet(provider)`; WalletConnect and any other mobile connector are loaded by
// the host page, which passes the resulting EIP-1193 provider the same way. No vendor bundle is shipped here.

// What is real here and what is not matters:
//   REAL: connecting (browser extension), address, chainId, native-token and ERC-20 balances (values come
//         from the user's wallet through its provider, decimals from the config);
//
//   NOT REAL: transfers. The escrow contract is not deployed yet and the escrow address in the demo is a mock,
//         so sending a transaction stays a simulation (see evm/index.js). The demo does not move real money
//         and must not.

// The modal is drawn by us (ui/walletModal.js): the browser-wallet list comes from EIP-6963, and the CSP bans
// inline styles, so everything goes through dom.h(). The host owns any QR or WalletConnect UI.

// Balances are cached in the state: the UI asks balanceOf() synchronously, and refreshBalances() updates
// them (on connect, network change, wallet event).
import { chainById, chainByChainId, tokensOf } from "../core/config.js";
import {
  discoverWallets,
  explainInjectedError,
  handshake as injectedHandshake,
  isUserRejection,
  silentAccounts,
} from "./injected.js";
import { openWalletModal } from "../ui/walletModal.js";
import { toHuman } from "./amounts.js";
// THE CLAIM FEE RULE - FROM THE SHARED MODULE: the same formula the node uses for its gift.
import { claimMaxFeePerGasWei } from "./claimGas.js";

const listeners = new Set();

const state = {
  status: "idle", // idle | pairing | connected | error
  kind: null, // injected - the only connector this engine owns
  label: null, // wallet name for the UI: "MetaMask", "Rabby"...
  address: null,
  chainId: null, // numeric chainId of the network the wallet is on
  balances: {}, // "42161:USDC" -> a human-readable number
  error: null,
  lastRefresh: 0,
};

let provider = null;
let modal = null;

function emit() {
  for (const fn of listeners) {
    try {
      fn(publicState());
    } catch (e) {
      console.warn("wallet listener failed", e);
    }
  }
}

function publicState() {
  return { ...state, balances: { ...state.balances } };
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function status() {
  return publicState();
}

export function isConnected() {
  return state.status === "connected" && !!state.address;
}

export function address() {
  return state.address;
}

export function chainIdOf() {
  return state.chainId;
}

// THE WALLET PROVIDER GOES OUTWARD - TO THE CORE, NOT TO SCREENS. The core (sdk/) gets the wallet as an
// adapter and opens no windows: it needs the same EIP-1193 provider the page signs with. A second provider is
// not allowed - the signature would leave with the wrong key. For screens this name means nothing: they read
// wallet state through status()/isConnected(), as before.
export function currentProvider() {
  return provider;
}

export function balanceOf(chainSlugOrId, symbol) {
  const chain = chainById(chainSlugOrId);
  const v = state.balances[`${chain.chainId}:${String(symbol).toUpperCase()}`];
  return v === undefined ? 0 : v;
}

const hexChainId = (id) => "0x" + Number(id).toString(16);

function reset(status = "idle", error = null) {
  state.status = status;
  state.error = error;
  state.kind = null;
  state.label = null;
  state.address = null;
  state.chainId = null;
  state.balances = {};
  provider = null;
  emit();
}

// --- the injected connector -----------------------------------------------------------------
//
// The browser wallet exposes EIP-1193. The host may supply WalletConnect or another connector as the same
// interface; that connector is not created or loaded here.

function wireProvider(p) {
  p.on("chainChanged", (id) => {
    state.chainId = Number(id);
    state.error = null;
    emit();
    refreshBalances();
  });
  p.on("accountsChanged", (accounts) => {
    const next = (accounts && accounts[0]) || null;
    // An empty list - the user disconnected the site in the wallet. That is not "connected without an address"
    // but a real disconnect: otherwise the screen would show an empty wallet as working.
    if (!next) {
      if (modal) modal.close();
      reset("idle", null);
      return;
    }
    state.address = next;
    emit();
    refreshBalances();
  });
  // disconnect comes from a browser wallet, for example after it resets the site.
  p.on("disconnect", () => {
    if (modal) modal.close();
    reset("idle", null);
  });
}

// THE "OPTED OUT MANUALLY" MARK. A browser wallet may remember the site even after
// wallet_revokePermissions is unavailable, so a deliberate disconnect must survive the next load.
const OPTOUT_KEY = "ninsei.wallet.optOut";
const isOptedOut = () => { try { return localStorage.getItem(OPTOUT_KEY) === "1"; } catch { return false; } };
const setOptOut = (on) => { try { on ? localStorage.setItem(OPTOUT_KEY, "1") : localStorage.removeItem(OPTOUT_KEY); } catch {} };

let restoreTried = false;

// Restore the injected wallet without a prompt. The host may pass its own wallet list; otherwise EIP-6963 is used.
export async function restore() {
  if (isOptedOut()) { restoreTried = true; console.log("[wallet] restore skipped: wallet disconnected manually"); return publicState(); }
  if (restoreTried || state.status === "connected") return publicState();
  restoreTried = true;
  return restoreInjected();
}

// A silent check for browser wallets: one already allowed for the site returns an address without a window.
export async function restoreInjected({ wallets } = {}) {
  if (isConnected()) return publicState();
  const list = wallets || (await discoverWallets());
  for (const w of list) {
    const accounts = await silentAccounts(w.provider);
    if (!accounts.length) continue;
    provider = w.provider;
    state.kind = "injected";
    state.label = w.name || "Browser wallet";
    wireProvider(provider);
    state.address = accounts[0];
    try {
      state.chainId = Number(await provider.request({ method: "eth_chainId" })) || null;
    } catch {
      state.chainId = null;
    }
    state.status = "connected";
    state.error = null;
    emit();
    await refreshBalances();
    console.info("Browser wallet restored without a prompt: " + state.address);
    return publicState();
  }
  return publicState();
}

// Connecting a browser wallet: here the wallet shows a permission window.
export async function connectInjected({ wallet, chainSlug } = {}) {
  setOptOut(false);  // a deliberate connect clears the mark
  if (!wallet || !wallet.provider) {
    throw new Error("No wallet extension found in this browser");
  }
  if (isConnected() && state.kind === "injected" && state.label === (wallet.name || null)) {
    return { address: state.address, chainId: state.chainId };
  }
  const want = chainById(chainSlug || state.chainId || undefined);
  provider = wallet.provider;
  state.kind = "injected";
  state.label = wallet.name || "Browser wallet";
  state.status = "pairing";
  state.error = null;
  emit();
  wireProvider(provider);
  try {
    const res = await injectedHandshake(provider);
    if (!res.address) throw new Error("The wallet returned no address");
    state.address = res.address;
    state.chainId = res.chainId || want.chainId;
    state.status = "connected";
    state.error = null;
    emit();
    // The network is brought to the one selected in the form: the user may have connected on another network.
    if (state.chainId !== want.chainId) await switchChain(want);
    await refreshBalances();
    return { address: state.address, chainId: state.chainId };
  } catch (e) {
    const label = state.label || wallet.name || "Wallet";
    const message = explainInjectedError(e, label);
    if (isUserRejection(e)) {
      console.info("[wallet] user refusal: " + message);
      reset("idle", null);
      return null;
    }
    console.warn("[wallet] connect did not happen: " + message, e);
    reset("error", message);
    throw new Error(message);
  }
}

// Connect. chainSlug - the network selected in the form; it also becomes the primary in the session.
//
// Only browser wallets found through EIP-6963 are offered. WalletConnect and any other connector are loaded by
// the host page, which passes the resulting EIP-1193 provider to `evmWallet`.
export async function connect({ chainSlug } = {}) {
  if (isConnected()) return { address: state.address, chainId: state.chainId };
  const want = chainById(chainSlug || state.chainId || undefined);

  state.status = "pairing";
  state.error = null;
  emit();

  const wallets = await discoverWallets();
  // A discovery log: the first thing needed for "the wallet does not open" is who we actually found.
  // For old extensions (no EIP-6963) the source is legacy: the name is taken from flags, and the provider may
  // belong to another extension - then the window opens a different wallet than the one clicked.
  if (wallets.length) {
    console.info(
      "[wallet] found in the browser: " +
        wallets.map((w) => w.name + " [" + w.source + (w.rdns ? " " + w.rdns : "") + "]").join(", ")
    );
  } else {
    console.info("[wallet] no browser wallets found");
  }
  modal = openWalletModal({
    title: "Connect a wallet",
    subtitle: `Requested network: ${want.name}.`,
    hint: "Browser wallets are detected in this browser through EIP-6963.",
  });

  const choice = await new Promise((resolve) => {
    // Cancel (the cross, a click on the backdrop, Cancel) is the user's decision, not an app error.
    modal.setOnCancel(() => resolve({ type: "cancel" }));
    const options = wallets.map((w) => ({
      key: w.rdns || w.name,
      name: w.name,
      icon: w.icon,
      // An honest mark: a wallet found through window.ethereum is named by its flags, but we cannot
      // confirm it is exactly that one - hence the matching label.
      hint: w.source === "eip6963" ? null : "detected via window.ethereum",
      onClick: () => resolve({ type: "injected", wallet: w }),
    }));
    modal.setChoices(options);
    modal.update({
      status: wallets.length
        ? "Choose a browser wallet above."
        : "No browser wallet found in this browser. Install a browser wallet or use the host's own connector.",
    });
  });

  if (choice.type === "cancel") {
    reset("idle", null);
    return null;
  }

  // --- browser wallet: the wallet itself shows the permission window ---
  try {
    const res = await connectInjected({ wallet: choice.wallet, chainSlug: want.id });
    if (modal) modal.close();
    return res;
  } catch (e) {
    // The modal is NOT closed: the refusal cause must stay on screen. Otherwise it is
    // "pressed - nothing happened", and there is nowhere to learn what happened (a check catches this).
    const message = String((e && e.message) || e);
    if (modal) {
      modal.update({
        error: message,
        status: "Try again.",
      });
    }
    throw e;
  }
}

// SIGNING A MESSAGE with the wallet (EIP-191). This is NOT a transaction: it moves nothing, costs no gas and
// cannot be presented to a contract - it proves exactly one thing: ownership of the address. Entry into your
// own deal list rests on this, because connecting a wallet proves nothing by itself: the server cannot tell
// from it who is on the other end.
//
// personal_sign is supported by the built SDK - verified by searching the bundle, not from memory.
export async function signMessage(message) {
  if (!provider || state.status !== "connected") {
    throw new Error("wallet not connected: signing is impossible");
  }
  // THE MESSAGE IS PASSED IN HEX, NOT AS TEXT. EIP-191 requires it: the first personal_sign argument is the
  // message bytes in hex. MetaMask accepts text too (which is why this never surfaced on a live wallet for
  // years), while a node refuses: "invalid value: string ..., expected a valid hex string". Verified by a call:
  // text - refusal -32602, hex - a signature. The argument order [data, address] is as in MetaMask and WalletConnect.
  // If the wallet answers with an error, we show it AS IS: the cause is visible from the text.
  const hex = "0x" + Array.from(new TextEncoder().encode(String(message)), (b) => b.toString(16).padStart(2, "0")).join("");
  return await provider.request({ method: "personal_sign", params: [hex, state.address] });
}

// SIGNING TYPED DATA with the wallet (EIP-712, eth_signTypedData_v4). This is also NOT a transaction: the
// signature moves no money and costs no gas, so a wallet without its own ETH can give it.
//
// WHAT EXACTLY IS SIGNED IS DECIDED BY THE CALLER: ready typed data arrives here as an object, not a string.
// Assembling the shape here would be a second record of the protocol next to the real one.
export async function signTypedData(typedData) {
  if (!provider || state.status !== "connected") {
    throw new Error("wallet not connected: typed-data signing is impossible");
  }
  if (!typedData || typeof typedData !== "object") throw new Error("signTypedData: no typed data passed");
  // The argument order [address, JSON] is as EIP-712 requires and as MetaMask and WalletConnect accept.
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [state.address, JSON.stringify(typedData)],
  });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("the wallet returned a non-65-byte typed-data signature: " + String(signature).slice(0, 20));
  }
  return signature;
}

export async function disconnect() {
  setOptOut(true);   // remember the decision: after a reload the wallet is not picked up
  const p = provider;
  if (!p) {
    reset("idle", null);
    return;
  }
  try {
    // A browser wallet has no "session" on our side: we can only ask it to revoke the permission
    // (wallet_revokePermissions) and forget the address locally. Honestly: the next eth_accounts may
    // return the address again if the wallet remembers the site.
    if (typeof p.revokePermissions === "function") {
      await p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    }
  } catch (e) {
    console.warn("disconnect failed", e);
  }
  reset("idle", null);
}

// Switching the network in the wallet. If the user lacks it - we offer to add it with our rpcUrl
// (this is a wallet parameter; the page does not go to that address - CSP is not involved).
export async function switchChain(chainSlugOrId) {
  const chain = typeof chainSlugOrId === "object" ? chainSlugOrId : chainById(chainSlugOrId);
  if (!provider || !isConnected()) return false;
  const hex = hexChainId(chain.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
    const unknownChain = code === 4902 || /unrecognized chain|not added/i.test(String(e && e.message));
    if (!unknownChain) {
      if (/rejected|denied/i.test(String(e && e.message))) return false;
      state.error = String((e && e.message) || e);
      emit();
      return false;
    }
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
    } catch (e2) {
      if (!/rejected|denied/i.test(String(e2 && e2.message))) {
        state.error = String((e2 && e2.message) || e2);
        emit();
      }
      return false;
    }
  }
  state.chainId = chain.chainId;
  emit();
  await refreshBalances();
  return true;
}

// Reading balances through the wallet provider: native via eth_getBalance, ERC-20 via balanceOf
// through eth_call (selector 0x70a08231); decimals come from the config (where the BSC trap was).
// Send a transaction from the USER's wallet and return its hash.
//
// An EIP-1193 method, one for every injected browser wallet: each exposes
// a provider with request(). The signature happens in the wallet, our code never touches keys.
//
// The call does not return at once: the user confirms the transaction in their wallet, and until
// then the promise hangs. The caller must show this in the interface, else the step looks stuck.
//
// value is passed as a hex string (wei). For calling a payable escrow function (lock) the amount goes into
// value and the function takes no arguments; for the factory's createOrder value is not needed at all.
// Read a contract: calling a view function without a transaction and without gas.
//
// Needed to learn the escrow address BEFORE it is created (factory.predict) and to read state
// (escrow.status) while polling. Requires no keys, asks the wallet nothing - only the provider.
export async function readContract({ to, data, block = "latest" } = {}) {
  if (!provider) throw new Error("wallet not connected: nothing to read the contract with");
  if (!to) throw new Error("no contract address given");
  if (!data) throw new Error("no call data given");
  const result = await provider.request({ method: "eth_call", params: [{ to, data }, block || "latest"] });
  if (typeof result !== "string" || !result.startsWith("0x")) {
    throw new Error("unexpected answer to a contract call: " + String(result).slice(0, 60));
  }
  return result;
}

// THE TRANSACTION RECEIPT. Needed where a hash is not enough: in the order-creation events it carries the
// ACTUAL escrow address. A predicted address is a hope (it depends on the salt and the factory code), an event is a fact.
// Read by the same provider as the contract calls: we keep no second way to reach the chain.
// CONTRACT CODE (eth_getCode). Needed by the factory-code check: extcodehash is keccak256 of this code,
// and the interface compares the factory against the list of known builds by it. eth_call will not do: code
// is read by a DIFFERENT method, hence a separate function.
export async function readCode({ address } = {}) {
  if (!provider) throw new Error("wallet not connected: nothing to read the contract code with");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error("not an address for reading code: " + String(address));
  return await provider.request({ method: "eth_getCode", params: [address, "latest"] });
}

export async function readReceipt({ hash } = {}) {
  if (!provider) throw new Error("wallet not connected: nothing to read the receipt with");
  if (!hash) throw new Error("no transaction hash given");
  const r = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
  if (!r || typeof r !== "object") return null;      // not in a block yet - NOT an error but a wait
  return r;
}

export async function sendTransaction({ to, data, value = "0x0", gas } = {}) {
  if (!provider) throw new Error("wallet not connected: nothing to send with");
  if (!to) throw new Error("no contract address given");
  if (!data) throw new Error("no call data given");
  const from = address();
  if (!from) throw new Error("wallet not connected: no sender address");
  const tx = { from, to, data, value: typeof value === "bigint" ? "0x" + value.toString(16) : value };
  if (gas) tx.gas = typeof gas === "bigint" ? "0x" + gas.toString(16) : gas;
  // WE COMPUTE THE FEE OURSELVES WITH ONE RULE. The formula (2 x baseFee + tip) is in
  // www/js/evm/claimGas.js - the same module by which the node computes the GIFT at claim. A second
  // computation here would diverge from the gift. The tip floor is a network policy (Arbitrum: 0), not 1 gwei.
  try {
    const latest = await provider.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    const baseFee = latest && latest.baseFeePerGas ? BigInt(latest.baseFeePerGas) : 0n;
    let priorityFeeWei = 0n;
    try {
      // The tip is taken from eth_gasPrice: every provider has this method. eth_maxPriorityFeePerGas
      // is not supported by all, and MetaMask answers it with error -32601, which lands in the user's console.
      const gp = await provider.request({ method: "eth_gasPrice", params: [] });
      if (typeof gp === "string" && /^0x[0-9a-fA-F]+$/.test(gp)) {
        const diff = BigInt(gp) - baseFee;
        if (diff > 0n) priorityFeeWei = diff;      // gasPrice - baseFee is exactly the tip
      }
    } catch { /* no hint given - the tip stays zero */ }
    const maxFee = claimMaxFeePerGasWei({ baseFeeWei: baseFee, priorityFeeWei });
    // maxFee === null means a network without EIP-1559 (baseFee = 0): fields are not set, the wallet decides.
    if (maxFee !== null) {
      tx.maxPriorityFeePerGas = "0x" + (maxFee - baseFee * 2n).toString(16);
      tx.maxFeePerGas = "0x" + maxFee.toString(16);
    }
  } catch (feeErr) {
    // Could not compute - leave the decision to the wallet, as before. Failing silently over this is not allowed.
    console.warn("could not compute the fee, the wallet decides: " + ((feeErr && feeErr.message) || feeErr));
  }
  const hash = await provider.request({ method: "eth_sendTransaction", params: [tx] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("the wallet returned not a transaction hash: " + String(hash).slice(0, 60));
  }
  return hash;
}

export async function refreshBalances() {
  if (!isConnected() || !provider) return;
  const chain = chainByChainId(state.chainId);
  if (!chain) {
    state.error = `Wallet is on chain ${state.chainId}, which this demo does not support`;
    emit();
    return;
  }
  const addr = state.address;
  const next = {};
  const reads = [
    [chain.native.symbol, null, chain.native.decimals, "eth_getBalance"],
  ];
  for (const t of chain.tokens) reads.push([t.symbol, t.address, t.decimals, null]);

  const results = await Promise.all(
    reads.map(async ([symbol, tokenAddress, decimals, method]) => {
      try {
        let raw;
        if (method === "eth_getBalance") {
          raw = await provider.request({ method, params: [addr, "latest"] });
        } else {
          const data = "0x70a08231" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
          raw = await provider.request({ method: "eth_call", params: [{ to: tokenAddress, data }, "latest"] });
        }
        return [symbol, toHuman(BigInt(raw), decimals)];
      } catch (e) {
        console.warn(`balance read failed for ${symbol}`, e);
        return [symbol, undefined];
      }
    }),
  );

  for (const [symbol, value] of results) {
    if (value !== undefined) next[`${chain.chainId}:${String(symbol).toUpperCase()}`] = value;
  }
  state.balances = { ...state.balances, ...next };
  state.lastRefresh = Date.now();
  state.error = null;
  emit();
}

export function tokensWithBalance(chainSlug) {
  const chain = chainById(chainSlug);
  return tokensOf(chain.id).map((t) => ({ ...t, balance: balanceOf(chain.id, t.symbol) }));
}
