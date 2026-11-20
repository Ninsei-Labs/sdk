#!/usr/bin/env node
// A REAL STAND CHECK FOR KEY IMAGES: monero-ts wallet output -> SDK and Rust.
//
// This is deliberately not a fixture test. It starts a real testnet monerod (offline, fixed difficulty), creates a
// funder and a target wallet with monero-ts, funds the funder by mining, sends a main-address payment (the buy
// case), a payment to a subaddress (the refunded-sale case), and a multi-destination transaction that makes Monero
// put per-output keys in extra tag 0x04 (the additional transaction-key case). It then compares three independent
// answers for every output:
//
//     monero-ts getKeyImage()  ==  SDK keyImageFromOutput()  ==  Rust monero-ed25519 oracle
//
// The Rust side is also built from the SDK's inputs, so a monero-ts defect cannot pass by agreeing with itself.
//
// Run:
//   docker run -d --name sdk-xmr-check -p 38081:38081 -p 38082:38082 \
//     ninsei-stand/monero:0.18.5.4 --testnet --offline --fixed-difficulty 1 \
//     --rpc-bind-ip=0.0.0.0 --rpc-bind-port=38081 --confirm-external-bind --non-interactive \
//     --no-igd --hide-my-port --data-dir /tmp/xmrdata
//   cargo build --release --manifest-path test/key-image-oracle/rust/Cargo.toml
//   KEY_IMAGE_STAND=1 node tools/check-key-image-stand.mjs
//
// Without KEY_IMAGE_STAND=1 this script exits immediately: it must never be part of the default check battery,
// which has no daemon and must stay fast.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import moneroTs from "monero-ts";
import * as mnemonic from "../engine/monero/mnemonic.js";
import { fromPrivateSpendKey } from "../engine/monero/keys.js";
import { addressFromKeys } from "../engine/monero/address.js";
import { decodeAddressKeys } from "../engine/monero/arrivalRead.js";
import { createSweep } from "../src/sweep.mjs";
import { verifyRecovery } from "../src/xmr-arrival.mjs";
import { keccak256 } from "../src/primitives.mjs";
import { ED_ORDER, bytesToHex, derivedOutputKey, hashToScalar, hexToBytes, keyDerivation, txKeysFromExtra, varint } from "../engine/monero/scan.js";
import { keyImageFromOutput, keyImageFromSpendKey } from "../engine/monero/keyImage.js";

if (process.env.KEY_IMAGE_STAND !== "1") {
  console.log("key image stand: skipped (set KEY_IMAGE_STAND=1 and start the local daemon)");
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON = process.env.KEY_IMAGE_STAND_DAEMON || "http://127.0.0.1:38081";
const ORACLE = process.env.KEY_IMAGE_ORACLE || [join(ROOT, "test/key-image-oracle/rust/target/release/key-image-oracle"),
  join(ROOT, "test/key-image-oracle/rust/target/release/key-image-oracle.exe")].find((path) => existsSync(path));
if (!ORACLE) throw new Error("build test/key-image-oracle/rust first");
const FUNDER_SEED = "amaze buffet cake entrance symptoms tiger lamb maze nestle python dusted faxed update vague zinger boxes ornament renting glass gained island nabbing afield calamity boxes";
const TARGET_SEED = mnemonic.encodeWithChecksum(Uint8Array.from({ length: 32 }, (_, i) => i + 0x40));
const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (!condition) problems.push(message); };
const leHex = (value) => { let x = BigInt(value), out = ""; for (let i = 0; i < 32; i += 1) { out += Number(x & 0xffn).toString(16).padStart(2, "0"); x >>= 8n; } return out; };
const beHex = (bytes) => Buffer.from(bytes).reverse().toString("hex");

