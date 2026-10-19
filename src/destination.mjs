// WHERE THE WITHDRAWAL GOES, AND WHETHER THAT IS WHO THE FILE PROMISED.
//
// The recovery file names the recipient the swap was made for. The page compared the address the person typed with
// the file's and showed a warning - a rule about the file, implemented in the interface that happens to read it.
// The comparison is not presentation: sending XMR to another address is a different payment.
//
// THE SHAPE IS CHECKED AGAINST THE FILE'S NETWORK. A stagenet file and a mainnet address is not "close enough": the
// transfer would go to another chain. The checksum is checked when the library is available; when it is not, the
// answer says so (`verified: false`) instead of pretending.
//
// A FILE WITHOUT A PROMISED ADDRESS IS NOT A FAILURE: `matches` is null, and the caller decides what to say.
import { checkAddress } from "../engine/monero/address.js";

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** The address the file promised, if it named one. */
export function promisedAddress(payload) {
  const receive = payload && payload.receive;
  const named = receive && typeof receive.address === "string" ? receive.address.trim() : "";
  return named || null;
}

/**
 * Compare a destination with the file's promise.
 *
 * `ok` answers "is this a usable address on the file's network"; `matches` answers "is it the promised one" and is
 * null when the file named none. `reason` is the library's own phrase when the shape is wrong.
 */
export async function checkDestination(payload, dest) {
  const address = text(dest);
  const promised = promisedAddress(payload);
  const network = (payload && payload.moneroWallet && payload.moneroWallet.network) || null;
  if (!address) {
    return { ok: false, dest: address, promised, matches: promised === null ? null : false, network, verified: false, reason: "no address" };
  }
  const shape = await checkAddress(address, network ? { expectNetwork: network } : {});
  return {
    ok: shape.ok === true,
    dest: address,
    promised,
    matches: promised === null ? null : address === promised,
    network,
    verified: shape.verified === true,
    reason: shape.reason || null,
  };
}
