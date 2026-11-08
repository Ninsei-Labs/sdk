#!/usr/bin/env node
// THE TARBALL MUST BE USABLE BY A CONSUMER, NOT ONLY WELL-FORMED.
//
// `check:pack` reads the file list; it cannot see that an import from the packed tree resolves, that a subpath
// exports what its declaration promises, or that the engine's relative assets are in the tarball. This check packs
// the package, installs that tarball into an empty project and imports every public subpath from there.
//
// Run: node tools/check-packed-consumer.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
// On Windows `execFileSync` cannot run `npm.cmd` directly; the old fix was `shell: true` with an argument array,
// which Node deprecates and which turns paths into shell text. Run npm's own JS entry with the current Node instead.
const NPM_CLI = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const HAS_NPM_CLI = existsSync(NPM_CLI);
let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const run = (args, cwd) => execFileSync(HAS_NPM_CLI ? process.execPath : NPM, HAS_NPM_CLI ? [NPM_CLI, ...args] : args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  // The fallback exists only for a Node distribution without npm beside it; it keeps the Windows path working.
  shell: !HAS_NPM_CLI && process.platform === "win32",
  env: { ...process.env, npm_config_update_notifier: "false" },
});

const work = mkdtempSync(join(tmpdir(), "ninsei-packed-"));
try {
  console.log("=== 1) PACK AND INSTALL THE TARBALL ===");
  let tarball = null;
  try {
    run(["pack", "--pack-destination", work], ROOT);
    tarball = readdirSync(work).find((name) => name.endsWith(".tgz")) || null;
  } catch (error) {
    bad("npm pack: " + String(error.stderr || error.message || error));
  }
  if (!tarball) {
    bad("no tarball was produced");
  } else {
    ok("packed " + tarball);
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }), "utf8");
    try {
      run(["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", join(work, tarball)], consumer);
      ok("the tarball installs in an empty project");
    } catch (error) {
      bad("install: " + String(error.stderr || error.message || error));
    }

    console.log("=== 2) EVERY PUBLIC SUBPATH IMPORTS FROM THE INSTALLED TREE ===");
    // THE LIST IS THE PACKAGE CONTRACT, NOT A SECOND HAND-WRITTEN COPY. Adding an export without adding it here
    // used to leave the new subpath untested; ./adapters and ./relay were exactly that gap.
    let suffixes = [];
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      suffixes = Object.keys(pkg.exports || {});
    } catch (error) {
      bad("package.json exports: " + String(error.message || error));
    }
    const code = `
      const root = await import("@ninsei-labs/sdk");
      const seen = [[".", Object.keys(root).length]];
      const names = ${JSON.stringify(suffixes.filter((suffix) => suffix.startsWith("./")))};
      for (const suffix of names) {
        const mod = await import("@ninsei-labs/sdk" + suffix.slice(1));
        seen.push([suffix, Object.keys(mod).length]);
      }
      console.log(JSON.stringify(seen));
    `;
    try {
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: consumer, encoding: "utf8" });
      const seen = JSON.parse(output.trim().split("\n").pop());
      if (seen.every(([, count]) => count > 0)) ok("all " + seen.length + " public subpaths import and export symbols");
      else bad("an empty subpath: " + JSON.stringify(seen));
    } catch (error) {
      bad("subpath import: " + String(error.stderr || error.message || error));
    }

    console.log("=== 3) THE TYPES IN THE TARBALL COMPILE FOR AN EXTERNAL CONSUMER ===");
    // THE WORKING-TREE CONSUMER IS NOT THE TARBALL. A declaration can resolve against the repository and still be
    // absent or unresolved after `npm pack`. Reuse the same consumer source, but compile it from the installed tree
    // with the repository's TypeScript binary and `skipLibCheck: false`.
    const consumerTs = readFileSync(join(ROOT, "tools", "ts-consumer", "consumer.ts"), "utf8");
    writeFileSync(join(consumer, "consumer.ts"), consumerTs, "utf8");
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
        noEmit: true, skipLibCheck: false, types: [], lib: ["ES2022", "DOM"],
      },
      include: ["consumer.ts"],
    }, null, 2) + "\n", "utf8");
    try {
      execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join(consumer, "tsconfig.json")],
        { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      ok("the packed declarations compile for an external consumer");
    } catch (error) {
      bad("packed TypeScript consumer: " + String(error.stdout || error.stderr || error.message || error).split("\n").slice(0, 4).join(" "));
    }

    // A DECLARATION THAT COMPILES EVERYTHING IS NOT A USEFUL DECLARATION. Prove the packed types reject a
    // concrete wrong argument; if this compiles, the subpath has fallen back to `any`.
    writeFileSync(join(consumer, "negative.ts"),
      'import { moneroFeeEstimate } from "@ninsei-labs/sdk/xmr";\nexport const bad = moneroFeeEstimate({ url: 1 });\n', "utf8");
    writeFileSync(join(consumer, "tsconfig.negative.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
        noEmit: true, skipLibCheck: false, types: [], lib: ["ES2022", "DOM"],
      },
      include: ["negative.ts"],
    }, null, 2) + "\n", "utf8");
    try {
      execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join(consumer, "tsconfig.negative.json")],
        { cwd: consumer, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      bad("the packed types accepted a number for a string option");
    } catch {
      ok("the packed types reject a wrong argument");
    }

    console.log("=== 4) THE RELATIVE ASSETS THE ENGINE IMPORTS ARE IN THE TARBALL ===");
    const installed = join(consumer, "node_modules", "@ninsei-labs", "sdk");
    for (const rel of ["engine/atomic/order.js", "index.d.ts"]) {
      if (existsSync(join(installed, rel))) ok(rel + " is present");
      else bad(rel + " is missing from the installed package");
    }
    // THE SECOND CRYPTO PATH IS GONE, NOT JUST UNUSED. A worker or its vendored bundle reappearing in the tarball
    // would bring back a verifier that does not check the knowledge proofs.
    // The WalletConnect bundle is host-owned: it must not return to the package either.
    for (const rel of ["assets/vendors/atomic/atomic-browser.js", "assets/vendors/walletconnect/wc-browser.js",
      "engine/atomic/order-worker.js", "engine/atomic/order-client.js",
      "engine/evm/asyncExec.js", "engine/evm/asyncLegs.js"]) {
      if (!existsSync(join(installed, rel))) ok(rel + " is not shipped");
      else bad(rel + " is still shipped");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "packed consumer: " + pass + " checks passed.");
if (fails.length) process.exit(1);
