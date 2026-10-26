// ONE RECOVERY KEY FOR EVERY SWAP: THE TAKER'S KEY, ITS HALVES, ITS FILE, AND THE SEARCH.
//
// The taker used to make a random secret per swap and ask a person to save a file before funding. One BIP39 key,
// made once and saved once, removes that step. The seeds of this module are the ONLY source of the taker's
// halves: the spend and view halves for swap number i come from halfFromSeed with a binding that is known at
// recovery time. The factory is deliberately not part of the binding: numbers then run across a redeployment,
// and the search reads every factory the caller names.
//
// THE KEY NEVER LEAVES THE CLIENT. The search sends an address and the OrderCreated topic to a log reader; it
// never sends the words, the seed, a half or a commitment. A service that answered "which of these are mine"
// would learn that the orders belong to one person.
//
// THIS MODULE DOES NOT SWITCH swaps.start. It is the foundation: the current per-swap flow keeps working until
// the node accepts the taker's maker view half and the page is rebuilt around the key.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createHalves } from "../engine/atomic/halves.js";
import { halfCommitmentHex } from "../engine/atomic/orderHalfCommit.js";
import { ORDER_CREATED_TOPIC, ORDER_CREATED_TOPICS } from "../engine/evm/factory.js";
import { SdkError } from "./errors.mjs";
import { probeMoneroNode } from "./probes.mjs";
import { ed25519, keccak256, randomBytes, secp256k1 } from "./primitives.mjs";

const halves = createHalves({ ed25519, secp256k1, keccak256, randomBytes });

/** A BIP39 mnemonic with 128 bits of entropy: twelve words. */
export const RECOVERY_KEY_VERSION = 1;
export const RECOVERY_KEY_WORDS = 12;
export const RECOVERY_KEY_STORE = "ninsei.recovery.key.v1";
export const RECOVERY_KEY_FILE_MAGIC = "NINSEI RECOVERY KEY";
export const RECOVERY_KEY_DOMAIN = "ninsei-taker-v1";
// The counterparty's view half is derived from the SAME ONE KEY, in a domain of its own. The taker sends this
// number to the maker (the node), which uses it as its own view half; the taker keeps it, so the joint view key
// can be rebuilt from the twelve words without any server.
export const MAKER_VIEW_HALF_DOMAIN = "ninsei-maker-view-v1";
export const RECOVERY_KEY_ENVELOPE_VERSION = 1;
export const RECOVERY_KEY_ALG = "AES-GCM-256/PBKDF2-SHA256";
export const RECOVERY_KEY_ITER = 600000;
const ITER_MIN = 600000;
const ITER_MAX = 6000000;

const te = new TextEncoder();
const td = new TextDecoder();

const hex32 = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");
const pad32 = (value) => "0x" + String(value).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const b64 = (bytes) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const bad = (field) => new SdkError("bad-input", { field });
const failed = (stage) => new SdkError("recovery-failed", { stage });

function normalizeWords(value) {
  if (typeof value !== "string") throw bad("mnemonic");
  const mnemonic = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!mnemonic || mnemonic.split(" ").length !== RECOVERY_KEY_WORDS) throw bad("mnemonic");
  if (!validateMnemonic(mnemonic, wordlist)) throw bad("mnemonic");
  return mnemonic;
}

function createdAtOf(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw bad("createdAt");
  return date.toISOString();
}

/** A new 12-word key. The caller stores it; this function keeps nothing. */
export function createRecoveryKey({ createdAt } = {}) {
  const mnemonic = generateMnemonic(wordlist, 128);
  return recoveryKeyOf(mnemonic, createdAt);
}

/** A key imported from words. Validation happens here, once. */
export function importRecoveryKey(mnemonic, { createdAt } = {}) {
  return recoveryKeyOf(mnemonic, createdAt);
}

