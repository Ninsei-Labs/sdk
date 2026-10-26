#!/usr/bin/env node
// TWO NODES MUST AGREE ON THE WHOLE ARRIVAL, NOT JUST ON A BLOCK HASH.
//
// The defect this check closes: `verifyArrival` grouped witnesses by block hash and then took the LARGEST
// decoded amount over every node. One node could flip a bit of `ecdhInfo.amount` (no key needed), report the same
// block hash and make a 0.001 XMR payment look like an arrival of 1 XMR. The fix has two independent parts:
//   1) the decoded amount must match its Pedersen commitment `mask*G + amount*H = outPk`;
//   2) witnesses must agree on the transaction id, the block, every output key and amount, and the unlock state.
//
// The fixture is built with the primitives the scanner uses, and the encoded amount and mask are produced
// independently of `matchTransaction` (the same formulas, but written here on the bytes).
//
// Run: node tools/check-arrival-consensus.mjs
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { verifyArrival } from "../src/xmr-arrival.mjs";
import {
  amountMaskCommitment,
  bytesToHex,
  derivedOutputKey,
  ED_ORDER,
  hashToScalar,
  hexToBytes,
  keyDerivation,
  scalarToBytesLE,
  varint,
} from "../engine/monero/scan.js";

const G = ed25519.Point.BASE;
const TXID = "a".repeat(64);
const BLOCK_HASH = "b".repeat(64);
const AMOUNT = 1_000_000_000n; // 0.001 XMR
const VIEW = 11n;
const SPEND = 13n;
const R = 17n;

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

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

function fixture({ amount = AMOUNT, unlockTime = 0 } = {}) {
  const spendPub = G.multiply(SPEND).toHex();
  const txPublicKey = G.multiply(R).toHex();
  const derivation = keyDerivation(txPublicKey, VIEW);
  const scalar = hashToScalar(derivation, varint(0));
  const scalarLE = scalarToBytesLE(scalar);
  const amountCipher = xorBytes(le8(amount), factor("amount", scalarLE));
  // TYPES 4-6 SEND NO mask FIELD. The receiver derives it as Hs("commitment_mask" || sharedSec); a fixture
  // that supplied a mask here would test an encoding no node produces.
  const mask = hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
  const outPk = amountMaskCommitment(amount, mask);
  const key = derivedOutputKey(derivation, 0, spendPub);
  return {
    version: 2,
    unlock_time: unlockTime,
    extra: [1, ...hexToBytes(txPublicKey)],
    vout: [{ amount: 0, target: { tagged_key: { key, view_tag: "00" } } }],
    rct_signatures: {
      type: 6,
      ecdhInfo: [{ amount: bytesToHex(amountCipher) }],
      outPk: [outPk],
    },
  };
}

function rpcFor(txByHost) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "get_info") {
      return { ok: true, json: async () => ({ result: { height: 121, synchronized: true } }) };
    }
    if (body.method === "get_block") {
      return { ok: true, json: async () => ({ result: { block_header: { hash: BLOCK_HASH }, tx_hashes: [TXID] } }) };
    }
    const tx = Object.entries(txByHost).find(([base]) => base !== "default" && url.startsWith(base))?.[1] || txByHost.default;
    return {
      ok: true,
      json: async () => ({
        txs: [{ tx_hash: TXID, block_height: 100, confirmations: 21 }],
        txs_as_json: [JSON.stringify(tx)],
      }),
    };
  };
}

const address = "stagenet-address-for-the-fixture";
const spendPub = G.multiply(SPEND).toHex();

async function run({ nodes, txByHost, expectedAtomic = AMOUNT, minConfirmations = 10 }) {
  const verdict = await verifyArrival({
    nodes,
    address,
    viewSecret: VIEW,
    spendPub,
    expectedAtomic,
    minConfirmations,
    fromHeight: 100,
    txid: TXID,
    fetch: rpcFor(txByHost),
  });
  return verdict;
}

