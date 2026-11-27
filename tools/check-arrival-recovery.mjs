#!/usr/bin/env node
// A RECOVERY READ MUST NOT DEPEND ON THE QUOTED AMOUNT.
//
// The seller can send less than the quote (an exchange fee), more, or several transfers. `verifyArrival` still
// applies the quote's amount to the ready gate; this separate read returns every transfer with its verified outputs
// so recovery can sweep what is actually there. A pool transfer is returned with `pool: true` and `confirmed: false`.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { readRecovery, verifyArrival, verifyRecovery } from "../src/xmr-arrival.mjs";
import { createSweep } from "../src/sweep.mjs";
import { keyImageFromSpendKey } from "../engine/monero/keyImage.js";
import {
  amountMaskCommitment, bytesToHex, derivedOutputKey, ED_ORDER, hashToScalar, hexToBytes, keyDerivation,
  scalarToBytesLE, varint,
} from "../engine/monero/scan.js";
import { addressFromKeys } from "../engine/monero/address.js";

const G = ed25519.Point.BASE;
const BLOCK_HASH = "09".repeat(32);
const VIEW = 11n;
const SPEND = 13n;
const R = 17n;
const SPEND_PUB = G.multiply(SPEND).toHex();
const VIEW_PUB = G.multiply(VIEW).toHex();
const ADDRESS = addressFromKeys({ network: "stagenet", kind: "primary", spendPub: SPEND_PUB, viewPub: VIEW_PUB }, { keccak256 });
const le32 = (value) => BigInt(value).toString(16).padStart(64, "0").match(/../g).reverse().join("");

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };
const okIf = (condition, message) => { if (condition) ok(message); else bad(message); };

function le8(value) {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function xorBytes(bytes, factor) {
  const out = bytes.slice();
  for (let i = 0; i < out.length && i < factor.length; i++) out[i] ^= factor[i];
  return out;
}
function factor(label, scalarLE) {
  const name = new TextEncoder().encode(label);
  const buf = new Uint8Array(name.length + scalarLE.length);
  buf.set(name, 0); buf.set(scalarLE, name.length);
  return keccak256(buf);
}
function fixture(amount) {
  const txPublicKey = G.multiply(R).toHex();
  const derivation = keyDerivation(txPublicKey, VIEW);
  const scalarLE = scalarToBytesLE(hashToScalar(derivation, varint(0)));
  const amountCipher = xorBytes(le8(amount), factor("amount", scalarLE));
  const mask = hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
  const outPk = amountMaskCommitment(amount, mask);
  const key = derivedOutputKey(derivation, 0, SPEND_PUB);
  return {
    version: 2,
    unlock_time: 0,
    extra: [1, ...hexToBytes(txPublicKey)],
    vout: [{ amount: 0, target: { tagged_key: { key, view_tag: "00" } } }],
    rct_signatures: { type: 6, ecdhInfo: [{ amount: bytesToHex(amountCipher) }], outPk: [outPk] },
  };
}

const ATOMIC_SHORT = 150_000_000_000n; // 0.15 XMR
const ATOMIC_QUOTE = 300_000_000_000n; // 0.3 XMR
const ATOMIC_OVER = 450_000_000_000n; // 0.45 XMR
const T1 = "a".repeat(64);
const T2 = "b".repeat(64);
const T3 = "c".repeat(64);
const T4 = "d".repeat(64);
const T5 = "e".repeat(64);
const T6 = "f".repeat(64);

function rpc({ blockTxids = [], poolHashes = [], poolFails = false, txs = {}, poolTxs = {}, failAt = null } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info") return { ok: true, json: async () => ({ result: { height: 121, synchronized: true, nettype: "stagenet" } }) };
    if (body.method === "get_block") {
      const height = Number(body.params.height);
      if (height === failAt) return { ok: false, status: 503 };
      const hashes = height === 105 ? blockTxids : [];
      return { ok: true, json: async () => ({ result: {
        block_header: {
          height, hash: (height < 0 ? "00" : height.toString(16).padStart(2, "0")).repeat(32),
          prev_hash: (height <= 0 ? "00" : (height - 1).toString(16).padStart(2, "0")).repeat(32),
          num_txes: hashes.length,
        },
        tx_hashes: hashes,
      } }) };
    }
    if (url.endsWith("/get_transaction_pool_hashes")) {
      if (poolFails) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ tx_hashes: poolHashes }) };
    }
    if (url.endsWith("/is_key_image_spent")) {
      const images = body.key_images || [];
      return { ok: true, json: async () => ({ status: "OK", spent_status: images.map(() => 0) }) };
    }
    const hashes = body.txs_hashes || [];
    const inPool = !hashes.some((hash) => blockTxids.includes(hash));
    const source = inPool ? (Object.keys(poolTxs).length ? poolTxs : txs) : txs;
    return { ok: true, json: async () => ({
      txs: hashes.map((hash) => ({ tx_hash: hash, block_height: inPool ? null : 105, confirmations: inPool ? 0 : 16 })),
      txs_as_json: hashes.map((hash) => JSON.stringify(source[hash] || { extra: [], vout: [] })),
    }) };
  };
}

