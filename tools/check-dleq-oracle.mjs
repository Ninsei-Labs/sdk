#!/usr/bin/env node
// TWO INDEPENDENT DLEQ ORACLES AGAINST THE SAME VECTORS.
//
// The Go oracle generates v2 proofs (bit proof + Schnorr knowledge proofs). The SDK verifier and the Rust
// verifier both check them; the SDK prover is then checked by the Go and Rust verifiers. This is not a
// generated-and-self-checked fixture: the two implementations do not share code.
//
//   DLEQ_GO_BIN       path to the built Go oracle (default test/dleq-oracle/go/oracle[.exe])
//   DLEQ_RUST_BIN     path to the built Rust verifier
//   DLEQ_REQUIRE_RUST set to 1 in CI: a missing Rust binary is a FAILURE, not a skipped half
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDleq2 } from "../engine/atomic/dleq2.js";
import { primitives } from "../src/primitives.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const GO = process.env.DLEQ_GO_BIN || join(ROOT, "test", "dleq-oracle", "go", isWindows ? "oracle.exe" : "oracle");
const RUST = process.env.DLEQ_RUST_BIN || null;
const REQUIRE_RUST = process.env.DLEQ_REQUIRE_RUST === "1";
const FIXTURES = join(ROOT, "tools", "fixtures", "dleq-vectors");
const dleq = createDleq2(primitives);
const temp = mkdtempSync(join(tmpdir(), "sdk-dleq-oracle-"));

