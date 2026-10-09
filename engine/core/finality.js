// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/finality.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// STATE MATURITY PER NETWORK: at which level the chain treats a record as final.
// One value for all networks is wrong: on base `safe` is ~25 s, on arbitrum ~13 min (measured on live nodes).
// On bsc, monad and hyperevm the tags are FORMAL: they answer but lag 0-1 block, so reading by `finalized`
// looks like protection and gives none. A named numeric depth is used there instead.
// A twin table lives in the node; the two copies are pinned by a check.
// SCOPE: the table answers one question - when the EVM side is mature enough for an IRREVERSIBLE decision
// (send XMR). Displaying state on screen uses `latest` and is not limited by this.
export const FINALITY = {
  // A MEANINGFUL TAG: the lag is measured and named.
  "arbitrum-sepolia": { mode: "tag", tag: "safe", costSec: 520, reason: "tag is meaningful: lag ~8.6 min (measured)" },
  "arbitrum": { mode: "tag", tag: "safe", costSec: 760, reason: "tag is meaningful: lag ~12.6 min (measured)" },
  "mainnet": { mode: "tag", tag: "safe", costSec: 710, reason: "tag is meaningful: lag ~11.8 min (measured)" },
  "base": { mode: "tag", tag: "safe", costSec: 25, reason: "safe is both meaningful and fast: ~25 s (measured)" },

  // A FORMAL TAG: it answers, but there is no lag. A numeric depth with a named risk cost.
  "bsc": { mode: "depth", depth: 15, costSec: 7, reason: "tags are formal (lag 0-1 block, measured): the depth is CHOSEN, not measured - risk named" },
  "monad": { mode: "depth", depth: 12, costSec: 4, reason: "tags are formal (lag 0-1 block, measured): depth chosen" },
  "hyperevm": { mode: "depth", depth: 12, costSec: 12, reason: "tags are formal (lag 0-1 block, measured): depth chosen" },
};

// NETWORK NOT DESCRIBED - WE SAY SO, NOT PASTE SILENTLY. Depth 12 is the old common value and is more
// honest than a blank: a decision is made, but the risk cost is named as unmeasured.
export const DEFAULT_FINALITY = {
  mode: "depth", depth: 12, costSec: 0,
  reason: "network not described in the table: using the common depth, risk not measured",
};

export function finalityFor(network) {
  return FINALITY[network] || DEFAULT_FINALITY;
}

// How long this network makes us wait before an irreversible decision, in seconds. Whoever sets the swap
// windows (readyBy, t1) must add it: a window shorter than the wait kills the swap.
export function finalityWaitSec(network) {
  return Number(finalityFor(network).costSec || 0);
}

// WHAT TO TELL THE PERSON. A screen line: the level and the wait cost in words.
export function finalityNote(network) {
  const f = finalityFor(network);
  if (f.mode === "tag") {
    const min = Math.max(1, Math.round(f.costSec / 60));
    return "waiting for level " + f.tag + ": ~" + min + " min";
  }
  return "waiting for " + f.depth + " confirmations: ~" + Math.max(1, Math.round(f.costSec)) + " s";
}

// PROVIDER BADGE FOR THE LIST. Short: the person chooses whom to pick, and the wait cost is part of it.
// Our own measurement beats the provider's words: if its level is a tag, we take the measured cost from the table.
export function finalityBadge(policy) {
  if (!policy) return "finality not stated";
  if (policy.mode === "tag") {
    const known = Object.values(FINALITY).find((f) => f.mode === "tag" && f.tag === policy.tag);
    const cost = Number(policy.costSec || (known && known.costSec) || 0);
    return cost >= 60 ? policy.tag + " · ~" + Math.round(cost / 60) + " min" : policy.tag + " · ~" + Math.round(cost) + " s";
  }
  const d = Number(policy.depth || 0);
  const cost = Number(policy.costSec || d * (FINALITY[Object.keys(FINALITY)[0]] ? 0.3 : 0.3) || 0);
  return d + " blocks · ~" + Math.max(1, Math.round(cost)) + " s";
}

// ORDER WINDOWS BY PROVIDER LEVEL. A window shorter than the wait kills the swap: the readiness mark cannot
// reach the contract in time and the swap falls apart, so the windows are derived from the wait cost.
// The numbers are the owner's decision: on a BUY the readiness window is 4 hours and the claim window AFTER
// readyBy is 1 hour - the formula below keeps exactly that: claim one hour after ready. On a sell the node sets the deadlines.
export function orderWindows(policy, base = { readyWindowSeconds: 14400, claimWindowSeconds: 3600 }) {
  const wait = Number((policy && policy.costSec) || 0);
  const ready = Math.max(base.readyWindowSeconds, wait + 900);         // margin for the deposit and tx travel
  return { readyWindowSeconds: ready, claimWindowSeconds: Math.max(base.claimWindowSeconds, ready + 3600) };
}
