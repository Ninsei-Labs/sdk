#!/usr/bin/env node
// THE DEFAULT FACTORY POLICY. A quote is signed for a factory named by the maker's registry; without a policy the
// interface would fund whatever factory that record names. The network registry therefore carries the code hash
// of the deployed factory, and the default options must expose it rather than leave the check unset.
import assert from "node:assert/strict";
import { DEFAULT_CHAIN, KNOWN_FACTORY_CODES, knownFactoryCodesFor, knownImplementationCodesFor } from "../engine/core/config.js";
import { factoryCodesForChain, implementationCodesForChain } from "../src/factoryPolicy.mjs";
import { readFileSync } from "node:fs";

const problems = [];
let passed = 0;
const check = (name, fn) => { try { fn(); passed += 1; console.log("  ok    " + name); } catch (e) { problems.push(name + ": " + e.message); console.log("  FAIL  " + name); } };

check("the default network has a factory policy", () => {
  const policy = knownFactoryCodesFor(DEFAULT_CHAIN);
  assert.ok(Array.isArray(policy) && policy.length > 0, "default network policy is empty");
});
check("the policy is the deployed testnet factory build", () => {
  const policy = knownFactoryCodesFor("arbitrum-sepolia");
  assert.deepEqual(policy, ["0x4d51e943b7786be7d3f9e2c44ad0b54f82932dba12ac6fa34be5088500d6615c"]);
});
check("a network without a deployed factory keeps no policy", () => {
  assert.equal(knownFactoryCodesFor("arbitrum"), null);
});
check("createNinsei's default factory policy is the network's pin", () => {
  assert.deepEqual(factoryCodesForChain({ chain: DEFAULT_CHAIN, knownFactoryCodes: null }),
    knownFactoryCodesFor(DEFAULT_CHAIN));
  assert.deepEqual(factoryCodesForChain({ chain: DEFAULT_CHAIN, knownFactoryCodes: undefined }),
    knownFactoryCodesFor(DEFAULT_CHAIN));
});
check("a caller's explicit list still wins, including an empty one", () => {
  assert.deepEqual(factoryCodesForChain({ chain: DEFAULT_CHAIN, knownFactoryCodes: ["0x" + "1".repeat(64)] }),
    ["0x" + "1".repeat(64)]);
  assert.deepEqual(factoryCodesForChain({ chain: DEFAULT_CHAIN, knownFactoryCodes: [] }), []);
});
check("a network without a deployed factory defaults to no policy", () => {
  assert.equal(factoryCodesForChain({ chain: "arbitrum", knownFactoryCodes: null }), null);
});
check("the default implementation policy comes from the same network", () => {
  assert.deepEqual(implementationCodesForChain({ chain: DEFAULT_CHAIN, knownImplementationCodes: null }),
    knownImplementationCodesFor(DEFAULT_CHAIN));
});
check("createNinsei uses the policy helper", () => {
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /factoryCodesForChain\(\{ chain: config\.settlement\.chain/);
  assert.match(source, /implementationCodesForChain\(\{ chain: config\.settlement\.chain/);
});
check("every policy entry is a 32-byte code hash", () => {
  for (const [network, list] of Object.entries(KNOWN_FACTORY_CODES)) {
    for (const hash of list) assert.match(hash, /^0x[0-9a-f]{64}$/, network + " carries " + hash);
  }
});

if (problems.length) { console.log("\nfactory policy: FAILED (" + problems.length + ")"); process.exit(1); }
console.log("\nfactory policy: " + passed + " checks passed.");
