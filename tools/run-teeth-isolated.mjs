#!/usr/bin/env node
// RUN A TEETH SCRIPT IN A THROWAWAY COPY OF THE TREE.
//
// A teeth script deliberately damages a source file, runs the guard, and restores the bytes in `finally`. A hard
// kill (SIGKILL, a job timeout, a power loss) skips `finally` and can leave the working checkout modified. The
// copy here is the isolation boundary: the repository that runs this command is never the tree the mutation sees.
//
// The copy carries sources, tests, tools and assets; `node_modules` is linked, not copied. The command is a child
// process, so a mutation cache cannot leak into the next case. A failed script is still a failed run, and the
// temporary tree is removed after the child exits.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const targetArg = process.argv[2];
if (!targetArg) {
  console.error("usage: node tools/run-teeth-isolated.mjs tools/check-*-teeth.mjs");
  process.exit(2);
}
const target = resolve(ROOT, targetArg);
if (!existsSync(target)) {
  console.error("no such teeth script: " + targetArg);
  process.exit(2);
}

// The generated and VCS directories are not inputs to a teeth run. `assets` and `engine` are: the guards import
// the browser bundle and the mirrored engine, and a missing asset makes the child fail for the wrong reason.
const SKIP = new Set(["node_modules", ".git", "coverage", ".hermes", "out", "cache", "dist"]);
const temp = mkdtempSync(join(tmpdir(), "sdk-teeth-isolated-"));
try {
  cpSync(ROOT, temp, {
    recursive: true,
    filter: (source) => {
      const rel = relative(ROOT, source);
      if (!rel) return true;
      return !SKIP.has(rel.split(sep)[0]);
    },
  });
  const modules = join(ROOT, "node_modules");
  if (existsSync(modules)) {
    symlinkSync(modules, join(temp, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  const targetCopy = join(temp, relative(ROOT, target));
  console.log("isolated teeth: " + targetArg + " in " + temp);
  execFileSync(process.execPath, [targetCopy], {
    cwd: temp,
    stdio: "inherit",
    env: { ...process.env, SDK_TEETH_ISOLATED: "1" },
  });
} finally {
  // Windows can hold a module handle for a moment after the child exits; retries make cleanup best-effort without
  // hiding a red child. The repository is untouched either way.
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
