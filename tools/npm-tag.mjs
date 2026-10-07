#!/usr/bin/env node
// WHICH npm DIST-TAG A VERSION PUBLISHES UNDER - DERIVED FROM THE VERSION, never left to a default.
//
// WHY THIS EXISTS. An npm publish sets the `latest` dist-tag to the published version unless `--tag` is given:
// "Publishing a package sets the `latest` tag to the published version unless the `--tag` option is used"
// (https://docs.npmjs.com/cli/v11/commands/npm-dist-tag), and the `tag` config itself defaults to "latest"
// (https://docs.npmjs.com/cli/v11/using-npm/config#tag). So an unpinned publish is exactly what moves `latest` -
// and a build for ourselves must never move it. Modern npm also refuses a prerelease publish that carries no
// explicit tag ("You must specify a tag using --tag when publishing a prerelease version"), which is the same
// line this file draws, only earlier and under our own names.
//
// THE CYCLE THIS ENCODES:
//   X.Y.Z              -> latest    a RELEASE: a separate decision, and the only thing that moves `latest`.
//   X.Y.Z-develop.N    -> develop   a build for ourselves; the demo pins the EXACT version, not the tag.
//   X.Y.Z-preview.N    -> preview   a build to show, pinned the same way.
// A prerelease NEVER takes `latest`, and a plain version does not slide into a channel someone else owns. Both
// are refusals that NAME the case (see `guard`), so a wrong version fails the release step instead of tagging
// quietly.
//
// USAGE:
//   node tools/npm-tag.mjs <version>                   print the derived tag; refuse (exit 1), naming the case
//   node tools/npm-tag.mjs <version> --override <tag>  use <tag> instead - a human decision, named on stderr
// The bare tag goes to STDOUT and everything explaining it to STDERR, so `tag=$(node tools/npm-tag.mjs ...)`
// captures the tag alone while the run's log still shows what was decided and why.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const STABLE_TAG = "latest";

// THE DECLARED CHANNELS. Keyed by the FIRST identifier of the prerelease part: `0.40.0-develop.1` publishes under
// `develop`. An identifier that is not here is refused rather than guessed at - a typo must not invent a channel,
// and an undeclared channel must not fall back to `latest`.
const CHANNEL_TAGS = { develop: "develop", preview: "preview" };

// X.Y.Z with an optional -prerelease and optional +build metadata. Deliberately stricter than semver: the
// package's version has exactly this shape, and anything else is a typo worth naming.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// A dist-tag shares a namespace with version numbers, so npm rejects a tag that reads as a semver range (`v1.4`)
// and recommends tags that begin with neither a digit nor a `v`.
const TAG_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;

const refuse = (message) => {
  throw new Error(message);
};

/** `X.Y.Z[-pre.N][+build]` -> the core and the prerelease identifiers. Anything else is a named refusal. */
export const parseVersion = (raw) => {
  const version = typeof raw === "string" ? raw.trim() : "";
  if (!VERSION_RE.test(version)) {
    refuse(`not a version: ${JSON.stringify(raw)} (want X.Y.Z, X.Y.Z-develop.N or X.Y.Z-preview.N)`);
  }
  const [, major, minor, patch, pre] = VERSION_RE.exec(version);
  return { core: `${major}.${minor}.${patch}`, prerelease: pre ? pre.split(".") : [] };
};

export const isPrerelease = (version) => parseVersion(version).prerelease.length > 0;

/** The tag a version derives to: `latest` for a plain version, the channel name for a declared prerelease. */
export const tagFor = (version) => {
  const { prerelease } = parseVersion(version);
  if (prerelease.length === 0) return STABLE_TAG;
  const channel = prerelease[0];
  const tag = CHANNEL_TAGS[channel];
  if (!tag) {
    refuse(`prerelease channel ${JSON.stringify(channel)} is not declared (declared: ${Object.keys(CHANNEL_TAGS).join(", ")})`);
  }
  return tag;
};

/** A dist-tag npm will accept: no semver-shaped names, no whitespace. */
export const validateTag = (tag) => {
  if (typeof tag !== "string" || !TAG_RE.test(tag)) refuse(`not a usable dist-tag: ${JSON.stringify(tag)}`);
  if (/^v\d/.test(tag)) refuse(`a dist-tag must not read as a version: ${JSON.stringify(tag)}`);
  return tag;
};

/**
 * THE TOOTH. Two directions, both refusals that NAME the case:
 *  - a prerelease must never take `latest` - not even under a manual override;
 *  - a plain version must not take a channel tag that is not `latest` unless a person decided so (`--override`).
 */
export const guard = (version, tag, { override = false } = {}) => {
  const { prerelease } = parseVersion(version);
  if (prerelease.length > 0 && tag === STABLE_TAG) {
    refuse(`a prerelease (${version}) would take the "${STABLE_TAG}" dist-tag - a prerelease must never move ${STABLE_TAG}`);
  }
  if (prerelease.length === 0 && tag !== STABLE_TAG && !override) {
    refuse(`a plain version (${version}) would publish under the "${tag}" dist-tag - that channel belongs to a build for ourselves, and moving it needs an explicit decision (--override ${tag})`);
  }
  return tag;
};

/** version + optional human override -> the tag for `npm publish --tag`, where it came from, and the decision. */
export const resolveTag = (version, { override } = {}) => {
  const derived = tagFor(version);
  const given = typeof override === "string" && override.trim() !== "";
  const tag = given ? validateTag(override.trim()) : derived;
  guard(version, tag, { override: given });
  return {
    tag,
    derived,
    overridden: given,
    decision: given ? "manual override - a decision by the person who started the run" : "derived from the version",
  };
};

const main = () => {
  const [version, ...rest] = process.argv.slice(2);
  if (!version) {
    process.stderr.write("usage: node tools/npm-tag.mjs <version> [--override <tag>]\n");
    process.exitCode = 2;
    return;
  }
  const at = rest.indexOf("--override");
  const override = at >= 0 ? rest[at + 1] : undefined;
  if (at >= 0 && (override === undefined || override.startsWith("--"))) {
    process.stderr.write("--override needs a tag value\n");
    process.exitCode = 2;
    return;
  }
  try {
    const { tag, derived, decision } = resolveTag(version, { override });
    process.stderr.write(`dist-tag: version ${version} -> ${tag}  [${decision}; the derivation alone would say ${derived}]\n`);
    process.stdout.write(`${tag}\n`);
  } catch (error) {
    process.stderr.write(`dist-tag: REFUSED - ${error.message}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
