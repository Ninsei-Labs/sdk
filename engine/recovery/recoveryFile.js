// The deal recovery file: WebCrypto AES-GCM, not a stub.
//
// The file is the only way to claim the XMR or refund the ETH after the tab is lost. It decrypts only with the
// password the user knows.
//
// File format (Ninsei-swap-<id>.json.enc):
//   { v:2, alg:"AES-GCM-256/PBKDF2-SHA256", iter, salt, iv, ciphertext, meta:{id,side,createdAt} }
// The envelope version (v) and the payload version (version) change independently.
//
// Payload:
// v3: my spend half and my view half, plus the counterparty's public points. The escrow address is here too, because
//   the sweep reads the revealed half from it.
// v2: the mnemonic is the single source of keys. The payload also carries the public spend key, the public view key,
//   the address for checking and the scan start height. Without the height the wallet scans from zero.
//
// The file does not carry the spend key in clear, a card number or a withdrawal address.
// A file with an extra kind key is still read. New files do not carry that key.

// The encryption parameters are explicit, not WebCrypto defaults. The tag length, key length and iteration count are
// part of the format. The iteration count can grow, and old files are read with their own count (see ITER_MIN).
//
// PBKDF2 is the only password KDF in WebCrypto. Argon2id and scrypt are not available. The count is 600,000 for
// PBKDF2-HMAC-SHA256. A weak password remains the weak point; iterations raise the cost of one guess.
const ITER = 600_000;
// The iteration count comes from the file, so a weak value must be refused.
const ITER_MIN = 100_000;
const ITER_MAX = 10_000_000;
// One algorithm identifier for writes and reads.
const ALG_ID = "AES-GCM-256/PBKDF2-SHA256";
const AES = Object.freeze({ name: "AES-GCM", tagLength: 128, keyBits: 256 });
const KDF = Object.freeze({ name: "PBKDF2", hash: "SHA-256" });
const te = new TextEncoder();
const td = new TextDecoder();

export const FILE_MAGIC = "NINSEI-SWAP-RECOVERY";

// The envelope version (encryption) and the payload version (deal content) are different numbers.
// ENVELOPE VERSION: 1 - no AAD (all files issued before it was added), 2 - the header is authenticated (AAD).
// BOTH must be readable: people hold version-1 files and they must not be lost. The version is raised when the
// ENVELOPE itself changes, not the payload inside.
export const ENVELOPE_VERSION = 2;
// v3 - NO ENCRYPTION. An empty passphrase writes the payload in the clear and the envelope says so. It is a
// deliberate choice by the owner: a forgotten passphrase locks a person out of their own money, and the file is
// still the only way to the XMR. Readers of every version must keep working.
export const UNENCRYPTED_ENVELOPE_VERSION = 3;
export const ALG_NONE = "NONE";
const READABLE_ENVELOPE_VERSIONS = [1, 2, 3];
export const PAYLOAD_VERSION = 3;
// v1 - the very first files (seedHex and both keys as separate fields), v2 - the mnemonic as the single source,
// v3 - HALVES. All three must be readable: people hold files of every version, and a recovery file is the only way
// to claim your XMR. Old versions must not be dropped.
const SUPPORTED_PAYLOAD_VERSIONS = [1, 2, 3];
// NETWORKS THE FILE READER KNOWS. The three standard ones plus fakechain - the official name of monerod's regtest
// mode: the CI contour node calls itself exactly that, and a file issued on such a network must be readable. The
// list is by name: a network outside it is rejected as unknown, and that stays.
const NETWORKS = ["mainnet", "stagenet", "testnet", "fakechain"];

function b64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// The iteration count is a parameter, not a call constant. Encryption uses ITER; reading uses the count from the
// file. The format stores it so the count can grow without losing old files.
// AAD: the header is authenticated, not only the ciphertext. Version 1 has no AAD, so a version-1 file must decrypt
// without it. The string is built by both writer and reader from the same fields in the same order.
// An array, not an object: object key order is a JSON implementation detail. Missing fields become null.
// Exported so checks build the same string, not a copy.
export function envelopeAad(envelope) {
  const m = envelope.meta || {};
  return JSON.stringify([
    envelope.v, envelope.alg, envelope.iter, envelope.salt, envelope.iv,
    m.id ?? null, m.side ?? null, m.createdAt ?? null, m.termsHash ?? null,
  ]);
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase), KDF.name, false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: KDF.name, salt, iterations, hash: KDF.hash },
    base,
    { name: AES.name, length: AES.keyBits },
    false,
    ["encrypt", "decrypt"]
  );
}

