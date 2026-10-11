// THE PACKAGE VERSION AS A VALUE, not only as a line in package.json.
//
// A consumer that has to agree with a peer on a minor line - a node refusing a client built from a different
// minor - needs the number at runtime. Reading package.json at runtime would drag a file system into a package
// that also runs in a browser, so the number is a constant; the `version` check keeps it equal to the file, and
// a release that forgets to move it goes red instead of shipping a lie.

export const SDK_VERSION = "0.40.0";
