// THE RECOVERY KEY CHECK (sdk#79): fixed vectors, the backup file, reservations and the on-chain search.
//
// The vectors are pinned so a change to a domain, a binding or the seed derivation is a red check, not a silent
// change to every swap made with the key.

import * as recovery from "../src/public/recovery.mjs";
import { recoveryIndexTaken } from "../src/recovery-key.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { startHeightFromNodes } from "../src/swaps.mjs";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CHAIN = 421614;
const TOPIC = "0xa22cdabaed3cce4f51dde71626a108ffe9c7bc4216fd14d5e719f892e2fd8ab0";
const MODERN_TOPIC = "0x09add13cca47b227c377447295bfaa00ef3169bfed0f5513d06f8be04af78aad";
const pad = (value) => "0x" + String(value).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const address = (byte) => "0x" + byte.repeat(20);

const memory = () => {
  const map = new Map();
  return { get: (key) => (map.has(key) ? map.get(key) : null), set: (key, value) => map.set(key, value), remove: (key) => map.delete(key) };
};

const logFor = ({ commitment, locker, claimer, index = 0, salt = "0x" + "33".repeat(32) }) => ({
  topics: [TOPIC, pad(address("aa")), pad(locker), pad(claimer)],
  data: "0x" + [
    commitment,
    "0x" + "00".repeat(32),
    "0x" + "11".repeat(32),
    "0x" + "22".repeat(32),
    "0x" + "33".repeat(32),
    "0x1",
    "0x2",
    "0x3",
    salt,
    pad(address("55")),
    pad(address("66")),
    pad(address("77")),
  ].map((word) => word.replace(/^0x/, "").padStart(64, "0")).join(""),
  transactionHash: "0x" + String(index + 1).padStart(64, "0"),
  logIndex: index,
  blockNumber: 100 + index,
});

