#!/usr/bin/env node
// THE EIP-712 TERMS A RELAY REQUEST SIGNS.
//
// The expected values come from the relay's wire vector, recomputed independently in Go. A digest that
// agrees only with this repository's own encoder would not catch a wrong type string, field order or nested
// struct hash.
//
// Run: node tools/check-relay-terms.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256 } from "../src/primitives.mjs";
import {
  FIRM_ORDER_TYPE,
  FIRM_TERMS_TYPE,
  firmOrderHash,
  firmTermsDigest,
  firmTermsDomainSeparator,
  firmTermsMissingFields,
  firmTermsStructHash,
} from "../src/relayTerms.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "relay-terms.json"), "utf8"));
const crypto = { keccak256 };
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");

let pass = 0;
const fails = [];
const ok = (message) => { pass += 1; console.log("  ok    " + message); };
const bad = (message) => { fails.push(message); console.log("  FAIL  " + message); };

console.log("=== 1) THE TYPE STRINGS NAME THE NESTED ORDER ===");
if (FIRM_ORDER_TYPE === "FirmOrder(uint256 chainId,address factory,address locker,address claimer,uint256 amount,uint64 readyBy,uint64 t1,bytes32 salt)") {
  ok("the order type is the wire type");
} else bad("order type: " + FIRM_ORDER_TYPE);
if (FIRM_TERMS_TYPE === "FirmTerms(string market,string side,address maker,address registry,bytes32 featuresHash,string xmrNetwork,FirmOrder order,uint256 xmrAmount,uint256 claimTip)" + FIRM_ORDER_TYPE) {
  ok("the terms type appends the referenced order type");
} else bad("terms type: " + FIRM_TERMS_TYPE);

console.log("=== 2) THE INDEPENDENT VECTOR MATCHES ===");
for (const [label, got, want] of [
  ["order struct", hex(firmOrderHash(crypto, fixture.terms.order)), fixture.orderHash],
  ["terms struct", hex(firmTermsStructHash({ crypto, terms: fixture.terms })), fixture.termsHash],
  ["relay domain", hex(firmTermsDomainSeparator(crypto)), fixture.domain],
  ["terms digest", hex(firmTermsDigest({ crypto, terms: fixture.terms })), fixture.digest],
]) {
  if (got === want) ok(label + " matches the Go vector");
  else bad(label + ": " + got + ", expected " + want);
}

console.log("=== 3) EVERY FIELD IS BOUND ===");
const baseline = hex(firmTermsDigest({ crypto, terms: fixture.terms }));
const mutate = (name, value) => ({ ...fixture.terms, [name]: value });
const mutations = [
  ["market", mutate("market", "42161:USDC")],
  ["side", mutate("side", "bid")],
  ["maker", mutate("maker", "0x" + "01".repeat(20))],
  ["registry", mutate("registry", "0x" + "02".repeat(20))],
  ["featuresHash", mutate("featuresHash", "0x" + "03".repeat(32))],
  ["xmrNetwork", mutate("xmrNetwork", "mainnet")],
  ["xmrAmount", mutate("xmrAmount", "1000000000001")],
  ["claimTip", mutate("claimTip", "1")],
];
for (const [name, next] of mutations) {
  const got = hex(firmTermsDigest({ crypto, terms: next }));
  if (got !== baseline) ok(name + " changes the digest");
  else bad(name + " does NOT change the digest");
}
for (const [name, value] of [
  ["chainId", "42162"],
  ["factory", "0x" + "04".repeat(20)],
  ["locker", "0x" + "05".repeat(20)],
  ["claimer", "0x" + "06".repeat(20)],
  ["amount", "152330000000000008"],
  ["readyBy", 1791188236],
  ["t1", 1791191836],
  ["salt", "0x" + "07".repeat(32)],
]) {
  const next = { ...fixture.terms, order: { ...fixture.terms.order, [name]: value } };
  const got = hex(firmTermsDigest({ crypto, terms: next }));
  if (got !== baseline) ok("order." + name + " changes the digest");
  else bad("order." + name + " does NOT change the digest");
}

console.log("=== 4) AN ABSENT FIELD IS NAMED ===");
for (const name of ["market", "side", "maker", "registry", "featuresHash", "xmrNetwork", "xmrAmount", "claimTip"]) {
  const next = { ...fixture.terms };
  delete next[name];
  if (firmTermsMissingFields(next).includes(name)) ok(name + " is named when missing");
  else bad(name + " is absent but not named");
}
for (const name of ["chainId", "factory", "locker", "claimer", "amount", "readyBy", "t1", "salt"]) {
  const next = { ...fixture.terms, order: { ...fixture.terms.order } };
  delete next.order[name];
  if (firmTermsMissingFields(next).includes("order." + name)) ok("order." + name + " is named when missing");
  else bad("order." + name + " is absent but not named");
}
if (firmTermsMissingFields({ ...fixture.terms, order: undefined }).includes("order")) ok("an absent order is named");
else bad("an absent order is not named");

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "relay terms: " + pass + " checks passed.");
if (fails.length) process.exit(1);
