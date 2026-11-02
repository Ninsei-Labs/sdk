// THE RECORD'S MONERO NETWORK COMES FROM THE SDK INSTANCE, NOT THE DEMO CONSTANT.
//
// The gap was silent: a `createNinsei({ xmrNetwork: "testnet" })` instance wrote "stagenet" into every swap record
// and its recovery file, while the start-height probe asked the testnet nodes. The first run on another network
// then refused with `xmr-no-nodes { why: "network" }`.
import { recordInputOf } from "../src/swaps.mjs";
import { createRecord } from "../src/record.mjs";

export const swapNetworkCheck = () => {
  const problems = [];
  const request = { side: "buy", quote: { chain: "arbitrum-sepolia" } };
  const input = recordInputOf(request, "testnet");
  if (input.moneroNetwork !== "testnet") problems.push("recordInputOf lost the instance network: " + input.moneroNetwork);
  let made = null;
  try { made = createRecord(input); } catch (error) { problems.push("createRecord refused: " + (error && error.code)); }
  if (made && made.swap.moneroNetwork !== "testnet") problems.push("the record wrote " + made.swap.moneroNetwork + " instead of testnet");
  const explicit = recordInputOf({ ...request, moneroNetwork: "mainnet" }, "testnet");
  if (explicit.moneroNetwork !== "mainnet") problems.push("an explicit request network did not win: " + explicit.moneroNetwork);
  // The demo path still has its own fallback; it must not be mistaken for the SDK instance setting.
  const fallback = recordInputOf(request);
  if (fallback.moneroNetwork !== undefined) problems.push("a missing instance network was invented: " + fallback.moneroNetwork);
  return {
    note: "swap records carry the instance Monero network and an explicit request wins",
    problems,
    notes: ["testnet instance -> testnet record", "explicit mainnet -> mainnet record", "no instance -> no record network"],
  };
};
