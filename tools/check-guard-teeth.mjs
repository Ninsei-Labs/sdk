#!/usr/bin/env node
// THE BREAKING RUNS FOR THE GUARDS THAT TOUCH MONEY. Each case changes one guard, boundary or constant in a source copy, runs the
// named check, and requires it to redden with its own reason. Every source file is restored byte for byte.
//
// Run: node tools/check-guard-teeth.mjs
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
  // Remove each request pair separately; a different refusal must not stand in for the named field.
  ...[
    ["chainId", "String(order.chainId)"], ["locker", "order.locker"], ["claimer", "order.claimer"],
    ["amount", "String(order.amount)"], ["readyBy", "String(order.readyBy)"], ["t1", "String(order.t1)"],
    ["salt", "order.salt"], ["claimTip", "String(terms.claimTip)"], ["provider", "terms.maker"], ["registry", "terms.registry"],
  ].map(([field, expression]) => ({
    check: "relay-http", source: "src/relayQuote.mjs", name: `the signed ${field} request binding is removed`,
    from: `    ["${field}", ${expression}],`, to: "", wants: `signed field ${field}`,
  })),
  {
    check: "relay-http", source: "src/relayQuote.mjs", name: "the envelope factory binding is removed",
    from: "if (!same(payload.factory, request.terms.order.factory))", to: "if (false)", wants: "signed field factory",
  },
  {
    check: "dleq-vectors", source: "engine/atomic/dleq2.js", name: "the subject subgroup check is removed",
    from: 'if (!torsionFree(curves.B, XB)) return { ok: false, reason: "proof: XB is not in the prime-order subgroup" };',
    to: "", wants: "order-2 XB did not get its subgroup refusal",
  },
  {
    check: "uniswapx-refusal", source: "src/legs/uniswapx.mjs", name: "the status read accepts the first returned order",
    from: "const matches = orders.filter((o) => o && String(o.orderHash || \"\").toLowerCase() === String(orderHash).toLowerCase());",
    to: "const matches = orders;", wants: "another order hash",
  },
  {
    check: "uniswap-relay-refusal", source: "src/legs/uniswaprelay.mjs", name: "the reactor address is ignored",
    from: '&& String(log.address || "").toLowerCase() === expectedAddress\n    && log.removed !== true',
    to: "&& log.removed !== true", wants: "a foreign reactor address",
  },
  {
    check: "uniswap-relay-refusal", source: "src/legs/uniswaprelay.mjs", name: "a removed event is accepted",
    from: "    && log.removed !== true", to: "", wants: "a removed event",
  },
  {
    check: "fees", source: "engine/evm/fees.js", name: "the buy fee is omitted from funding",
    from: "totalWei: feeOnTop ? amount + fee : amount", to: "totalWei: amount", wants: "fee roles and wei",
  },
  {
    check: "fees", source: "engine/evm/fees.js", name: "the fee cap rejects its boundary",
    from: "bps > BigInt(MAX_FEE_BPS)", to: "bps >= BigInt(MAX_FEE_BPS)", wants: "fee rate must be an integer from 0 to 200",
  },
  {
    check: "arrival-consensus", source: "src/xmr-arrival.mjs", name: "the fastest node supplies confirmations",
    from: "Math.min(...best.nodes.map((r) => r.confirmations))", to: "Math.max(...best.nodes.map((r) => r.confirmations))", wants: "confirmation boundary",
  },
  {
    check: "arrival-consensus", source: "src/xmr-arrival.mjs", name: "the confirmation threshold moves by one",
    from: "confirmations < minConfirmations", to: "confirmations <= minConfirmations", wants: "confirmation boundary",
  },
  {
    check: "recovery-key", source: "src/recovery-key.mjs", name: "the recovery KDF work factor is weakened",
    from: "export const RECOVERY_KEY_ITER = 600000;\nconst ITER_MIN = 600000;", to: "export const RECOVERY_KEY_ITER = 1000;\nconst ITER_MIN = 1000;", wants: "recovery KDF work factor",
  },
  {
    check: "recovery-key", source: "src/recovery-key.mjs", name: "the minimum recovery KDF work factor moves by one",
    from: "const ITER_MIN = 600000;", to: "const ITER_MIN = 599999;", wants: "weak recovery KDF 599999",
  },
  {
    check: "relay-adapter", source: "src/quotes.mjs", name: "screening always selects the claimer",
    from: 'side === "bid" ? order.claimer : order.locker', to: 'order.claimer', wants: "ask denylist",
  },
  {
    check: "sweep-adapter", source: "src/sweep-fees.mjs", name: "an unknown signed fee is omitted",
    from: "if (value === null || value === undefined) return null;", to: "if (value === null || value === undefined) continue;", wants: "partial signed fee",
  },
  {
    check: "action-state", source: "src/swap-flow.mjs",
    name: "the clock guard is removed",
    from: "if (!Number.isSafeInteger(at) || at <= 0) {", to: "if (false) {",
    wants: "no clock",
  },
  {
    check: "action-state", source: "src/swap-flow.mjs",
    name: "the claim deadline margin is removed",
    from: "if (at + margin >= Number(deadlines.t1))", to: "if (false)",
    wants: "inside the t1 margin",
  },
  {
    check: "action-state", source: "src/swap-flow.mjs",
    name: "the simulation refusal is removed",
    from: "if (!reverted) throw error;\n    throw new SdkError(\"contract-reverted\", {",
    to: "if (true) return;\n    throw new SdkError(\"contract-reverted\", {",
    wants: "simulation",
  },
  {
    check: "sell-start", source: "src/swaps.mjs",
    name: "the full-width commitment check is removed",
    from: "if (!ownCommit || fullHex(ownCommit) !== fullHex(quote.commitHalfClaimer)) {", to: "if (false) {",
    wants: "low 160 bits",
  },
  {
    check: "sell-watch", source: "src/swaps.mjs",
    name: "the claim-open report is removed",
    from: "if (Number.isSafeInteger(readyBy) && Number.isSafeInteger(t1) && at !== null && at >= readyBy) {", to: "if (false) {",
    wants: "exact proof path failed",
  },
  {
    check: "claim-sender", source: "src/actions.mjs",
    name: "the claim-sender policy is removed",
    from: "if (from !== to) return { ok: false, code: \"bad-input\", field: \"wallet\", why: \"not-the-claimer\" };",
    to: "if (false) return { ok: false, code: \"bad-input\", field: \"wallet\", why: \"not-the-claimer\" };",
    wants: "third-party sender",
  },
  {
    check: "funding-receipt", source: "engine/evm/funding.js",
    name: "a reverted receipt is no longer reverted",
    from: "if (status === 0) return { status: \"reverted\", reason: \"status-0\" };",
    to: "if (false) return { status: \"reverted\", reason: \"status-0\" };",
    wants: "status 0",
  },
  {
    check: "order-proof", source: "engine/atomic/order.js",
    name: "the proof-to-commitment binding is removed",
    from: "if (!provenCommit || low160(provenCommit) !== low160(side.commitHalfClaimer)) {",
    to: "if (false) {",
    wants: "substituted commitment",
  },
  {
    check: "claim-tip", source: "src/quotes.mjs",
    name: "the claim-tip ceiling is removed",
    from: "if (tip > ceiling) {", to: "if (false) {",
    wants: "too-large",
  },
  {
    check: "relay-http", source: "src/relayQuote.mjs",
    name: "the forwarded provider binding is removed",
    from: "if (!same(forwarded.provider, provider)) {", to: "if (false) {",
    wants: "a different provider",
  },
  {
    check: "relay-adapter", source: "src/quotes.mjs",
    name: "the registry pin is removed",
    from: "if (pinnedRegistry && !sameText(registry, pinnedRegistry)) {", to: "if (false) {",
    wants: "foreign registry",
  },
  {
    check: "relay-adapter", source: "src/quotes.mjs",
    name: "a foreign cashier is accepted",
    from: "if (got !== pin) fail(\"quote-cashier-mismatch\", { step, got: got || null, want: pin });",
    to: "if (false) fail(\"quote-cashier-mismatch\", { step, got: got || null, want: pin });",
    wants: "foreign cashier",
  },
  {
    check: "action-state", source: "src/swap-flow.mjs",
    name: "the claim's dry run carries the half again",
    from: "await assertHalfMatchesCommit(escrow, halfClaimer, \"commitHalfClaimer\", \"claim\", deps);",
    to: "await simulateAction(escrow, encodeClaim(halfClaimer), \"claim\", deps);",
    wants: "read call(s) carried the half",
  },
  {
    check: "action-state", source: "src/swap-flow.mjs",
    name: "the local half comparison is removed",
    from: "if (got !== low160Hex(commit)) {", to: "if (false) {",
    wants: "with a foreign half",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "the relay claim window guard is removed",
    from: "return windowResult(gate.reason, tried);",
    to: "return null;",
    wants: "did not stop before the relay",
  },
  {
    check: "relay-claim", source: "src/swaps.mjs",
    name: "an unread escrow is no longer named",
    from: "throw new SdkError(\"claim-unknown\", { step: \"relay-claim\", why: \"escrow-unread\",\n            detail: String((error && error.message) || error).slice(0, 160) });",
    to: "throw new Error(\"escrow-unread\");",
    wants: "unread escrow",
  },
  {
    check: "key-view", source: "src/swaps.mjs",
    name: "the pending salt is no longer canonicalised",
    from: "saltForResume = rawSaltForResume === null || rawSaltForResume === undefined || rawSaltForResume === \"\"\n          ? null : recoverySaltOf(rawSaltForResume);",
    to: "saltForResume = rawSaltForResume;",
    wants: "bigint salt retry",
  },
  {
    check: "relay-adapter", source: "src/config.mjs",
    name: "the cashier is dropped from the network projection",
    from: "    cashier: chain.escrow.cashier || null,", to: "",
    wants: "has cashier",
  },
  {
    check: "wallet-balances", source: "src/wallet.mjs",
    name: "the balance chain snapshot check is removed",
    from: "if (chainMoved) {", to: "if (false) {",
    wants: "a chain change and return during the read",
  },
  {
    check: "wallet-balances", source: "src/wallet.mjs",
    name: "the balance account snapshot check is removed",
    from: "if (accountMoved) {", to: "if (false) {",
    wants: "an account change between the native and token replies",
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
console.log("guard teeth: " + (cases.length + baselines.size + 1) + " checks passed.");
