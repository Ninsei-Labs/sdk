// THE CLAIM TIP CHECK (sdk#18): a quote's tip is sized by the claim, and an unmeasured base fee is refused.
import { claimGasGiftWei } from "../engine/evm/claimGas.js";
import { claimTipVerdict } from "../src/quotes.mjs";

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

  notes.push("a tip is bounded by twice the SDK's own estimate; zero and an unmeasured base fee behave");
  return { note: "the claim tip is sized and refused before a quote is accepted", problems, notes };
};
