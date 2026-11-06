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

// THE HEAVY VENDOR FILES STAY SEPARATE. `engine/evm/session.js` and the Monero adapter import their browser
// bundles dynamically; esbuild follows those imports unless they are kept external. Without this plugin the SDK
// bundle absorbs WalletConnect (about 2 MB), and the page pays for it
// on every load even when it never opens a WalletConnect session. The page serves these from `/assets/`.
const keepVendorsExternal = {
  name: "keep-vendors-external",
  setup(build) {
    build.onResolve({ filter: /assets\/vendors\// }, (args) => {
      const rel = args.path.slice(args.path.indexOf("assets/vendors/"));
      return { path: "/" + rel, external: true };
    });
  },
};

await build({
  entryPoints: [join(ROOT, "tools", "sdk-browser-entry.mjs")],
  outfile: OUT,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { global: "globalThis" },
  plugins: [keepVendorsExternal],
  // The bundle contains the go-dleq port, whose licence differs from the rest of the package. The banner is a legal
  // comment esbuild preserves, so a consumer of the built file sees where the LGPL part and its text live.
  banner: { js: "/*! @ninsei-labs/sdk includes a port of github.com/athanorlabs/go-dleq, licensed LGPL-3.0-only. See THIRD_PARTY_NOTICES.md. */" },
  logLevel: "info",
});
console.log("built:", OUT, "-", ((await stat(OUT)).size / 1024).toFixed(0), "KiB");
