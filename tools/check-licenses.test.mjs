import assert from "node:assert/strict";
import test from "node:test";
import { licenseAllowed, summary, violations } from "./check-licenses.mjs";

test("the allowlist is a permission set, not a spelling match", () => {
  for (const license of ["MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause", "Unlicense", "0BSD", "CC0-1.0"]) {
    assert.equal(licenseAllowed(license), true, license);
  }
  for (const license of ["GPL-3.0-only", "AGPL-3.0", "LGPL-2.1", "BUSL-1.1", "UNLICENSED", "UNKNOWN", "SEE LICENSE IN LICENSE", ""]) {
    assert.equal(licenseAllowed(license), false, license);
  }
});

test("SPDX expressions are read by OR, AND and parentheses", () => {
  assert.equal(licenseAllowed("MIT OR Apache-2.0"), true);
  assert.equal(licenseAllowed("MIT AND ISC"), true);
  assert.equal(licenseAllowed("MIT AND GPL-3.0-only"), false);
  assert.equal(licenseAllowed("(MIT OR GPL-3.0-only) AND ISC"), true);
  assert.equal(licenseAllowed("(MIT OR GPL-3.0-only) AND LGPL-2.1"), false);
  assert.equal(licenseAllowed("Apache-2.0 WITH LLVM-exception"), true);
});

test("violations name the license and the package, and the summary counts packages", () => {
  const report = {
    MIT: [{ name: "a", versions: ["1.0.0"] }, { name: "b", versions: ["2.0.0"] }],
    "GPL-3.0-only": [{ name: "c", versions: ["3.0.0"] }],
    "MIT OR Apache-2.0": [{ name: "d", versions: ["4.0.0"] }],
  };
  assert.deepEqual(violations(report), [{ license: "GPL-3.0-only", package: "c@3.0.0" }]);
  assert.deepEqual(summary(report), {
    packages: 4,
    licenses: [
      { license: "MIT", count: 2 },
      { license: "GPL-3.0-only", count: 1 },
      { license: "MIT OR Apache-2.0", count: 1 },
    ],
  });
});
