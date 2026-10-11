// THE RECOVERY FILE AS IT TRAVELS: the envelope a wallet writes and a sweep page reads back.
//
// A sweep page opens a file the user was given earlier and has to prove it is the file this protocol wrote, take
// the keys out of it and start scanning from the right height. Those rules live in the engine next to this file;
// this entry only NAMES them, so the page does not keep a copy of them to stay in step with the package.

export {
  ENVELOPE_VERSION,
  FILE_MAGIC,
  PAYLOAD_VERSION,
  buildPayload,
  createRecoveryFile,
  decryptFile,
  encryptPayload,
  envelopeAad,
  recoveryFileName,
  scanStartHeight,
  validatePayload,
} from "../../engine/recovery/recoveryFile.js";
