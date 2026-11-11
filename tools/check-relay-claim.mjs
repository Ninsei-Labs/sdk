// A SELLER WITH NO WALLET CAN STILL CLAIM THROUGH AN ORDERED LIST OF SENDERS.
//
// The seller holds XMR and no ETH. The client passes the relay's own sender first, then other listed makers; the SDK
// tries them one at a time, reads the escrow during each slot and only reports a claim when the escrow says claimed.
// A refusal moves on at once, a txid is not success, and an exhausted list tells the seller to claim before t1.
import { createRecoveryKey, takerHalvesV2 } from "../src/recovery-key.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { keccak256, secp256k1 } from "../src/primitives.mjs";
import { createSwaps } from "../src/swaps.mjs";
import { createNinsei } from "../src/index.mjs";
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
const dealMaker = order.locker;
const quoteKeyOwner = "0x" + "e4".repeat(20);
const storedSender = "0x" + "c3".repeat(20);
const relaySender = "0x" + "f1".repeat(20);
const secondSender = "0x" + "f2".repeat(20);
const quote = {
  id: "oq_relay_claim",
  provider: dealMaker, factory: order.factory,
  quoteKey: quoteKeyOwner,
  locker: dealMaker, claimer: order.claimer, chainId: order.chainId,
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
const lower = (value) => String(value || "").toLowerCase();
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
};
let clockMs = 1_900_000_000_000;
let chainStatus = { funded: true, claimed: false, refunded: false, balance: 1_000_000_000_000_000_000n };
const resetChain = (overrides = {}) => {
  chainStatus = { funded: true, claimed: false, refunded: false, balance: 1_000_000_000_000_000_000n, ...overrides };
};
const read = async ({ data }) => {
  if (data === encodeStatus()) {
    return "0x" + word(chainStatus.funded ? 1 : 0) + word(chainStatus.claimed ? 1 : 0)
      + word(chainStatus.refunded ? 1 : 0) + word(chainStatus.balance);
  }
  const answer = slotReads[data];
  if (!answer) throw new Error("unexpected chain read " + data);
  return "0x" + answer;
};
const sharedStorage = memoryStorage();
const store = createStore(sharedStorage);
const swaps = createSwaps({ config: {}, call: read, store, now: () => clockMs,
  sleep: async (ms) => { clockMs += ms; } });
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
    jointAddress: offer.jointAddress.slice(0, -2) + String(sequence % 10) + String(sequence % 10),
  };
  if (overrides.withoutRelay) { delete made.withoutRelay; delete made.relayUrl; }
  const sender = Object.prototype.hasOwnProperty.call(overrides, "claimSender") ? overrides.claimSender : storedSender;
  const request = { offer: made, recoveryKey: mnemonic, onRecoveryKey: accept };
  if (sender && !overrides.omitClaimSender) request.claimSender = sender;
  return await swaps.startSell(request);
};

const answer = (sender, txid, at = escrow) => ({ ok: true, status: 200, json: async () => ({
  version: 1, provider: sender, escrow: at, txid, from: sender, tipWei: claimTip,
}) });
const refusal = (code) => ({ ok: false, status: 409, json: async () => ({ version: 1, code }) });