function recoveryKeyOf(mnemonic, createdAt) {
  const words = normalizeWords(mnemonic);
  return {
    version: RECOVERY_KEY_VERSION,
    mnemonic: words,
    fingerprint: fingerprintOf(words),
    createdAt: createdAtOf(createdAt),
  };
}

/** The first four hex characters of the key's hash: a name a person can compare, not a secret. */
export function fingerprintOf(mnemonic) {
  const words = typeof mnemonic === "string" ? mnemonic.trim().toLowerCase().replace(/\s+/g, " ") : "";
  if (!words) throw bad("mnemonic");
  return Array.from(keccak256(te.encode(words)), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 4);
}

function seedOf(mnemonic) {
  // BIP39 defines the seed; no wallet password is used here. A wallet password is a DIFFERENT feature and would
  // silently produce different halves.
  return mnemonicToSeedSync(normalizeWords(mnemonic));
}

function numberField(value, field) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw bad(field);
  return n;
}

/** The binding a swap number is derived from. The chain id keeps testnet and mainnet keys apart. */
export function recoveryBinding(chainId, index) {
  return `${RECOVERY_KEY_DOMAIN}|${numberField(chainId, "chainId")}|${numberField(index, "index")}`;
}

/**
 * The taker's two halves for swap number `index`.
 *
 * The halves are returned as 0x-prefixed scalars (64 hex digits), not BigInt: every crossing of JSON in this
 * package is a hex string, and a BigInt that reaches JSON.stringify fails the whole record.
 */
export function takerHalves({ mnemonic, chainId, index }) {
  const binding = recoveryBinding(chainId, index);
  const seed = seedOf(mnemonic);
  const spendHalf = halves.halfFromSeed(seed, binding, halves.HALF_DOMAIN);
  const viewHalf = halves.halfFromSeed(seed, binding, halves.VIEW_HALF_DOMAIN);
  // THE OTHER SIDE'S VIEW HALF. The same key, a third domain: the taker gives this number to the maker, so the
  // maker's view half no longer comes from a seed the taker cannot reproduce.
  const makerViewHalf = halves.halfFromSeed(seed, binding, MAKER_VIEW_HALF_DOMAIN);
  const spend = halves.publicHalves(spendHalf);
  const view = halves.publicHalves(viewHalf);
  const makerView = halves.publicHalves(makerViewHalf);
  return {
    index: numberField(index, "index"),
    binding,
    spendHalf: hex32(spendHalf),
    viewHalf: hex32(viewHalf),
    spendPoint: spend.ed,
    viewPoint: view.ed,
    makerViewHalf: hex32(makerViewHalf),
    makerViewPoint: makerView.ed,
    spendCommitment: halfCommitmentHex(spendHalf, secp256k1, keccak256),
  };
}

// ---------------------------------------------------------------------------------------------------
// THE BACKUP FILE
// ---------------------------------------------------------------------------------------------------

const stampOf = (createdAt) => createdAtOf(createdAt).slice(0, 10);

/** The stable name a person can search for. `DO-NOT-DELETE` is part of the name on purpose. */
export function recoveryKeyFileName({ mnemonic, fingerprint, createdAt } = {}) {
  const fp = fingerprint || fingerprintOf(mnemonic);
  return `ninsei-recovery-key-DO-NOT-DELETE-${stampOf(createdAt)}-${fp}.txt`;
}

function headerOf({ fingerprint, createdAt }) {
  return [
    RECOVERY_KEY_FILE_MAGIC,
    "This file restores every swap made with this key.",
    "Restore at https://recovery.ninsei.finance",
    "Never share it with anyone, not even Ninsei.",
    "This is not a wallet seed. Do not import it into a wallet.",
    `Key ${fingerprint}, created ${stampOf(createdAt)}`,
  ].join("\n");
}

/** The plain file: a readable header above the words. */
export function recoveryKeyText({ mnemonic, createdAt } = {}) {
  const key = recoveryKeyOf(mnemonic, createdAt);
  return `${headerOf(key)}\n\n${key.mnemonic}\n`;
}

