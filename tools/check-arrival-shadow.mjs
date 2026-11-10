#!/usr/bin/env node
// THE SHADOW CHECK IS A COMPARISON, NOT A SWAP DECISION.
//
// It runs the real exact `verifyArrival` and the real witness-v1 client against one fixture. The check proves:
//   * the witness is asked for a slice, never for the order's start or the payout height;
//   * the slice reading agrees with the exact reading on txid, block, amount and height;
//   * a different block hash is reported, not accepted;
//   * a standard URL without `protocol: "witness-v1"` is refused by name.
import { ed25519, keccak256 } from "../src/primitives.mjs";
import { verifyArrivalShadow } from "../src/xmr-arrival.mjs";
import {
  amountMaskCommitment, bytesToHex, derivedOutputKey, hashToScalar, hexToBytes,
  keyDerivation, scalarToBytesLE, varint,
} from "../engine/monero/scan.js";
import { addressFromKeys } from "../engine/monero/address.js";

const G = ed25519.Point.BASE;
const TXID = "a".repeat(64);
const BLOCK_HASH = "b".repeat(64);
const AMOUNT = 1_000_000_000n;
const VIEW = 11n;
const SPEND = 13n;
const R = 17n;

function isHost(url, host) {
  try { return new URL(url).hostname === host; } catch { return false; }
}

let pass = 0;
const problems = [];
const ok = (name) => { pass += 1; console.log("  ok    " + name); };
const bad = (name) => { problems.push(name); console.log("  FAIL  " + name); };

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
function fixture() {
  const spendPub = G.multiply(SPEND).toHex();
  const txPublicKey = G.multiply(R).toHex();
  const derivation = keyDerivation(txPublicKey, VIEW);
  const scalar = hashToScalar(derivation, varint(0));
  const scalarLE = scalarToBytesLE(scalar);
  const amountCipher = xorBytes(le8(AMOUNT), factor("amount", scalarLE));
  const mask = hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
  const outPk = amountMaskCommitment(AMOUNT, mask);
  const key = derivedOutputKey(derivation, 0, spendPub);
  return {
    version: 2,
    unlock_time: 0,
    extra: [1, ...hexToBytes(txPublicKey)],
    vout: [{ amount: 0, target: { tagged_key: { key, view_tag: "00" } } }],
    rct_signatures: { type: 6, ecdhInfo: [{ amount: bytesToHex(amountCipher) }], outPk: [outPk] },
  };
}

const spendPub = G.multiply(SPEND).toHex();
const viewPub = G.multiply(VIEW).toHex();
const address = addressFromKeys({ network: "stagenet", kind: "primary", spendPub, viewPub }, { keccak256 });
const tx = fixture();
const requests = [];

function blockFor(height) {
  const hash = height === 105 ? BLOCK_HASH : String(height).padStart(64, "0");
  return { block_header: { hash }, tx_hashes: height === 105 ? [TXID] : [] };
}

