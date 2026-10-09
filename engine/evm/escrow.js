// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/escrow.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Calls to the NinseiSwap escrow contract (one instance = one order).
//
// There is no EVM library here: the escrow has three state-moving functions (markReady, claim, refund) and a few
// readers, so calldata is built from a selector and 32-byte words. There is NO FUNDING FUNCTION: an order is born
// funded in the creation transaction, and the two-step path (create empty, fund by a second call) was removed with
// it - that path locked money inside a closed order. Hence no fund() selector below.
// Selectors were computed by a tool, and they are the signatures the contract HAS:
//   cast sig "markReady()"     -> 0x1ca087e7
//   cast sig "claim(bytes32)"  -> 0xbd66528a
//   cast sig "refund(bytes32)" -> 0x7249fbb6   (no refund() without an argument: the half is mandatory)
//   cast sig "status()"        -> 0x200d2ed2
// They are cross-checked against the Foundry reference (cast sig / cast calldata).
//
// EVENTS EXIST - THREE OF THEM:
//   HalfRevealed(bytes32 half, bool byClaimer), OrderTerms(...), Ready(address indexed by), StrayRescued(...)
// State is still read by calling status(), and the reason is not the absence of events:
//   1) FUNDING HAS NO EVENT AT ALL: the funded flag is set in the constructor together with OrderTerms, so the
//      first order state never reaches the logs;
//   2) status() returns all four values - funded, claimed, refunded, balance - in ONE call by escrow address.
//      There is no need to follow logs from the creation block. HalfRevealed carries byClaimer, so it tells both
//      "claimed" and "refunded": useful for whoever keeps an order journal, but status() reads one order on the spot.