async function deriveKey(passphrase, salt, iter) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw failed("crypto-unavailable");
  const material = await crypto.subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const aadOf = (header) => JSON.stringify({
  kind: "ninsei-recovery-key",
  v: header.v,
  alg: header.alg,
  iter: header.iter,
  salt: header.salt,
  iv: header.iv,
  meta: header.meta,
});

/**
 * The backup file, optionally protected by a password. An empty password is a choice, not an omission: the
 * file then says so in plain text, as the unencrypted recovery envelope does.
 */
export async function createRecoveryKeyFile({ mnemonic, createdAt, passphrase = "" } = {}) {
  const key = recoveryKeyOf(mnemonic, createdAt);
  if (typeof passphrase !== "string") throw bad("passphrase");
  if (passphrase === "") return recoveryKeyText(key);
  if (passphrase.length < 12) throw bad("passphrase");
  if (!globalThis.crypto || !globalThis.crypto.subtle) throw failed("crypto-unavailable");

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = {
    v: RECOVERY_KEY_ENVELOPE_VERSION,
    alg: RECOVERY_KEY_ALG,
    iter: RECOVERY_KEY_ITER,
    salt: b64(salt),
    iv: b64(iv),
    meta: { fingerprint: key.fingerprint, createdAt: key.createdAt },
  };
  const aes = await deriveKey(passphrase, salt, RECOVERY_KEY_ITER);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128, additionalData: te.encode(aadOf(header)) },
    aes,
    te.encode(JSON.stringify({ mnemonic: key.mnemonic }))
  );
  return JSON.stringify({ ...header, ciphertext: b64(new Uint8Array(ciphertext)) }, null, 2);
}

/** Read a plain or an encrypted key file. The returned key is always validated. */
export async function openRecoveryKeyFile(contents, passphrase = "") {
  if (typeof contents !== "string" || !contents.trim()) throw bad("file");
  if (typeof passphrase !== "string") throw bad("passphrase");
  const text = contents.trim();

  if (!text.startsWith("{")) {
    // THE PLAIN FILE. The header is checked by its first line, not by a loose search: a random text file must
    // not be mistaken for a key.
    const lines = text.split(/\r?\n/);
    if (lines[0].trim() !== RECOVERY_KEY_FILE_MAGIC) throw failed("parse");
    const words = lines.slice(1).map((line) => line.trim()).find((line) => line && validateMnemonic(line.toLowerCase(), wordlist));
    if (!words) throw failed("parse");
    return recoveryKeyOf(words);
  }

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw failed("parse");
  }
  if (!envelope || envelope.v !== RECOVERY_KEY_ENVELOPE_VERSION || envelope.alg !== RECOVERY_KEY_ALG) throw failed("parse");
  for (const field of ["salt", "iv", "ciphertext"]) if (typeof envelope[field] !== "string" || !envelope[field]) throw failed("parse");
  const iter = Number(envelope.iter);
  if (!Number.isInteger(iter) || iter < ITER_MIN || iter > ITER_MAX) throw failed("parse");
  if (passphrase.length < 12) throw failed("passphrase");

  let payload;
  try {
    const aes = await deriveKey(passphrase, unb64(envelope.salt), iter);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(envelope.iv), tagLength: 128, additionalData: te.encode(aadOf(envelope)) },
      aes,
      unb64(envelope.ciphertext)
    );
    payload = JSON.parse(td.decode(plain));
  } catch {
    throw failed("decrypt");
  }
  const key = recoveryKeyOf(payload && payload.mnemonic);
  if (envelope.meta && envelope.meta.fingerprint && envelope.meta.fingerprint !== key.fingerprint) throw failed("fingerprint");
  return key;
}

// ---------------------------------------------------------------------------------------------------
// RESERVATION
// ---------------------------------------------------------------------------------------------------

