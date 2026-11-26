// A FOUND ORDER AND THE KEY: build the sweep payload without a recovery file.
//
// The page used to assemble the SDK's own payload from the order and the key. That rule is now here: the side,
// the person's spend and view points, the other side's points, the joint address and the restore height.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSweep } from "../src/sweep.mjs";
import { createSwaps } from "../src/swaps.mjs";
import { takerHalvesV2 } from "../src/recovery-key.mjs";
import { createHalves } from "../engine/atomic/halves.js";
import { decodeAddressKeys } from "../engine/monero/arrivalRead.js";
import { primitives } from "../src/primitives.mjs";
import { verifyArrival } from "../src/xmr-arrival.mjs";
import {
  amountMaskCommitment, bytesToHex, derivedOutputKey, hashToScalar, hexToBytes, keyDerivation,
  scalarToBytesLE, varint,
} from "../engine/monero/scan.js";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_WORDS = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const CHAIN = 421614;
const field = (byte) => "0x" + String(byte).repeat(20);

const factoryV2main = field("dd");
const saltV2main = "0x" + "ab".repeat(32);
const orderFor = (halves, side) => ({
  escrow: field("aa"),
  locker: field("bb"),
  claimer: field("cc"),
  edPointLocker: "0x" + String(side === "locker" ? halves.spendPoint : halves.makerViewPoint).replace(/^0x/, ""),
  edPointClaimer: "0x" + String(side === "locker" ? halves.makerViewPoint : halves.spendPoint).replace(/^0x/, ""),
  edViewPointLocker: "0x" + String(side === "locker" ? halves.viewPoint : halves.makerViewPoint).replace(/^0x/, ""),
  amount: "1000000000000000000",
  commitHalfLocker: "0x" + "11".repeat(32),
  commitHalfClaimer: "0x" + "22".repeat(32),
  derivation: "salt-v2",
  factory: factoryV2main,
  salt: saltV2main,
  side,
  xmrAmount: "1250000000000",
  startHeight: 2_100_000,
  blockTime: 1_700_000_000,
  readyBy: 1_700_000_100,
  t1: 1_700_000_200,
});

const ARRIVAL_AMOUNT = 1_000_000_000n;
const ARRIVAL_TXID = "a".repeat(64);
const le8 = (value) => {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
};
const xorBytes = (bytes, key) => bytes.map((byte, index) => byte ^ (key[index] || 0));
const factorOf = (label, scalarLE) => {
  const name = new TextEncoder().encode(label);
  const buf = new Uint8Array(name.length + scalarLE.length);
  buf.set(name, 0); buf.set(scalarLE, name.length);
  return primitives.keccak256(buf);
};
const arrivalTx = (viewSecret, spendPub) => {
  const txPublicKey = primitives.ed25519.Point.BASE.multiply(17n).toHex();
  const derivation = keyDerivation(txPublicKey, viewSecret);
  const scalarLE = scalarToBytesLE(hashToScalar(derivation, varint(0)));
  const amountCipher = xorBytes(le8(ARRIVAL_AMOUNT), factorOf("amount", scalarLE));
  const mask = hashToScalar(new TextEncoder().encode("commitment_mask"), scalarLE);
  const outPk = amountMaskCommitment(ARRIVAL_AMOUNT, mask);
  const key = derivedOutputKey(derivation, 0, spendPub);
  return {
    version: 2,
    unlock_time: 0,
    extra: [1, ...hexToBytes(txPublicKey)],
    vout: [{ amount: 0, target: { tagged_key: { key, view_tag: "00" } } }],
    rct_signatures: { type: 6, ecdhInfo: [{ amount: bytesToHex(amountCipher) }], outPk: [outPk] },
  };
};
const arrivalNode = (tx) => async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.method === "get_info") {
    return { ok: true, json: async () => ({ result: { height: 121, synchronized: true, nettype: "stagenet" } }) };
  }
  if (body.method === "get_block") {
    const height = Number(body.params.height);
    const hashes = height === 105 ? [ARRIVAL_TXID] : [];
    return { ok: true, json: async () => ({ result: {
      block_header: {
        height,
        hash: (height < 0 ? "00" : height.toString(16).padStart(2, "0")).repeat(32),
        prev_hash: (height <= 0 ? "00" : (height - 1).toString(16).padStart(2, "0")).repeat(32),
        num_txes: hashes.length,
      },
      tx_hashes: hashes,
    } }) };
  }
  if (url.endsWith("/get_transaction_pool_hashes")) {
    return { ok: true, json: async () => ({ tx_hashes: [] }) };
  }
  const hashes = body.txs_hashes || [];
  return { ok: true, json: async () => ({
    txs: hashes.map((hash) => ({ tx_hash: hash, block_height: 105, confirmations: 16 })),
    txs_as_json: hashes.map(() => JSON.stringify(tx)),
  }) };
};

