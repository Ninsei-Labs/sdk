// THE REVEALED HALF IS A 32-BYTE SCALAR, NOT AN ADDRESS.
//
// `revealedHalf()` returns one ABI word: 32 bytes of the ed25519 scalar the settlement published. The withdrawal path
// used to read it as an address (`hex.slice(24)`), keeping only the last 20 bytes; `(s_a + s_b)·G` then never matched the
// order's spend point and every real withdrawal was refused. The parser is separate from the chain read so a guard can
// hand it the exact 32-byte word without a wallet or an RPC.
const WORD_RE = /^[0-9a-f]{64}$/;

export function revealedHalfWord(word) {
  const raw = String(word === undefined || word === null ? "" : word).trim();
  const hex = (raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw).toLowerCase();
  if (!WORD_RE.test(hex) || /^0+$/.test(hex)) return null;
  return "0x" + hex;
}
