// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/prices.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// LIVE MARKET NUMBERS FOR THE EVM LEG: the native price (Chainlink on-chain) and the gas cost (RPC).
// WHY ON-CHAIN, NOT AN API: the price is a contract call over the same RPC already allowed by the CSP
// (connect-src), so no new external domain appears, there are no keys or rate limits, and the feed address is
// per chain. The feed addresses are NOT invented: each is confirmed by a call on chain (description() must match).
// WHAT IS NOT HERE: if a network has no feed or it is silent, return null and let the caller mark the number as demo.

const SELECTOR = {
  description: "0x7284e416", // description()
  latestRoundData: "0xfeaf968c", // latestRoundData() -> (roundId, answer, startedAt, updatedAt, answeredInRound)
};

const CACHE_MS = 60_000; // price: a minute balances freshness and request count
const GAS_CACHE_MS = 30_000; // gas changes more often, but it need not run on every keystroke
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // older than a day, the feed is stale and not shown as live

const cache = new Map(); // key: chainId + request kind

function cached(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  return undefined;
}

function put(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function rpc(chain, method, params = []) {
  const res = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(method + ": HTTP " + res.status);
  const j = await res.json();
  if (j.error) throw new Error(method + ": " + (j.error.message || "RPC error"));
  return j.result;
}

const word = (data, i) => BigInt("0x" + String(data).slice(2).slice(i * 64, (i + 1) * 64));

// ABI string decode: [offset][length][bytes]. Needed to tell the ETH/USD feed from another one. TextDecoder,
// not Buffer: this code runs in the browser.
function decodeString(data) {
  const s = String(data || "");
  if (s.length < 2 + 128) return "";
  const len = Number(BigInt("0x" + s.slice(2 + 64, 2 + 128)));
  const body = s.slice(2 + 128, 2 + 128 + len * 2);
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

// Native price in USD. null if the feed is missing, silent, or fails validation.
export async function nativeUsd(chain, { force = false } = {}) {
  const feed = chain && chain.priceFeed;
  if (!feed || !feed.address) return null;
  const key = chain.id + ":usd";
  if (!force) {
    const hit = cached(key, CACHE_MS);
    if (hit !== undefined) return hit;
  }
  try {
    const [descHex, roundHex] = await Promise.all([
      rpc(chain, "eth_call", [{ to: feed.address, data: SELECTOR.description }, "latest"]),
      rpc(chain, "eth_call", [{ to: feed.address, data: SELECTOR.latestRoundData }, "latest"]),
    ]);
    const desc = decodeString(descHex);
    const answer = word(roundHex, 1);
    const updatedAt = Number(word(roundHex, 3)) * 1000;
    const decimals = Number(feed.decimals || 8);
    const value = Number(answer) / 10 ** decimals;
    const fresh = updatedAt > 0 && Date.now() - updatedAt < MAX_AGE_MS;
    const sane = value >= (feed.min || 0.01) && value <= (feed.max || 1e7);
    if (desc !== feed.pair || !fresh || !sane) {
      return put(key, null); // null, not "roughly this": silence is more honest than a guess
    }
    return put(key, { usd: value, updatedAt, source: "chainlink", pair: desc });
  } catch {
    return put(key, null);
  }
}

// Gas cost in USD: limit estimate x gas price x native price. On Arbitrum the L1 part is already in the gas
// price, so no separate NodeInterface call is needed.
export async function gasUsd(chain, { from = null, payToken = null, amountWei = null } = {}) {
  const key = chain.id + ":gas";
  const hit = cached(key, GAS_CACHE_MS);
  if (hit !== undefined) return hit;
  const price = await nativeUsd(chain);
  if (!price) return put(key, null);
  try {
    const gasPrice = BigInt(await rpc(chain, "eth_gasPrice"));
    let gasLimit = null;
    let measured = false;
    // We estimate the transaction the person will actually sign: a transfer of the paying token.
    // The escrow is not deployed yet, so this is an honest lower bound, not the swap gas.
    try {
      // Without an account eth_estimateGas uses the ZERO address and a token transfer fails with
      // "ERC20: transfer from the zero address". So without `from` we do not estimate: we take a typical
      // limit and mark it as unmeasured. NOTE: "token transfer" and "has account" are DIFFERENT conditions.
      const tokenTransfer = Boolean(payToken && !payToken.native);
      if (tokenTransfer && from) {
        // transfer(address,uint256) = 0xa9059cbb
        const to = String(from || "").replace(/^0x/, "").padStart(64, "0");
        const value = BigInt(amountWei || 1).toString(16).padStart(64, "0");
        gasLimit = BigInt(await rpc(chain, "eth_estimateGas", [{ from, to: payToken.address, data: "0xa9059cbb" + to + value }]));
        measured = true;
      } else if (from) {
        gasLimit = BigInt(await rpc(chain, "eth_estimateGas", [{ from, to: from, value: "0x1" }]));
        measured = true;
      } else {
        // No account and no measurement: a typical limit and an honest 'not measured' flag.
        gasLimit = BigInt(chain.gasLimitFallback || (tokenTransfer ? 65000 : 21000));
      }
    } catch {
      gasLimit = BigInt(chain.gasLimitFallback || (tokenTransfer ? 65000 : 21000));
    }
    const wei = gasPrice * gasLimit;
    const usd = (Number(wei) / 1e18) * price.usd;
    return put(key, { usd, gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), native: price, source: "rpc", measured });
  } catch {
    return put(key, null);
  }
}

// One refresh point: fetch price and gas for the network and return what the interface can sign with.
export async function refreshChainPrices(chain, opts = {}) {
  if (!chain || !chain.rpcUrl) return { nativeUsd: null, gasUsd: null, source: "none" };
  const [price, gas] = await Promise.all([nativeUsd(chain), gasUsd(chain, opts)]);
  // The native price is shared by all network maths (balances, '~ $', gas), so it is written into the
  // network config, else the same number would live in two places and drift.
  if (price && Number.isFinite(price.usd)) chain.native.usd = price.usd;
  return {
    nativeUsd: price ? price.usd : null,
    nativeUpdatedAt: price ? price.updatedAt : null,
    gasUsd: gas ? gas.usd : null,
    // GAS PRICE IN WEI GOES OUT, not just the estimate cost. The order-action gas reserve is derived from it
    // (gasReserve.js): the mark and refund are different transactions with their own limits. No gas - null.
    gasPriceWei: gas ? gas.gasPrice : null,
    gasSource: gas ? gas.source : null,
    gasMeasured: gas ? Boolean(gas.measured) : false,
    source: price ? "chainlink" : "demo",
  };
}

// Short and one line, but covering BOTH halves: the string is "Gas & price", so both gas and price must be
// in the value. A live price shows as Chainlink, a demo one as 'demo values'.
export function priceLabel(info) {
  if (!info || !info.source || info.source === "none") return "demo values";
  if (info.source !== "chainlink") return "demo values";
  const when = info.nativeUpdatedAt ? new Date(info.nativeUpdatedAt).toISOString().slice(11, 16) : "?";
  const gas = info.gasMeasured ? "gas by RPC" : "gas estimate";
  return gas + ", price by Chainlink at " + when + " UTC";
}

export function resetPriceCache() {
  cache.clear();
}