const request = (fetch, nodes = [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }], extra = {}) => ({
  nodes, address: ADDRESS, viewSecret: VIEW, spendPub: SPEND_PUB, fromHeight: 100, minConfirmations: 1, fetch, ...extra,
});

export const arrivalRecoveryCheck = async () => {
console.log("=== 0) THE START HEIGHT IS REQUIRED, NOT SILENTLY GENESIS ===");
{
  let caught = null;
  try { await verifyRecovery({ ...request(rpc()), fromHeight: undefined }); }
  catch (error) { caught = error; }
  if (caught && caught.code === "bad-input" && caught.params && caught.params.field === "fromHeight") {
    ok("a missing fromHeight is refused");
  } else bad("missing fromHeight: " + JSON.stringify(caught && { code: caught.code, params: caught.params }));
}

console.log("=== 1) SHORT, OVER AND QUOTE AMOUNTS ARE ALL RETURNED ===");
{
  const txs = { [T1]: fixture(ATOMIC_SHORT), [T2]: fixture(ATOMIC_QUOTE), [T3]: fixture(ATOMIC_OVER) };
  const verdict = await verifyRecovery(request(rpc({ blockTxids: [T1, T2, T3], txs })));
  const amounts = (verdict.transfers || []).map((transfer) => transfer.amountAtomic).sort();
  if (verdict.state === "ready" && verdict.complete === true && amounts.length === 3
    && amounts.includes(ATOMIC_SHORT.toString()) && amounts.includes(ATOMIC_QUOTE.toString()) && amounts.includes(ATOMIC_OVER.toString())) {
    ok("all three transfers are returned with their verified amounts");
  } else {
    bad("recovery amounts: " + JSON.stringify(verdict));
  }
  if (verdict.transfers.every((transfer) => transfer.agreed && transfer.confirmed)) {
    ok("both operators agree and the block transfers are confirmed");
  } else bad("agreement/confirmation: " + JSON.stringify(verdict.transfers));
}

console.log("=== 1b) A SPLIT PAYMENT IS TWO TRANSFERS, NOT ONE REFUSAL ===");
{
  const first = 100_000_000_000n;
  const second = 200_000_000_000n;
  const txs = { [T5]: fixture(first), [T6]: fixture(second) };
  const verdict = await verifyRecovery(request(rpc({ blockTxids: [T5, T6], txs })));
  const amounts = (verdict.transfers || []).map((transfer) => transfer.amountAtomic).sort();
  const sum = (verdict.transfers || []).reduce((total, transfer) => total + BigInt(transfer.amountAtomic), 0n);
  if (verdict.state === "ready" && amounts.length === 2 && sum === ATOMIC_QUOTE) {
    ok("two transfers that sum to the quote are both returned");
  } else bad("split recovery: " + JSON.stringify(verdict));
}

console.log("=== 1c) A WITNESS BELOW THE PRIMARY TOP MAKES THE READ INCOMPLETE ===");
{
  const txs = { [T2]: fixture(ATOMIC_QUOTE) };
  const baseFetch = rpc({ blockTxids: [T2], txs });
  const mixedFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info" && new URL(url).hostname === "b.example") {
      return { ok: true, json: async () => ({ result: { height: 104, synchronized: true, nettype: "stagenet" } }) };
    }
    return baseFetch(url, init);
  };
  const verdict = await verifyRecovery(request(mixedFetch));
  if (verdict.complete === false && verdict.state === "one-node" && verdict.transfers.length === 1
    && verdict.failed.some((failure) => failure.why === "witness-behind")) {
    ok("a witness below the primary top is incomplete, not silently complete");
  } else bad("lower-tip recovery: " + JSON.stringify(verdict));
}

