#!/usr/bin/env node
// A SENT TRANSACTION IS NOT A FUNDED ESCROW (sdk#113, item 7).
//
// The receipt is the only evidence that the factory created the order: status 1, an OrderCreated from the factory
// that was called, for the predicted escrow. A missing receipt or a different event is pending, not funded.
import { ORDER_CREATED_TOPIC } from "../engine/evm/factory.js";
import { escrowFromReceipt, fundingReceiptVerdict } from "../engine/evm/funding.js";

const factory = "0x" + "11".repeat(20);
const escrow = "0x" + "88".repeat(20);
const other = "0x" + "99".repeat(20);
const pad = (address) => "0x" + String(address).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const event = (address = factory, escrowAddress = escrow) => ({
  address,
  topics: [ORDER_CREATED_TOPIC, pad(escrowAddress), pad("0x" + "22".repeat(20)), pad("0x" + "33".repeat(20))],
  data: "0x" + "00".repeat(12 * 32),
});
const receipt = (status, logs, blockNumber = 42) => ({ status, logs, blockNumber });

let pass = 0;
const fails = [];
const ok = (m) => { pass += 1; console.log("  ok    " + m); };
const bad = (m) => { fails.push(m); console.log("  FAIL  " + m); };

console.log("=== 1) A MISSING RECEIPT IS PENDING ===");
{
  const v = fundingReceiptVerdict(null, { factory, expectedEscrow: escrow });
  if (v.status === "pending" && v.reason === "no-receipt") ok("no receipt -> pending no-receipt");
  else bad("no receipt -> " + JSON.stringify(v));
}

console.log("=== 2) A REVERTED RECEIPT IS NOT FUNDED ===");
{
  const v = fundingReceiptVerdict(receipt("0x0", [event()]), { factory, expectedEscrow: escrow });
  if (v.status === "reverted" && v.reason === "status-0") ok("status 0 -> reverted, even with an event");
  else bad("status 0 -> " + JSON.stringify(v));
}

console.log("=== 3) A RECEIPT WITHOUT THE EXPECTED EVENT IS PENDING ===");
{
  const empty = fundingReceiptVerdict(receipt("0x1", []), { factory, expectedEscrow: escrow });
  if (empty.status === "pending" && empty.reason === "no-order-created") ok("status 1, no OrderCreated -> pending");
  else bad("empty receipt -> " + JSON.stringify(empty));
  const wrongFactory = fundingReceiptVerdict(receipt("0x1", [event("0x" + "44".repeat(20))]), { factory, expectedEscrow: escrow });
  if (wrongFactory.status === "pending" && wrongFactory.reason === "no-order-created") ok("an event from another factory is not this order");
  else bad("wrong factory -> " + JSON.stringify(wrongFactory));
  const wrongEscrow = fundingReceiptVerdict(receipt("0x1", [event(factory, other)]), { factory, expectedEscrow: escrow });
  if (wrongEscrow.status === "pending" && wrongEscrow.reason === "no-order-created") ok("an event for another escrow is not this order");
  else bad("wrong escrow -> " + JSON.stringify(wrongEscrow));
}

console.log("=== 4) ONLY STATUS 1 WITH THE EXPECTED EVENT IS FUNDED ===");
{
  const v = fundingReceiptVerdict(receipt("0x1", [event()]), { factory, expectedEscrow: escrow });
  if (v.status === "funded" && v.escrow === escrow && v.birthBlock === 42) ok("status 1 + factory + escrow -> funded with the birth block");
  else bad("funded receipt -> " + JSON.stringify(v));
  const direct = escrowFromReceipt(receipt("0x1", [event()]), { factory, expectedEscrow: escrow });
  if (direct === escrow) ok("escrowFromReceipt keeps the expected address");
  else bad("escrowFromReceipt -> " + JSON.stringify(direct));
}

console.log("");
console.log(fails.length ? "FAILED: " + fails.length + " (passed " + pass + ")" : "funding receipt: " + pass + " checks passed.");
if (fails.length) process.exit(1);
