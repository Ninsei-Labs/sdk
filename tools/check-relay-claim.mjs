// A SELLER WITH NO WALLET CAN STILL CLAIM: the half goes to the relay that answered the quote and the signed tip
// pays the sender. This check drives the real `startSell` record and the real `claimViaRelay` wire with stand-in
// transports, and proves the own-wallet path is unchanged.
//
// It covers: a no-wallet success, a zero-tip refusal before any request, a foreign relay origin, a provider that
// disagrees with the answer, a node refusal, a lost answer (never success), and the `sellClaim` fallback.
import { createRecoveryKey, takerHalvesV2 } from "../src/recovery-key.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { keccak256, secp256k1 } from "../src/primitives.mjs";
import { createSwaps } from "../src/swaps.mjs";
import * as engine from "../src/engine.mjs";
import { createStore, memoryStorage } from "../engine/core/store.js";
import { encodeRead, encodeStatus } from "../engine/evm/escrow.js";

const order = {
  chainId: 421614,
  factory: "0x" + "11".repeat(20),
  locker: "0x" + "a1".repeat(20),
  claimer: "0x" + "b2".repeat(20),
  amount: "1000000000000000000",
  readyBy: 2_000_000_000,
  t1: 2_000_003_600,
  salt: "0x" + "44".repeat(32),
  asset: "ETH",
};
const mnemonic = createRecoveryKey().mnemonic;
const derived = takerHalvesV2({ mnemonic, chainId: order.chainId, factory: order.factory, salt: order.salt });
const own = buildOwnSideFromHalves(order, { spendHalf: derived.spendHalf, viewHalf: derived.viewHalf });
const ownCommit = "0x" + Buffer.from(keccak256(secp256k1.Point.fromHex(own.side.proof.XA).toBytes(false).slice(1))).toString("hex");
const escrow = "0x" + "dd".repeat(20);
const claimTip = "1000000000000000";
const quote = {
  id: "oq_relay_claim",
  provider: order.locker, factory: order.factory,
  locker: order.locker, claimer: order.claimer, chainId: order.chainId,
  amount: order.amount, xmrAmount: "1000000000000", claimTip,
  commitHalfLocker: "0x" + "a1".repeat(32), edPointLocker: "0x" + "a2".repeat(32), edViewPointLocker: "0x" + "a3".repeat(32),
  edPointClaimer: own.spendPoint, commitHalfClaimer: ownCommit,
};
const offer = {
  order,
  quote,
  orderQuote: { ...quote, signature: "0x" + "55".repeat(65) },
  nodeHalf: { commitHalf: "0x" + "77".repeat(32), edPoint: "0x" + "88".repeat(32) },
  edViewPointClaimer: own.viewPoint,
  edViewPointLocker: "0x" + "99".repeat(32),
  jointAddress: "52TsoaDECj3P6WFzmChWEq6WMLf9gYp831b76bRNzFN4EMDgNXuxDQXY8hRcmncmMMF3o5bYqFeTEbzPQ3joqdABAeGwY3z",
  escrow,
  context: "relay-claim",
  recovery: { kind: "salt-v2", salt: order.salt },
  viewHalfClaimer: derived.makerViewHalf,
  relayUrl: "https://relay.example/",
  readyWindow: { side: "bid", readyMinSeconds: 2400, readyMaxSeconds: 3000 },
};

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const bytes = (value) => String(value).replace(/^0x/, "").padStart(64, "0");
const slotReads = {
  [encodeRead("t1")]: word(order.t1),
  [encodeRead("readyBy")]: word(order.readyBy),
  [encodeRead("ready")]: word(1),
  [encodeRead("termsHash")]: "00".repeat(32),
  [encodeRead("edPointLocker")]: bytes(offer.nodeHalf.edPoint),
  [encodeRead("edPointClaimer")]: bytes(quote.edPointClaimer),
  [encodeRead("edViewPointLocker")]: bytes(offer.edViewPointLocker),
  [encodeRead("commitHalfLocker")]: bytes(offer.nodeHalf.commitHalf),
  [encodeRead("commitHalfClaimer")]: bytes(quote.commitHalfClaimer),
  [encodeStatus()]: word(1) + word(0) + word(0) + word(1_000_000_000_000_000_000n),
};
const read = async ({ data }) => {
  const answer = slotReads[data];
  if (!answer) throw new Error("unexpected chain read " + data);
  return "0x" + answer;
};
const store = createStore(memoryStorage());
const swaps = createSwaps({ config: {}, call: read, store });
const accept = async () => true;

