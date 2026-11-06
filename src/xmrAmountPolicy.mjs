// THE XMR AMOUNT A QUOTE MAY SIGN FOR A REQUESTED AMOUNT.
//
// The provider's signed `xmrAmount` is allowed to be BETTER for the client than the requested figure, never worse:
//   ask - the client buys XMR, so the provider may sign at least the requested amount;
//   bid - the client sells XMR, so the provider may sign at most the requested amount.
// The ETH side stays exact and is checked separately by both callers: it is part of the proof context, not a
// price that may move with the XMR amount.
//
// A value that cannot be read, a negative value and an unknown side are all refused. Returning a boolean here would
// turn "unreadable" into "equal", so the verdict names the reason.
export function xmrAmountVerdict({ side, requested, signed } = {}) {
  const parse = (value) => {
    if (value === undefined || value === null || value === "") return null;
    try {
      const amount = BigInt(String(value));
      return amount >= 0n ? amount : null;
    } catch {
      return null;
    }
  };
  const want = parse(requested);
  const got = parse(signed);
  if (want === null || got === null) return { ok: false, reason: "unreadable" };
  if (side === "ask") {
    return got >= want
      ? { ok: true, side, requested: want.toString(), signed: got.toString() }
      : { ok: false, reason: "worse", side, requested: want.toString(), signed: got.toString() };
  }
  if (side === "bid") {
    return got <= want
      ? { ok: true, side, requested: want.toString(), signed: got.toString() }
      : { ok: false, reason: "worse", side, requested: want.toString(), signed: got.toString() };
  }
  return { ok: false, reason: "side" };
}
