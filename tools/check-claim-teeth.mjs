#!/usr/bin/env node
// THE BREAKING RUNS FOR THE CLAIM GUARDS THAT LANDED IN 0.61.0. Each case removes one guard from a source copy,
// runs its check, and requires the check to redden with its own reason. Sources are restored byte for byte.
//
// Run: node tools/check-claim-teeth.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const read = (file) => readFileSync(join(ROOT, file), "utf8");

const guard = (check) => {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, "tools", "check.mjs"), "--only=" + check], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    return { code: 0, text: stdout.toString() };
  } catch (error) {
    return { code: error.status ?? 1, text: `${error.stdout || ""}${error.stderr || ""}`.toString() };
  }
};

const cases = [
  {
    check: "relay-claim", source: "src/relayClaim.mjs",
    name: "a 2xx relay-level answer becomes a sender refusal",
    from: "if (!answer || version !== 1) {\n    throw new SdkError(\"claim-unknown\", { step: \"relay-claim\", why: \"answer\", outcome: \"unknown\" });\n  }\n  if (code && RELAY_LEVEL_CODES.has(code)) {",
    to: "if (!answer || version !== 1) {\n    throw new SdkError(\"claim-unknown\", { step: \"relay-claim\", why: \"answer\", outcome: \"unknown\" });\n  }\n  if (false) {",
    wants: "a 200 relay-level answer was treated as a sender refusal",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "the retired scalar is accepted by claimViaRelay",
    from: "if (request.claimSender !== undefined && request.claimSender !== null\n        && String(request.claimSender).trim() !== \"\") {\n        throw new SdkError(\"bad-input\", { field: \"claimSender\", why: \"retired\" });\n      }\n      // THE ORDER IS THE CLIENT'S, NOT THE RECORD'S.",
    to: "if (false) {\n        throw new SdkError(\"bad-input\", { field: \"claimSender\", why: \"retired\" });\n      }\n      // THE ORDER IS THE CLIENT'S, NOT THE RECORD'S.",
    wants: "a retired scalar sender",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "a matching list keeps the retired scalar",
    from: "if (Object.prototype.hasOwnProperty.call(swap, \"claimSender\")) {",
    to: "if (false) {",
    wants: "a matching list kept the retired scalar",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "the late-claim read before a window stop is removed",
    from: "if (tried.length || priorTried.length) return windowStop(gate.reason, tried);",
    to: "if (false) return windowStop(gate.reason, tried);",
    wants: "a late claim was reported as a closing window",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "a watch may redirect the record to another escrow",
    from: "if (request.escrow !== undefined && request.escrow !== null && String(request.escrow).trim()\n        && recordEscrow && !sameAddress(request.escrow, recordEscrow)) {",
    to: "if (false) {",
    wants: "a watch accepted another escrow",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "a pre-send unread escrow loses its own state",
    from: "if (!priorAttempts.length && error && error.code === \"claim-unknown\"",
    to: "if (error && error.code === \"claim-unknown\"",
    wants: "a prior attempt with an unread escrow was not claim-unknown",
  },
  {
    check: "relay-claim", source: "src/relayClaim.mjs",
    name: "a relay-level answer becomes a sender refusal",
    from: "if (code && RELAY_LEVEL_CODES.has(code)) {",
    to: "if (false) {",
    wants: "was treated as a sender refusal",
  },
  {
    check: "key-view", source: "engine/evm/funding.js",
    name: "the locker-half terms comparison is removed",
    from: "  for (const name of [\"locker\", \"claimer\", \"amount\", \"readyBy\", \"t1\", \"salt\", \"commitHalfClaimer\", \"edPointClaimer\",\n    \"commitHalfLocker\", \"edPointLocker\", \"edViewPointLocker\"]) {",
    to: "  for (const name of [\"locker\", \"claimer\", \"amount\", \"readyBy\", \"t1\", \"salt\", \"commitHalfClaimer\", \"edPointClaimer\"]) {",
    wants: "locker-half mismatch",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "the retired scalar sender is accepted by startSell",
    from: "if (request.claimSender !== undefined && request.claimSender !== null\n        && String(request.claimSender).trim() !== \"\") {\n        throw new SdkError(\"bad-input\", { field: \"claimSender\", why: \"retired\" });\n      }",
    to: "if (false) {\n        throw new SdkError(\"bad-input\", { field: \"claimSender\", why: \"retired\" });\n      }",
    wants: "startSell accepted the retired scalar sender",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "the pre-list record loses its stored scalar fallback",
    from: "const rawSenders = explicitList || (Array.isArray(swap.claimSenders) && swap.claimSenders.length\n        ? swap.claimSenders : (legacyStored ? [legacyStored] : []));",
    to: "const rawSenders = explicitList || (Array.isArray(swap.claimSenders) ? swap.claimSenders : []);",
    wants: "not-in-record",
  },
];

const originals = new Map();
for (const item of cases) if (!originals.has(item.source)) originals.set(item.source, read(item.source));
let failed = 0;
const fail = (message) => { failed += 1; console.log("  FAIL  " + message); };
const ok = (message) => console.log("  ok    " + message);

const baselines = new Set(cases.map((item) => item.check));
for (const check of baselines) {
  const result = guard(check);
  if (result.code !== 0) fail("baseline " + check + " is already red");
  else ok("baseline " + check + " is green");
}

for (const item of cases) {
  const original = originals.get(item.source);
  const normalized = original.replace(/\r\n/g, "\n");
  const mutated = normalized.replace(item.from, item.to);
  if (mutated === normalized) { fail(item.name + ": the anchor was not found"); continue; }
  try {
    writeFileSync(join(ROOT, item.source), mutated, "utf8");
    const result = guard(item.check);
    if (result.code === 0) fail(item.name + ": " + item.check + " stayed green");
    else if (!result.text.includes(item.wants)) fail(item.name + ": red without " + JSON.stringify(item.wants));
    else ok(item.name + " reddens " + item.check + " with " + item.wants);
  } finally {
    writeFileSync(join(ROOT, item.source), original, "utf8");
  }
}

for (const [source, original] of originals) {
  if (sha256(read(source)) !== sha256(original)) fail(source + " was not restored byte for byte");
}
if (!failed) ok("sources restored byte for byte");

if (failed) {
  console.log("FAILED: " + failed + " case(s)");
  process.exit(1);
}
console.log("claim guard teeth: " + (cases.length + baselines.size + 1) + " checks passed.");