const readStore = (storage) => {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function" || typeof storage.remove !== "function") throw bad("storage");
  const raw = storage.get(RECOVERY_KEY_STORE);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== RECOVERY_KEY_VERSION || typeof value.mnemonic !== "string") return null;
    return value;
  } catch {
    return null;
  }
};

/** Save the key next to the swap records. The words are the secret; the store is the caller's. */
export function saveRecoveryKey(storage, key) {
  const checked = recoveryKeyOf(key && key.mnemonic, key && key.createdAt);
  storage.set(RECOVERY_KEY_STORE, JSON.stringify({ ...checked, nextIndex: Number(key.nextIndex) || 0,
    reserved: key.reserved || {}, retired: key.retired || {}, backupConfirmed: key.backupConfirmed === true }));
  return checked;
}

export function loadRecoveryKey(storage) {
  const value = readStore(storage);
  if (!value) return null;
  return { ...value, fingerprint: value.fingerprint || fingerprintOf(value.mnemonic) };
}

/**
 * Reserve a number for a request. A reservation is not a spent number: if the request is abandoned, the caller
 * releases it and the same number is used again. The chain check belongs to the caller: a number is retired only
 * when an order with its commitment exists.
 */
export function reserveRecoveryIndex(storage, { chainId, swapId = null } = {}) {
  const key = loadRecoveryKey(storage);
  if (!key) throw failed("key-missing");
  const chain = String(numberField(chainId, "chainId"));
  const reserved = { ...(key.reserved || {}) };
  const retired = { ...(key.retired || {}) };
  const index = Number(key.nextIndex) || 0;
  // Holes left by RELEASED numbers are reused; a retired number was seen on chain and is never reused.
  for (let i = 0; i < index; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(reserved, i) && !Object.prototype.hasOwnProperty.call(retired, i)) {
      reserved[i] = { chainId: chain, swapId, at: new Date().toISOString() };
      storage.set(RECOVERY_KEY_STORE, JSON.stringify({ ...key, reserved, retired }));
      return i;
    }
  }
  if (index >= 100000) throw failed("index-exhausted");
  reserved[index] = { chainId: chain, swapId, at: new Date().toISOString() };
  storage.set(RECOVERY_KEY_STORE, JSON.stringify({ ...key, nextIndex: index + 1, reserved, retired }));
  return index;
}

export function releaseRecoveryIndex(storage, index) {
  const key = loadRecoveryKey(storage);
  if (!key) throw failed("key-missing");
  const reserved = { ...(key.reserved || {}) };
  delete reserved[String(numberField(index, "index"))];
  storage.set(RECOVERY_KEY_STORE, JSON.stringify({ ...key, reserved }));
}

/** Retire a number after its order exists on chain: it is never reused, so a later scan has no collision. */
export function commitRecoveryIndex(storage, index) {
  const key = loadRecoveryKey(storage);
  if (!key) throw failed("key-missing");
  const reserved = { ...(key.reserved || {}) };
  const retired = { ...(key.retired || {}) };
  const n = numberField(index, "index");
  delete reserved[String(n)];
  retired[String(n)] = true;
  storage.set(RECOVERY_KEY_STORE, JSON.stringify({ ...key, reserved, retired }));
}

// ---------------------------------------------------------------------------------------------------
// THE SEARCH
// ---------------------------------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function topicAddress(address) {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) throw bad("address");
  return pad32(address);
}

