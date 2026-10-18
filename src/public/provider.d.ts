// DECLARATIONS FOR THE `./provider` ENTRY: the node-side helpers, Node only.
//
// These declarations name what `src/public/provider.mjs` re-exports: identity, signing and env files. Every
// signature is copied from the modules the barrel re-exports (`src/provider/identity.mjs`, `sign.mjs`,
// `envFile.mjs`), and a symbol the barrel does not re-export is not declared here.
//
// NOT FOR A BROWSER. These functions use `node:crypto`, `node:fs` and `node:path`; a page must import from the
// browser entries instead.

/** The shape of a provider code: `lp-` and eight lowercase hex digits, derived from the provider's address. */
export declare const PROVIDER_CODE_RE: RegExp;

/** The longest display name a provider may set. */
export declare const DISPLAY_NAME_MAX: number;

/** The provider code of an address: stable for the address, independent of any key. Throws on a malformed address. */
export declare function providerCode(address: string): string;

/** A display name the operator may keep or replace: a word and four hex digits. */
export declare function randomDisplayName(): string;

/** The canonical JSON a signature covers: keys sorted at every level, so two writers agree on the bytes. */
export declare function canonical(payload: unknown): string;

/** A signed package: the payload's fields plus the detached signature and the key identity that made it. */
export interface SignedPayload {
  readonly [field: string]: unknown;
  readonly signature: string;
  readonly keyId?: string;
}

/** Signs the canonical form of the payload with a PEM private key. */
export declare function signPayload(payload: Record<string, unknown>, privateKeyPem: string, keyId?: string): SignedPayload;

/** Verifies a signed package against a PEM public key. False means refused, never "probably fine". */
export declare function verifyPayload(pkg: SignedPayload, publicKeyPem: string): boolean;

/** The public key file that belongs to a private key file: `x.key` becomes `x.pub`. */
export declare function publicKeyPath(keyFile: string): string;

/** Creates a key pair on disk and writes the public half beside it. Refuses to overwrite unless `force`. */
export declare function generateKeyFiles(options?: { readonly keyFile?: string; readonly force?: boolean }): {
  readonly key?: string;
  readonly file?: string;
  readonly why?: string;
};

/** The raw seed bytes of a PEM private key, for consumers that must not keep the PEM. */
export declare function privateKeySeedBytes(privateKeyPem: string): Uint8Array;

/** Reads a PEM private key from a file. */
export declare function loadPrivateKey(keyFile: string): string;

/** The base64 SPKI form of a public key, from either a public or a private PEM. */
export declare function publicKeyBase64From(publicKeyPem: string): string;

/** The base64 public key that belongs to a private key. */
export declare function signingPublicKeyBase64(privateKeyPem: string): string;

/** The base64 public key held in a public key file, or a named reason when it is missing. */
export declare function publicKeyFileBase64(pubFile: string): { readonly key: string | null; readonly why?: string };

/** What the node reports about its own key: the key, its file, and whether the two halves agree. */
export declare function nodePublicKeyReport(options?: {
  readonly privateKeyPem?: string | null;
  readonly keyFile?: string | null;
  readonly pubFile?: string | null;
}): { readonly key: string | null; readonly file?: string | null; readonly matches?: boolean | null; readonly why?: string };

/** The settings files looked up, in order, when none is named. */
export declare const ENV_CANDIDATES: readonly string[];

/** The first settings file that exists under `cwd`, or null. */
export declare function findEnvFile(cwd: string, candidates?: readonly string[]): string | null;

/** A Windows path found in a settings file on a non-Windows system, or null when the file is usable. */
export declare function foreignPathProblem(
  file: string,
  values: Record<string, string>,
  platform?: string,
): { readonly file: string; readonly key: string; readonly value: string } | null;

/** The sentence that explains a foreign path to an operator. */
export declare function foreignPathMessage(problem: { readonly file: string; readonly key: string; readonly value: string }): string;

/** Reads a settings file into a plain object of its values. */
export declare function readEnvFile(path: string): Record<string, string>;

/** Substitutes `${STACK_DATA}` and `${ROOT}` in a setting value. */
export declare function substituteEnvVars(value: unknown, paths: { readonly dataDir: string; readonly root: string }): string;

/** Applies a settings file to a target object (the process environment by default) and returns the names set. */
export declare function applyEnvFile(path: string, target?: Record<string, string | undefined>): string[];
