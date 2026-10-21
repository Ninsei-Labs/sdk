// THE SALE RANKING (#18): a maker may move margin into the claim tip, and the seller receives the payout after it.
import { rankOffers } from "../src/quotes.mjs";

export const quoteRankCheck = async () => {
  const problems = [];
  const notes = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };
  const offer = (rate, claimTip = "0") => ({ rate, claimTip });

  const gross = rankOffers([offer(1), offer(0.95)], { direction: "sell", amount: 10 });
  check(gross.best && gross.best.rate === 1, "the higher rate did not win without a tip");
  check(gross.net === 10, `the gross net is ${gross.net}, expected 10`);

  const tipped = rankOffers([offer(1, "2000000000000000000"), offer(0.95)], { direction: "sell", amount: 10 });
  check(tipped.best && tipped.best.rate === 0.95, "a 2 ETH tip on a 10 XMR sale did not move the winner");
  check(tipped.net === 9.5, `the tipped net is ${tipped.net}, expected 9.5`);

  const buy = rankOffers([offer(1, "2000000000000000000"), offer(0.95)], { direction: "buy", amount: 10 });
  check(buy.best && buy.best.rate === 1, "a buy was ranked by a tip it does not pay");

  const noAmount = rankOffers([offer(1, "2000000000000000000"), offer(0.95)], { direction: "sell" });
  check(noAmount.best && noAmount.best.rate === 1, "without an amount the rate was not the fallback");

  notes.push("the sale winner is the payout after the tip; a buy and a missing amount fall back to the rate");
  return { note: "a claim tip is part of the sale's ranking", problems, notes };
};