// The recovery scan start height. This is a pure function, so a test can run it without a node.
//
// The height has three sources: the escrow birth height from the receipt, the application's stored height and the
// Monero node height. The node is an external service and can be down. The deal height is ours and already exists.
//
// Use the smallest source and subtract one block. The XMR arrival can land one block before the recorded height. A
// scan that starts too high never finds the money.
export function scanStartHeight({ escrowBirthHeight = null, serverRestoreHeight = null, nodeHeight = null } = {}) {
  const known = [escrowBirthHeight, serverRestoreHeight, nodeHeight]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (known.length === 0) return null;
  return Math.max(1, Math.min(...known) - 1);
}

// The payload. `restoreHeight` is passed by the caller; scanStartHeight computes it. This module never reads the
// network.
export function buildPayload({ swap, swapWallet, escrow, receiveAddress, restoreHeight = null }) {
  return {
    magic: FILE_MAGIC,
    // The version reflects the content, not the module version. A halves file is 3. A mnemonic file is 2.
    version: swapWallet && swapWallet.spendHalf ? 3 : 2,
    swapId: swap.id,
    // The order terms hash FROM THE CONTRACT. It is the file's tie to the chain: knowing the terms, one can check
    // the file belongs to this very order. The field is OPTIONAL: files issued earlier lack it and must still read.
    termsHash: (swap.escrow && swap.escrow.termsHash) || null,
    side: swap.side,
    network: swap.network,
    moneroNetwork: swap.moneroNetwork,
    createdAt: swap.createdAt,
    pay: { token: swap.payToken, amount: swap.payAmount },
    receive: { token: "XMR", amount: swap.xmrAmount, address: receiveAddress },
    rate: swap.rate,
    maker: swap.maker,
    quote: { signature: swap.quoteSignature, nonce: swap.quoteSignature ? swap.quoteSignature.slice(-8) : null },
    escrow: escrow || swap.escrow || null,
    // v3 (halves) and v2 (mnemonic) are different content, incompatible: v3 has NO mnemonic, because no full spend
    // key exists. What to write is decided by the wallet source.
    moneroWallet: swapWallet
      ? swapWallet.spendHalf
        ? {
            source: "halves",
            library: swapWallet.library || null,
            network: swapWallet.network,
            address: swapWallet.address,
            subaddress: swapWallet.subaddress || null,
            spendHalf: swapWallet.spendHalf,
            viewHalf: swapWallet.viewHalf,
            otherSpendPoint: swapWallet.otherSpendPoint,
            otherViewPoint: swapWallet.otherViewPoint,
            // THE COUNTERPARTY'S VIEW HALF - and it is not a secret. The full VIEW key (the sum of two halves) lets
            // one SEE incoming funds and not spend them; spending needs the sum of the SPEND halves. Without the
            // other view half the wallet cannot find our XMR on chain: the spend halves alone are not enough for
            // the scan, and Monero's view and spend keys are independent.
            otherViewHalf: swapWallet.otherViewHalf || null,
            escrowAddress: (escrow && escrow.address) || (swap.escrow && swap.escrow.address) || null,
            restoreHeight: Number.isFinite(restoreHeight) ? restoreHeight : null,
          }
        : {
            source: swapWallet.source,
            library: swapWallet.library || null,
            network: swapWallet.network,
            address: swapWallet.address,
            subaddress: swapWallet.subaddress || null,
            mnemonic: swapWallet.mnemonic || null,
            publicSpendKey: swapWallet.publicSpendKey,
            publicViewKey: swapWallet.publicViewKey,
            restoreHeight: Number.isFinite(restoreHeight) ? restoreHeight : null,
          }
      : null,
    deadlines: swap.timeline,
    recoveryClient: "any standalone client implementing the Ninsei swap protocol (see litepaper §5.3)",
  };
}

