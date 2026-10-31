// THE DEFAULT FACTORY POLICY, AT THE ONE DOOR EVERY CALLER COMES THROUGH.
//
// The engine's network registry pins the deployed factory build by code hash. `engine/sdk/bridge.js` passed that
// list explicitly, but `createNinsei` did not: a browser caller with default options got no policy, so a quote
// naming any factory from the maker's registry was funded. The pin has to reach the core, not only the bridge.
//
// An explicit list from the caller still wins, including an empty array ("no policy" on purpose). Only absent or
// null is replaced by the network's list; a network with no deployed factory keeps null.
import * as engine from "./engine.mjs";

export function factoryCodesForChain({ chain, knownFactoryCodes } = {}) {
  if (knownFactoryCodes !== undefined && knownFactoryCodes !== null) return knownFactoryCodes;
  return engine.config.knownFactoryCodesFor(chain);
}

export function implementationCodesForChain({ chain, knownImplementationCodes } = {}) {
  if (knownImplementationCodes !== undefined && knownImplementationCodes !== null) return knownImplementationCodes;
  // `knownImplementationCodesFor` falls back to the default chain for an unknown id; a policy from another
  // network must not be applied here. Only an exact network record gets its pin.
  const id = typeof chain === "string" ? chain : chain && chain.id;
  const record = id ? engine.config.chainById(id) : null;
  if (!record || String(record.id) !== String(id)) return null;
  return engine.config.knownImplementationCodesFor(chain);
}
