// THE PREBUILT BROWSER BUNDLES ARE PINNED, NOT TRUSTED BY AGE.
//
// `assets/vendors/*.js` are minified inputs shipped with the package. Nothing in this repository rebuilds them,
// so the only safe check here is provenance: every bundle must match the SHA-256 recorded in MANIFEST.json, and
// a new or missing bundle must be named. A rebuild updates both the file and the manifest.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDORS = join(ROOT, "assets", "vendors");

// THE HASH IS OVER THE CHECKED-IN BYTES, NOT THE WORKING-TREE LINE ENDINGS. A Windows checkout may turn LF into
// CRLF; Git stores LF, and CI checks out LF. Normalising CRLF keeps the same manifest valid on both.
const sha256Of = (file) => createHash("sha256")
  .update(readFileSync(file).toString("utf8").replace(/\r\n/g, "\n"))
  .digest("hex");

const listBundles = (dir, root = dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listBundles(full, root, out);
    else if (name.endsWith(".js")) out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
};

export const vendorBundlesCheck = ({ vendorsDir = VENDORS, manifestPath = join(VENDORS, "MANIFEST.json"),
  sessionPath = join(ROOT, "engine", "evm", "session.js") } = {}) => {
  const problems = [];
  const notes = [];
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { return { note: "the vendor manifest is unreadable", problems: [`MANIFEST.json: ${error && error.message}`] }; }
  if (!manifest || manifest.version !== 1 || !manifest.bundles || typeof manifest.bundles !== "object") {
    return { note: "the vendor manifest has the wrong shape", problems: ["MANIFEST.json: version 1 and bundles are required"] };
  }
  const listed = new Set(Object.keys(manifest.bundles));
  for (const [rel, entry] of Object.entries(manifest.bundles)) {
    const file = join(vendorsDir, rel);
    if (!existsSync(file)) { problems.push(`${rel}: listed in the manifest but missing`); continue; }
    const want = String(entry && entry.sha256 || "").toLowerCase();
    const got = sha256Of(file);
    if (!/^[0-9a-f]{64}$/.test(want) || got !== want) problems.push(`${rel}: sha256 ${got}, expected ${want || "a 64-digit hash"}`);
  }
  // EVERY JAVASCRIPT FILE UNDER vendors IS AN INPUT THE PACKAGE SHIPS. A bundle added to the directory but
  // not to the manifest is named, so the manifest cannot quietly cover only the known files.
  for (const rel of listBundles(vendorsDir)) {
    if (!listed.has(rel)) problems.push(`${rel}: present under assets/vendors but absent from the manifest`);
  }
  // THE SDK ENGINE MUST NOT LOAD A WALLETCONNECT VENDOR. `evmWallet(provider)` is the seam; the host page
  // owns the connector and its bundle. A path or provider initializer returning here would make the package
  // depend on a file it no longer ships.
  const sessionFile = sessionPath;
  if (existsSync(sessionFile)) {
    const sessionText = readFileSync(sessionFile, "utf8");
    if (/assets\/vendors\/walletconnect|EthereumProvider\.init|QRCode\.toDataURL/.test(sessionText)) {
      problems.push("engine/evm/session.js: the WalletConnect connector is back; the host owns it");
    }
  }
  // THE SDK BUNDLE EMBEDS THE PAGE BRIDGE, AND THE BRIDGE NAMES THE BUNDLE'S CACHE KEY. Changing that key after
  // building leaves the committed bundle with the previous key and makes CI rebuild a different file. The key is a
  // cache label, not the bundle hash: keep it stable and rebuild after changing it.
  const bridgeFile = join(ROOT, "engine", "sdk", "bridge.js");
  const sdkBundle = join(vendorsDir, "sdk", "sdk-browser.js");
  if (existsSync(bridgeFile) && existsSync(sdkBundle)) {
    const bridgeText = readFileSync(bridgeFile, "utf8");
    const bundleText = readFileSync(sdkBundle, "utf8");
    const bridgeKey = /sdk-browser\.js\?v=([0-9a-f]+)/.exec(bridgeText);
    const bundleKey = /sdk-browser\.js\?v=([0-9a-f]+)/.exec(bundleText);
    if (!bridgeKey || !bundleKey) problems.push("sdk/sdk-browser.js: the bridge query is missing");
    else if (bridgeKey[1] !== bundleKey[1]) {
      problems.push(`sdk/sdk-browser.js: embeds query ${bundleKey[1]}, while engine/sdk/bridge.js names ${bridgeKey[1]}; rebuild after changing the key`);
    }
  }
  if (!problems.length) notes.push(`${Object.keys(manifest.bundles).length} pinned browser bundles match their manifest`);
  return { note: "the prebuilt browser bundles match the pinned manifest", problems, notes };
};
