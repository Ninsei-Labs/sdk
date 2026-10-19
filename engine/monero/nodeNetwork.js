// THE NETWORK A NODE SAYS IT IS ON.
//
// A node answers `get_info` with `nettype` ("mainnet", "stagenet", "testnet"). A wallet MUST be built from that
// answer: a mainnet wallet against a stagenet node looks like a broken sweep, not like a wrong address. The
// mapping used to be a private function of the sweep page, which made "what a node may say" knowledge of one
// interface.
//
// AN UNKNOWN ANSWER IS NULL, NOT A GUESS. Defaulting to a network would build a wallet for a chain the node may not
// serve; the caller can then say which answer it got and stop.
const KNOWN = new Set(["mainnet", "stagenet", "testnet"]);

export function networkFromNode(info) {
  const type = String((info && info.nettype) || "").trim().toLowerCase();
  return KNOWN.has(type) ? type : null;
}