function decodeOrderLog(log) {
  const topics = Array.isArray(log && log.topics) ? log.topics : [];
  const topic0 = String(topics[0] || "").toLowerCase();
  if (topics.length < 4 || !ORDER_CREATED_TOPICS.includes(topic0)) return null;
  const data = String(log.data || "").replace(/^0x/, "");
  const modern = topic0 === ORDER_CREATED_TOPIC;
  if (data.length < 64 * (modern ? 13 : 12)) return null;
  const word = (i) => "0x" + data.slice(i * 64, (i + 1) * 64).toLowerCase();
  // THE FIELD OFFSETS MOVED WHEN `xmrAmount` JOINED THE EVENT. The old topic has no XMR amount; its orders fall
  // back to the clone read, and a caller can still tell why from `xmrAmountReason`.
  const shift = modern ? 1 : 0;
  return {
    escrow: "0x" + String(topics[1]).slice(26).toLowerCase(),
    locker: "0x" + String(topics[2]).slice(26).toLowerCase(),
    claimer: "0x" + String(topics[3]).slice(26).toLowerCase(),
    commitHalfLocker: word(0),
    commitHalfClaimer: word(1),
    edPointLocker: word(2),
    edPointClaimer: word(3),
    edViewPointLocker: word(4),
    amount: BigInt(word(5)).toString(),
    xmrAmount: modern ? BigInt(word(6)).toString() : null,
    readyBy: Number(BigInt(word(6 + shift))),
    t1: Number(BigInt(word(7 + shift))),
    salt: word(8 + shift),
    registry: "0x" + data.slice((9 + shift) * 64 + 24, (10 + shift) * 64),
    provider: "0x" + data.slice((10 + shift) * 64 + 24, (11 + shift) * 64),
    quoteKey: "0x" + data.slice((11 + shift) * 64 + 24, (12 + shift) * 64),
    transactionHash: log.transactionHash || null,
    blockNumber: log.blockNumber != null ? Number(log.blockNumber) : null,
    logIndex: log.logIndex != null ? Number(log.logIndex) : null,
  };
}

// THE CLONE CARRIES THE ORDER, INCLUDING THE XMR AMOUNT. OrderCreated does not repeat `xmrAmount`, and the clone
// has no getter for it, but word 18 of the condition blob is in its code. Read it only from a clone of the exact
// shape: a contract of another size is not this order and must not yield a guessed number.
const CLONE_CODE_BYTES = 877;
const XMR_AMOUNT_WORD = 18;
const CLONE_PROXY_BYTES = 45;
const XMR_AMOUNT_OFFSET = CLONE_PROXY_BYTES + XMR_AMOUNT_WORD * 32;

function xmrAmountFromClone(code) {
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]+$/.test(code)) return { value: null, reason: "code" };
  const bytes = (code.length - 2) / 2;
  if (!Number.isInteger(bytes) || bytes !== CLONE_CODE_BYTES) return { value: null, reason: "not-clone" };
  const word = code.slice(2 + XMR_AMOUNT_OFFSET * 2, 2 + (XMR_AMOUNT_OFFSET + 32) * 2);
  if (word.length !== 64) return { value: null, reason: "not-clone" };
  try {
    return { value: BigInt("0x" + word).toString(), reason: null };
  } catch {
    return { value: null, reason: "code" };
  }
}

async function readLogs(evmLogs, request) {
  if (typeof evmLogs !== "function") throw bad("evmLogs");
  let logs;
  try {
    logs = await evmLogs(request);
  } catch {
    throw failed("logs");
  }
  if (!Array.isArray(logs)) throw failed("logs");
  return logs;
}

/**
 * Is this number already held by an order on chain?
 *
 * A browser store is per device. The same twelve words opened on a second device, or restored before any search, start
 * at number 0 again; two swaps would then share the taker's halves, and a refund of one publishes a half the other's
 * maker can use. The check is the factory's own `OrderCreated` log, matched by the spend commitment the number derives.
 *
 * The caller owns the log transport, as everywhere else in this module. An unreadable log request is a refusal, not
 * "free": the number is not reserved on a guess.
 */
export async function recoveryIndexTaken({ mnemonic, chainId, index, factory, evmLogs, fromBlock = 0, toBlock = "latest" } = {}) {
  if (typeof factory !== "string" || !ADDRESS_RE.test(factory)) throw bad("factory");
  const own = takerHalves({ mnemonic, chainId, index });
  const logs = await readLogs(evmLogs, { address: factory, topics: [ORDER_CREATED_TOPICS], fromBlock, toBlock });
  return logs.map(decodeOrderLog).filter(Boolean).some((order) =>
    order.commitHalfLocker.toLowerCase() === own.spendCommitment.toLowerCase() ||
    order.commitHalfClaimer.toLowerCase() === own.spendCommitment.toLowerCase());
}

