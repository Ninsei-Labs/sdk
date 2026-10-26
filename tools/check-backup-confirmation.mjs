#!/usr/bin/env node
// A SAVED KEY IS NOT A BACKED-UP KEY.
//
// `start` used to save a new recovery key before asking the person to confirm it. If the person declined, the
// first start failed but the key stayed in storage; the next start saw a key, did not ask again, and could fund
// the escrow. The confirmation is now its own fact (`backupConfirmed`), and a declined key is asked for again.
//
// Run: node tools/check-backup-confirmation.mjs
import { createSwaps } from "../src/swaps.mjs";
import { buildOwnSideFromHalves } from "../src/order.mjs";
import { primitives } from "../src/primitives.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";
import { halfCommitmentHex } from "../engine/atomic/orderHalfCommit.js";
import { memoryStorage, setStorage } from "../engine/core/store.js";
import { FACTORY_METHODS } from "../engine/evm/factory.js";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const addr = (b) => "0x" + b.repeat(20);
const now = Math.floor(Date.now() / 1000);

const order = { chainId: 421614, factory: addr("11"), locker: addr("22"), claimer: addr("33"),
  amount: "1000000000000000000", readyBy: now + 7200, t1: now + 14400, salt: "0x" + "44".repeat(32) };
const maker = buildOwnSideFromHalves(order, { spendHalf: "0x03", viewHalf: "0x04" });
const makerKey = "0x" + "11".repeat(32);
const pub = primitives.secp256k1.getPublicKey(Buffer.from(makerKey.slice(2), "hex"), false);
const quote = { ...order, provider: order.claimer,
  quoteKey: "0x" + Buffer.from(primitives.keccak256(pub.slice(1)).slice(12)).toString("hex"),
  registry: addr("55"), cashier: addr("66"),
  commitHalfClaimer: halfCommitmentHex(3n, primitives.secp256k1, primitives.keccak256),
  edPointClaimer: maker.spendPoint, feeBps: 0, fee: "0", feeRecipient: addr("77"),
  validUntil: now + 600, nonce: "1", xmrAmount: "1000000000000", claimTip: "0" };
quote.signature = signQuoteDigest({ crypto: primitives, digest: quoteDigest({ crypto: primitives, quote }), privateKey: makerKey });

setStorage(memoryStorage());
let asked = 0;
const sent = [];
const wallet = { address: async () => order.locker,
  send: async (tx) => { sent.push(tx); throw Object.assign(new Error("stop before broadcast"), { code: "wallet-rejected" }); },
  receipt: async () => null };
const deps = { mode: "live", xmrNetwork: "stagenet", logs: async () => [],
  call: async ({ data }) => (data.startsWith(FACTORY_METHODS.predict) ? "0x" + "0".repeat(24) + "88".repeat(20) : "0x") };
const request = { quote: { id: "q", chain: "arbitrum-sepolia", asset: "ETH", amount: 1, size: 1 }, order, orderQuote: quote,
  counterparty: { proof: maker.side.proof, edPointClaimer: maker.spendPoint, viewHalfClaimer: "0x04", commitHalfClaimer: quote.commitHalfClaimer },
  recoveryKey: WORDS, receiveTo: "synthetic-xmr-destination", restoreHeight: 100, wallet,
  onRecoveryKey: async () => { asked += 1; return false; } };

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

const first = await createSwaps(deps).start(request).catch((e) => e.code || String(e));
const second = await createSwaps(deps).start(request).catch((e) => e.code || String(e));

if (first === "recovery-declined") ok("the first start refuses after a declined backup");
else bad("first start returned " + JSON.stringify(first));
if (second === "recovery-declined") ok("the second start asks for the backup again");
else bad("second start returned " + JSON.stringify(second));
if (asked === 2) ok("the person is asked on both starts");
else bad("backup prompts: " + asked);
if (sent.length === 0) ok("no funding transaction was sent");
else bad("funding was sent: " + sent.length);

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "backup confirmation: " + pass + " checks passed.");
if (fails.length) process.exit(1);
