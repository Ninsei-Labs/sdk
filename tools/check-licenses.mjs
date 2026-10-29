#!/usr/bin/env node
// PRODUCTION DEPENDENCIES MUST CARRY A LICENSE WE CAN SHIP.
//
// pnpm already knows the installed tree and groups it by the license in each package manifest. This guard turns
// that answer into a policy decision: an allowlist of permissive licenses, an SPDX expression reader (so
// `MIT OR Apache-2.0` is not rejected by its spelling), and a non-zero exit for every package whose license is
// outside the list. The published SDK must not rely on a license nobody checked.
//
// Run: pnpm run check:licenses
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// The same permissive set the organisation uses for public code. A copyleft, source-available, unknown or
// "see LICENSE" package is not on this list: it is a decision for a person, not a silent dependency.
export const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "Unlicense", "0BSD", "CC0-1.0",
  "BlueOak-1.0.0",
]);

const stripOuter = (text) => {
  let value = String(text || "").trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let closesAt = -1;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === "(") depth += 1;
      else if (value[i] === ")") depth -= 1;
      if (depth === 0) { closesAt = i; break; }
    }
    if (closesAt !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
};

/** Split on a top-level SPDX operator, ignoring parentheses. */
function splitTop(text, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const needle = ` ${operator} `;
  for (let i = 0; i <= text.length - needle.length; i += 1) {
    const char = text[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth === 0 && text.slice(i, i + needle.length).toUpperCase() === needle) {
      parts.push(text.slice(start, i).trim());
      start = i + needle.length;
      i = start - 1;
    }
  }
  if (!parts.length) return null;
  parts.push(text.slice(start).trim());
  return parts;
}

/** Whether an SPDX expression permits every alternative it names. OR needs one allowed branch; AND needs all. */
export function licenseAllowed(expression) {
  const text = stripOuter(expression);
  if (!text) return false;
  const ors = splitTop(text, "OR");
  if (ors) return ors.some((part) => licenseAllowed(part));
  const ands = splitTop(text, "AND");
  if (ands) return ands.every((part) => licenseAllowed(part));
  // `Apache-2.0 WITH LLVM-exception` is the same permission with an exception; the base license decides. A
  // version range such as `GPL-2.0+` is not a permissive license and stays refused.
  const atom = text.replace(/\s+WITH\s+.+$/i, "").trim();
  return ALLOWED.has(atom);
}

function packageLabel(entry) {
  const versions = Array.isArray(entry.versions) && entry.versions.length ? entry.versions.join(", ") : "?";
  return `${entry.name}@${versions}`;
}

/** Every package in a pnpm `licenses list --json` answer that is outside the allowlist. */
export function violations(report) {
  const bad = [];
  for (const [license, entries] of Object.entries(report || {})) {
    if (licenseAllowed(license)) continue;
    for (const entry of Array.isArray(entries) ? entries : []) {
      bad.push({ license, package: packageLabel(entry) });
    }
  }
  return bad;
}

export function summary(report) {
  const rows = Object.entries(report || {});
  const packages = rows.reduce((count, [, entries]) => count + (Array.isArray(entries) ? entries.length : 0), 0);
  return { packages, licenses: rows.map(([license, entries]) => ({ license, count: Array.isArray(entries) ? entries.length : 0 })) };
}

function readReport() {
  const stdout = execSync("pnpm licenses list --prod --json", {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  try { return JSON.parse(stdout); } catch { throw new Error("pnpm licenses list did not return JSON"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  try { report = readReport(); } catch (error) {
    console.error("license check: " + (error?.message || error));
    process.exit(2);
  }
  const totals = summary(report);
  console.log("=== PRODUCTION DEPENDENCY LICENSES ===");
  for (const row of totals.licenses.sort((a, b) => a.license.localeCompare(b.license))) {
    console.log(`  ${row.license}: ${row.count} package(s)`);
  }
  const bad = violations(report);
  if (!totals.packages) {
    console.error("license check: no production dependencies were read - the scanner is looking at nothing");
    process.exit(1);
  }
  if (bad.length) {
    console.error("RESTRICTED LICENSES:");
    for (const row of bad) console.error(`  ${row.license}: ${row.package}`);
    console.error(`license check: ${bad.length} package(s) outside the allowlist`);
    process.exit(1);
  }
  console.log(`license check: ${totals.packages} production package(s), all on the allowlist`);
}