// THE MONERO HEIGHT A RECOVERED ORDER STARTED AT. With one key there is no per-swap file to carry it, so it is
// derived from the settlement chain: the timestamp of the block that holds OrderCreated, then the last Monero
// block at or before it. A Monero block's timestamp may run ahead of wall time, hence the safety margin.
//
// The two readers are seams, like evmLogs: the SDK owns the rule, the caller owns the transport. Without them the
// order is still returned, with startHeight null and a named reason, instead of a guessed height.
const MONERO_HEIGHT_SAFETY_BLOCKS = 60;

function secondsOf(value) {
  // A MISSING BLOCK TIME IS NOT 1970. `Number(null)` is 0, so a reader that answered null used to place an order
  // at the epoch and derive a Monero height from it. Null means "not read": the caller names no-block-time.
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

async function heightAtOrBefore(timestamp, { tip, headerTimestamp }) {
  const top = Number(await tip());
  if (!Number.isSafeInteger(top) || top < 0) throw new Error("monero-tip");
  const at = async (height) => secondsOf(await headerTimestamp(height));
  const topTime = await at(top);
  if (topTime !== null && topTime <= timestamp) return top;
  let low = 0;
  let high = top;
  const zeroTime = await at(0);
  if (zeroTime !== null && zeroTime > timestamp) return 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const ts = await at(mid);
    if (ts === null) throw new Error("monero-header");
    if (ts <= timestamp) low = mid;
    else high = mid - 1;
  }
  return low;
}

// THE READERS A CALLER SHOULD NOT HAVE TO BUILD. A page already holds the node URLs it probed; these wrap
// `get_info` and `get_block_header_by_height` over one of them. The SDK still owns the binary search; only the
// transport is borrowed.
async function moneroReadersFromNodes({ nodes = [], network = null, fetchImpl = globalThis.fetch } = {}) {
  const urls = (Array.isArray(nodes) ? nodes : [])
    .map((entry) => typeof entry === "string" ? entry : entry && entry.url).filter(Boolean);
  if (!urls.length) return { readers: null, reason: "no-height-readers" };
  const answers = await Promise.all(urls.map(async (url) => {
    try { return { ...(await probeMoneroNode({ url, fetchImpl })), url }; }
    catch { return { ok: false, why: "unreachable", url }; }
  }));
  const node = answers.find((answer) => answer.ok === true && (!network || answer.network === network));
  if (!node) {
    // TWO DIFFERENT FAILURES, TWO DIFFERENT REASONS. A node that answered but runs another network is not the
    // same as no node answering at all; a page must be able to tell the person which one to fix.
    const answered = answers.some((answer) => answer.ok === true);
    return { readers: null, reason: answered ? "monero-network-mismatch" : "monero-nodes-unreachable" };
  }
  const call = async (method, params) => {
    let response;
    try {
      response = await fetchImpl(node.url + "/json_rpc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
      });
    } catch { throw new Error("monero-unreachable"); }
    if (!response || response.ok !== true) throw new Error("monero-http");
    let body = null;
    try { body = await response.json(); } catch { throw new Error("monero-json"); }
    if (!body || body.error || !body.result) throw new Error("monero-rpc");
    return body.result;
  };
  return {
    reason: null,
    readers: {
      // `get_info.height` is the block COUNT, one past the top block. Asking a real node for a header at that height
      // answers "greater than current top block"; the tip reader must name the top block itself.
      tip: async () => Math.max(0, Number(node.height) - 1),
      headerTimestamp: async (height) => {
        const result = await call("get_block_header_by_height", { height });
        const ts = Number(result.block_header && result.block_header.timestamp);
        // GENESIS HAS TIMESTAMP 0. The binary search reads height 0 to prove the requested moment is before it; a
        // `<= 0` refusal turned a legitimate genesis answer into "monero-header" and every old order lost its height.
        if (!Number.isFinite(ts) || ts < 0) throw new Error("monero-header");
        return ts;
      },
    },
  };
}