export const sweepFromOrderCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const sweep = createSweep({});
  const halves = takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory: factoryV2main, salt: saltV2main });
  const halfMath = createHalves(primitives);
  const moneroScalar = (hex) => BigInt("0x" + String(hex).match(/../g).reverse().join(""));
  const viewPubOf = (address) => decodeAddressKeys(address).viewPub;

  const buy = await sweep.fromOrder({
    mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet",
    order: orderFor(halves, "locker"),
  });
  check(typeof buy.contents === "string" && buy.contents.length > 0, "fromOrder returned no file contents");
  check(buy.address === buy.payload.moneroWallet.address, "the returned address is not the payload's joint address");
  check(/^[0-9a-f]{64}$/.test(buy.viewSecret), "the buy view secret is not 64 hex without a prefix");
  check(String(halfMath.publicHalves(moneroScalar(buy.viewSecret)).ed).replace(/^0x/, "").toLowerCase()
    === viewPubOf(buy.address).toLowerCase(), "the buy view secret does not open the returned address");
  check(buy.payload.side === "buy" && buy.payload.moneroWallet.otherViewHalf === halves.makerViewHalf,
    "the buy did not carry the maker's view half");
  check(buy.payload.receive && buy.payload.receive.amount === "1.25",
    `the signed XMR amount is not in the recovery file: ${JSON.stringify(buy.payload.receive)}`);
  check(buy.payload.moneroWallet.restoreHeight === 2_100_000, `the restore height is ${buy.payload.moneroWallet.restoreHeight}`);
  check(buy.payload.moneroWallet.escrowAddress === orderFor(halves, "locker").escrow, "the escrow is not on the wallet");
  check(buy.side === "locker" && buy.kind === "refund", "a buy did not return the locker's refund action");
  check(buy.escrow === field("aa") && buy.claimer === field("cc"), "the buy action does not name its escrow and claimer");
  check(buy.half === halves.spendHalf, "the buy action did not carry the recovered spend half");
  check(buy.expect.chainId === CHAIN && buy.expect.factory === factoryV2main,
    "the buy action does not carry the chain and factory");
  check(buy.expect.locker === field("bb") && buy.expect.claimer === field("cc"),
    "the buy action does not carry the order parties");
  check(buy.expect.amount === "1000000000000000000" && buy.expect.readyBy === 1_700_000_100 && buy.expect.t1 === 1_700_000_200,
    "the buy action does not carry the amount and deadlines");
  check(buy.expect.salt === saltV2main && buy.expect.commitHalfLocker === "0x" + "11".repeat(32) &&
    buy.expect.commitHalfClaimer === "0x" + "22".repeat(32),
    "the buy action does not carry the salt and commitments");
  check(buy.expect.edPointLocker === "0x" + halves.spendPoint && buy.expect.edPointClaimer === "0x" + halves.makerViewPoint &&
    buy.expect.edViewPointLocker === "0x" + halves.viewPoint,
    "the buy action does not carry the order points");
  notes.push("a found buy becomes the same payload a recovery file carries");

  const sell = await sweep.fromOrder({
    mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet",
    order: orderFor(halves, "claimer"),
  });
  check(sell.payload.side === "sell" && sell.address === sell.payload.moneroWallet.address,
    "the sell did not build the claimer's joint address");
  check(/^[0-9a-f]{64}$/.test(sell.viewSecret), "the sell view secret is not 64 hex without a prefix");
  check(String(halfMath.publicHalves(moneroScalar(sell.viewSecret)).ed).replace(/^0x/, "").toLowerCase()
    === viewPubOf(sell.address).toLowerCase(), "the sell view secret does not open the returned address");
  check(sell.side === "claimer" && sell.kind === "claim" && sell.half === halves.spendHalf,
    "a sell did not return the claimer's claim action and recovered half");

  // THE SAME SECRET AFTER THE OTHER HALF IS REVEALED. `sweep.keys` is the post-reveal path; a secret that differs
  // from it would make the page watch one key now and another key after settlement.
  const otherHalves = takerHalvesV2({ mnemonic: OTHER_WORDS, chainId: CHAIN, factory: factoryV2main,
    salt: "0x" + "cd".repeat(32) });
  const revealOrder = orderFor(halves, "locker");
  revealOrder.edPointClaimer = "0x" + otherHalves.spendPoint;
  const revealBuy = await sweep.fromOrder({
    mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet", order: revealOrder,
  });
  const revealedKeys = await sweep.keys({
    file: { contents: revealBuy.contents }, passphrase: "", revealedHalf: otherHalves.spendHalf,
  });
  check(revealedKeys.privateViewKey === revealBuy.viewSecret,
    "the pre-reveal view secret differs from sweep.keys privateViewKey");

  // THE ARRIVAL READ USES ONLY THE ADDRESS AND THE SECRET. A payment made to the returned address is found by
  // `verifyArrival`; the caller derives no view half, no point and no second key.
  const spendPub = decodeAddressKeys(buy.address).spendPub;
  const arrival = await verifyArrival({
    nodes: [{ url: "https://a.example", operator: "A" }, { url: "https://b.example", operator: "B" }],
    address: buy.address,
    viewSecret: buy.viewSecret,
    expectedAtomic: ARRIVAL_AMOUNT,
    amountRule: "at-least",
    minConfirmations: 1,
    fromHeight: 100,
    txid: ARRIVAL_TXID,
    fetch: arrivalNode(arrivalTx(buy.viewSecret, spendPub)),
  });
  check(arrival.state === "arrived" && arrival.txid === ARRIVAL_TXID
    && BigInt(arrival.amountAtomic) === ARRIVAL_AMOUNT,
    "verifyArrival did not find the payment with the returned address and view secret: " + JSON.stringify(arrival));
  check(sell.claimer === field("cc") && sell.expect.claimer === field("cc"),
    "the sell action does not name the claimer the sender guard reads");
  notes.push("a found sell names the person as the claimer");

  // A V2 ORDER CARRIES NO INDEX. Its salt, factory and the words rebuild the same address; reading an index would
  // invent a number and produce a different wallet.
  const saltV2 = "0x" + "ab".repeat(32);
  const factoryV2 = field("dd");
  const halvesV2 = takerHalvesV2({ mnemonic: WORDS, chainId: CHAIN, factory: factoryV2, salt: saltV2 });
  const v2Order = { ...orderFor(halvesV2, "locker"), index: null, derivation: "salt-v2", factory: factoryV2, salt: saltV2 };
  const v2 = await sweep.fromOrder({
    mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet", order: v2Order,
  });
  check(v2.address === v2.payload.moneroWallet.address, "the v2 order did not build the joint address");
  check(v2.payload.moneroWallet.spendHalf === halvesV2.spendHalf, "the v2 order used a different spend half");
  notes.push("a salt-based found order builds the same payload without an index");

  let mismatch = null;
  try {
    const wrong = orderFor(halves, "locker");
    wrong.edPointLocker = "0x" + "11".repeat(32);
    await sweep.fromOrder({
      mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet", order: wrong,
    });
  } catch (error) { mismatch = error; }
  check(mismatch && mismatch.code === "bad-input" && mismatch.params && mismatch.params.why === "spend-point",
    "an order whose spend point is not the key's was not refused");
  check(mismatch && !JSON.stringify(mismatch).includes(buy.viewSecret)
    && !JSON.stringify(mismatch).includes("viewSecret"),
    "a refused foreign order leaked the view secret");

  // BREAKING RUN: THE VIEW SECRET IS LOAD-BEARING. A copy that returns a constant instead of the sum of the two
  // view halves must fail the same public-key check the accepted cases use.
  const secretTmp = mkdtempSync(join(tmpdir(), "sdk-sweep-view-"));
  try {
    const sourceUrl = new URL("../src/sweep.mjs", import.meta.url);
    const source = readFileSync(sourceUrl, "utf8").replace(/\r\n?/g, "\n");
    const sum = 'BigInt(value).toString(16).padStart(64, "0").match(/../g).reverse().join("")';
    if (!source.includes(sum)) {
      problems.push("the view-secret breaking run could not find the scalar helper");
    } else {
      const mutated = source.replace(sum, '"01".repeat(32)')
        .replace(/from\s+"(\.[^"]+)"/g, (_, spec) => `from "${new URL(spec, sourceUrl).href}"`);
      const copy = join(secretTmp, "sweep.mjs");
      writeFileSync(copy, mutated);
      const mod = await import(pathToFileURL(copy).href + "?v=" + Date.now());
      const mutant = await mod.createSweep({}).fromOrder({
        mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet",
        order: orderFor(halves, "locker"),
      });
      check(mutant.viewSecret === "01".repeat(32)
        && String(halfMath.publicHalves(moneroScalar(mutant.viewSecret)).ed).replace(/^0x/, "").toLowerCase()
          !== viewPubOf(mutant.address).toLowerCase(),
        "removing the view-sum did not change the returned secret");
    }
  } finally {
    rmSync(secretTmp, { recursive: true, force: true });
  }

  // THE ACTION MATERIAL REFUSES AN ORDER THAT CANNOT BE CHECKED. A missing expectation field would make the
  // slot guard skip that field; the half must not become usable from an order without it.
  let incomplete = null;
  try {
    const broken = orderFor(halves, "locker");
    delete broken.amount;
    await sweep.fromOrder({
      mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet", order: broken,
    });
  } catch (error) { incomplete = error; }
  check(incomplete && incomplete.code === "bad-input" && incomplete.params && incomplete.params.field === "order" &&
    Array.isArray(incomplete.params.missing) && incomplete.params.missing.includes("amount"),
    "an order without the native amount still produced action material");

  // BREAKING RUN: THE MISSING-AMOUNT REFUSAL IS THE GUARD THE CASE CLAIMS. A copy with the amount check removed must
  // accept the same order; otherwise the refusal above came from something else and would survive the rule's removal.
  const tmp = mkdtempSync(join(tmpdir(), "sdk-sweep-action-"));
  try {
    const source = readFileSync(new URL("../src/sweep-action.mjs", import.meta.url), "utf8");
    const errorsUrl = new URL("../src/errors.mjs", import.meta.url).href;
    const amountGuard = 'if (!amount || !INTEGER_RE.test(amount) || BigInt(amount) <= 0n) missing.push("amount");';
    const mutated = source
      .replace('from "./errors.mjs"', `from "${errorsUrl}"`)
      .replace(amountGuard, "/* the amount guard is removed by the breaking run */");
    check(!mutated.includes(amountGuard), "the breaking run could not find the amount guard");
    const copy = join(tmp, "sweep-action.mjs");
    writeFileSync(copy, mutated);
    const mod = await import(pathToFileURL(copy).href + "?run=" + Date.now());
    const broken = orderFor(halves, "locker");
    delete broken.amount;
    let accepted = null;
    try { accepted = mod.actionMaterialOf({ order: broken, chainId: CHAIN, half: halves.spendHalf }); } catch { accepted = null; }
    check(accepted && accepted.expect.amount === null, "removing the amount guard did not change the refusal");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  let missing = null;
  try {
    await sweep.fromOrder({ order: orderFor(halves, "locker") });
  } catch (error) { missing = error; }
  check(missing && missing.code === "bad-input" && missing.params && missing.params.field === "mnemonic",
    "a request without the key was not refused");

  // NO BACKEND BY DEFAULT: a watch without the client's verify data has nothing to ask and must name that, not call
  // the page's own origin.
  const swaps = createSwaps({ config: { limits: { watchPollMs: 1, watchTimeoutMs: 5 } } });
  let noBackend = null;
  try { await swaps.watch({ id: "no-backend" }); } catch (error) { noBackend = error; }
  check(noBackend && noBackend.code === "bad-input" && noBackend.params && noBackend.params.why === "required",
    "a watch without verify data did not name the missing client-side check");
  check(typeof sweep.report !== "function", "sweep.report still exists");
  notes.push("the SDK does not call a backend by default and has no service report");

  return { note: "the sweep builds its payload from the key and a found order", problems, notes };
};
