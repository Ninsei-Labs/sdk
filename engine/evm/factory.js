// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/factory.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Calls to the NinseiSwap escrow factory contract.
//
// There are no EVM libraries in the project and we are not adding any. BOTH FACTORY FUNCTIONS NOW TAKE THE
// SIGNED QUOTE (OrderQuote.Quote), the signature as three words (r, s, v) and three depositor fields. The fee
// and the registry address are PART of the quote, not a contract setting: the factory no longer has feeBps()/
// feeFor() (the router was removed), so there is nothing to ask. All arguments are static, so calldata is a
// selector plus 32-byte words, built here in one place and checked mechanically.
//
//   cast sig "predict((address,address,address,address,address,address,uint256,uint64,uint64,bytes32,bytes32,bytes32,uint256,uint256,uint256,address,uint64,uint256,uint256),bytes32,bytes32,uint8,bytes32,bytes32,bytes32)" -> 0x0824d205
//   cast sig "createOrderAndFund(<same tuple>,...)"                                                                                                                -> 0x4703a9d3

export const FACTORY_METHODS = {
  // THE QUOTE GREW THE xmrAmount FIELD: the XMR side of the deal is part of the signed set, so both selectors
  // changed a second time (earlier for the cashier field).
  predict: "0x0824d205",
  // create the escrow AND deposit funds in ONE transaction (a value transfer with the call).
  createOrderAndFund: "0x4703a9d3",
  // create the escrow and deposit when the DEPOSITOR is recovered FROM THE SIGNATURE over the quote digest:
  // anyone may send the transaction, and `locker` is set to the signer.
  createOrderAndFundByDepositor: "0x2acd187b",
};

// The OrderCreated event topic. It grew the registry address, the provider and the signing key:
//   cast keccak "OrderCreated(address,address,address,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint64,uint64,bytes32,address,address,address)"
// The topic lives in TWO places and both must match; a check pins them.
export const ORDER_CREATED_TOPIC =
  "0xa22cdabaed3cce4f51dde71626a108ffe9c7bc4216fd14d5e719f892e2fd8ab0";

// QUOTE FIELDS IN CONTRACT ORDER. The order is part of the ABI: a swap gives another call. One list for both
// functions, so they cannot diverge.
export const QUOTE_FIELDS = [
  "provider", "quoteKey", "registry", "cashier", "locker", "claimer", "amount", "readyBy", "t1", "salt",
  "commitHalfClaimer", "edPointClaimer", "chainId", "feeBps", "fee", "feeRecipient", "validUntil", "nonce", "xmrAmount",
];
// The depositor fields are NOT in the quote: they go as separate arguments (into the escrow init code).
const LOCKER_HALF_FIELDS = ["commitHalfLocker", "edPointLocker", "edViewPointLocker"];
const ADDR_FIELDS = ["provider", "quoteKey", "registry", "cashier", "locker", "claimer", "feeRecipient"];
const B32_FIELDS = ["salt", "commitHalfClaimer", "edPointClaimer", "commitHalfLocker", "edPointLocker", "edViewPointLocker"];

// A calldata word: a value right-aligned to 32 bytes. Numbers arrive decimal (wei, deadlines) but must be hex in
// calldata: padding decimal digits as hex would change the number. Caught by comparison with a Foundry reference.
export function word(value, bytes = 32) {
  const raw = String(value).trim();
  let hex;
  if (/^0x[0-9a-fA-F]*$/.test(raw)) {
    hex = raw.slice(2).toLowerCase();
    if (hex.length === 0) hex = "0";
  } else if (/^[0-9]+$/.test(raw)) {
    hex = BigInt(raw).toString(16);
  } else {
    throw new Error("not a number and not hex: " + value);
  }
  if (!/^[0-9a-f]*$/.test(hex)) throw new Error("not hex: " + value);
  if (hex.length > bytes * 2) throw new Error(`value does not fit in ${bytes} bytes: ${value}`);
  return hex.padStart(bytes * 2, "0");
}

// FORM IS NORMALISED, NOT DEMANDED: points and commitments in the engine record sit WITHOUT the 0x prefix, while
// word() requires it. Same bytes, so both forms encode identically.
const asHex32 = (v) => {
  const x = String(v === undefined || v === null ? "" : v).trim();
  return /^[0-9a-fA-F]{64}$/.test(x) ? "0x" + x.toLowerCase() : x;
};

