// THE PROVIDER SIDE, NODE ONLY: identity, signing and env files for the machine that runs the node.
//
// Separate entry, like ./adapters, because these helpers reach the filesystem and node:crypto. A browser
// consumer must never pull them in, and a Node consumer gets them with one import.
//
// WHY THEY LIVE HERE. The demo's backend verifies a maker's quote and builds an allow list from the provider's
// key; the node signs tickets with the same key. One implementation in the package means the identity rule and
// the key-path rule are not re-derived per consumer.

export {
  PROVIDER_CODE_RE,
  DISPLAY_NAME_MAX,
  providerCode,
  randomDisplayName,
} from "../provider/identity.mjs";

export {
  canonical,
  signPayload,
  verifyPayload,
  publicKeyPath,
  generateKeyFiles,
  privateKeySeedBytes,
  loadPrivateKey,
  publicKeyBase64From,
  signingPublicKeyBase64,
  publicKeyFileBase64,
  nodePublicKeyReport,
} from "../provider/sign.mjs";

export {
  ENV_CANDIDATES,
  findEnvFile,
  foreignPathProblem,
  foreignPathMessage,
  readEnvFile,
  substituteEnvVars,
  applyEnvFile,
} from "../provider/envFile.mjs";
