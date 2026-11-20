// THE INPUTS OF THE SIGNED TRANSACTION ARE THE UNSPENT OUTPUTS THE CALLER VERIFIED.
//
// The page used to parse the serialized transaction itself. That parser is tied to the transaction format; the SDK
// owns the comparison now. The signed transaction object exposes its inputs through the wallet library, so a format
// change does not silently turn the check off.
import { SdkError } from "./errors.mjs";

const HASH = /^[0-9a-f]{64}$/i;
const lower = (value) => String(value).toLowerCase();

// `sweep.keyImages` returns records; a page that already has the hex strings may pass those instead.
export function normalizeKeyImages(value) {
  if (!Array.isArray(value)) throw new SdkError("bad-input", { field: "keyImages" });
  const images = value.map((entry, position) => {
    const image = typeof entry === "string" ? entry : entry && entry.keyImage;
    if (typeof image !== "string" || !HASH.test(image)) {
      throw new SdkError("bad-input", { field: "keyImages", why: "key-image", position });
    }
    return lower(image);
  });
  if (!images.length) throw new SdkError("bad-input", { field: "keyImages", why: "empty" });
  if (new Set(images).size !== images.length) throw new SdkError("bad-input", { field: "keyImages", why: "duplicate" });
  return images;
}

// The wallet library's signed transaction carries `getInputs()` and each input carries its key image. A signed
// object that cannot answer is unknown, never an empty set: an empty set would falsely match a caller with no images.
export function signedKeyImages(signed) {
  const list = Array.isArray(signed) ? signed : (signed === null || signed === undefined ? [] : [signed]);
  const images = [];
  for (const tx of list) {
    if (!tx || typeof tx.getInputs !== "function") {
      throw new SdkError("sweep-inputs-unknown", { why: "no-inputs" });
    }
    const inputs = tx.getInputs();
    if (!Array.isArray(inputs)) throw new SdkError("sweep-inputs-unknown", { why: "inputs-shape" });
    for (const input of inputs) {
      const keyImage = input && typeof input.getKeyImage === "function" ? input.getKeyImage() : input && input.keyImage;
      const hex = typeof keyImage === "string" ? keyImage
        : (keyImage && typeof keyImage.getHex === "function" ? keyImage.getHex() : keyImage && keyImage.hex);
      if (typeof hex !== "string" || !HASH.test(hex)) {
        throw new SdkError("sweep-inputs-unknown", { why: "key-image" });
      }
      images.push(lower(hex));
    }
  }
  if (!images.length) throw new SdkError("sweep-inputs-unknown", { why: "empty" });
  if (new Set(images).size !== images.length) throw new SdkError("sweep-inputs-unknown", { why: "duplicate" });
  return images;
}

export function sameKeyImages(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((image) => expected.has(image));
}

export function assertSameKeyImages(expected, actual, phase) {
  if (sameKeyImages(expected, actual)) return;
  throw new SdkError("sweep-inputs-changed", { phase, expected: expected.length, signed: actual.length });
}
