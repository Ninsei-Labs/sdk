#!/usr/bin/env node
// THE SIGNED PUBLIC FEATURES OF A RELAY MAKER.
//
// The vector and its type string come from the relay's own wire tests. A digest that agrees only with this
// encoder would not catch a wrong array order or a missing FirmWindow type.
//
// Run: node tools/check-relay-features.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256 } from "../src/primitives.mjs";
import {
  FIRM_WINDOW_TYPE,
  NODE_FEATURES_TYPE,
  nodeFeaturesDigest,
  nodeFeaturesMissingFields,
  nodeFeaturesStructHash,
  verifyNodeFeatures,
} from "../src/relayFeatures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "relay-features.json"), "utf8"));
const features = fixture.features;
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const terms = {
  market: "42161:ETH",
  side: "ask",
  maker: features.provider,
  registry: features.registry,
  xmrNetwork: "stagenet",
};

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };

console.log("=== 1) THE TYPE STRING INCLUDES THE WINDOW STRUCT ===");
if (NODE_FEATURES_TYPE === fixture.typeString) ok("the features type matches the relay vector");
else bad("features type: " + NODE_FEATURES_TYPE);
if (FIRM_WINDOW_TYPE === "FirmWindow(string market,string side,string xmrNetwork,uint32 readyMinSeconds,uint32 readyMaxSeconds,uint32 settlementMinSeconds,uint32 settlementMaxSeconds,uint32 quoteTtlSeconds)") {
  ok("the window type is the wire type");
} else bad("window type: " + FIRM_WINDOW_TYPE);
if (hex(keccak256(new TextEncoder().encode(NODE_FEATURES_TYPE))) === fixture.typeHash) ok("the type hash matches");
else bad("type hash mismatch");

console.log("=== 2) THE INDEPENDENT VECTOR MATCHES ===");
for (const [label, got, want] of [
  ["struct hash", hex(nodeFeaturesStructHash(features)), fixture.structHash],
  ["digest", hex(nodeFeaturesDigest(features)), fixture.digest],
]) {
  if (got === want) ok(label + " matches the relay vector");
  else bad(label + ": " + got + ", expected " + want);
}

console.log("=== 3) THE SIGNATURE AND THE REQUEST BINDING ===");
try {
  const verdict = verifyNodeFeatures({ features, terms });
  if (verdict.featuresHash === fixture.digest && verdict.hpkeKey === features.hpkeKey && verdict.window?.side === "ask") {
    ok("the verified features name the provider, key and ask window");
  } else bad("verified features: " + JSON.stringify(verdict));
} catch (error) { bad("valid features refused: " + JSON.stringify(error && (error.code || error.message))); }
for (const [label, changed] of [
  ["a changed provider", { ...features, provider: "0x" + "01".repeat(20) }],
  ["a changed registry", { ...features, registry: "0x" + "02".repeat(20) }],
  ["a changed market", { ...features, firmWindows: [{ ...features.firmWindows[0], market: "42162:ETH" }] }],
  ["a changed side", { ...features, firmWindows: [{ ...features.firmWindows[0], side: "bid" }] }],
  ["a changed network", { ...features, firmWindows: [{ ...features.firmWindows[0], xmrNetwork: "mainnet" }] }],
]) {
  if (hex(nodeFeaturesDigest(changed)) !== fixture.digest) ok(label + " changes the digest");
  else bad(label + " does NOT change the digest");
  try { verifyNodeFeatures({ features: changed, terms }); bad(label + " passed verification"); }
  catch { ok(label + " is refused"); }
}

console.log("=== 4) MALFORMED OR UNSIGNED FEATURES ARE REFUSED ===");
const mutations = [
  ["another signature", { ...features, signature: "0x" + "00".repeat(65) }],
  ["another quote key", { ...features, quoteKey: "0x" + "03".repeat(20) }],
  ["a zero hpke key", { ...features, hpkeKey: "0x" + "00".repeat(32) }],
  ["a short hpke key", { ...features, hpkeKey: "0x01" }],
  ["no window", { ...features, firmWindows: [] }],

  ["another type", { ...features, type: "features" }],
];
for (const [label, changed] of mutations) {
  try { verifyNodeFeatures({ features: changed, terms }); bad(label + " was accepted"); }
  catch (error) {
    if (error && (error.code === "quote-refused" || (label === "a short hpke key" && error.code === "bad-input"))) {
      ok(label + " is refused");
    } else bad(label + " gave " + JSON.stringify(error && (error.code || error.message)));
  }
}
for (const name of ["relayId", "provider", "quoteKey", "registry", "hpkeKey", "firmWindows", "time", "nonce"]) {
  const next = { ...features };
  delete next[name];
  if (nodeFeaturesMissingFields(next).includes(name)) ok(name + " is named when missing");
  else bad(name + " is absent but not named");
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "relay features: " + pass + " checks passed.");
if (fails.length) process.exit(1);
