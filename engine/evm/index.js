// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/index.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// The wallet used by the demo interface.
// One implementation: WalletConnect (www/js/evm/walletconnect.js) - the user's real wallet, real balances.
// The built-in demo wallet and its mode switch were removed: we are heading to a real product, not a mockup.
// Still NO transfers: there is no escrow contract yet and the address is mocked (mock/chain.js), so funding
// is a simulation (simulateEscrowFunding below); provider.sendTransaction will replace it.

import {
  address,
  balanceOf,
  chainIdOf,
  connect,
  disconnect,
  isConnected,
  refreshBalances,
  restore,
  status,
  subscribe,
  switchChain,
  currentProvider,
  tokensWithBalance,
  connectInjected,
  restoreInjected,
} from "./session.js";
import { discoverWallets } from "./injected.js";
// fundOrder needs a LOCAL name: `export * from ./funding.js` only re-exports and does not create a local
// variable, so fundOrderLive called a missing name and crashed.
import { fundOrder } from "./funding.js";
export * from "./factory.js";
export * from "./escrow.js";
export * from "./funding.js";
// The depositor signature form (evm/depositor.js) and the permit verdict (evm/permit.js) go through the SAME
// engine seam: the page and the SDK share one protocol code, not two lookalikes.
export * from "./depositor.js";
export * from "./permit.js";
// THE ASYNCHRONOUS ROUTE, EXECUTED - through the same engine seam as the decision that chooses it. The page reaches
// it through the bridge; the SDK carries the same module in its engine mirror (tools/build-sdk-engine.mjs).
export * from "./asyncRoute.js";
export * from "./asyncExec.js";
// THE LIQUIDITY LEG OF A COMPOSED ROUTE (KyberSwap Limit Order) - through the same engine seam as the CoW leg,
// so the page and the SDK carry one implementation each.
export * from "./asyncLegs.js";

// currentProvider - the wallet provider goes OUT to the SDK core (evm-wallet.mjs) so signing uses the same
// key as the page. Screens do not need it; they read status()/isConnected().
export { address, balanceOf, chainIdOf, connect, disconnect, isConnected, refreshBalances, restore, status, subscribe, switchChain, currentProvider };
export { connectInjected, restoreInjected };
// IMPORTANT: this is an import, not a re-export. `export { X } from ...` only re-exports and does NOT create
// a local name, while fundOrderLive uses sendTransaction/readContract directly - this already broke twice.
import { sendTransaction, readContract, readReceipt, readCode } from "./session.js";
export { sendTransaction, readContract, readReceipt, readCode };

// The browser wallets available here (EIP-6963, falling back to window.ethereum). An empty list is normal:
// no extension, so WalletConnect remains.
export function wallets() {
  return discoverWallets();
}

// Balances of all accepted tokens of the network (native first), for screens that need the list.

// SIMULATION: no real transaction is sent (there is no escrow contract). A fake hash is returned so the
// swap state stays derivable; the UI says plainly the demo moves no real money.
export async function simulateEscrowFunding(tx) {
  await new Promise((r) => setTimeout(r, 900));
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hash = "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return { hash, ...tx, simulated: true };
}

// THE LIVE FUNDING PATH: real transactions in the user's wallet.
//
// Replaces simulateEscrowFunding. The difference is fundamental: the simulation invented a hash, here two
// real transactions go out - createOrder to the factory and lock(sealedHalf) to the new escrow.
//
// Separation is deliberate: cryptography (halves, DLEQ, envelope) lives in www/js/atomic/ and does NOT reach
// here. This function gets the ready sealedCommitment and sealedHalf - exactly what goes to the contract.
// The caller sets the order of steps: verify the counterparty first, then lock.
//
// factory is passed in (the caller takes it from the network config) so there is no second source of truth
// for addresses here.
// THE SIGNATURE WAS BROUGHT TO THE NEW SCHEME: the old hashlock/commitment/envelope fields remained, while
// the half commitments and ed25519 points that fundOrder REQUIRES were absent - so the live funding path
// could not pass even the first step. Neither syntax nor checks saw this, because the live path is never run.
// FOUR FIELDS AND TWO DEADLINES EXPLICITLY. The deadlines come ready (readyBy, t1), not computed from now:
// they go into the context the proof binds to, so they must be fixed before it.
export async function fundOrderLive({ factory, locker, claimer, commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker, salt, amountWei, amountLabel, claimWindowSeconds = 3600, readyWindowSeconds = 14400, readyBy, t1, quote, depositorSignature, onStep }) {
  return fundOrder({
    factory,
    quote,                         // signed quote: carries the fee, registry address and provider
    // THE DEPOSITOR SIGNATURE OVER THE QUOTE DIGEST. Present: funding goes via
    // createOrderAndFundByDepositor and anyone may send the transaction. Absent: the old path.
    depositorSignature,
    locker,
    claimer,
    commitHalfLocker,
    commitHalfClaimer,
    edPointLocker,
    edPointClaimer,
    edViewPointLocker,
    salt,                          // retrying funding must land at the same escrow address
    amountLabel,                   // "0.03 ETH" instead of the wei number on the button
    amountWei,
    claimWindowSeconds,
    readyWindowSeconds,
    readyBy,                       // deadlines the proof is already bound to
    t1,
    call: readContract,
    send: sendTransaction,
    receipt: readReceipt,          // the escrow address comes from the receipt, not from a prediction
    onStep,
  });
}
