#!/usr/bin/env node
// BASELINE LINE COVERAGE FROM NODE'S OWN V8 INSTRUMENTATION - no new dependency.
//
// `NODE_V8_COVERAGE` is inherited by every child process the SDK checks spawn. The report here is deliberately
// line coverage of executable ranges, not a claim of branch or mutation coverage; the security-invariants map is
// the reviewable half of the argument. Run it as `pnpm run coverage`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lineCoverage } from "./coverage-merge.mjs";

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

let batteryFailed = false;
try {
  run(["tools/check.mjs", ...(only ? ["--only=" + only] : [])]);
} catch (error) {
  // Keep the partial coverage report, but never exit zero: a red battery must not look like a successful
  // coverage run just because V8 files were produced.
  batteryFailed = true;
  console.error("coverage: the check battery failed; the report is partial");
}

const inScope = (file) => {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  return /^(src|engine)\//.test(rel) && /\.(mjs|js)$/.test(rel);
};

const files = new Map(); // absolute path -> array of ranges from every process
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

// THE INVENTORY IS NOT THE PROFILE LIST. A module that no check loaded has no V8 row at all; showing only loaded
// files makes the denominator look better than the source tree. Keep every source file in the report and mark the
// never-loaded ones explicitly. Their executable line count is unknown without V8, so they are not folded into the
// percentage; the count of unloaded files is reported separately.
const walkSource = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walkSource(full, out);
    else if (inScope(full)) out.push(full);
  }
  return out;
};
for (const file of [...walkSource(join(ROOT, "src")), ...walkSource(join(ROOT, "engine"))]) {
  if (!files.has(file)) files.set(file, []);
}

const summary = [];
let totalLines = 0;
let totalCovered = 0;
let unloadedFiles = 0;
for (const [file, ranges] of [...files.entries()].sort()) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  if (!ranges.length) {
    unloadedFiles += 1;
    summary.push({ file: rel, lines: 0, covered: 0, percent: 0, loaded: false });
    continue;
  }
  const text = readFileSync(file, "utf8");
  const row = lineCoverage(text, ranges);
  totalLines += row.lines;
  totalCovered += row.covered;
  summary.push({ file: rel, lines: row.lines, covered: row.covered, percent: row.percent, loaded: true });
}

const result = {
  kind: "v8-line-coverage",
  note: "Executable-range line coverage; not branch or mutation coverage. Never-loaded files are listed but not in the percentage.",
  totals: { lines: totalLines, covered: totalCovered, percent: totalLines ? Number(((totalCovered / totalLines) * 100).toFixed(1)) : 100, unloadedFiles },
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

// A BASELINE IS A FLOOR, NOT A SECURITY SCORE. The audit found that one global percentage lets a critical
// money-path module fall while the total stays flat. The committed baseline records a floor per critical file and
// the known-unloaded set; a new unloaded critical file or a drop below the floor is a red coverage run.
// `tolerancePercent` absorbs the small process/runtime variation between a developer machine and CI, not a real
// regression.
const baselineFile = join(ROOT, "tools", "coverage-baseline.json");
const coverageProblems = [];
let baseline = null;
try {
  baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
} catch (error) {
  coverageProblems.push("coverage baseline could not be read: " + String((error && error.message) || error));
}
if (baseline) {
  const tolerance = Number.isFinite(Number(baseline.tolerancePercent)) ? Number(baseline.tolerancePercent) : 0;
  if (Number(result.totals.percent) + tolerance < Number(baseline.totals.percent)) {
    coverageProblems.push(`total line coverage ${result.totals.percent}% is below the baseline ${baseline.totals.percent}%`);
  }
  if (Number(result.totals.unloadedFiles) > Number(baseline.totals.unloadedFiles)) {
    coverageProblems.push(`${result.totals.unloadedFiles} source file(s) never loaded, above the baseline ${baseline.totals.unloadedFiles}`);
  }
  const allowedUnloaded = new Set(Array.isArray(baseline.allowedUnloadedCritical) ? baseline.allowedUnloadedCritical : []);
  for (const file of [...critical, ...Object.keys(baseline.critical || {})]) {
    if (!Object.prototype.hasOwnProperty.call(baseline.critical || {}, file)) {
      coverageProblems.push(`critical file ${file} has no baseline floor`);
      continue;
    }
    const row = summary.find((entry) => entry.file === file);
    if (!row) {
      coverageProblems.push(`critical file ${file} is missing from the coverage report`);
      continue;
    }
    const floor = baseline.critical[file];
    if (!row.loaded) {
      if (!allowedUnloaded.has(file)) coverageProblems.push(`critical file ${file} was never loaded and is not an allowed baseline gap`);
    } else if (floor !== null && row.percent + tolerance < Number(floor)) {
      coverageProblems.push(`${file} ${row.percent}% is below its baseline floor ${floor}%`);
    }
  }
}
console.log("coverage: " + result.totals.percent + "% of executable lines (" + result.totals.covered + "/" + result.totals.lines + "), " + result.totals.unloadedFiles + " source file(s) never loaded");
for (const row of summary.filter((row) => critical.has(row.file))) {
  console.log("  " + row.percent.toString().padStart(5) + "%  " + row.file);
}
for (const problem of coverageProblems) console.log("  FAIL  " + problem);
console.log("report: " + relative(ROOT, reportFile));
if (coverageProblems.length) console.log("coverage gate: FAILED (" + coverageProblems.length + ")");
else console.log("coverage gate: critical-file floors hold");
if (batteryFailed || coverageProblems.length) process.exitCode = 1;
