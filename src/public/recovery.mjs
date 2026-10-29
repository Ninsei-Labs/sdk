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
  isEncrypted,
  ALG_NONE,
  UNENCRYPTED_ENVELOPE_VERSION,
  recoveryFileName,
  scanStartHeight,
  validatePayload,
} from "../../engine/recovery/recoveryFile.js";

// ONE RECOVERY KEY FOR EVERY SWAP (sdk#79): the taker's key, its derivation, its file and the on-chain search.
export {
  RECOVERY_KEY_ALG,
  RECOVERY_KEY_DOMAIN,
  RECOVERY_KEY_DOMAIN_V2,
  RECOVERY_KEY_ENVELOPE_VERSION,
  RECOVERY_KEY_FILE_MAGIC,
  RECOVERY_KEY_ITER,
  RECOVERY_KEY_STORE,
  RECOVERY_KEY_VERSION,
  MAKER_VIEW_HALF_DOMAIN,
  RECOVERY_KEY_WORDS,
  RECOVERY_SCAN_DEFAULT,
  commitRecoveryIndex,
  createRecoveryKey,
  createRecoveryKeyFile,
  findSwaps,
  fingerprintOf,
  importRecoveryKey,
  loadRecoveryKey,
  newRecoverySalt,
  openRecoveryKeyFile,
  recoveryBinding,
  recoveryBindingV2,
  recoveryIndexTaken,
  recoverySaltOf,
  recoveryKeyFileName,
  recoveryKeyText,
  releaseRecoveryIndex,
  reserveRecoveryIndex,
  saveRecoveryKey,
  takerHalves,
  takerHalvesV2,
} from "../recovery-key.mjs";