console.log("=== 1c2) ABSENCE NEEDS EVERY CONFIGURED OPERATOR, AND A WITNESS AHEAD OF THE PRIMARY IS UNKNOWN ===");
{
  const three = [
    { url: "https://a.example", operator: "A" },
    { url: "https://b.example", operator: "B" },
    { url: "https://c.example", operator: "C" },
  ];
  const base = rpc();
  const thirdDown = async (url, init) => {
    if (new URL(url).hostname === "c.example" && JSON.parse(init.body).method === "get_info") {
      return { ok: false, status: 503 };
    }
    return base(url, init);
  };
  const missing = await verifyArrival({
    ...request(thirdDown, three, { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(missing.absent === false && missing.state === "unknown",
    "a failing third operator did not turn an empty read into absence");

  const ahead = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info") {
      const host = new URL(url).hostname;
      const height = host === "b.example" ? 106 : 102;
      return { ok: true, json: async () => ({ result: { height, synchronized: true, nettype: "stagenet" } }) };
    }
    return base(url, init);
  };
  const behind = await verifyRecovery(request(ahead));
  okIf(behind.complete === false && behind.failed.some((failure) => failure.why === "witness-ahead"),
    "a witness ahead of the primary left the recovery read incomplete");
  const behindArrival = await verifyArrival({
    ...request(ahead, undefined, { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(behindArrival.absent === false && behindArrival.state === "unknown",
    "a primary behind its witness did not claim absence");
}

console.log("=== 1d) A DOWN PRIMARY IS NOT REPLACED BY A WITNESS ===");
{
  const baseFetch = rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } });
  let witnessBlocks = 0;
  const primaryDown = async (url, init) => {
    const body = JSON.parse(init.body);
    const host = new URL(url).hostname;
    if (host === "a.example" && body.method === "get_info") {
      return { ok: false, status: 503 };
    }
    if (host === "b.example" && body.method === "get_block") witnessBlocks += 1;
    return baseFetch(url, init);
  };
  const verdict = await verifyRecovery(request(primaryDown));
  if (verdict.complete === false && verdict.state === "none" && verdict.transfers.length === 0
    && verdict.availableSource === null && verdict.failed.some((failure) => failure.why !== "witness-behind")
    && witnessBlocks === 0) {
    ok("a down primary leaves the read incomplete; no witness is promoted");
  } else bad("primary-down recovery: " + JSON.stringify({ verdict, witnessBlocks }));
}

console.log("=== 1b) THE RECOVERY OUTPUT CARRIES A DERIVATION AND FEEDS keyImages ===");
{
  const txs = { [T2]: fixture(ATOMIC_QUOTE) };
  const verdict = await verifyRecovery(request(rpc({ blockTxids: [T2], txs })));
  const transfer = verdict.transfers && verdict.transfers[0];
  const output = transfer && transfer.outputs && transfer.outputs[0];
  const keys = { privateSpendKey: le32(SPEND), privateViewKey: le32(VIEW), address: ADDRESS };
  const expected = output && keyImageFromSpendKey({
    outputKey: output.key, privateSpendKey: le32((hashToScalar(hexToBytes(output.derivation), varint(output.index)) + SPEND) % ED_ORDER),
  });
  const images = transfer ? await createSweep().keyImages({ keys, arrival: transfer }) : [];
  if (output && output.derivation && images.length === 1 && images[0].keyImage === expected) {
    ok("a recovery transfer derives the same image as its known spend scalar");
  } else bad("recovery key image: " + JSON.stringify({ output, images, expected }));
}

console.log("=== 1c) A SPENT FUNDING OUTPUT IS EXCLUDED FROM THE AVAILABLE REMAINDER ===");
{
  const funded = fixture(ATOMIC_SHORT);
  const outputKey = funded.vout[0].target.tagged_key.key;
  const spendImage = "ab".repeat(32);
  const verdict = await verifyRecovery({
    ...request(rpc({ blockTxids: [T1], txs: { [T1]: { ...funded, vin: [{ key: { k_image: spendImage } }] } } })),
    keyImages: [{ keyImage: spendImage, outputKey }],
  });
  if (verdict.complete === true && verdict.spends.length === 1 && verdict.spends[0].keyImage === spendImage
    && verdict.availableAtomic === "0" && verdict.receivedAtomic === ATOMIC_SHORT.toString()
    && verdict.spentAtomic === ATOMIC_SHORT.toString() && verdict.unspentAtomic === "0"
    && verdict.withdrawalState === "withdrawn") {
    ok("a spend is reported and removed from the available remainder");
  } else bad("spend/available recovery: " + JSON.stringify({ spends: verdict.spends, availableAtomic: verdict.availableAtomic }));
}

console.log("=== 1d) A CLOSED WINDOW USES THE PRIMARY TIP FOR CONFIRMATIONS AND SKIPS THE WITNESS POOL ===");
{
  const txs = { [T1]: fixture(ATOMIC_QUOTE) };
  const verdict = await verifyRecovery(request(rpc({ blockTxids: [T1], txs }), undefined, { toHeight: 105 }));
  const transfer = verdict.transfers && verdict.transfers[0];
  if (verdict.complete === true && verdict.state === "ready" && transfer && transfer.agreed
    && transfer.confirmations === 16) {
    ok("a closed window keeps the primary tip for confirmations");
  } else bad("closed-window confirmations: " + JSON.stringify({ state: verdict.state, transfer }));
}
{
  const txs = { [T4]: fixture(ATOMIC_SHORT) };
  const verdict = await verifyRecovery(request(rpc({ poolHashes: [T4], txs }), undefined, { toHeight: 105 }));
  if (verdict.complete === true && verdict.transfers.length === 0) {
    ok("a closed window does not read a witness pool");
  } else bad("closed-window witness pool: " + JSON.stringify(verdict.transfers));
}

console.log("=== 2) A TRANSFER SEEN BY ONE OPERATOR IS NOT AN AGREED TRANSFER ===");
{
  const verdict = await verifyRecovery(request(
    rpc({ blockTxids: [T1], txs: { [T1]: fixture(ATOMIC_QUOTE) } }),
    [{ url: "https://a.example", operator: "A" }],
  ));
  if (verdict.state === "one-node" && verdict.transfers.length === 1 && verdict.transfers[0].agreed === false) {
    ok("one operator is returned as one-node, not as agreement");
  } else bad("one-node recovery: " + JSON.stringify(verdict));
}

console.log("=== 3) AN UNCONFIRMED POOL TRANSFER IS RETURNED BUT NOT CONFIRMED ===");
{
  const txs = { [T4]: fixture(ATOMIC_SHORT) };
  const verdict = await verifyRecovery(request(rpc({ poolHashes: [T4], txs })));
  const transfer = verdict.transfers && verdict.transfers[0];
  if (verdict.state === "pending" && transfer && transfer.pool === true && transfer.confirmed === false
    && transfer.amountAtomic === ATOMIC_SHORT.toString() && transfer.agreed === true) {
    ok("the pool transfer is returned with pool: true and confirmations: 0");
  } else bad("pool recovery: " + JSON.stringify(verdict));
}

console.log("=== 4) A FAILED POOL READ MAKES THE LIST INCOMPLETE ===");
{
  const verdict = await verifyRecovery(request(rpc({ poolFails: true })));
  if (verdict.complete === false && verdict.failed.some((entry) => entry.why === "pool-read")
    && verdict.state === "none") {
    ok("a failed pool read is named and the answer is not complete");
  } else bad("failed pool recovery: " + JSON.stringify(verdict));
}

console.log("=== 5) BREAKING RUN: AN AMOUNT FILTER DROPS THE SHORT TRANSFER ===");
{
  const sourceFile = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "xmr-arrival.mjs");
  const mutantFile = join(dirname(sourceFile), ".recovery-mutant-" + process.pid + ".mjs");
  const source = readFileSync(sourceFile, "utf8").replace(/\r\n/g, "\n");
  const from = "if (!hit.length) continue;\n        const confirmations = confirmationsOf(tx, height, tipTop);";
  if (!source.includes(from)) {
    bad("the breaking-run mutation did not apply");
  } else {
    const changed = source.split(from).join("if (!hit.length || sumOutputs(hit[0]) < 300000000000n) continue;\n        const confirmations = confirmationsOf(tx, height, top);");
    writeFileSync(mutantFile, changed, "utf8");
    try {
      const mutant = await import(pathToFileURL(mutantFile).href + "?v=" + process.pid);
      const verdict = await mutant.readRecovery(request(rpc({
        blockTxids: [T1], txs: { [T1]: fixture(ATOMIC_SHORT) },
      })));
      if (verdict.transfers.length === 0) ok("the amount filter removes the short transfer (the guard is load-bearing)");
      else bad("breaking run kept the short transfer: " + JSON.stringify(verdict.transfers));
    } finally {
      rmSync(mutantFile, { force: true });
    }
  }
}

console.log("=== 6) THE AMOUNT RULES OVER THE SAME READ ===");
{
  const split = { [T5]: fixture(100_000_000_000n), [T6]: fixture(200_000_000_000n) };
  const buy = await verifyArrival({
    ...request(rpc({ blockTxids: [T5, T6], txs: split }), undefined, { amountRule: "at-least", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(buy.state === "arrived" && buy.amountRule === "at-least" && BigInt(buy.amountAtomic) === ATOMIC_QUOTE,
    "buy at-least accepts two outputs that reach the quote");
  // AN ARRIVED EXACT READ DESCRIBES THE TRANSFERS IT USED. A confirmed 0.30 plus a pool 0.05 is not an `over`
  // payment: the answer keeps the 0.30 txid, amount and confirmations, and its comparison stays exact.
  const arrivedWithPool = await verifyArrival({
    ...request(rpc({ blockTxids: [T2], poolHashes: [T4],
      txs: { [T2]: fixture(ATOMIC_QUOTE), [T4]: fixture(50_000_000_000n) } }), undefined,
    { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(arrivedWithPool.state === "arrived" && arrivedWithPool.amountComparison === "exact"
    && arrivedWithPool.txid === T2 && arrivedWithPool.amountAtomic === ATOMIC_QUOTE.toString()
    && arrivedWithPool.confirmations === 16,
    "an arrived exact read keeps the pool amount out of its figures: " + JSON.stringify({
      state: arrivedWithPool.state, comparison: arrivedWithPool.amountComparison, txid: arrivedWithPool.txid,
      amount: arrivedWithPool.amountAtomic, confirmations: arrivedWithPool.confirmations,
      transfers: arrivedWithPool.transfers.map((transfer) => ({ txid: transfer.txid, pool: transfer.pool, agreed: transfer.agreed, amount: transfer.amountAtomic })),
    }));
  const over = await verifyArrival({
    ...request(rpc({ blockTxids: [T1], txs: { [T1]: fixture(ATOMIC_OVER) } }), undefined, { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(over.state === "over" && over.seen === false && over.amountComparison === "over"
    && over.overageAtomic === (ATOMIC_OVER - ATOMIC_QUOTE).toString(), "sale exact names an overpayment");
  const short = await verifyArrival({
    ...request(rpc({ blockTxids: [T1], txs: { [T1]: fixture(ATOMIC_SHORT) } }), undefined,
      { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(short.state === "short" && short.absent === false && short.amountComparison === "short"
    && short.shortfallAtomic === (ATOMIC_QUOTE - ATOMIC_SHORT).toString(),
    "an underpaid sale is short, not absent");
  const confirming = await verifyArrival({
    ...request(rpc({ blockTxids: [T1], txs: { [T1]: fixture(ATOMIC_QUOTE) } }), undefined,
      { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE, minConfirmations: 20 }),
  });
  okIf(confirming.state === "confirming" && confirming.txid === T1 && confirming.confirmations === 16
    && confirming.amountAtomic === ATOMIC_QUOTE.toString(),
    "a paid transfer still confirming keeps its txid, amount and confirmations");
  const lockedTx = fixture(ATOMIC_QUOTE);
  lockedTx.unlock_time = 5_000_000_000;
  const locked = await verifyArrival({
    ...request(rpc({ blockTxids: [T1], txs: { [T1]: lockedTx } }), undefined,
      { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(locked.state === "locked" && locked.seen === false && locked.unlock && locked.unlock.untilTime === 5_000_000_000,
    "a locked payment is named with its unlock time");
  const failInfoB = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info" && new URL(url).hostname === "b.example") return { ok: false, status: 503 };
    return rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } })(url, init);
  };
  const deadWitness = await verifyArrival({
    ...request(failInfoB, undefined, { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(deadWitness.state === "unknown" && deadWitness.seen === false,
    "exact does not settle when a configured witness never answered get_info");
  const failInfoC = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info" && new URL(url).hostname === "c.example") return { ok: false, status: 503 };
    return rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } })(url, init);
  };
  const quorum = await verifyArrival({
    ...request(failInfoC, [
      { url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" },
      { url: "https://c.example", operator: "C" },
    ], { amountRule: "at-least", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(quorum.state === "arrived" && quorum.seen === true,
    "at-least settles with two complete operators when the third never answered");
  // WITHOUT THE PRIMARY, TWO COMPLETE WITNESSES CAN STILL SETTLE A BUY. The primary is not promoted and the answer
  // is incomplete for figures and absence, but the payment itself is agreed by the required operators.
  const primaryDown = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info" && new URL(url).hostname === "a.example") return { ok: false, status: 503 };
    return rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } })(url, init);
  };
  const witnessOnly = await verifyArrival({
    ...request(primaryDown, [
      { url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" },
      { url: "https://c.example", operator: "C" },
    ], { amountRule: "at-least", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(witnessOnly.state === "arrived" && witnessOnly.seen === true
    && witnessOnly.failed.some((failure) => String(failure.url).includes("a.example")),
    "at-least settles on two witnesses when the primary is down");
  const witnessOnlyRecovery = await verifyRecovery(request(primaryDown, [
    { url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" },
    { url: "https://c.example", operator: "C" },
  ]));
  okIf(witnessOnlyRecovery.state === "pending" && witnessOnlyRecovery.availableSource === null,
    "a witness-only read never reports ready without the primary");
  // AN UNAGREED EXTRA TRANSFER KEEPS `exact` UNKNOWN. The signed 0.30 is agreed by A and B; C also sees a 0.15 that
  // nobody agrees with. Paying the exact amount is not enough to call the sale exact while a second transfer exists.
  const baseAB = rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } });
  const baseC = rpc({ blockTxids: [T4], txs: { [T4]: fixture(ATOMIC_SHORT) } });
  const extraOnC = async (url, init) => (
    new URL(url).hostname === "c.example" ? baseC(url, init) : baseAB(url, init)
  );
  const extra = await verifyArrival({
    ...request(extraOnC, [
      { url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" },
      { url: "https://c.example", operator: "C" },
    ], { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(extra.state === "unknown" && extra.seen === false,
    "exact stays unknown when one operator sees an extra transfer");
  // A POOL THAT CANNOT BE READ DOES NOT UNDO A MINED PAYMENT the required operators agree on.
  const poolOnC = async (url, init) => (
    new URL(url).hostname === "c.example"
      ? rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) }, poolFails: true })(url, init)
      : rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } })(url, init)
  );
  const poolFailed = await verifyArrival({
    ...request(poolOnC, [
      { url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" },
      { url: "https://c.example", operator: "C" },
    ], { amountRule: "at-least", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(poolFailed.state === "arrived" && poolFailed.seen === true,
    "at-least keeps a mined payment when one operator's pool fails");
  const oneExact = await verifyArrival({
    ...request(rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } }),
      [{ url: "https://a.example", operator: "A" }], { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(oneExact.state === "unknown" && oneExact.seen === false,
    "exact keeps a one-node match unknown");
  const oneAtLeast = await verifyArrival({
    ...request(rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } }),
      [{ url: "https://a.example", operator: "A" }], { amountRule: "at-least", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(oneAtLeast.state === "one-node" && oneAtLeast.seen === false,
    "at-least names a one-node match without settling it");
  const defaultOneRead = await verifyArrival({
    ...request(rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } }), undefined,
      { expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(defaultOneRead.state === "arrived" && defaultOneRead.seen === true,
    "the default arrival uses the one read with the exact rule");
  const exact = await verifyArrival({
    ...request(rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } }), undefined, { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(exact.state === "arrived" && exact.seen === true, "sale exact accepts the signed amount");
  const { spendPub: _spendPub, ...withoutSpend } = request(rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } }));
  const viewOnly = await verifyArrival({ ...withoutSpend, amountRule: "at-least", expectedAtomic: ATOMIC_QUOTE });
  okIf(viewOnly.state === "arrived", "arrival with the address and view key only reaches the same answer");
  const legacyViewOnly = await verifyArrival({ ...withoutSpend, expectedAtomic: ATOMIC_QUOTE });
  okIf(legacyViewOnly.state === "arrived", "the default arrival path also works without a supplied spend key");
  let noStart = null;
  try {
    await verifyArrival({ ...request(rpc()), fromHeight: undefined, amountRule: "at-least", expectedAtomic: ATOMIC_QUOTE });
  } catch (error) { noStart = error; }
  okIf(noStart && noStart.code === "bad-input" && noStart.params.field === "fromHeight",
    "an omitted fromHeight is refused; genesis must be explicit");
  const unread = await verifyArrival({
    ...request(rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) }, failAt: 110 }), undefined,
      { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(unread.state === "unknown" && unread.seen === false
    && unread.failed.some((failure) => failure.height === 110),
    "sale exact keeps a read with a later unread part unknown, not arrived");
  const restored = await verifyArrival({
    ...request(rpc({ blockTxids: [T2], txs: { [T2]: fixture(ATOMIC_QUOTE) } }), undefined,
      { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE }),
  });
  okIf(restored.state === "arrived" && restored.seen === true,
    "a complete exact read is the only one that offers the sale arrival");
}

console.log("=== 7) SPENT STATUS GOES ONLY TO THE TRUSTED PRIMARY AND CAN BE TURNED OFF ===");
{
  const images = ["ab".repeat(32)];
  const statusCalls = [];
  const base = rpc();
  const trackedFetch = async (url, init) => {
    if (String(url).endsWith("/is_key_image_spent")) statusCalls.push(new URL(url).hostname);
    return base(url, init);
  };
  await verifyArrival({
    ...request(trackedFetch, undefined, { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE,
      keyImages: images, spentStatus: false }),
  });
  okIf(statusCalls.length === 0, "spentStatus: false sent no key images to any node");
  await verifyArrival({
    ...request(trackedFetch, undefined, { amountRule: "exact", expectedAtomic: ATOMIC_QUOTE,
      keyImages: images, spentStatus: true }),
  });
  okIf(statusCalls.length === 1 && statusCalls[0] === "a.example",
    "spentStatus: true asked only the primary for key images");
}

return { note: "recovery reads every transfer without the quoted amount", problems: fails, notes: fails.length ? [] : ["short, over, split and pool transfers are returned"] };
};

if (import.meta.main) {
  const result = await arrivalRecoveryCheck();
  for (const problem of result.problems) console.log("  FAIL  " + problem);
  console.log(result.problems.length ? "FAILED" : "recovery read: " + result.note);
  if (result.problems.length) process.exit(1);
}
