// THE SHAPE OF A ROUTE PROVIDER - A MODULE OF ITS OWN SO THE SEAM AND THE PROVIDERS SHARE IT.
//
// A provider says WHICH WAY its swap settles, because the deal path differs by it. Uniswap and SushiSwap are router
// AMMs - the router runs INSIDE the user's transaction, so the swap and the escrow funding are ONE transaction
// ("sync"). CoWSwap is an intent auction - the person signs an intent and the settlement arrives LATER as a separate
// transaction sent by someone else ("async"). Hard-coding "one transaction" into the deal path would fit only the
// first and force a rewrite for the second, so the shape lives HERE and the path ASKS for it.
//
// WHY THIS FILE EXISTS APART FROM THE REGISTRY (legs/evm.mjs): the registry imports the concrete providers, and a
// provider imports the shape constants. Putting the constants in the registry would make the import a cycle
// (registry -> provider -> registry), and a cycle initialised at module load reads an uninitialised constant. So
// the shared vocabulary sits in its own module with no imports, and both sides depend on it.
export const SYNC = "sync";
export const ASYNC = "async";
export const SHAPES = [SYNC, ASYNC];

/**
 * IS A PROVIDER COMPLETE - may a path trust it. An answer as a VALUE, not an exception: { ok: true, shape } or
 * { ok: false, reason, ... }.
 *
 * The rule that matters: an ASYNCHRONOUS provider MUST declare what ends its execution - `settled(...)`, a check
 * that reads the outcome and answers whether the swap has ended and with what. A provider that cannot say this is
 * INCOMPLETE, and it is refused BY NAME ("provider-incomplete") rather than treated as synchronous or as finished.
 * The same refusal (not silence) is owed for a provider that declares no shape at all.
 */
export const providerShapeVerdict = (provider) => {
  if (!provider || typeof provider !== "object") return { ok: false, reason: "provider-absent" };
  if (provider.shape !== SYNC && provider.shape !== ASYNC) {
    return { ok: false, reason: "provider-shape-unknown", shape: provider.shape === undefined ? null : provider.shape };
  }
  if (provider.shape === ASYNC && typeof provider.settled !== "function") {
    return { ok: false, reason: "provider-incomplete", shape: ASYNC, missing: "settled" };
  }
  return { ok: true, shape: provider.shape };
};
