// ONE ADDRESS CHECK FOR EVERY PATH THAT CAN MOVE MONEY.
//
// `checkAddress` answers the shape, the checksum and the network. A caller that forgets it used to be able to send
// XMR to a malformed address or to another Monero network; `sweep.sign` and `swaps.start` now share this boundary.
import { SdkError } from "./errors.mjs";
import { checkAddress } from "../engine/monero/address.js";

export async function checkAddressOrThrow(address, network, field) {
  const shape = await checkAddress(address, network ? { expectNetwork: network } : {});
  if (shape.ok === true) return;
  const wrongNetwork = /This is a .* address, but the swap runs on/.test(String(shape.reason || ""));
  throw new SdkError(wrongNetwork ? "wrong-chain" : "bad-input", { field, why: shape.reason || null });
}
