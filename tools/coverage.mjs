#!/usr/bin/env node
// BASELINE LINE COVERAGE FROM NODE'S OWN V8 INSTRUMENTATION - no new dependency.
//
// `NODE_V8_COVERAGE` is inherited by every child process the SDK checks spawn. The report here is deliberately
// line coverage of executable ranges, not a claim of branch or mutation coverage; the security-invariants map is
// the reviewable half of the argument. Run it as `pnpm run coverage`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "coverage");
const RAW = join(tmpdir(), "sdk-v8-coverage-" + process.pid);
const reportFile = join(OUT, "coverage-summary.json");

rmSync(RAW, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

const only = process.env.COVERAGE_CHECKS || null;
const run = (args) => execFileSync(process.execPath, args, {
  cwd: ROOT,
  env: { ...process.env, NODE_V8_COVERAGE: RAW },
  stdio: "inherit",
});

try {
  run(["tools/check.mjs", ...(only ? ["--only=" + only] : [])]);
} catch {
  // The coverage run still produces a report for the checks that did run; the CI status is the caller's concern.
}

const inScope = (file) => {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  return /^(src|engine)\//.test(rel) && /\.(mjs|js)$/.test(rel);
};

const files = new Map(); // absolute path -> array of ranges
for (const entry of readdirSync(RAW)) {
  if (!entry.endsWith(".json")) continue;
  let data;
  try { data = JSON.parse(readFileSync(join(RAW, entry), "utf8")); } catch { continue; }
  for (const result of data.result || []) {
    if (!result || typeof result.url !== "string" || !result.url.startsWith("file:")) continue;
    let file;
    try { file = fileURLToPath(result.url); } catch { continue; }
    if (!inScope(file) || !existsSync(file)) continue;
    const ranges = files.get(file) || [];
    for (const fn of result.functions || []) {
      for (const range of fn.ranges || []) {
        if (Number.isFinite(range.startOffset) && Number.isFinite(range.endOffset)) ranges.push(range);
      }
    }
    files.set(file, ranges);
  }
}

const lineStarts = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
};
const summary = [];
let totalLines = 0;
let totalCovered = 0;
for (const [file, ranges] of [...files.entries()].sort()) {
  const text = readFileSync(file, "utf8");
  const starts = lineStarts(text);
  let lines = 0;
  let covered = 0;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : text.length + 1;
    const touching = ranges.filter((range) => range.startOffset < end && range.endOffset > start);
    if (!touching.length) continue; // comments/blank/declarations with no executable range
    lines += 1;
    // V8 ranges are nested: the module/top-level range covers the whole file and would paint an uncalled function
    // as covered. The innermost range that contains the line start is the one that describes that line.
    const innermost = touching.reduce((best, range) => (range.endOffset - range.startOffset < best.endOffset - best.startOffset ? range : best));
    if (innermost.count > 0) covered += 1;
  }
  totalLines += lines;
  totalCovered += covered;
  summary.push({ file: relative(ROOT, file).replaceAll("\\", "/"), lines, covered, percent: lines ? Number(((covered / lines) * 100).toFixed(1)) : 100 });
}

const result = {
  kind: "v8-line-coverage",
  note: "Executable-range line coverage; not branch or mutation coverage",
  totals: { lines: totalLines, covered: totalCovered, percent: totalLines ? Number(((totalCovered / totalLines) * 100).toFixed(1)) : 100 },
  files: summary,
};
writeFileSync(reportFile, JSON.stringify(result, null, 2) + "\n");
rmSync(RAW, { recursive: true, force: true });

const critical = new Set([
  "src/actions.mjs", "src/chainGuard.mjs", "src/quotes.mjs", "src/factoryPolicy.mjs",
  "src/recovery-key.mjs", "src/relayFirmClient.mjs", "src/relayQuote.mjs", "src/relayRequest.mjs",
  "src/swaps.mjs", "src/swap-flow.mjs", "src/xmr-arrival.mjs", "engine/atomic/dleq2.js",
  "engine/core/store.js", "src/adapters/index.mjs", "src/adapters/evm-wallet.mjs", "src/index.mjs",
]);
console.log("coverage: " + result.totals.percent + "% of executable lines (" + result.totals.covered + "/" + result.totals.lines + ")");
for (const row of summary.filter((row) => critical.has(row.file))) {
  console.log("  " + row.percent.toString().padStart(5) + "%  " + row.file);
}
console.log("report: " + relative(ROOT, reportFile));
