// THE RECOVERY KEY CHECK: fixed v2 vectors, the backup file, and the salt-based on-chain search.
import * as recovery from "../src/public/recovery.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { ESCROW_EVENT_TOPICS, readEscrowEvents, readEscrowEventsByTopic } from "../src/recovery-key.mjs";
import { startHeightFromNodes } from "../src/swaps.mjs";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CHAIN = 421614;
const TOPIC = "0xa22cdabaed3cce4f51dde71626a108ffe9c7bc4216fd14d5e719f892e2fd8ab0";
const MODERN_TOPIC = "0x09add13cca47b227c377447295bfaa00ef3169bfed0f5513d06f8be04af78aad";
const pad = (value) => "0x" + String(value).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const address = (byte) => "0x" + byte.repeat(20);
const memory = () => { const map = new Map(); return { get: (k) => (map.has(k) ? map.get(k) : null), set: (k, v) => map.set(k, v), remove: (k) => map.delete(k) }; };
const logFor = ({ commitment, locker, claimer, salt, index = 0 }) => ({
  topics: [TOPIC, pad(address("aa")), pad(locker), pad(claimer)],
  data: "0x" + [commitment, "0x" + "00".repeat(32), "0x" + "11".repeat(32), "0x" + "22".repeat(32), "0x" + "33".repeat(32),
    "0x1", "0x2", "0x3", salt, pad(address("55")), pad(address("66")), pad(address("77"))]
    .map((word) => word.replace(/^0x/, "").padStart(64, "0")).join(""),
  transactionHash: "0x" + String(index + 1).padStart(64, "0"), logIndex: index, blockNumber: 100 + index,
});
const modernLogFor = ({ commitment, locker, claimer, salt, index = 0, xmrAmount = "5000000000000" }) => {
  const legacy = logFor({ commitment, locker, claimer, salt, index });
  const words = [];
  const data = legacy.data.slice(2);
  for (let i = 0; i < data.length; i += 64) words.push(data.slice(i, i + 64));
  words.splice(6, 0, BigInt(xmrAmount).toString(16).padStart(64, "0"));
  return { ...legacy, topics: [MODERN_TOPIC, ...legacy.topics.slice(1)], data: "0x" + words.join("") };
};

