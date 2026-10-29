// THE SIGNED ANSWER A RELAY RETURNS.
//
// The relay's outer `quote` frame is signed by the maker's quote key in the relay domain. Its `payload` is a
// JSON string with the factory, the signed `OrderQuote`, the node half and both view points. This module checks
// both signatures and binds the answer to the request terms before the caller can fund anything.
import { SdkError } from "./errors.mjs";
import { keccak256, secp256k1 } from "./primitives.mjs";
import { recoverOrderQuoteKey } from "./quoteEip712.mjs";
import * as engine from "./engine.mjs";

export const RELAY_QUOTE_TYPE =
  "Quote(string relayId,address provider,bytes32 session,bytes32 requestId,uint64 counter,bytes32 requestHash,string payload,uint64 time)";

const DOMAIN_TYPE = "EIP712Domain(string name,string version)";
const DOMAIN_NAME = "Ninsei Relay";
const DOMAIN_VERSION = "1";

const utf8 = (value) => new TextEncoder().encode(String(value));
const concat = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const array of arrays) { out.set(array, at); at += array.length; }
  return out;
};
const hexBytes = (value, field, width) => {
  const text = String(value === undefined || value === null ? "" : value).replace(/^0x/, "");
  if (!new RegExp("^[0-9a-fA-F]{" + width * 2 + "}$").test(text)) throw new SdkError("bad-input", { field });
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const wordAddress = (value, field) => {
  const out = new Uint8Array(32);
  out.set(hexBytes(value, field, 20), 12);
  return out;
};
const wordBytes32 = (value, field) => hexBytes(value, field, 32);
const wordUint = (value, field) => {
  let n = null;
  try { n = BigInt(value); } catch { n = null; }
  if (n === null || n < 0n) throw new SdkError("bad-input", { field });
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i -= 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};
const wordString = (value) => keccak256(utf8(value === undefined || value === null ? "" : value));

export function relayQuoteStructHash(answer) {
  if (!answer || typeof answer !== "object") throw new SdkError("bad-input", { field: "answer" });
  return keccak256(concat(
    keccak256(utf8(RELAY_QUOTE_TYPE)),
    wordString(answer.relayId),
    wordAddress(answer.provider, "answer.provider"),
    wordBytes32(answer.session, "answer.session"),
    wordBytes32(answer.requestId, "answer.requestId"),
    wordUint(answer.counter, "answer.counter"),
    wordBytes32(answer.requestHash, "answer.requestHash"),
    wordString(answer.payload),
    wordUint(answer.time, "answer.time"),
  ));
}

export function relayQuoteDomainSeparator() {
  return keccak256(concat(
    keccak256(utf8(DOMAIN_TYPE)),
    keccak256(utf8(DOMAIN_NAME)),
    keccak256(utf8(DOMAIN_VERSION)),
  ));
}

export function relayQuoteDigest(answer) {
  return keccak256(concat(Uint8Array.from([0x19, 0x01]), relayQuoteDomainSeparator(), relayQuoteStructHash(answer)));
}

const hex = (bytes) => {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};
function recoverAddress(digest, signature) {
  const sig = String(signature || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(sig)) return null;
  let v = parseInt(sig.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const publicKey = secp256k1.Signature.fromBytes(concat(
      hexBytes(sig.slice(0, 64), "signature", 32),
      hexBytes(sig.slice(64, 128), "signature", 32),
    )).addRecoveryBit(v).recoverPublicKey(digest);
    return hex(keccak256(publicKey.toBytes(false).slice(1)).slice(12));
  } catch {
    return null;
  }
}

// The outer frame: signed by the quote key in the relay domain.
export function verifyRelayQuoteFrame(answer, quoteKey) {
  if (!answer || typeof answer !== "object" || answer.type !== "quote" || Number(answer.version) !== 1) {
    throw new SdkError("quote-refused", { step: "answer", why: "frame" });
  }
  const recovered = recoverAddress(relayQuoteDigest(answer), answer.signature);
  if (recovered === null || recovered !== String(quoteKey || "").toLowerCase()) {
    throw new SdkError("quote-refused", { step: "answer", why: "signature" });
  }
  return answer;
}

const ZERO = "0x" + "00".repeat(20);
const lower = (value) => String(value === undefined || value === null ? "" : value).toLowerCase();
const same = (a, b) => lower(a) === lower(b);

function checkOrderQuote(quote, terms, nowSec) {
  const order = terms.order;
  if (!quote || typeof quote !== "object") throw new SdkError("quote-refused", { step: "answer", why: "quote" });
  const pairs = [
    ["chainId", String(order.chainId)],
    ["factory", order.factory],
    ["locker", order.locker],
    ["claimer", order.claimer],
    ["amount", String(order.amount)],
    ["readyBy", String(order.readyBy)],
    ["t1", String(order.t1)],
    ["salt", order.salt],
    ["xmrAmount", String(terms.xmrAmount)],
    ["claimTip", String(terms.claimTip)],
    ["provider", terms.maker],
    ["registry", terms.registry],
  ];
  for (const [field, want] of pairs) {
    if (!same(quote[field], want)) throw new SdkError("quote-refused", { step: "answer", why: "field", field });
  }
  if (same(quote.feeRecipient, ZERO)) {
    throw new SdkError("quote-refused", { step: "answer", why: "fee-recipient" });
  }
  const bps = Number(quote.feeBps);
  let fee = null;
  let amount = null;
  try { fee = BigInt(String(quote.fee)); amount = BigInt(String(order.amount)); }
  catch { throw new SdkError("quote-refused", { step: "answer", why: "fee" }); }
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 200) {
    throw new SdkError("quote-refused", { step: "answer", why: "fee" });
  }
  if (fee !== (amount * BigInt(bps)) / 10000n) throw new SdkError("quote-refused", { step: "answer", why: "fee" });
  const validUntil = Number(quote.validUntil);
  if (!Number.isSafeInteger(validUntil) || validUntil <= nowSec) {
    throw new SdkError("quote-expired", { step: "answer", validUntil: quote.validUntil });
  }
}

