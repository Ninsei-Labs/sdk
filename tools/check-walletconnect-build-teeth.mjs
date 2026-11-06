#!/usr/bin/env node
// BREAKING RUN FOR THE WALLETCONNECT BUILD CHECK.
//
// A guard that has never been seen to fail is decoration. This changes only the expected hash in a temporary
// manifest; the rebuilt bundle must then be refused by name. It also proves that the check reads the manifest
// through the documented override rather than passing because it compared a file with itself.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "wc-build-teeth-"));
const manifest = JSON.parse(readFileSync(join(ROOT, "assets/vendors/MANIFEST.json"), "utf8"));
manifest.bundles["walletconnect/wc-browser.js"].sha256 = "0".repeat(64);
const tempManifest = join(temp, "MANIFEST.json");
writeFileSync(tempManifest, JSON.stringify(manifest, null, 2));

let problems = [];
try {
  const run = spawnSync(process.execPath, [join(ROOT, "tools/check-walletconnect-build.mjs")], {
    cwd: ROOT,
    env: { ...process.env, WALLETCONNECT_MANIFEST: tempManifest },
    encoding: "utf8",
  });
  if (run.status === 0) problems.push("a wrong expected hash did not redden the check");
  if (!/manifest says 0{64}/.test(String(run.stderr))) {
    problems.push("the refusal did not name the expected hash: " + String(run.stderr).trim());
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

if (problems.length) {
  console.error("FAILED: " + problems.join("; "));
  process.exit(1);
}
console.log("walletconnect build teeth: a wrong expected hash is refused by name");