function fetchBoth({ witnessHash = BLOCK_HASH, witnessTop = 119, witnessInfoTop = null, witnessPartialAt = null,
  witnessPartialTo = null, witnessBroken = null } = {}) {
  return async (url, init) => {
    const body = JSON.parse(String(init.body || "{}"));
    requests.push({ url, body });
    if (isHost(url, "witness.example") && url.endsWith("/v1/witness/slice")) {
      if (body.height !== undefined || body.txid !== undefined) return { ok: false, status: 400, json: async () => ({}) };
      const from = Number(body.slice) * Number(body.grid);
      const sliceEnd = from + Number(body.grid) - 1;
      const limit = witnessPartialAt !== null && Number(body.slice) === Number(witnessPartialAt)
        ? Number(witnessPartialTo) : Number(witnessTop);
      const to = Math.min(sliceEnd, limit);
      const blocks = Array.from({ length: to - from + 1 }, (_, i) => {
        const height = from + i;
        return {
          height,
          hash: height === 105 ? witnessHash : String(height).padStart(64, "0"),
          txids: height === 105 ? [TXID] : [],
        };
      });
      const complete = to === sliceEnd;
      const tip = complete ? null : { height: witnessBroken === "wrong-tip" ? to - 1 : to, hash: blocks[blocks.length - 1].hash };
      return { ok: true, json: async () => ({ version: 1, network: "stagenet", grid: 20, slice: body.slice,
        from, to, complete: witnessBroken === "claims-complete" ? true : complete, blocks,
        tip: witnessBroken === "claims-complete" ? null : tip }) };
    }
    if (body.method === "get_info") {
      const height = isHost(url, "witness.example") ? Number(witnessInfoTop ?? witnessTop) + 1 : 121;
      return { ok: true, json: async () => ({ result: { height, synchronized: true, status: "OK", nettype: "stagenet" } }) };
    }
    if (body.method === "get_block") {
      return { ok: true, json: async () => ({ result: blockFor(Number(body.params.height)) }) };
    }
    if (typeof body.method === "string") {
      return { ok: true, json: async () => ({ txs: [{ tx_hash: TXID, block_height: 105, confirmations: 16 }],
        txs_as_json: [JSON.stringify(tx)] }) };
    }
    if (Array.isArray(body.txs_hashes)) {
      return { ok: true, json: async () => ({ txs: [{ tx_hash: TXID, block_height: 105, confirmations: 16 }],
        txs_as_json: [JSON.stringify(tx)] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function fetchEmpty() {
  return async (url, init) => {
    const body = JSON.parse(String(init.body || "{}"));
    if (isHost(url, "missing.example")) return { ok: false, status: 404, json: async () => ({}) };
    if (body.method === "get_info") return { ok: true, json: async () => ({ result: { height: 121, synchronized: true } }) };
    if (body.method === "get_block") {
      return { ok: true, json: async () => ({ result: { block_header: { hash: String(body.params.height).padStart(64, "0") }, tx_hashes: [] } }) };
    }
    if (Array.isArray(body.txs_hashes)) return { ok: true, json: async () => ({ txs: [], txs_as_json: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

async function shadow({ fromHeight = 100, ...overrides } = {}) {
  return verifyArrivalShadow({
    nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
    witnessNodes: [{ url: "https://witness.example", operator: "W", protocol: "witness-v1" }],
    address, viewSecret: VIEW, spendPub, expectedAtomic: AMOUNT, minConfirmations: 1,
    fromHeight, fetch: fetchBoth(overrides),
  });
}

console.log("=== 1) THE EXACT AND SLICE READINGS AGREE ===");
{
  requests.length = 0;
  const result = await shadow();
  if (result.exact && result.exact.state === "arrived") ok("the exact path still arrives");
  else bad("exact path: " + JSON.stringify(result.exact || result.exactError, (key, value) => typeof value === "bigint" ? value.toString() : value));
  if (result.witness.state === "seen" && result.witness.txid === TXID && result.witness.height === 105) ok("the slice walk finds the same transaction");
  else bad("slice walk: " + JSON.stringify(result.witness));
  if (result.agrees === true && result.problems.length === 0) ok("the two readings agree");
  else bad("agreement: " + JSON.stringify(result.problems));
  const witnessCalls = requests.filter((entry) => isHost(entry.url, "witness.example"));
  if (!witnessCalls.some((entry) => entry.url.endsWith("/json_rpc") && entry.body.method === "get_block")) ok("the witness never receives a get_block request");
  else bad("a get_block reached the witness");
  const sliceCalls = witnessCalls.filter((entry) => entry.url.endsWith("/v1/witness/slice"));
  if (sliceCalls.length && sliceCalls.every((entry) => Object.keys(entry.body).sort().join(",") === "grid,network,slice,version")) ok("the slice body has no height or txid");
  else bad("slice body: " + JSON.stringify(sliceCalls.map((entry) => entry.body)));
  if (!sliceCalls.some((entry) => entry.body.height === 100 || entry.body.height === 105)) ok("the exact start and payout heights are not on the witness wire");
  else bad("an exact height reached the witness");
}

console.log("=== 2) A DIFFERENT BLOCK HASH IS NAMED ===");
{
  const result = await shadow({ witnessHash: "c".repeat(64) });
  if (result.agrees === false && result.problems.includes("blockHash")) ok("the mismatch is reported as a block hash problem");
  else bad("mismatch: " + JSON.stringify({ agrees: result.agrees, problems: result.problems }));
}

console.log("=== 3) A STANDARD URL IS NOT GUESSED INTO A WITNESS ===");
{
  let refused = null;
  try {
    await verifyArrivalShadow({
      nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
      witnessNodes: [{ url: "https://witness.example", operator: "W" }],
      address, viewSecret: VIEW, spendPub, expectedAtomic: AMOUNT, minConfirmations: 1, fromHeight: 100,
      fetch: fetchBoth(),
    });
  } catch (error) { refused = error; }
  if (refused && refused.code === "bad-input" && refused.params && refused.params.why === "no-witness-v1") ok("a URL without the protocol is refused by name");
  else bad("standard URL: " + JSON.stringify(refused && { code: refused.code, params: refused.params }));
}

console.log("=== 4) ABSENCE NEEDS THE WITNESS WALK, NOT A SILENT SERVER ===");
{
  const result = await verifyArrivalShadow({
    nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
    witnessNodes: [{ url: "https://missing.example", operator: "W", protocol: "witness-v1" }],
    address, viewSecret: VIEW, spendPub, expectedAtomic: AMOUNT, minConfirmations: 1, fromHeight: 100,
    fetch: fetchEmpty(),
  });
  if (result.exact && result.exact.absent === true) ok("the exact path reports absence");
  else bad("exact absence: " + JSON.stringify(result.exact || result.exactError));
  if (result.witness.completed === false && result.witness.failed.length > 0) ok("the empty witness did not complete the slice walk");
  else bad("witness evidence: " + JSON.stringify({ completed: result.witness.completed, failed: result.witness.failed }));
  if (result.agrees === false && result.problems.includes("witness:not-completed")) ok("absence without a witness walk is not agreement");
  else bad("false agreement: " + JSON.stringify({ agrees: result.agrees, problems: result.problems }));
}

console.log("=== 5) A TIP SLICE IS PARTIAL, NOT A REFUSAL ===");
{
  requests.length = 0;
  const result = await shadow({ witnessTop: 115 });
  if (result.witness.state === "seen" && result.witness.completed === true) ok("the witness walk completes on a partial tip slice");
  else bad("partial witness walk: " + JSON.stringify({ state: result.witness.state, completed: result.witness.completed, failed: result.witness.failed }));
  if (result.agrees === true && result.problems.length === 0) ok("the partial tip agrees with the exact reading");
  else bad("partial tip agreement: " + JSON.stringify(result.problems));
  const slices = requests.filter((entry) => isHost(entry.url, "witness.example") && entry.url.endsWith("/v1/witness/slice"));
  if (slices.length === 1 && slices[0].body.slice === 5) ok("the last request is still one fixed slice");
  else bad("partial slice requests: " + JSON.stringify(slices.map((entry) => entry.body)));
}

console.log("=== 6) A BROKEN PARTIAL SLICE IS NOT AN ANSWER ===");
{
  const result = await shadow({ witnessTop: 115, witnessBroken: "claims-complete" });
  if (result.witness.state !== "seen" && result.witness.failed.length > 0) ok("a partial slice that claims to be complete is refused");
  else bad("broken partial: " + JSON.stringify({ state: result.witness.state, failed: result.witness.failed }));

  const wrongTip = await shadow({ witnessTop: 115, witnessBroken: "wrong-tip" });
  if (wrongTip.witness.state !== "seen" && wrongTip.witness.failed.length > 0) ok("a partial slice whose tip does not match the walk is refused");
  else bad("wrong tip: " + JSON.stringify({ state: wrongTip.witness.state, failed: wrongTip.witness.failed }));
}

console.log("=== 7) THE WALK GUARDS ARE LOAD-BEARING ===");
{
  const nonTip = await shadow({ witnessTop: 139, witnessPartialAt: 5, witnessPartialTo: 115 });
  if (nonTip.witness.state !== "seen" && nonTip.witness.completed === false && nonTip.witness.failed.length > 0) {
    ok("a partial slice before the tip slice is refused");
  } else bad("non-tip partial: " + JSON.stringify({ state: nonTip.witness.state, completed: nonTip.witness.completed, failed: nonTip.witness.failed }));

  const wrongTop = await shadow({ witnessTop: 115, witnessInfoTop: 116 });
  if (wrongTop.witness.state !== "seen" && wrongTop.witness.completed === false && wrongTop.witness.failed.length > 0) {
    ok("a partial tip that does not match the caller's top is refused");
  } else bad("tip height: " + JSON.stringify({ state: wrongTop.witness.state, completed: wrongTop.witness.completed, failed: wrongTop.witness.failed }));

  const empty = await shadow({ fromHeight: 200, witnessTop: 115 });
  if (empty.witness.completed === false) ok("an empty slice range is not a completed walk");
  else bad("empty range: " + JSON.stringify({ completed: empty.witness.completed }));
}

console.log("=== 8) A BLOCK THAT ARRIVES DURING THE WALK IS NOT A FAILURE ===");
{
  const raced = await shadow({ witnessTop: 116, witnessInfoTop: 115 });
  if (raced.witness.state === "seen" && raced.witness.completed === true && raced.agrees === true) {
    ok("a tip one block above the caller's top is accepted");
  } else bad("tip race: " + JSON.stringify({ state: raced.witness.state, completed: raced.witness.completed, failed: raced.witness.failed, agrees: raced.agrees, problems: raced.problems }));
}

if (problems.length) {
  console.log("FAILED: " + problems.length + " problem(s) (passed " + pass + ")");
  process.exit(1);
}
console.log("arrival shadow: " + pass + " checks passed");
