// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/preSignGuards.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// PRE-SIGNING GUARDS: AN INADMISSIBLE DEAL DOES NOT START.
//
// WHY A SEPARATE MODULE. The guards used to live apart: one in the route registry (the DEX leg's coverage and
// price), the rest scattered across the form and the order flow. That breeds exactly the defect this file exists
// for: the rule is there but the signature does not stop, because the screen never asked. Here the rules sit in
// ONE place with ONE answer shape, and the summary (signingGateVerdict) answers the only question that matters:
// start the signature or not.
//
// WHAT AN ANSWER MEANS. Every verdict carries three fields of different meaning:
//   blocks  - signing is NOT ALLOWED (the guard itself; the caller MUST honour this field);
//   checked - whether the check could be performed at all (true/false);
//   reason  - words, and they carry NUMBERS: a person needs not "no" but "no, because this much".
// Telling checked from blocks is mandatory; two examples from this file show why:
//
//   * AN UNCHECKED BALANCE BLOCKS. Reading a balance always works here, so "could not read" means "we do not
//     know whether there is enough money for what the person is about to sign". Skipping it would send the person
//     to sign a wallet refusal.
//   * AN UNMEASURED GAS RESERVE DOES NOT BLOCK, AND THAT IS A DECISION, NOT AN OVERSIGHT. Unlike the DEX price
//     check: a bad price means the deal is WRONG, while an unmeasured gas figure only means "the reserve is
//     unknown". The deal does not become inadmissible, and a wallet will name a shortfall anyway. So this case is
//     marked (checked: false, kind reserve-unstated) and does NOT lock the signature.
//   * A SIZE RANGE THE PROVIDER DID NOT NAME - SAME THING: marked, not blocking (the market already decided:
//     "no size named - nothing to cap", see coversSize in the mock market module).
//
// ONE MORE THING THAT IS FUNDAMENTAL HERE. All verdicts are PURE functions: no network, no wallet, no DOM. So
// each guard can be run against the numbers that BREAK it and be seen red: "the code is there" is not "the
// refusal works".
//
// THE THRESHOLDS COME IN AS DATA (the registry: SIGNING_GUARDS in core/config.js), not as numbers here: changing
// them is a data edit, not a logic edit.

