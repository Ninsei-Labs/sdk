// Generate the pinned DLEQ vectors the SDK check verifies.
//
//   node tools/gen-dleq-vectors.mjs
//
// The DRBG is deterministic (SHA3-512 counter mode), so regenerating the file must produce the same proof. The
// vectors carry `ninsei-dleq-vector/2`, add the two knowledge proofs, and include one pure-multiple proof: its bit
// proof is valid under the old statement, while the knowledge proof refuses it. That pair is the regression
// vector for the gap closed in D3.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256, sha3_512 } from "@noble/hashes/sha3.js";
import { createDleq2 } from "../engine/atomic/dleq2.js";
import { primitives } from "../src/primitives.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = join(ROOT, "tools", "fixtures", "dleq-vectors");

const bigToHex = (v) => BigInt(v).toString(16).padStart(64, "0");
const bytesToBig = (bytes) => { let v = 0n; for (const b of bytes) v = (v << 8n) | BigInt(b); return v; };
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const u32be = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function drbg(seedHex) {
  let state = new Uint8Array(32);
  state.set(Buffer.from(seedHex, "hex").subarray(0, 32));
  return {
    bytes(n) {
      const out = new Uint8Array(n);
      let offset = 0, counter = 0;
      while (offset < n) {
        const block = keccak_256(concat(state, u32be(counter)));
        const take = Math.min(32, n - offset);
        out.set(block.slice(0, take), offset);
        state = keccak_256(concat(state, block));
        offset += take;
        counter += 1;
      }
      return out;
    },
  };
}

const fresh = (seedHex) => {
  const rng = drbg(seedHex);
  return createDleq2({ ...primitives, randomBytes: (n) => rng.bytes(n) });
};

function write(name, vector) {
  writeFileSync(join(OUT, name + ".json"), JSON.stringify(vector, null, 2) + "\n");
  console.log("wrote " + name + ".json");
}

function positive(name, x, context, seed, note) {
  const dleq = fresh(seed);
  const proof = dleq.prove(x, context);
  const verdict = dleq.verify(proof, context);
  if (!verdict.ok) throw new Error(name + " does not verify: " + verdict.reason);
  write(name, {
    schema: "ninsei-dleq-vector/2",
    generatedBy: "js",
    compat: { bits: dleq.BITS, context: true, secpHashLE: true, signatures: true, strictTorsion: true, knowledge: true },
    x: bigToHex(x),
    context,
    proof,
    expect: { verify: true },
    note,
  });
}

function pureMultiple(name, context, seed, note) {
  const x = 1n;
  const dleq = fresh(seed);
  const prepared = dleq.prepareProof(x, context);
  const rhoA = 0x1234567890abcdefn;
  const rhoB = 0x0fedcba987654321n;
  const addGalt = (curve, pointHex, rho) => curve.P.fromHex(String(pointHex).replace(/^0x/i, "")).add(curve.Galt.multiply(rho)).toHex();
  prepared.XA = addGalt(dleq.curves.A, prepared.XA, rhoA);
  prepared.XB = addGalt(dleq.curves.B, prepared.XB, rhoB);
  const part = prepared.bits[0];
  part.cA = addGalt(dleq.curves.A, part.cA, rhoA);
  part.cB = addGalt(dleq.curves.B, part.cB, rhoB);
  part.rA = bigToHex((BigInt("0x" + part.rA) + rhoA) % dleq.curves.A.order);
  part.rB = bigToHex((BigInt("0x" + part.rB) + rhoB) % dleq.curves.B.order);
  const proof = dleq.assembleProof(prepared, prepared.bits.map((bit) => dleq.proveBit(bit, context)));
  const old = dleq.verify(proof, context, { requireKnowledge: false });
  const current = dleq.verify(proof, context);
  if (!old.ok) throw new Error(name + ": the old statement no longer accepts the pure-multiple proof: " + old.reason);
  if (current.ok) throw new Error(name + ": the knowledge proofs did not refuse the pure-multiple proof");
  write(name, {
    schema: "ninsei-dleq-vector/2",
    generatedBy: "js",
    compat: { bits: dleq.BITS, context: true, secpHashLE: true, signatures: true, strictTorsion: true, knowledge: true },
    x: bigToHex(x),
    context,
    proof,
    expect: { verify: false, reason: "knowledge", withoutKnowledge: true },
    note,
  });
}

mkdirSync(OUT, { recursive: true });
positive("kat-01-pok", 1n, "ninsei-order-v3|kat|01", "00".repeat(32), "smallest witness, both knowledge proofs");
positive("kat-05-pok-2^252", 1n << 252n, "ninsei-order-v3|kat|05", "44".repeat(32), "boundary accepted by 253 bits and refused by the reference's 252");
positive("kat-06-pok-utf8", 0xdeadbeefn, "ninsei-order-v3|ctx-ü-テスト|06", "55".repeat(32), "UTF-8 context above 0x7F");
positive("kat-07-pok-empty", 0xabcdefn, "", "66".repeat(32), "empty context");
pureMultiple("neg-pure-multiple", "ninsei-order-v3|kat|01", "00".repeat(32), "same bit proof, X shifted by rho*H; knowledge proofs refuse it");
