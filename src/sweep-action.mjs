// THE ORDER ACTION A RECOVERED HALF AUTHORIZES.
//
// A recovery caller finds an order on chain and needs two things: the half it can present, and the
// expectations the action's slot check compares against the live escrow. Both are derived here from the same
// found order and taker halves `sweep.fromOrder` already uses, so a page does not assemble a second copy of the
// order fields.
//
// THIS MODULE DECIDES NO STATE AND NO TIME. Whether the refund or claim window is open belongs to the caller:
// it reads the escrow's events and the order's deadlines. This function only says which action the half can
// authorize and what the live order must look like before signing.

import { SdkError } from "./errors.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const FIELD_RE = /^0x[0-9a-fA-F]{64}$/;
const INTEGER_RE = /^\d+$/;

const addressOf = (value) => (typeof value === "string" && ADDRESS_RE.test(value) ? value.toLowerCase() : null);
const fieldOf = (value) => (typeof value === "string" && FIELD_RE.test(value) ? value.toLowerCase() : null);

export function actionMaterialOf({ order = null, chainId = null, half = null } = {}) {
  if (!order || typeof order !== "object") throw new SdkError("bad-input", { field: "order" });
  const chain = Number(chainId);
  if (!Number.isSafeInteger(chain) || chain <= 0) throw new SdkError("bad-input", { field: "chainId" });
  const side = order.side;
  if (side !== "locker" && side !== "claimer") throw new SdkError("bad-input", { field: "order.side" });

  const escrow = addressOf(order.escrow);
  const locker = addressOf(order.locker);
  const claimer = addressOf(order.claimer);
  const factory = addressOf(order.factory);
  const salt = fieldOf(order.salt);
  const commitHalfLocker = fieldOf(order.commitHalfLocker);
  const commitHalfClaimer = fieldOf(order.commitHalfClaimer);
  const edPointLocker = fieldOf(order.edPointLocker);
  const edPointClaimer = fieldOf(order.edPointClaimer);
  const edViewPointLocker = fieldOf(order.edViewPointLocker);
  const ownHalf = fieldOf(half);
  const amount = typeof order.amount === "string" ? order.amount
    : typeof order.amount === "bigint" ? order.amount.toString() : null;
  const readyBy = Number(order.readyBy);
  const t1 = Number(order.t1);

  const missing = [];
  if (!escrow) missing.push("escrow");
  if (!locker) missing.push("locker");
  if (!claimer) missing.push("claimer");
  if (!factory) missing.push("factory");
  if (!salt) missing.push("salt");
  if (!commitHalfLocker) missing.push("commitHalfLocker");
  if (!commitHalfClaimer) missing.push("commitHalfClaimer");
  if (!edPointLocker) missing.push("edPointLocker");
  if (!edPointClaimer) missing.push("edPointClaimer");
  if (!edViewPointLocker) missing.push("edViewPointLocker");
  if (!ownHalf) missing.push("half");
  if (!amount || !INTEGER_RE.test(amount) || BigInt(amount) <= 0n) missing.push("amount");
  if (!Number.isSafeInteger(readyBy) || readyBy <= 0) missing.push("readyBy");
  if (!Number.isSafeInteger(t1) || t1 <= 0) missing.push("t1");
  if (missing.length) throw new SdkError("bad-input", { field: "order", missing });

  return Object.freeze({
    side,
    kind: side === "locker" ? "refund" : "claim",
    escrow,
    half: ownHalf,
    claimer,
    expect: Object.freeze({
      chainId: chain,
      factory, locker, claimer, amount, readyBy, t1, salt,
      commitHalfLocker, commitHalfClaimer, edPointLocker, edPointClaimer, edViewPointLocker,
    }),
  });
}
