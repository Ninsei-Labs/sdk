// A REFUND NEEDS A POSITIVE "NOT THERE", NOT A WAITING ANSWER.
//
// `refundIfXmrMissing` used to treat every non-arrived verdict as an empty address. A payout with too few
// confirmations (`pending` with a txid) and a payout seen by one operator (`one-node`) are the opposite: the money
// is there. Refunding on either reverses a swap the maker has already paid.
//
// The helper now signs only when `verifyArrival` returns `absent: true` - the marker set only after a node completed
// the walk and found no matching transaction. Every other waiting answer is returned as `arrival-pending`, and a
// failure to check still throws before a signature.
import { SdkError } from "../src/errors.mjs";
import { createSwaps } from "../src/swaps.mjs";
import { verifyArrival } from "../src/xmr-arrival.mjs";

const now = 1_800_000_000;
const address = "59DnddZzVBCevVg9YB3zCs24DSRH4ByS2FMBafPpYxSEB6FMegQNEbtNzbLjrrEUPNAg9NhK5uMiiAZpAvENBS4D4mEPcRq";
const slot = "0x" + "11".repeat(32);
const base = {
  escrow: "0x" + "aa".repeat(20),
  halfLocker: slot,
  address,
  viewSecret: "0x" + "22".repeat(32),
  spendPub: "0x" + "33".repeat(32),
  expect: { edPointLocker: slot, edPointClaimer: slot, edViewPointLocker: slot, commitHalfLocker: slot, commitHalfClaimer: slot },
  expectedAtomic: "1000000000000",
  readyBySec: now + 50,
  nowSec: now,
  leadSec: 100,
};

async function run(verdict, { request = {}, throws = false } = {}) {
  let refunds = 0;
  let checks = 0;
  try {
    const result = await createSwaps({}).refundIfXmrMissing({ ...base, ...request }, {
      verify: async () => {
        checks += 1;
        if (throws) throw new SdkError("xmr-no-nodes", { tried: ["node"] });
        return verdict;
      },
      refund: async () => {
        refunds += 1;
        return { hash: "0x" + "bb".repeat(32) };
      },
      now: () => now,
    });
    return { result, refunds, checks };
  } catch (error) {
    return { error, refunds, checks };
  }
}

export const refundIfMissingCheck = async () => {
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(message); };

  // ONLY THE ABSENCE MARKER SIGNS. The walk found no transaction at all.
  {
    const got = await run({ seen: false, state: "pending", absent: true, txid: null });
    check(got.result && got.result.refunded === true, "an absent verdict did not refund");
    check(got.result && got.result.state === "refunded", "an absent verdict did not report refunded");
    check(got.refunds === 1, "an absent verdict did not call the refund once");
  }

  // A PAYOUT WITH TOO FEW CONFIRMATIONS IS SEEN, NOT ABSENT. This is the regression that reversed paid swaps.
  for (const [name, verdict] of [
    ["pending with a txid", { seen: false, state: "pending", txid: "ab".repeat(32), height: 100 }],
    ["pending with a height", { seen: false, state: "pending", height: 100 }],
    ["one-node", { seen: false, state: "one-node", txid: "ab".repeat(32), height: 100 }],
    ["arrived", { seen: true, state: "arrived", txid: "ab".repeat(32), height: 100 }],
    ["no marker", { seen: false, state: "pending" }],
  ]) {
    const got = await run(verdict);
    check(!got.error && got.result && got.result.refunded === false, `${name} refunded`);
    check(got.refunds === 0, `${name} called the refund`);
    check(got.result && got.result.state === (verdict.seen ? "arrived" : "arrival-pending"),
      `${name} reported ${JSON.stringify(got.result && got.result.state)}`);
  }

  // A FAILED CHECK SIGNS NOTHING.
  {
    const got = await run(null, { throws: true });
    check(got.error && got.error.code === "xmr-no-nodes", "a failed check did not keep its code");
    check(got.refunds === 0, "a failed check called the refund");
  }

  // THE ARRIVAL CHECK MARKS ONLY TWO OPERATORS' COMPLETED WALK WITH NO TRANSACTION. The marker is what lets the
  // refund rule above tell that apart from a payout that is merely still confirming.
  const emptyFetch = ({ busy = false, partial = false } = {}) => async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "get_info") {
      const isBusy = busy && String(url).includes("busy.example");
      return { ok: true, json: async () => ({ result: isBusy ? { height: 3, status: "BUSY" } : { height: 3, synchronized: true } }) };
    }
    if (body.method === "get_block") {
      return { ok: true, json: async () => ({ result: { block_header: { hash: "ab".repeat(32) }, tx_hashes: partial ? ["aa", "bb"] : [] } }) };
    }
    if (String(url).endsWith("/get_transactions") && partial) {
      return { ok: true, json: async () => ({ txs: [{ tx_hash: "aa" }], txs_as_json: ["{}"] }) };
    }
    throw new Error("unexpected monero call: " + body.method);
  };
  const request = (nodes, fetch) => ({
    nodes, address, viewSecret: base.viewSecret, spendPub: base.spendPub, expectedAtomic: "1", fromHeight: 1, fetch,
  });
  {
    const verdict = await verifyArrival(request([
      { url: "http://one.example", operator: "one" },
      { url: "http://two.example", operator: "two" },
    ], emptyFetch()));
    check(verdict && verdict.absent === true, "two empty operators did not carry absent: true");
    check(verdict && verdict.seen === false && !verdict.height, "an empty walk did not stay unseen");
  }
  {
    const verdict = await verifyArrival(request([{ url: "http://one.example", operator: "one" }], emptyFetch()));
    check(verdict && verdict.absent === false, "one operator's empty walk claimed absence");
  }
  {
    const verdict = await verifyArrival(request([
      { url: "http://busy.example", operator: "busy" },
      { url: "http://one.example", operator: "one" },
    ], emptyFetch({ busy: true })));
    check(verdict && verdict.absent === false, "a busy operator's empty walk claimed absence");
  }
  try {
    await verifyArrival(request([{ url: "http://partial.example", operator: "partial" }], emptyFetch({ partial: true })));
    check(false, "a partial get_transactions answer became an absence");
  } catch (error) {
    const failures = error && error.params && Array.isArray(error.params.nodes) ? error.params.nodes : [];
    check(error && error.code === "xmr-no-nodes" && failures.some((n) => n.why === "partial-transactions"),
      "a partial get_transactions answer did not keep its refusal");
  }

  // THE TIME RULES STAY IN FRONT OF THE CHECK.
  {
    const waiting = await run({ seen: false, state: "pending", absent: true }, { request: { readyBySec: now + 200 } });
    check(waiting.result && waiting.result.state === "waiting", "more than the lead did not wait");
    check(waiting.checks === 0 && waiting.refunds === 0, "more than the lead checked or refunded");
    const late = await run({ seen: false, state: "pending", absent: true }, { request: { readyBySec: now - 1 } });
    check(late.result && late.result.state === "claim-window", "a passed readyBy did not report claim-window");
    check(late.checks === 0 && late.refunds === 0, "a passed readyBy checked or refunded");
  }

  return {
    note: "only two operators' completed walk with nothing refunds; a seen transaction and a failed check do not",
    problems,
    notes: problems.length ? [] : ["pending/one-node/arrived are kept apart from absent; busy and partial answers are refusals"],
  };
};
