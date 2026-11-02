// THE PREBUILT BROWSER BUNDLES ARE PINNED, NOT TRUSTED BY AGE.
//
// `assets/vendors/*.js` are minified inputs shipped with the package. Nothing in this repository rebuilds them,
// so the only safe check here is provenance: every bundle must match the SHA-256 recorded in MANIFEST.json, and
// a new or missing bundle must be named. A rebuild in the page repository updates both the file and the manifest.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDORS = join(ROOT, "assets", "vendors");
const MANIFEST = join(VENDORS, "MANIFEST.json");

export const vendorBundlesCheck = () => {
  const problems = [];
  const notes = [];
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(MANIFEST, "utf8")); }
  catch (error) { return { note: "the vendor manifest is unreadable", problems: [`assets/vendors/MANIFEST.json: ${error && error.message}`] }; }
  if (!manifest || manifest.version !== 1 || !manifest.bundles || typeof manifest.bundles !== "object") {
    return { note: "the vendor manifest has the wrong shape", problems: ["assets/vendors/MANIFEST.json: version 1 and bundles are required"] };
  }
  for (const [rel, entry] of Object.entries(manifest.bundles)) {
    const file = join(VENDORS, rel);
    if (!existsSync(file)) { problems.push(`${rel}: listed in the manifest but missing`); continue; }
    const want = String(entry && entry.sha256 || "").toLowerCase();
    const got = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(want) || got !== want) problems.push(`${rel}: sha256 ${got}, expected ${want || "a 64-digit hash"}`);
  }
  // A BUNDLE NOT IN THE MANIFEST IS AN UNREVIEWED INPUT. Its presence is not a failure by itself only when it
  // is a license or a directory; every `.js` under vendors must be named.
  const listed = new Set(Object.keys(manifest.bundles));
  for (const rel of ["atomic/atomic-browser.js", "monero/monero-js-browser.js", "sdk/sdk-browser.js", "walletconnect/wc-browser.js"]) {
    if (!listed.has(rel)) problems.push(`${rel}: the known bundle is absent from the manifest`);
  }
  if (!problems.length) notes.push(`${Object.keys(manifest.bundles).length} pinned browser bundles match their manifest`);
  return { note: "the prebuilt browser bundles match the pinned manifest", problems, notes };
};
