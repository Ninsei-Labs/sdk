// Signing the quote packet of the RFQ node. Ed25519, canonical packet.
//
// WHY THIS FILE IS COPIED AND NOT TAKEN FROM OUR SIGNER APPLICATION. The node runs AT THE PROVIDER: he has no
// signer application of ours, and must not. An application that pulls code from a neighbouring directory is not
// standalone - and the node must start on its own.
//
// THE RISK OF THE THREE IMPLEMENTATIONS DIVERGING (the feeder, rfq, the interface backend) IS CLOSED NOT BY COMMON CODE, BUT BY A CHECK.
// the check on our side signs the same packet with both senders and confirms it with our
// backend, and also compares the signatures against each other. They cannot diverge unnoticed.
//
// Canonical form: all fields except signature, keys sorted, no spaces. The order of serialisation is part of
// the contract: if it diverges, the signatures stop matching for everyone at once.

import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The canonical form of the packet: the signature is excluded, the keys are sorted, there are no spaces.
export function canonical(payload) {
  const { signature, ...rest } = payload || {};
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      return Object.keys(v).sort().reduce((acc, k) => {
        acc[k] = sortKeys(v[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(sortKeys(rest));
}

export function signPayload(payload, privateKeyPem, keyId) {
  // IMPORTANT: the FINAL packet is signed, already including keyId. Otherwise the signature is computed over one set of
  // bytes while the check is over another (the check sees keyId in the packet), and one's own signature does not match.
  // Verified by a round-trip test: before this fix 'own packet' gave false.
  const pkg = { ...payload, keyId };
  const signature = nodeSign(null, Buffer.from(canonical(pkg), "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
  return { ...pkg, signature };
}

// The check is needed by the interface backend when it turns signature checking on. It is not called now,
// but it lies next to the signing: signing and checking must be computed the same way, otherwise they diverge.
export function verifyPayload(payload, publicKeyPem) {
  const { signature, ...rest } = payload || {};
  if (!signature) return false;
  try {
    return nodeVerify(null, Buffer.from(canonical(rest), "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// The public key path: beside the private one, by the same name without ".key" and with ".pub" at the end.
//   <path>.key -> <path>.pub
// That way the operator does not look for the file by eye and does not copy the key from the terminal output: both files appear together.
export function publicKeyPath(keyFile) {
  return String(keyFile).replace(/\.key$/i, "") + ".pub";
}

// Key pair generation: the private one goes to a file with permissions 0600, the public one - TO A FILE BESIDE it and to the output
// (the public one is not a secret, it is handy both to print and to keep as a file; the private one NEVER gets into the log).
//
// Overwriting an existing key is possible ONLY explicitly (force). Otherwise - a refusal: to silently wipe someone else's key
// means breaking the provider, and he learns about it by rejected quotes rather than by a message.
export function generateKeyFiles({ keyFile, force = false } = {}) {
  if (!keyFile) throw new Error("key file is not specified");
  if (existsSync(keyFile) && !force) {
    const e = new Error("key already exists: " + keyFile + " - it was NOT overwritten");
    e.code = "KEY_EXISTS";
    throw e;
  }
  // We create the keys directory ourselves: the keys lie apart from the code (keys/), and it may be absent on a fresh install.
  try { mkdirSync(dirname(keyFile), { recursive: true }); } catch { /* it is already there - not a reason to fall */ }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(keyFile, priv, { mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch { /* on some file systems there are no permissions - not a reason to fall */ }
  const pubFile = publicKeyPath(keyFile);
  writeFileSync(pubFile, pub, { mode: 0o644 });
  return { keyFile, pubFile, publicKeyPem: pub };
}

// Reading a key with a permission check: if the file is available to anyone besides the owner - a refusal, not silent work.
// THE RAW KEY BYTES - the material for deriving the halves for orders. For an ed25519 key this is exactly
// 32 bytes of a uniform seed: HMAC and hashing over them give a result indistinguishable from random.
//
// AN IMPORTANT CONSEQUENCE ONE MUST KNOW: the derivation requires the RAW key in the process. So a node whose
// signing key has moved into hardware (HSM, a hardware wallet) will not be able to issue an order quote - and this is
// an honest limitation, not a breakdown: while the key is there, the node is both identified and serves such quotes.
export function privateKeySeedBytes(privateKeyPem) {
  const ko = createPrivateKey(privateKeyPem);
  const jwk = ko.export({ format: "jwk" });
  if (!jwk || !jwk.d) throw new Error("could not get raw bytes from the signing key (an ed25519 key is required)");
  const bytes = Buffer.from(jwk.d, "base64url");
  if (bytes.length < 16) throw new Error("signing key is shorter than 16 bytes: unusable for half derivation");
  return new Uint8Array(bytes);
}

export function loadPrivateKey(keyFile) {
  const st = statSync(keyFile);
  // The permission check - only where permissions exist. On Windows there are no POSIX mode bits (the file is always seen
  // as 666), and access is defined by ACLs, not by these bits: refusing on Windows would mean not letting the
  // service start locally at all. This is not a weakening - on Linux the check works as it worked.
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new Error("key file is accessible to others: " + keyFile + " (mode 0600 is required)");
  }
  return readFileSync(keyFile, "utf8");
}

// THE NODE'S PUBLIC KEY: THE ONE IT SIGNS WITH, AND NOT THE CONTENT OF THE FILE BESIDE IT (partner request to the node).
//
// WHY FROM THE LOADED KEY AND NOT FROM THE .pub FILE. The signature is made by the key the node read at start
// (loadPrivateKey), so ITS public key must go out: the file beside it could be left from a former
// key, come from a backup or be substituted. A reader who took the key from the file would check the signature
// with the wrong key and would take a live node for a foreign one.
//
// WHY THE FILE IS STILL READ. A divergence of the file and the working key is a STATE, and it is NAMED
// (nodePublicKeyFileMatches: false), not hidden: other tools and a human read the file, and by it they
// judge the node. The file is re-read on EVERY read, not remembered at start: a file substituted beside the
// key must be visible at once, not at the next node start.
export function publicKeyBase64From(publicKeyPem) {
  return createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }).toString("base64");
}

// The SIGNING public key from a private PEM - with the same SPKI DER export as in the .pub file.
// createPublicKey accepts the PRIVATE PEM itself and derives the public key from it; a repeated call on a KeyObject
// (createPublicKey(createPublicKey(pem))) refuses - "expected private", so there is NO nesting here.
export function signingPublicKeyBase64(privateKeyPem) {
  return publicKeyBase64From(privateKeyPem);
}

// The content of the .pub file in the same form (base64 of SPKI DER), or the reason why it is absent.
export function publicKeyFileBase64(pubFile) {
  if (!pubFile) return { key: null, why: "the path of the public key file is not known" };
  if (!existsSync(pubFile)) return { key: null, why: "the public key file is missing: " + pubFile };
  try { return { key: publicKeyBase64From(readFileSync(pubFile, "utf8")), why: null }; }
  catch (e) { return { key: null, why: "the public key file could not be read: " + String((e && e.message) || e).slice(0, 140) }; }
}

// THE REPORT FOR THE nodePublicKey FIELD IN GET /v1/info. The shape is assembled by ONE place - here; the listener only
// returns it (makerApi.mjs), and the node passes its key (index.mjs), so the rule does not multiply.
// key - the public key the node SIGNS with; file - what lies in the file beside it; matches - whether they
// match (true/false, and null means 'nothing to compare with'); why - the reasons of the fields left null.
export function nodePublicKeyReport({ privateKeyPem = null, keyFile = null, pubFile = null } = {}) {
  const pubPath = pubFile || (keyFile ? publicKeyPath(keyFile) : null);
  const file = publicKeyFileBase64(pubPath);
  const why = {};
  if (file.why) why.nodePublicKeyFile = file.why;
  if (!privateKeyPem) {
    why.nodePublicKey = "the node has no signing key it could read" + (keyFile ? " (" + keyFile + ")" : "") + ", so the key it signs with is unknown";
    return { key: null, file: file.key, matches: null, why };
  }
  let key = null;
  try { key = signingPublicKeyBase64(privateKeyPem); }
  catch (e) { why.nodePublicKey = "the signing key could not be read: " + String((e && e.message) || e).slice(0, 140); }
  // A DIVERGENCE IS A NAMED STATE, NOT SILENCE: false is the name of the state, and both keys stand side by side,
  // so that one can sort it out without third-party tools. The node works with ITS OWN key meanwhile - it is loaded and
  // the packets are signed with it; the file does not replace the signature.
  const matches = key === null || file.key === null ? null : key === file.key;
  return { key, file: file.key, matches, why };
}
