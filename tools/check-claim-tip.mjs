// THE CLAIM TIP CHECK (sdk#18): a quote's tip is sized by the claim, and an unmeasured base fee is refused.
import { claimGasGiftWei } from "../engine/evm/claimGas.js";
import { claimTipVerdict, createQuotes } from "../src/quotes.mjs";

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

  // THE MAKER'S VIEW HALF TRAVELS TOP-LEVEL. A quote request built from the recovery key must not leave the node to
  // choose its own view half; the field is captured before the (deliberately refused) answer.
  const sent = [];
  const quotes = createQuotes({ config: { route: () => "/order-quote" },
    http: { async tryJson(_path, request) { sent.push(JSON.parse(request.body)); return { ok: false, body: { ok: false } }; } } });
  const half = "0x" + "07".repeat(32);
  await quotes.firm({ providerId: "p", order: { locker: "0x" + "11".repeat(20) }, viewHalfClaimer: half }).catch(() => null);
  await quotes.firm({ providerId: "p", order: { locker: "0x" + "11".repeat(20) } }).catch(() => null);
  check(sent[0] && sent[0].viewHalfClaimer === half, "the firm request did not carry the supplied view half");
  check(sent[1] && !("viewHalfClaimer" in sent[1]), "a request without a view half gained one");

  notes.push("a tip is bounded by twice the SDK's own estimate; zero and an unmeasured base fee behave");
  notes.push("the maker view half is sent with the firm request and is not invented when absent");
  return { note: "the claim tip is sized and refused before a quote is accepted", problems, notes };
};
