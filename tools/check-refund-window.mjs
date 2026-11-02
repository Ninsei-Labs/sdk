// THE REFUND WINDOW IS THE ESCROW'S, NOT A SECOND OPINION.
//
// The escrow rejects `refund()` before T1 whenever the ready mark is absent, including the window between
// `readyBy` and T1. A live order without the mark therefore has one state where nothing can be signed, and a
// second state at T1 where the refund opens. The screen must not offer a button the contract will revert.
import * as engine from "../src/engine.mjs";

const address = "0x" + "11".repeat(20);
const make = (readyBy, t1) => {
  const swap = engine.swap.createSwap({
    side: "buy", xmrSource: "app", network: "arbitrum-sepolia",
    payToken: "eth", payAmount: 0.01, xmrAmount: 0.5, rate: 2_000,
    makerId: "refund-window", makerName: "refund-window",
    receiveAddress: "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq",
  });
  swap.xmrSource = "app";
  swap.escrow = { address, readyBy, t1 };
  swap.xmrSession = { status: "ready", receivedXmr: 0.5, lockedXmr: 0, confirmations: 10, fundingTxids: [], address: "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq" };
  return swap;
};

export const refundWindowCheck = async () => {
  const problems = [];
  const now = Math.floor(Date.now() / 1000);
  const deadline = make(now - 10, now + 1000);
  const waiting = engine.swap.derive(deadline);
  if (waiting.phase !== "dead_zone") problems.push(`the readyBy-to-T1 window is the phase ${JSON.stringify(waiting.phase)}, not "dead_zone"`);
  if (waiting.can.refund !== false) problems.push("the readyBy-to-T1 window offers a refund the escrow rejects");
  if (waiting.can.ready !== false) problems.push("the readyBy-to-T1 window offers a ready mark after readyBy");

  const after = make(now - 1000, now - 1);
  const open = engine.swap.derive(after);
  if (open.phase !== "refund_available") problems.push(`the window after T1 is the phase ${JSON.stringify(open.phase)}, not "refund_available"`);
  if (open.can.refund !== true) problems.push("the window after T1 does not offer the refund");
  if (open.can.refundByAnyone !== true) problems.push("the window after T1 does not open the refund to anyone");

  return { note: "the refund window matches the escrow: closed between readyBy and T1, open at T1", problems, notes: problems.length ? [] : ["dead zone and post-T1 states are distinct"] };
};
