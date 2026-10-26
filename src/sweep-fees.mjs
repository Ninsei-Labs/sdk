// THE FEE OF A WITHDRAWAL IS THE SUM OF EVERY SIGNED TRANSACTION, not the first one.
//
// A sweep normally signs one transaction, but the wallet may split the inputs: every transaction pays its own fee
// and the relay sends all of them. Showing only the first fee understates what leaves, and subtracting only it
// overstates what the recipient receives.
//
// The answer is null when any signed transaction cannot report a fee: a partial total would be a claim the wallet
// did not make.
export function signedFeeTotal(signed) {
  const list = Array.isArray(signed) ? signed : [signed];
  if (!list.length) return null;
  let total = 0n;
  for (const tx of list) {
    if (!tx || typeof tx.getFee !== "function") return null;
    let value;
    try {
      value = tx.getFee();
    } catch {
      return null;
    }
    if (value === null || value === undefined) return null;
    let amount;
    try {
      amount = BigInt(value);
    } catch {
      return null;
    }
    if (amount < 0n) return null;
    total += amount;
  }
  return total.toString();
}