export const ESCROW_METHODS = {
  // NO FUNDING HERE, ON PURPOSE. The old fund() encoded as 0xb60d4288; the contract no longer has it, and its
  // rules moved into order birth: the constructor checks exactly `amount + fee`, paid by the named depositor. A
  // returning line with this selector reddens the ABI check.
  // mark readiness: "I see the XMR". Without it a claim is impossible - the guard against claiming ETH without XMR.
  // Only the depositor sets it, only on a funded order, and only before readyBy.
  markReady: "0x1ca087e7",
  // claim, presenting YOUR half; its hash (the commitment) was fixed in the order at creation.
  // Anyone may send it - the contract does not check the sender - but the money goes to the recorded claimer, so
  // the caller cannot redirect it.
  claim: "0xbd66528a",
  // refund after t1, PRESENTING THE DEPOSITOR'S HALF: the contract checks its hash against commitHalfLocker and
  // rejects a foreign half (BadHalf). So "anyone may call" is precise: anyone may SEND the transaction (the
  // watchtower role), but only the holder of the depositor's half can carry it through. The money always goes to
  // the depositor, and the half is published - with it he claims his XMR.
  refund: "0x7249fbb6",
  // state: (funded, claimed, refunded, balance)
  status: "0x200d2ed2",
  // ONE DEADLINE. Before t1 only the claimer may claim by his half and only with the ready mark; from t1 a claim
  // is forbidden and anyone may refund by presenting the depositor's half. There is no t0() selector: the t0 field
  // does not exist in the contract. Orders created earlier carry their deadline in the deal record, with the old
  // rule - see derive() in core/swap.js.
  t1: "0xfb5343f3",
  // up to this deadline the depositor may mark readiness; strictly before t1
  readyBy: "0x53fc2f40",
  // whether readiness is marked: without it a claim is closed
  ready: "0x6defbf80",
  // the half revealed by settlement: from it the other side assembles the spend key
  revealedHalf: "0x3f267bb6",
  // ORDER POINTS AND COMMITMENTS, read FROM THE ESCROW ITSELF. Needed before signing: the DLEQ proof binds a half
  // to a point but does not stop OTHER points from being put into the order - then the Monero address would be
  // assembled from the wrong halves, and only a comparison of the LIVE CHAIN slots with what the page assembled
  // reveals it. Selectors are `cast sig` over the actual signatures; the ABI check cross-checks the table.
  edPointLocker: "0x8c03382b",     // the depositor's spend point: half of the joint address
  edPointClaimer: "0xdd98c465",    // and the claimer's spend point: checked against the quote, not taken on trust
  edViewPointLocker: "0x9a06a5fe", // and his view point: without it the Monero address cannot be built
  commitHalfLocker: "0x498b422e",  // commitment to the depositor's half: the contract checks refund by it
  commitHalfClaimer: "0x7d4c81f7", // commitment to the claimer's half: the contract checks claim by it
  // order terms in one hash. It ties the recovery file to the on-chain order: by it the file's owner checks the
  // file belongs to THIS escrow and not a look-alike.
  // A FORMER GAP, CLOSED BY DECISION: the depositor's view point used to be OUTSIDE the hash, so it had to be
  // checked separately. Now it is inside, right after the claimer's point as in the OrderTerms event, so the order
  // is checked WHOLE. THE PRICE IS NAMED: every order's hash changes, so the factory and escrow are redeployed,
  // and addresses recorded before that do not refer to the new orders.
  termsHash: "0xb311d9fd",
  // FEE, REGISTRY AND ORIGIN - ALL READ FROM THE ESCROW. The factory no longer has these fields (the router was
  // removed): the rate, amount and recipient of the fee, the registry address, the provider and the signing key
  // come in the signed quote as immutable order fields. Selectors are `cast sig` over the actual signatures.
  fee: "0xddca3f43",                // fee amount in wei (computed at order creation)
  feeBps: "0x24a9d853",             // rate in basis points (30 = 0.30%)
  feeRecipient: "0x46904840",       // who the fee is credited to in the cashier
  feeOnTop: "0x2296cc23",           // true - a buy (fee on top), false - a sell (deducted from the payout)
  registry: "0x7b103999",           // maker registry address FROM THE ORDER TERMS
  cashier: "0xed740e97",            // fee cashier FROM THE ORDER TERMS: the factory does NOT create it
  provider: "0x085d4883",           // the provider declared in the quote (checked against the registry)
  quoteKey: "0x391d53ca",           // the key the quote was signed with
  validUntil: "0xddac6654",         // quote validity (SECONDS)
  nonce: "0xaffed0e0",              // quote nonce
};

// The escrow has NO dynamic arguments, so every call below is a bare selector. The funding encoder is gone with
// the function itself (see the note in ESCROW_METHODS).
// call markReady(): no arguments.
export function encodeMarkReady() {
  return ESCROW_METHODS.markReady;
}

// call ready()/readyBy()/revealedHalf(): no arguments - their calldata equals the selector, so there are no
// separate encoders and the selectors live in ESCROW_METHODS above.

// call claim(secret): the secret is bytes32. In the contract it is the CLAIMER'S half (the parameter is named
// halfClaimer), called a "secret" because it is the preimage of the commitHalfClaimer commitment: the contract
// compares keccak256 of the presented half with its commitment and nothing more - it does not check the link
// between the half and the Monero address.
export function encodeClaim(secret) {
  return ESCROW_METHODS.claim + halfAsThirtyTwoBytes(secret, "secret");
}