console.log("=== 1) TWO HONEST NODES AGREE ===");
{
  const tx = fixture();
  if (tx.rct_signatures.ecdhInfo[0].mask === undefined) ok("the fixture has the compact type-6 shape: no ecdhInfo.mask");
  else bad("the fixture supplied a mask that a type-6 transaction does not carry");
  const verdict = await run({
    nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
    txByHost: { default: tx },
  });
  if (verdict.seen === true && verdict.state === "arrived") ok("the honest pair returns arrived");
  else bad("honest pair: " + JSON.stringify(verdict, (k,v)=>typeof v==="bigint"?v.toString():v));
  if (verdict.amountAtomic === AMOUNT.toString()) ok("the amount comes from the agreed observation");
  else bad("arrived amount: " + verdict.amountAtomic);
  if (verdict.confirmations >= 10) ok("confirmations are reported");
  else bad("confirmations: " + verdict.confirmations);
}

console.log("=== 2) ONE ALTERED AMOUNT DEFEATS THE OLD MAXIMUM ===");
{
  const honest = fixture();
  const lying = structuredClone(honest);
  const c = hexToBytes(lying.rct_signatures.ecdhInfo[0].amount);
  c[7] ^= 0x80;
  lying.rct_signatures.ecdhInfo[0].amount = bytesToHex(c);
  let error = null;
  try {
    await run({
      nodes: [{ url: "https://honest.example", operator: "A" }, { url: "https://lying.example", operator: "B" }],
      txByHost: { "https://honest.example": honest, "https://lying.example": lying, default: honest },
    });
  } catch (e) { error = e; }
  if (error && error.code === "xmr-nodes-disagree") ok("an altered amount is a named disagreement");
  else bad("altered amount returned " + (error ? error.code : "a verdict"));
  if (error && /amount-unverified/.test(JSON.stringify(error.params || error))) ok("the refusal names the unverified amount");
  else bad("the refusal does not name amount-unverified: " + JSON.stringify(error && (error.params || error.message)));
}

console.log("=== 2b) TWO NODES THAT AGREE ON A FORGED AMOUNT ARE STILL REFUSED ===");
{
  const forged = fixture();
  const c = hexToBytes(forged.rct_signatures.ecdhInfo[0].amount);
  c[7] ^= 0x80;
  forged.rct_signatures.ecdhInfo[0].amount = bytesToHex(c);
  let error = null;
  try {
    await run({
      nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
      txByHost: { default: forged },
    });
  } catch (e) { error = e; }
  if (error && error.code === "xmr-nodes-disagree") ok("agreement on a forged amount is not an arrival");
  else bad("two forged nodes returned " + (error ? error.code : "a verdict"));
  if (error && /amount-unverified/.test(JSON.stringify(error.params || error))) ok("the commitment check names the forged amount");
  else bad("the refusal does not name amount-unverified: " + JSON.stringify(error && (error.params || error.message)));
}

console.log("=== 3) ONE NODE WHOSE OUTPUT KEY DIFFERS IS ALSO A DISAGREEMENT ===");
{
  const one = fixture();
  const two = structuredClone(one);
  two.vout[0].target.tagged_key.key = G.multiply(99n).toHex();
  // The second output no longer matches the watched address, so that node reports no-output.
  let error = null;
  try {
    await run({
      nodes: [{ url: "https://one.example", operator: "A" }, { url: "https://two.example", operator: "B" }],
      txByHost: { "https://one.example": one, "https://two.example": two, default: one },
    });
  } catch (e) { error = e; }
  if (error && error.code === "xmr-nodes-disagree") ok("a different output key is a disagreement");
  else bad("different output key returned " + (error ? error.code : "a verdict"));
}

console.log("=== 4) A SHORTFALL IS STILL NAMED, NOT ACCEPTED ===");
{
  const tx = fixture({ amount: AMOUNT });
  let error = null;
  try {
    await run({
      nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
      txByHost: { default: tx },
      expectedAtomic: AMOUNT + 1n,
    });
  } catch (e) { error = e; }
  if (error && error.code === "xmr-underpaid") ok("the shortfall has its own code");
  else bad("shortfall returned " + (error ? error.code : "a verdict"));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "arrival consensus: " + pass + " checks passed.");
if (fails.length) process.exit(1);
