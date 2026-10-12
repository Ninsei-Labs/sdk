#!/usr/bin/env node
// THE VERSION CONSTANT, WRITTEN FROM package.json - never typed, never fetched at runtime.
//
// WHY THE NUMBER IS BAKED IN AND NOT READ. The obvious short-cut is to import package.json as a JSON module and
// export its version. That works in Node, and it is refused on purpose because of what it means in a BROWSER:
// the page would FETCH package.json over HTTP from whatever server serves the bundle - a file that is not part of
// the bundle, that need not be deployed next to it, and whose absence would turn a version constant into a
// request failure. Whether a bundler happens to inline the JSON is the consumer's build detail, not a property
// this package can promise, and no entry of this package promises a file read.
// So the number is a plain constant. This script is what keeps it true: the release flow sets the version in
// package.json, runs this, and the `version` check (tools/check.mjs) refuses a mismatch - and also refuses a
// runtime read, so nobody can quietly turn the constant back into a fetch.
//
// USAGE: node tools/sync-version.mjs   (writes src/version.mjs; exit 0 when already in step)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET = join(ROOT, "src", "version.mjs");

// The shape this package is published with, deliberately stricter than semver: anything else is a typo worth
// naming rather than writing into a file a consumer will read.
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const versionOf = (pkg) => {
  const version = pkg && typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!VERSION_RE.test(version)) {
    throw new Error(`package.json carries no usable version: ${JSON.stringify(pkg && pkg.version)}`);
  }
  return version;
};

export const fileFor = (version) => `// THE PACKAGE VERSION AS A VALUE, BAKED INTO THE CODE.
//
// A consumer that has to agree with a peer on a minor line - a node refusing a client built from a different
// minor - needs the number at runtime, and a page cannot fetch it: package.json is not part of a bundle and need
// not be served beside it. So the number is a constant, and this file is GENERATED from package.json by
// tools/sync-version.mjs. Do not edit it by hand - set the version in package.json and run \`npm run sync:version\`.
// The \`version\` check in tools/check.mjs refuses a mismatch, and refuses a runtime read of package.json here.

export const SDK_VERSION = ${JSON.stringify(version)};
`;

export const sync = () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const version = versionOf(pkg);
  const wanted = fileFor(version);
  let current = null;
  try { current = readFileSync(TARGET, "utf8"); } catch { /* absent is a case, not an error */ }
  if (current === wanted) return { version, changed: false, was: null };
  const was = current && /export const SDK_VERSION = "([^"]*)"/.exec(current);
  writeFileSync(TARGET, wanted);
  return { version, changed: true, was: was ? was[1] : null };
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { version, changed, was } = sync();
    console.log(changed
      ? `src/version.mjs: SDK_VERSION ${was ? `"${was}" -> ` : ""}"${version}"`
      : `src/version.mjs: already "${version}", nothing to write`);
  } catch (error) {
    console.error(`sync-version refused: ${error && error.message}`);
    process.exitCode = 1;
  }
}
