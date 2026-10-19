// RECOVERY FROM FILE: parsing and integrity checks are done by the engine, the response shape by the SDK
// contract.
//
// The file arrives from the interface as a string or as `{ contents }`: the SDK knows neither about
// <input type=file> nor about buffers - that is the interface's business.
//
// THE RESTORE HEIGHT IS A RULE, NOT A LOOKUP THE PAGE PERFORMS. Two sources exist: the height written into the
// file when it was issued, and the height the service learned when it registered the wallet (it watches the
// address, so its row is often more precise). The order between them is the package's: the service's height wins
// when it is known, the file's is the fallback, and NO height is a named state - not a refusal, because the
// person can still type one.
import * as engine from "./engine.mjs";
import { SdkError } from "./errors.mjs";

const contentsOf = (file) => {
  if (typeof file === "string") return file;
  if (file && typeof file.contents === "string") return file.contents;
  return null;
};

export function createRecovery({ http = null, config = null } = {}) {
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

    // WHICH HEIGHT TO SCAN FROM, AND WHERE IT CAME FROM. The page used to run this lookup itself: it read the
    // file, then asked the service by address. Two readers of one rule is how a page and a package drift, so the
    // lookup lives here and the answer names its source.
    //
    // A SERVICE THAT DOES NOT ANSWER IS NOT A REFUSAL. The file's height is still a height; with neither, the
    // answer is `source: "none"` and the interface asks the person. The problem is a token, never a message.
    async restoreHeight(request = {}) {
      const contents = contentsOf(request.file);
      if (contents === null) throw new SdkError("bad-input", { field: "file" });
      if (typeof request.passphrase !== "string" || !request.passphrase) {
        throw new SdkError("bad-input", { field: "passphrase" });
      }
      // THE ENVELOPE IS PARSED HERE: `restoreFromFile` takes the OBJECT, while the file arrives as text. Doing it
      // in one place keeps "not JSON" a named stage instead of a library message.
      let envelope;
      try {
        envelope = JSON.parse(contents);
      } catch {
        throw new SdkError("recovery-failed", { stage: "parse" });
      }
      // ONLY THE PAYLOAD IS NEEDED, NOT A RESTORED WALLET: the height and the address live in the decrypted
      // payload, while restoring a wallet would rebuild keys from the halves - work this answer does not use, and
      // work that needs the browser's crypto vendor.
      let payload;
      try {
        payload = await engine.recoveryFile.decryptFile(envelope, request.passphrase);
        engine.recoveryFile.validatePayload(payload);
      } catch {
        throw new SdkError("recovery-failed", { stage: "restore" });
      }
      const wallet = payload.moneroWallet || {};
      const address = typeof wallet.address === "string" && wallet.address ? wallet.address : null;
      const fileHeight = Number(wallet.restoreHeight) || 0;

      let appHeight = 0;
      let appAsked = false;
      let appProblem = null;
      if (http && config && address) {
        appAsked = true;
        try {
          const answer = await http.json(config.route("swaps"));
          const rows = Array.isArray(answer) ? answer : ((answer && answer.swaps) || []);
          const row = rows.find((x) => String((x && x.address) || "") === String(address)) || null;
          appHeight = Number(row && row.restoreHeight) || 0;
          if (!row) appProblem = "no-row";
        } catch {
          appProblem = "unreachable";
        }
      }

      const height = appHeight > 0 ? appHeight : fileHeight;
      const source = appHeight > 0 ? "app" : (fileHeight > 0 ? "file" : "none");
      return {
        address,
        height,
        source,
        fileHeight,
        appHeight,
        appAsked,
        // Why there is no height, when there is none: a token the interface turns into words. Null when a height
        // was found, so a reader cannot mistake "found" for "asked and failed".
        appProblem: source === "none" ? (appProblem || "no-height") : null,
      };
    },
  };
}
