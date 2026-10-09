// GENERATED FILE - a byte-for-byte copy of the engine module www/js/recovery/restore.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// The reverse recovery-file path: file -> wallet that can claim the XMR.
// The forward path (file generation) is in recoveryFile.js. Here is why the file exists: recovery when the tab is
// lost. Two rules are pinned by CODE, not by a comment:
//   1) the wallet is restored from the mnemonic, and the restored address MUST match the address in the file. No
//      match - the file is corrupted or substituted, and we must not continue;
//   2) only the view key, with the address and height, goes to the server (watch-only). The spend key, mnemonic
//      and seed stay in the browser, a product boundary checked by a separate test.

import { createSwapWallet } from "../monero/wallet.js";
import { decryptFile, validatePayload } from "./recoveryFile.js";
import { swapAddressFromHalves, watchViewSeedHex } from "../monero/swapKeys.js";

// The restored wallet plus everything needed for the scan: height and format warnings.
//
// TWO DIFFERENT SCHEMES, BOTH LIVE. A v2 file carries a MNEMONIC (a full wallet is built from it). A v3 file
// carries HALVES, and has NO full spend key: each side has only its half, the second is revealed on chain at ETH
// claim. So a v3 file builds a VIEWING wallet; spending becomes possible only after the reveal.
//
// deps is needed for testability: in the browser the libraries come from the vendored bundle (loaded dynamically,
// as a static bundle import would break Node runs), in tests they are passed in.
export async function restoreWalletFromPayload(payload, deps = {}) {
  const { warnings } = validatePayload(payload);
  const m = payload.moneroWallet;
  const network = m.network || payload.moneroNetwork;
  if (payload.version >= 3) return await restoreFromHalves(payload, warnings, deps);

  // The mnemonic is passed explicitly: monero-js checks its checksum and refuses a broken phrase
  // (in wallet.js this is now an error, not a silent new-wallet generation).
  const wallet = await createSwapWallet({ seed: m.mnemonic, network });

  if (wallet.address !== m.address) {
    throw new Error("the address from the file does not match the one derived from the mnemonic: the file is corrupted or altered");
  }
  // The public keys in the file are a second check on the same thing: the address is built from them, so a
  // mismatch means the file was edited by hand.
  for (const [field, value] of [
    ["publicSpendKey", wallet.publicSpendKey],
    ["publicViewKey", wallet.publicViewKey],
  ]) {
    if (m[field] && m[field] !== value) {
      throw new Error(`key ${field} from the file does not match the one derived from the mnemonic: the file was altered`);
    }
  }

  return {
    wallet,
    payload,
    // This is why the height is stored: without it the wallet scans Monero history from scratch (tens of hours).
    restoreHeight: Number.isFinite(m.restoreHeight) && m.restoreHeight > 0 ? m.restoreHeight : 0,
    warnings,
  };
}

