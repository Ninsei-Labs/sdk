// THE VIEW MATERIAL A RELAY REQUEST CARRIES.
//
// The relay `firm/1` exchange does not send a Monero view scalar in clear text. The client chooses the view
// halves, keeps them in its recovery material, and encrypts only the node's share to the X25519 key in the
// signed public features. The profile is fixed by the relay wire spec: HPKE RFC 9180 base mode, DHKEM(X25519,
// HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305.
//
// This module owns the profile, not the request shape. It names one encryption and one decryption, both taking
// the application `info` as bytes, so the caller cannot accidentally use a different suite or a different
// interpretation of the context. The relay client builds `info` with `relayViewInfo`.
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { SdkError } from "./errors.mjs";

const utf8 = (value) => new TextEncoder().encode(String(value));

const bytesOf = (value) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new SdkError("bad-input", { field: "viewEnvelope" });
};

const bytesToHex = (bytes) => {
  let out = "0x";
  for (const byte of bytesOf(bytes)) out += byte.toString(16).padStart(2, "0");
  return out;
};

const hexToBytes = (value, width, field) => {
  const text = String(value === undefined || value === null ? "" : value).replace(/^0x/, "");
  if (!new RegExp("^[0-9a-fA-F]{" + (width * 2) + "}$").test(text)) {
    throw new SdkError("bad-input", { field });
  }
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const suite = () => new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

// The relay binds encryption to the exact terms, the client half and both view points. The prefix and the
// order of the five words are part of the wire format; a different order still decrypts, which is why it is
// built here once instead of at each call site.
export const RELAY_VIEW_INFO_PREFIX = "ninsei-relay-view-v1";

export function relayViewInfo({ termsDigest, commitHalf, edPoint, edViewPointClient, edViewPointNode } = {}) {
  const words = [
    ["termsDigest", termsDigest],
    ["commitHalf", commitHalf],
    ["edPoint", edPoint],
    ["edViewPointClient", edViewPointClient],
    ["edViewPointNode", edViewPointNode],
  ].map(([field, value]) => hexToBytes(value, 32, field));
  const prefix = utf8(RELAY_VIEW_INFO_PREFIX);
  const out = new Uint8Array(prefix.length + words.reduce((n, word) => n + word.length, 0));
  out.set(prefix, 0);
  let at = prefix.length;
  for (const word of words) { out.set(word, at); at += word.length; }
  return out;
}

// One sender context, one Seal. The relay spec forbids reusing an ephemeral key for another encryption, so
// the context is created here and never exposed.
export async function sealViewEnvelope({ hpkeKey, info, plaintext } = {}) {
  // The two plaintext lengths are part of the wire contract: ask carries the node's view scalar, bid carries
  // the node's scalar followed by the client's. A caller that passes another length is refused before any
  // network or cryptographic work.
  const publicKey = hexToBytes(hpkeKey, 32, "hpkeKey");
  const body = bytesOf(plaintext);
  if (body.length !== 32 && body.length !== 64) {
    throw new SdkError("bad-input", { field: "plaintext" });
  }
  if (!(info instanceof Uint8Array)) throw new SdkError("bad-input", { field: "info" });
  const ctx = suite();
  let key = null;
  try {
    key = await ctx.kem.deserializePublicKey(publicKey);
    const sender = await ctx.createSenderContext({ recipientPublicKey: key, info });
    const ciphertext = bytesOf(await sender.seal(body));
    return { enc: bytesToHex(sender.enc), ciphertext: bytesToHex(ciphertext) };
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError("bad-input", { field: "hpkeKey" });
  }
}

// The recipient side exists for checks and for a node that embeds this package. It is not needed by a client
// that only asks for a quote, but keeping both halves in one module makes a symmetric test possible.
export async function openViewEnvelope({ privateKey, enc, ciphertext, info } = {}) {
  const secret = hexToBytes(privateKey, 32, "privateKey");
  const encapsulated = hexToBytes(enc, 32, "enc");
  const text = String(ciphertext === undefined || ciphertext === null ? "" : ciphertext).replace(/^0x/, "");
  const width = text.length / 2;
  if (width !== 48 && width !== 80) throw new SdkError("bad-input", { field: "ciphertext" });
  const body = hexToBytes(ciphertext, width, "ciphertext");
  if (!(info instanceof Uint8Array)) throw new SdkError("bad-input", { field: "info" });
  const ctx = suite();
  try {
    const key = await ctx.kem.deserializePrivateKey(secret, true);
    const recipient = await ctx.createRecipientContext({ recipientKey: key, enc: encapsulated, info });
    return bytesOf(await recipient.open(body));
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError("bad-input", { field: "ciphertext" });
  }
}
