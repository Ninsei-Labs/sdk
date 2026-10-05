// PRE-SIGNATURE CHECKS: the same engine guards, but the answer is codes, not texts.
//
// WHAT MATTERS HERE and why this is not a "wrapper": the unverified must be named as unverified. The engine guards
// already distinguish "good" from "not measured" (`checked: false`, the `*-unchecked` kinds), so the SDK does not
// discard such checks and does not pass them off as green: it calls the guard with what it has and passes the
// verdict on.
import * as engine from "./engine.mjs";
import { checkCodeFor } from "./codes.mjs";

// The engine's refusal reason is a phrase for a person; the SDK does not hand it out: the interface translates the code itself.
const toCheck = (verdict) => {
  const v = verdict && typeof verdict === "object" ? verdict : {};
  const { reason, kind, ok, checked, blocks, ...params } = v;
  return {
    code: checkCodeFor(kind),
    ok: ok === true,
    checked: checked !== false,
    blocks: blocks === true,
    kind: typeof kind === "string" ? kind : "unknown",
    params,
  };
};

// IS THERE ANYTHING TO COMPARE AGAINST. An empty value means "there was no check", and a check with nothing to
// apply to is not run at all: otherwise it locks the signature where there is NOTHING to check against by
// construction.
const hasComparison = (...values) => values.some((v) => v !== undefined && v !== null && v !== "");

const call = (fn, input) => {
  try {
    return fn(input);
  } catch (error) {
    // A guard that could not compute is "not checked", not "passed".
    return { ok: false, checked: false, blocks: false, kind: "unchecked", error: String(error && error.message ? error.message : error) };
  }
};

export function createPreflight({ config, wallet, limits = {} }) {
  return async function preflight(offer = {}, options = {}) {
    const guards = engine.config.SIGNING_GUARDS || {};
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const quote = offer && typeof offer === "object" ? offer : {};
    const tokenIsNative = Boolean(options.tokenIsNative);
    const chain = config.evmNetwork;

    const checks = [
      // 1. THE QUOTE IS ALIVE. The deadline is taken from the quote: an expired one must not be signed, even if its numbers are correct.
      call(engine.guards.quoteFreshnessVerdict, {
        at: Number.isFinite(quote.at) ? quote.at : null,
        ttlMs: Number.isFinite(quote.ttlMs) ? quote.ttlMs : null,
        expiresAt: Number.isFinite(quote.expiresAt) ? quote.expiresAt : null,
        nowMs,
      }),
      // 2. DEADLINES FROM THE CHAIN: the mark window and the claim window must not overlap.
      call(engine.guards.deadlineVerdict, {
        nowSec: Math.floor(nowMs / 1000),
        readyBy: Number.isFinite(quote.readyBy) ? quote.readyBy : null,
        t1: Number.isFinite(quote.t1) ? quote.t1 : null,
        minReadyLeadSec: guards.minReadyLeadSec ?? null,
        minClaimWindowSec: guards.minClaimWindowSec ?? null,
      }),
      // 3. SIZE. The grid is declared by the provider node, so the sizes come with the quote, not from a file.
      call(engine.guards.rangeVerdict, {
        size: Number.isFinite(quote.amount) ? quote.amount : null,
        unit: quote.token || null,
        min: Number.isFinite(quote.min) ? quote.min : (limits.minAmount ?? null),
        max: Number.isFinite(quote.max) ? quote.max : (limits.maxAmount ?? null),
        step: Number.isFinite(quote.step) ? quote.step : (limits.stepAmount ?? null),
        quoteUnit: quote.token || null,
      }),
      // 4. MONEY: is there enough to pay and does anything remain for gas.
      call(engine.guards.payBalanceVerdict, {
        payBalanceWei: options.payBalanceWei ?? null,
        payAmountWei: options.payAmountWei ?? null,
        symbol: tokenIsNative ? chain.nativeSymbol : (quote.token || null),
        decimals: Number.isFinite(options.decimals) ? options.decimals : 18,
      }),
      call(engine.guards.gasReserveVerdict, {
        nativeBalanceWei: options.nativeBalanceWei ?? null,
        requiredNativeWei: options.requiredNativeWei ?? null,
        gasReserveWei: options.gasReserveWei ?? null,
        symbol: chain.nativeSymbol,
        decimals: 18,
      }),
      // 5. TOKEN ALLOWANCE. Without the person's consent no allowance is granted - that is a separate code.
      call(engine.guards.allowanceVerdict, {
        tokenIsNative,
        allowanceWei: options.allowanceWei ?? null,
        amountWei: options.payAmountWei ?? null,
        consent: options.allowanceConsent === true,
        symbol: quote.token || null,
        decimals: Number.isFinite(options.decimals) ? options.decimals : 18,
      }),
      // 6. THE WALLET NETWORK against the settlement network.
      call(engine.guards.networkGateVerdict, {
        walletChainId: wallet.status().chainId,
        selectedChainId: chain.chainId,
        settlementChainId: chain.chainId,
        selectedChainName: chain.name,
      }),
      // 7. THE COUNTERPARTY and 8. THE ESCROW STATE, 9. THE POINTS, 10. THE ORDER-BOOK SLOTS. These are chain
      // reads: while they are absent, the guards must say "not checked" rather than stay silent (stages 2 and 3).
      call(engine.guards.counterpartyVerdict, {
        standIn: options.standIn === true,
        liveChain: options.liveChain === true,
        network: config.evmNetwork.id,
        chainId: chain.chainId,
      }),
      call(engine.guards.escrowStateVerdict, { status: options.escrowStatus ?? null, error: null, address: options.escrowAddress ?? null }),
      // THE POINTS AND SLOTS ARE TURNED ON ONLY WHEN THERE IS SOMETHING TO COMPARE AGAINST. Both compare an order
      // ALREADY LYING ON THE CHAIN, while at the swap-start step the order does not exist YET: it is created by
      // the very signature the guards protect, so there is nothing to compare against BY CONSTRUCTION. While both
      // stood in the list unconditionally, on empty data each answered "not checked" (blocks: true), and the swap
      // start ran into its own guard without ever reaching the signature. The check APPEARS when its data is
      // brought (the core does this on mark/claim/refund - assertOrderSlots), and then incompleteness still locks:
      // this is removing a check with nothing to apply to, not weakening one that compares.
      ...(hasComparison(options.point, options.commit)
        ? [call(engine.guards.escrowPointsVerdict, {
            role: options.pointsRole ?? null,
            what: options.pointsWhat ?? null,
            point: options.point ?? null,
            onchainPoint: options.onchainPoint ?? null,
            commit: options.commit ?? null,
            onchainCommit: options.onchainCommit ?? null,
            readError: options.pointsReadError ?? null,
          })]
        : []),
      ...(hasComparison(options.slots)
        ? [call(engine.guards.liveOrderSlotsVerdict, { slots: options.slots ?? null, expect: options.slotsExpect ?? null, readError: options.slotsReadError ?? null })]
        : []),
    ];

    const mapped = checks.map(toCheck);
    const blockedBy = [...new Set(mapped.filter((c) => c.blocks).map((c) => c.code))];
    return { ok: blockedBy.length === 0, blockedBy, checks: mapped };
  };
}
