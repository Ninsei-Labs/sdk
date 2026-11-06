#!/usr/bin/env node
// REPRODUCIBILITY CHECK FOR THE WALLETCONNECT VENDOR BUNDLE.
//
// The committed file is a composition, not an upstream release. This check rebuilds it from the lock file and
// entry beside it, then compares the SHA-256 with assets/vendors/MANIFEST.json. It runs in the dedicated
// walletconnect-vendor workflow after `npm ci`; a stale or hand-edited bundle is a named failure.
//
// Run: npm ci in tools/vendors/walletconnect, then node tools/check-walletconnect-build.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWalletConnect } from "./vendors/walletconnect/build.mjs";

const manifestPath = process.env.WALLETCONNECT_MANIFEST || "assets/vendors/MANIFEST.json";
const rel = "walletconnect/wc-browser.js";
const problems = [];

let expected = null;
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  expected = manifest?.bundles?.[rel]?.sha256 || null;
} catch (error) {
  problems.push(`${manifestPath}: ${error.message}`);
}

const temp = mkdtempSync(join(tmpdir(), "wc-build-"));
try {
  if (!expected) {
    problems.push(`${manifestPath}: no sha256 for ${rel}`);
  } else {
    const result = await buildWalletConnect({ outfile: join(temp, "wc-browser.js") });
    if (result.sha256 !== expected) {
      problems.push(`${rel}: rebuilt ${result.sha256}, manifest says ${expected}`);
    }
  }
} catch (error) {
  problems.push(`the bundle could not be rebuilt (run npm ci in tools/vendors/walletconnect): ${error.message}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (problems.length) {
  console.error("FAILED: " + problems.join("; "));
  process.exit(1);
}
console.log(`walletconnect bundle: rebuilt ${rel} matches the committed sha256`);
