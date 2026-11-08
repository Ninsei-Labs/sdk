// THE CLAIM TIP IS SIZED BY THE CLAIM, NOT BY THE MAKER'S MOOD.
//
// The helpers below survived the direct-quote removal and are still used by the relay path. Every refusal must be
// named, and a tip above the measured ceiling must not pass. `check-guard-teeth` removes the ceiling comparison
// and requires this check to redden.
import { claimPriorityFeeOfBlock, claimTipVerdict } from "../src/quotes.mjs";

export const claimTipCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  const baseFee = 100_000_000n;
  const priority = 2_000_000n;

  const explicit = claimPriorityFeeOfBlock({ baseFeePerGas: baseFee, priorityFeePerGas: priority });
  check(explicit === priority, "an explicit priority fee is not used as is");

  const derived = claimPriorityFeeOfBlock({ baseFeePerGas: baseFee, gasPrice: baseFee + priority });
  check(derived === priority, "a plain gasPrice is not reduced by the base fee");

  const missing = claimPriorityFeeOfBlock({ baseFeePerGas: baseFee });
  check(missing === 0n, "a block without a gas price did not fall back to zero priority");

  const zero = claimTipVerdict({ claimTipWei: 0 });
  check(zero.ok === true && zero.tipWei === "0", "a zero tip was refused without a block read");

  const unchecked = claimTipVerdict({ claimTipWei: 1n });
  check(unchecked.ok === false && unchecked.code === "quote-tip-unchecked",
    "a non-zero tip without a base fee was accepted or refused under the wrong code");

  const unreadable = claimTipVerdict({ claimTipWei: -1n, baseFeeWei: baseFee });
  check(unreadable.ok === false && unreadable.code === "quote-tip-unreadable",
    "a negative tip was accepted or refused under the wrong code");

  const accepted = claimTipVerdict({ claimTipWei: 1n, baseFeeWei: baseFee, priorityFeeWei: priority });
  check(accepted.ok === true && accepted.ceilingWei !== null, "a tip at the measured ceiling was refused");

  const ceiling = BigInt(accepted.ceilingWei || 0);
  const tooLarge = claimTipVerdict({ claimTipWei: ceiling + 1n, baseFeeWei: baseFee, priorityFeeWei: priority });
  check(tooLarge.ok === false && tooLarge.code === "quote-tip-too-large",
    "a tip above the measured ceiling was accepted");

  notes.push("the claim tip is bounded by the measured claim cost; a missing base fee and a too-large tip are named refusals");
  return { note: "the claim tip is bounded and its refusals are named", problems, notes };
};