export const relayClaimCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  const record = await seed({ escrow });
  const stored = engine.swap.getSwap(record.id, store);
  check(stored && stored.relayUrl === "https://relay.example", "startSell did not store the relay origin");
  check(stored && stored.claimSender === storedSender, "startSell did not store the legacy sender");
  check(stored && stored.claimTip === claimTip && stored.escrow && stored.escrow.half,
    "the sale record does not carry the positive tip and the half");

  // (0a) THE DEAL'S MAKER AND THE QUOTE-KEY OWNER ARE REFUSED BEFORE ANY REQUEST.
  for (const [label, sender, why] of [["deal maker", dealMaker, "is-deal-maker"],
    ["quote key owner", quoteKeyOwner, "is-quote-key"]]) {
    resetChain();
    let called = 0;
    try {
      await swaps.claimViaRelay({ id: record.id, claimSenders: [sender],
        fetchImpl: async () => { called += 1; throw new Error("must not be called"); } });
      check(false, "the " + label + " was accepted as a sender");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "claimSenders"
        && error.params.why === why, "the " + label + " was not refused by name");
    }
    check(called === 0, "the " + label + " reached the relay");
  }

  // (0b) THE LIST IS REQUIRED; A MISSING LIST IS NOT A GUESS.
  {
    const noSender = await seed({ omitClaimSender: true });
    try {
      await swaps.claimViaRelay({ id: noSender.id, fetchImpl: async () => { throw new Error("must not be called"); } });
      check(false, "a record without senders was claimed");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "claimSenders"
        && error.params.why === "not-in-record", "a missing sender list was not refused by name");
    }
    try {
      await swaps.claimViaRelay({ id: noSender.id, claimSenders: [], fetchImpl: async () => { throw new Error("must not be called"); } });
      check(false, "an empty sender list was claimed");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "claimSenders"
        && error.params.why === "empty", "an empty sender list was not refused by name");
    }
  }

  // (0c) A RESUMED OFFER MAY NAME ANOTHER SENDER. THE RECORD'S OLD SCALAR IS NOT A PIN; THE CLIENT'S LIST AT CLAIM
  // TIME IS THE AUTHORITY.
  {
    const resumed = await swaps.startSell({ offer: { ...offer, escrow, jointAddress: stored.escrow.moneroAddress,
      quote: { ...stored.quote }, orderQuote: stored.orderQuote },
      recoveryKey: mnemonic, onRecoveryKey: accept, claimSender: secondSender });
    const after = engine.swap.getSwap(record.id, store);
    check(resumed && resumed.resumed === true && after && after.claimSender === secondSender,
      "a resumed sell still pinned the earlier sender");
  }

  // (1) THE FIRST SENDER IS THE RELAY'S OWN; THE ESCROW SAYS CLAIMED.
  {
    resetChain();
    const calls = [];
    const transport = async (url, init) => {
      calls.push({ url, init });
      chainStatus.claimed = true;
      return answer(relaySender, "0x" + "ab".repeat(32));
    };
    const claimed = await swaps.claimViaRelay({ id: record.id,
      claimSenders: [relaySender, secondSender], fetchImpl: transport });
    check(claimed && claimed.state === "claimed" && claimed.provider === lower(relaySender)
      && claimed.claimSender === lower(relaySender) && claimed.txid === "0x" + "ab".repeat(32),
      "the first sender did not claim: " + JSON.stringify(claimed));
    check(calls.length === 1 && calls[0].url === "https://relay.example/v1/claims/" + lower(relaySender) + "/" + escrow,
      "the first sender path is not the ordered first entry: " + JSON.stringify(calls.map((entry) => entry.url)));
    if (calls.length === 1) {
      const body = JSON.parse(calls[0].init && calls[0].init.body || "{}");
      check(calls[0].init && calls[0].init.method === "POST", "the claim was not a POST");
      check(body.version === 1 && body.halfClaimer === stored.escrow.half && Object.keys(body).length === 2,
        "the claim body is not exactly {version:1, halfClaimer}");
      check(!JSON.stringify(claimed).toLowerCase().includes(String(stored.escrow.half).replace(/^0x/, "")),
        "the result echoed the half");
    }
  }

  // (2) A REFUSAL MOVES TO THE NEXT SENDER AT ONCE.
  {
    resetChain();
    const calls = [];
    const transport = async (url) => {
      calls.push(url);
      if (url.includes(lower(relaySender))) return refusal("claim-tip-too-small");
      chainStatus.claimed = true;
      return answer(secondSender, "0x" + "bc".repeat(32));
    };
    const claimed = await swaps.claimViaRelay({ id: record.id,
      claimSenders: [relaySender, secondSender], fetchImpl: transport });
    check(claimed && claimed.state === "claimed" && claimed.provider === lower(secondSender),
      "a refused first sender did not move to the second: " + JSON.stringify(claimed));
    check(calls.length === 2 && calls[0].includes(lower(relaySender)) && calls[1].includes(lower(secondSender)),
      "the sender order was not tried in order: " + JSON.stringify(calls));
    check(claimed && claimed.tried && claimed.tried[0] && claimed.tried[0].outcome === "refused"
      && claimed.tried[0].code === "quote-refused" && claimed.tried[0].params
      && claimed.tried[0].params.code === "claim-tip-too-small" && claimed.tried[0].params.status === 409,
      "the refusal was not recorded with its code and status");
  }

  // (3) A TXID IS NOT SUCCESS: THE ESCROW MUST READ CLAIMED.
  {
    resetChain();
    let calls = 0;
    const transport = async () => {
      calls += 1;
      if (calls === 1) return answer(relaySender, "0x" + "cd".repeat(32));
      chainStatus.claimed = true;
      return answer(secondSender, "0x" + "de".repeat(32));
    };
    const claimed = await swaps.claimViaRelay({ id: record.id,
      claimSenders: [relaySender, secondSender], fetchImpl: transport, slotMs: 15_000, pollMs: 2_000 });
    check(claimed && claimed.state === "claimed" && claimed.provider === lower(secondSender) && calls === 2,
      "an unconfirmed txid from the first sender was treated as done: " + JSON.stringify({ claimed, calls }));
    check(claimed && claimed.tried && claimed.tried[0].outcome === "unconfirmed",
      "the unconfirmed first slot was not recorded");
  }

  // (4) AN UNKNOWN ANSWER GETS ITS SLOT, THEN THE NEXT SENDER.
  {
    resetChain();
    let calls = 0;
    const transport = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("lost answer"), { code: "claim-unknown" });
      chainStatus.claimed = true;
      return answer(secondSender, "0x" + "ef".repeat(32));
    };
    const claimed = await swaps.claimViaRelay({ id: record.id,
      claimSenders: [relaySender, secondSender], fetchImpl: transport, slotMs: 15_000, pollMs: 2_000 });
    check(claimed && claimed.state === "claimed" && claimed.provider === lower(secondSender) && calls === 2,
      "an unknown first answer did not move after its slot: " + JSON.stringify({ claimed, calls }));
    check(claimed && claimed.tried && claimed.tried[0].outcome === "unknown",
      "the unknown first slot was not recorded");
  }

  // (5) WHEN THE LIST RUNS OUT, NAME THE TIME LEFT BEFORE t1.
  {
    resetChain();
    let calls = 0;
    const transport = async () => { calls += 1; return refusal("claim-tip-too-small"); };
    const result = await swaps.claimViaRelay({ id: record.id,
      claimSenders: [relaySender, secondSender], fetchImpl: transport });
    check(result && result.state === "claim-yourself" && result.reason === "senders-exhausted"
      && result.txid === null && result.provider === null && calls === 2,
      "an exhausted list did not return claim-yourself: " + JSON.stringify({ result, calls }));
    check(result && Number.isSafeInteger(result.secondsLeft) && result.secondsLeft > 0,
      "the exhausted result does not carry the time left before t1");
    check(result && result.tried.length === 2 && result.tried.every((entry) => entry.outcome === "refused"),
      "the exhausted result does not name both attempts");
  }

  // (5a) AN ESCROW THAT IS ALREADY CLAIMED IS NOT A REASON TO SEND THE HALF OR TO SAY CLAIM-YOURSELF.
  {
    resetChain({ claimed: true });
    let calls = 0;
    const result = await swaps.claimViaRelay({ id: record.id, claimSenders: [relaySender],
      fetchImpl: async () => { calls += 1; return answer(relaySender, "0x" + "a1".repeat(32)); } });
    check(result && result.state === "claimed" && result.provider === null && result.txid === null && calls === 0,
      "an already claimed escrow was sent again or reported as claim-yourself: " + JSON.stringify({ result, calls }));
  }

  // (5b) A CLAIM LANDING WHILE THE NEXT SENDER REFUSES IS STILL CLAIMED, NOT CLAIM-YOURSELF.
  {
    resetChain();
    let calls = 0;
    const transport = async () => {
      calls += 1;
      if (calls === 1) return answer(relaySender, "0x" + "a2".repeat(32));
      chainStatus.claimed = true;
      return refusal("claim-tip-too-small");
    };
    const result = await swaps.claimViaRelay({ id: record.id,
      claimSenders: [relaySender, secondSender], fetchImpl: transport, slotMs: 15_000, pollMs: 2_000 });
    check(result && result.state === "claimed" && result.provider === null && calls === 2,
      "a late claim was reported as claim-yourself: " + JSON.stringify({ result, calls }));
  }

  // (5c) A REFUNDED ESCROW IS NAMED, NOT SENT TO SELLCLAIM AS IF IT WERE STILL OPEN.
  {
    resetChain({ refunded: true });
    let calls = 0;
    const result = await swaps.claimViaRelay({ id: record.id, claimSenders: [relaySender],
      fetchImpl: async () => { calls += 1; return refusal("claim-tip-too-small"); } });
    check(result && result.state === "claim-yourself" && result.reason === "escrow-refunded" && calls === 0,
      "a refunded escrow was not named: " + JSON.stringify({ result, calls }));
  }

  // (5d) EVERY LOST-ANSWER SHAPE ENDS IN CLAIM-YOURSELF AFTER THE SENDER'S SLOT.
  for (const [label, transport] of [
    ["a thrown transport", async () => { throw new TypeError("connection reset"); }],
    ["a success body without a txid", async () => ({ ok: true, status: 200, json: async () => ({ version: 1 }) })],
    ["a 503 claim-unknown", async () => ({ ok: false, status: 503, json: async () => ({ version: 1, code: "claim-unknown" }) })],
  ]) {
    resetChain();
    const result = await swaps.claimViaRelay({ id: record.id, claimSenders: [relaySender], fetchImpl: transport,
      slotMs: 15_000, pollMs: 2_000 });
    check(result && result.state === "claim-yourself" && result.tried[0] && result.tried[0].outcome === "unknown",
      "a lost answer (" + label + ") was not kept in its slot: " + JSON.stringify({ result }));
  }

  // (5e) THE LIST SHAPE AND THE LEGACY FALLBACKS ARE NAMED.
  {
    let called = 0;
    try {
      await swaps.claimViaRelay({ id: record.id, claimSenders: "not-an-array",
        fetchImpl: async () => { called += 1; throw new Error("must not be called"); } });
      check(false, "a non-array sender list was accepted");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "claimSenders"
        && error.params.why === "not-an-array", "a non-array sender list was not refused");
    }
    check(called === 0, "a non-array sender list reached the relay");
    try {
      await swaps.claimViaRelay({ id: record.id, claimSenders: [relaySender], claimSender: secondSender,
        fetchImpl: async () => { called += 1; throw new Error("must not be called"); } });
      check(false, "a list and a scalar sender were accepted together");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.why === "with-claim-sender",
        "a list and a scalar sender were not refused");
    }

    resetChain();
    const deduped = [];
    const shared = async (url) => { deduped.push(url); chainStatus.claimed = true; return answer(relaySender, "0x" + "a3".repeat(32)); };
    const result = await swaps.claimViaRelay({ id: record.id, claimSenders: [relaySender, relaySender], fetchImpl: shared });
    check(result && result.state === "claimed" && deduped.length === 1,
      "a duplicated sender was tried twice");

    resetChain();
    const legacy = await seed({ omitClaimSender: true });
    resetChain();
    check(chainStatus.claimed === false, "fixture reset left claimed=true");
    const legacyFetch = async () => { chainStatus.claimed = true; return answer(storedSender, "0x" + "a4".repeat(32), legacy.escrow); };
    resetChain();
    const legacyResult = await swaps.claimViaRelay({ id: legacy.id, claimSender: storedSender, fetchImpl: legacyFetch });
    check(legacyResult && legacyResult.state === "claimed" && legacyResult.provider === lower(storedSender),
      "the legacy scalar sender was not accepted as a fallback: " + JSON.stringify({ legacyResult, claimed: chainStatus.claimed }));

    resetChain();
    const storedResult = await swaps.claimViaRelay({ id: record.id,
      fetchImpl: async () => { chainStatus.claimed = true; return answer(relaySender, "0x" + "a5".repeat(32)); } });
    check(storedResult && storedResult.state === "claimed" && storedResult.provider === lower(relaySender),
      "the stored sender list was not used as a fallback: " + JSON.stringify(storedResult));
  }

  // (5f) A RECORD WITHOUT THE RELAY ORIGIN IS STILL REFUSED BEFORE THE SENDER LOOP.
  {
    resetChain();
    const noRelay = await seed({ withoutRelay: true });
    let called = 0;
    try {
      await swaps.claimViaRelay({ id: noRelay.id, claimSenders: [relaySender],
        fetchImpl: async () => { called += 1; throw new Error("must not be called"); } });
      check(false, "a record without a relay origin was claimed");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "relayUrl"
        && error.params.why === "not-in-record", "a missing relay origin was not refused by name");
    }
    check(called === 0, "a record without a relay origin reached the network");
  }

  // (6) A SOLO TIP IS STILL REFUSED, AND A FOREIGN ORIGIN IS REFUSED BEFORE ANY SENDER.
  {
    const zero = await seed({ quote: { claimTip: "0" } });
    try {
      await swaps.claimViaRelay({ id: zero.id, fetchImpl: async () => { throw new Error("must not be called"); } });
      check(false, "a zero tip was claimed");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "claimTip"
        && error.params.why === "not-positive", "a zero tip was not refused by name");
    }
  }
  {
    resetChain();
    let called = 0;
    try {
      await swaps.claimViaRelay({ id: record.id, claimSenders: [relaySender], relayUrl: "https://other.example",
        fetchImpl: async () => { called += 1; return answer(relaySender, "0x" + "aa".repeat(32)); } });
      check(false, "a foreign relay origin was accepted");
    } catch (error) {
      check(error && error.code === "bad-input" && error.params && error.params.field === "relayUrl"
        && error.params.why === "foreign-relay", "a foreign relay origin was not refused by name");
    }
    check(called === 0, "a foreign relay origin reached the network");
  }

  // (7) THE INSTANCE FETCH IS STILL THE DEFAULT.
  {
    resetChain();
    const calls = [];
    const defaultFetch = async (url) => { calls.push(url); chainStatus.claimed = true; return answer(relaySender, "0x" + "fa".repeat(32)); };
    try {
      const client = createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet",
        storage: sharedStorage, fetch: defaultFetch, evmCall: read });
      const result = await client.swaps.claimViaRelay({ id: record.id, claimSenders: [relaySender] });
      check(result && result.state === "claimed" && calls.length === 1,
        "the instance fetch was not used by the ordered claim");
    } catch (error) {
      problems.push("the instance fetch claim refused: " + JSON.stringify({ code: error && error.code, params: error && error.params }));
    }
  }

  // (8) THE OWN-WALLET PATH IS UNCHANGED.
  {
    resetChain();
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

  notes.push("the client list is tried in order; a refusal moves on, a txid waits for the escrow, and exhaustion asks for the seller's own claim");
  notes.push("the relay origin and the instance fetch rules are unchanged; sellClaim remains the own-wallet path");
  return { note: "the ordered relay claim reads the escrow and names the sender that landed it", problems, notes };
};
