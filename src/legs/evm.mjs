// THE EVM LEG DRIVER. Everything the SDK knows about an EVM network as a settlement side.
//
// This is not the full leg yet: the escrow reads and writes (fund/markReady/claim/refund, the order state) will
// land here in stage 2. Already here: what the network is called for the wallet, how to tell that the wallet is on
// the right network, how balances are read, and the ROUTE-PROVIDER REGISTRY (our declared routes today, an
// external aggregator when it arrives).
export const vm = "evm";

/** What this network is called for the wallet: for EVM - a numeric chainId. */
export const walletChainId = (chain) => Number(chain.chainId);

/** Does the wallet's network match the settlement network. The comparison is VM-specific, so it lives in the driver. */
export const sameChain = (walletChainIdValue, chain) => {
  const want = walletChainId(chain);
  const got = Number(walletChainIdValue);
  return Number.isFinite(got) && Number.isFinite(want) && got === want;
};

// THE balanceOf(address) SELECTOR - 0x70a08231. It is not taken from memory: the same value is declared in the
// project (rfq/evm.mjs, "verified against the project's code") and used by the engine (www/js/evm/session.js). The
// match is checked by tools/check-sdk.mjs - it reads the engine's registry and fails if they diverge.
export const BALANCE_OF_SELECTOR = "0x70a08231";

const toMinimal = (hex) => {
  try {
    return BigInt(hex).toString(10);
  } catch {
    return null;
  }
};
const addrWord = (address) => String(address).replace(/^0x/, "").toLowerCase().padStart(64, "0");

/**
 * BALANCES: the native coin - eth_getBalance, a token - balanceOf via eth_call. decimals are taken from the
 * registry (they held the BSC trap), not from the chain's answer: the answer carries only the number in minimal
 * units.
 * Not read - null, not zero: zero would look like an empty wallet.
 */
export async function balances({ driver, address, tokens }) {
  const out = [];
  for (const token of tokens) {
    let amount = null;
    try {
      if (token.address === null) {
        amount = toMinimal(await driver.request({ method: "eth_getBalance", params: [address, "latest"] }));
      } else {
        const data = BALANCE_OF_SELECTOR + addrWord(address);
        amount = toMinimal(await driver.request({ method: "eth_call", params: [{ to: token.address, data }, "latest"] }));
      }
    } catch {
      amount = null;
    }
    out.push({ token: token.id, symbol: token.symbol, decimals: token.decimals, amount });
  }
  return out;
}

// THE ROUTE-PROVIDER REGISTRY (DEX/aggregator). Their role is one: turn what the person gives into what the escrow
// is funded with, and name the expected output. They DIFFER in the method: your own declared routes (DEX_ROUTES
// data in the engine's registry) or an external aggregator (1inch and the like).
//
// WHAT THIS GIVES: an aggregator becomes a CHOICE, not a rewrite - a new file and a line in this registry. The
// pre-signature guards are shared by all providers: the price is not market, the amount is covered, the token
// allowance - otherwise an external route would become a hole in those very guards.
//
// REQUIREMENT FOR A PROVIDER: id, kind, plan(...) -> { ok, expectedOutWei | code, route?, calldata?, to? }.
// Execution (assembling and sending the transaction) is stage 3; for now only our provider is declared, and its
// plan honestly answers with a code.
const ROUTE_PROVIDERS = {
  declared: {
    id: "declared",
    kind: "declared",
    async plan() {
      return { ok: false, code: "not-implemented", stage: 3 };
    },
  },
};

/** Who can execute a route at all. The list is needed by the "no such provider" error. */
export const routeProviders = () => Object.keys(ROUTE_PROVIDERS).sort();
export const routeProviderFor = (id) => ROUTE_PROVIDERS[id] || null;