let sequence = 0;
const seed = async (overrides = {}) => {
  sequence += 1;
  const escrowAddress = overrides.escrow || ("0x" + String(sequence).padStart(2, "0") + "e".repeat(38));
  const made = {
    ...offer,
    ...overrides,
    escrow: escrowAddress,
    quote: { ...quote, ...(overrides.quote || {}), id: "oq_relay_claim_" + sequence },
    orderQuote: { ...quote, id: "oq_relay_claim_" + sequence, signature: "0x" + "55".repeat(65) },
    jointAddress: "52TsoaDECj3P6WFzmChWEq6WMLf9gYp831b76bRNzFN4EMDgNXuxDQXY8hRcmncmMMF3o5bYqFeTEbzPQ3joqdABAeGwY3z".slice(0, -2) + String(sequence % 10) + String(sequence % 10),
  };
  if (overrides.withoutRelay) { delete made.withoutRelay; delete made.relayUrl; }
  return await swaps.startSell({ offer: made, recoveryKey: mnemonic, onRecoveryKey: accept });
};

export const relayClaimCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const lower = (value) => String(value || "").toLowerCase();

  const record = await seed({ escrow });
  const stored = engine.swap.getSwap(record.id, store);
  check(stored && stored.relayUrl === "https://relay.example", "startSell did not store the relay origin");
  check(stored && stored.claimTip === claimTip && stored.escrow && stored.escrow.half,
    "the sale record does not carry the positive tip and the half");
  check(stored && stored.readyWindow && stored.readyWindow.readyMinSeconds === 2400
    && stored.readyWindow.readyMaxSeconds === 3000, "startSell did not store the node's ready window");

  // (0) THE RELAY IS PART OF THE OFFER ON A RESUME TOO: a retry naming another origin is a different offer.
  {
    try {
      await swaps.startSell({ offer: { ...offer, escrow, jointAddress: stored.escrow.moneroAddress,
        quote: { ...stored.quote }, orderQuote: stored.orderQuote, relayUrl: "https://other.example" },
        recoveryKey: mnemonic, onRecoveryKey: accept });
      check(false, "a resumed sell accepted another relay origin");
    } catch (error) {
      check(error && error.code === "quote-refused" && error.params && error.params.why === "relay-changed",
        "a resumed sell did not refuse another relay origin: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
    }
  }

  // (1) NO WALLET, NO CHAIN WRITE: the half goes to the stored relay and a real txid comes back.
  const sentCalls = [];
  const txid = "0x" + "ab".repeat(32);
  const sender = "0x" + "c3".repeat(20);
  const successFetch = async (url, init) => {
    sentCalls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ version: 1, provider: order.locker, escrow, txid, from: sender, tipWei: claimTip }) };
  };
  const noChain = createSwaps({ config: {}, store, call: () => { throw new Error("the no-wallet claim read the chain"); } });
  let claimed = null;
  try {
    claimed = await noChain.claimViaRelay({ id: record.id, fetchImpl: successFetch });
  } catch (error) {
    problems.push("the no-wallet claim refused: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
  }
  if (claimed) {
    check(claimed.txid === txid && claimed.from === sender && claimed.tipWei === claimTip,
      "the claim did not return the real txid, sender and tip");
    check(claimed.provider === lower(order.locker) && claimed.escrow === escrow && claimed.relayUrl === "https://relay.example",
      "the claim does not name the provider, escrow and relay it used");
  }
  check(sentCalls.length === 1, "the claim did not make exactly one relay request");
  if (sentCalls.length === 1) {
    const call = sentCalls[0];
    check(call.init && call.init.method === "POST", "the claim was not a POST");
    check(call.url === "https://relay.example/v1/claims/" + lower(order.locker) + "/" + escrow,
      "the claim path is not /v1/claims/{provider}/{escrow}: " + call.url);
    let body = null;
    try { body = JSON.parse(call.init.body); } catch { body = null; }
    check(body && body.version === 1 && body.halfClaimer === stored.escrow.half && Object.keys(body).length === 2,
      "the claim body is not exactly {version:1, halfClaimer:0x<64>}");
    check(!JSON.stringify(claimed).toLowerCase().includes(String(stored.escrow.half).replace(/^0x/, "")),
      "the claim result echoed the half");
  }

  // (2) A ZERO TIP IS REFUSED BEFORE THE HALF LEAVES THE CLIENT.
  {
    const zero = await seed({ quote: { claimTip: "0" } });
    let called = 0;
    try {
      await swaps.claimViaRelay({ id: zero.id, fetchImpl: async () => { called += 1; throw new Error("must not be called"); } });
      check(false, "a zero tip was claimed");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "claimTip" && error.params.why === "not-positive",
        "a zero tip was not refused with bad-input claimTip not-positive: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
    }
    check(called === 0, "a zero-tip claim reached the relay");
  }

  // (3) THE RELAY IS THE QUOTE'S. A foreign origin is refused before any request.
  {
    let called = 0;
    try {
      await swaps.claimViaRelay({ id: record.id, relayUrl: "https://other.example", fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; } });
      check(false, "a foreign relay origin was accepted");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "relayUrl" && error.params.why === "foreign-relay",
        "a foreign relay origin was not refused with bad-input relayUrl foreign-relay");
    }
    check(called === 0, "a foreign relay origin reached the network");
  }

  // (3b) A RECORD WITHOUT THE ORIGIN CANNOT CLAIM THROUGH A GUESS.
  {
    const noRelay = await seed({ withoutRelay: true });
    try {
      await swaps.claimViaRelay({ id: noRelay.id, fetchImpl: async () => { throw new Error("must not be called"); } });
      check(false, "a record without a relay origin was claimed");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "relayUrl" && error.params.why === "not-in-record",
        "a missing relay origin was not refused with bad-input relayUrl not-in-record");
    }
  }

  // (4) A PROVIDER THAT DISAGREES WITH THE ANSWER IS NOT THIS CLAIM.
  {
    const otherProvider = "0x" + "ff".repeat(20);
    try {
      await swaps.claimViaRelay({ id: record.id, fetchImpl: async () => ({ ok: true, status: 200,
        json: async () => ({ version: 1, provider: otherProvider, escrow, txid, from: sender, tipWei: claimTip }) }) });
      check(false, "an answer naming another provider passed");
    } catch (error) {
      check(error && error.code === "quote-refused" && error.params && error.params.why === "answer-provider",
        "an answer naming another provider was not refused with quote-refused answer-provider");
    }
  }

  // (5) A NODE REFUSAL KEEPS ITS CODE AND NOT ITS MESSAGE - AND NEVER THE HALF.
  {
    const nodeCode = "claim-tip-too-small";
    try {
      await swaps.claimViaRelay({ id: record.id, fetchImpl: async () => ({ ok: false, status: 409,
        json: async () => ({ version: 1, code: nodeCode, message: "tip " + stored.escrow.half }) }) });
      check(false, "a node refusal passed as a claim");
    } catch (error) {
      check(error && error.code === "quote-refused" && error.params && error.params.code === nodeCode && error.params.status === 409,
        "a node refusal did not keep its code and status under quote-refused");
      const carried = JSON.stringify({ code: error && error.code, params: error && error.params });
      check(!carried.toLowerCase().includes(String(stored.escrow.half).replace(/^0x/, "")),
        "a node refusal copied the half into the refusal");
      check(!carried.includes("tip "), "a node refusal copied the provider's message into the refusal");
    }
  }

  // (6) A LOST ANSWER IS UNKNOWN: no txid, and the code says so.
  for (const [label, transport] of [
    ["a thrown transport", async () => { throw new TypeError("connection reset"); }],
    ["a success body without a txid", async () => ({ ok: true, status: 200, json: async () => ({ version: 1 }) })],
    ["a relay that lost the answer after dispatch", async () => ({ ok: false, status: 503,
      json: async () => ({ version: 1, code: "claim-unknown", message: "the claim may have been sent" }) })],
  ]) {
    try {
      await swaps.claimViaRelay({ id: record.id, fetchImpl: transport });
      check(false, "a lost answer (" + label + ") was reported as a claim");
    } catch (error) {
      check(error && error.code === "claim-unknown" && error.params && error.params.outcome === "unknown",
        "a lost answer (" + label + ") was not refused with claim-unknown outcome unknown: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
    }
  }

  // (7) THE OWN-WALLET PATH IS UNCHANGED: sellClaim still checks the sender and signs the claim itself.
  {
    const signatures = [];
    const clock = { request: async ({ method }) => {
      if (method === "eth_getBlockByNumber") return { timestamp: order.readyBy - 100 };
      throw new Error("unexpected provider method " + method);
    } };
    const wallet = {
      chainId: async () => order.chainId,
      address: async () => order.claimer,
      driver: () => clock,
      send: async (tx) => { signatures.push(tx); return "0x" + "ee".repeat(32); },
      receipt: async () => ({ status: "0x1" }),
    };
    const result = await swaps.sellClaim({ id: record.id }, wallet);
    check(result && result.hash === "0x" + "ee".repeat(32), "sellClaim did not return the signed hash");
    check(signatures.length === 1 && signatures[0].to === escrow,
      "sellClaim did not sign the claim against the escrow");
    check(signatures.length === 1 && signatures[0].data.startsWith("0xbd66528a")
      && signatures[0].data.toLowerCase().endsWith(String(stored.escrow.half).replace(/^0x/, "").toLowerCase()),
      "sellClaim did not present the record's half to claim()");
  }

  notes.push("the record stores the answering relay; a zero tip, a foreign origin and a missing origin are refused before any request");
  notes.push("a node refusal keeps its code, a lost answer is claim-unknown, and sellClaim remains the own-wallet path");
  return { note: "the no-wallet relay claim sends the half once and the own-wallet fallback is unchanged", problems, notes };
};
