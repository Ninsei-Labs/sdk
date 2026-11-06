// REPRODUCIBLE BUILD OF assets/vendors/walletconnect/wc-browser.js.
//
// The bundle is a browser composition of @walletconnect/ethereum-provider and qrcode. It is NOT an upstream
// release: the SDK owns the entry point and the esbuild settings. The lock file beside this script is the
// package-lock from arrakisswap-demo at commit c466583d3e7b9eea538d4de4d61e23ccbbebfd16, where this exact
// bundle was built and committed. `npm ci` plus this script reproduce it byte for byte.
//
// Reown AppKit is deliberately absent: its modal writes inline <style>, which the page CSP forbids. The SDK's
// own modal lives in engine/ui/walletModal.js.
//
// Run from this directory: npm ci && npm run build
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const OUT_FILE = join(ROOT, "assets", "vendors", "walletconnect", "wc-browser.js");

const require = createRequire(import.meta.url);
const POLYFILLS = {
  buffer: "buffer/",
  process: "process/browser.js",
  events: "events/",
};

function aliases() {
  const alias = {};
  for (const [name, pkg] of Object.entries(POLYFILLS)) {
    alias[name] = pkg.endsWith("/") ? require.resolve(pkg) : dirname(require.resolve(pkg));
  }
  return alias;
}

export async function buildWalletConnect({ outfile = OUT_FILE } = {}) {
  await mkdir(dirname(outfile), { recursive: true });
  const result = await build({
    entryPoints: [join(HERE, "entry.mjs")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    sourcemap: false,
    outfile,
    legalComments: "none",
    alias: aliases(),
    define: {
      "process.env.NODE_ENV": '"production"',
      global: "globalThis",
    },
    logLevel: "warning",
    metafile: true,
  });
  const bytes = await readFile(outfile);
  const { size } = await stat(outfile);
  const metaOutput = Object.entries(result.metafile.outputs)
    .find(([file]) => file.split(/[\\/]/).pop() === "wc-browser.js")?.[1];
  return {
    outfile,
    size,
    sha256: createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/g, "\n")).digest("hex"),
    largest: Object.entries(metaOutput?.inputs || {})
      .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
      .slice(0, 6),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await buildWalletConnect();
  console.log(`built ${result.outfile} - ${(result.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`sha256 ${result.sha256}`);
  console.log("largest parts:");
  for (const [file, info] of result.largest) console.log(`  ${(info.bytesInOutput / 1024).toFixed(0).padStart(6)} KB  ${file}`);
}