// wei from whatever the caller supplied (BigInt, string, number). Unparsable - null, and that is NOT zero: a zero
// balance and an unknown balance are two different states and must not be confused.
const wei = (v) => {
  if (v === null || v === undefined || v === "") return null;
  try { const n = BigInt(v); return n >= 0n ? n : null; } catch { return null; }
};
// A QUANTITY IN HUMAN FORM - SEPARATE FROM wei. The swap size and the range bounds arrive ALREADY human (ASSET
// units of the pair), not wei, so there is nothing to divide by 10^decimals: a shared function would put numbers
// into the refusal that differ from the real ones by a factor of 10^14 - a confident but wrong answer.
const qty = (v) => String(Number(Number(v).toFixed(4)));
const finite = (v) => (v === null || v === undefined || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
// A number in human form for the words: six decimals suit both a stable and a native, and nobody reads full wei
// in text.
const human = (v, decimals = 18) => {
  const n = Number(v) / 10 ** Number(decimals);
  if (!Number.isFinite(n)) return String(v);
  return String(Number(n.toFixed(6)));
};

// ---------------------------------------------------------------------------
// 1) SIZE AGAINST THE QUOTE RANGE. The range is the provider's (min/max/step) and it will not take a size outside
// it: a size out of range is a REFUSAL, not a "let us try", and it must happen BEFORE the signature, not at the
// provider after it.
// THE UNIT IS PART OF THE CHECK, NOT DECORATION: the size and the bounds must be in ONE unit (the ASSET of the
// pair), else different quantities are compared and "in range" means nothing.
// ---------------------------------------------------------------------------
export function rangeVerdict({ size = null, unit = null, min = null, max = null, step = null, quoteUnit = null } = {}) {
  const u = String(unit || quoteUnit || "").toUpperCase();
  const statedUnit = String(quoteUnit || "").toUpperCase();
  if (statedUnit && u && statedUnit !== u) {
    return {
      ok: false, checked: true, blocks: true, kind: "unit-mismatch",
      reason: `the size is measured in ${u} while the quote states its range in ${statedUnit} - the two cannot be compared`,
      size, min, max, step, unit: u, quoteUnit: statedUnit,
    };
  }
  const s = finite(size);
  if (s === null || s <= 0) {
    return {
      ok: false, checked: false, blocks: false, kind: "size-unstated",
      reason: "the size is not entered, so the provider's range cannot be checked",
      size: null, min: finite(min), max: finite(max), step: finite(step), unit: u,
    };
  }
  const lo = finite(min), hi = finite(max), st = finite(step);
  if (lo === null && hi === null) {
    // The provider named no bounds - that is its word, not our error: mark it and do not block.
    return {
      ok: true, checked: false, blocks: false, kind: "range-unstated",
      reason: "the provider did not state a volume range (min/max), so the size could not be checked against it",
      size: s, min: null, max: null, step: st, unit: u,
    };
  }
  const base = { size: s, min: lo, max: hi, step: st, unit: u, quoteUnit: statedUnit || u };
  if (lo !== null && s < lo) {
    return { ok: false, checked: true, blocks: true, kind: "below-min", ...base,
      reason: `the order size ${qty(s)} ${u} is below the provider minimum ${qty(lo)} ${u} - short by ${qty(lo - s)} ${u}: the provider does not take this size` };
  }
  if (hi !== null && s > hi) {
    return { ok: false, checked: true, blocks: true, kind: "above-max", ...base,
      reason: `the order size ${qty(s)} ${u} is above the provider maximum ${qty(hi)} ${u} - over by ${qty(s - hi)} ${u}: the provider does not take this size` };
  }
  if (st !== null && st > 0) {
    // The step is counted FROM min, not from zero: min=0.05 with step 0.1 yields no further size, and that is the
    // market rule, not an invention of this function.
    const from = lo !== null ? lo : 0;
    const grid = (s - from) / st;
    if (Math.abs(grid - Math.round(grid)) > 1e-6) {
      return { ok: false, checked: true, blocks: true, kind: "off-step", ...base,
        reason: `the order size ${qty(s)} ${u} does not sit on the ${qty(st)} ${u} step from ${qty(from)} ${u}` };
    }
  }
  return { ok: true, checked: true, blocks: false, kind: "in-range", ...base,
    reason: `the order size ${qty(s)} ${u} is inside the provider range ${lo === null ? "?" : qty(lo)}..${hi === null ? "?" : qty(hi)} ${u}` };
}

// ---------------------------------------------------------------------------
// 2) PAYMENT BALANCE. Not enough of what pays - there is nothing to sign: the transaction would fail in the
// wallet and the person would learn of the shortfall AFTER signing. An unknown balance (not read) also locks: see
// the reasoning in the header.
// ---------------------------------------------------------------------------
export function payBalanceVerdict({ payBalanceWei = null, payAmountWei = null, symbol = null, decimals = 18 } = {}) {
  const have = wei(payBalanceWei);
  const need = wei(payAmountWei);
  if (need === null || need <= 0n) {
    return { ok: false, checked: false, blocks: false, kind: "amount-unstated",
      reason: "the amount to fund is not known, so the wallet balance cannot be checked against it" };
  }
  if (have === null) {
    return { ok: false, checked: false, blocks: true, kind: "balance-unchecked",
      reason: "the wallet balance was not read, so it is unknown whether the wallet covers the order - signing is blocked" };
  }
  if (have < need) {
    return { ok: false, checked: true, blocks: true, kind: "balance-short",
      haveWei: have.toString(), needWei: need.toString(), shortfallWei: (need - have).toString(),
      reason: `the wallet holds ${human(have, decimals)} ${symbol} but the order locks ${human(need, decimals)} ${symbol} - short by ${human(need - have, decimals)} ${symbol}` };
  }
  return { ok: true, checked: true, blocks: false, kind: "balance-enough",
    haveWei: have.toString(), needWei: need.toString(),
    reason: `the wallet holds ${human(have, decimals)} ${symbol} for the order's ${human(need, decimals)} ${symbol}` };
}

// ---------------------------------------------------------------------------
// 3) GAS RESERVE. Funding is a transaction and costs gas in the NATIVE coin, so both the order amount and the
// order amount PLUS the reserve are checked: an account holding exactly `amount` will not pass. The required value
// is computed by the caller (amount + reserve), not here: one quantity instead of two branches - less room to
// diverge.
// An unmeasured reserve does NOT lock: see the header (the difference from the price check is deliberate).
// ---------------------------------------------------------------------------
export function gasReserveVerdict({ nativeBalanceWei = null, requiredNativeWei = null, gasReserveWei = null, symbol = null, decimals = 18 } = {}) {
  const need = wei(requiredNativeWei);
  const reserve = wei(gasReserveWei);
  const have = wei(nativeBalanceWei);
  if (reserve === null || reserve <= 0n) {
    return { ok: true, checked: false, blocks: false, kind: "reserve-unstated",
      reason: "the gas reserve was not measured, so the gas part of the funding could not be checked (the wallet will name any shortfall)" };
  }
  if (need === null) {
    return { ok: false, checked: false, blocks: false, kind: "amount-unstated", reserveWei: reserve.toString(),
      reason: "the amount to fund is not known, so the native balance cannot be checked against amount + gas" };
  }
  if (have === null) {
    return { ok: false, checked: false, blocks: true, kind: "native-unchecked", needWei: need.toString(), reserveWei: reserve.toString(),
      reason: "the native balance was not read, so it is unknown whether the wallet covers amount + gas - signing is blocked" };
  }
  const total = need + reserve;
  if (have < total) {
    return { ok: false, checked: true, blocks: true, kind: "gas-short",
      haveWei: have.toString(), needWei: need.toString(), reserveWei: reserve.toString(), requiredTotalWei: total.toString(),
      shortfallWei: (total - have).toString(),
      reason: `funding needs ${human(need, decimals)} ${symbol} plus ${human(reserve, decimals)} ${symbol} of gas, but the wallet holds ${human(have, decimals)} ${symbol} - short by ${human(total - have, decimals)} ${symbol}` };
  }
  return { ok: true, checked: true, blocks: false, kind: "gas-enough",
    haveWei: have.toString(), needWei: need.toString(), reserveWei: reserve.toString(), requiredTotalWei: total.toString(),
    reason: `the wallet holds ${human(have, decimals)} ${symbol}: ${human(need, decimals)} for the order and ${human(reserve, decimals)} for gas` };
}

// ---------------------------------------------------------------------------
// 4) QUOTE FRESHNESS. Product rule: nobody shows a stale quote (older than its own ttlMs) and it cannot be signed
// - the price in it is no longer what the person sees. The age is computed from the quote's OWN timestamp (at),
// not from the response time: otherwise the age would be rejuvenated by every poll.
// No timestamp or no ttl - nothing to check; that is marked and does not block (the market decided the same:
// "the provider named no quote ttl" on screen, not a closed market).
// ---------------------------------------------------------------------------
export function quoteFreshnessVerdict({ at = null, ttlMs = null, expiresAt = null, nowMs = null } = {}) {
  const now = finite(nowMs) === null ? Date.now() : Number(nowMs);
  const exp = finite(expiresAt);
  if (exp !== null && exp <= now) {
    return { ok: false, checked: true, blocks: true, kind: "expired", expiresAt: exp, nowMs: now,
      reason: `the order quote expired ${Math.round((now - exp) / 1000)}s ago` };
  }
  const stamp = finite(at);
  if (stamp === null) {
    return { ok: false, checked: false, blocks: false, kind: "untimed",
      reason: "the quote carries no timestamp, so its age could not be checked" };
  }
  const ttl = finite(ttlMs);
  const ageMs = Math.max(0, now - stamp);
  if (ttl === null || ttl <= 0) {
    return { ok: true, checked: false, blocks: false, kind: "no-ttl", at: stamp, ageMs,
      reason: `the provider did not state how long the quote lives, so only its age is known: said ${Math.round(ageMs / 1000)}s ago` };
  }
  if (ageMs > ttl) {
    return { ok: false, checked: true, blocks: true, kind: "stale", at: stamp, ttlMs: ttl, ageMs,
      overMs: ageMs - ttl,
      reason: `the quote is ${Math.round(ageMs / 1000)}s old while it was valid for ${Math.round(ttl / 1000)}s - it expired ${Math.round((ageMs - ttl) / 1000)}s ago` };
  }
  return { ok: true, checked: true, blocks: false, kind: "fresh", at: stamp, ttlMs: ttl, ageMs,
    reason: `the quote is ${Math.round(ageMs / 1000)}s old and valid for ${Math.round(ttl / 1000)}s` };
}

// ---------------------------------------------------------------------------
// 5) ORDER DEADLINES (readyBy / t1). A deadline in the past means an order created already closed: nothing can be
// claimed, the money hangs until refund. Deadlines that are too tight mean the same, but invisibly: the readiness
// window is shorter than the XMR confirmation itself, and the settlement window shorter than the maker needs to
// claim. A deadline too far off is the third extreme: ETH can be returned only before `readyBy` and after `t1`, so
// an order with `t1` a year away locks the money for a year. Hence the ceiling. The thresholds are data.
// ---------------------------------------------------------------------------
export function deadlineVerdict({ nowSec = null, readyBy = null, t1 = null, minReadyLeadSec = null, minClaimWindowSec = null, maxDeadlineSec = null } = {}) {
  const now = finite(nowSec) === null ? Math.floor(Date.now() / 1000) : Number(nowSec);
  const r = finite(readyBy), c = finite(t1);
  if (r === null || c === null) {
    return { ok: false, checked: false, blocks: true, kind: "deadlines-unstated",
      reason: "the order's deadlines are not stated, so neither the ready window nor the claim window can be checked - signing is blocked" };
  }
  if (r <= now) {
    return { ok: false, checked: true, blocks: true, kind: "ready-by-in-past", readyBy: r, nowSec: now,
      reason: `the order would be created already past its ready-by deadline (${r} is ${Math.round(now - r)}s ago): nothing could be claimed in it` };
  }
  if (c <= r) {
    return { ok: false, checked: true, blocks: true, kind: "t1-not-after-ready-by", readyBy: r, t1: c,
      reason: `t1 (${c}) must be later than readyBy (${r}): an overlapping window lets claim and refund both be valid at once` };
  }
  const lead = finite(minReadyLeadSec), claim = finite(minClaimWindowSec);
  if (lead !== null && r - now < lead) {
    return { ok: false, checked: true, blocks: true, kind: "ready-window-too-short", readyBy: r, nowSec: now, minReadyLeadSec: lead,
      reason: `the ready-by deadline is only ${Math.round(r - now)}s away while the mark-ready window needs at least ${lead}s - XMR confirmations alone take minutes` };
  }
  if (claim !== null && c - r < claim) {
    return { ok: false, checked: true, blocks: true, kind: "claim-window-too-short", readyBy: r, t1: c, minClaimWindowSec: claim,
      reason: `the claim window is ${Math.round(c - r)}s while at least ${claim}s is needed to take the funds before the refund opens` };
  }
  // THE DEADLINE CEILING. Without it a deadline can be set a year ahead: both sides sign, the ETH goes into the
  // escrow and cannot be returned before `readyBy` or after `t1` - a whole year. The ceiling is computed from `t1`
  // (the farthest deadline): `readyBy` is always nearer, so this check covers both.
  const cap = finite(maxDeadlineSec);
  if (cap !== null && c - now > cap) {
    return { ok: false, checked: true, blocks: true, kind: "deadline-too-far", readyBy: r, t1: c, nowSec: now, maxDeadlineSec: cap,
      reason: `the order's deadline is ${Math.round(c - now)}s (${Math.round((c - now) / 3600)}h) away while at most ${cap}s (${Math.round(cap / 3600)}h) is allowed: a deposit locked that long could not be refunded until t1` };
  }
  return { ok: true, checked: true, blocks: false, kind: "deadlines-ok", readyBy: r, t1: c, nowSec: now,
    reason: `ready in ${Math.round(r - now)}s, claim window ${Math.round(c - r)}s` };
}

// ---------------------------------------------------------------------------
// 6) ESCROW STATE. The contract forbids a second deposit (AlreadyFunded) and does not allow claiming twice, so
// "signing again" at an already funded, claimed or refunded escrow is not a "just in case" check: the second
// signature either reverts or creates a SECOND order instead of the old one. Read by calling status() at the
// predicted address - before signing.
// About an empty answer: for an address that does not exist yet eth_call returns empty - that is "a new order",
// not "the check failed". A call error is another matter, and it locks.
// ---------------------------------------------------------------------------
export function escrowStateVerdict({ status = null, error = null, address = null } = {}) {
  const where = address ? " the escrow at " + address : " the escrow";
  if (error) {
    return { ok: false, checked: false, blocks: true, kind: "state-unchecked", error: String(error),
      reason: `the state of${where} could not be read (${String(error)}), so it is unknown whether this order already exists - signing is blocked` };
  }
  if (!status) {
    return { ok: true, checked: true, blocks: false, kind: "new", address: address || null,
      reason: address ? `no escrow exists at ${address} yet: this is a new order` : "no escrow exists yet: this is a new order" };
  }
  if (status.isClaimed) {
    return { ok: false, checked: true, blocks: true, kind: "already-claimed", status, address: address || null,
      reason: `${where} is already claimed: the order is settled, a new signature would create a second order` };
  }
  if (status.isRefunded) {
    return { ok: false, checked: true, blocks: true, kind: "already-refunded", status, address: address || null,
      reason: `${where} was already refunded: the order is closed, a new signature would create a second order` };
  }
  if (status.isFunded) {
    return { ok: false, checked: true, blocks: true, kind: "already-funded", status, address: address || null,
      reason: `${where} is already funded: the contract refuses a second funding (AlreadyFunded) - top up that order instead of signing a new one` };
  }
  return { ok: true, checked: true, blocks: false, kind: "new", status, address: address || null,
    reason: `${where} exists but holds nothing: this is a new order` };
}

// ---------------------------------------------------------------------------
// 7) ERC-20 CONSENT. It will arrive with DEX-leg execution: swapping a token requires approve, and permission to
// spend is a SEPARATE action of the person, not a consequence of signing the swap. So there are two checks, both
// mandatory: the allowance is granted (enough) AND the person explicitly consented. Enough without consent and
// consent without enough are different refusals, named differently.
// THIS GUARD ALREADY HAS A CONSUMER: the DEX-leg execution builder (swapAllowanceVerdict) calls it to tell
// "allowance short" from "the person did not consent" - different refusals, named differently. It is still NOT
// part of the form's signature: the form does not swap yet (the swap is a paid stage), and adding the check to the
// signature before the action exists would lock a person on something he does not yet do.
// ---------------------------------------------------------------------------
export function allowanceVerdict({ tokenIsNative = false, allowanceWei = null, amountWei = null, consent = false, symbol = null, decimals = 18 } = {}) {
  if (tokenIsNative) {
    return { ok: true, checked: true, blocks: false, kind: "not-needed",
      reason: "the payment is the network's own coin: no ERC-20 approval and no pool are involved" };
  }
  const need = wei(amountWei), have = wei(allowanceWei);
  if (consent !== true) {
    return { ok: false, checked: false, blocks: true, kind: "consent-missing", needWei: need === null ? null : need.toString(),
      reason: `swapping ${symbol || "the token"} needs an ERC-20 approval for you to sign, and no consent was given for it` };
  }
  if (have === null) {
    return { ok: false, checked: false, blocks: true, kind: "allowance-unchecked",
      reason: `the existing allowance for ${symbol || "the token"} was not read, so it is unknown whether the approval is needed - signing is blocked` };
  }
  if (need === null || need <= 0n) {
    return { ok: false, checked: false, blocks: false, kind: "amount-unstated",
      reason: "the amount to swap is not known, so the allowance cannot be checked against it" };
  }
  if (have < need) {
    return { ok: false, checked: true, blocks: true, kind: "allowance-short",
      allowanceWei: have.toString(), needWei: need.toString(),
      reason: `the approved amount is ${human(have, decimals)} ${symbol || ""} but the swap spends ${human(need, decimals)} ${symbol || ""}: the approval must be raised first` };
  }
  return { ok: true, checked: true, blocks: false, kind: "allowed",
    allowanceWei: have.toString(), needWei: need.toString(),
    reason: `the approved amount ${human(have, decimals)} ${symbol || ""} covers the swap of ${human(need, decimals)} ${symbol || ""}` };
}

// ---------------------------------------------------------------------------
// 8) WALLET NETWORK. Balances are read through the wallet, i.e. FROM ITS NETWORK, and the transaction goes there
// too. So a network mismatch is a refusal, not a warning: "page on one network, wallet on another" means we know
// neither the balances nor where the money goes. The wallet's network marker comes from the session (chainIdOf),
// the settlement network marker from the registry (chainId of the selected network).
// ---------------------------------------------------------------------------
export function networkGateVerdict({ walletChainId = null, selectedChainId = null, settlementChainId = null, selectedChainName = null } = {}) {
  const w = finite(walletChainId), s = finite(selectedChainId), set = finite(settlementChainId);
  if (w === null) {
    return { ok: false, checked: false, blocks: true, kind: "wallet-unknown",
      reason: "the wallet's network is unknown, so balances and the funding transaction have no network - signing is blocked" };
  }
  if (s === null) {
    return { ok: false, checked: false, blocks: true, kind: "network-unknown",
      reason: "the page's settlement network is unknown, so it cannot be compared with the wallet's - signing is blocked" };
  }
  if (w !== s) {
    return { ok: false, checked: true, blocks: true, kind: "wallet-network", walletChainId: w, selectedChainId: s,
      reason: `the wallet is on chain ${w} while this page settles on chain ${s}${selectedChainName ? " (" + selectedChainName + ")" : ""}: balances and the funding transaction would come from another network` };
  }
  if (set !== null && set !== s) {
    return { ok: false, checked: true, blocks: true, kind: "settlement-network", walletChainId: w, selectedChainId: s, settlementChainId: set,
      reason: `the escrow contract sits on chain ${set} while the page is set to chain ${s}: the money would go to a network where this order's escrow does not exist` };
  }
  return { ok: true, checked: true, blocks: false, kind: "network-match", chainId: s,
    reason: `the wallet and the page agree on chain ${s}${selectedChainName ? " (" + selectedChainName + ")" : ""}` };
}

// ---------------------------------------------------------------------------
// THE SUMMARY. The caller assembles what it has and gets ONE answer: whether the signature may start. The order
// of checks is set by the order of the array: the first cause in the list is named, because with a wrong network
// the question of size coverage no longer matters.
// ---------------------------------------------------------------------------
// A LIVE NETWORK DOES NOT SIGN A DEAL WITH A STAND-IN. In the demo the counterparty side is assembled locally and
// marked standIn: then DLEQ is checked against itself and proves nothing - a showcase mode, not a deal. On a live
// network there must be no such signature: the money would go against a party that does not exist.
export function counterpartyVerdict({ standIn = false, liveChain = false, network = null, chainId = null } = {}) {
  const v = (ok, kind, words) => ({ ok, checked: true, blocks: !ok, kind, words, reason: words });
  // THE NETWORK IS NAMED BY NUMBER AND CODE, not by the word "live": a refusal must show which network is meant
  // (one node can serve several), and that is the same standard as elsewhere - a cause without a number is a
  // defect, because it leaves no way to understand what happened.
  const where = (network || "this network") + (chainId === null || chainId === undefined ? "" : " (chainId " + chainId + ")");
  if (!standIn) return v(true, "real-provider", "counterparty is a real provider: the proof is checked against it");
  if (liveChain) {
    return v(false, "standin-on-production",
      `${where} is a live network and the counterparty is a local stand-in: the proof would be checked against itself, so the signature stays locked until a real provider answers`);
  }
  return v(true, "standin-on-testnet", `demo mode: the counterparty is a local stand-in and ${where} is a testnet (not a live network), the proof proves nothing by itself`);
}


// ---------------------------------------------------------------------------
// 9) ORDER POINTS ON CHAIN AGAINST THE POINTS DLEQ AGREED ON (an audit finding). DLEQ proves a point's link to a
// half, but by itself does not stop OTHER points from going into the order: the proof would hold for one set while
// createOrderAndFund gets another - and after claim the XMR sweep would not assemble, because the spend key is
// derived from other halves. The chain cannot check this (EVM has no ed25519), so the side that risks checks it,
// BEFORE acting. Here only the question "is the signature locked" is decided; the comparison takes the points
// FROM THE LIVE ESCROW SLOTS, not from form memory.
// ---------------------------------------------------------------------------
const normHex = (v) => (v === null || v === undefined ? "" : String(v).replace(/^0x/i, "").toLowerCase());
export function escrowPointsVerdict({ role = null, what = null, point = null, onchainPoint = null, commit = null, onchainCommit = null, readError = null } = {}) {
  const who = what || (role ? "the " + role + " point" : "the point");
  if (readError) {
    return { ok: false, checked: false, blocks: true, kind: "points-unchecked",
      reason: `${who} of the live escrow could not be read (${String(readError)}): whether the order holds the points that DLEQ proved is unknown - signing is blocked` };
  }
  // THE BRANCH IS CHOSEN BY WHAT IS ASKED TO BE COMPARED. The order of checks here is not cosmetic: if the
  // commitment is asked about while the point is checked first, a missing POINT makes the verdict say "points not
  // read" and the real cause (a wrong commitment) goes unnamed - already caught by a tooth.
  let compared = false;
  if (normHex(point)) {
    compared = true;
    if (!normHex(onchainPoint)) {
      return { ok: false, checked: false, blocks: true, kind: "points-unchecked",
        reason: `the live escrow did not return ${who}: the order may hold different points than the proof proved - signing is blocked` };
    }
    if (normHex(point) !== normHex(onchainPoint)) {
      return { ok: false, checked: true, blocks: true, kind: "point-mismatch",
        reason: `${who} in the escrow (0x${normHex(onchainPoint)}) is NOT the point DLEQ proved (0x${normHex(point)}): the Monero address would be assembled from other halves and the XMR could not be swept after claim` };
    }
  }
  // BOTH FIELDS ARE COMPARED INDEPENDENTLY. An "else" branch here was a bug: when the point matched, a commitment
  // divergence simply went unchecked and a swapped half slipped past the verdict. Caught by a tooth.
  if (normHex(commit)) {
    compared = true;
    if (!normHex(onchainCommit)) {
      return { ok: false, checked: false, blocks: true, kind: "points-unchecked",
        reason: `the live escrow did not return ${who}: the order may hold a different half than we do - signing is blocked` };
    }
    if (normHex(commit) !== normHex(onchainCommit)) {
      return { ok: false, checked: true, blocks: true, kind: "commit-mismatch",
        reason: `${who} in the escrow (0x${normHex(onchainCommit)}) is NOT the one we hold (0x${normHex(commit)}): the reveal would not match the order` };
    }
  }
  if (!compared) {
    return { ok: false, checked: false, blocks: true, kind: "points-unchecked",
      reason: `nothing to compare for ${who}: neither a point nor a commitment was recorded - signing is blocked` };
  }
  return { ok: true, checked: true, blocks: false, kind: "points-match",
    reason: `${who} in the escrow matches what we hold${normHex(point) && normHex(commit) ? " (point and commitment)" : ""}` };
}

// LIVE ORDER SLOTS AGAINST WHAT THE PAGE ASSEMBLED. One question, four answers: the points of both sides and the
// commitments to both halves. EVERY field we have is compared, and a field missing on chain locks just like a
// mismatch. Built from the same primitive as the single point check (escrowPointsVerdict), so refusals and
// comparison rules are one for all.
export function liveOrderSlotsVerdict({ slots = null, expect = null, readError = null } = {}) {
  if (readError || !slots) {
    return { ok: false, checked: false, blocks: true, kind: "slots-unchecked",
      reason: `the live escrow slots could not be read (${String(readError || "no answer")}): whether the order holds the points and halves we assembled is unknown - signing is blocked` };
  }
  const fields = [
    ["edPointLocker", "the locker spend point", "point"],
    ["edPointClaimer", "the claimer spend point", "point"],
    ["edViewPointLocker", "the locker view point", "point"],
    ["commitHalfLocker", "the commitment of the locker half", "commit"],
    ["commitHalfClaimer", "the commitment of the claimer half", "commit"],
  ];
  const checked = [];
  const missing = [];
  for (const [key, what, kind] of fields) {
    if (!normHex(expect && expect[key])) continue;   // what we do not have we do not compare - and that is named below
    if (!normHex(slots[key])) { missing.push(what); continue; }
    const v = kind === "point"
      ? escrowPointsVerdict({ what, point: expect[key], onchainPoint: slots[key] })
      : escrowPointsVerdict({ what, commit: expect[key], onchainCommit: slots[key] });
    if (v.blocks) return { ...v, fields: checked.concat([key]) };
    checked.push(key);
  }
  if (!checked.length) {
    return { ok: false, checked: false, blocks: true, kind: "slots-unchecked",
      reason: "nothing to compare: the app recorded neither a point nor a commitment for this order - signing is blocked" };
  }
  if (missing.length) {
    return { ok: false, checked: true, blocks: true, kind: "slots-unchecked",
      reason: `the live escrow did not return ${missing.join(", ")}: the order may differ from what was proved - signing is blocked` };
  }
  return { ok: true, checked: true, blocks: false, kind: "slots-match", fields: checked,
    reason: `the live escrow holds exactly what we assembled: ${checked.join(", ")}` };
}

export function signingGateVerdict(checks = []) {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && typeof c === "object");
  const blocking = list.filter((c) => c.blocks === true);
  const unchecked = list.filter((c) => c.blocks !== true && c.checked === false);
  return {
    ok: blocking.length === 0,
    blocked: blocking.length > 0,
    kind: blocking.length ? blocking[0].kind : (list.length ? list[list.length - 1].kind : "nothing-to-check"),
    reason: blocking.length ? blocking.map((c) => c.reason).filter(Boolean).join("; ") : null,
    blockedBy: blocking.map((c) => c.kind),
    unchecked: unchecked.map((c) => c.kind),
    // WHAT WAS CHECKED IS RETURNED WHOLE: the screen and the report must name not only the verdict but what it was
    // taken from, and the numbers there are already computed.
    checks: list,
  };
}

// Words for the button and the caption under it. One phrase per verdict, so the screen and the report say the
// same thing: once they diverge they will explain one thing to the person and another to the operator.
export function signingGateWords(gate) {
  if (!gate || !gate.blocked) return null;
  const first = (gate.checks || []).find((c) => c.blocks === true) || null;
  const why = first && first.reason ? first.reason : "the order cannot be checked";
  return "Signing is blocked: " + why + " (" + gate.kind + ")";
}