/**
 * Verify an answer against the request terms and the verified features. `request` is the result of
 * `buildFirmRequest`: it carries the normalised terms and both view points.
 */
export function verifyFirmAnswer({ answer, features, request, now = null } = {}) {
  if (!request || !request.terms) throw new SdkError("bad-input", { field: "request" });
  verifyRelayQuoteFrame(answer, features && features.quoteKey);
  if (!answer.relayId || !same(answer.relayId, features && features.relayId)) {
    throw new SdkError("quote-refused", { step: "answer", why: "relay" });
  }
  let payload = null;
  try { payload = JSON.parse(answer.payload); } catch { throw new SdkError("quote-refused", { step: "answer", why: "payload" }); }
  if (!payload || typeof payload !== "object" || !payload.quote) {
    throw new SdkError("quote-refused", { step: "answer", why: "payload" });
  }
  if (payload.contextVersion !== "ninsei-order-v3" || Number(payload.quoteVersion) !== 9) {
    throw new SdkError("quote-refused", { step: "answer", why: "version" });
  }
  if (!same(payload.factory, request.terms.order.factory)) {
    throw new SdkError("quote-refused", { step: "answer", why: "factory" });
  }
  if (!same(answer.provider, request.terms.maker)) {
    throw new SdkError("quote-refused", { step: "answer", why: "provider" });
  }
  const quote = { ...payload.quote, factory: request.terms.order.factory };
  if (!quote.quoteSignature) quote.quoteSignature = payload.quoteSignature;
  let context = null;
  try { context = engine.orderContext.orderContextString(request.terms.order); } catch { context = null; }
  if (!context || payload.context !== context) throw new SdkError("quote-refused", { step: "context", why: "other-terms" });
  const recovered = recoverOrderQuoteKey({ ...quote, signature: payload.quoteSignature });
  if (recovered === null) throw new SdkError("quote-refused", { step: "signature", why: "invalid" });
  if (!same(recovered, quote.quoteKey)) throw new SdkError("quote-refused", { step: "signature", why: "key" });
  const nowSec = Math.floor((now === null ? Date.now() : now) / 1000);
  checkOrderQuote(quote, request.terms, nowSec);
  const side = request.terms.side;
  const lockerPoint = side === "ask" ? request.edViewPointClient : request.edViewPointNode;
  const claimerPoint = side === "ask" ? request.edViewPointNode : request.edViewPointClient;
  if (!same(payload.edViewPointLocker, lockerPoint) || !same(payload.edViewPointClaimer, claimerPoint)) {
    throw new SdkError("quote-refused", { step: "answer", why: "view-points" });
  }
  const nodeHalf = payload.nodeHalf;
  if (!nodeHalf || typeof nodeHalf !== "object" || !nodeHalf.proof) {
    throw new SdkError("quote-refused", { step: "answer", why: "node-half" });
  }
  if (side === "ask") {
    if (!same(nodeHalf.commitHalf, quote.commitHalfClaimer) || !same(nodeHalf.edPoint, quote.edPointClaimer)) {
      throw new SdkError("quote-refused", { step: "answer", why: "node-half" });
    }
  }
  return {
    quote,
    orderQuote: { ...quote, factory: payload.factory, signature: payload.quoteSignature },
    nodeHalf,
    edViewPointLocker: payload.edViewPointLocker,
    edViewPointClaimer: payload.edViewPointClaimer,
    context,
  };
}