/// The current event: the same fields plus `xmrAmount` after `amount`.
const modernLogFor = ({ commitment, locker, claimer, index = 0, xmrAmount = "5000000000000" }) => {
  const legacy = logFor({ commitment, locker, claimer, index });
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
  check(imported.mnemonic === WORDS, "importRecoveryKey did not return the normalised words");
  check(imported.fingerprint === "3ae0", `fingerprint changed: ${imported.fingerprint}`);
  check(recovery.fingerprintOf(WORDS) === "3ae0", "fingerprintOf disagrees with importRecoveryKey");
  check(recovery.recoveryBinding(CHAIN, 0) === "ninsei-taker-v1|421614|0", "the binding changed");
  const saltV2 = "0x" + "ab".repeat(32);
  const factoryV2 = address("dd");
  const bindingV2 = recovery.recoveryBindingV2({ chainId: CHAIN, factory: factoryV2, salt: saltV2 });
  check(bindingV2 === `ninsei-taker-v2|421614|${factoryV2}|taker|${saltV2}`, `the v2 binding changed: ${bindingV2}`);
  const halvesV2 = recovery.takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory: factoryV2, salt: saltV2 });
  check(halvesV2.spendHalf === "0x007c77c781458811e2c9aabd59361f2360112c70cb8b20168cf468a5037b9ac6", `v2 spend half changed: ${halvesV2.spendHalf}`);
  check(halvesV2.spendCommitment === "0xedea6e219238e63caa05acc46a3a144c4d4d34e889b7f4e9c58f23fce6ee1601", `v2 commitment changed: ${halvesV2.spendCommitment}`);
  check(halvesV2.index === null && halvesV2.derivation === "salt-v2", "v2 did not name its derivation");
  const otherFactory = recovery.takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory: address("ee"), salt: saltV2 });
  check(otherFactory.spendCommitment !== halvesV2.spendCommitment, "the same salt at another factory produced the same half");
  const freshSalt = recovery.newRecoverySalt();
  check(/^0x[0-9a-f]{64}$/.test(freshSalt) && freshSalt !== recovery.newRecoverySalt(), "a fresh salt is not a unique 32-byte word");
  notes.push("v2 is salt-based: the factory, role and public salt are in the binding");

  const halves = recovery.takerHalves({ mnemonic: WORDS, chainId: CHAIN, index: 0 });
  check(halves.spendHalf === "0x08a3f2c84abe73db766e8925647c65c44e63439e6cb9aa0065816c8ada646200", `spend half changed: ${halves.spendHalf}`);
  check(halves.viewHalf === "0x0c7f5926fff480f57b3da60b019ebc3cddfd014ca348e8cab1702e8534f696cf", `view half changed: ${halves.viewHalf}`);
  check(halves.spendCommitment === "0xd76f78b636a123aafb4da3c226d1e8b81332461291641efe334026b85252a4b2", `commitment changed: ${halves.spendCommitment}`);
  check(halves.makerViewHalf === "0x0470bcc4d4c3e8af89174f19e71e208124a7947d98cc40b9436258d20e48a3e5", `maker view half changed: ${halves.makerViewHalf}`);
  check(halves.makerViewPoint === "ad1f3bb9b66ab339f47d9e215bd9ff90f6e8c87a66325a4a0c0ad700047057a8", `maker view point changed: ${halves.makerViewPoint}`);
  check(halves.makerViewHalf !== halves.viewHalf, "the maker view half equals the taker view half");
  const again = recovery.takerHalves({ mnemonic: WORDS, chainId: CHAIN, index: 0 });
  check(JSON.stringify(again) === JSON.stringify(halves), "the same words and index gave different halves");
  const orderTerms = {
    chainId: 421614, factory: "0x" + "11".repeat(20), locker: "0x" + "22".repeat(20),
    claimer: "0x" + "33".repeat(20), amount: "1000", readyBy: 2000000000, t1: 2000003600,
    salt: "0x" + "44".repeat(32),
  };
  const known = buildOwnSideFromHalves(orderTerms, { spendHalf: halves.spendHalf, viewHalf: halves.viewHalf });
  const samePoint = (a, b) => String(a).replace(/^0x/i, "").toLowerCase() === String(b).replace(/^0x/i, "").toLowerCase();
  check(samePoint(known.spendPoint, halves.spendPoint), "the known spend half produced another point");
  check(samePoint(known.viewPoint, halves.viewPoint), "the known view half produced another point");
  check(known.side.half.toString() === BigInt(halves.spendHalf).toString(), "the side did not keep the supplied spend half");
  notes.push("fixed halves and commitment vectors hold; the order side can be built from them");

  const generated = recovery.createRecoveryKey({ createdAt: "2026-10-21" });
  check(generated.mnemonic.split(" ").length === 12, "createRecoveryKey did not make twelve words");
  check(recovery.recoveryKeyFileName(generated) === `ninsei-recovery-key-DO-NOT-DELETE-2026-10-21-${generated.fingerprint}.txt`, `unexpected file name: ${recovery.recoveryKeyFileName(generated)}`);
  let refused = false;
  try { recovery.importRecoveryKey("abandon abandon abandon"); } catch (error) { refused = error && error.code === "bad-input"; }
  check(refused, "a short mnemonic was not refused with bad-input");
  notes.push("generation and refusal behave");

  const plain = await recovery.createRecoveryKeyFile({ mnemonic: WORDS, createdAt: "2026-10-21", passphrase: "" });
  check(plain.startsWith("NINSEI RECOVERY KEY\n"), "the plain file does not start with its magic line");
  const openedPlain = await recovery.openRecoveryKeyFile(plain, "");
  check(openedPlain.mnemonic === WORDS && openedPlain.fingerprint === "3ae0", "the plain file did not round-trip");

  const encrypted = await recovery.createRecoveryKeyFile({ mnemonic: WORDS, createdAt: "2026-10-21", passphrase: "correct horse battery" });
  check(encrypted.startsWith("{"), "the encrypted file is not JSON");
  const openedEncrypted = await recovery.openRecoveryKeyFile(encrypted, "correct horse battery");
  check(openedEncrypted.mnemonic === WORDS, "the encrypted file did not round-trip");
  let wrong = false;
  try { await recovery.openRecoveryKeyFile(encrypted, "wrong password"); } catch (error) { wrong = error && error.code === "recovery-failed" && error.params && error.params.stage === "decrypt"; }
  check(wrong, "a wrong password was not refused at decrypt");
  notes.push("plain and encrypted backup files round-trip");

  const storage = memory();
  recovery.saveRecoveryKey(storage, generated);
  const first = recovery.reserveRecoveryIndex(storage, { chainId: CHAIN, swapId: "one" });
  const second = recovery.reserveRecoveryIndex(storage, { chainId: CHAIN, swapId: "two" });
  check(first === 0 && second === 1, `reservation returned ${first} and ${second}`);
  recovery.releaseRecoveryIndex(storage, first);
  const reused = recovery.reserveRecoveryIndex(storage, { chainId: CHAIN, swapId: "three" });
  check(reused === 0, `a released number was not reused: ${reused}`);
  recovery.commitRecoveryIndex(storage, second);
  const afterCommit = recovery.reserveRecoveryIndex(storage, { chainId: CHAIN, swapId: "four" });
  check(afterCommit !== second, `a retired number was reused: ${afterCommit}`);
  check(typeof recovery.recoveryIndexTaken === "function", "recoveryIndexTaken is not exported from the public recovery entry");
  notes.push("reservations are reused only when released; the on-chain number check is public");

  const order = logFor({ commitment: halves.spendCommitment, locker: address("bb"), claimer: address("cc"), index: 0 });
  const taken = await recoveryIndexTaken({
    mnemonic: WORDS, chainId: CHAIN, index: 0, factory: address("dd"), evmLogs: async () => [order],
  });
  check(taken === true, "the on-chain check did not see the number held by its own commitment");
  const free = await recoveryIndexTaken({
    mnemonic: WORDS, chainId: CHAIN, index: 1, factory: address("dd"), evmLogs: async () => [order],
  });
  check(free === false, "the on-chain check treated another number's order as this number's");
  let unreadable = null;
  try {
    await recoveryIndexTaken({ mnemonic: WORDS, chainId: CHAIN, index: 0, factory: address("dd"),
      evmLogs: async () => { throw new Error("rpc down"); } });
  } catch (error) { unreadable = error; }
  check(unreadable && unreadable.code === "recovery-failed" && unreadable.params && unreadable.params.stage === "logs",
    "an unreadable chain did not refuse the number check");
  notes.push("a number held on chain is found by its commitment; an unreadable log refuses instead of guessing");
  const calls = [];
  const found = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => { calls.push(request); return request.topics.includes(pad(address("bb"))) ? [order] : []; },
    maxIndex: 4,
  });
  check(found.swaps.length === 1 && found.swaps[0].index === 0, `the search found ${found.swaps.length} orders`);
  check(found.swaps[0] && found.swaps[0].side === "locker", "the search named the wrong side");
  check(found.swaps[0] && found.swaps[0].derivation === "index-v1" && found.swaps[0].factory === address("dd"),
    "a v1 order did not name its derivation and factory");
  check(found.swaps[0].settlementToken === "native" && found.swaps[0].payToken === null &&
    found.swaps[0].payTokenReason === "not-on-chain", "the found order invented a paying token");
  check(calls.length === 2, `an address query made ${calls.length} log calls, expected 2`);
  check(calls.every((call) => !call.topics.some((topic) => String(topic).toLowerCase().includes(halves.spendHalf.slice(2, 10)))), "a half was put into the log filter");
  check(found.swaps[0].xmrAmount === null && found.swaps[0].xmrAmountReason === "no-code-reader",
    `a search without a code reader answered ${found.swaps[0].xmrAmount}/${found.swaps[0].xmrAmountReason}`);
  // A RUN OF EMPTY NUMBERS IS NOT A STOP. The number before this order (5) is empty; a gap rule of 2 would
  // have returned no swaps while the matching log was already in hand. The scan is bounded, and this order is
  // the only unmatched log, so finding it also ends the search.
  const gappedHalves = recovery.takerHalves({ mnemonic: WORDS, chainId: CHAIN, index: 5 });
  const gappedOrder = logFor({ commitment: gappedHalves.spendCommitment, locker: address("bb"), claimer: address("cc"), index: 5 });
  const gapped = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [gappedOrder], gap: 2, maxIndex: 6,
  });
  check(gapped.swaps.length === 1 && gapped.swaps[0].index === 5,
    `a gap of two hid the order at number 5: found ${gapped.swaps.length}`);
  check(gapped.complete === true && gapped.searchedUpTo === 5 && gapped.nextIndex === undefined,
    `a found-and-complete search named its bound wrongly: ${JSON.stringify({ complete: gapped.complete, searchedUpTo: gapped.searchedUpTo, nextIndex: gapped.nextIndex })}`);
  // A SHARED FACTORY KEEPS UNRELATED LOGS. The scan cannot finish early, so it stops at the bound and names
  // the next index instead of pretending the range was complete.
  const foreign = logFor({ commitment: "0x" + "99".repeat(32), locker: address("bb"), claimer: address("cc"), index: 1 });
  const bounded = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [foreign], maxIndex: 4,
  });
  check(bounded.swaps.length === 0 && bounded.scanned === 4 && bounded.searchedUpTo === 3 &&
    bounded.complete === false && bounded.incompleteReason === "max-index" && bounded.nextIndex === 4,
    `a bounded search did not name its bound: ${JSON.stringify(bounded)}`);
  // THE DEFAULT BOUND IS SMALL AND THE SCAN YIELDS. A zero-delay timer must run before the call returns, and
  // the default must not walk the allocator's 100,000 numbers on a page open.
  let yielded = false;
  const timer = setTimeout(() => { yielded = true; }, 0);
  const started = Date.now();
  const defaulted = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [foreign],
  });
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  check(defaulted.scanned === recovery.RECOVERY_SCAN_DEFAULT && defaulted.complete === false &&
    defaulted.nextIndex === recovery.RECOVERY_SCAN_DEFAULT,
    `the default bound is ${defaulted.scanned}, complete=${defaulted.complete}, next=${defaulted.nextIndex}`);
  check(yielded, "the scan did not yield to the event loop");
  check(elapsed < 5000, `the default scan took ${elapsed} ms`);
  // THE PROGRESS CALLBACK SEES THE LAST INDEX EVEN WHEN IT IS NOT A CHUNK BOUNDARY, and an abort from that
  // callback stops the scan before the next index.
  const progress = [];
  const controller = new AbortController();
  const aborted = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [foreign], maxIndex: 200, signal: controller.signal,
    onProgress: ({ scanned, index }) => { progress.push({ scanned, index }); if (scanned === 64) controller.abort(); },
  });
  check(progress.length === 1 && progress[0].scanned === 64 && progress[0].index === 63,
    `progress reported ${JSON.stringify(progress)}`);
  check(aborted.scanned === 64 && aborted.complete === false && aborted.incompleteReason === "aborted" &&
    aborted.nextIndex === 64,
    `an aborted scan did not name its stop: ${JSON.stringify({ scanned: aborted.scanned, complete: aborted.complete, reason: aborted.incompleteReason, next: aborted.nextIndex })}`);
  const already = new AbortController();
  already.abort();
  const beforeStart = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [foreign], maxIndex: 200, signal: already.signal,
  });
  check(beforeStart.scanned === 0 && beforeStart.complete === false && beforeStart.incompleteReason === "aborted" &&
    beforeStart.nextIndex === 0 && beforeStart.searchedUpTo === null,
    `an already-aborted scan did not stop before derivation: ${JSON.stringify(beforeStart)}`);
  const finalProgress = [];
  const final = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [foreign], maxIndex: 4,
    onProgress: (value) => finalProgress.push(value),
  });
  check(finalProgress.length === 1 && finalProgress[0].scanned === 4 && finalProgress[0].index === 3,
    `the final partial chunk was not reported: ${JSON.stringify(finalProgress)}`);
  let refusedProgress = false;
  try {
    await recovery.findSwaps({
      mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
      evmLogs: async () => [foreign], maxIndex: 1, onProgress: "not-a-function",
    });
  } catch (error) { refusedProgress = error && error.code === "bad-input"; }
  check(refusedProgress, "a non-function progress callback was accepted");
  // A CALLER CAN CONTINUE FROM THE RETURNED nextIndex. The order at 100 is outside the first 10, and the
  // second call finds it without rescanning the first range.
  const lateHalves = recovery.takerHalves({ mnemonic: WORDS, chainId: CHAIN, index: 100 });
  const lateOrder = logFor({ commitment: lateHalves.spendCommitment, locker: address("bb"), claimer: address("cc"), index: 100 });
  const firstPart = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [lateOrder], maxIndex: 10,
  });
  check(firstPart.swaps.length === 0 && firstPart.complete === false && firstPart.nextIndex === 10,
    `the first part did not stop at 10: ${JSON.stringify(firstPart)}`);
  const secondPart = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [lateOrder], fromIndex: firstPart.nextIndex, maxIndex: 100,
  });
  check(secondPart.swaps.length === 1 && secondPart.swaps[0].index === 100 && secondPart.complete === true &&
    secondPart.searchedUpTo === 100,
    `the continuation did not find the order at 100: ${JSON.stringify(secondPart)}`);
  notes.push("discovery scans past empty numbers, yields, and names the next index when bounded");
  const v2Log = logFor({ commitment: halvesV2.spendCommitment, locker: address("bb"), claimer: address("cc"), index: 0, salt: saltV2 });
  const v2Found = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: factoryV2, address: address("bb"),
    evmLogs: async () => [v2Log], maxIndex: 1,
  });
  check(v2Found.swaps.length === 1 && v2Found.swaps[0].index === null && v2Found.swaps[0].derivation === "salt-v2",
    `a v2 order was not found from its salt: ${JSON.stringify(v2Found.swaps[0] && { index: v2Found.swaps[0].index, derivation: v2Found.swaps[0].derivation })}`);
  check(v2Found.scanned === 0 && v2Found.complete === true && v2Found.searchedUpTo === null,
    `a v2-only search still scanned a range: ${JSON.stringify({ scanned: v2Found.scanned, complete: v2Found.complete, searchedUpTo: v2Found.searchedUpTo })}`);
  check(v2Found.swaps[0].factory === factoryV2 && v2Found.swaps[0].salt === saltV2,
    "the v2 result did not carry the factory and salt needed by the withdrawal");
  notes.push("v2 discovery uses the event salt and needs no index reservation");
  const xmrWord = BigInt(5_000_000_000_000).toString(16).padStart(64, "0");
  const cloneCode = "0x" + "00".repeat(621) + xmrWord + "00".repeat(877 - 621 - 32);
  const withXmr = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [],
    evmCode: async () => cloneCode, maxIndex: 4,
  });
  check(withXmr.swaps[0].xmrAmount === "5000000000000" && withXmr.swaps[0].xmrAmountReason === null,
    `the clone's XMR amount became ${withXmr.swaps[0].xmrAmount}/${withXmr.swaps[0].xmrAmountReason}`);
  const modernLog = modernLogFor({ commitment: halves.spendCommitment, locker: address("bb"), claimer: address("cc"), xmrAmount: "7000000000000" });
  const modern = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [modernLog], maxIndex: 4,
  });
  check(modern.swaps[0] && modern.swaps[0].xmrAmount === "7000000000000" && modern.swaps[0].xmrAmountReason === "event",
    `the current event's XMR amount became ${modern.swaps[0]?.xmrAmount}/${modern.swaps[0]?.xmrAmountReason}`);

  const allCalls = [];
  const all = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"),
    evmLogs: async (request) => { allCalls.push(request); return [order]; },
    maxIndex: 4,
  });
  check(all.swaps.length === 1 && allCalls.length === 1, `a full scan made ${allCalls.length} calls and found ${all.swaps.length} orders`);
  // THE FACTORY'S BIRTH HEIGHT IS THE DEFAULT START. A public RPC refuses a log query from genesis; the registry
  // carries the block, and `findSwaps` uses it when the caller did not name one.
  const deploymentCalls = [];
  await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"),
    evmLogs: async (request) => { deploymentCalls.push(request.fromBlock); return [order]; },
    maxIndex: 4, deploymentBlock: 321430239,
  });
  check(deploymentCalls.length === 1 && deploymentCalls[0] === 321430239,
    `the deployment block became ${deploymentCalls[0]}, expected 321430239`);
  const explicitCalls = [];
  await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"),
    evmLogs: async (request) => { explicitCalls.push(request.fromBlock); return [order]; },
    maxIndex: 4, fromBlock: 7, deploymentBlock: 321430239,
  });
  check(explicitCalls.length === 1 && explicitCalls[0] === 7,
    `an explicit fromBlock became ${explicitCalls[0]}, expected 7`);
  const withHeight = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [],
    evmBlockTime: async () => 1_000_000,
    moneroTip: async () => 2_000,
    moneroBlockTimestamp: async (height) => 500 + height * 1_000,
    maxIndex: 4,
  });
  check(withHeight.swaps.length === 1, "the height search lost the order");
  check(withHeight.swaps[0].startHeight === 939, `the start height is ${withHeight.swaps[0].startHeight}, expected 939 (999 - 60)`);
  check(withHeight.swaps[0].startHeightReason === null, "a derived start height carries a refusal reason");
  check(withHeight.swaps[0].blockTime === 1_000_000, `the block time is ${withHeight.swaps[0].blockTime}`);
  const nodeFetch = async (url, options) => {
    const request = JSON.parse(options.body);
    // A REAL NODE'S TOP BLOCK IS height - 1: `get_info.height` counts blocks, and a header request at `height` answers
    // "greater than current top block". This stand-in does the same, so a reader that asks for `height` loses the order.
    if (request.method === "get_block_header_by_height" && Number(request.params.height) >= 2_000) {
      return { ok: true, json: async () => ({ error: { code: -1, message: "greater than current top block height" } }) };
    }
    const result = request.method === "get_info"
      ? { height: 2_000, nettype: "stagenet", synchronized: true }
      : { block_header: { timestamp: 500 + Number(request.params.height) * 1_000 } };
    return { ok: true, json: async () => ({ result }) };
  };
  const throughNode = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [],
    evmBlockTime: async () => 1_000_000,
    xmrNodes: ["https://node.example"], moneroNetwork: "stagenet", fetchImpl: nodeFetch,
    maxIndex: 4,
  });
  check(throughNode.swaps[0].startHeight === 939, `the node-backed start height is ${throughNode.swaps[0].startHeight}`);
  const genesis = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [],
    evmBlockTime: async () => 0,
    xmrNodes: ["https://node.example"], moneroNetwork: "stagenet",
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === "get_info") return { ok: true, json: async () => ({ result: { height: 1, nettype: "stagenet", synchronized: true } }) };
      return { ok: true, json: async () => ({ result: { block_header: { timestamp: 0 } } }) };
    },
    maxIndex: 4,
  });
  check(genesis.swaps[0].startHeightReason === null, `genesis timestamp 0 was refused: ${genesis.swaps[0].startHeightReason}`);
  check(genesis.swaps[0].startHeight === 0, `genesis start height is ${genesis.swaps[0].startHeight}`);
  notes.push("the search can use node URLs without three callbacks");
  const withoutHeight = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [], maxIndex: 4,
  });
  check(withoutHeight.swaps[0].startHeight === null && withoutHeight.swaps[0].startHeightReason === "no-height-readers",
    "a search without readers did not name the missing height");
  check(withoutHeight.swaps[0].blockTime === null, `a search without a block-time reader returned ${withoutHeight.swaps[0].blockTime}`);
  const noTime = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [],
    evmBlockTime: async () => null, maxIndex: 4,
  });
  check(noTime.swaps[0].startHeightReason === "no-block-time" && noTime.swaps[0].blockTime === null,
    `a null block time became ${JSON.stringify({ reason: noTime.swaps[0].startHeightReason, time: noTime.swaps[0].blockTime })}`);
  // ONE FAILING BLOCK-TIME READ KEEPS THE ORDER IT ALREADY MATCHED. A thrown reader used to escape findSwaps and
  // drop every row, so a page showed the whole network as unreadable.
  const secondHalves = recovery.takerHalves({ mnemonic: WORDS, chainId: CHAIN, index: 1 });
  const secondOrder = logFor({ commitment: secondHalves.spendCommitment, locker: address("bb"), claimer: address("cc"), index: 1 });
  const mixed = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async () => [order, secondOrder], maxIndex: 3,
    evmBlockTime: async (block) => { if (block === 101) throw new Error("rpc down"); return 1_000_000; },
  });
  check(mixed.swaps.length === 2, `a failed block-time read dropped matched orders: ${mixed.swaps.length}`);
  const failed = mixed.swaps.find((row) => row.blockNumber === 101);
  const kept = mixed.swaps.find((row) => row.blockNumber === 100);
  check(failed && failed.startHeight === null && failed.startHeightReason === "block-time-read" && failed.blockTime === null,
    `a failed block-time read was not named: ${JSON.stringify(failed && { reason: failed.startHeightReason, time: failed.blockTime })}`);
  check(kept && kept.blockTime === 1_000_000, "the other matched order lost its block time");
  notes.push("a failed block-time read keeps the matched order and names the reason");
  const unreachable = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [],
    evmBlockTime: async () => 1_000_000, xmrNodes: ["https://node.example"], moneroNetwork: "stagenet",
    fetchImpl: async () => { throw new Error("down"); }, maxIndex: 4,
  });
  check(unreachable.swaps[0].startHeightReason === "monero-nodes-unreachable",
    `an unreachable node was reported as ${unreachable.swaps[0].startHeightReason}`);
  const otherNet = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [],
    evmBlockTime: async () => 1_000_000, xmrNodes: ["https://node.example"], moneroNetwork: "mainnet",
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: { height: 2_000, nettype: "stagenet", synchronized: true } }) }),
    maxIndex: 4,
  });
  check(otherNet.swaps[0].startHeightReason === "monero-network-mismatch",
    `a node on another network was reported as ${otherNet.swaps[0].startHeightReason}`);
  notes.push("no block time, an unreachable node and a wrong-network node have three different reasons");
  notes.push("the search matches a commitment and filters by address without sending a secret; it derives the Monero start height");

  const answer = (result) => async () => ({ ok: true, json: async () => ({ result }) });
  const measured = await startHeightFromNodes({
    nodes: ["https://node.example"], network: "stagenet",
    fetchImpl: answer({ height: 2234563, nettype: "stagenet", synchronized: true }),
  });
  check(measured === 2234563, `the node height was read as ${measured}`);
  let wrongNetwork = null;
  try {
    await startHeightFromNodes({ nodes: ["https://node.example"], network: "mainnet",
      fetchImpl: answer({ height: 1, nettype: "stagenet", synchronized: true }) });
  } catch (error) { wrongNetwork = error; }
  check(wrongNetwork && wrongNetwork.code === "xmr-no-nodes" && wrongNetwork.params && wrongNetwork.params.why === "network",
    "a node on another network was not refused with why=network");
  let noNode = null;
  try { await startHeightFromNodes({ nodes: [], network: "stagenet", fetchImpl: answer({ height: 1 }) }); }
  catch (error) { noNode = error; }
  check(noNode && noNode.code === "xmr-no-nodes" && noNode.params && noNode.params.why === "no-node",
    "a missing node was not refused with why=no-node");
  notes.push("the start height is measured from a node and a foreign network is refused");

  return { note: "the recovery key, its backup file, reservations and the on-chain search behave", problems, notes };
};