// RESTORATION FROM HALVES (v3 file). What is here and what is not:
//   present: INTEGRITY CHECK. The address is built from our halves and THEIR points and must match the file
//   address - the same role as the address/mnemonic comparison in v2. No match - the file is corrupted or
//   substituted, and we must not continue;
//   present: the VIEW KEY - the sum of our view half and the counterparty half. It lets the wallet SEE arrivals;
//   NOT present: the spend key. It cannot be assembled: the second spend half is not in the file. It comes from
//   the chain when the counterparty claims the ETH - then spending becomes possible (sweepSpendSecret verifies
//   it against the order public key).
//
export async function restoreFromHalves(payload, warnings = [], deps = {}) {
  const m = payload.moneroWallet;
  const network = m.network || payload.moneroNetwork;
  const libs = deps.halves && deps.addressFromKeys
    ? { halves: deps.halves, addressFromKeys: deps.addressFromKeys, keccak256: deps.keccak256 }
    : await (async () => {
        const vendor = await import("../../assets/vendors/atomic/atomic-browser.js?v=77cc4725");
        const { createHalves } = await import("../atomic/halves.js");
        const { addressFromKeys } = await import("../monero/address.js");
        const halves = createHalves({
          ed25519: vendor.ed25519, secp256k1: vendor.secp256k1,
          keccak256: vendor.keccak256, randomBytes: vendor.randomBytes,
        });
        return { halves, addressFromKeys, keccak256: vendor.keccak256 };
      })();
  if (!libs.keccak256) throw new Error("no keccak256: the address cannot be checked without it");

  const built = swapAddressFromHalves({
    halves: libs.halves, addressFromKeys: libs.addressFromKeys, deps: { keccak256: libs.keccak256 },
    ownSpendHalf: m.spendHalf, ownViewHalf: m.viewHalf,
    otherSpendPoint: m.otherSpendPoint, otherViewPoint: m.otherViewPoint, network,
  });
  if (built.address !== m.address) {
    throw new Error("the address from the file does not match the one built from the halves and counterparty points: the file is corrupted or altered");
  }
  const viewSeedHex = watchViewSeedHex({
    halves: libs.halves, ownViewHalf: m.viewHalf, otherViewHalf: m.otherViewHalf,
  });
  const wallet = {
    address: built.address,
    network,
    spendPub: built.spendPub,
    viewPub: built.viewPub,
    viewSeedHex,
    spendHalf: m.spendHalf,
    viewHalf: m.viewHalf,
    otherSpendPoint: m.otherSpendPoint,
    otherViewPoint: m.otherViewPoint,
    otherViewHalf: m.otherViewHalf,
    source: "halves",
    // EXPLICIT: this wallet CANNOT yet spend. The spend key appears after a half is revealed on chain.
    spendable: false,
  };
  return {
    wallet,
    payload,
    restoreHeight: Number.isFinite(m.restoreHeight) && m.restoreHeight > 0 ? m.restoreHeight : 0,
    warnings: [
      ...warnings,
      "this file describes the HALVES scheme: the view key sees arrivals, but spending needs the counterparty " +
        "half, which is revealed on chain at the ETH claim",
    ],
  };
}

// The full path: decrypt the file with a password and restore the wallet.
export async function restoreFromFile(fileObject, passphrase, deps = {}) {
  return restoreWalletFromPayload(await decryptFile(fileObject, passphrase), deps);
}

// A safeguard pulled out so it can be tested: today share is built from a field allowlist, so a secret cannot
// get in. But if someone later adds a just-in-case field, it must fail here instead of leaking to the server.
// We check by field names and by values (renaming a field is easy, the secret value is not).
export function assertNoSecretsInShare(share, wallet) {
  // spendHalf and viewHalf were added with the halves scheme: secrets as strong as the spend key, they must not
  // reach the server - it sees only the SUM of view halves, enough to see incoming, not to spend.
  for (const name of ["mnemonic", "seed", "seedHex", "privateSpendKey", "spendKey", "subaddressKeys", "spendHalf", "viewHalf"]) {
    if (Object.hasOwn(share, name)) throw new Error("the watch-only share must not contain " + name);
  }
  const json = JSON.stringify(share);
  for (const [label, secret] of [
    ["spend key", wallet.privateSpendKey],
    ["mnemonic", wallet.mnemonic],
    ["seed", wallet.seedHex],
    ["spend key half", wallet.spendHalf],
    ["view key half", wallet.viewHalf],
  ]) {
    if (secret && json.includes(secret)) throw new Error(`the watch-only share leaked a secret (${label})`);
  }
  return share;
}

// What goes to the server: the address and view key - enough to see incoming, not to spend.
export function watchOnlyShareFromWallet({ swapId = null, wallet, restoreHeight = null } = {}) {
  if (!wallet || !wallet.address || !wallet.privateViewKey) {
    throw new Error("a watch-only wallet needs an address and a private view key");
  }
  // Built from the allowlist: wallet fields not listed here will never go out.
  return assertNoSecretsInShare(
    {
      swapId: swapId || null,
      network: wallet.network,
      address: wallet.address,
      privateViewKey: wallet.privateViewKey,
      restoreHeight: Number.isFinite(restoreHeight) ? restoreHeight : null,
    },
    wallet
  );
}
