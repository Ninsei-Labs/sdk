// THE NETWORK A NODE SAYS IT IS ON.
//
// A node answers `get_info` with `nettype` ("mainnet", "stagenet", "testnet"). A wallet MUST be built from that
// answer: a mainnet wallet against a stagenet node looks like a broken sweep, not like a wrong address. The
// mapping used to be a private function of the sweep page, which made "what a node may say" knowledge of one
// interface.
//
// REGTEST JOINS THEM BY ITS OFFICIAL NAME. monerod in regtest mode answers `fakechain`; the CI contour and every
// local stand run that mode, and the wallet's own network comes from the recovery file, not from this answer. Without
// the name the page refuses a node it is supposed to test against. It is a KNOWN name, not a wildcard.
//
// AN UNKNOWN ANSWER IS STILL NULL, NOT A GUESS. Defaulting to a network would build a wallet for a chain the node may
// not serve; the caller can then say which answer it got and stop.
const KNOWN = new Set(["mainnet", "stagenet", "testnet", "fakechain"]);

export function networkFromNode(info) {
  const type = String((info && info.nettype) || "").trim().toLowerCase();
  return KNOWN.has(type) ? type : null;
}
