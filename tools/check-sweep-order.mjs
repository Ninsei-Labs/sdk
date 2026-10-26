// A FOUND ORDER AND THE KEY (sdk#92, item 5): build the sweep payload without a recovery file.
//
// The page used to assemble the SDK's own payload from the order and the key. That rule is now here: the side,
// the person's spend and view points, the other side's points, the joint address and the restore height.
import { createSweep } from "../src/sweep.mjs";
import { createSwaps } from "../src/swaps.mjs";
import { takerHalves, takerHalvesV2 } from "../src/recovery-key.mjs";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CHAIN = 421614;
const field = (byte) => "0x" + String(byte).repeat(20);

const orderFor = (halves, side) => ({
  escrow: field("aa"),
  locker: field("bb"),
  claimer: field("cc"),
  edPointLocker: side === "locker" ? halves.spendPoint : halves.makerViewPoint,
  edPointClaimer: side === "locker" ? halves.makerViewPoint : halves.spendPoint,
  edViewPointLocker: side === "locker" ? halves.viewPoint : halves.makerViewPoint,
  index: 0,
  side,
  xmrAmount: "1250000000000",
  startHeight: 2_100_000,
  blockTime: 1_700_000_000,
  readyBy: 1_700_000_100,
  t1: 1_700_000_200,
});

export const sweepFromOrderCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const sweep = createSweep({});
  const halves = takerHalves({ mnemonic: WORDS, chainId: CHAIN, index: 0 });

  const buy = await sweep.fromOrder({
    mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet",
    order: orderFor(halves, "locker"),
  });
  check(typeof buy.contents === "string" && buy.contents.length > 0, "fromOrder returned no file contents");
  check(buy.address === buy.payload.moneroWallet.address, "the returned address is not the payload's joint address");
  check(buy.payload.side === "buy" && buy.payload.moneroWallet.otherViewHalf === halves.makerViewHalf,
    "the buy did not carry the maker's view half");
  check(buy.payload.receive && buy.payload.receive.amount === "1.25",
    `the signed XMR amount is not in the recovery file: ${JSON.stringify(buy.payload.receive)}`);
  check(buy.payload.moneroWallet.restoreHeight === 2_100_000, `the restore height is ${buy.payload.moneroWallet.restoreHeight}`);
  check(buy.payload.moneroWallet.escrowAddress === orderFor(halves, "locker").escrow, "the escrow is not on the wallet");
  notes.push("a found buy becomes the same payload a recovery file carries");

  const sell = await sweep.fromOrder({
    mnemonic: WORDS, chainId: CHAIN, network: "arbitrum-sepolia", moneroNetwork: "stagenet",
    order: orderFor(halves, "claimer"),
  });
  check(sell.payload.side === "sell" && sell.address === sell.payload.moneroWallet.address,
    "the sell did not build the claimer's joint address");
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
  check(noBackend && noBackend.code === "bad-input" && noBackend.params && noBackend.params.why === "no-backend",
    "a watch without verify data did not name the missing backend");
  check(typeof sweep.report !== "function", "sweep.report still exists");
  notes.push("the SDK does not call a backend by default and has no service report");

  return { note: "the sweep builds its payload from the key and a found order", problems, notes };
};