// WORDS OF THE SIGNED SET. The signature is 65 bytes r || s || v; v is normalised to 27/28 (the contract takes
// both). r and s are FULL 32 bytes, v is a FULL 32-byte word (ABI uint8 is never shorter: a short word would shift
// the calldata tail and the call would go to a non-existent selector).
function quoteWords(quote) {
  for (const name of QUOTE_FIELDS) {
    if (quote[name] === undefined || quote[name] === null || quote[name] === "") throw new Error("the quote has no field: " + name);
  }
  // FORM IS CHECKED, NOT PADDED: a short address or a truncated bytes32 would be silently zero-padded and reach
  // the contract as a DIFFERENT value.
  for (const name of ADDR_FIELDS) {
    if (!/^(0x)?[0-9a-fA-F]{40}$/.test(String(quote[name]).trim())) throw new Error("quote field " + name + " is not an address");
  }
  for (const name of B32_FIELDS) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(String(quote[name]).trim())) throw new Error("quote field " + name + " is not bytes32");
  }
  const map = {
    provider: word(quote.provider, 32), quoteKey: word(quote.quoteKey, 32), registry: word(quote.registry, 32),
    cashier: word(quote.cashier, 32),
    locker: word(quote.locker, 32), claimer: word(quote.claimer, 32),
    amount: word(quote.amount, 32), readyBy: word(quote.readyBy, 32), t1: word(quote.t1, 32),
    salt: word(asHex32(quote.salt), 32),
    commitHalfClaimer: word(asHex32(quote.commitHalfClaimer), 32),
    edPointClaimer: word(asHex32(quote.edPointClaimer), 32),
    chainId: word(quote.chainId, 32), feeBps: word(quote.feeBps, 32), fee: word(quote.fee, 32),
    feeRecipient: word(quote.feeRecipient, 32), validUntil: word(quote.validUntil, 32), nonce: word(quote.nonce, 32),
    xmrAmount: word(quote.xmrAmount, 32),
  };
  return QUOTE_FIELDS.map((n) => map[n]).join("");
}

