#!/usr/bin/env node
// THE WORKER'S VERDICT IS BOUND TO THE COMMITMENT. The worker runs the prebuilt atomic bundle; its verifySide checks
// the DLEQ equation and the ed25519 point, but not that the proven secp256k1 point matches the quote's
// commitHalfClaimer. Without that comparison a caller can prove one point and fund another. This check drives the
// real worker with a valid proof, a wrong commitment and a missing commitment, then mutates a copy to remove the
// comparison and requires the same input to be accepted.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOrderBuilder, ed25519, secp256k1, keccak256, sha3_512, randomBytes } from "../assets/vendors/atomic/atomic-browser.js";
import { fundOrder } from "../engine/evm/funding.js";

const ROOT = new URL("../", import.meta.url);
const WORKER = new URL("../engine/atomic/order-worker.js", import.meta.url);
const BUNDLE = new URL("../assets/vendors/atomic/atomic-browser.js", import.meta.url).href;
const context = "worker-binding-check";
const builder = createOrderBuilder({ ed25519, secp256k1, keccak256, sha3_512, randomBytes });
const half = 5n;
const pub = builder.halves.publicHalves(half);
const proof = builder.dleq.prove(half, context);
const good = { proof, edPub: pub.ed, commitHalfClaimer: builder.halfCommitment(half) };
const wrong = { ...good, commitHalfClaimer: "0x" + "00".repeat(20) };
const missing = { ...good, commitHalfClaimer: null };

const problems = [];
const check = (c, m) => { if (!c) problems.push(m); else console.log("  ok    " + m); };
let reply = null;
globalThis.self = { onmessage: null, postMessage: (message) => { reply = message; } };

async function verify(workerUrl, counterparty) {
  reply = null;
  await import(workerUrl);
  self.onmessage({ data: { id: 1, type: "verify", orderContext: context, counterparty } });
  return reply && reply.result ? reply.result : null;
}

try {
  const real = await verify(WORKER.href + "?real=" + Date.now(), good);
  check(real && real.ok === true, "a valid proof with the matching commitment is accepted: " + JSON.stringify(real));
  const badCommit = await verify(WORKER.href + "?bad=" + Date.now(), wrong);
  check(badCommit && badCommit.ok === false && /commitHalfClaimer/.test(badCommit.reason), "a foreign commitment is refused");
  const noCommit = await verify(WORKER.href + "?none=" + Date.now(), missing);
  check(noCommit && noCommit.ok === false && /no commitHalfClaimer/.test(noCommit.reason), "a missing commitment is refused");

  // THE MONEY BOUNDARY REPEATS THE COMPARISON. A caller can reach fundOrder with a quote whose claimer fields
  // differ from the terms; it must be refused before predict or send, not after the escrow is created.
  const hex = (n) => "0x" + n.repeat(64);
  try {
    await fundOrder({
      factory: "0x" + "1".repeat(40), locker: "0x" + "2".repeat(40), claimer: "0x" + "3".repeat(40),
      commitHalfLocker: hex("a"), commitHalfClaimer: hex("b"), edPointLocker: hex("c"), edPointClaimer: hex("d"),
      edViewPointLocker: hex("e"), salt: "0x" + "f".repeat(64), amountWei: 1n, amountLabel: "1 wei",
      readyBy: Math.floor(Date.now() / 1000) + 3600, t1: Math.floor(Date.now() / 1000) + 7200,
      quote: { locker: "0x" + "2".repeat(40), claimer: "0x" + "3".repeat(40), amount: "1",
        readyBy: String(Math.floor(Date.now() / 1000) + 3600), t1: String(Math.floor(Date.now() / 1000) + 7200),
        salt: "0x" + "f".repeat(64), commitHalfClaimer: hex("9"), edPointClaimer: hex("d") },
      call: async () => { throw new Error("the chain must not be read for a mismatched quote"); },
    });
    check(false, "a quote with another claimer commitment reached the chain");
  } catch (e) {
    check(/commitHalfClaimer/.test(String(e && e.message)), "a quote with another claimer commitment is refused by the funding boundary");
  }

  // BREAKING RUN: remove only the point-to-commitment comparison in a copy and require the wrong input to pass.
  const dir = mkdtempSync(join(tmpdir(), "rfq-sdk-worker-"));
  try {
    let text = readFileSync(WORKER, "utf8").replaceAll('"../../assets/vendors/atomic/atomic-browser.js"', JSON.stringify(BUNDLE));
    const needle = 'if (!proven || low160(proven) !== low160(counterparty.commitHalfClaimer)) {';
    check(text.includes(needle), "the worker no longer carries the commitment comparison");
    text = text.replace(needle, "if (false) {");
    const copy = join(dir, "order-worker.mut.mjs");
    writeFileSync(copy, text);
    const mutated = await verify(pathToFileURL(copy).href + "?mut=" + Date.now(), wrong);
    check(mutated && mutated.ok === true, "the breaking copy accepts the wrong commitment, so this check is load-bearing");
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps the module briefly */ } }
} finally {
  if (problems.length) {
    for (const p of problems) console.log("  FAIL  " + p);
    console.log("FAILED: " + problems.length + " problem(s)");
    process.exit(1);
  }
  console.log("PASSED: the worker's verdict is bound to the quote's commitment");
}
void ROOT;
