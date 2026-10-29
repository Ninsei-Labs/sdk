#!/usr/bin/env node
// THE HPKE PROFILE FOR RELAY VIEW MATERIAL.
//
// This check exercises the exact suite and context the relay spec fixes: DHKEM(X25519, HKDF-SHA256),
// HKDF-SHA256, ChaCha20-Poly1305, base mode. It also proves the two plaintext widths: 32 bytes on ask and
// 64 bytes on bid, with the ciphertext carrying a 16-byte tag.
//
// Run: node tools/check-relay-view.mjs
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { openViewEnvelope, relayViewInfo, sealViewEnvelope } from "../src/relayView.mjs";

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const bytes = (value) => new Uint8Array(value);

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});
const pair = await suite.kem.generateKeyPair(true);
const hpkeKey = hex(bytes(await suite.kem.serializePublicKey(pair.publicKey)));
const privateKey = hex(bytes(await suite.kem.serializePrivateKey(pair.privateKey)));

const words = {
  termsDigest: "0x" + "11".repeat(32),
  commitHalf: "0x" + "22".repeat(32),
  edPoint: "0x" + "33".repeat(32),
  edViewPointClient: "0x" + "44".repeat(32),
  edViewPointNode: "0x" + "55".repeat(32),
};
const info = relayViewInfo(words);

console.log("=== 1) THE CONTEXT HAS THE FIVE WORDS IN THE WIRE ORDER ===");
if (Buffer.from(info).toString("utf8").startsWith("ninsei-relay-view-v1")) ok("the context starts with the wire prefix");
else bad("the context does not start with the wire prefix");
if (info.length === 20 + 5 * 32) ok("the context is the prefix followed by five 32-byte words");
else bad("the context length is " + info.length);
const moved = relayViewInfo({ ...words, edViewPointNode: "0x" + "66".repeat(32) });
if (!Buffer.from(moved).equals(Buffer.from(info))) ok("a different view point changes the context");
else bad("a different view point left the context unchanged");
for (const field of ["termsDigest", "commitHalf", "edPoint", "edViewPointClient", "edViewPointNode"]) {
  const next = relayViewInfo({ ...words, [field]: "0x" + "77".repeat(32) });
  if (!Buffer.from(next).equals(Buffer.from(info))) ok(field + " is bound by the context");
  else bad(field + " is not bound by the context");
}

console.log("=== 2) ASK CARRIES ONE 32-BYTE SCALAR ===");
const askPlain = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
let ask = null;
try {
  ask = await sealViewEnvelope({ hpkeKey, info, plaintext: askPlain });
  const opened = await openViewEnvelope({ privateKey, enc: ask.enc, ciphertext: ask.ciphertext, info });
  if (ask.enc.length === 66) ok("enc is one 32-byte X25519 point");
  else bad("enc is " + ask.enc.length + " hex characters");
  if (ask.ciphertext.length === 2 + 2 * 48) ok("ciphertext is 32 bytes plus a 16-byte tag");
  else bad("ask ciphertext is " + ask.ciphertext.length + " hex characters");
  if (Buffer.from(opened).equals(Buffer.from(askPlain))) ok("the recipient opens the ask scalar");
  else bad("the recipient opened different bytes");
} catch (error) {
  bad("ask seal/open: " + String(error.message || error));
}

console.log("=== 3) BID CARRIES TWO 32-BYTE SCALARS ===");
const bidPlain = Uint8Array.from({ length: 64 }, (_, i) => (i * 3) & 0xff);
try {
  const bid = await sealViewEnvelope({ hpkeKey, info, plaintext: bidPlain });
  const opened = await openViewEnvelope({ privateKey, enc: bid.enc, ciphertext: bid.ciphertext, info });
  if (bid.ciphertext.length === 2 + 2 * 80) ok("ciphertext is 64 bytes plus a 16-byte tag");
  else bad("bid ciphertext is " + bid.ciphertext.length + " hex characters");
  if (Buffer.from(opened).equals(Buffer.from(bidPlain))) ok("the recipient opens both bid scalars");
  else bad("the recipient opened different bytes");
} catch (error) {
  bad("bid seal/open: " + String(error.message || error));
}

console.log("=== 4) A WRONG CONTEXT DOES NOT OPEN ===");
if (ask) {
  const wrong = relayViewInfo({ ...words, edViewPointClient: "0x" + "88".repeat(32) });
  try {
    await openViewEnvelope({ privateKey, enc: ask.enc, ciphertext: ask.ciphertext, info: wrong });
    bad("a different context opened the envelope");
  } catch {
    ok("a different context is refused");
  }
}

console.log("=== 5) BAD INPUT IS NAMED BEFORE CRYPTOGRAPHY ===");
for (const [label, call] of [
  ["a short key", () => sealViewEnvelope({ hpkeKey: "0x11", info, plaintext: askPlain })],
  ["a short plaintext", () => sealViewEnvelope({ hpkeKey, info, plaintext: new Uint8Array(31) })],
  ["a wrong info type", () => sealViewEnvelope({ hpkeKey, info: "text", plaintext: askPlain })],
  ["a short ciphertext", () => openViewEnvelope({ privateKey, enc: ask?.enc || "0x" + "00".repeat(32), ciphertext: "0x01", info })],
]) {
  try {
    await call();
    bad(label + " was accepted");
  } catch (error) {
    if (error && error.code === "bad-input") ok(label + " is refused as bad-input");
    else bad(label + " gave " + JSON.stringify(error && (error.code || error.message)));
  }
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "relay view: " + pass + " checks passed.");
if (fails.length) process.exit(1);
