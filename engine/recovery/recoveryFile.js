// GENERATED FILE - a byte-for-byte copy of the engine module www/js/recovery/recoveryFile.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// The deal recovery file: real cryptography in the browser (WebCrypto).
//
// Litepaper §5: without a saved recovery file a deal is not funded; if the tab is lost, this file is the only way
// to claim the XMR or refund the ETH (including through a standalone client without the site). So it is real
// AES-GCM, not a stub: the file can be decrypted only with the password the user knows.
//
// File format (Ninsei-swap-<id>.json.enc):
//   { v:2, alg:"AES-GCM-256/PBKDF2-SHA256", iter, salt, iv, ciphertext, meta:{id,side,createdAt} }
// Inside ciphertext is the payload (see buildPayload), versioned separately: the envelope version (v) and the
// payload version (version) change independently - encryption and deal content are different things.
//
// WHAT IS IN THE PAYLOAD, AND WHY EXACTLY THIS
// v3: MY HALF of the spend key and MY HALF of the view key (spendHalf, viewHalf) plus the counterparty's PUBLIC
//   points (otherSpendPoint, otherViewPoint). No full spend key exists for ANYONE: the address is a sum of halves,
//   and only the holder of both can spend. The second half is given by the chain - hence the escrow address is in
//   the file too: the sweep reads the revealed half from it. The counterparty's points are public (they are in the
//   address and the order anyway), but without them the address cannot be assembled from the halves.
// v2: the mnemonic is the single source of keys: both the spend key and the view key derive from it. Keys are NOT
//   duplicated in the payload: a copy of the secret in the file is one more way to lose it and one more reason for
//   the fields to drift (the file used to carry both seedHex and the two private keys).
//   publicSpendKey /
//   publicViewKey /
//   address - for checking: if the mnemonic derives another address, the file is corrupt or substituted, and a
//     wallet must not be restored from it.
//   restoreHeight - the height to start the scan from. Without it the wallet scans Monero history from zero,
//     which is tens of hours (measured ~35 blocks/s). The deal's creation height is a correct floor: the XMR lock
//     cannot happen earlier.
//
// WHAT IS NOT IN THE FILE: the spend key in the clear (only inside the ciphertext), a card number, a withdrawal
// address, and anything not needed to complete or roll back the deal.
//
// THERE IS NO QUOTE KIND IN THE PAYLOAD, and the payload key set is not checked: a file issued earlier with an
// extra kind key is still read (the extra key just goes unread) and new files are issued without it. The format
// does not change: PAYLOAD_VERSION stays 3 - the quote kind never had to do with the file version.

// THE ENCRYPTION PARAMETERS ARE NAMED EXPLICITLY AND ARE NOT TAKEN FROM WEB-CRYPTO DEFAULTS.
// The tag length and the key length are part of the FORMAT, not an implementation detail: a file issued today must
// be readable years later, so both numbers stand in every call (encrypt/decrypt/deriveKey), live in frozen objects
// and were confirmed by MEASUREMENT: the tag length (ciphertext minus plaintext = 16 bytes) and the derived key
// length (256 bits - proven by decrypting with a key derived separately as 256 bits). The PBKDF2 iteration count
// is also part of the format, but it is DELIBERATELY changeable: it grows with time, and old files are then read
// by their own count (see ITER_MIN below).
//
//
// THE ITERATION COUNT: 600,000 - OWASP's recommendation for PBKDF2-HMAC-SHA256, i.e. when FIPS-140 requires
// a "work factor of 600,000 or more" with an internal HMAC-SHA-256 (the numbers come from GPU measurements on an
// RTX 4000, as of December 2022).
// WHY PBKDF2 AND NOT Argon2id/scrypt, WHICH OWASP RANKS HIGHER: a browser offers only what WebCrypto gives, and
// among password-hashing it has ONE - PBKDF2; Argon2id and scrypt are not in the standard. There is nothing to
// choose from, so at least the number correct for PBKDF2 matters.
// WHY 210,000 WAS WRONG: that number is in the OWASP table for PBKDF2-HMAC-SHA512 (220,000), while we use
// HMAC-SHA256 - the count was three times below the recommendation for our own algorithm.
// WHAT THIS DOES NOT GIVE, SO AS NOT TO BE MISLED: iterations raise the price of ONE guess (measured on the
// development machine: 210k - 109 ms, 600k - 283 ms; noticeably more on a weak device in a browser) but do not
// save a weak password: an offline brute force is bounded by the password ENTROPY, not by the count. The 12-char
// minimum remains the weak spot.
const ITER = 600_000;
// A FLOOR FOR FOREIGN FILES. The iteration count comes FROM THE FILE (otherwise it could not be raised without
// losing old files), so a weak value must meet a refusal: a file below the floor is not decrypted.
const ITER_MIN = 100_000;
const ITER_MAX = 10_000_000;
// The algorithm identifier is ONE string for the whole module: it used to be written twice (write and read), and a
// divergence between the copies would surface only on a live file.
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
const READABLE_ENVELOPE_VERSIONS = [1, 2];
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