const post = async (path, body) => {
  const response = await fetch(DAEMON + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return json;
};
const info = async () => (await post("/json_rpc", { jsonrpc: "2.0", id: "stand", method: "get_info" })).result;
const startMining = async (address) => post("/start_mining", { miner_address: address, threads_count: 1, do_background_mining: false, ignore_battery: true });
const stopMining = async () => post("/stop_mining", {});
const waitHeight = async (target) => {
  for (let i = 0; i < 240; i += 1) {
    const height = (await info()).height;
    if (height >= target) return height;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the daemon did not reach height ${target}`);
};
const walletOptions = (seed, restoreHeight) => ({
  seed, networkType: moneroTs.MoneroNetworkType.TESTNET, server: { uri: DAEMON }, password: "", restoreHeight,
});
const oracle = (requests) => {
  const result = spawnSync(ORACLE, [], { input: JSON.stringify({ requests }), encoding: "utf8" });
  if (result.status !== 0) throw new Error("Rust oracle failed: " + (result.stderr || result.error));
  return JSON.parse(result.stdout).results;
};

const start = (await info()).height;
await stopMining();
const funder = await moneroTs.createWalletFull(walletOptions(FUNDER_SEED, Math.max(0, start - 1)));
const target = await moneroTs.createWalletFull(walletOptions(TARGET_SEED, Math.max(0, start - 1)));
const funderAddress = await funder.getAddress(0, 0);
const targetAddress = await target.getAddress(0, 0);
const sub1 = await target.getAddress(0, 1);
const sub2 = await target.getAddress(0, 2);
const targetKeys = decodeAddressKeys(targetAddress);
const privateSpend = await target.getPrivateSpendKey();
const privateView = await target.getPrivateViewKey();
const publicSpend = await target.getPublicSpendKey();
check(targetKeys.spendPub === publicSpend, "the target wallet address carries the wallet public spend key");
const wallet = fromPrivateSpendKey(Buffer.from(privateSpend, "hex"));
const baseSpend = BigInt("0x" + beHex(Buffer.from(privateSpend, "hex")));

// Monero's subaddress spend secret is b + Hs("SubAddr\0" || a || account || index). The wallet's subaddress()
// gives the matching public key; the formula is checked below by rebuilding the address.
const subSpend = (index) => {
  const buffer = Buffer.concat([Buffer.from("SubAddr\0"), Buffer.from(privateView, "hex"),
    Buffer.from([0, 0, 0, 0]), Buffer.from([index & 0xff, (index >> 8) & 0xff, (index >> 16) & 0xff, (index >> 24) & 0xff])]);
  const m = BigInt("0x" + beHex(Buffer.from(keccak256(buffer)))) % ED_ORDER;
  return (baseSpend + m) % ED_ORDER;
};
for (const [index, address] of [[1, sub1], [2, sub2]]) {
  const derived = wallet.subaddress(index, 0);
  const rebuilt = addressFromKeys({ network: "testnet", kind: "subaddress", spendPub: Buffer.from(derived.publicSpendKey).toString("hex"), viewPub: Buffer.from(derived.publicViewKey).toString("hex") }, { keccak256 });
  check(rebuilt === address, `subaddress ${index} is rebuilt from the SDK keys`);
}

await startMining(funderAddress);
const fundedAt = await waitHeight(start + 80);
await stopMining();
await funder.sync();
check((await funder.getUnlockedBalance()) > 0n, "the funder has spendable testnet coins");

const buy = await funder.createTx({ accountIndex: 0, address: targetAddress, amount: 1_000_000_000_000n, relay: true });
const refundedSale = await funder.createTx({ accountIndex: 0, address: sub1, amount: 2_000_000_000_000n, relay: true });
const additional = await funder.createTx({ accountIndex: 0, destinations: [
  { address: sub1, amount: 3_000_000_000_000n }, { address: sub2, amount: 4_000_000_000_000n },
], relay: true });
await startMining(funderAddress);
const tip = await waitHeight(fundedAt + 2);
await stopMining();
await target.sync();
const outputs = await target.getOutputs();
check(outputs.length >= 4, `the target wallet sees the main, subaddress and multi-output payments (${outputs.length})`);

const records = [];
for (const output of outputs) {
  const txid = output.getTx().getHash();
  const raw = await post("/get_transactions", { txs_hashes: [txid], decode_as_json: true });
  const decoded = JSON.parse(raw.txs[0].as_json);
  const voutIndex = decoded.vout.findIndex((v) => ((v.target || {}).tagged_key || v.target || {}).key === output.getStealthPublicKey());
  if (voutIndex < 0) { problems.push(`output ${output.getStealthPublicKey()} is not in the transaction body`); continue; }
  const extraKeys = decoded.extra;
  const keys = txKeysFromExtra(extraKeys);
  const subaddressIndex = output.getSubaddressIndex();
  const spend = subaddressIndex === 0 ? baseSpend : subSpend(subaddressIndex);
  const spendPub = subaddressIndex === 0 ? publicSpend : Buffer.from(wallet.subaddress(subaddressIndex, 0).publicSpendKey).toString("hex");
  let derivation = null;
  let keyKind = null;
  let extraIndex = null;
  const candidates = [];
  for (const key of keys.txPublicKeys) candidates.push({ key, kind: "main", index: null });
  for (const [index, key] of keys.additionalPublicKeys.entries()) candidates.push({ key, kind: "additional", index });
  for (const candidate of candidates) {
    const bytes = keyDerivation(candidate.key, privateView);
    if (derivedOutputKey(bytes, voutIndex, spendPub) !== output.getStealthPublicKey()) continue;
    derivation = bytesToHex(bytes);
    keyKind = candidate.kind;
    extraIndex = candidate.index;
    break;
  }
  check(derivation !== null, `output ${voutIndex} is derived from ${keyKind || "a transaction key"}`);
  if (derivation === null) continue;
  const scalar = hashToScalar(hexToBytes(derivation), varint(voutIndex));
  const x = (scalar + spend) % ED_ORDER;
  const sdkImage = keyImageFromOutput({ outputKey: output.getStealthPublicKey(), derivation, index: voutIndex, privateSpendKey: leHex(spend) });
  const primitiveImage = keyImageFromSpendKey({ outputKey: output.getStealthPublicKey(), privateSpendKey: leHex(x) });
  const rustImage = oracle([{ op: "key_image", output_key: output.getStealthPublicKey(), private_spend_key: leHex(x) }])[0];
  const moneroImage = output.getKeyImage()?.getHex();
  check(primitiveImage === sdkImage, `the primitive and derivation path agree on output ${voutIndex}`);
  check(moneroImage === sdkImage, `monero-ts and the SDK agree on ${keyKind} output ${voutIndex}: ${moneroImage} vs ${sdkImage}`);
  check(rustImage?.ok === true && rustImage.key_image === sdkImage, `Rust and the SDK agree on ${keyKind} output ${voutIndex}`);
  records.push({ txid, voutIndex, subaddressIndex, keyKind, extraIndex, outputKey: output.getStealthPublicKey(), moneroImage, sdkImage, rustImage: rustImage?.key_image, derivation, amount: String(output.getAmount()) });
}

check(records.some((record) => record.keyKind === "main"), "at least one output uses the main transaction key");
check(records.some((record) => record.keyKind === "additional"), "at least one output uses an additional transaction key");
check(records.some((record) => record.keyKind === "main" && record.txid === buy.getHash()), "the buy payment is seen through the main key");
check(records.some((record) => record.subaddressIndex === 1 && record.txid === refundedSale.getHash()), "the refunded-sale payment is seen through a subaddress");
check(records.some((record) => record.keyKind === "additional" && record.txid === additional.getHash()), "the multi-output payment uses an additional key");

// The primary-address facade path. This is the same route the page uses: verifyRecovery -> sweep.keyImages.
const arrival = await verifyRecovery({
  nodes: [{ url: DAEMON, operator: "stand-a" }, { url: DAEMON, operator: "stand-b" }],
  address: targetAddress, viewSecret: privateView, spendPub: publicSpend,
  fromHeight: Math.max(0, start - 1), minConfirmations: 1, timeoutMs: 30000,
});
check(arrival.complete === true, "the recovery read is complete");
const sweep = createSweep();
for (const transfer of arrival.transfers) {
  if (!transfer.outputs?.length || transfer.outputs.some((output) => output.amountVerified !== true)) continue;
  const images = await sweep.keyImages({ keys: { privateSpendKey: privateSpend, privateViewKey: privateView, address: targetAddress }, arrival: transfer });
  for (const image of images) {
    const record = records.find((entry) => entry.txid === transfer.txid && entry.outputKey === image.outputKey);
    check(record !== undefined, `the facade returned an output present in the stand wallet (${transfer.txid})`);
    if (record) check(record.moneroImage === image.keyImage, `the facade image matches monero-ts for ${transfer.txid}/${image.outputKey}`);
  }
}
check(arrival.transfers.some((transfer) => transfer.txid === buy.getHash()), "the buy transaction is found by the primary read");

if (problems.length) {
  for (const problem of problems) console.log("  FAIL  " + problem);
  console.log("key image stand: FAILED (" + problems.length + ")");
  process.exitCode = 1;
} else {
  console.log(`key image stand: ${records.length} outputs agree across monero-ts, SDK and Rust (${checks} checks)`);
}
await funder.close();
await target.close();
await moneroTs.shutdown();
