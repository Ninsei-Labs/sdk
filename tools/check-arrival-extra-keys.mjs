#!/usr/bin/env node
// A SUBADDRESS OUTPUT IN A MIXED TRANSACTION IS STILL OUR ARRIVAL (sdk#271.1).
//
// Monero puts a per-output additional transaction key in extra tag 0x04. The scanner used to read only tag 0x01,
// so an output paid to a subaddress in a transaction that also paid someone else looked absent. This check builds
// a two-output transaction: output 0 belongs to another address, output 1 is ours and is derived from its own
// additional key. The same transaction without the tag is the negative control.
//
// Run: node tools/check-arrival-extra-keys.mjs
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { addressFromKeys } from "../engine/monero/address.js";
import {
  amountMaskCommitment, bytesToHex, derivedOutputKey, hashToScalar, hexToBytes, keyDerivation,
  matchTransaction, scalarToBytesLE, txKeysFromExtra, varint, scanRange,
} from "../engine/monero/scan.js";

const G = ed25519.Point.BASE;
const VIEW = 17n;
const SPEND = 19n;
const R0 = 23n;
const R1 = 29n;
const AMOUNT = 2_000_000_000n;
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
function fixture({ additional = true, view = VIEW } = {}) {
  const spendPub = G.multiply(SPEND).toHex();
  const viewPub = G.multiply(view).toHex();
  const address = addressFromKeys({ network: "stagenet", spendPub, viewPub }, { keccak256 });
  const primary = G.multiply(R0).toHex();
  const additionalKey = G.multiply(R1).toHex();
  const derivation = keyDerivation(additionalKey, view);
  const scalar = hashToScalar(derivation, varint(1));
  const scalarLE = scalarToBytesLE(scalar);
  const amount = xorBytes(le8(AMOUNT), factor("amount", scalarLE));
  const mask = hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
  const ownKey = derivedOutputKey(derivation, 1, spendPub);
  const otherKey = G.multiply(31n).toHex();
  const extra = [0x01, ...hexToBytes(primary)];
  if (additional) extra.push(0x04, 0x02, ...hexToBytes(primary), ...hexToBytes(additionalKey));
  return {
    tx: {
      version: 2,
      unlock_time: 0,
      extra,
      vout: [
        { amount: 0, target: { tagged_key: { key: otherKey, view_tag: "00" } } },
        { amount: 0, target: { tagged_key: { key: ownKey, view_tag: "00" } } },
      ],
      rct_signatures: {
        type: 6,
        ecdhInfo: [{ amount: "00".repeat(8) }, { amount: bytesToHex(amount) }],
        outPk: [amountMaskCommitment(1n, 1n), amountMaskCommitment(AMOUNT, mask)],
      },
    },
    primary,
    additionalKey,
    derivation: bytesToHex(derivation),
    spendPub,
    address,
  };
}

console.log("=== 1) THE EXTRA PARSER READS TAG 0x04 ===");
{
  const f = fixture();
  const keys = txKeysFromExtra(f.tx.extra);
  if (keys.txPublicKeys.length === 1 && keys.txPublicKeys[0] === f.primary) ok("the main key is read");
  else bad("main keys: " + JSON.stringify(keys.txPublicKeys));
  if (keys.additionalPublicKeys.length === 2 && keys.additionalPublicKeys[1] === f.additionalKey) {
    ok("both per-output additional keys are read, in output order");
  } else bad("additional keys: " + JSON.stringify(keys.additionalPublicKeys));
}

console.log("=== 2) THE OUTPUT DERIVED FROM ITS OWN ADDITIONAL KEY IS FOUND ===");
{
  const f = fixture();
  const hit = matchTransaction(f.tx, [{ address: f.address, viewSecret: VIEW, spendPub: f.spendPub }], { height: 100 });
  const outputs = hit[0] ? hit[0].outputs : [];
  if (outputs.length === 1 && outputs[0].index === 1) ok("only output 1 is ours");
  else bad("owned outputs: " + JSON.stringify(outputs.map((o) => o.index)));
  if (outputs[0] && outputs[0].amountAtomic === AMOUNT) ok("the amount is decoded with the additional key");
  else bad("amount: " + (outputs[0] && String(outputs[0].amountAtomic)));
  if (outputs[0] && outputs[0].amountVerified === true) ok("the decoded amount matches its commitment");
  else bad("the amount is not commitment-backed");
  if (outputs[0] && outputs[0].derivation === f.derivation) ok("the output carries the derivation that matched it");
  else bad("derivation: " + (outputs[0] && outputs[0].derivation));
}

