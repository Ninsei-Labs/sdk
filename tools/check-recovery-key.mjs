// THE RECOVERY KEY CHECK (sdk#79): fixed vectors, the backup file, reservations and the on-chain search.
//
// The vectors are pinned so a change to a domain, a binding or the seed derivation is a red check, not a silent
// change to every swap made with the key.

import * as recovery from "../src/public/recovery.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { startHeightFromNodes } from "../src/swaps.mjs";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CHAIN = 421614;
const TOPIC = "0xa22cdabaed3cce4f51dde71626a108ffe9c7bc4216fd14d5e719f892e2fd8ab0";
const pad = (value) => "0x" + String(value).toLowerCase().replace(/^0x/, "").padStart(64, "0");
const address = (byte) => "0x" + byte.repeat(20);

const memory = () => {
  const map = new Map();
  return { get: (key) => (map.has(key) ? map.get(key) : null), set: (key, value) => map.set(key, value), remove: (key) => map.delete(key) };
};

const logFor = ({ commitment, locker, claimer, index = 0 }) => ({
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
    "0x" + "44".repeat(32),
    pad(address("55")),
    pad(address("66")),
    pad(address("77")),
  ].map((word) => word.replace(/^0x/, "").padStart(64, "0")).join(""),
  transactionHash: "0x" + String(index + 1).padStart(64, "0"),
  logIndex: index,
  blockNumber: 100 + index,
});

export const recoveryKeyCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  const imported = recovery.importRecoveryKey(WORDS, { createdAt: "2026-10-21" });
  check(imported.mnemonic === WORDS, "importRecoveryKey did not return the normalised words");
  check(imported.fingerprint === "3ae0", `fingerprint changed: ${imported.fingerprint}`);
  check(recovery.fingerprintOf(WORDS) === "3ae0", "fingerprintOf disagrees with importRecoveryKey");
  check(recovery.recoveryBinding(CHAIN, 0) === "ninsei-taker-v1|421614|0", "the binding changed");

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
  notes.push("reservations are reused only when released");

  const order = logFor({ commitment: halves.spendCommitment, locker: address("bb"), claimer: address("cc"), index: 0 });
  const calls = [];
  const found = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => { calls.push(request); return request.topics.includes(pad(address("bb"))) ? [order] : []; },
    gap: 2,
  });
  check(found.swaps.length === 1 && found.swaps[0].index === 0, `the search found ${found.swaps.length} orders`);
  check(found.swaps[0] && found.swaps[0].side === "locker", "the search named the wrong side");
  check(calls.length === 2, `an address query made ${calls.length} log calls, expected 2`);
  check(calls.every((call) => !call.topics.some((topic) => String(topic).toLowerCase().includes(halves.spendHalf.slice(2, 10)))), "a half was put into the log filter");

  const allCalls = [];
  const all = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"),
    evmLogs: async (request) => { allCalls.push(request); return [order]; },
    gap: 2,
  });
  check(all.swaps.length === 1 && allCalls.length === 1, `a full scan made ${allCalls.length} calls and found ${all.swaps.length} orders`);
  const withHeight = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [],
    evmBlockTime: async () => 1_000_000,
    moneroTip: async () => 2_000,
    moneroBlockTimestamp: async (height) => 500 + height * 1_000,
    gap: 2,
  });
  check(withHeight.swaps.length === 1, "the height search lost the order");
  check(withHeight.swaps[0].startHeight === 939, `the start height is ${withHeight.swaps[0].startHeight}, expected 939 (999 - 60)`);
  check(withHeight.swaps[0].startHeightReason === null, "a derived start height carries a refusal reason");
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
    gap: 2,
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
    gap: 2,
  });
  check(genesis.swaps[0].startHeightReason === null, `genesis timestamp 0 was refused: ${genesis.swaps[0].startHeightReason}`);
  check(genesis.swaps[0].startHeight === 0, `genesis start height is ${genesis.swaps[0].startHeight}`);
  notes.push("the search can use node URLs without three callbacks");
  const withoutHeight = await recovery.findSwaps({
    mnemonic: WORDS, chainId: CHAIN, factory: address("dd"), address: address("bb"),
    evmLogs: async (request) => request.topics.includes(pad(address("bb"))) ? [order] : [], gap: 2,
  });
  check(withoutHeight.swaps[0].startHeight === null && withoutHeight.swaps[0].startHeightReason === "no-height-readers",
    "a search without readers did not name the missing height");
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