// Payload validation AFTER decryption. A separate function, because garbage can decrypt too (the password
// matched but the content is wrong) and because checks must hit each field separately. It throws with a clear
// cause instead of failing deep inside wallet recovery. No secrets appear in error text: a mnemonic is a spend key.
export function validatePayload(payload) {
  const fail = (m) => {
    throw new Error("Corrupt recovery file: " + m);
  };
  if (!payload || typeof payload !== "object") fail("the content is not an object");
  if (payload.magic !== FILE_MAGIC) fail("foreign file (no Ninsei mark)");
  if (!SUPPORTED_PAYLOAD_VERSIONS.includes(payload.version)) {
    fail(`payload version ${payload.version} is not supported (we support ${SUPPORTED_PAYLOAD_VERSIONS.join(", ")})`);
  }
  if (!payload.swapId) fail("no deal id");
  const m = payload.moneroWallet;
  if (!m || typeof m !== "object") fail("no Monero wallet data");
  if (payload.version >= 3) {
    // HALVES. There is no mnemonic here and there must not be: no full spend key exists for either side, and a
    // file that somehow contains one means the wallet was not built by the scheme.
    for (const field of ["spendHalf", "viewHalf", "otherSpendPoint", "otherViewPoint", "otherViewHalf"]) {
      if (!m[field]) fail("the halves file has no field " + field);
    }
    if (m.mnemonic) fail("the halves file contains a mnemonic - the wallet was not built by the scheme");
  } else {
    if (!m.mnemonic) fail("no mnemonic - there is nothing that can restore the wallet");
    const words = String(m.mnemonic).trim().split(/\s+/).length;
    if (words !== 25 && words !== 13 && words !== 24) fail(`the mnemonic does not look like a Monero phrase (${words} words)`);
  }
  if (!m.address) fail("no wallet address - nothing to check the restored one against");
  const net = m.network || payload.moneroNetwork;
  if (!NETWORKS.includes(net)) fail(`unknown network "${net}"`);
  if (m.network && payload.moneroNetwork && m.network !== payload.moneroNetwork) {
    fail(`the wallet network (${m.network}) does not match the deal network (${payload.moneroNetwork})`);
  }

  const warnings = [];
  if (!Number.isFinite(m.restoreHeight) || m.restoreHeight <= 0) {
    warnings.push(
      "no restore height (restoreHeight): the wallet will scan history from zero, " +
        "which is tens of hours - set the XMR lock height manually"
    );
  }
  if (payload.version === 1) {
    warnings.push("an old-format file (v1): its keys were separate fields, the spend key is taken from the mnemonic");
  }
  return { warnings };
}

export async function encryptPayload(payload, passphrase) {
  const metaOf = () => ({ id: payload.swapId, side: payload.side, createdAt: payload.createdAt, termsHash: payload.termsHash || null });
  // AN EMPTY PASSPHRASE MEANS NO ENCRYPTION, AND THE ENVELOPE SAYS SO. A provided one keeps the twelve character
  // floor: a short password is worse than none because it looks like protection.
  if (passphrase === "") {
    return { v: UNENCRYPTED_ENVELOPE_VERSION, alg: ALG_NONE, meta: metaOf(), payload };
  }
  if (typeof passphrase !== "string" || passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITER);
  // The header is built BEFORE encryption: it also serves as the AAD, so the ciphertext is tied to its content.
  const meta = { id: payload.swapId, side: payload.side, createdAt: payload.createdAt, termsHash: payload.termsHash || null };
  const header = { v: ENVELOPE_VERSION, alg: ALG_ID, iter: ITER, salt: b64(salt), iv: b64(iv) };
  const ct = await crypto.subtle.encrypt(
    { name: AES.name, iv, tagLength: AES.tagLength, additionalData: te.encode(envelopeAad({ ...header, meta })) },
    key,
    te.encode(JSON.stringify(payload, bigintSafe))
  );
  return { ...header, ciphertext: b64(ct), meta };
}

// Decryption. AES-GCM errors (wrong password, altered ciphertext) arrive as OperationError with no detail - we
// turn them into a human message, else the user sees "operation failed" and cannot tell a wrong password from a
// corrupt file.
// WHETHER A FILE ASKS FOR A PASSPHRASE. A page reads this before showing the field: an unencrypted file has none.
export function isEncrypted(fileObject) {
  return !!(fileObject && typeof fileObject === "object" && fileObject.alg !== ALG_NONE);
}