export const recoveryKeyCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const imported = recovery.importRecoveryKey(WORDS, { createdAt: "2026-10-21" });
  check(imported.mnemonic === WORDS && imported.fingerprint === "3ae0", "importRecoveryKey changed");
  const salt = "0x" + "ab".repeat(32);
  const factory = address("dd");
  const halves = recovery.takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory, salt });
  check(recovery.recoveryBindingV2({ chainId: CHAIN, factory, salt }) === `ninsei-taker-v2|421614|${factory}|taker|${salt}`, "the v2 binding changed");
  check(halves.spendHalf === "0x007c77c781458811e2c9aabd59361f2360112c70cb8b20168cf468a5037b9ac6", "the v2 spend half changed");
  check(halves.spendCommitment === "0xedea6e219238e63caa05acc46a3a144c4d4d34e889b7f4e9c58f23fce6ee1601", "the v2 commitment changed");
  check(halves.derivation === "salt-v2" && !("index" in halves), "the v2 result still carries an index");
  check(recovery.takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory: address("ee"), salt }).spendCommitment !== halves.spendCommitment, "another factory produced the same half");
  check(recovery.newRecoverySalt() !== recovery.newRecoverySalt(), "fresh salts repeat");

  const orderTerms = { chainId: 421614, factory: "0x" + "11".repeat(20), locker: "0x" + "22".repeat(20), claimer: "0x" + "33".repeat(20),
    amount: "1000", readyBy: 2000000000, t1: 2000003600, salt };
  const known = buildOwnSideFromHalves(orderTerms, { spendHalf: halves.spendHalf, viewHalf: halves.viewHalf });
  const bare = (value) => String(value).replace(/^0x/i, "").toLowerCase();
  check(bare(known.spendPoint) === bare(halves.spendPoint) && bare(known.viewPoint) === bare(halves.viewPoint), "the side lost the supplied halves");

  const generated = recovery.createRecoveryKey({ createdAt: "2026-10-21" });
  check(generated.mnemonic.split(" ").length === 12, "createRecoveryKey did not make twelve words");
  let refused = false;
  try { recovery.importRecoveryKey("abandon abandon abandon"); } catch (error) { refused = error && error.code === "bad-input"; }
  check(refused, "a short mnemonic was not refused");
  const plain = await recovery.createRecoveryKeyFile({ mnemonic: WORDS, createdAt: "2026-10-21", passphrase: "" });
  check(plain.startsWith("NINSEI RECOVERY KEY\n"), "the plain backup lost its magic line");
  const plainOpened = await recovery.openRecoveryKeyFile(plain, "");
  check(plainOpened.mnemonic === WORDS, "the plain backup did not round-trip");
  check(plainOpened.createdAt === "2026-10-21T00:00:00.000Z", "the plain backup lost its header date");
  const encrypted = await recovery.createRecoveryKeyFile({ mnemonic: WORDS, createdAt: "2026-10-21T09:30:00.000Z", passphrase: "correct horse battery" });
  check(JSON.parse(encrypted).kind === "ninsei-recovery-key", "the encrypted backup has no readable kind header");
  const encryptedOpened = await recovery.openRecoveryKeyFile(encrypted, "correct horse battery");
  check(encryptedOpened.mnemonic === WORDS, "the encrypted backup did not round-trip");
  check(encryptedOpened.createdAt === "2026-10-21T09:30:00.000Z", "the encrypted backup lost its sealed creation time");
  {
    const poisoned = JSON.parse(encrypted);
    poisoned.iter = { toString: null };
    try {
      await recovery.openRecoveryKeyFile(JSON.stringify(poisoned), "correct horse battery");
      check(false, "a non-primitive iter was accepted");
    } catch (error) {
      check(error && error.code === "recovery-failed" && error.params && error.params.stage === "parse",
        "a non-primitive iter is a named parse refusal");
    }
  }
  const storage = memory();
  recovery.saveRecoveryKey(storage, generated);
  check(recovery.loadRecoveryKey(storage)?.mnemonic === generated.mnemonic, "the key did not round-trip through the store");

  const v2Log = logFor({ commitment: halves.spendCommitment, locker: address("bb"), claimer: address("cc"), salt });
  const calls = [];
  const found = await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory, address: address("bb"),
    evmLogs: async (request) => { calls.push(request); return request.topics.includes(pad(address("bb"))) ? [v2Log] : []; } });
  check(found.swaps.length === 1 && found.swaps[0].side === "locker", `the search found ${found.swaps.length} orders`);
  check(found.swaps[0].derivation === "salt-v2" && found.swaps[0].factory === factory && found.swaps[0].salt === salt, "the v2 order lost its derivation fields");
  check(!("index" in found.swaps[0]), "the v2 order still carries an index");
  check(found.complete === true && !("nextIndex" in found) && !("scanned" in found) && !("searchedUpTo" in found), "the result still names an index bound");
  check(calls.length === 2 && calls.every((call) => !JSON.stringify(call).includes(halves.spendHalf)), "the address query leaked a half or made the wrong number of calls");
  check(found.swaps[0].xmrAmount === null && found.swaps[0].xmrAmountReason === "no-code-reader", "a search without a code reader invented an amount");

  const foreign = logFor({ commitment: "0x" + "99".repeat(32), locker: address("bb"), claimer: address("cc"), salt: "0x" + "44".repeat(32), index: 1 });
  const allCalls = [];
  const all = await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory,
    evmLogs: async (request) => { allCalls.push(request); return [v2Log, foreign]; } });
  check(all.swaps.length === 1 && allCalls.length === 1 && all.complete === true, "a full log read did not return exactly the v2 order");

  {
    const broken = { ...v2Log, data: "0xzz", topics: [TOPIC, v2Log.topics[1], v2Log.topics[2], v2Log.topics[3]] };
    const poisonedTx = { ...v2Log, transactionHash: { toString: null } };
    const mixed = await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory,
      evmLogs: async () => [broken, poisonedTx, v2Log] });
    check(mixed.swaps.length === 1 && mixed.swaps[0].side === "locker", "one malformed log hid the key's own order");
  }

  // A CHAIN CAN HAVE MORE THAN ONE FACTORY. Searching only the newest hides every older order; the result keeps
  // each order's own factory and the commitments are derived with that factory, not with the last one in the list.
  {
    const otherFactory = address("ef");
    const otherHalves = recovery.takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory: otherFactory, salt });
    const otherLog = logFor({ commitment: otherHalves.spendCommitment, locker: address("bb"), claimer: address("cc"), salt });
    const seen = [];
    const multi = await recovery.findSwaps({
      mnemonic: WORDS, chainId: CHAIN,
      factories: [{ address: factory, deploymentBlock: 10 }, { address: otherFactory, deploymentBlock: 20 }],
      evmLogs: async (request) => {
        seen.push({ address: request.address, fromBlock: request.fromBlock });
        return request.address === otherFactory ? [otherLog] : [v2Log];
      },
    });
    check(multi.swaps.length === 2 && multi.swaps.some((row) => row.factory === factory)
      && multi.swaps.some((row) => row.factory === otherFactory), `multi-factory search returned ${multi.swaps.length}`);
    check(seen.length === 2 && seen[0].fromBlock === 10 && seen[1].fromBlock === 20, "each factory was not searched from its own deployment block");
  }

  const xmrWord = BigInt(5_000_000_000_000).toString(16).padStart(64, "0");
  const cloneCode = "0x" + "00".repeat(621) + xmrWord + "00".repeat(877 - 621 - 32);
  const withXmr = await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory, address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [v2Log] : [], evmCode: async () => cloneCode });
  check(withXmr.swaps[0].xmrAmount === "5000000000000" && withXmr.swaps[0].xmrAmountReason === null, "the clone amount was not read");
  const modern = await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory, address: address("bb"),
    evmLogs: async () => [modernLogFor({ commitment: halves.spendCommitment, locker: address("bb"), claimer: address("cc"), salt, xmrAmount: "7000000000000" })] });
  check(modern.swaps[0].xmrAmount === "7000000000000" && modern.swaps[0].xmrAmountReason === "event", "the event amount was not read");

  const deploymentCalls = [];
  await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory,
    evmLogs: async (request) => { deploymentCalls.push(request.fromBlock); return [v2Log]; }, deploymentBlock: 321430239 });
  check(deploymentCalls[0] === 321430239, `the deployment block became ${deploymentCalls[0]}`);
  const explicitCalls = [];
  await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory,
    evmLogs: async (request) => { explicitCalls.push(request.fromBlock); return [v2Log]; }, fromBlock: 7, deploymentBlock: 321430239 });
  check(explicitCalls[0] === 7, `an explicit fromBlock became ${explicitCalls[0]}`);

  const withHeight = await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory, address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [v2Log] : [],
    evmBlockTime: async () => 1_000_000, moneroTip: async () => 2_000, moneroBlockTimestamp: async (height) => 500 + height * 1_000 });
  check(withHeight.swaps[0].startHeight === 939 && withHeight.swaps[0].startHeightReason === null, `the start height is ${withHeight.swaps[0].startHeight}`);
  check(withHeight.swaps[0].blockTime === 1_000_000, "the block time was lost");

  const second = recovery.takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory, salt: "0x" + "cd".repeat(32) });
  const secondLog = logFor({ commitment: second.spendCommitment, locker: address("bb"), claimer: address("cc"), salt: "0x" + "cd".repeat(32), index: 1 });
  const mixed = await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory, address: address("bb"),
    evmLogs: async () => [v2Log, secondLog], evmBlockTime: async (block) => { if (block === 101) throw new Error("rpc down"); return 1_000_000; } });
  const failed = mixed.swaps.find((row) => row.blockNumber === 101);
  const kept = mixed.swaps.find((row) => row.blockNumber === 100);
  check(mixed.swaps.length === 2, `a failed block-time read dropped matched orders: ${mixed.swaps.length}`);
  check(failed && failed.startHeightReason === "block-time-read" && kept && kept.blockTime === 1_000_000, "a failed block-time read was not kept and named");

  // The bulk seam sees only unique matched blocks; duplicates and failures never cause singular RPC reads.
  const sameBlockLog = { ...secondLog, blockNumber: 100 };
  const nextBlockLog = { ...secondLog, transactionHash: "0x" + "03".padStart(64, "0"), logIndex: 2 };
  const bulkLogs = [v2Log, sameBlockLog, nextBlockLog];
  const bulkCalls = [];
  let singularCalls = 0;
  const bulkRequest = { mnemonic: WORDS, chainId: CHAIN, factory, evmLogs: async () => bulkLogs,
    evmBlockTime: async () => { singularCalls += 1; return 42; } };
  const batched = await recovery.findSwaps({ ...bulkRequest,
    evmBlockTimes: async (blocks) => { bulkCalls.push([...blocks]); return new Map([[100, 1_000_000], [101, 1_001_000]]); },
    moneroTip: async () => 2_000, moneroBlockTimestamp: async (height) => 500 + height * 1_000 });
  check(bulkCalls.length === 1 && JSON.stringify(bulkCalls[0]) === "[100,101]" && singularCalls === 0,
    "bulk timestamps did not use one unique-block read with no singular fallback");
  check(batched.swaps.length === 3 && batched.swaps.every((row) => row.startHeightReason === null &&
    row.blockTime === (row.blockNumber === 100 ? 1_000_000 : 1_001_000) && row.startHeight === (row.blockNumber === 100 ? 939 : 940)),
    "bulk timestamps changed start heights, timestamps or matched orders");
  const itemFailure = await recovery.findSwaps({ ...bulkRequest,
    evmBlockTimes: async () => new Map([[100, 1_000_000], [101, new Error("rpc down")]]) });
  check(itemFailure.swaps.length === 3 && itemFailure.swaps.filter((row) => row.blockNumber === 100).every((row) => row.blockTime === 1_000_000) &&
    itemFailure.swaps.find((row) => row.blockNumber === 101)?.startHeightReason === "block-time-read",
    "one failed bulk item dropped orders or lost the named read failure");
  for (const value of [null, undefined]) {
    const missingTime = await recovery.findSwaps({ ...bulkRequest,
      evmBlockTimes: async () => new Map([[100, 1_000_000], ...(value === null ? [[101, null]] : [])]) });
    check(missingTime.swaps.length === 3 && missingTime.swaps.find((row) => row.blockNumber === 101)?.startHeightReason === "no-block-time",
      "a missing/null bulk timestamp dropped an order or lost no-block-time");
  }
  const batchFailure = await recovery.findSwaps({ ...bulkRequest,
    evmBlockTimes: async () => { throw new Error("batch down"); } });
  check(batchFailure.swaps.length === 3 && batchFailure.swaps.every((row) => row.blockTime === null && row.startHeightReason === "block-time-read"),
    "a whole batch failure dropped orders or lost block-time-read");
  check(singularCalls === 0, "a failed/missing bulk timestamp fell back to a singular read");
  const genesisTime = await recovery.findSwaps({ ...bulkRequest,
    evmBlockTimes: async () => new Map([[100, 0], [101, Number.NaN]]) });
  check(genesisTime.swaps.filter((row) => row.blockNumber === 100).every((row) => row.blockTime === 0) &&
    genesisTime.swaps.find((row) => row.blockNumber === 101)?.startHeightReason === "no-block-time",
    "zero or invalid bulk timestamps changed timestamp normalization");
  const malformedBatch = await recovery.findSwaps({ ...bulkRequest, evmBlockTimes: async () => ({}) });
  check(malformedBatch.swaps.length === 3 && malformedBatch.swaps.every((row) => row.startHeightReason === "block-time-read") && singularCalls === 0,
    "a malformed batch response dropped orders or used singular fallback");
  let emptyBatchCalls = 0;
  const unmatched = { ...v2Log, data: "0x" + "00".repeat(192) };
  const emptyBatch = await recovery.findSwaps({ ...bulkRequest, evmLogs: async () => [unmatched],
    evmBlockTimes: async () => { emptyBatchCalls += 1; return new Map(); } });
  check(emptyBatch.swaps.length === 0 && emptyBatchCalls === 0 && singularCalls === 0,
    "no matched orders still triggered a timestamp read");
  let fallbackCalls = 0;
  const fallback = await recovery.findSwaps({ ...bulkRequest,
    evmBlockTime: async () => { fallbackCalls += 1; return 1_000_000; } });
  check(fallback.swaps.length === 3 && fallbackCalls === 2 && fallback.swaps.every((row) => row.blockTime === 1_000_000),
    "omitting the bulk seam changed the singular reader/cache behavior");
  {
    // A LOG WITHOUT A BLOCK NUMBER IS NOT BLOCK ZERO. It keeps its row with a named reason and makes no batch call.
    const withoutBlock = { ...v2Log };
    delete withoutBlock.blockNumber;
    let batchRead = false;
    const missingBlock = await recovery.findSwaps({ mnemonic: WORDS, chainId: CHAIN, factory,
      evmLogs: async () => [withoutBlock],
      evmBlockTimes: async () => { batchRead = true; return new Map(); } });
    check(missingBlock.swaps.length === 1 && missingBlock.swaps[0].startHeightReason === "no-block-number" && batchRead === false,
      `a log without a block number invented block zero or made a batch call: ${missingBlock.swaps.length} order(s), reason ${missingBlock.swaps[0] && missingBlock.swaps[0].startHeightReason}, batch ${batchRead}`);
  }

  const answer = (result) => async () => ({ ok: true, json: async () => ({ result }) });
  check(await startHeightFromNodes({ nodes: ["https://node.example"], network: "stagenet",
    fetchImpl: answer({ height: 2234563, nettype: "stagenet", synchronized: true }) }) === 2234563, "the node height was not read");
  const twoNodes = (first, second) => async (url) => ({
    ok: true, json: async () => ({ result: { height: url.includes("one") ? first : second, nettype: "stagenet", synchronized: true } }),
  });
  check(await startHeightFromNodes({ nodes: ["https://one.example", "https://two.example"], network: "stagenet",
    fetchImpl: twoNodes(1200, 1150) }) === 1150, "the scan started at a newer witness instead of the oldest");
  let disagree = null;
  try {
    await startHeightFromNodes({ nodes: ["https://one.example", "https://two.example"], network: "stagenet",
      fetchImpl: twoNodes(1200, 1000) });
  } catch (error) { disagree = error; }
  check(disagree && disagree.code === "xmr-no-nodes" && disagree.params?.why === "disagree",
    "two witnesses far apart were not refused as a disagreement");
  let wrongNetwork = null;
  try { await startHeightFromNodes({ nodes: ["https://node.example"], network: "mainnet", fetchImpl: answer({ height: 1, nettype: "stagenet", synchronized: true }) }); }
  catch (error) { wrongNetwork = error; }
  check(wrongNetwork && wrongNetwork.code === "xmr-no-nodes" && wrongNetwork.params?.why === "network", "a wrong-network node was accepted");
  // BULK SETTLEMENT EVENTS. One request with an address list returns the half, the ready mark and a decline
  // without asking the RPC about each escrow separately.
  {
    const escrow = "0x" + "ab".repeat(20);
    const half = "0x" + "cd".repeat(32);
    const words = (values) => "0x" + values.map((value) => BigInt(value).toString(16).padStart(64, "0")).join("");
    const logs = [
      { address: escrow, topics: [ESCROW_EVENT_TOPICS.halfRevealed], data: words([BigInt(half), 1]), blockNumber: 5, transactionHash: "0x" + "01".repeat(32), logIndex: 0 },
      { address: escrow, topics: [ESCROW_EVENT_TOPICS.ready, "0x" + "0".repeat(24) + "11".repeat(20)], data: "0x", blockNumber: 6, transactionHash: "0x" + "02".repeat(32), logIndex: 0 },
      { address: escrow, topics: [ESCROW_EVENT_TOPICS.declined, "0x" + "0".repeat(24) + "22".repeat(20)], data: "0x", blockNumber: 7, transactionHash: "0x" + "03".repeat(32), logIndex: 0 },
    ];
    let request = null;
    const events = await readEscrowEvents({ escrows: [escrow], evmLogs: async (value) => { request = value; return logs; } });
    check(events.length === 3 && events[0].event === "HalfRevealed" && events[0].half === half && events[0].byClaimer === true,
      "bulk events did not decode the revealed half");
    check(events[1].event === "Ready" && events[2].event === "Declined", "bulk events lost the ready or declined event");
    check(request && Array.isArray(request.address) && request.address[0] === escrow, "bulk events did not send the escrow list");
  }
  // THE SAME EVENTS WITHOUT NAMING ANY ESCROW. The privacy path asks for the three topics and the range; the
  // decoder takes each escrow from log.address. Two escrows prove the local filter has something to filter.
  {
    const first = "0x" + "ac".repeat(20);
    const second = "0x" + "bd".repeat(20);
    const half = "0x" + "ce".repeat(32);
    const words = (values) => "0x" + values.map((value) => BigInt(value).toString(16).padStart(64, "0")).join("");
    const logs = [
      { address: first, topics: [ESCROW_EVENT_TOPICS.halfRevealed], data: words([BigInt(half), 1]), blockNumber: 2, transactionHash: "0x" + "04".repeat(32), logIndex: 0 },
      { address: second, topics: [ESCROW_EVENT_TOPICS.ready, "0x" + "0".repeat(24) + "33".repeat(20)], data: "0x", blockNumber: 1, transactionHash: "0x" + "05".repeat(32), logIndex: 0 },
    ];
    let request = null;
    const events = await readEscrowEventsByTopic({ evmLogs: async (value) => { request = value; return logs; } });
    check(request && !("address" in request), "the topic-only read sent an address filter");
    check(events.length === 2 && events[0].escrow === second && events[1].escrow === first,
      "topic-only events were not decoded or sorted");
    check(events[1].event === "HalfRevealed" && events[1].half === half && events[1].byClaimer === true,
      "topic-only events lost the revealed half");
    let refused = null;
    try { await readEscrowEventsByTopic({}); } catch (error) { refused = error; }
    check(refused && refused.code === "bad-input" && refused.params && refused.params.field === "evmLogs",
      "a topic-only read without a log seam was not refused");
  }

  notes.push("the v2 search uses the event salt, reads every log once, and derives the Monero start height");
  return { note: "the recovery key, its backup file and the salt-based search behave", problems, notes };
};
