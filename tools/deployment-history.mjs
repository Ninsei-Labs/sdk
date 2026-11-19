// FACTORY-HISTORY VALIDATION, SHARED BY THE GENERATOR AND ITS CHECK.
//
// The history file is a recovery artifact: it tells a client which retired factory addresses belong to a network.
// The chain identity must survive normalization, otherwise the mainnet-only rule compares `undefined` with
// "42161" and rejects every valid mainnet history while accepting nothing.
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const networkPattern = /^[a-z0-9][a-z0-9-]*$/;
const positiveInteger = /^[1-9][0-9]*$/;

const fail = (message) => { throw new Error(message); };

export function normalizeHistory(manifest, label) {
  if (manifest.schema !== 1) fail(`${label}: history schema is ${JSON.stringify(manifest.schema)}, expected 1`);
  if (manifest.vm !== "evm") fail(`${label}: history vm ${JSON.stringify(manifest.vm)} has no validator yet`);
  if (typeof manifest.network !== "string" || !networkPattern.test(manifest.network)) fail(`${label}: bad network`);
  if (typeof manifest.chainRef !== "string" || !positiveInteger.test(manifest.chainRef)) fail(`${label}: bad chainRef`);
  if (manifest.caip2 !== `eip155:${manifest.chainRef}`) fail(`${label}: caip2 does not match chainRef`);
  if (!Array.isArray(manifest.factories) || manifest.factories.length === 0) fail(`${label}: factories is empty`);

  const seen = new Set();
  const factories = manifest.factories.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${label}: factories[${index}] is not an object`);
    if (!addressPattern.test(entry.address || "")) fail(`${label}: factories[${index}].address is not an address`);
    const address = entry.address.toLowerCase();
    if (seen.has(address)) fail(`${label}: duplicate factory ${entry.address}`);
    seen.add(address);
    const block = Number(entry.deploymentBlock);
    if (!Number.isSafeInteger(block) || block <= 0) fail(`${label}: factories[${index}].deploymentBlock is not a positive integer`);
    const tag = entry.release && entry.release.tag;
    if (typeof tag !== "string" || !tag.trim()) fail(`${label}: factories[${index}].release.tag is empty`);
    return { address: entry.address, deploymentBlock: block, release: { tag } };
  });
  return { network: manifest.network, chainRef: manifest.chainRef, factories };
}

// HISTORY IS MAINNET ONLY. A development chain replaces its factory on every switch; a retired entry there would
// make recovery search addresses no user should depend on.
export function historyVerdict(history, deployments) {
  if (!deployments[history.network]) return { ok: false, why: `history network ${history.network} has no deployment manifest` };
  if (history.chainRef !== "42161") {
    return { ok: false, why: `${history.network}: factory history is mainnet-only (chain 42161)` };
  }
  return { ok: true };
}
