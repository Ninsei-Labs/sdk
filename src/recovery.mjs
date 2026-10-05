// RECOVERY FROM FILE: parsing and integrity checks are done by the engine, the response shape by the SDK
// contract.
//
// The file arrives from the interface as a string or as `{ contents }`: the SDK knows neither about
// <input type=file> nor about buffers - that is the interface's business.
import * as engine from "./engine.mjs";
import { SdkError } from "./errors.mjs";

const contentsOf = (file) => {
  if (typeof file === "string") return file;
  if (file && typeof file.contents === "string") return file.contents;
  return null;
};

export function createRecovery() {
  return {
    async open(file, passphrase) {
      const contents = contentsOf(file);
      if (contents === null) throw new SdkError("bad-input", { field: "file" });
      let restored;
      try {
        restored = await engine.restore.restoreFromFile(contents, passphrase);
      } catch (error) {
        // Parsing, decryption and the address check live in the engine; a code goes out, not the engine's wording.
        throw new SdkError("recovery-failed", { stage: "restore" });
      }
      const payload = restored.payload || {};
      const wallet = restored.wallet || {};
      const halves = Number(payload.version) >= 3;
      return {
        address: typeof wallet.address === "string" ? wallet.address : null,
        // THERE IS NO SPEND KEY FROM THE HALVES, AND THERE CANNOT BE: in the halves scheme the second half
        // arrives from the chain once the counterparty takes the ETH. Observing - yes; disposing of funds -
        // only after the half is revealed.
        spendable: !halves,
        swapId: typeof payload.swapId === "string" ? payload.swapId : null,
      };
    },
  };
}
