#!/usr/bin/env node
// WHERE THE XMR GOES, AND WHETHER THAT IS WHO THE FILE PROMISED.
//
// The recovery file names the recipient the swap was made for. The page compared the typed address with that name
// and showed a warning - a rule about the file, living in the interface that happened to read it. Sending XMR to
// another address is a different payment, so the comparison belongs where the file is understood.
//
// WHAT IS PROVEN (a real file built by the engine):
//   1) the promised address comes back, and typing it matches;
//   2) another well-formed address does not match - the answer is false, not a refusal;
//   3) an address of another network is refused by the file's network, with the library's reason;
//   4) an address of the wrong length is refused;
//   5) a file that names nobody gives `matches: null` - an absence, not a failure;
//   6) an empty destination and a wrong passphrase are refusals with codes.
//
// BREAKING RUNS (each mutates a COPY of the module in a temp directory):
//   A) `matches` always true -> case 2 reddens;
//   B) the network is not passed to the shape check -> case 3 reddens.
//
// Run: node tools/check-destination.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSweep } from "../src/sweep.mjs";
import { SdkError } from "../src/errors.mjs";
import * as engine from "../src/engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "src", "destination.mjs");
const PASSPHRASE = "destination-test-pass";
const ADDRESS = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";
const OTHER = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRr";
const MAINNET = "4" + "A".repeat(94);

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

async function recoveryFile({ receiveAddress = ADDRESS } = {}) {
  const payload = engine.recoveryFile.buildPayload({
    swap: {
      id: "destination", side: "buy", network: "arbitrum-sepolia", moneroNetwork: "stagenet",
      createdAt: new Date(0).toISOString(), payToken: "USDC", payAmount: 1, xmrAmount: 0.5,
      escrow: { address: "0x00000000000000000000000000000000000000e5", termsHash: null },
    },
    swapWallet: {
      source: "unit", library: "monero-ts", network: "stagenet", address: ADDRESS,
      spendHalf: "0x" + "11".repeat(32), viewHalf: "0x" + "22".repeat(32),
      otherSpendPoint: "0x" + "33".repeat(32), otherViewPoint: "0x" + "44".repeat(32),
      otherViewHalf: "0x" + "55".repeat(32),
    },
    escrow: { address: "0x00000000000000000000000000000000000000e5" },
    receiveAddress,
    restoreHeight: 2_206_635,
  });
  engine.recoveryFile.validatePayload(payload);
  return { contents: await engine.recoveryFile.createRecoveryFile(payload, PASSPHRASE) };
}

const sweep = (mod) => (mod || { createSweep }).createSweep({ http: { async json() { return {}; } }, config: { route: (n) => n } });
const ask = async (mod, file, dest, passphrase = PASSPHRASE) => {
  try { return { kind: "ok", value: await sweep(mod).destination({ file, passphrase, dest }) }; }
  catch (error) { return { kind: "error", error }; }
};

const file = await recoveryFile();
const noPromise = await recoveryFile({ receiveAddress: null });

console.log("=== 1) THE PROMISE ===");
{
  const o = await ask(null, file, ADDRESS);
  if (o.kind !== "ok") bad("same address refused: " + JSON.stringify(o.error && o.error.code));
  else {
    const r = o.value;
    if (r.ok && r.matches === true && r.promised === ADDRESS) ok("the promised address is named and typing it matches");
    else bad("same address: " + JSON.stringify(r));
    if (r.network === "stagenet") ok("the file's network is named");
    else bad("network: " + JSON.stringify(r.network));
  }
}
{
  const o = await ask(null, file, OTHER);
  if (o.kind === "ok" && o.value.ok === true && o.value.matches === false) ok("another well-formed address does not match (ok, matches false)");
  else bad("mismatch: " + JSON.stringify(o.kind === "ok" ? o.value : o.error.code));
}

