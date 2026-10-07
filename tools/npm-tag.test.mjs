#!/usr/bin/env node
// THE TAG DERIVATION AS A TABLE. A version in, a dist-tag out, or a refusal that names the case - no guessing in
// between. This is the same module the release workflow calls, so a green run here is a statement about the tag
// the publish will actually use.
//
// WHAT IT DOES NOT DO: it never publishes and never talks to the registry. The publish is not exercisable
// locally (npm OIDC runs in GitHub Actions); what IS exercisable is the decision the workflow makes before it
// sends anything, and that is what this covers.
import { tagFor, resolveTag, guard } from "./npm-tag.mjs";

const DERIVE = [
  { version: "0.40.0", want: "latest", why: "a plain version is a release" },
  { version: "1.2.3", want: "latest", why: "" },
  { version: "0.40.0-develop.1", want: "develop", why: "a build for ourselves" },
  { version: "0.40.0-develop", want: "develop", why: "no counter is still the channel" },
  { version: "0.41.0-preview.2", want: "preview", why: "a build to show" },
  { version: "0.39.1+build.7", want: "latest", why: "build metadata is not a prerelease" },
];

const DERIVE_REFUSALS = [
  { version: "0.40.0-rc.1", match: /channel "rc" is not declared/, why: "an undeclared channel is not guessed at" },
  { version: "0.40.0-alpha", match: /channel "alpha" is not declared/, why: "" },
  { version: "0.40", match: /not a version/, why: "a two-part version is not X.Y.Z" },
  { version: "not-a-version", match: /not a version/, why: "garbage" },
  { version: "", match: /not a version/, why: "" },
  { version: "v0.40.0", match: /not a version/, why: "the v prefix belongs to the git tag, not the version" },
];

const RESOLVE = [
  { version: "0.40.0", override: undefined, want: "latest", why: "" },
  { version: "0.40.0-develop.1", override: undefined, want: "develop", why: "" },
  { version: "0.41.0-preview.2", override: undefined, want: "preview", why: "" },
  { version: "0.40.0", override: "develop", want: "develop", why: "a decision is allowed and named" },
  { version: "0.40.0-develop.1", override: "preview", want: "preview", why: "crossing channels is a decision too" },
];

const RESOLVE_REFUSALS = [
  { version: "0.40.0-develop.1", override: "latest", match: /must never move latest/, why: "THE TOOTH: a prerelease cannot be given latest" },
  { version: "0.41.0-preview.2", override: "latest", match: /must never move latest/, why: "the same, for the other channel" },
  { version: "0.40.0", override: "v1.4", match: /must not read as a version/, why: "npm rejects a semver-shaped tag" },
  { version: "0.40.0", override: "1.4", match: /not a usable dist-tag/, why: "" },
  { version: "0.40.0", override: "has space", match: /not a usable dist-tag/, why: "" },
];

// guard() called directly, so the two directions of the tooth are pinned separately from the derivation.
const GUARD = [
  { version: "0.40.0", tag: "latest", override: false, refusals: 0, why: "a plain version on latest is fine" },
  { version: "0.40.0", tag: "develop", override: false, refusals: 1, why: "THE TOOTH, direction 2: a plain version does not take a channel tag by itself" },
  { version: "0.40.0", tag: "develop", override: true, refusals: 0, why: "a decision may move it" },
  { version: "0.40.0-develop.1", tag: "develop", override: false, refusals: 0, why: "" },
  { version: "0.40.0-develop.1", tag: "latest", override: false, refusals: 1, why: "THE TOOTH, direction 1" },
  { version: "0.40.0-develop.1", tag: "latest", override: true, refusals: 1, why: "THE TOOTH holds even under an override" },
];

const rows = [];
let failed = 0;
const record = (ok, cells) => {
  if (!ok) failed += 1;
  rows.push([ok ? "ok" : "RED", ...cells]);
};

for (const c of DERIVE) {
  let got;
  try { got = tagFor(c.version); } catch (e) { got = `threw: ${e.message}`; }
  record(got === c.want, [c.version, "tag", c.want, got, c.why]);
}

for (const c of DERIVE_REFUSALS) {
  let got;
  try { got = tagFor(c.version); } catch (e) { got = e.message; }
  record(c.match.test(got), [JSON.stringify(c.version), "refuse", c.match.source.slice(0, 28), got, c.why]);
}

for (const c of RESOLVE) {
  let got;
  try { got = resolveTag(c.version, { override: c.override }).tag; } catch (e) { got = `threw: ${e.message}`; }
  record(got === c.want, [`${c.version}${c.override ? " --override " + c.override : ""}`, "tag", c.want, got, c.why]);
}

for (const c of RESOLVE_REFUSALS) {
  let got;
  try { got = resolveTag(c.version, { override: c.override }).tag; } catch (e) { got = e.message; }
  record(c.match.test(got), [`${c.version} --override ${c.override}`, "refuse", c.match.source.slice(0, 28), got, c.why]);
}

for (const c of GUARD) {
  let refusals = 0;
  let got = "";
  try { guard(c.version, c.tag, { override: c.override }); } catch (e) { refusals = 1; got = e.message; }
  record(refusals === c.refusals, [`guard(${c.version}, ${c.tag}${c.override ? ", override" : ""})`, c.refusals ? "refuse" : "allow", c.refusals ? "refuse" : "allow", refusals ? "refused" : "allowed", got || c.why]);
}

const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)));
const line = (cells) => cells.map((c, i) => (i < 4 ? c.padEnd(widths[i]) : c)).join("  ").replace(/\s+$/, "");
console.log("input".padEnd(widths[0]) + "  " + "kind".padEnd(widths[1]) + "  " + "want".padEnd(widths[2]) + "  " + "got".padEnd(widths[3]) + "  note");
for (const r of rows) console.log(line(r));
console.log(failed ? `FAILED: ${failed}/${rows.length} cases red` : `PASSED: all ${rows.length} cases green`);
process.exitCode = failed ? 1 : 0;
