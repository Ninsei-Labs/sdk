// Pinned DLEQ vectors plus the edge cases the review named.
//
// The vectors are data, not a second implementation: `tools/gen-dleq-vectors.mjs` writes them from the module
// under test, and this check only consumes them. The pure-multiple vector is the important one: its bit proof
// passes the old statement, and the knowledge proofs refuse it. That is the D3 regression.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createDleq2 } from "../engine/atomic/dleq2.js";
import { primitives } from "../src/primitives.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "tools", "fixtures", "dleq-vectors");
const hex = (bytes) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const clone = (value) => JSON.parse(JSON.stringify(value));
const read = (name) => JSON.parse(readFileSync(join(DIR, name + ".json"), "utf8"));

export const dleqVectorsCheck = async () => {
const dleq = createDleq2(primitives);
const problems = [];
const fail = (name, reason) => problems.push(name + ": " + reason);

const POSITIVE = ["kat-01-pok", "kat-05-pok-2^252", "kat-06-pok-utf8", "kat-07-pok-empty"];
for (const name of POSITIVE) {
  const vector = read(name);
  const verdict = dleq.verify(vector.proof, vector.context);
  if (!verdict.ok) fail(name, "did not verify: " + verdict.reason);
  if (!vector.proof.pokA || !vector.proof.pokB) fail(name, "the vector carries no knowledge proofs");
  if (vector.proof.proofs.length !== dleq.BITS) fail(name, "wrong part count: " + vector.proof.proofs.length);
}
if (dleq.BITS !== 253) problems.push("BITS is " + dleq.BITS + ", the review pinned 253");
const boundary = read("kat-05-pok-2^252");
if (BigInt("0x" + boundary.x) !== (1n << 252n)) problems.push("kat-05 does not carry x = 2^252");

// D3: the old statement accepts a point with a rho*H component; the knowledge proofs refuse it.
{
  const vector = read("neg-pure-multiple");
  const current = dleq.verify(vector.proof, vector.context);
  const old = dleq.verify(vector.proof, vector.context, { requireKnowledge: false });
  if (current.ok) fail("neg-pure-multiple", "the knowledge proofs accepted a pure-multiple proof");
  if (!current.reason || !/knowledge/.test(current.reason)) fail("neg-pure-multiple", "refusal does not name the knowledge proof: " + current.reason);
  if (!old.ok) fail("neg-pure-multiple", "the old statement no longer accepts its own proof: " + old.reason);
}

// D3: a proof with the field missing or changed is refused before the 253 parts are read.
{
  const base = read("kat-01-pok");
  const missing = clone(base.proof);
  delete missing.pokA;
  if (dleq.verify(missing, base.context).ok) fail("missing-pokA", "a proof without pokA was accepted");
  const changed = clone(base.proof);
  changed.pokA.s = (changed.pokA.s[0] === "0" ? "1" : "0") + changed.pokA.s.slice(1);
  if (dleq.verify(changed, base.context).ok) fail("changed-pokA", "a proof with a changed pokA was accepted");
  if (dleq.verify(base.proof, base.context + "|wrong").ok) fail("wrong-context", "a proof verified under another context");
}

// THE SECOND CURVE'S KNOWLEDGE PROOF IS ITS OWN GUARD. The pure-multiple vector refuses at pokA first, so a
// deletion of the pokB check alone would stay green without these cases.
{
  const base = read("kat-01-pok");
  const other = read("kat-06-pok-utf8");
  const noB = clone(base.proof);
  delete noB.pokB;
  if (dleq.verify(noB, base.context).ok) fail("missing-pokB", "a proof without pokB was accepted");
  const changedB = clone(base.proof);
  changedB.pokB.s = (changedB.pokB.s[0] === "0" ? "1" : "0") + changedB.pokB.s.slice(1);
  if (dleq.verify(changedB, base.context).ok) fail("changed-pokB", "a proof with a changed pokB was accepted");
  const swapped = clone(base.proof);
  [swapped.pokA, swapped.pokB] = [swapped.pokB, swapped.pokA];
  if (dleq.verify(swapped, base.context).ok) fail("swapped-pokB", "a proof with the two knowledge proofs swapped was accepted");
  const foreign = clone(base.proof);
  foreign.pokB = clone(other.proof.pokB);
  if (dleq.verify(foreign, base.context).ok) fail("foreign-pokB", "a proof with another vector's pokB was accepted");
}

// N1: the point paths accept 0X as well as 0x, and canonicalise the result.
{
  const base = read("kat-01-pok");
  const upper = clone(base.proof);
  upper.XA = "0X" + upper.XA.replace(/^0x/i, "");
  upper.XB = "0X" + upper.XB.replace(/^0x/i, "");
  upper.pokA.R = "0X" + upper.pokA.R.replace(/^0x/i, "");
  upper.pokB.R = "0X" + upper.pokB.R.replace(/^0x/i, "");
  upper.pokA.s = "0X" + upper.pokA.s;
  for (const part of upper.proofs) { part.cA = "0X" + part.cA.replace(/^0x/i, ""); part.cB = "0X" + part.cB.replace(/^0x/i, ""); }
  const verdict = dleq.verify(upper, base.context);
  if (!verdict.ok) fail("uppercase-prefix", "0X and uppercase point prefixes were refused: " + verdict.reason);
}

// N2: unknown top-level and sig fields do not change the verdict.
{
  const base = read("kat-01-pok");
  const extra = clone(base.proof);
  extra.extra = "ignored";
  extra.proofs[0].sig.extra = "ignored";
  const verdict = dleq.verify(extra, base.context);
  if (!verdict.ok) fail("extra-fields", "an unknown field changed the verdict: " + verdict.reason);
}

// N3: uncompressed secp256k1 encodings are accepted and canonicalised by the challenge.
{
  const base = read("kat-01-pok");
  const uncompressed = clone(base.proof);
  uncompressed.XA = hex(secp256k1.Point.fromHex(base.proof.XA).toBytes(false));
  for (const part of uncompressed.proofs) part.cA = hex(secp256k1.Point.fromHex(part.cA).toBytes(false));
  const verdict = dleq.verify(uncompressed, base.context);
  if (!verdict.ok) fail("uncompressed", "an uncompressed secp256k1 encoding was refused: " + verdict.reason);
}

// N4: a scalar above the order is reduced, not treated as a new proof.
{
  const base = read("kat-01-pok");
  const reduced = clone(base.proof);
  reduced.proofs[0].sig.a1 = (BigInt("0x" + base.proof.proofs[0].sig.a1) + secp256k1.Point.Fn.ORDER).toString(16).padStart(64, "0");
  const verdict = dleq.verify(reduced, base.context);
  if (!verdict.ok) fail("scalar-ge-order", "adding the group order to a1 changed the verdict: " + verdict.reason);
}

// D5 and malformed input: a refusal, never an exception.
{
  const base = read("kat-01-pok");
  const torsion = clone(base.proof);
  torsion.XB = "0100000000000000000000000000000000000000000000000000000000000000";
  if (dleq.verify(torsion, base.context).ok) fail("torsion", "an order-2 XB was accepted");
  // THE IDENTITY IS A FORBIDDEN SUBJECT, NOT A ZERO INTERMEDIATE. A manufactured proof of the identity would let a
  // side omit its half from the joint spend point.
  for (const [name, identity] of [
    ["identity-B", (() => { const p = clone(base.proof); p.XB = primitives.ed25519.Point.ZERO.toHex(); return p; })()],
  ]) {
    const verdict = dleq.verify(identity, base.context);
    if (verdict.ok) fail(name, "the identity subject was accepted");
    else if (!/identity/.test(verdict.reason)) fail(name, "refusal does not name the identity: " + verdict.reason);
  }
  // The secp256k1 point at infinity has no valid compressed/uncompressed encoding in @noble, so an XA identity is
  // refused by the parser rather than reaching an identity branch. Pin that refusal instead of inventing an encoding.
  {
    const identityA = clone(base.proof);
    identityA.XA = "00";
    const verdict = dleq.verify(identityA, base.context);
    if (verdict.ok) fail("identity-A", "an unparsable XA identity was accepted");
    else if (!/unparsable/.test(verdict.reason)) fail("identity-A", "refusal is not the parser's: " + verdict.reason);
  }
  for (const [name, value] of [["null", null], ["empty", {}], ["short", { ...clone(base.proof), proofs: base.proof.proofs.slice(1) }]]) {
    try { if (dleq.verify(value, base.context).ok) fail("malformed-" + name, "accepted"); }
    catch (error) { fail("malformed-" + name, "threw: " + error.message); }
  }
}

// BREAKING RUN. Remove the knowledge check from a copy and require the pure-multiple vector to pass the old
// statement under the copy. A guard that cannot be shown red is not evidence that the check runs.
{
  const source = readFileSync(join(ROOT, "engine", "atomic", "dleq2.js"), "utf8");
  const anchor = "if (requireKnowledge) {";
  if (!source.includes(anchor)) {
    fail("breaking-run", "the knowledge-check anchor is missing; the mutation cannot be attempted");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "sdk-dleq-"));
    const copy = join(dir, "dleq2.mjs");
    try {
      writeFileSync(copy, source.replace(anchor, "if (false) {"));
      const broken = await import(pathToFileURL(copy).href + "?breaking=" + Date.now());
      const verdict = broken.createDleq2(primitives).verify(read("neg-pure-multiple").proof, "ninsei-order-v3|kat|01");
      if (!verdict.ok) fail("breaking-run", "without the knowledge check the pure-multiple proof was still refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// BREAKING RUN, POKB ONLY. Removing the ed25519 knowledge check from a copy must let the changed-pokB proof through;
// otherwise these cases prove the pokA guard, not the one under test.
{
  const source = readFileSync(join(ROOT, "engine", "atomic", "dleq2.js"), "utf8");
  const anchor = "if (!verifyKnowledge(curves.B, XB, proof.pokB, context, \"B\")) return { ok: false, reason: \"proof: the ed25519 knowledge proof did not verify\" };";
  if (!source.includes(anchor)) {
    fail("breaking-run-pokB", "the pokB anchor is missing; the mutation cannot be attempted");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "sdk-dleq-pokb-"));
    const copy = join(dir, "dleq2.mjs");
    try {
      writeFileSync(copy, source.replace(anchor, anchor.replace("if (!verifyKnowledge", "if (false && !verifyKnowledge")));
      const broken = await import(pathToFileURL(copy).href + "?pokb=" + Date.now());
      const base = read("kat-01-pok");
      const changedB = clone(base.proof);
      changedB.pokB.s = (changedB.pokB.s[0] === "0" ? "1" : "0") + changedB.pokB.s.slice(1);
      const verdict = broken.createDleq2(primitives).verify(changedB, base.context);
      if (!verdict.ok) fail("breaking-run-pokB", "without the pokB check the changed proof was still refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

return {
  note: "pinned vectors, D3 pure-multiple regression, N1-N4 and refusal edges",
  problems,
  notes: ["4 positive vectors and 1 pure-multiple vector", "253 bits", "knowledge proofs checked before the bit loop"],
};
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await dleqVectorsCheck();
  if (result.problems.length) {
    console.error("FAIL dleq-vectors");
    for (const problem of result.problems) console.error("  " + problem);
    process.exitCode = 1;
  } else {
    console.log("ok dleq-vectors - " + result.note);
    for (const note of result.notes) console.log("  note: " + note);
  }
}
