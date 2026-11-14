// The one-shot Monero wallet of a swap.
//
// Keys are derived by the package's own Monero module (engine/monero/keys.js) from @noble/curves; the 25-word
// mnemonic is encoded/decoded by engine/monero/mnemonic.js. The old vendored monero-js bundle is gone. The address
// string is built by our encoder (monero/address.js), which knows mainnet, stagenet and testnet prefixes.
//
// Keys NEVER leave the browser: only the view key goes out (to the backend, for a watch-only wallet), and a
// separate explicit function does it - recovery/restore.js::watchOnlyShareFromWallet. The wallet is one-shot,
// for one deal, and the user's main-wallet seed is never imported.

import { MONERO } from "../core/config.js";
import { randomHex, toHex } from "../core/format.js";
import { keccak256 } from "../../src/primitives.mjs";
import { addressFromKeys } from "./address.js";
import * as moneroMnemonic from "./mnemonic.js";
import * as moneroKeys from "./keys.js";

// A pseudo-address for mock mode: the right length (95) and network prefix, but WITHOUT a checksum.
// The UI always marks it as mock, so nobody sends XMR there.

// ---------------------------------------------------------------------------
// Monero mnemonic + keys + addresses (the package's own implementation)
// ---------------------------------------------------------------------------

// A supplied phrase must be valid. An invalid phrase used to be silently replaced by a fresh one, so recovering
// from a corrupt file gave a DIFFERENT wallet: the error looked like success and the funds stayed out of reach.
// Generation happens only when there is no phrase at all.
async function withMoneroKeys({ mnemonic: phrase, network = MONERO.networkType } = {}) {
  await moneroKeys.initEcc();
  let words;
  if (phrase) {
    if (!moneroMnemonic.isValid(phrase)) {
      throw new Error("the mnemonic failed its checksum check (file or form corrupted?)");
    }
    words = String(phrase).trim();
  } else {
    words = moneroMnemonic.generateWithChecksum();
  }
  const seed = moneroMnemonic.toSeed(words); // 32 bytes: for Monero the seed == the decoded mnemonic
  const w = moneroKeys.fromSeed(seed);

  const net = network || "mainnet";
  const deps = { keccak256 };
  const spendPub = toHex(w.publicSpendKey);
  const viewPub = toHex(w.publicViewKey);
  const sub = w.subaddress(1, 0);
  // The address of our own network is built here; mainnet is kept for cross-checking.
  const address = addressFromKeys({ network: net, kind: "primary", spendPub, viewPub }, deps);
  const subaddress = addressFromKeys(
    { network: net, kind: "subaddress", spendPub: toHex(sub.publicSpendKey), viewPub: toHex(sub.publicViewKey) },
    deps
  );
  const addressMainnet = addressFromKeys({ network: "mainnet", kind: "primary", spendPub, viewPub }, deps);

  return {
    source: "ninsei-monero-keys",
    library: "Ninsei Monero keys (@noble/curves + @noble/hashes)",
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
    addressMainnet,
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// The old monero-js / monero-ts browser paths are gone.
// ---------------------------------------------------------------------------
// Keys are derived by engine/monero/keys.js from @noble/curves. The monero-ts WASM wallet was removed earlier:
// it needs SharedArrayBuffer, i.e. COOP/COEP, which on the demo domain would block third-party resources; the
// sweep app has its own domain and wallet adapter.

export async function createSwapWallet({ network = MONERO.networkType, seed } = {}) {
  return withMoneroKeys({ mnemonic: seed, network });
}

// Whether the key module is available (the Demo controls panel shows this as one line).
export async function probeMode() {
  try {
    await moneroKeys.initEcc();
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
