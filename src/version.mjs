// THE PACKAGE VERSION AS A VALUE, BAKED INTO THE CODE.
//
// A consumer that has to agree with a peer on a minor line - a node refusing a client built from a different
// minor - needs the number at runtime, and a page cannot fetch it: package.json is not part of a bundle and need
// not be served beside it. So the number is a constant, and this file is GENERATED from package.json by
// tools/sync-version.mjs. Do not edit it by hand - set the version in package.json and run `npm run sync:version`.
// The `version` check in tools/check.mjs refuses a mismatch, and refuses a runtime read of package.json here.

export const SDK_VERSION = "0.44.3";