export async function decryptFile(fileObject, passphrase) {
  if (!fileObject || typeof fileObject !== "object") throw new Error("Not a recovery file (expecting JSON)");
  if (!READABLE_ENVELOPE_VERSIONS.includes(fileObject.v)) throw new Error(`Unsupported recovery file version: ${fileObject.v}`);
  if (fileObject.v === UNENCRYPTED_ENVELOPE_VERSION) {
    if (fileObject.alg !== ALG_NONE) throw new Error(`Unknown algorithm: ${fileObject.alg}`);
    if (!fileObject.payload || typeof fileObject.payload !== "object") throw new Error('Recovery file is missing "payload"');
    return fileObject.payload;
  }
  if (fileObject.alg !== ALG_ID) throw new Error(`Unknown algorithm: ${fileObject.alg}`);
  for (const field of ["salt", "iv", "ciphertext"]) {
    if (typeof fileObject[field] !== "string" || !fileObject[field]) throw new Error(`Recovery file is missing "${field}"`);
  }
  // THE ITERATION COUNT IS READ FROM THE FILE AND CHECKED. Below the floor - a refusal: a weak count must not lead
  // to a quiet decryption. Above the ceiling - also a refusal: that is no longer a file but an attempt to occupy the CPU.
  const iter = Number(fileObject.iter);
  if (!Number.isInteger(iter) || iter < ITER_MIN) {
    throw new Error(`Recovery file declares too few PBKDF2 iterations: ${fileObject.iter} (minimum ${ITER_MIN})`);
  }
  if (iter > ITER_MAX) {
    throw new Error(`Recovery file declares too many PBKDF2 iterations: ${iter} (maximum ${ITER_MAX})`);
  }
  const salt = unb64(fileObject.salt);
  const iv = unb64(fileObject.iv);
  const key = await deriveKey(passphrase, salt, iter);
  // AAD IS MIXED IN ONLY FROM VERSION 2. A version-1 file cannot take it: it was encrypted without AAD and would
  // decrypt for nobody with one - so the "improvement" would have wiped every old file.
  const additionalData = fileObject.v >= 2 ? te.encode(envelopeAad(fileObject)) : undefined;
  const decryptAlg = additionalData
    ? { name: AES.name, iv, tagLength: AES.tagLength, additionalData }
    : { name: AES.name, iv, tagLength: AES.tagLength };
  let pt;
  try {
    pt = await crypto.subtle.decrypt(decryptAlg, key, unb64(fileObject.ciphertext));
  } catch {
    throw new Error("Could not decrypt the file: wrong password or the file was altered");
  }
  let payload;
  try {
    payload = JSON.parse(td.decode(pt));
  } catch {
    throw new Error("It decrypted, but the content is not JSON - the file is corrupt");
  }
  validatePayload(payload);
  // IN VERSION 1 THE HEADER IS NOT AUTHENTICATED, SO WE CHECK IT AGAINST THE CONTENT. The meta of an old file can
  // be substituted (no AAD), but it cannot disagree with the data inside the ciphertext: the deal id must match.
  // For version 2 this is already redundant - AAD checks it.
  if (fileObject.meta && fileObject.meta.id != null && payload.swapId != null &&
      String(fileObject.meta.id) !== String(payload.swapId)) {
    throw new Error("The deal id in the header does not match the file content: the file was altered");
  }
  return payload;
}

// BigInt DOES NOT SERIALISE IN JSON, and key halves are BigInt: JSON.stringify FAILS on them and the recovery file
// is never issued. We turn BigInt into a hex string - same meaning, serialisable. The same handler sits in state
// writing (core/store.js): it is the same serialisation boundary.
const bigintSafe = (key, value) => (typeof value === "bigint" ? "0x" + value.toString(16) : value);
export async function createRecoveryFile(payload, passphrase) {
  const file = await encryptPayload(payload, passphrase);
  return JSON.stringify(file, bigintSafe, 2);
}

export function recoveryFileName(swapId) {
  // The file name is lowercase and tied to the swap: it shows which deal the file belongs to, and it can be
  // checked against the id on the server (same there). It used to be "Ninsei-swap-<id>.json.enc": a capital letter
  // and no tie to a specific swap when there is no id yet.
  // If there is no id yet (the file is downloaded before the swap is created) the name is FIXED, with no random tail.
  //
  // There used to be a random tail here: it stopped files overwriting each other, but in practice every click of
  // "Download recovery file" produced a NEW name and the downloads filled with a heap of look-alike files of
  // unclear origin. That is exactly what looked like "a different file every time". Now the name is stable and a
  // repeated download is marked (1) by the browser - clearer than a new random string. The name matches the one
  // already used on the server for an unfinished deal.
  const raw = String(swapId || "").trim();
  const known = raw && raw !== "pending" ? raw : "pending";
  // Lowercase and safe characters only: the name goes to a filesystem, where case and special characters behave
  // differently on Windows, Linux and macOS.
  const safe = known.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `ninsei-${safe}.json.enc`;
}