// THE ITERATION COUNT IS A PARAMETER, NOT A CALL CONSTANT. On encryption it is ITER, on reading it is the number
// FROM THE FILE: the format stores it precisely so the count can be raised without losing already issued files.
// Reading used to take the constant and ignore the iter field entirely - so raising the count would have silently
// broken all old files, and the field in the file would have been decoration.
// AAD: THE HEADER IS UNDER AUTHENTICATION, NOT ONLY THE CIPHERTEXT. AES-GCM checks the integrity of what is passed
// to it as additionalData. Without AAD (as in version 1) only the ciphertext was covered, while `meta` - the deal
// id, side, time, terms hash - sits beside it and could be edited without a trace, and the reader would take the
// substituted value. The string is built by both writer and reader FROM THE SAME FIELDS IN THE SAME ORDER: any
// field edit changes the string and decryption is rejected.
// WHY AN ARRAY, NOT AN OBJECT: key order in an object is a JSON implementation detail and an "identical" object
// can yield different text. And why ?? null: a missing field in the array would give undefined, which is another
// value.
// EXPORTED ON PURPOSE: the string is part of the FORMAT, and checks must build it with the same code, not their
// own copy (a copy would diverge from the format exactly where it costs most).
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

// THE HEIGHT TO START THE RECOVERY SCAN FROM. A pure function: it goes nowhere, so it is checked without a node -
// and that matters, because this is exactly where the height used to get lost.
//
// WHY TWO SOURCES. The height was taken ONLY from the Monero node, and when the node did not answer, null was
// honestly written into the file. Recovery then scanned history from zero (tens of hours), although the exact deal
// height was at hand: the escrow is created by a transaction and its block is in the receipt. The node is someone
// else's service that may be down (a live proxy returned 502), while the deal is our own and already exists.
//
// TAKE THE SMALLER AND STEP BACK A BLOCK. The XMR arrival may land a block earlier than the recorded height, and a
// scan that starts below the money finds it; one that starts above never does. Hence Math.min and minus one, but
// never below one.
// THE THIRD SOURCE - THE APPLICATION. Old deal records have no birthHeight field (it appeared later), but the app
// resolved and stored the height when it registered the watch; the page gets it from its server. This is OUR
// source, so it does not depend on whether the Monero node answers now, and it is what saves already issued
// files: their record has no height at all.
export function scanStartHeight({ escrowBirthHeight = null, serverRestoreHeight = null, nodeHeight = null } = {}) {
  const known = [escrowBirthHeight, serverRestoreHeight, nodeHeight]
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (known.length === 0) return null;
  return Math.max(1, Math.min(...known) - 1);
}

// The payload: everything needed to complete or roll back the deal without the site. restoreHeight is passed by
// the caller - scanStartHeight puts it here, and the module does not go to the network itself so it can be tested
// without a node.
export function buildPayload({ swap, swapWallet, escrow, receiveAddress, restoreHeight = null }) {
  return {
    magic: FILE_MAGIC,
    // THE VERSION REFLECTS THE CONTENT, NOT THE MODULE VERSION. It used to hold PAYLOAD_VERSION, so after halves
    // appeared a file built from a mnemonic got number 3 - claiming content it did not have, and the check rightly
    // rejected it. The number must tell the truth about the content: a halves file is three, a mnemonic file is two.
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
  if (!passphrase || passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters");
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
export async function decryptFile(fileObject, passphrase) {
  if (!fileObject || typeof fileObject !== "object") throw new Error("Not a recovery file (expecting JSON)");
  if (!READABLE_ENVELOPE_VERSIONS.includes(fileObject.v)) throw new Error(`Unsupported recovery file version: ${fileObject.v}`);
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