async function recoveredStartHeight(order, { evmBlockTime, moneroTip, moneroBlockTimestamp, cache, readersReason = "no-height-readers" }) {
  if (order.blockNumber === null || order.blockNumber === undefined) {
    return { startHeight: null, startHeightReason: "no-block-number", blockTime: null };
  }
  // NOTHING TO READ WITH: no settlement block time and no Monero readers. That is a missing seam, not a missing date.
  if (typeof evmBlockTime !== "function" && typeof moneroTip !== "function" && typeof moneroBlockTimestamp !== "function") {
    return { startHeight: null, startHeightReason: readersReason || "no-height-readers", blockTime: null };
  }
  // THE BLOCK TIME IS PART OF THE FOUND ORDER. The page used to read the block again just to show a date; the
  // timestamp is already needed here for the Monero height, so it is returned with it.
  let timestamp = cache.get(order.blockNumber);
  if (timestamp === undefined) {
    timestamp = typeof evmBlockTime === "function" ? secondsOf(await evmBlockTime(order.blockNumber)) : null;
    if (timestamp === null) return { startHeight: null, startHeightReason: "no-block-time", blockTime: null };
    cache.set(order.blockNumber, timestamp);
  }
  if (typeof moneroTip !== "function" || typeof moneroBlockTimestamp !== "function") {
    return { startHeight: null, startHeightReason: readersReason || "no-height-readers", blockTime: timestamp };
  }
  try {
    const height = await heightAtOrBefore(timestamp, { tip: moneroTip, headerTimestamp: moneroBlockTimestamp });
    return { startHeight: Math.max(0, height - MONERO_HEIGHT_SAFETY_BLOCKS), startHeightReason: null, blockTime: timestamp };
  } catch {
    return { startHeight: null, startHeightReason: "monero-header", blockTime: timestamp };
  }
}

/**
 * Find orders made with this key.
 *
 * `evmLogs` is the caller's read seam: ({ address, topics, fromBlock, toBlock }) -> logs. With an address, the
 * search asks for it as the locker and as the claimer (two queries; the RPC topic filter cannot say OR across two
 * positions) and merges the answers. Without one, every OrderCreated of the factory is read and matched locally.
 */