console.log("=== 3) WITHOUT TAG 0x04 THE SAME OUTPUT IS ABSENT, NOT GUESSED ===");
{
  const f = fixture({ additional: false });
  const hit = matchTransaction(f.tx, [{ address: f.address, viewSecret: VIEW, spendPub: f.spendPub }], { height: 100 });
  if (hit.length === 0) ok("the main key alone does not invent an arrival");
  else bad("a missing additional key still produced " + hit.length + " hit(s)");
}

console.log("=== 4) THE ADDITIONAL KEY IS BOUND TO ITS OUTPUT INDEX ===");
{
  const f = fixture();
  const wrong = structuredClone(f.tx);
  wrong.extra = [0x01, ...hexToBytes(f.primary), 0x04, 0x01, ...hexToBytes(f.additionalKey)];
  const hit = matchTransaction(wrong, [{ address: f.address, viewSecret: VIEW, spendPub: f.spendPub }], { height: 100 });
  if (hit.length === 0) ok("key 0 cannot claim output 1");
  else bad("the wrong-index key produced " + hit.length + " hit(s)");
}

console.log("=== 5) PADDING BEFORE THE KEY IS SKIPPED ===");
{
  const f = fixture();
  const padded = { ...f.tx, extra: [0x00, 0x00, ...f.tx.extra] };
  const keys = txKeysFromExtra(padded.extra);
  if (keys.txPublicKeys[0] === f.primary) ok("zero padding does not consume the next tag");
  else bad("padding parse: " + JSON.stringify(keys));
}

console.log("=== 6) A MALFORMED EXTRA KEY DOES NOT HIDE THE REAL OUTPUT ===");
{
  const f = fixture();
  const poisoned = { ...f.tx, extra: [0x01, ...hexToBytes("ff".repeat(32)), ...f.tx.extra] };
  let hit = null;
  let error = null;
  try { hit = matchTransaction(poisoned, [{ address: f.address, viewSecret: VIEW, spendPub: f.spendPub }], { height: 100 }); }
  catch (e) { error = e; }
  if (!error && hit.length === 1 && hit[0].outputs.length === 1 && hit[0].outputs[0].index === 1) {
    ok("the decoder skips the bad key and still finds output 1");
  } else bad("bad extra key -> " + (error ? error.message : JSON.stringify(hit)));
}

console.log("=== 7) THE OTHER BYTE-ORDER READING IS NOT A SECOND ADDRESS ===");
{
  // A 64-hex watch string has two readings: the number it spells (1) and the little-endian bytes (2^248). The
  // address names the view point 1*G, so the LE reading belongs to a different address even though the string is
  // the same. The scanner must not count a payment to that other point.
  const viewHex = "00".repeat(31) + "01";
  const named = fixture({ view: 1n });
  const other = fixture({ view: 1n << 248n });
  const hit = matchTransaction(other.tx, [{ address: named.address, viewSecret: viewHex, spendPub: named.spendPub }], { height: 100 });
  if (hit.length === 0) ok("a payment to the other byte-order reading is not our arrival");
  else bad("the other byte-order reading produced " + hit.length + " hit(s)");
  const scanFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/json_rpc")) {
      return { ok: true, json: async () => ({ result: { json: JSON.stringify({ tx_hashes: ["aa"] }) } }) };
    }
    if (url.endsWith("/get_transactions")) {
      return { ok: true, json: async () => ({ txs: [{ tx_hash: "aa" }], txs_as_json: [JSON.stringify(other.tx)] }) };
    }
    throw new Error("unexpected route " + url);
  };
  const scanned = await scanRange({
    daemonUrl: "https://node.example", fromHeight: 100, toHeight: 100,
    watched: [{ address: named.address, viewSecret: viewHex, spendPub: named.spendPub }], fetchImpl: scanFetch,
  });
  const row = scanned.results[0] || {};
  if (row.receivedAtomic === 0n && (row.txids || []).length === 0) ok("the public scanRange applies the same address binding");
  else bad("scanRange counted the other byte-order reading: " + JSON.stringify({ received: String(row.receivedAtomic), txids: row.txids }));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "extra keys: " + pass + " checks passed.");
if (fails.length) process.exit(1);
