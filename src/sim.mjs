// SANDBOX: failure scenarios and time. Added on requirement 8 of issue #32 - the interface lays out failure
// screens without waiting for a live testnet.
//
// What is deliberately absent, and why: scenarios are applied by the ENGINE (`www/js/mock`, the scenario fields
// on the swap), not by the SDK - the SDK merely names the scenarios and holds the interface's choice. Applying
// one to a swap will arrive together with `swaps.start` (stage 2), because a scenario is a property of the swap,
// not a global setting.
import * as engine from "./engine.mjs";
import { fail } from "./errors.mjs";

export const SCENARIOS = Object.keys(engine.config.SCENARIO_LABELS || {});

export function createSim() {
  let scenario = SCENARIOS[0] || null;
  let speedValue = 1;
  let advancedMs = 0;
  return {
    scenarios: () => SCENARIOS.slice(),
    apply(next) {
      if (!SCENARIOS.includes(next)) fail("bad-input", { field: "scenario", known: SCENARIOS });
      scenario = next;
    },
    speed(multiplier) {
      const value = Number(multiplier);
      if (!Number.isFinite(value) || value <= 0) fail("bad-input", { field: "speed" });
      speedValue = value;
    },
    advance(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value)) fail("bad-input", { field: "ms" });
      advancedMs += value;
    },
    // The sandbox's internal state: needed by the interface's debug panel and by `swaps.start` (stage 2). Named
    // `debug`, not `state`: this is not the swap state, and neither the interface nor a check should confuse them.
    debug: () => ({ scenario, speed: speedValue, advancedMs }),
  };
}