export async function findSwaps({ mnemonic, chainId, factory, address = null, evmLogs,
  fromBlock = null, deploymentBlock = null, toBlock = "latest", gap = 5, maxIndex = 1000,
  evmBlockTime = null, evmCode = null, moneroTip = null, moneroBlockTimestamp = null,
  xmrNodes = null, moneroNetwork = null, fetchImpl = globalThis.fetch } = {}) {
  if (typeof factory !== "string" || !ADDRESS_RE.test(factory)) throw bad("factory");
  const chain = numberField(chainId, "chainId");
  const max = numberField(maxIndex, "maxIndex") || 1000;
  const missesAllowed = numberField(gap, "gap") || 5;
  // THE CHAIN SAYS WHERE ITS ORDERS CAN START. An explicit fromBlock wins; otherwise the caller can pass the
  // factory's deployment block (the SDK's chain registry exposes it as escrow.deploymentBlock). Zero remains the
  // last resort for a caller that knows the factory existed at genesis.
  if (deploymentBlock !== null && deploymentBlock !== undefined && !Number.isSafeInteger(Number(deploymentBlock))) {
    throw bad("deploymentBlock");
  }
  const startBlock = fromBlock === null || fromBlock === undefined
    ? (deploymentBlock === null || deploymentBlock === undefined ? 0 : Number(deploymentBlock))
    : fromBlock;
  const base = { address: factory, fromBlock: startBlock, toBlock };
  let logs = [];
  if (address) {
    const padded = topicAddress(address);
    const [asLocker, asClaimer] = await Promise.all([
      readLogs(evmLogs, { ...base, topics: [ORDER_CREATED_TOPICS, null, padded, null] }),
      readLogs(evmLogs, { ...base, topics: [ORDER_CREATED_TOPICS, null, null, padded] }),
    ]);
    const seen = new Set();
    for (const log of asLocker.concat(asClaimer)) {
      const id = `${log.transactionHash || ""}:${log.logIndex ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      logs.push(log);
    }
  } else {
    logs = await readLogs(evmLogs, { ...base, topics: [ORDER_CREATED_TOPICS] });
  }
  const orders = logs.map(decodeOrderLog).filter(Boolean);
  const found = [];
  let misses = 0;
  let scanned = 0;
  for (let index = 0; index < max && misses < missesAllowed; index += 1) {
    scanned = index + 1;
    const own = takerHalves({ mnemonic, chainId: chain, index });
    const matches = orders.filter((order) =>
      order.commitHalfLocker.toLowerCase() === own.spendCommitment.toLowerCase() ||
      order.commitHalfClaimer.toLowerCase() === own.spendCommitment.toLowerCase()
    );
    if (matches.length === 0) {
      misses += 1;
      continue;
    }
    misses = 0;
    for (const order of matches) {
      found.push({ ...order, index, side: order.commitHalfLocker.toLowerCase() === own.spendCommitment.toLowerCase() ? "locker" : "claimer" });
    }
  }
  // EACH FOUND ORDER CARRIES THE MONERO HEIGHT ITS WITHDRAWAL MAY START FROM. The rule lives here, not in a
  // page: a widget and the recovery page must not derive two different answers from one chain.
  const cache = new Map();
  let tip = moneroTip;
  let header = moneroBlockTimestamp;
  let readersReason = "no-height-readers";
  if ((typeof tip !== "function" || typeof header !== "function") && Array.isArray(xmrNodes) && xmrNodes.length) {
    const probed = await moneroReadersFromNodes({ nodes: xmrNodes, network: moneroNetwork, fetchImpl });
    if (probed.readers) { tip = tip || probed.readers.tip; header = header || probed.readers.headerTimestamp; }
    else readersReason = probed.reason || "no-height-readers";
  }
  // THE ORDER IS NATIVE, AND THE PAYING TOKEN IS NOT ON THE CHAIN. The escrow receives the settlement network's
  // native coin (`amount` is wei); which token the person swapped into it (USDC, USDT, ...) belongs to the DEX/quote
  // record, not to OrderCreated or the clone. `payToken: null` plus a reason is the honest answer here; an invented
  // "USDC" would be a claim the chain does not support.
  for (const order of found) {
    order.settlementToken = "native";
    order.payToken = null;
    order.payTokenReason = "not-on-chain";
  }
  for (const order of found) {
    Object.assign(order, await recoveredStartHeight(order, { evmBlockTime, moneroTip: tip, moneroBlockTimestamp: header, cache, readersReason }));
  }
  // THE XMR AMOUNT COMES FROM THE EVENT IN THE CURRENT FACTORY. The previous event has no field; those orders fall
  // back to the clone read, where word 18 is read only from a clone of the exact shape. This is data, not a
  // withdrawal verdict.
  for (const order of found) {
    if (order.xmrAmount !== null && order.xmrAmount !== undefined) {
      order.xmrAmountReason = "event";
      continue;
    }
    if (typeof evmCode !== "function") {
      order.xmrAmount = null;
      order.xmrAmountReason = "no-code-reader";
      continue;
    }
    let code;
    try {
      code = await evmCode(order.escrow);
    } catch {
      order.xmrAmount = null;
      order.xmrAmountReason = "code";
      continue;
    }
    const read = xmrAmountFromClone(code);
    order.xmrAmount = read.value;
    order.xmrAmountReason = read.reason;
  }
  return { swaps: found, scanned };
}