function signatureWords(signature) {
  const hex = String(signature || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error("the quote signature must be 65 bytes: " + String(signature).slice(0, 20));
  const r = hex.slice(0, 64), s = hex.slice(64, 128);
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  return word("0x" + r, 32) + word("0x" + s, 32) + word(v, 32);
}

// The common part of predict and createOrderAndFund.
function lockerHalfWords(quote) {
  return LOCKER_HALF_FIELDS.map((name) => {
    if (quote[name] === undefined || quote[name] === null || quote[name] === "") throw new Error("the quote has no depositor field: " + name);
    return word(asHex32(quote[name]), 32);
  }).join("");
}

function quoteCallArgs(quote) {
  return quoteWords(quote) + signatureWords(quote.signature) + lockerHalfWords(quote);
}

// PREDICT THE ADDRESS. The argument set matches createOrderAndFund BYTE FOR BYTE (the address is the code hash of
// creation, and the signature is part of it).
export function encodePredict(quote) {
  return FACTORY_METHODS.predict + quoteCallArgs(quote);
}

// CREATE AND DEPOSIT. The depositor becomes msg.sender; its address is already inside the quote and the factory
// checks it against the sender.
export function encodeCreateOrderAndFund(quote) {
  return FACTORY_METHODS.createOrderAndFund + quoteCallArgs(quote);
}

// CREATE AND DEPOSIT when the depositor is recovered FROM ITS SIGNATURE over the quote digest. Anyone may send
// the transaction, so there are TWO signers: quote.signature (the provider, checked by the escrow) and
// depositorSignature (the depositor, checked by the factory, which requires the recovered address to equal
// quote.locker). Both over ONE digest.
export function encodeCreateOrderAndFundByDepositor(quote, depositorSignature) {
  return FACTORY_METHODS.createOrderAndFundByDepositor + quoteWords(quote) +
    signatureWords(quote.signature) + signatureWords(depositorSignature) + lockerHalfWords(quote);
}

// predict() answer - one address in a 32-byte word.
export function decodeAddress(returnedHex) {
  const hex = String(returnedHex || "").replace(/^0x/, "");
  if (hex.length < 64) throw new Error("short answer: " + returnedHex);
  return "0x" + hex.slice(24, 64);
}


// ============================================================================================
// ESCROW IMPLEMENTATION: ITS ADDRESS AND CODE HASH. Every order escrow is an EIP-1167 CLONE of one shared
// implementation, and the implementation address and code hash live at the factory. The FACTORY checks the pair
// at order creation; the CLIENT must check the SAME pair, else the clone runs foreign code and the money paths
// "pass" for nothing (a delegatecall to an address without code SUCCEEDS). Here we only read fields and give a
// verdict; the chain calls are made by the carrier, so the function is pure.
// ============================================================================================

// Selectors are computed by a tool, not by hand:
//   cast sig "implementation()"         -> 0x5c60da1b
//   cast sig "implementationCodeHash()" -> 0xbc0a3981
export const FACTORY_READS = {
  implementation: "0x5c60da1b",
  implementationCodeHash: "0xbc0a3981",
};

// Reading a factory field with no arguments: calldata is the selector.
export function encodeFactoryRead(name) {
  const sel = FACTORY_READS[name];
  if (typeof sel !== "string" || !/^0x[0-9a-f]{8}$/.test(sel)) throw new Error("no such factory read: " + name);
  return sel;
}

// implementation() - one address in a 32-byte word.
export function decodeImplementation(returnedHex) {
  return decodeAddress(returnedHex);
}

// implementationCodeHash() - one bytes32 word.
export function decodeImplementationCodeHash(returnedHex) {
  const hex = String(returnedHex || "").replace(/^0x/, "");
  if (hex.length < 64) throw new Error("short answer from implementationCodeHash(): " + returnedHex);
  return "0x" + hex.slice(0, 64).toLowerCase();
}

// VERDICT ON THE IMPLEMENTATION - the same three conditions the factory checks:
//   1) the implementation address is named and its CODE on chain is non-empty: a delegatecall to an address without
//      code succeeds, so a clone without an implementation would take ETH and markReady/claim/refund would "pass";
//   2) the implementation code hash equals the factory recorded hash (compared by the factory via codehash);
//   3) the recorded hash is in the interface policy (a list of known builds), if set.
// If hashCode is given (keccak256 of the code bytes), the live code is compared too: the verdict then recomputes
// the hash from eth_getCode.
export function verifyFactoryImplementation({ implementation, implementationCodeHash, code, hashCode, policy } = {}) {
  if (!implementation || !/^0x[0-9a-fA-F]{40}$/.test(String(implementation))) {
    return { ok: false, why: "implementation-missing" };
  }
  if (!implementationCodeHash || !/^0x[0-9a-fA-F]{64}$/.test(String(implementationCodeHash))) {
    return { ok: false, why: "code-hash-missing" };
  }
  if (code === undefined || code === null || code === "0x" || code === "0x0") {
    return { ok: false, why: "implementation-has-no-code" };
  }
  const pinned = String(implementationCodeHash).toLowerCase();
  if (Array.isArray(policy) && policy.length) {
    if (!policy.map((h) => String(h).toLowerCase()).includes(pinned)) {
      return { ok: false, why: "implementation-code-unknown", codeHash: pinned };
    }
  }
  if (typeof hashCode === "function") {
    const live = String(hashCode(code)).toLowerCase();
    if (live !== pinned) return { ok: false, why: "implementation-code-mismatch", got: live, want: pinned };
  }
  return { ok: true, codeHash: pinned };
}

// READING THE PAIR AT THE FACTORY + VERDICT - ONE PLACE FOR ALL CARRIERS (SDK, node, watchtower). It reads the
// factory fields (implementation()/implementationCodeHash()) and the CODE at the implementation address, then
// applies the same verdict the factory applies at order creation (verifyFactoryImplementation above). The chain
// is injected: read - eth_call({to,data}) -> hex, code - eth_getCode(address) -> hex. The module stays pure: no
// import, no network call. Carriers pass their OWN reads. hashCode, if given, recomputes the live code.
export async function verifyFactoryImplementationOnChain({ factory, read, code, policy = null, hashCode = null } = {}) {
  if (!factory || !/^0x[0-9a-fA-F]{40}$/.test(String(factory))) {
    return { ok: false, why: "factory-missing" };
  }
  if (typeof read !== "function") return { ok: false, why: "no-chain-read" };
  if (typeof code !== "function") return { ok: false, why: "no-code-read" };
  let implRaw, hashRaw;
  try {
    implRaw = await read({ to: factory, data: FACTORY_READS.implementation });
    hashRaw = await read({ to: factory, data: FACTORY_READS.implementationCodeHash });
  } catch {
    // READING THE PAIR FAILED - A NAMED REFUSAL, NOT SILENCE. An old factory (without these getters) reverts:
    // the pair is unread, there is no verdict, and the carrier must refuse.
    return { ok: false, why: "implementation-unreadable", factory: String(factory).toLowerCase() };
  }
  let implementation, implementationCodeHash;
  try {
    implementation = decodeImplementation(implRaw);
    implementationCodeHash = decodeImplementationCodeHash(hashRaw);
  } catch {
    return { ok: false, why: "implementation-unreadable", factory: String(factory).toLowerCase() };
  }
  let liveCode;
  try {
    liveCode = await code(implementation);
  } catch {
    return { ok: false, why: "implementation-code-unreadable", implementation };
  }
  const verdict = verifyFactoryImplementation({ implementation, implementationCodeHash, code: liveCode, hashCode, policy });
  return { ...verdict, implementation, implementationCodeHash };
}
