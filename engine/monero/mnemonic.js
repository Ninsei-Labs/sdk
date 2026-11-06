// MONERO MNEMONIC, WITHOUT A VENDORED LIBRARY.
//
// Monero uses its own 1626-word list and a checksum over the first three letters of the 24 payload words. The
// algorithm is fixed and small; `@noble` primitives are not involved. Keeping it here removes the old monero-js
// bundle from the package and leaves one wordlist, one encoder and one decoder.
import { randomBytes } from "../../src/primitives.mjs";
import { WORDLIST } from "./wordlist.en.js";

const WORD_COUNT = 24;
const CHECKSUM_WORD_COUNT = 25;
const ENTROPY_BYTES = 32;
const PREFIX = 3;
const WORD_INDEX = new Map(WORDLIST.map((word, index) => [word, index]));

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function wordsToChunk(one, two, three) {
  const n = WORDLIST.length;
  const a = WORD_INDEX.get(one);
  const b = WORD_INDEX.get(two);
  const c = WORD_INDEX.get(three);
  if (a === undefined || b === undefined || c === undefined) throw new Error("invalid mnemonic word");
  // The word order encodes a value in a mixed radix; the inverse is in chunkToWords.
  return a + n * (((b - a) % n + n) % n) + n * n * (((c - b) % n + n) % n);
}

function chunkToWords(value) {
  const n = WORDLIST.length;
  const one = value % n;
  const two = (Math.floor(value / n) + one) % n;
  const three = (Math.floor(Math.floor(value / n) / n) + two) % n;
  return [WORDLIST[one], WORDLIST[two], WORDLIST[three]];
}

function checksumWord(words) {
  const prefix = words.map((word) => word.slice(0, PREFIX)).join("");
  return words[crc32(new TextEncoder().encode(prefix)) % words.length];
}

function validateWords(words) {
  return (words.length === WORD_COUNT || words.length === CHECKSUM_WORD_COUNT)
    && words.every((word) => WORD_INDEX.has(word));
}

export function encode(entropy) {
  const bytes = entropy instanceof Uint8Array ? entropy : Uint8Array.from(entropy);
  if (bytes.length !== ENTROPY_BYTES) throw new Error("invalid entropy length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = [];
  for (let i = 0; i < bytes.length; i += 4) words.push(...chunkToWords(view.getUint32(i, true)));
  return words.join(" ");
}

export function encodeWithChecksum(entropy) {
  const words = encode(entropy).split(" ");
  words.push(checksumWord(words));
  return words.join(" ");
}

export function generate() {
  return encode(randomBytes(ENTROPY_BYTES));
}

export function generateWithChecksum() {
  return encodeWithChecksum(randomBytes(ENTROPY_BYTES));
}

export function decode(mnemonic) {
  const words = String(mnemonic || "").trim().split(/\s+/).filter(Boolean);
  if (!validateWords(words)) throw new Error("invalid mnemonic phrase (length or words)");
  if (words.length === CHECKSUM_WORD_COUNT) {
    const payload = words.slice(0, WORD_COUNT);
    if (words[WORD_COUNT] !== checksumWord(payload)) throw new Error("invalid mnemonic checksum");
  }
  const entropy = new Uint8Array(ENTROPY_BYTES);
  const view = new DataView(entropy.buffer);
  const count = Math.min(words.length, WORD_COUNT);
  for (let i = 0; i < count / 3; i += 1) {
    view.setUint32(i * 4, wordsToChunk(words[i * 3], words[i * 3 + 1], words[i * 3 + 2]), true);
  }
  return entropy;
}

export function isValid(mnemonic) {
  try { decode(mnemonic); return true; } catch { return false; }
}

export function toSeed(mnemonic) {
  return decode(mnemonic);
}
