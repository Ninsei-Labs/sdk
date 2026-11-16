// Executable examples of adapters accepted by index.d.ts. Known defects stay skipped until their issue is fixed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNinsei } from "../src/index.mjs";
import { createSwaps } from "../src/swaps.mjs";
import { createStore, memoryStorage } from "../engine/core/store.js";
import { encodeStatus, encodeRead } from "../engine/evm/escrow.js";
import { asyncStorage, feeOnlyBlock } from "./ts-consumer/adapter-fixtures.ts";

test("a Promise-returning declared store can list an empty account", { skip: "sdk#356: runtime parses the storage Promise instead of awaiting it" }, async () => {
  const sdk = createNinsei({ settlement: { chain: "arbitrum-sepolia" }, xmrNetwork: "stagenet", storage: asyncStorage() });
  assert.deepEqual(await sdk.swaps.list(), []);
});

test("a declared block adapter supports a ready relay claim", { skip: "sdk#356: evmBlock declaration omits the number and timestamp required by claims" }, async () => {
  const address = (byte) => "0x" + byte.repeat(20);
  const record = { id: "declared-block", side: "sell", claimTip: "1", claimSenders: [address("33")],
    relayUrl: "https://relay.example", quote: { provider: address("11") },
    escrow: { address: address("22"), half: "0x" + "01".repeat(32) } };
  const store = createStore(memoryStorage());
  const state = store.loadState();
  state.swaps[record.id] = record;
  store.saveState(state);
  let posted = false;
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  const swaps = createSwaps({ config: {}, store, now: () => 1900000000000, evmBlock: feeOnlyBlock,
    call: async ({ data }) => {
      if (data === encodeStatus()) return "0x" + word(1) + word(posted ? 1 : 0) + word(0) + word(1000);
      if (data === encodeRead("termsHash")) return "0x" + word(0);
      if (data === encodeRead("ready")) return "0x" + word(1);
      if (data === encodeRead("readyBy")) return "0x" + word(1900000000);
      if (data === encodeRead("t1")) return "0x" + word(1900003600);
      throw new Error("unexpected escrow read");
    },
  });
  const result = await swaps.claimViaRelay({ id: record.id, fetchImpl: async (url, init) => {
    assert.equal(url, "https://relay.example/v1/claims/" + address("33") + "/" + address("22"));
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), { version: 1, halfClaimer: record.escrow.half });
    posted = true;
    // Synthetic success in relay/spec/relay-v1.md, claim HTTP contract (relay revision 74820cb).
    return { ok: true, status: 200, json: async () => ({ version: 1, provider: address("33"), escrow: address("22"), from: address("33"), tipWei: "1", txid: "0x" + "44".repeat(32) }) };
  } });
  assert.equal(result.state, "claimed");
  assert.equal(posted, true, "a ready claim reaches its sender");
});
