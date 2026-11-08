// BREAKING RUN FOR THE VENDOR MANIFEST GUARD.
//
// The guard is a hash comparison; a guard nobody has seen fail is decoration. This builds a small temporary
// vendor tree, checks it green, adds an unlisted bundle and flips one hash, and requires each case to be red
// with the file named.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendorBundlesCheck } from "./check-vendor-bundles.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const root = mkdtempSync(join(tmpdir(), "vendor-bundles-"));
const vendors = join(root, "vendors");
mkdirSync(join(vendors, "a"), { recursive: true });
writeFileSync(join(vendors, "a", "one.js"), "one");
writeFileSync(join(vendors, "two.js"), "two");
const manifest = join(vendors, "MANIFEST.json");
writeFileSync(manifest, JSON.stringify({
  version: 1,
  bundles: { "a/one.js": { sha256: hash("one") }, "two.js": { sha256: hash("two") } },
}));
const session = join(root, "session.js");
writeFileSync(session, "export const session = true;\n");

const problems = [];
const expect = (condition, message) => { if (!condition) problems.push(message); };
try {
  const green = vendorBundlesCheck({ vendorsDir: vendors, manifestPath: manifest, sessionPath: session });
  expect(green.problems.length === 0, `the baseline is red: ${green.problems.join("; ")}`);

  writeFileSync(join(vendors, "three.js"), "three");
  const extra = vendorBundlesCheck({ vendorsDir: vendors, manifestPath: manifest, sessionPath: session });
  expect(extra.problems.some((line) => line.includes("three.js") && line.includes("absent")),
    `an unlisted bundle is not named: ${extra.problems.join("; ")}`);

  writeFileSync(join(vendors, "two.js"), "changed");
  const changed = vendorBundlesCheck({ vendorsDir: vendors, manifestPath: manifest, sessionPath: session });
  expect(changed.problems.some((line) => line.includes("two.js") && line.includes("sha256")),
    `a changed bundle is not named: ${changed.problems.join("; ")}`);

  writeFileSync(session, "const lib = import(\"../../assets/vendors/walletconnect/wc-browser.js\");\n");
  const connector = vendorBundlesCheck({ vendorsDir: vendors, manifestPath: manifest, sessionPath: session });
  expect(connector.problems.some((line) => line.includes("WalletConnect connector")),
    `a returning WalletConnect connector is not named: ${connector.problems.join("; ")}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (problems.length) {
  console.error("FAILED: " + problems.join("; "));
  process.exit(1);
}
console.log("vendor-bundles teeth: 3 breaking cases red and named");
