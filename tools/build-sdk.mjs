// BUILD THE BROWSER BUNDLE THE PAGE IMPORTS.
//
// One entry, one output, no runtime build on the page. The output is committed: the page stays static, and the
// bridge's `?v=<hash>` link is updated separately. Nothing here minifies the other vendor bundles; they have their
// own sources and are only pinned by `assets/vendors/MANIFEST.json`.
import { build } from "esbuild";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "vendors", "sdk", "sdk-browser.js");

await build({
  entryPoints: [join(ROOT, "tools", "sdk-browser-entry.mjs")],
  outfile: OUT,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { global: "globalThis" },
  logLevel: "info",
});
console.log("built:", OUT, "-", ((await stat(OUT)).size / 1024).toFixed(0), "KiB");
