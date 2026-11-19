// THE RECORD'S MONERO NETWORK COMES FROM THE SDK INSTANCE, NOT THE DEMO CONSTANT.
//
// The gap was silent: a `createNinsei({ xmrNetwork: "testnet" })` instance wrote "stagenet" into every swap record
// and its recovery file, while the start-height probe asked the testnet nodes. The first run on another network
// then refused with `xmr-no-nodes { why: "network" }`.
import { recordInputOf } from "../src/swaps.mjs";
import { createRecord } from "../src/record.mjs";
import { createNinsei } from "../src/index.mjs";

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

  // A TESTNET INSTANCE HAS A NODE MAP, EMPTY UNTIL THE CALLER NAMES NODES. The old map refused both a testnet array
  // and a testnet key as unknown, so a testnet swap could never measure its start height.
  const testnet = createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "testnet", mode: "sim" });
  if (testnet.config.nodesFor("testnet").length !== 0) {
    problems.push("testnet did not start with an empty node list");
  }
  const withNodes = createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "testnet", mode: "sim",
    nodes: { testnet: [{ url: "https://testnet.example", operator: "testnet" }] } });
  if (withNodes.config.nodesFor("testnet").length !== 1
    || withNodes.config.nodesFor("testnet")[0].url !== "https://testnet.example") {
    problems.push("a testnet node map was not accepted");
  }
  const withArray = createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "testnet", mode: "sim",
    nodes: [{ url: "https://array.example", operator: "array" }] });
  if (withArray.config.nodesFor("testnet").length !== 1
    || withArray.config.nodesFor("testnet")[0].url !== "https://array.example") {
    problems.push("a testnet node array was not accepted");
  }

  // A LOCAL ANVIL DEPLOYMENT IS CALLER-PROVIDED. A fresh Deploy.s.sol changes the factory, so a fixed constant
  // cannot describe the stand; the override changes addresses, not the checks.
  const escrow = {
    address: "0x" + "12".repeat(20), cashier: "0x" + "34".repeat(20),
    implementationCodeHash: "0x" + "56".repeat(32), deploymentBlock: 7,
  };
  const local = createNinsei({ settlement: { chain: "local-anvil", escrow }, xmrNetwork: "fakechain", mode: "sim" });
  const got = local.config.settlement.chain.escrow || {};
  if (got.address !== escrow.address || got.cashier !== escrow.cashier
    || got.implementationCodeHash !== escrow.implementationCodeHash || got.deploymentBlock !== 7) {
    problems.push("a local-anvil deployment was not used: " + JSON.stringify(got));
  }
  let foreign = null;
  try {
    createNinsei({ settlement: { chain: "arbitrum-sepolia", escrow }, xmrNetwork: "stagenet", mode: "sim" });
  } catch (error) { foreign = error; }
  if (!foreign || foreign.code !== "bad-input" || !foreign.params || foreign.params.field !== "settlement.escrow"
    || foreign.params.why !== "only-local-anvil") {
    problems.push("a public deployment override was accepted: " + JSON.stringify(foreign && foreign.params));
  }

  return {
    note: "swap records carry the instance Monero network and an explicit request wins",
    problems,
    notes: ["testnet instance -> testnet record", "explicit mainnet -> mainnet record", "no instance -> no record network",
      "testnet has an empty node map and accepts caller nodes", "local-anvil accepts the deployment it just created"],
  };
};
