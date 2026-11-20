// ONE ADDRESS CHECK FOR EVERY PATH THAT CAN MOVE MONEY.
//
// `checkAddress` answers the shape, the checksum and the network. A caller that forgets it used to be able to send
// XMR to a malformed address or to another Monero network; `sweep.sign` and `swaps.start` now share this boundary.
import { SdkError } from "./errors.mjs";
import { checkAddress } from "../engine/monero/address.js";

export async function checkAddressOrThrow(address, network, field) {
  const shape = await checkAddress(address, network ? { expectNetwork: network } : {});
  if (shape.ok === true) return;
  // THE NETWORK IS A FIELD, NOT A SENTENCE. The refusal still carries the human reason for the caller, but the
  // decision uses the actual network reported by `checkAddress`; editing its wording cannot reclassify the error.
  const wrongNetwork = shape.network !== undefined && network !== null
    && network !== undefined && shape.network !== network;
  throw new SdkError(wrongNetwork ? "wrong-chain" : "bad-input", { field, why: shape.reason || null });
}
