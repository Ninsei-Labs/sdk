// GENERATED FILE - a byte-for-byte copy of the engine module www/js/monero/wallet.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// The one-shot Monero wallet of a swap.
//
// Keys are computed by monero-js (ebellocchia/monero-js, MIT, vendored under www/assets/vendors/monero-js):
// a mnemonic and keys in pure JS, real and instant. The library only knows mainnet address prefixes, so the
// address string is built by our encoder (monero/address.js) for the network from the config - which is how
// stagenet (24/36) also works.
//
// Keys NEVER leave the browser: only the view key goes out (to the backend, for a watch-only wallet), and a
// separate explicit function does it - recovery/restore.js::watchOnlyShareFromWallet. The wallet is one-shot,
// for one deal, and the user's main-wallet seed is never imported.

import { MONERO } from "../core/config.js";
import { randomHex, toHex } from "../core/format.js";
import { addressFromKeys } from "./address.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num /= 58n;
  }
  return out;
}

// A pseudo-address for mock mode: the right length (95) and network prefix, but WITHOUT a checksum.
// The UI always marks it as mock, so nobody sends XMR there.

// ---------------------------------------------------------------------------
// monero-js (mnemonic + keys + addresses, pure JS)
// ---------------------------------------------------------------------------

let moneroJsModule = null;
let moneroJsError = null;

export async function loadMoneroJs() {
  if (moneroJsModule) return moneroJsModule;
  if (moneroJsError) throw new Error(moneroJsError);
  try {
    const mod = await import("../../assets/vendors/monero/monero-js-browser.js?v=05c682ea");
    moneroJsModule = mod.default || mod;
    return moneroJsModule;
  } catch (e) {
    // The reason is not replaced: "bundle not built", "not uploaded" and "blocked by CSP" are different problems
    moneroJsError = "monero-js unavailable: " + e.message +
      " (run npm run build:vendor; for CSP see the deploy notes)";
    throw new Error(moneroJsError);
  }
}

async function withMoneroJs({ mnemonic: phrase, network = MONERO.networkType } = {}) {
  const lib = await loadMoneroJs();
  await lib.wallet.initEcc();

  // A supplied phrase must be valid. An invalid phrase used to be silently replaced by a fresh one, so
  // recovering from a corrupt file gave a DIFFERENT wallet: the error looked like success and the funds stayed
  // out of reach. Generation happens only when there is no phrase at all.
  let words;
  if (phrase) {
    if (!lib.mnemonic.isValid(phrase)) {
      throw new Error("the mnemonic failed its checksum check (file or form corrupted?)");
    }
    words = String(phrase).trim();
  } else {
    words = lib.mnemonic.generateWithChecksum();
  }
  const seed = lib.mnemonic.toSeed(words); // 32 bytes: for Monero the seed == the decoded mnemonic
  const w = lib.wallet.fromSeed(seed);

  const net = network || "mainnet";
  const deps = { keccak256: lib.keccak256, Buffer: lib.Buffer };
  const spendPub = toHex(w.publicSpendKey);
  const viewPub = toHex(w.publicViewKey);
  const sub = w.subaddress(1, 0);
  // the address of our own network is built here (the library only knows mainnet);
  // addressMainnet is kept for cross-checking: on mainnet the two must match
  const address = addressFromKeys({ network: net, kind: "primary", spendPub, viewPub }, deps);
  const subaddress = addressFromKeys(
    { network: net, kind: "subaddress", spendPub: toHex(sub.publicSpendKey), viewPub: toHex(sub.publicViewKey) },
    deps
  );

  return {
    source: "monero-js",
    library: "ebellocchia/monero-js (MIT)",
    network: net,
    mnemonic: words,
    mnemonicWords: words.split(" ").length,
    seedHex: toHex(seed),
    privateSpendKey: toHex(w.privateSpendKey),
    privateViewKey: toHex(w.privateViewKey),
    publicSpendKey: spendPub,
    publicViewKey: viewPub,
    address,
    subaddress,
    addressMainnet: w.primaryAddress().encode(),
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// monero-ts removed
// ---------------------------------------------------------------------------
// A second wallet mode lived here - a WebAssembly wallet2 (woodser/monero-ts) built into the vendors. It was
// removed for two reasons: the WASM wallet needs SharedArrayBuffer, i.e. COOP/COEP, which on the demo domain
// would block third-party resources; and the bundle moved to the sweep app, which has its own COOP/COEP domain.
// While the branch of code stayed, it pulled an import along a path that no longer existed - dead, yet looking
// alive. Keys in the demo are computed by monero-js, and that is the only path.

// ---------------------------------------------------------------------------

export async function createSwapWallet({ network = MONERO.networkType, seed } = {}) {
  return withMoneroJs({ mnemonic: seed, network });
}

// Whether the key library is available (the Demo controls panel shows this as one line).
export async function probeMode() {
  try {
    const lib = await loadMoneroJs();
    await lib.wallet.initEcc();
    return { available: true, info: "mnemonic + keys + addresses (" + MONERO.networkType + ")" };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

// The joint swap address. In the real protocol it is the SUM of both sides' public keys (S_a + S_b, V_a + V_b):
// the output can be spent only with both halves of the spend key, and the DLEQ proof binds the halves to the
// secret. In the demo the sum is a hash of the keys: same interface and flow, cryptography openly replaced.
export function combineAddress({ swapId, userPublicSpendKey, userPublicViewKey, makerKeySeed }) {
  const mk = (salt) => {
    const payload = `${salt}|${swapId}|${userPublicSpendKey}|${userPublicViewKey}`;
    let hh = 0x811c9dc5;
    for (let i = 0; i < payload.length; i++) {
      hh ^= payload.charCodeAt(i);
      hh = (hh * 0x01000193) >>> 0;
    }
    return hh.toString(16).padStart(8, "0") + randomHex(28);
  };
  return {
    mock: true,
    address: "8" + mk(makerKeySeed).slice(0, 94),
    spendShare: "0x" + mk("spend-share").slice(0, 64),
    viewShare: "0x" + mk("view-share").slice(0, 64),
    note: "mock: in the real protocol this is the sum of both sides' public keys with a DLEQ proof",
  };
}

export function networkLabel(network = MONERO.networkType) {
  return { mainnet: "Monero mainnet", stagenet: "Monero stagenet", testnet: "Monero testnet" }[network] || network;
}
