// GENERATED FILE - a byte-for-byte copy of the engine module www/js/mock/chain.js for the SDK package.
// Edit the source under www/js, then run: node tools/build-sdk-engine.mjs
// tools/check-sdk-engine.mjs reddens on any drift, so a stale copy cannot ship silently.
// Everything below this header is identical to the source.

// Мок-чейн: escrow-контракт на EVM и Monero-нога.
//
// Здесь НЕТ реальных транзакций. Всё, что возвращается, помечено как mock, а хеши
// детерминированы от id сделки - чтобы демо было воспроизводимо.
// Точка подмены: когда появится контракт, эти функции заменяются на вызовы ethers.js,
// а интерфейс (fund/lock/claim/refund/sweep) сохраняется.

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

// CREATE2-адрес per-order escrow (litepaper §8: свой контракт на сделку, без admin).
export function escrowAddress(swapId) {
  return "0x" + hashOf("escrow", swapId).slice(2, 42);
}

// Адрес совместного Monero-выхода (S_a + S_b, V_a + V_b в реальном протоколе).
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
    // ИМЯ МЕТОДА НЕ ВЫДУМЫВАЕМ. Здесь стояло lockAndSwap(bytes32 quoteHash, bytes makerSig) - такого
    // метода в контракте нет вовсе, но именно эта строка уезжала в запись сделки и показывалась на экране
    // как "Escrow method". Демо-путь денег не двигает, поэтому честная подпись для него - эта, без
    // выдуманной сигнатуры. Настоящее имя вызова живой путь записывает сам, из фактического вызова.
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

// Подтверждения Monero-ноды: 10 блоков по 2 минуты (litepaper §5.0).
//
// chainMode=mock - подтверждения идут по sim-времени (быстро, для показа потока).
// chainMode=live - подтверждения считаются по реальному росту высоты mainnet-нода:
//   сделка тогда честно длится ~20 минут независимо от скорости демки. Если нод
//   недоступен или высота на момент лока не зафиксирована, откатываемся на sim-счётчик.
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
