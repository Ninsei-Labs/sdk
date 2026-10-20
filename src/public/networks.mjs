// THE NETWORK REGISTRY, FOR A CONSUMER THAT IS NOT THE BROWSER.
//
// The registry is one structure: each network names its chain id, its native coin, the tokens it accepts and,
// where it exists, the DEX deployment. A backend that validates a chain id and a token against it must read the
// same data the page reads, or the two drift apart silently.
//
// Names only: the engine owns the values. Nothing here is re-implemented.

export { ASYNC_ROUTE_PROVIDERS, CHAINS, DEFAULT_CHAIN, DEX_CHAINS } from "../../engine/core/config.js";
