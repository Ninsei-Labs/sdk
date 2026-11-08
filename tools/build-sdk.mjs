// BUILD THE BROWSER BUNDLE THE PAGE IMPORTS.
//
// One entry, one output, no runtime build on the page. The output is committed: the page stays static, and the
// bridge's `?v=<hash>` link is updated separately. The host page owns every other browser dependency; the SDK
// does not ship a WalletConnect bundle or load one at runtime.
import { build } from "esbuild";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "vendors", "sdk", "sdk-browser.js");

// THE SDK BUNDLE IS THE ONLY BROWSER ARTIFACT THE PACKAGE SHIPS. The host page owns any WalletConnect bundle
// or other connector; the SDK exposes `evmWallet(provider)` and does not load a vendor at runtime.

await build({
  entryPoints: [join(ROOT, "tools", "sdk-browser-entry.mjs")],
  outfile: OUT,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { global: "globalThis" },
  // The bundle contains the go-dleq port, whose licence differs from the rest of the package. The banner is a legal
  // comment esbuild preserves, so a consumer of the built file sees where the LGPL part and its text live.
  banner: { js: "/*! @ninsei-labs/sdk includes a port of github.com/athanorlabs/go-dleq, licensed LGPL-3.0-only. See THIRD_PARTY_NOTICES.md. */" },
  logLevel: "info",
});
console.log("built:", OUT, "-", ((await stat(OUT)).size / 1024).toFixed(0), "KiB");