console.log("=== 2) THE NETWORK AND THE SHAPE ===");
{
  const o = await ask(null, file, MAINNET);
  if (o.kind === "ok" && o.value.ok === false && o.value.matches === false && /mainnet|stagenet/.test(String(o.value.reason))) {
    ok("a mainnet address is refused by the file's network: " + o.value.reason);
  } else bad("mainnet address: " + JSON.stringify(o.kind === "ok" ? o.value : o.error.code));
}
{
  const o = await ask(null, file, "not-an-address");
  if (o.kind === "ok" && o.value.ok === false && o.value.reason) ok("a wrong length is refused: " + o.value.reason.slice(0, 40) + "...");
  else bad("short address: " + JSON.stringify(o.kind === "ok" ? o.value : o.error.code));
}

console.log("=== 3) A FILE THAT NAMES NOBODY ===");
{
  const o = await ask(null, noPromise, ADDRESS);
  if (o.kind === "ok" && o.value.matches === null) ok("matches is null when the file named nobody");
  else bad("no promise: " + JSON.stringify(o.kind === "ok" ? o.value : o.error.code));
}

console.log("=== 4) REFUSALS ===");
{
  const cases = [
    ["an empty destination", async () => {
      const o = await ask(null, file, "");
      return o.kind === "error" && o.error instanceof SdkError && o.error.code === "bad-input" && o.error.params && o.error.params.field === "dest";
    }],
    ["a wrong passphrase", async () => {
      const o = await ask(null, file, ADDRESS, "wrong-passphrase");
      return o.kind === "error" && o.error instanceof SdkError && o.error.code === "recovery-failed";
    }],
  ];
  for (const [name, run] of cases) {
    if (await run()) ok(name + " is refused");
    else bad(name + " was not refused as expected");
  }
}

function mutated(mutate, name) {
  const dir = mkdtempSync(join(tmpdir(), "check-destination-"));
  const source = mutate(readFileSync(DEST, "utf8").replace(/\r\n/g, "\n"));
  const rewritten = source.replace(/from\s+"(\.[^"]+)"/g, (whole, rel) => `from "${pathToFileURL(join(dirname(DEST), rel)).href}"`);
  const filePath = join(dir, name + ".mjs");
  writeFileSync(filePath, rewritten, "utf8");
  return { filePath, dir };
}
const importFresh = (p) => import(pathToFileURL(p).href + "?run=" + Math.random().toString(16).slice(2));

console.log("=== 5) BREAKING RUN A: matches is always true -> case 2 reddens ===");
{
  const { filePath, dir } = mutated((src) => {
    const before = src;
    src = src.replace("matches: promised === null ? null : address === promised,", "matches: promised === null ? null : true,");
    if (src === before) throw new Error("mutation A did not apply");
    return src;
  }, "a");
  try {
    const { checkDestination } = await importFresh(filePath);
    const payload = await engine.recoveryFile.decryptFile(JSON.parse(file.contents), PASSPHRASE);
    const r = await checkDestination(payload, OTHER);
    if (r.matches !== false) ok("breaking run A REDDENS: a different address matched (" + JSON.stringify(r.matches) + ")");
    else bad("breaking run A does not redden: matches is still false");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("=== 6) BREAKING RUN B: the network is not checked -> case 3 reddens ===");
{
  const { filePath, dir } = mutated((src) => {
    const before = src;
    src = src.replace("const shape = await checkAddress(address, network ? { expectNetwork: network } : {});", "const shape = await checkAddress(address, {});");
    if (src === before) throw new Error("mutation B did not apply");
    return src;
  }, "b");
  try {
    const { checkDestination } = await importFresh(filePath);
    const payload = await engine.recoveryFile.decryptFile(JSON.parse(file.contents), PASSPHRASE);
    const r = await checkDestination(payload, MAINNET);
    if (r.ok === true) ok("breaking run B REDDENS: a mainnet address passed the shape check");
    else bad("breaking run B does not redden: the network still refuses it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "destination: " + pass + " checks passed.");
if (fails.length) process.exit(1);
