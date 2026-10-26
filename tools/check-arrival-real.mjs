#!/usr/bin/env node
// A REAL STAGENET ARRIVAL, PINNED AS A FIXTURE.
//
// The synthetic checks prove the logic; this one proves the decoder against a transaction the network actually
// produced. The fixture is a type-6 transfer (CLSAG): `ecdhInfo` carries only the 8-byte amount, no mask, and the
// receiver derives the mask as Hs("commitment_mask" || sharedSec). It was taken from stagenet and paid to a
// test-only wallet; the view key can see incoming transfers and cannot spend.
//
// Run: node tools/check-arrival-real.mjs
import { readFileSync } from "node:fs";
import { matchTransaction } from "../engine/monero/scan.js";
import { verifyArrival } from "../src/xmr-arrival.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/stagenet-arrival.json", import.meta.url), "utf8"));
const { tx, txid, height, blockHash, address, viewSecret, spendPub, expectedAtomic } = fixture;
let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

console.log("=== 1) THE FIXTURE IS A REAL COMPACT TYPE-6 TRANSACTION ===");
if (tx.rct_signatures && Number(tx.rct_signatures.type) === 6) ok("rct_signatures.type is 6");
else bad("type: " + (tx.rct_signatures && tx.rct_signatures.type));
if (tx.rct_signatures && tx.rct_signatures.ecdhInfo.every((e) => e.mask === undefined)) ok("ecdhInfo has no mask field");
else bad("the fixture carries a mask field");

console.log("=== 2) THE DECODER FINDS THE OUTPUT AND VERIFIES ITS COMMITMENT ===");
const hit = matchTransaction(tx, [{ address, viewSecret, spendPub }], { height });
const outputs = hit[0] ? hit[0].outputs : [];
if (outputs.length === 1) ok("one owned output is found");
else bad("owned outputs: " + outputs.length);
if (outputs[0] && outputs[0].amountAtomic === BigInt(expectedAtomic)) ok("the decoded amount is " + expectedAtomic);
else bad("decoded amount: " + (outputs[0] && String(outputs[0].amountAtomic)));
if (outputs[0] && outputs[0].amountVerified === true) ok("the amount matches outPk through mask*G + amount*H");
else bad("the amount is not commitment-backed");

console.log("=== 3) verifyArrival ACCEPTS THE REAL TRANSACTION FROM TWO NODES ===");
const rpcFor = (body) => async (url, init) => {
  const request = JSON.parse(init.body);
  if (request.method === "get_info") return { ok: true, json: async () => ({ result: { height: height + 1, synchronized: true } }) };
  if (request.method === "get_block") return { ok: true, json: async () => ({ result: { block_header: { hash: blockHash }, tx_hashes: [txid] } }) };
  return { ok: true, json: async () => ({ txs: [{ tx_hash: txid, block_height: height, confirmations: 1 }],
    txs_as_json: [JSON.stringify(body)] }) };
};
const verdict = await verifyArrival({
  nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
  address, viewSecret, spendPub, expectedAtomic, minConfirmations: 1,
  fromHeight: height, txid, fetch: rpcFor(tx),
});
if (verdict.seen === true && verdict.state === "arrived") ok("the real arrival is accepted");
else bad("verdict: " + JSON.stringify(verdict));
if (verdict.amountAtomic === expectedAtomic) ok("the agreed amount is the decoded one");
else bad("arrived amount: " + verdict.amountAtomic);

console.log("=== 4) THE SAME REAL TRANSACTION WITH A CHANGED AMOUNT IS A DISAGREEMENT ===");
const forged = structuredClone(tx);
// THE OWNED OUTPUT IS INDEX 1: the other output belongs to someone else. Altering the wrong ciphertext
// leaves our own amount untouched and proves nothing.
const ownedIndex = outputs[0].index;
const cipher = Uint8Array.from(Buffer.from(forged.rct_signatures.ecdhInfo[ownedIndex].amount, "hex"));
cipher[0] ^= 1;
forged.rct_signatures.ecdhInfo[ownedIndex].amount = Buffer.from(cipher).toString("hex");
let error = null;
try {
  await verifyArrival({
    nodes: [{ url: "https://honest.example", operator: "A" }, { url: "https://lying.example", operator: "B" }],
    address, viewSecret, spendPub, expectedAtomic, minConfirmations: 1,
    fromHeight: height, txid,
    fetch: async (url, init) => {
      const body = url.includes("lying") ? forged : tx;
      return rpcFor(body)(url, init);
    },
  });
} catch (e) { error = e; }
if (error && error.code === "xmr-nodes-disagree") ok("an altered amount is refused");
else bad("altered amount returned " + (error ? error.code : "a verdict"));

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "real arrival: " + pass + " checks passed.");
if (fails.length) process.exit(1);
