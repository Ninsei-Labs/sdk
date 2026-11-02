#!/usr/bin/env node
// TWO INDEPENDENT DLEQ ORACLES AGAINST THE SAME VECTORS.
//
// The Go oracle generates v2 proofs (bit proof + Schnorr knowledge proofs). The SDK verifier and the Rust
// verifier both check them; the SDK prover is then checked by the Go and Rust verifiers. This is not a
// generated-and-self-checked fixture: the two implementations do not share code.
//
//   DLEQ_GO_BIN   path to the built Go oracle (default test/dleq-oracle/go/oracle[.exe])
//   DLEQ_RUST_BIN path to the built Rust verifier (optional; when absent that half is reported as skipped)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDleq2 } from "../engine/atomic/dleq2.js";
import { primitives } from "../src/primitives.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const GO = process.env.DLEQ_GO_BIN || join(ROOT, "test", "dleq-oracle", "go", isWindows ? "oracle.exe" : "oracle");
const RUST = process.env.DLEQ_RUST_BIN || null;
const dleq = createDleq2(primitives);
const temp = mkdtempSync(join(tmpdir(), "sdk-dleq-oracle-"));

const problems = [];
const notes = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const run = (bin, args) => {
  try { return { ok: true, out: execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { return { ok: false, out: String((error && (error.stdout || error.stderr)) || error) }; }
};

// A fixed corpus: the witness, context and DRBG seed are the inputs; proofs are regenerated every run.
const CASES = [
  ["x1", "1", "ninsei-order-v3|go|01", "00".repeat(32)],
  ["x2", "2", "ninsei-order-v3|go|02", "11".repeat(32)],
  ["x2-252", (1n << 252n).toString(16), "ninsei-order-v3|go|05", "44".repeat(32)],
  ["utf8", "deadbeef", "ninsei-order-v3|ctx-ü-テスト|06", "55".repeat(32)],
  ["empty", "abcdef", "", "66".repeat(32)],
];

try {
  for (const [name, x, context, seed] of CASES) {
    const goFile = join(temp, name + "-go.json");
    const gen = run(GO, ["prove", "--x", x, "--context", context, "--bits", "253", "--no-sigs", "--seed", seed, "--out", goFile]);
    if (!gen.ok) { problems.push(`${name}: Go prove failed: ${gen.out.trim()}`); continue; }
    const goVector = JSON.parse(readFileSync(goFile, "utf8"));
    check(goVector.proof && goVector.proof.pokA && goVector.proof.pokB, `${name}: Go vector has no knowledge proofs`);

    const sdkVerdict = dleq.verify(goVector.proof, context);
    check(sdkVerdict.ok, `${name}: SDK refused the Go proof: ${sdkVerdict.reason}`);

    const goVerify = run(GO, ["verify", "--file", goFile, "--bits", "253", "--no-sigs"]);
    check(goVerify.ok, `${name}: Go refused its own proof: ${goVerify.out.trim()}`);

    // Direction two: the SDK prover -> Go verifier.
    const sdkProof = dleq.prove(BigInt("0x" + x), context);
    const sdkFile = join(temp, name + "-sdk.json");
    writeFileSync(sdkFile, JSON.stringify({ schema: "ninsei-dleq-vector/2", context, proof: sdkProof }));
    const sdkToGo = run(GO, ["verify", "--file", sdkFile, "--bits", "253", "--no-sigs"]);
    check(sdkToGo.ok, `${name}: Go refused the SDK proof: ${sdkToGo.out.trim()}`);

    // Direction three: corrupted POK must be refused by every verifier.
    const bad = JSON.parse(JSON.stringify(goVector));
    bad.proof.pokA.s = (bad.proof.pokA.s[0] === "0" ? "1" : "0") + bad.proof.pokA.s.slice(1);
    const badFile = join(temp, name + "-bad.json");
    writeFileSync(badFile, JSON.stringify(bad));
    check(!dleq.verify(bad.proof, context).ok, `${name}: SDK accepted a corrupted pokA`);
    check(!run(GO, ["verify", "--file", badFile, "--bits", "253", "--no-sigs"]).ok, `${name}: Go accepted a corrupted pokA`);

    if (RUST) {
      const rustGo = run(RUST, ["verify", "--file", goFile]);
      check(rustGo.ok, `${name}: Rust refused the Go proof: ${rustGo.out.trim()}`);
      const rustSdk = run(RUST, ["verify", "--file", sdkFile]);
      check(rustSdk.ok, `${name}: Rust refused the SDK proof: ${rustSdk.out.trim()}`);
      check(!run(RUST, ["verify", "--file", badFile]).ok, `${name}: Rust accepted a corrupted pokA`);
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

notes.push("Go generates v2 vectors; SDK and Rust verify them");
notes.push("SDK proofs are verified by Go and Rust");
notes.push(RUST ? "corrupted knowledge proof refused by all three verifiers" : "Rust verifier skipped (DLEQ_RUST_BIN is unset)");
for (const n of notes) console.log("  note: " + n);
if (problems.length) {
  for (const p of problems) console.log("  FAIL  " + p);
  console.log("dleq oracle: FAILED (" + problems.length + ")");
  process.exit(1);
}
console.log("dleq oracle: " + (CASES.length * (RUST ? 7 : 5)) + " checks passed");
