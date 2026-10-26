#!/usr/bin/env node
// THE TARBALL MUST BE USABLE BY A CONSUMER, NOT ONLY WELL-FORMED.
//
// `check:pack` reads the file list; it cannot see that an import from the packed tree resolves, that a subpath
// exports what its declaration promises, or that the engine's relative assets are in the tarball. This check packs
// the package, installs that tarball into an empty project and imports every public subpath from there.
//
// Run: node tools/check-packed-consumer.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };
const run = (args, cwd) => execFileSync(NPM, args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
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
    const code = `
      const names = ["", "/xmr", "/recovery", "/evm", "/networks", "/order", "/core", "/provider"];
      const seen = [];
      for (const suffix of names) {
        const mod = await import("@ninsei-labs/sdk" + suffix);
        seen.push([suffix || ".", Object.keys(mod).length]);
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

    console.log("=== 3) THE RELATIVE ASSETS THE ENGINE IMPORTS ARE IN THE TARBALL ===");
    const installed = join(consumer, "node_modules", "@ninsei-labs", "sdk");
    for (const rel of ["assets/vendors/atomic/atomic-browser.js", "assets/vendors/monero/monero-js-browser.js", "engine/atomic/order-worker.js", "index.d.ts"]) {
      if (existsSync(join(installed, rel))) ok(rel + " is present");
      else bad(rel + " is missing from the installed package");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "packed consumer: " + pass + " checks passed.");
if (fails.length) process.exit(1);