const problems = [];
const notes = [];
if (REQUIRE_RUST && !RUST) problems.push("DLEQ_REQUIRE_RUST=1 but DLEQ_RUST_BIN is unset");
let checks = 0;
const check = (condition, message) => {
  checks++;
  if (!condition) problems.push(message);
};
const run = (bin, args) => {
  try { return { ok: true, out: execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { return { ok: false, out: String((error && (error.stdout || error.stderr)) || error) }; }
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const verifySdk = (proof, context) => dleq.verify(clone(proof), context);
const verifyGo = (file, signatures = false) =>
  run(GO, ["verify", "--file", file, "--bits", "253", "--strict-torsion", ...(signatures ? [] : ["--no-sigs"])]);
const verifyRust = (file) => (RUST ? run(RUST, ["verify", "--file", file]) : null);

// A fixed corpus: the witness, context and DRBG seed are the inputs; proofs are regenerated every run.
const CASES = [
  ["x1", "1", "ninsei-order-v3|go|01", "00".repeat(32)],
  ["x2", "2", "ninsei-order-v3|go|02", "11".repeat(32)],
  ["x2-252", (1n << 252n).toString(16), "ninsei-order-v3|go|05", "44".repeat(32)],
  ["utf8", "deadbeef", "ninsei-order-v3|ctx-ü-テスト|06", "55".repeat(32)],
  ["empty", "abcdef", "", "66".repeat(32)],
];

const assertVerdict = (label, file, proof, context, expected) => {
  const sdk = verifySdk(proof, context);
  check(sdk.ok === expected, `${label}: SDK expected ${expected}, got ${sdk.ok}`);
  const go = verifyGo(file);
  check(go.ok === expected, `${label}: Go expected ${expected}, got ${go.ok}: ${go.out.trim()}`);
  if (RUST) {
    const rust = verifyRust(file);
    check(rust.ok === expected, `${label}: Rust expected ${expected}, got ${rust.ok}: ${rust.out.trim()}`);
  }
};

try {
  for (const [name, x, context, seed] of CASES) {
    const goFile = join(temp, name + "-go.json");
    const gen = run(GO, ["prove", "--x", x, "--context", context, "--bits", "253", "--no-sigs", "--seed", seed, "--out", goFile]);
    if (!gen.ok) { problems.push(`${name}: Go prove failed: ${gen.out.trim()}`); continue; }
    const goVector = JSON.parse(readFileSync(goFile, "utf8"));
    check(goVector.proof && goVector.proof.pokA && goVector.proof.pokB, `${name}: Go vector has no knowledge proofs`);

    // Go prover -> SDK and Rust verifiers. Go verifying its own bytes is only a serialization test.
    assertVerdict(`${name}: Go proof`, goFile, goVector.proof, context, true);
    check(verifyGo(goFile).ok, `${name}: Go refused its own proof`);

    // SDK prover -> Go and Rust verifiers.
    const sdkProof = dleq.prove(BigInt("0x" + x), context);
    const sdkFile = join(temp, name + "-sdk.json");
    writeFileSync(sdkFile, JSON.stringify({ schema: "ninsei-dleq-vector/2", context, proof: sdkProof }));
    const sdkToGo = verifyGo(sdkFile);
    check(sdkToGo.ok, `${name}: Go refused the SDK proof: ${sdkToGo.out.trim()}`);
    if (RUST) {
      const sdkToRust = verifyRust(sdkFile);
      check(sdkToRust.ok, `${name}: Rust refused the SDK proof: ${sdkToRust.out.trim()}`);
    }

    // Negative one: a valid proof under a different transcript context.
    const wrongContext = context + "|wrong-context";
    const wrongContextFile = join(temp, name + "-wrong-context.json");
    const wrongContextVector = clone(goVector);
    wrongContextVector.context = wrongContext;
    writeFileSync(wrongContextFile, JSON.stringify(wrongContextVector));
    assertVerdict(`${name}: wrong context`, wrongContextFile, goVector.proof, wrongContext, false);

    // Negative two: a valid secp256k1 point that is not the claimed public key.
    const wrongPointFile = join(temp, name + "-wrong-point.json");
    const wrongPointVector = clone(goVector);
    wrongPointVector.proof.XA = wrongPointVector.proof.pokA.R;
    writeFileSync(wrongPointFile, JSON.stringify(wrongPointVector));
    assertVerdict(`${name}: wrong point`, wrongPointFile, wrongPointVector.proof, context, false);

    // Negative three: a low-order ed25519 point. The SDK and Rust reject it with the strict subgroup
    // check; the Go verifier is run with --strict-torsion and must not accept it either.
    const torsionFile = join(temp, name + "-torsion.json");
    const torsionVector = clone(goVector);
    torsionVector.proof.XB = "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";
    writeFileSync(torsionFile, JSON.stringify(torsionVector));
    assertVerdict(`${name}: torsion point`, torsionFile, torsionVector.proof, context, false);

    // Negative four: the public keys of a different witness under the same transcript.
    const nextX = (BigInt("0x" + x) + 1n).toString(16);
    const otherFile = join(temp, name + "-other.json");
    const otherGen = run(GO, ["prove", "--x", nextX, "--context", context, "--bits", "253", "--no-sigs", "--seed", seed, "--out", otherFile]);
    if (!otherGen.ok) {
      problems.push(`${name}: Go alternate-witness prove failed: ${otherGen.out.trim()}`);
    } else {
      const other = JSON.parse(readFileSync(otherFile, "utf8"));
      const wrongWitnessFile = join(temp, name + "-wrong-witness.json");
      const wrongWitnessVector = clone(goVector);
      wrongWitnessVector.proof.XA = other.proof.XA;
      wrongWitnessVector.proof.XB = other.proof.XB;
      writeFileSync(wrongWitnessFile, JSON.stringify(wrongWitnessVector));
      assertVerdict(`${name}: wrong witness`, wrongWitnessFile, wrongWitnessVector.proof, context, false);
    }

    // Negative five: a corrupted Schnorr knowledge proof.
    const badFile = join(temp, name + "-bad-pok.json");
    const bad = clone(goVector);
    bad.proof.pokA.s = (bad.proof.pokA.s[0] === "0" ? "1" : "0") + bad.proof.pokA.s.slice(1);
    writeFileSync(badFile, JSON.stringify(bad));
    assertVerdict(`${name}: corrupted pokA`, badFile, bad.proof, context, false);
  }

  // The committed JS fixtures are the historical contract: the SDK, Go and Rust must agree on every one,
  // including the pure-multiple refusal. This is a separate direction from the fresh SDK proof above.
  for (const name of readdirSync(FIXTURES).filter((file) => file.endsWith(".json")).sort()) {
    const file = join(FIXTURES, name);
    const vector = JSON.parse(readFileSync(file, "utf8"));
    const expected = vector.expect && vector.expect.verify === true;
    const sdk = verifySdk(vector.proof, vector.context);
    check(sdk.ok === expected, `fixture ${name}: SDK expected ${expected}, got ${sdk.ok}`);
    const go = verifyGo(file, Boolean(vector.signatures));
    check(go.ok === expected, `fixture ${name}: Go expected ${expected}, got ${go.ok}: ${go.out.trim()}`);
    if (RUST) {
      const rust = verifyRust(file);
      check(rust.ok === expected, `fixture ${name}: Rust expected ${expected}, got ${rust.ok}: ${rust.out.trim()}`);
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

notes.push("Go generates v2 vectors; SDK and Rust verify them");
notes.push("SDK proofs are verified by Go and Rust");
notes.push("wrong context, wrong point and wrong witness are refused by every verifier");
notes.push("committed JS fixtures are checked by the SDK, Go and Rust");
notes.push(RUST ? "corrupted knowledge proof refused by all three verifiers" : "Rust verifier skipped (DLEQ_RUST_BIN is unset)");
for (const n of notes) console.log("  note: " + n);
if (problems.length) {
  for (const p of problems) console.log("  FAIL  " + p);
  console.log("dleq oracle: FAILED (" + problems.length + ")");
  process.exit(1);
}
console.log("dleq oracle: " + checks + " checks passed");
