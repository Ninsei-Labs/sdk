#!/usr/bin/env node
// THE MONERO KEY MODULE, PINNED WITH THE VALUES THE OLD VENDORED LIBRARY PRODUCED.
//
// These vectors were captured before monero-js was removed. They check the whole path that used to come from that
// package: mnemonic encoding/checksum, seed reduction, spend/view keys, the subaddress formula and the address
// encoder. A drift here is a different wallet, not a cosmetic change.
//
// Run: node tools/check.mjs --only=monero-keys (the check is registered in the battery)
import { addressFromKeys, checkAddress } from "../engine/monero/address.js";
import { createSwapWallet } from "../engine/monero/wallet.js";
import * as mnemonic from "../engine/monero/mnemonic.js";
import * as keys from "../engine/monero/keys.js";
import { WORDLIST } from "../engine/monero/wordlist.en.js";
import { keccak256 } from "../src/primitives.mjs";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const WORDS = "amaze buffet cake entrance symptoms tiger lamb maze nestle python dusted faxed update vague zinger boxes ornament renting glass gained island nabbing afield calamity boxes";
const PRIVATE_SPEND = "132d0ca6e9a1f3ae316c12682d132ffa0f1112131415161718191a1b1c1d1e0f";
const PRIVATE_VIEW = "73111dc718bf267d0cdf37e4096a051cecb7dac1f487af47d59ecd7b2ae1e00a";
const PUBLIC_SPEND = "ca4a448c3fc4d04945da9fdf920976c05e9bbe3d8cebb1858ea44d587c5e63c3";
const PUBLIC_VIEW = "88c1ef1bf8b7575ea2a8ccbc0bbde2d1b5e00da2980097a8b1a51e6d09f707ae";
const SUB_SPEND = "b4c4701686dfd7cac7450f31333730de09ca61179fdecf244dc3793f8c7cc86e";
const SUB_VIEW = "15061ca226c8d7656c6fff68ab7444c803c2ec00aefde1b929fb097df026b3cd";
const SUB_ACCOUNT_SPEND = "a7e310bddf060161a29e968e0cdf00b360ecf6a7f057d7c8ef5900330b8182e8";
const SUB_ACCOUNT_VIEW = "f40788bc3dda62f8b652e490cc8633257dac962806ff8685d5b5387c3602f039";
const MAINNET = "49HjJN4ZbLjDFqe3Mus7mPZBE6Q27cRGtPLfyuNejGdYZhvke36zj1xGq5kDCbSCXbc5TLTR7vygzVDYTcgFURLaLe4Gdds";
const MAINNET_SUB = "89JZu9GXu4zavCrprHJBhqe93rCDYAXGS75C8qoi1DKuKQwCfbZMM3tHxwH5H7Mx5ZaTPoHrEcTBEXyKiHYt47L6Q8ar72s";
const STAGENET = "59VmPCyXEwqDFqe3Mus7mPZBE6Q27cRGtPLfyuNejGdYZhvke36zj1xGq5kDCbSCXbc5TLTR7vygzVDYTcgFURLaLe9FA9B";
const STAGENET_SUB = "796XpJMaFTtavCrprHJBhqe93rCDYAXGS75C8qoi1DKuKQwCfbZMM3tHxwH5H7Mx5ZaTPoHrEcTBEXyKiHYt47L6Q9GHdE7";

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const problems = [];

