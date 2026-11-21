// A FIRM REQUEST'S DEADLINES, FROM THE MAKER'S SIGNED WINDOW AND THE CHAIN'S CLOCK.
//
// The maker publishes `readyMinSeconds..readyMaxSeconds` and `settlementMinSeconds..settlementMaxSeconds`; the client
// must place `readyBy` and `t1` inside those ranges, not on their edges. The node later judges the request by its own
// clock, which is later than the chain block the card read, so the lower edge needs more room than the upper one.
import { SdkError } from "./errors.mjs";
import { readReadyWindow } from "./readyWindow.mjs";

export const READY_MARGIN_SEC = 150;
export const DEADLINE_MARGIN_SEC = 60;

const int = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};

const inside = (min, max, margin) => (max - min >= 2 * margin
  ? min + margin
  : min + Math.floor((max - min) / 2));

const readyInside = (min, max) => {
  const room = max - min;
  if (room < 2 * DEADLINE_MARGIN_SEC) return min + Math.floor(room / 2);
  return min + Math.min(READY_MARGIN_SEC, room - DEADLINE_MARGIN_SEC);
};

/**
 * Pick the one signed window for a market, side and Monero network. A missing or ambiguous match is a refusal, never
 * the first window on the list: two networks for the same market are a real case, and picking the wrong one changes
 * the order's Monero network.
 */
export function firmWindowFor({ features, side, market, xmrNetwork } = {}) {
  if (!features || typeof features !== "object") throw new SdkError("bad-input", { field: "features" });
  if (side !== "ask" && side !== "bid") throw new SdkError("bad-input", { field: "side" });
  if (typeof market !== "string" || !market) throw new SdkError("bad-input", { field: "market" });
  if (typeof xmrNetwork !== "string" || !xmrNetwork) throw new SdkError("bad-input", { field: "xmrNetwork" });
  if (!Array.isArray(features.firmWindows)) throw new SdkError("bad-input", { field: "features.firmWindows" });
  const matches = features.firmWindows.filter((entry) => entry && entry.market === market && entry.side === side
    && entry.xmrNetwork === xmrNetwork);
  if (matches.length !== 1) {
    throw new SdkError("bad-input", { field: "features.firmWindows",
      why: matches.length ? "duplicate-window" : "window", market, side, xmrNetwork });
  }
  return readReadyWindow(matches[0], { side, field: "features.firmWindows" });
}

/**
 * The deadlines for one signed window at the chain's `chainNow` (Unix seconds): `readyBy` and `t1`, in chain seconds.
 * The margins are the same ones the site used: 150 s from the lower readiness edge, 60 s from the upper readiness
 * edge and from both settlement edges.
 */
export function firmDeadlines(window, chainNow) {
  const ready = readReadyWindow(window);
  const now = int(chainNow);
  if (now === null || now <= 0) throw new SdkError("bad-input", { field: "chainNow" });
  const settleMin = int(ready.settlementMinSeconds);
  const settleMax = int(ready.settlementMaxSeconds);
  if (settleMin === null || settleMax === null || settleMin <= 0 || settleMax < settleMin) {
    throw new SdkError("bad-input", { field: "features.firmWindows", why: "settlement" });
  }
  const readyBy = now + readyInside(ready.readyMinSeconds, ready.readyMaxSeconds);
  const t1 = readyBy + inside(settleMin, settleMax, DEADLINE_MARGIN_SEC);
  if (!(t1 > readyBy)) throw new SdkError("bad-input", { field: "features.firmWindows", why: "deadlines" });
  return { readyBy, t1 };
}

/**
 * The firm-request builder: one window, selected by market, side and Monero network, and its deadlines on the chain
 * clock. The caller spreads `readyBy`/`t1` into the order it then gives to `quotes.firmRelay`.
 */
export function firmRequest({ features, side, market, xmrNetwork, chainNow } = {}) {
  const window = firmWindowFor({ features, side, market, xmrNetwork });
  return Object.freeze({
    market,
    side,
    xmrNetwork,
    window,
    ...firmDeadlines(window, chainNow),
  });
}
