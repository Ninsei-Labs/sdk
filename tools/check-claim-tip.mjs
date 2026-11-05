// THE CLAIM TIP CHECK (sdk#18): a quote's tip is sized by the claim, and an unmeasured base fee is refused.
import { claimGasGiftWei } from "../engine/evm/claimGas.js";
import { claimPriorityFeeOfBlock, claimTipVerdict, createQuotes } from "../src/quotes.mjs";
import { readFileSync } from "node:fs";
import { SDK_VERSION } from "../src/version.mjs";
import { primitives } from "../src/primitives.mjs";
import { quoteDigest, signQuoteDigest } from "../src/quoteEip712Spec.mjs";
import { orderContextString } from "../engine/atomic/orderContext.js";

export const claimTipCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  const base = 100_000_000n;
  const estimate = claimGasGiftWei({ baseFeeWei: base });
  check(estimate !== null && estimate > 0n, "the estimate is not measurable");

  const zero = claimTipVerdict({ claimTipWei: 0 });
  check(zero.ok === true && zero.tipWei === "0", "a zero tip was refused");
  const atCeiling = claimTipVerdict({ claimTipWei: estimate * 2n, baseFeeWei: base });
  check(atCeiling.ok === true, "a tip at twice the estimate was refused");
  const over = claimTipVerdict({ claimTipWei: estimate * 2n + 1n, baseFeeWei: base });
  check(over.ok === false && over.code === "quote-tip-too-large", "a tip above twice the estimate was not refused");
  const unknown = claimTipVerdict({ claimTipWei: 1n, baseFeeWei: null });
  check(unknown.ok === false && unknown.code === "quote-tip-unchecked", "an unmeasured base fee was not refused");
  const unreadable = claimTipVerdict({ claimTipWei: "not-a-number", baseFeeWei: base });
  check(unreadable.ok === false && unreadable.code === "quote-tip-unreadable", "an unreadable tip was not refused");

  // THE PRIORITY FEE HAS ONE RULE FOR SALE, FIRM AND FIRMRELAY. An explicit field wins; a plain RPC block with only
  // gasPrice derives the priority above the base fee; an unreadable or absent pair means zero, never a guess.
  check(String(claimPriorityFeeOfBlock({ priorityFeePerGas: 7n })) === "7", "an explicit priority fee was not used");
  check(String(claimPriorityFeeOfBlock({ maxPriorityFeePerGas: 8n })) === "8", "maxPriorityFeePerGas was not used");
  check(String(claimPriorityFeeOfBlock({ baseFeePerGas: 10n, gasPrice: 15n })) === "5", "gasPrice did not yield the priority fee");
  check(String(claimPriorityFeeOfBlock({ baseFeePerGas: 10n, gasPrice: 8n })) === "0", "a gasPrice below base yielded a negative fee");
  check(String(claimPriorityFeeOfBlock({ baseFeePerGas: 10n })) === "0", "a missing priority field did not fall back to zero");
  // A SITE THAT FORGETS THE HELPER IS THE REGRESSION THIS GUARD EXISTS FOR. All three tip checks must call it; a
  // copy of the source is read here because the typed API cannot see which branch produced a quote.
  const quotesSource = readFileSync(new URL("../src/quotes.mjs", import.meta.url), "utf8");
  const helperCalls = (quotesSource.match(/priorityFeeOfBlock\(block\)/g) || []).length;
  check(helperCalls >= 3, "only " + helperCalls + " of the three tip checks use the shared priority-fee rule");

  // THE MAKER'S VIEW HALF TRAVELS TOP-LEVEL. A quote request built from the recovery key must not leave the node to
  // choose its own view half; the field is captured before the (deliberately refused) answer.
  const sent = [];
  const quotes = createQuotes({ config: { route: () => "/order-quote" },
    http: { async tryJson(_path, request) { sent.push(JSON.parse(request.body)); return { ok: false, body: { ok: false } }; } } });
  const half = "0x" + "07".repeat(32);
  await quotes.firm({ providerId: "p", order: { locker: "0x" + "11".repeat(20) }, viewHalfClaimer: half }).catch(() => null);
  await quotes.firm({ providerId: "p", order: { locker: "0x" + "11".repeat(20) } }).catch(() => null);
  check(sent[0] && sent[0].viewHalfClaimer === half, "the firm request did not carry the supplied view half");
  check(sent[0] && sent[0].sdkVersion === SDK_VERSION && sent[1] && sent[1].sdkVersion === SDK_VERSION,
    "the firm request did not carry the SDK version");
  check(sent[1] && !("viewHalfClaimer" in sent[1]), "a request without a view half gained one");

  // A SALE TICKET'S TIP IS CHECKED ON THE SIGNED FIGURE, WITH THE PRIORITY FEE. The node sizes the tip from gas price
  // (base plus priority); passing only the base fee used to refuse an honest L1 ticket.
  // THE TICKET IS A SIGNED QUOTE. The old fixture carried no signature and was accepted - that was the finding
  // this check now exercises. The signer is invented; the EIP-712 digest and recovery are production code.
  const signerKey = "0x" + "11".repeat(32);
  const signerPub = primitives.secp256k1.getPublicKey(Uint8Array.from(Buffer.from(signerKey.slice(2), "hex")), false);
  const quoteKey = "0x" + Buffer.from(primitives.keccak256(signerPub.slice(1))).subarray(12).toString("hex");
  const addr = (b) => "0x" + b.repeat(20);
  const nowSec = Math.floor(Date.now() / 1000);
  const quoteFor = (tipWei) => {
    const quote = { provider: addr("22"), quoteKey, registry: addr("55"), cashier: addr("66"),
      locker: addr("44"), claimer: addr("33"), amount: "1000000000000000000",
      readyBy: nowSec + 7200, t1: nowSec + 14400, salt: "0x" + "44".repeat(32),
      commitHalfClaimer: "0x" + "55".repeat(32), edPointClaimer: "0x" + "66".repeat(32),
      chainId: 421614, feeBps: "0", fee: "0", feeRecipient: addr("77"),
      validUntil: nowSec + 600, nonce: "1", xmrAmount: "1000000000000", factory: addr("88"),
      claimTip: String(tipWei), commitHalfLocker: "0x" + "a1".repeat(32),
      edPointLocker: "0x" + "a2".repeat(32), edViewPointLocker: "0x" + "a3".repeat(32) };
    quote.signature = signQuoteDigest({ crypto: primitives, digest: quoteDigest({ crypto: primitives, quote }), privateKey: signerKey });
    return quote;
  };
  const ticketFor = (tipWei) => ({ ok: true, claimTip: { wei: String(tipWei), signed: true },
    handoff: { quote: quoteFor(tipWei) } });
  const baseL1 = 500_000_000n;
  const priorityL1 = 1_500_000_000n;
  const l1Estimate = claimGasGiftWei({ baseFeeWei: baseL1, priorityFeeWei: priorityL1 });
  let currentQuote = null;
  let chainReads = 0;
  const saleBodies = [];
  const sale = (body, block = { baseFeePerGas: baseL1, gasPrice: baseL1 + priorityL1 }) => {
    currentQuote = body.handoff.quote;
    chainReads = 0;
    return createQuotes({
      config: { route: () => "/order-sell" }, http: { async tryJson(_path, request) { saleBodies.push(JSON.parse(request.body)); return { ok: true, body }; } },
      evmBlock: async () => block,
      evmCall: async () => "0x" + "0".repeat(24) + ((chainReads++ === 0 ? currentQuote.provider : currentQuote.factory).slice(2)),
    }).sale({ claimer: addr("33"), xmr: 1 });
  };
  const accepted = await sale(ticketFor(l1Estimate)).catch((error) => error);
  check(accepted && accepted.ok === true, "a ticket at the node's own L1 estimate was refused: " + (accepted && accepted.code));
  check(saleBodies[0] && saleBodies[0].sdkVersion === SDK_VERSION, "the sale request did not carry the SDK version");
  const tooLarge = await sale(ticketFor(l1Estimate * 2n + 1n)).catch((error) => error);
  check(tooLarge && tooLarge.code === "quote-tip-too-large", "a ticket above twice the L1 estimate was not refused");
  const mismatched = await sale({ ...ticketFor(l1Estimate), claimTip: { wei: String(l1Estimate + 1n), signed: true } })
    .catch((error) => error);
  check(mismatched && mismatched.code === "quote-refused" && mismatched.params && mismatched.params.why === "not-the-signed-tip",
    "a ticket whose shown tip differed from the signed one was not refused");

  // A DIRECT FIRM QUOTE TAKES THE SAME PRIORITY-AWARE TIP CHECK. The quote is signed with the real EIP-712 code; the
  // block carries only an explicit priority field, which is the case the old base-fee-only check refused.
  {
    const quote = quoteFor(l1Estimate);
    const order = {
      chainId: quote.chainId, factory: quote.factory, locker: quote.locker, claimer: quote.claimer,
      amount: quote.amount, readyBy: quote.readyBy, t1: quote.t1, salt: quote.salt,
    };
    quote.context = orderContextString(order);
    quote.signature = signQuoteDigest({ crypto: primitives, digest: quoteDigest({ crypto: primitives, quote }), privateKey: signerKey });
    const word = (address) => "0x" + "00".repeat(12) + address.replace(/^0x/, "");
    let chainCalls = 0;
    const direct = createQuotes({
      config: { route: () => "/order-quote" },
      http: { async tryJson() { return { ok: true, body: { ok: true, quote } }; } },
      evmBlock: async () => ({ baseFeePerGas: baseL1, priorityFeePerGas: priorityL1 }),
      evmCall: async () => (chainCalls++ === 0 ? word(quote.provider) : word(quote.factory)),
    });
    const acceptedFirm = await direct.firm({ providerId: "p", order }).catch((error) => error);
    check(acceptedFirm && acceptedFirm.provider === quote.provider,
      "a direct firm quote at the priority-aware estimate was refused: " + (acceptedFirm && acceptedFirm.code));
  }

  notes.push("a tip is bounded by twice the SDK's own estimate; zero and an unmeasured base fee behave");
  notes.push("the maker view half is sent with the firm request and is not invented when absent");
  notes.push("a sale ticket's signed tip is checked with the priority fee");
  return { note: "the claim tip is sized and refused before a quote is accepted", problems, notes };
};