export const moneroKeysCheck = async () => {
  problems.length = 0;
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const pw = (a, b, label) => check(hex(a) === b, `${label}: ${hex(a)}`);

  check(mnemonic.isValid(WORDS), "the fixed mnemonic was refused");
  check(WORDLIST.length === 1626 && new Set(WORDLIST).size === 1626, "the English wordlist is not 1626 unique words");
  check(!mnemonic.isValid(WORDS.split(" ").slice(0, 23).join(" ")), "a 23-word phrase was accepted");
  check(!mnemonic.isValid(WORDS.replace(/boxes$/, "boxed")), "a changed checksum word was accepted");
  check(hex(mnemonic.toSeed(WORDS)) === hex(SEED), "mnemonic decode did not return the seed");
  check(mnemonic.encodeWithChecksum(SEED) === WORDS, "the seed did not encode to the fixed mnemonic");

  const wallet = keys.fromSeed(SEED);
  pw(wallet.privateSpendKey, PRIVATE_SPEND, "private spend key");
  pw(wallet.privateViewKey, PRIVATE_VIEW, "private view key");
  pw(wallet.publicSpendKey, PUBLIC_SPEND, "public spend key");
  pw(wallet.publicViewKey, PUBLIC_VIEW, "public view key");
  const sub = wallet.subaddress(1, 0);
  pw(sub.publicSpendKey, SUB_SPEND, "subaddress spend key");
  pw(sub.publicViewKey, SUB_VIEW, "subaddress view key");
  // The account index is the major part of the SubAddr hash; this pins its order against a regression.
  const subAccount = wallet.subaddress(0, 1);
  pw(subAccount.publicSpendKey, SUB_ACCOUNT_SPEND, "account subaddress spend key");
  pw(subAccount.publicViewKey, SUB_ACCOUNT_VIEW, "account subaddress view key");

  const mainnet = addressFromKeys({ network: "mainnet", spendPub: PUBLIC_SPEND, viewPub: PUBLIC_VIEW }, { keccak256 });
  const mainnetSub = addressFromKeys({ network: "mainnet", kind: "subaddress", spendPub: SUB_SPEND, viewPub: SUB_VIEW }, { keccak256 });
  const stagenet = addressFromKeys({ network: "stagenet", spendPub: PUBLIC_SPEND, viewPub: PUBLIC_VIEW }, { keccak256 });
  const stagenetSub = addressFromKeys({ network: "stagenet", kind: "subaddress", spendPub: SUB_SPEND, viewPub: SUB_VIEW }, { keccak256 });
  check(mainnet === MAINNET, `mainnet address: ${mainnet}`);
  check(mainnetSub === MAINNET_SUB, `mainnet subaddress: ${mainnetSub}`);
  check(stagenet === STAGENET, `stagenet address: ${stagenet}`);
  check(stagenetSub === STAGENET_SUB, `stagenet subaddress: ${stagenetSub}`);

  const verified = await checkAddress(STAGENET, { expectNetwork: "stagenet" });
  check(verified.ok === true && verified.verified === true && verified.network === "stagenet", "a valid stagenet address was not verified");
  const wrongNetwork = await checkAddress(STAGENET, { expectNetwork: "mainnet" });
  check(wrongNetwork.ok === false, "a stagenet address was accepted as mainnet");
  const broken = STAGENET.slice(0, -1) + (STAGENET.endsWith("B") ? "C" : "B");
  const brokenVerdict = await checkAddress(broken, { expectNetwork: "stagenet" });
  check(brokenVerdict.ok === false && /Checksum|decode/i.test(brokenVerdict.reason), "a broken checksum was accepted");

  const swapWallet = await createSwapWallet({ seed: WORDS, network: "stagenet" });
  check(swapWallet.privateSpendKey === PRIVATE_SPEND, "createSwapWallet lost the spend key");
  check(swapWallet.privateViewKey === PRIVATE_VIEW, "createSwapWallet lost the view key");
  check(swapWallet.publicSpendKey === PUBLIC_SPEND, "createSwapWallet lost the public spend key");
  check(swapWallet.publicViewKey === PUBLIC_VIEW, "createSwapWallet lost the public view key");
  check(swapWallet.address === STAGENET, "createSwapWallet built the wrong stagenet address");
  check(swapWallet.subaddress === STAGENET_SUB, "createSwapWallet built the wrong stagenet subaddress");
  check(swapWallet.addressMainnet === MAINNET, "createSwapWallet built the wrong mainnet cross-check address");
  check(swapWallet.source === "ninsei-monero-keys", "createSwapWallet still names the removed vendor");
  let refused = false;
  try {
    await createSwapWallet({ seed: WORDS.replace(/boxes$/, "boxed"), network: "stagenet" });
  } catch {
    refused = true;
  }
  check(refused, "createSwapWallet accepted a mnemonic with a broken checksum");

  const generated = mnemonic.generateWithChecksum();
  check(generated.split(" ").length === 25 && mnemonic.isValid(generated), "a generated mnemonic is not a valid 25-word phrase");
  return {
    note: "mnemonic, keys, subaddresses and addresses match the pinned Monero vectors",
    problems,
    notes: ["the vectors are the values produced before the monero-js bundle was removed"],
  };
};
