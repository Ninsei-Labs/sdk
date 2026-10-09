// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/injected.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// BROWSER WALLETS: detection by EIP-6963 and connection by EIP-1193.
// WHY EIP-6963, NOT window.ethereum.isMetaMask. With two extensions installed, window.ethereum is "whoever was
// last", and guessing by flags gives wrong names and icons. EIP-6963 solves this: a wallet announces itself with
// an `eip6963:announceProvider` event (name, icon, provider), and the page requests it with `eip6963:requestProvider`.
// So the wallet list is real and updates if the user installs an extension with the tab open.
// window.ethereum stays as a fallback for old wallets; there the honest name is "Browser wallet".
// NO STATE HERE: this module only finds providers and does the handshake. State and balances live in evm/session.js.
//
//
//

const ANNOUNCE = "eip6963:announceProvider";
const REQUEST = "eip6963:requestProvider";

// EIP-1193 codes that matter on screen: a user refusal is not an application error.
export const USER_REJECTED = 4001;

export function isUserRejection(error) {
  const code = error && (error.code || (error.data && error.data.originalError && error.data.originalError.code));
  if (code === USER_REJECTED) return true;
  return /rejected|denied|cancell?ed|closed by user/i.test(String((error && error.message) || error || ""));
}

// A human name for the fallback: flags are all the old wallets have.
function fallbackName(eth) {
  if (!eth) return null;
  if (eth.isMetaMask) return "MetaMask";
  if (eth.isRabby) return "Rabby";
  if (eth.isCoinbaseWallet) return "Coinbase Wallet";
  if (eth.isBraveWallet) return "Brave Wallet";
  if (eth.isFrame) return "Frame";
  return "Browser wallet";
}

// Build the wallet list: first those announced by EIP-6963, then the window.ethereum fallback. timeoutMs is
// needed because announceProvider is an event: without a pause the list would be empty even with a wallet installed.
export function discoverWallets({ win = globalThis, timeoutMs = 250 } = {}) {
  const found = [];
  const seen = new Set();
  const add = (entry) => {
    const key = entry.rdns || entry.uuid || entry.name;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(entry);
  };

  const onAnnounce = (event) => {
    const detail = event && event.detail;
    if (!detail || !detail.provider || !detail.info) return;
    add({
      uuid: detail.info.uuid || null,
      name: detail.info.name || "Browser wallet",
      icon: detail.info.icon || null,
      rdns: detail.info.rdns || null,
      provider: detail.provider,
      source: "eip6963",
    });
  };

  if (win && typeof win.addEventListener === "function") {
    win.addEventListener(ANNOUNCE, onAnnounce);
    if (typeof win.dispatchEvent === "function") {
      // We ask them to announce; answers arrive asynchronously, so we wait a short pause.
      win.dispatchEvent(new Event(REQUEST));
    }
  }

  return new Promise((resolve) => {
    const finish = () => {
      if (win && typeof win.removeEventListener === "function") win.removeEventListener(ANNOUNCE, onAnnounce);
      // Fallback: an old wallet that does not know 6963 but sets window.ethereum. providers (array) appears with
      // several wallets without 6963 support.
      const legacy = win && win.ethereum;
      if (!found.length && legacy) {
        const list = Array.isArray(legacy.providers) && legacy.providers.length ? legacy.providers : [legacy];
        for (const p of list) {
          add({ name: fallbackName(p), icon: null, rdns: null, provider: p, source: "legacy" });
        }
      }
      resolve(found);
    };
    if (timeoutMs > 0 && typeof setTimeout === "function") setTimeout(finish, timeoutMs);
    else finish();
  });
}

// Subscribe to "a wallet appeared". Needed so the modal list is not a snapshot at open time: the user may install
// an extension without reloading.
//
// We work with the announcement itself, not a re-detection: the EIP-6963 event carries the name and provider, and
// events are not replayed, so a wallet that announced before our subscription would be lost on a re-request. The list only grows.
export function watchWallets(fn, { win = globalThis } = {}) {
  if (!win || typeof win.addEventListener !== "function") return () => {};
  const known = new Map();
  const publish = () => fn([...known.values()]);
  const onAnnounce = (event) => {
    const detail = event && event.detail;
    if (!detail || !detail.provider || !detail.info) return;
    const key = detail.info.rdns || detail.info.uuid || detail.info.name;
    if (!key || known.has(key)) return;
    known.set(key, {
      uuid: detail.info.uuid || null,
      name: detail.info.name || "Browser wallet",
      icon: detail.info.icon || null,
      rdns: detail.info.rdns || null,
      provider: detail.provider,
      source: "eip6963",
    });
    publish();
  };
  win.addEventListener(ANNOUNCE, onAnnounce);
  // We ask them to announce: installed wallets answer right now and enter the list. An empty list is not handed
  // out, else the UI would be cleared just because there are no wallets.
  if (typeof win.dispatchEvent === "function") win.dispatchEvent(new Event(REQUEST));
  return () => win.removeEventListener(ANNOUNCE, onAnnounce);
}

// EIP-1193 handshake: ask for accounts (here the wallet asks permission) and learn the network.
export async function handshake(provider) {
  if (!provider || typeof provider.request !== "function") {
    throw new Error("This wallet does not support EIP-1193 (no request)");
  }
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) ? accounts[0] : null;
  const chainIdHex = await provider.request({ method: "eth_chainId" });
  return { address: address || null, chainId: Number(chainIdHex) || null };
}

// A silent check "the site is already allowed for this wallet" - for restoring after a reload. eth_accounts does
// NOT show the wallet window: an empty answer means "no permission", a normal state, not an error. That is why
// eth_requestAccounts must not be called here: the page must not pop a connect window on load.
export async function silentAccounts(provider) {
  if (!provider || typeof provider.request !== "function") return [];
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    return [];
  }
}

// Why the wallet may not have opened - translate the error code into a plain reason.
//
// -32002 is the most common cause of "pressed but no window": the wallet already has an open request (the window
// hangs on another screen/tab, or the previous attempt did not finish).
export function explainInjectedError(e, label = "Wallet") {
  const code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
  const message = String((e && e.message) || e);
  if (code === -32002 || /already pending|already processing/i.test(message)) {
    return (
      label +
      ": the wallet already has a pending request, so a new window did not open. " +
      "Open the extension, finish or cancel that request, then try again."
    );
  }
  if (/no provider|not connected|provider is disconnected|undefined is not a function/i.test(message)) {
    return label + ": the extension is not responding (the browser may have unloaded it, or the page is not where it works).";
  }
  if (/user rejected|user denied|rejected by user/i.test(message) || code === 4001) {
    return label + ": the request was rejected in the wallet.";
  }
  return label + ": " + message;
}
