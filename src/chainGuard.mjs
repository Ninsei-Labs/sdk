// THE NETWORK A TRANSACTION IS ABOUT TO BE SIGNED ON.
//
// The wallet signs on whatever chain it currently serves, while the order, the escrow and the quote were assembled
// for `expect.chainId`. A wallet left on another network would sign a transaction the contract cannot accept - or,
// worse, one for a same-address contract on another chain. Read the wallet's chain immediately before the send and
// refuse a mismatch by name.
import { SdkError } from "./errors.mjs";

export async function assertWalletChain(wallet, chainId, step = "send") {
  const want = Number(chainId);
  if (!Number.isSafeInteger(want) || want <= 0) {
    throw new SdkError("bad-input", { field: "chainId", step });
  }
  // A wallet adapter that cannot answer its chain cannot prove which network it signs on. The production adapters
  // do answer; a caller bringing a bare send/receipt adapter is refused rather than sent blind.
  if (!wallet || typeof wallet.chainId !== "function") {
    throw new SdkError("bad-input", { field: "wallet.chainId", step });
  }
  let got = null;
  try { got = Number(await wallet.chainId()); }
  catch { throw new SdkError("wrong-chain", { vm: "evm", step, want, got: null, why: "unreadable" }); }
  if (!Number.isSafeInteger(got) || got <= 0) {
    throw new SdkError("wrong-chain", { vm: "evm", step, want, got: null, why: "unreadable" });
  }
  if (got !== want) throw new SdkError("wrong-chain", { vm: "evm", step, want, got });
  return want;
}
