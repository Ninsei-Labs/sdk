// ONE FIRM REQUEST: THE TERMS, THE CLIENT HALF AND THE ENCRYPTED VIEW MATERIAL.
//
// The relay signs the payload as the exact UTF-8 string it forwards, so this module serialises it once. Every
// field that the node or the relay checks is taken from the caller's terms or from the signed features; nothing
// is filled in from a second source.
//
// The builder does not create the client half: the caller has already built one order side and proved it in
// this context. It normalises the proof's spellings and refuses a half whose point is not the one in its proof.
import { SdkError } from "./errors.mjs";
import { ed25519, keccak256 } from "./primitives.mjs";
import { verifyNodeFeatures } from "./relayFeatures.mjs";
import { relayViewInfo, sealViewEnvelope } from "./relayView.mjs";
import { firmTermsDigest, firmTermsMissingFields } from "./relayTerms.mjs";

const hexToBytes = (value, field, width) => {
  const text = String(value === undefined || value === null ? "" : value).replace(/^0x/, "");
  if (!new RegExp("^[0-9a-fA-F]{" + width * 2 + "}$").test(text)) {
    throw new SdkError("bad-input", { field });
  }
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const hex = (bytes) => {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
};
const normHex = (value, width, field) => hex(hexToBytes(value, field, width));
const scalar = (value, field) => {
  let n = null;
  try { n = BigInt(value); } catch { n = null; }
  if (n === null || n <= 0n || n >= ed25519.Point.Fn.ORDER) throw new SdkError("bad-input", { field });
  return n;
};
const scalarBytes = (value, field) => {
  let n = scalar(value, field);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i -= 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};
const pointOf = (value, field) => hex(ed25519.Point.BASE.multiply(scalar(value, field)).toBytes());
const assertPoint = (value, field) => {
  const bytes = hexToBytes(value, field, 32);
  try { ed25519.Point.fromHex(hex(bytes).slice(2)); } catch { throw new SdkError("bad-input", { field }); }
  return hex(bytes);
};

const PROOF_FIELDS = ["XA", "XB", "proofs"];
function normaliseProof(proof) {
  if (!proof || typeof proof !== "object") throw new SdkError("bad-input", { field: "clientHalf.proof" });
  for (const field of PROOF_FIELDS) {
    if (proof[field] === undefined || proof[field] === null || proof[field] === "") {
      throw new SdkError("bad-input", { field: "clientHalf.proof." + field });
    }
  }
  if (!Array.isArray(proof.proofs) || proof.proofs.length !== 253) {
    throw new SdkError("bad-input", { field: "clientHalf.proof.proofs" });
  }
  const xa = normHex(proof.XA, 33, "clientHalf.proof.XA");
  const xb = normHex(proof.XB, 32, "clientHalf.proof.XB");
  const proofs = proof.proofs.map((entry, index) => {
    if (!entry || typeof entry !== "object" || !entry.sig) {
      throw new SdkError("bad-input", { field: "clientHalf.proof.proofs." + index });
    }
    const sig = {};
    for (const field of ["eA", "eB", "a0", "a1", "b0", "b1"]) {
      sig[field] = normHex(entry.sig[field], 32, "clientHalf.proof.proofs." + index + ".sig." + field);
    }
    return {
      cA: normHex(entry.cA, 33, "clientHalf.proof.proofs." + index + ".cA"),
      cB: normHex(entry.cB, 32, "clientHalf.proof.proofs." + index + ".cB"),
      sig,
    };
  });
  return { XA: xa, XB: xb, proofs };
}

/**
 * Build the exact request payload.
 *
 * `features` is the signed public object the relay forwarded; `terms` is the client's request terms (its
 * `featuresHash` may be omitted and is filled from the verified features). `clientHalf` is
 * `{commitHalf, edPoint, proof}`; `nodeViewScalar` and `clientViewScalar` are the two view halves the client
 * chose. Both are sent on both sides: after a taker refund on an ask the maker needs the taker's view scalar to
 * rebuild the joint view key.
 */
export async function buildFirmRequest({
  features, terms, clientHalf, edViewPointClient, edViewPointNode,
  nodeViewScalar, clientViewScalar = null, side = null,
} = {}) {
  const verdict = verifyNodeFeatures({ features, terms });
  const requestSide = String(side || terms?.side || "");
  if (requestSide !== "ask" && requestSide !== "bid") throw new SdkError("bad-input", { field: "side" });
  if (terms?.side !== undefined && terms.side !== requestSide) throw new SdkError("bad-input", { field: "terms.side" });
  if (!terms || typeof terms !== "object" || !terms.order || typeof terms.order !== "object") {
    throw new SdkError("bad-input", { field: "terms" });
  }
  if (terms.featuresHash !== undefined && terms.featuresHash !== null && terms.featuresHash !== ""
    && String(terms.featuresHash).toLowerCase() !== verdict.featuresHash) {
    throw new SdkError("quote-refused", { step: "features", why: "hash" });
  }
  const order = terms.order;
  const orderFields = ["chainId", "factory", "locker", "claimer", "amount", "readyBy", "t1", "salt"];
  for (const field of orderFields) {
    if (order[field] === undefined || order[field] === null || order[field] === "") {
      throw new SdkError("bad-input", { field: "terms.order." + field });
    }
  }
  if (String(order.chainId) !== String(terms.market || "").split(":")[0]) {
    throw new SdkError("bad-input", { field: "terms.market" });
  }
  const half = clientHalf || {};
  const commitHalf = normHex(half.commitHalf, 32, "clientHalf.commitHalf");
  const point = normHex(half.edPoint, 32, "clientHalf.edPoint");
  const proof = normaliseProof(half.proof);
  if (proof.XB !== point) throw new SdkError("bad-input", { field: "clientHalf.edPoint" });
  const maker = normHex(terms.maker, 20, "terms.maker");
  const locker = normHex(order.locker, 20, "terms.order.locker");
  const claimer = normHex(order.claimer, 20, "terms.order.claimer");
  if (locker === claimer) throw new SdkError("bad-input", { field: "terms.order.roles" });
  if (requestSide === "ask") {
    if (claimer !== maker) throw new SdkError("bad-input", { field: "terms.order.claimer" });
    if (String(terms.claimTip) !== "0") throw new SdkError("bad-input", { field: "terms.claimTip" });
  } else if (locker !== maker) {
    throw new SdkError("bad-input", { field: "terms.order.locker" });
  }
  const clientViewPoint = assertPoint(edViewPointClient, "edViewPointClient");
  const nodeViewPoint = assertPoint(edViewPointNode, "edViewPointNode");
  const nodeScalar = scalarBytes(nodeViewScalar, "nodeViewScalar");
  if (pointOf(nodeViewScalar, "nodeViewScalar").toLowerCase() !== nodeViewPoint.toLowerCase()) {
    throw new SdkError("bad-input", { field: "edViewPointNode" });
  }
  const clientScalar = scalarBytes(clientViewScalar, "clientViewScalar");
  if (pointOf(clientViewScalar, "clientViewScalar").toLowerCase() !== clientViewPoint.toLowerCase()) {
    throw new SdkError("bad-input", { field: "edViewPointClient" });
  }
  const requestTerms = {
    market: String(terms.market),
    side: requestSide,
    maker: normHex(terms.maker, 20, "terms.maker"),
    registry: normHex(terms.registry, 20, "terms.registry"),
    featuresHash: verdict.featuresHash,
    xmrNetwork: String(terms.xmrNetwork),
    order: {
      chainId: String(order.chainId),
      factory: normHex(order.factory, 20, "terms.order.factory"),
      locker: normHex(order.locker, 20, "terms.order.locker"),
      claimer: normHex(order.claimer, 20, "terms.order.claimer"),
      amount: String(order.amount),
      readyBy: Number(order.readyBy),
      t1: Number(order.t1),
      salt: normHex(order.salt, 32, "terms.order.salt"),
    },
    xmrAmount: String(terms.xmrAmount),
    claimTip: String(terms.claimTip),
  };
  const missing = firmTermsMissingFields(requestTerms);
  if (missing.length) throw new SdkError("bad-input", { field: "terms", missing });
  const termsDigest = hex(firmTermsDigest({ crypto: { keccak256 }, terms: requestTerms }));
  const info = relayViewInfo({
    termsDigest,
    commitHalf,
    edPoint: point,
    edViewPointClient: clientViewPoint,
    edViewPointNode: nodeViewPoint,
  });
  const plaintext = new Uint8Array(64);
  plaintext.set(nodeScalar, 0);
  plaintext.set(clientScalar, 32);
  const viewEnvelope = await sealViewEnvelope({ hpkeKey: verdict.hpkeKey, info, plaintext });
  const payload = JSON.stringify({
    terms: requestTerms,
    clientHalf: { commitHalf, edPoint: point, proof },
    edViewPointClient: clientViewPoint,
    edViewPointNode: nodeViewPoint,
    viewEnvelope,
  });
  return {
    payload,
    terms: requestTerms,
    viewEnvelope,
    edViewPointClient: clientViewPoint,
    edViewPointNode: nodeViewPoint,
  };
}