// A HALF IS A NUMBER, NOT A FIXED-LENGTH STRING. In the deal record and the recovery file it is stored as is, and
// a leading zero is lost: 63 digits instead of 64. The contract needs exactly 32 bytes, so we pad on the left (as
// the node does in its claim). Without this a refund was impossible in principle: on screen it looked like "the
// half must be 32 bytes" on a live click of the refund button.
function halfAsThirtyTwoBytes(value, what) {
  const hex = String(value || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new Error(what + " must be a number of up to 32 bytes: " + value);
  return hex.padStart(64, "0");
}

// call refund(bytes32 halfLocker): the DEPOSITOR'S half is presented, not the caller's - the contract checks its
// hash against commitHalfLocker and rejects a foreign one (BadHalf). The sender is not checked: the half itself
// grants the right to call.
export function encodeRefund(halfLocker) {
  return ESCROW_METHODS.refund + halfAsThirtyTwoBytes(halfLocker, "half");
}

// call status(): no arguments.
export function encodeStatus() {
  return ESCROW_METHODS.status;
}

// call t1(): no arguments.
export function encodeT1() {
  return ESCROW_METHODS.t1;
}

// call termsHash(): no arguments.
export function encodeTermsHash() {
  return ESCROW_METHODS.termsHash;
}

// call an escrow method WITHOUT arguments by name. Used where there are many reads (the order slots): a function
// per selector would mean a second table of the same names, free to diverge silently.
export function encodeRead(name) {
  const sel = ESCROW_METHODS[name];
  if (typeof sel !== "string" || !/^0x[0-9a-f]{8}$/.test(sel)) throw new Error("no such escrow method: " + name);
  return sel;
}

// Parse a bytes32 answer: one word.
export function decodeBytes32(returnedHex, what = "value") {
  const hex = String(returnedHex || "").replace(/^0x/, "");
  if (hex.length < 64) throw new Error("short answer " + what + ": " + returnedHex);
  return "0x" + hex.slice(0, 64).toLowerCase();
}

// Parse the t1() answer: one word, uint64 inside uint256.
export function decodeUint64(returnedHex, what = "value") {
  const hex = String(returnedHex || "").replace(/^0x/, "");
  if (hex.length < 64) throw new Error("short answer " + what + ": " + returnedHex);
  const v = BigInt("0x" + hex.slice(0, 64));
  if (v > 18446744073709551615n) throw new Error("answer " + what + " does not fit in uint64: " + v);
  return Number(v);
}

// Parse the status() answer: four 32-byte words - three flags and the balance.
export function decodeStatus(returnedHex) {
  const hex = String(returnedHex || "").replace(/^0x/, "");
  if (hex.length < 256) throw new Error("short status() answer: " + returnedHex);
  const word = (i) => hex.slice(i * 64, (i + 1) * 64);
  return {
    isFunded: BigInt("0x" + word(0)) !== 0n,
    isClaimed: BigInt("0x" + word(1)) !== 0n,
    isRefunded: BigInt("0x" + word(2)) !== 0n,
    balance: BigInt("0x" + word(3)),
  };
}

// Which order terms the escrow needs at creation - in one place, so the form and the checks do not diverge.
// ONE DEADLINE. There is no t0 field: before t1 ETH is claimed by the claimer via his half and only with the
// ready mark; from t1 a claim is forbidden and anyone may refund by PRESENTING THE DEPOSITOR'S HALF - the
// watchtower does not have it, so "anyone refunds" reads as "anyone holding the half".
// The "t1 later than t0" check lost its meaning, but emptiness did not take its place: the deadline must be IN
// THE FUTURE, else the order is created already closed - no claim is possible and the money hangs until refund.
// The CONTRACT has no upper bounds and no "future deadlines" rule: the constructor only checks amount != 0 and
// t1 > readyBy, and deadlines in the past are fine for it. This function holds those bounds - the contract
// protects the money, not the caller from an order with past deadlines.
export function orderTerms({ locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, amount, readyBy, t1 }) {
  for (const [k, v] of Object.entries({ locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, amount })) {
    if (v === undefined || v === null || v === "") throw new Error("order term not set: " + k);
  }
  // Two deadlines that must NOT coincide: coincidence would restore a window where claim and refund are both
  // valid and gas would decide the dispute. The first is the readiness window, the second the settlement boundary.
  if (Number(readyBy) <= Math.floor(Date.now() / 1000)) throw new Error("readyBy must be in the future: " + readyBy);
  if (Number(t1) <= Number(readyBy)) throw new Error("t1 must be later than readyBy");
  return { locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, amount, readyBy, t1 };
}
