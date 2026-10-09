// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/auth.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// WALLET-SIGNATURE LOGIN AND THE SERVER-SIDE SWAP LIST.
// Why: while swap records live only in localStorage, "my list" is tied to the browser. A server-side list
// fixes that; binding it to the wallet address keeps other people's swaps hidden.
//
// A SIGNATURE, NOT JUST A CONNECTION. Connecting is only a channel. Proving you own the address needs a
// message signature, re-done every time: the pass lives in sessionStorage and dies with the tab.
//
// WHAT GOES TO THE SERVER AND WHAT DOES NOT. Only public fields: escrow address, amounts, deadlines,
// hashlock, network, swap id. THE SECRET NEVER GOES: it grants the money and stays in the recovery file.
//
// A SERVER REFUSAL DOES NOT BREAK THE SWAP: sync is a convenience, and on failure the swap continues on
// the local record (said honestly in the console).
import { signMessage, address, isConnected } from "./session.js";

const TOKEN_KEY = "ninsei.auth.token";
const ADDR_KEY = "ninsei.auth.address";

// The pass and the address live in sessionStorage: it survives a reload but dies with the tab - exactly the
// chosen behaviour ("valid while the browser is open"). SESSION STORAGE COMES FROM OUTSIDE, like the state
// store (www/js/core/store.js): sessionStorage in the browser, memory in the checks and the SDK - the module
// must load without a DOM.
const sessionAdapters = () => {
  const store = typeof globalThis !== "undefined" ? globalThis.sessionStorage : undefined;
  if (!store || typeof store.getItem !== "function") return null;
  return {
    get: (key) => store.getItem(key),
    set: (key, value) => store.setItem(key, String(value)),
    remove: (key) => store.removeItem(key),
  };
};
const memoryStore = () => {
  const map = new Map();
  return { get: (key) => (map.has(key) ? map.get(key) : null), set: (key, value) => map.set(key, String(value)), remove: (key) => map.delete(key) };
};
let sessionStore = sessionAdapters() || memoryStore();

/** Swap the session storage: sessionStorage, memory or an SDK adapter all qualify. */
export function setSessionStore(next) {
  const ok = next && typeof next.get === "function" && typeof next.set === "function" && typeof next.remove === "function";
  if (!ok) throw new Error("session storage must support get/set/remove");
  sessionStore = next;
  return sessionStore;
}
export const sessionStoreInUse = () => sessionStore;

function readSession(key) { try { return sessionStore.get(key); } catch { return null; } }
function writeSession(key, value) { try { value == null ? sessionStore.remove(key) : sessionStore.set(key, value); } catch { /* silence on purpose: an unavailable store must not break login */ } }

export function token() { return readSession(TOKEN_KEY); }
export function authedAddress() { return readSession(ADDR_KEY); }
export function forgetSession() { writeSession(TOKEN_KEY, null); writeSession(ADDR_KEY, null); }

async function api(path, init = {}) {
  const res = await fetch(path, init);
  let body = null;
  try { body = await res.json(); } catch { /* not JSON - returned as is below */ }
  return { status: res.status, body };
}

// Login: get a one-time number, sign the message GIVEN BY THE SERVER (not our own: a one-char mismatch
// would give "signature does not match" with no explanation) and exchange the signature for a pass.
export async function signIn() {
  if (!isConnected()) throw new Error("connect the wallet first");
  const nonce = await api("/api/auth/nonce");
  if (nonce.status !== 200 || !nonce.body || !nonce.body.message) {
    throw new Error("the server did not issue a message to sign (response " + nonce.status + ")");
  }
  const signature = await signMessage(nonce.body.message);
  const verified = await api("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: nonce.body.nonce, address: address(), signature }),
  });
  if (verified.status !== 200 || !verified.body || !verified.body.token) {
    const why = verified.body && verified.body.error ? verified.body.error : "response " + verified.status;
    throw new Error("login not accepted: " + why);
  }
  writeSession(TOKEN_KEY, verified.body.token);
  writeSession(ADDR_KEY, verified.body.address);
  return verified.body.address;
}

// A request with the pass. On 401 the pass may have expired or the server restarted - try to log in once
// more, and only if that also fails return the refusal honestly: silent re-signing would spam the wallet.
async function authed(path, init = {}, retry = true) {
  const t = token();
  const headers = { ...(init.headers || {}) };
  if (t) headers.authorization = "Bearer " + t;
  const r = await api(path, { ...init, headers });
  if (r.status === 401 && retry && isConnected()) {
    forgetSession();
    try { await signIn(); } catch (e) { return r; }
    return authed(path, init, false);
  }
  return r;
}

// Send a swap record. Returns { ok, reason }: a refusal is a fact, not an exception, and the caller
// decides - the swap must not abort because of it.
export async function saveServerSwap(swap, network) {
  const escrow = swap && swap.escrow && swap.escrow.address;
  if (!escrow) return { ok: false, reason: "the record has no escrow address" };
  if (!isConnected()) return { ok: false, reason: "wallet not connected" };
  try {
    if (!token() || authedAddress() !== String(address()).toLowerCase()) { forgetSession(); await signIn(); }
    const r = await authed("/api/evm-swaps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: swap.id, network: network || swap.network || swap.chain, escrow,
      // QUOTE REFERENCE. Through it the server and the provider node know WHOSE order this is: without it
      // the escrow address stays unknown to the node and it cannot claim the ETH. A missing field is not
      // an error: old records and provider-less swaps are sent as is.
        quoteId: swap.orderQuoteId || null,
        providerId: swap.providerId || null,
        hashlock: (swap.escrow && swap.escrow.hashlock) || swap.hashlock || null,
        amount: (swap.escrow && swap.escrow.amountWei) || swap.amountWei || null,
        t0: swap.escrow && swap.escrow.t0 != null ? swap.escrow.t0 : null,
        t1: swap.escrow && swap.escrow.t1 != null ? swap.escrow.t1 : null,
      }),
    });
    if (r.status === 201 || r.status === 200) {
      // THE SERVER ALSO ANSWERS ABOUT THE QUOTE BINDING. Without it the provider node cannot claim the ETH.
      // A binding refusal does not abort the swap, but must not be silent either - it goes to the caller, which logs it.
      return { ok: true, orderBinding: (r.body && r.body.orderBinding) || null };
    }
    const why = r.body && r.body.error ? r.body.error : "response " + r.status;
    return { ok: false, reason: why };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// The swap list from the server. An empty result and a refusal are different, and the caller sees the difference.
export async function loadServerSwaps() {
  if (!isConnected()) return { ok: false, reason: "wallet not connected", swaps: [] };
  try {
    if (!token()) await signIn();
    const r = await authed("/api/evm-swaps");
    if (r.status !== 200 || !r.body) return { ok: false, reason: "response " + r.status, swaps: [] };
    return { ok: true, swaps: r.body.swaps || [] };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e), swaps: [] };
  }
}
