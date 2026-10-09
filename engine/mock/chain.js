// GENERATED FILE - a byte-for-byte copy of the engine module www/js/mock/chain.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Mock chain: the escrow contract on EVM and the Monero leg.
//
// There are NO real transactions here. Everything returned is marked mock, and the hashes
// are deterministic from the swap id - so the demo is reproducible.
// Swap-out point: once the contract exists, these functions are replaced by ethers.js calls,
// while the interface (fund/lock/claim/refund/sweep) is preserved.

import { randomHex } from "../core/format.js";
import * as node from "../monero/node.js";

function hashOf(...parts) {
  const payload = parts.join("|");
  let hh = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hh ^= payload.charCodeAt(i);
    hh = (hh * 0x01000193) >>> 0;
  }
  return "0x" + hh.toString(16).padStart(8, "0") + randomHex(28);
}

// CREATE2 address of the per-order escrow (litepaper §8: its own contract per swap, no admin).
export function escrowAddress(swapId) {
  return "0x" + hashOf("escrow", swapId).slice(2, 42);
}

// Address of the joint Monero output (S_a + S_b, V_a + V_b in the real protocol).
export function moneroLockAddress(swapId) {
  return "8" + hashOf("xmrlock", swapId).slice(2, 96);
}

export function fundEscrow({ swapId, ethAmountUsd, ethUsd }) {
  return {
    mock: true,
    txHash: hashOf("fund", swapId),
    escrow: escrowAddress(swapId),
    ethAmount: ethUsd > 0 ? ethAmountUsd / ethUsd : 0,
    valueUsd: ethAmountUsd,
    gasUsd: 0.21,
    // WE DO NOT INVENT THE METHOD NAME. This used to be lockAndSwap(bytes32 quoteHash, bytes makerSig) - no
    // such method exists in the contract at all, yet that exact string went into the swap record and was shown
    // on screen as "Escrow method". The demo path moves no money, so its honest label is this one, without the
    // invented signature. The real call name is written by the live path itself, from the actual call.
    method: "simulated funding (no real transaction)",
    confirmations: 1,
  };
}

export function lockXmr({ swapId, xmrAmount }) {
  return {
    mock: true,
    txid: hashOf("xmrtx", swapId),
    address: moneroLockAddress(swapId),
    amount: xmrAmount,
    viewKeyVerified: true,
    unlocked: "1 of 2 spend key shares revealed (DLEQ bound)",
  };
}

export function sweepXmr({ swapId }) {
  return { mock: true, txid: hashOf("sweep", swapId) };
}

export function refundEscrow({ swapId, by }) {
  return { mock: true, txHash: hashOf("refund", swapId, by), by };
}

// Monero node confirmations: 10 blocks of 2 minutes (litepaper §5.0).
//
// chainMode=mock - confirmations follow sim-time (fast, for showing the flow).
// chainMode=live - confirmations are counted from the real height growth of the mainnet node:
//   the swap then honestly takes ~20 minutes regardless of the demo speed. If the node
//   is unavailable or the height at lock time was not recorded, we fall back to the sim counter.
export function confirmations(swap, simElapsedMs) {
  const target = swap.timeline.confTarget;

  if (swap.chainMode === "live") {
    const lockHeight = swap.xmr && swap.xmr.lockHeight;
    const snap = node.snapshot();
    if (lockHeight && snap && typeof snap.height === "number" && snap.height >= lockHeight) {
      return Math.max(0, Math.min(target, snap.height - lockHeight));
    }
    return swap.xmr ? 0 : 0;
  }

  const started = swap.timeline.lockAtSim;
  if (started === null || simElapsedMs < started) return 0;
  const blocks = Math.floor((simElapsedMs - started) / swap.timeline.blockSim);
  return Math.max(0, Math.min(target, blocks));
}

export function explorerTx(hash) {
  return "https://arbiscan.io/tx/" + hash;
}
