// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/depositor.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// THE DEPOSITOR BY SIGNATURE, CLIENT SIDE: EIP-712 typed data over the QUOTE DIGEST.
//
// WHY. The factory has a path createOrderAndFundByDepositor: ANYONE may send the transaction (a relayer, our
// service), but the depositor is whoever signed the quote digest, so the depositor must sign first. A wallet
// signature is typed data, not a transaction: it costs no gas and moves no money, so a person without ETH can give it.
//
// WHY THIS FORM, NOT AN INVENTED ONE. The field set and domain are PART OF THE PROTOCOL - the same OrderQuote
// the escrow verifies and the node signs. Two swapped fields give a DIFFERENT digest and the factory refuses
// BadDepositorSignature. So the form is ONE list below, and a check computes the digest with it and compares.
//
// DOMAIN. verifyingContract is the FACTORY ADDRESS FROM THE QUOTE (field `factory`), chainId is live: a signature
// made for another factory or network will not recover here. There is no second source of the domain.
//
// NO CRYPTOGRAPHY HERE: the wallet computes the digest (eth_signTypedData_v4). Here is only the form and its check.

import { SIGNING_DOMAIN } from "../core/config.js";

// The domain name and version are quote protocol v8. They are NOT brand literals here: they belong to the registry
// contract (it returns DOMAIN_SEPARATOR()), so they are read from the config. The defaults equal today's values.
export const DEPOSITOR_DOMAIN_NAME = SIGNING_DOMAIN.name;
export const DEPOSITOR_DOMAIN_VERSION = SIGNING_DOMAIN.version;

// FIELD SET IN CONTRACT ORDER. The order is part of the ABI: a swap gives another digest. One list feeds both
// the type string and the message, so they cannot diverge.
export const ORDER_QUOTE_TYPED_FIELDS = [
  ["provider", "address"],
  ["quoteKey", "address"],
  ["registry", "address"],
  ["cashier", "address"],
  ["locker", "address"],
  ["claimer", "address"],
  ["amount", "uint256"],
  ["readyBy", "uint64"],
  ["t1", "uint64"],
  ["salt", "bytes32"],
  ["commitHalfClaimer", "bytes32"],
  ["edPointClaimer", "bytes32"],
  ["chainId", "uint256"],
  ["feeBps", "uint256"],
  ["fee", "uint256"],
  ["feeRecipient", "address"],
  ["validUntil", "uint64"],
  ["nonce", "uint256"],
  // THE XMR SIDE OF THE DEAL, in atomic units: it joined the signed set together with the contract
  // (OrderQuote.sol), the node/SDK spec and the vector, so the depositor's signature covers the same XMR the chain
  // verifies. A field the chain could not see used to stay OUT of this list on purpose - that is no longer the case.
  ["xmrAmount", "uint256"],
];

// The message type. Built from the list: editing the list changes both the type and the signature, so it cannot
// go unnoticed.
export const ORDER_QUOTE_TYPED_TYPE = "OrderQuote(" + ORDER_QUOTE_TYPED_FIELDS.map(([n, t]) => t + " " + n).join(",") + ")";

const isHex = (v, bytes) => new RegExp("^(0x)?[0-9a-fA-F]{" + bytes * 2 + "}$").test(String(v === undefined || v === null ? "" : v).trim());
const isNum = (v) => /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(String(v === undefined || v === null ? "" : v).trim());

// FORM IS NORMALISED, NOT DEMANDED. The quote carries ed25519 points WITHOUT the 0x prefix, while the wallet and
// contract expect the same BYTES. So we normalise here and reject anything that is not address/bytes32/number.
function normaliseField(name, type, value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (raw === "") throw new Error("the quote carries no depositor-signature field: " + name);
  if (type === "address") {
    if (!isHex(raw, 20)) throw new Error("field " + name + " is not an address: " + raw);
    return "0x" + raw.replace(/^0x/, "").toLowerCase();
  }
  if (type === "bytes32") {
    if (!isHex(raw, 32)) throw new Error("field " + name + " is not bytes32: " + raw);
    return "0x" + raw.replace(/^0x/, "").toLowerCase();
  }
  // uint64 / uint256: the wallet accepts a string; decimal and hex are parsed the same.
  if (!isNum(raw)) throw new Error("field " + name + " is not a number: " + raw);
  return String(BigInt(raw));
}

/**
 * EIP-712 typed data that the depositor signs (eth_signTypedData_v4).
 * The domain is built FROM THE QUOTE: verifyingContract = quote.factory, chainId = quote.chainId.
 * @returns {{ domain: object, types: object, primaryType: string, message: object }}
 */
export function orderQuoteTypedData(quote) {
  if (!quote || typeof quote !== "object") throw new Error("no signed quote: nothing to sign");
  if (!isHex(quote.factory, 20)) throw new Error("the quote has no factory address - cannot build the signing domain");
  if (!isNum(quote.chainId)) throw new Error("the quote has no chainId - cannot build the signing domain");
  const message = {};
  for (const [name, type] of ORDER_QUOTE_TYPED_FIELDS) {
    message[name] = normaliseField(name, type, quote[name]);
  }
  return {
    domain: {
      name: DEPOSITOR_DOMAIN_NAME,
      version: DEPOSITOR_DOMAIN_VERSION,
      chainId: Number(BigInt(quote.chainId)),
      verifyingContract: "0x" + String(quote.factory).replace(/^0x/, "").toLowerCase(),
    },
    types: {
      // EIP712Domain explicit: wallets show it to the person, and it must match what the chain computes.
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      OrderQuote: ORDER_QUOTE_TYPED_FIELDS.map(([name, type]) => ({ name, type })),
    },
    primaryType: "OrderQuote",
    message,
  };
}

// SIGNATURE ON THE WIRE - 65 BYTES r || s || v. The form is checked HERE: the factory takes the signature as
// three words, and a "signature-like" string must not reach the contract as consent.
export function depositorSignatureShape(signature) {
  const hex = String(signature === undefined || signature === null ? "" : signature).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return { ok: false, reason: "the depositor signature must be 65 bytes (r || s || v), got " + hex.length / 2 + " bytes" };
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) return { ok: false, reason: "depositor signature v outside {27,28}: " + v };
  return { ok: true, r: "0x" + hex.slice(0, 64).toLowerCase(), s: "0x" + hex.slice(64, 128).toLowerCase(), v: 27 + (v - 27) };
}
