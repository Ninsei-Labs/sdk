// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/dex.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// THE DEX LEG: a Uniswap v3 quote read from the chain. READ ONLY: eth_call, not one transaction.
//
// WHAT IS REPLACED HERE. The price breakdown used to hold a mock: "Uniswap v3 USDC/WETH 0.05%" and the spread
// 0.0004 came from config constants, i.e. the pool fee and the output were INVENTED. Now both are read from the
// chain itself via QuoterV2 - the same path the page already uses to read price and gas (evm/prices.js): a POST
// to chain.rpcUrl, no new domains, no new URL parameters and no new external addresses. The host is already
// allowed in CSP - it comes from the network registry.
//
// SELECTORS AND ARGUMENT SHAPE ARE TAKEN FROM A CALL, NOT FROM MEMORY (checked 2026-09-23):
//   * selector = keccak256(signature)[0..4]. Computed by a check from the signature string lying here next to
//     the selector, and the selector's presence is cross-checked in the contract CODE.
//   * THE ARGUMENTS GO AS FIVE CONSECUTIVE WORDS, WITHOUT AN OFFSET WORD. The signature formally takes a struct
//     (address,address,uint256,uint24,uint160) and by the ABI spec the first word should be the offset 0x20. ON
//     THE DEPLOYED QuoterV2 THAT IS FALSE: the offset variant REVERTS (execution reverted), while five consecutive
//     words answer with four (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate). So we encode
//     consecutively - and this is written here so nobody "fixes" the code to the spec and silently breaks the quote.
//
//
// WHAT THE MODULE DOES NOT DO: it sends no transactions, makes no approve, swaps nothing and does NOT touch the
// funding path. The gas figure here is the gasEstimate QuoterV2 itself returned (a number from the chain), not
// eth_estimateGas over someone else's transaction.
//
// AN HONEST "NO QUOTE" INSTEAD OF AN INVENTED NUMBER. An empty pool, no pool, a reverted quote and a price that
// diverged from the reference - FOUR DIFFERENT answers, each named in words (why). A number is returned only
// when the chain really named it and it passed the reference check.
//
// THE ROUTE IS DECLARED HERE, NOT CHOSEN. There is no runtime search for "a direct path or via a hub" and there
// must not be: a person declared the route in the registry (DEX_ROUTES), and the module only turns it into a path
// and asks the chain IN ONE CALL. If there is no declared route (or it is empty) - that is an honest "no route",
// the cause lies in the data (route.why), and such a leg blocks signing rather than looking for a detour.
//
// THE PRICE CHECK (priceGateVerdict) - A SECOND GUARD OF THE SAME FAMILY as coverage: a wrong price means the
// deal will not settle and signing does not start. It is computed two ways, neither needing a feed per token: the
// implied native price from the quote against the reference (Chainlink) and a "near 1:1" band on steps between
// stables (with no oracle at all). The thresholds are in the registry (DEX_PRICE_GATE), and the testnet exception
// is data too (a network's dexPriceGate): there the price is wrong by nature, and a wrong price is marked in
// words rather than stopping the flow. There is still no liquidity scoring here: pool depth is a person's call.
//

// Selectors. Next to each is the signature string it was computed from: the check recomputes keccak256 over these
// strings and fails if even one selector diverged from its signature.
// WHAT IS VERIFIED BY A CALL HERE (2026-09-23, Arbitrum One and Ethereum):
//   * quoteExactInputSingle 0xc6a5026a - a ONE-step quote, five consecutive words with no offset;
//   * quoteExactInput 0xcdca1753 - a WHOLE-PATH quote in one call. Signature quoteExactInput(bytes,uint256), the
//     selector found in the QuoterV2 code on both networks, and a single-step path checked against the single
//     quote gave EXACTLY the same number (36685744820778786 for 100 USDC), so the path encoding (20-byte address
//     + 3-byte fee, consecutively) is confirmed by a number, not from memory. There is no reference value - there
//     is a match of two DIFFERENT calls.
//
export const DEX_METHOD = {
  // THE EXACT-OUT SHAPE. This is NOT "how much comes out" but "receive exactly this much, spending no more than
  // that": with it the question of a difference in amounts does not exist at all.
  // BOTH shapes are confirmed by a call on Arbitrum One and mainnet:
  //   - the single one gives amountIn for exactly 0.035 WETH;
  //   - the multi-step on a two-leg path also answers, but ITS PATH IS SET IN REVERSE - from the received token
  //     to the paid one (a forward path fails: "Unexpected error"). This is measured, not deduced: getting the
  //     direction wrong here costs a call refusal.
  quoteExactOutputSingle: { hex: "0xbd21704a", signature: "quoteExactOutputSingle((address,address,uint256,uint24,uint160))" },
  quoteExactOutput: { hex: "0x2f80bb1d", signature: "quoteExactOutput(bytes,uint256)" },
  quoteExactInputSingle: { hex: "0xc6a5026a", signature: "quoteExactInputSingle((address,address,uint256,uint24,uint160))" },
  // The multi-step shape: the path is passed PACKED (token|fee|token|fee|token), the argument is dynamic, so the
  // offset is 0x40 here (see encodeQuoteExactInput), unlike the single shape.
  quoteExactInput: { hex: "0xcdca1753", signature: "quoteExactInput(bytes,uint256)" },
  getPool: { hex: "0x1698ee82", signature: "getPool(address,address,uint24)" },
  liquidity: { hex: "0x1a686502", signature: "liquidity()" },
  balanceOf: { hex: "0x70a08231", signature: "balanceOf(address)" },
  // withdraw on WETH9: NOT for sending, only for estimating the unwrap gas (and only if we have a measured WETH
  // holder - see the DEX quote check).
  withdraw: { hex: "0x2e1a7d4d", signature: "withdraw(uint256)" },
};

// THE PATH FROM THE DECLARED ROUTE (DEX_ROUTES in the registry). There is NO choice here: a person declared the
// steps with their fees, and we only map symbols to addresses. The wrapped native comes from the network data
// (u.wrapped), not written as the string "WETH": a BNB network's wrapped native is WBNB.
// Returns null and a cause if the declared route cannot be assembled (a step names a token this network does not
// have) - that is NOT "no route" but a data error, and it must be named differently.
export function declaredRoutePath({ token, tokens = [], wrapped, route }) {
  if (!token || !route || !Array.isArray(route.steps) || !route.steps.length) return null;
  const bySym = new Map((tokens || []).map((t) => [String(t.symbol).toUpperCase(), t]));
  const addrOf = (sym) => {
    const s = String(sym).toUpperCase();
    if (wrapped && s === String(wrapped.symbol).toUpperCase()) return wrapped.address;
    const t = bySym.get(s);
    return t && t.address ? t.address : null;
  };
  const symbols = [token.symbol];
  const addresses = [token.address];
  const fees = [];
  const pools = [];
  for (const step of route.steps) {
    const a = addrOf(step.to);
    if (!a) return { error: `declared route names a token that this network has no address for: ${step.to}` };
    addresses.push(a);
    symbols.push(String(step.to).toUpperCase() === String(wrapped && wrapped.symbol).toUpperCase() ? wrapped.symbol : step.to);
    fees.push(Number(step.fee));
    pools.push(step.pool || null);
  }
  return { tokens: addresses, symbols, fees, pools };
}

// The path as one string with step fees: "USDe → USDC 0.01% → WETH 0.05%". The same record in the interface and
// in the report - once they diverge they explain one thing to the person and another to the operator.
export function routeLabel(route) {
  if (!route || !route.symbols) return "";
  let s = route.symbols[0];
  for (let i = 0; i < route.fees.length; i++) s += " → " + route.symbols[i + 1] + " " + feeTierLabel(route.fees[i]);
  return s;
}

// Split the path into steps: [{from, to, fee, feeLabel}] - for the step-by-step line in the interface and report.
export function routeSteps(route) {
  if (!route || !route.symbols) return [];
  return route.fees.map((fee, i) => ({ from: route.symbols[i], to: route.symbols[i + 1], fee, feeLabel: feeTierLabel(fee) }));
}

const CACHE_MS = 20_000; // a quote lives 20 s: holding it longer is unsafe (the pool price moves), asking more often is needless

const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  return undefined;
}
function put(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function resetDexCache() {
  cache.clear();
}

// One eth_call to the network's node from the registry. Never throws: node silence is a UI state, not a screen
// crash (the same as in evm/prices.js).
async function rpc(chain, method, params = [], { timeoutMs = 15_000 } = {}) {
  if (!chain || !chain.rpcUrl) return { ok: false, why: "network has no RPC endpoint" };
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res.ok) return { ok: false, why: method + ": HTTP " + res.status };
    const json = await res.json();
    if (json.error) return { ok: false, why: method + ": " + String(json.error.message || "rpc error").slice(0, 120) };
    return { ok: true, result: json.result };
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return { ok: false, why: method + ": " + (aborted ? "no answer in " + timeoutMs + " ms" : String((e && e.message) || e)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- ABI encode/decode without libraries (the project has zero dependencies in app/) ----------------------
const hexBody = (s) => String(s || "").replace(/^0x/, "");
const word = (v) => hexBody(v).toLowerCase().padStart(64, "0");
// AN ADDRESS IS A WHOLE ABI WORD (24 zeros and 20 address bytes), not just 20 bytes. The bug here was exactly the
// opposite of the obvious one: the address was first padded with zeros to a word, and then the first 24 characters
// of the word were cut - i.e. the padding was thrown away and calldata carried arguments shifted by 12 bytes. The
// call reverted ("execution reverted") and it looked like "no liquidity in the pool" although the pool answered -
// our encoder lied (caught by comparing against a working call).
const addrWord = (a) => word(a);
const uintWord = (v) => {
  let h = "";
  let n = BigInt(v);
  while (n > 0n) {
    h = (n & 0xffn).toString(16).padStart(2, "0") + h;
    n >>= 8n;
  }
  return h.padStart(64, "0");
};
function decodeWords(hex) {
  const b = hexBody(hex);
  const out = [];
  for (let i = 0; i + 64 <= b.length; i += 64) out.push(BigInt("0x" + b.slice(i, i + 64)));
  return out;
}
export function encodeQuoteExactInputSingle({ tokenIn, tokenOut, amountInWei, fee, sqrtPriceLimitX96 = 0 }) {
  return (
    DEX_METHOD.quoteExactInputSingle.hex +
    addrWord(tokenIn) +
    addrWord(tokenOut) +
    uintWord(amountInWei) +
    uintWord(fee) +
    uintWord(sqrtPriceLimitX96)
  );
}
export function encodeGetPool({ tokenA, tokenB, fee }) {
  return DEX_METHOD.getPool.hex + addrWord(tokenA) + addrWord(tokenB) + uintWord(fee);
}

// THE INVERSE FOR ONE POOL: how much you must give to get EXACTLY amountOutWei. The layout is the same as the
// single input shape (the static struct goes INSIDE, with no offset word): address, address, amount, fee, price
// limit. Confirmed by a call, see DEX_METHOD.quoteExactOutputSingle.
export function encodeQuoteExactOutputSingle({ tokenIn, tokenOut, amountOutWei, fee, sqrtPriceLimitX96 = 0 }) {
  return DEX_METHOD.quoteExactOutputSingle.hex +
    addrWord(tokenIn) + addrWord(tokenOut) + uintWord(amountOutWei) + uintWord(fee) + uintWord(sqrtPriceLimitX96);
}

// EITHER HOW MUCH COMES OUT, OR WHY NOT - same as the input shape. Here this is NOT a forecast but the answer to
// "does the pool have enough to give exactly this much": the refusal IS "not enough".
export async function quoteExactOutSingle(chain, { tokenIn, tokenOut, amountOutWei, fee }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.quoter) return { ok: false, why: "no verified QuoterV2 for this network" };
  const data = encodeQuoteExactOutputSingle({ tokenIn, tokenOut, amountOutWei, fee });
  const res = await rpc(chain, "eth_call", [{ to: u.quoter, data }, "latest"], opts);
  if (!res.ok) return { ok: false, why: res.why };
  const words = decodeWords(res.result);
  if (!words.length) return { ok: false, why: "quoter answered without data" };
  if (words[0] <= 0n) return { ok: false, why: "pool cannot serve this output" };
  return {
    ok: true,
    amountInWei: words[0].toString(),
    gasEstimate: words.length > 1 ? words[words.length - 1].toString() : null,
  };
}

// THE INVERSE OVER THE WHOLE PATH: how much you must give to get EXACTLY amountOutWei.
// THE PATH GOES IN REVERSE HERE - from the received token to the paid one, with fees in the same reverse order.
// This is not our convention but the contract's requirement: a forward path fails ("Unexpected error"), a reverse
// one answers with a number. Measured on both networks, see DEX_METHOD.
// THE PREFERENCE FOR THIS SHAPE: with it the output minimum is not "roughly equal" to the required amount but
// exactly it, and the question "what to do with the difference" does not arise at all.
export async function quoteExactOutPath(chain, { route, amountOutWei }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.quoter) return { ok: false, why: "no verified QuoterV2 for this network" };
  if (!route || !Array.isArray(route.tokens) || route.tokens.length < 2) return { ok: false, why: "route has no path" };
  const tokens = route.tokens.slice().reverse();
  const fees = (route.fees || []).slice().reverse();
  const path = encodePath({ tokens, fees });
  // A dynamic argument (bytes) goes with an offset word: 0x40, then the exact output amount, then the path itself.
  const data = DEX_METHOD.quoteExactOutput.hex + uintWord(0x40) + uintWord(amountOutWei) + uintWord(path.bytes) +
    path.packed.padEnd(Math.ceil(path.packed.length / 64) * 64, "0");
  const res = await rpc(chain, "eth_call", [{ to: u.quoter, data }, "latest"], opts);
  if (!res.ok) return { ok: false, why: res.why };
  const out = decodeQuoteExactInput(res.result); // the answer shape is the same: amount, arrays, gas
  if (!out || out.amountOutWei <= 0n) return { ok: false, why: "pool cannot serve exactly this output" };
  return {
    ok: true,
    amountInWei: out.amountOutWei.toString(),
    gasEstimate: out.gasEstimate.toString(),
    shapeOk: out.sqrtPriceX96After.length === fees.length,
    reversed: tokens.map((x) => x).length === fees.length + 1,
  };
}

// THE PATH FOR A MULTI-STEP QUOTE. A Uniswap v3 path is a PACKED sequence "address(20) + fee(3)" with a trailing
// address: token0|fee0|token1|fee1|token2. There are no ABI words inside the path: 43 bytes per leg, 66 for two.
// Confirmed by a number: a single-step path through quoteExactInput returned exactly the same amountOut as
// quoteExactInputSingle on the same step.
export function encodePath({ tokens, fees }) {
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    parts.push(hexBody(tokens[i]).toLowerCase().padStart(40, "0"));
    if (i < fees.length) parts.push(hexBody(Number(fees[i]).toString(16)).toLowerCase().padStart(6, "0"));
  }
  const packed = parts.join("");
  return { packed, bytes: packed.length / 2 };
}

// THE CALL quoteExactInput(bytes path, uint256 amountIn) - ONE eth_call for the WHOLE route. Built to the ABI
// spec because the argument is dynamic here: an offset word (0x40), then amountIn, then the path length and the
// path itself, padded to a word boundary. HERE, UNLIKE THE SINGLE SHAPE, THE OFFSET IS REALLY NEEDED - the single
// shape takes a static struct and goes as consecutive words.
export function encodeQuoteExactInput({ tokens, fees, amountInWei }) {
  const { packed, bytes } = encodePath({ tokens, fees });
  const padded = packed.padEnd(Math.ceil(bytes / 32) * 64, "0");
  return DEX_METHOD.quoteExactInput.hex + word("0x40") + uintWord(amountInWei) + uintWord(bytes) + padded;
}
const wordToAddress = (w) => (w === undefined || w === null ? null : "0x" + w.toString(16).padStart(40, "0"));
const ZERO_ADDR = "0x" + "0".repeat(40);

// The step fee in percent: 500 -> "0.05%". This is the ONLY value that used to come from the mock, and now it is
// computed from the step itself rather than taken as a constant.
// Arithmetic: fee is measured in hundredths of a basis point, 1,000,000 = 100%. So percent = fee/10,000, i.e.
// 500 -> 0.05%. It first had ANOTHER division by 100 here, and step 500 was labelled "0.0005%" - the fee was
// understated a hundredfold (caught by a run, not by eye).
export function feeTierPct(fee) {
  const n = Number(fee);
  if (!Number.isFinite(n)) return null;
  return n / 10_000;
}
export function feeTierLabel(fee) {
  const pct = feeTierPct(fee);
  if (pct === null) return String(fee);
  return String(Number(pct.toFixed(4))) + "%";
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// The pool address at the factory. null - no pool (that is an ANSWER, not an error: nothing to change it into).
export async function poolAddress(chain, { tokenIn, tokenOut, fee }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.factory) return { ok: false, why: "no verified Uniswap factory for this network" };
  const res = await rpc(chain, "eth_call", [{ to: u.factory, data: encodeGetPool({ tokenA: tokenIn, tokenB: tokenOut, fee }) }, "latest"], opts);
  if (!res.ok) return { ok: false, why: res.why };
  const words = decodeWords(res.result);
  const pool = wordToAddress(words[0]);
  if (!pool || pool === ZERO_ADDR) return { ok: true, pool: null };
  return { ok: true, pool };
}

// Pool state: active liquidity and both-side reserves. Needed for an HONEST "no liquidity" answer: an empty
// pool quotes zero, and without this read we cannot tell "no pool" from "a pool exists but is empty". Read only
// on the diagnostic path (when there is no quote or it is implausible).
export async function poolState(chain, pool, { tokenIn, tokenOut }, opts = {}) {
  if (!pool) return null;
  const [liq, balIn, balOut] = await Promise.all([
    rpc(chain, "eth_call", [{ to: pool, data: DEX_METHOD.liquidity.hex }, "latest"], opts),
    rpc(chain, "eth_call", [{ to: tokenIn, data: DEX_METHOD.balanceOf.hex + addrWord(pool) }, "latest"], opts),
    rpc(chain, "eth_call", [{ to: tokenOut, data: DEX_METHOD.balanceOf.hex + addrWord(pool) }, "latest"], opts),
  ]);
  const one = (r) => (r.ok ? decodeWords(r.result)[0] ?? null : null);
  return {
    liquidity: liq.ok ? (BigInt(decodeWords(liq.result)[0] ?? 0n)).toString() : null,
    reserveInWei: balIn.ok && one(balIn) !== null ? one(balIn).toString() : null,
    reserveOutWei: balOut.ok && one(balOut) !== null ? one(balOut).toString() : null,
  };
}

// ONE QUOTE OF ONE STEP. A reverted quote is a NAMED refusal, not an exception.
export async function quoteTier(chain, { tokenIn, tokenOut, amountInWei, fee }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.quoter) return { fee, ok: false, why: "no verified QuoterV2 for this network" };
  const data = encodeQuoteExactInputSingle({ tokenIn, tokenOut, amountInWei, fee });
  const res = await rpc(chain, "eth_call", [{ to: u.quoter, data }, "latest"], opts);
  if (!res.ok) return { fee, ok: false, why: res.why };
  const words = decodeWords(res.result);
  if (words.length < 4) return { fee, ok: false, why: "quoter answered " + words.length + " words, expected 4" };
  const amountOut = words[0];
  if (amountOut <= 0n) return { fee, ok: false, why: "pool cannot serve this size" };
  return {
    fee,
    ok: true,
    amountOutWei: amountOut.toString(),
    gasEstimate: words[3].toString(),
    sqrtPriceX96After: words[1].toString(),
    initializedTicksCrossed: words[2].toString(),
  };
}

// Parsing the quoteExactInput answer. The answer DIFFERS from the single shape: (uint256 amountOut,
// uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate) - i.e. one element
// per path step in two of the arrays. Offsets are read from the answer itself, not assumed: the array lengths
// equal the number of path legs, and that can be CHECKED, not trusted.
export function decodeQuoteExactInput(hex) {
  const words = decodeWords(hex);
  if (words.length < 4) return null;
  const at = (w) => Number(w) / 32;
  const readArr = (w) => {
    const i = at(w);
    if (!Number.isInteger(i) || i < 0 || i >= words.length) return [];
    const n = Number(words[i]);
    if (!Number.isInteger(n) || n <= 0 || i + 1 + n > words.length) return [];
    return words.slice(i + 1, i + 1 + n).map(String);
  };
  return {
    amountOutWei: words[0],
    sqrtPriceX96After: readArr(words[1]),
    initializedTicksCrossed: readArr(words[2]),
    gasEstimate: words[3],
  };
}

// A WHOLE-PATH QUOTE IN ONE CALL. There is NO chain of "step 1 quote, then step 2 from its output": such a chain
// prices both steps against the same pool state and gives a optimistically wrong number.
export async function quotePath(chain, { route, amountInWei }, opts = {}) {
  const u = chain && chain.uniswap;
  if (!u || !u.quoter) return { ...route, ok: false, why: "no verified QuoterV2 for this network" };
  const data = encodeQuoteExactInput({ tokens: route.tokens, fees: route.fees, amountInWei });
  const res = await rpc(chain, "eth_call", [{ to: u.quoter, data }, "latest"], opts);
  if (!res.ok) return { ...route, ok: false, why: res.why };
  const out = decodeQuoteExactInput(res.result);
  if (!out) return { ...route, ok: false, why: "quoter answered a shape that is not quoteExactInput" };
  if (out.amountOutWei <= 0n) return { ...route, ok: false, why: "pool cannot serve this size" };
  return {
    ...route,
    ok: true,
    amountOutWei: out.amountOutWei.toString(),
    gasEstimate: out.gasEstimate.toString(),
    sqrtPriceX96After: out.sqrtPriceX96After,
    initializedTicksCrossed: out.initializedTicksCrossed,
    hops: route.fees.length,
    // THE ANSWER STEP COUNT IS CHECKED AGAINST THE PATH LEG COUNT: if the contract returned not one element per
    // step, this is not an answer we can read, and it is better to say so in words than to show a number at random.
    shapeOk: out.sqrtPriceX96After.length === route.fees.length,
  };
}

// THE DECLARED-ROUTE SIGNATURE: one string showing WHAT it is assembled from. Needed for the cache key: if the
// declaration changed (another fee, another hub), the old answer does not fit the new question.
export function routeSignature(route) {
  if (!route || !Array.isArray(route.steps) || !route.steps.length) return route && route.unwrap ? "unwrap" : "none";
  return route.steps.map((s) => String(s.to).toUpperCase() + ":" + Number(s.fee) + (s.pool ? ":" + String(s.pool).toLowerCase() : "")).join("+");
}

// ---------------------------------------------------------------------------
// THE PRICE CHECK: IS THE DEAL WRONG OR NOT.
//
// This is NOT liquidity scoring - that is still a person's job, and there are no verdicts about pool depth here.
// It is a check of the same kind as amount coverage: if the price is wrong the deal will not settle and must not
// start. A sign of a wrong price is taken TWO ways, and neither needs a feed per token (else USDe/USDS/PyUSD
// without their own feed would break the check entirely):
//
//   1) THE LAST STEP INTO NATIVE. The implied dollar price of native is derived from the quote (dollars in /
//      native out) and compared against the native price reference - the same Chainlink the page already reads
//      (evm/prices.js). This works for any input: a stable's dollar price is known from the registry, and the
//      rest end at native anyway;
//   2) A STEP BETWEEN TWO STABLES (USDe→USDC, USDS→USDC, PyUSD→USDC): the price must be near 1:1, and that is
//      checked BY THE QUOTE ITSELF, with no oracle at all. An absurdity like "100 USDe give 0.5 USDC" is caught
//      exactly here.
//
// THE THRESHOLDS COME IN AS DATA (the registry: DEX_PRICE_GATE), not as numbers here: changing them is a data edit.
// A NETWORK MARK tolerated (registry: dexPriceGate === "tolerated") CANCELS THE BLOCK BUT NOT THE FACT: the price
// stays wrong and is named so (bad), and the interface must show it. Thus a testnet does not stall on a price we
// did not choose, and does not pretend the price is market.
//
// The function is PURE: not one network call, only the leg numbers and the reference. So it can be run on any
// numbers without a network - which is how the guard is proven to go red (the DEX gate check).
// ---------------------------------------------------------------------------
export function priceGateVerdict({
  amountInWei = null, amountOutWei = null, inDecimals = null, outDecimals = null,
  tokenUsd = null, referenceUsd = null, stableSteps = [], tolerated = false, gates = null,
} = {}) {
  const maxDev = gates && Number.isFinite(Number(gates.maxDeviationPct)) && Number(gates.maxDeviationPct) > 0 ? Number(gates.maxDeviationPct) : null;
  const band = gates && Number.isFinite(Number(gates.stableBandPct)) && Number(gates.stableBandPct) >= 0 ? Number(gates.stableBandPct) : null;
  const why = [];

  // (1) STEPS BETWEEN STABLES: near 1:1, no oracle.
  const stable = (Array.isArray(stableSteps) ? stableSteps : []).map((s) => {
    const row = {
      from: s.from, to: s.to, fee: s.fee, feeLabel: feeTierLabel(s.fee),
      inWei: s.inWei || null, outWei: s.outWei || null, exactAmount: Boolean(s.exact),
      quoted: Boolean(s.ok), ok: false, ratio: null, deviationPct: null, why: null,
    };
    if (!s.ok) {
      // A STABLE-STABLE STEP DID NOT ANSWER - AND THAT IS NAMED, NOT SKIPPED: an unmeasured price does not pass
      // the check, else "we did not check" would look like "the price is fine".
      row.why = "the 1:1 step could not be quoted (" + (s.why || "no answer") + ")";
      why.push(row.why);
      return row;
    }
    const inUnits = Number(s.inWei) / 10 ** Number(s.inDecimals);
    const outUnits = Number(s.outWei) / 10 ** Number(s.outDecimals);
    if (!(inUnits > 0) || !(outUnits > 0)) {
      row.why = "the 1:1 step answered with a number that cannot be read";
      why.push(row.why);
      return row;
    }
    row.ratio = outUnits / inUnits;
    row.deviationPct = Math.abs(1 - row.ratio) * 100;
    if (band === null) { row.why = "the 1:1 band is not declared for this step, so this step cannot be checked"; why.push(row.why); return row; }
    if (row.deviationPct > band) {
      row.why = `${row.from}→${row.to} at ${row.feeLabel} pays ${row.ratio.toFixed(6)} ${row.to} per 1 ${row.from} - ${row.deviationPct.toFixed(2)}% off 1:1, and the band is ${band}%`;
      why.push(row.why);
      return row;
    }
    row.ok = true;
    return row;
  });

  // (2) THE IMPLIED NATIVE PRICE AGAINST THE REFERENCE.
  const inUnits = Number.isFinite(Number(inDecimals)) && Number(amountInWei) > 0 ? Number(amountInWei) / 10 ** Number(inDecimals) : null;
  const outUnits = Number.isFinite(Number(outDecimals)) && Number(amountOutWei) > 0 ? Number(amountOutWei) / 10 ** Number(outDecimals) : null;
  const valueUsd = inUnits !== null && Number(tokenUsd) > 0 ? inUnits * Number(tokenUsd) : null;
  const impliedUsd = valueUsd !== null && outUnits !== null && outUnits > 0 ? valueUsd / outUnits : null;
  const ref = Number(referenceUsd) > 0 ? Number(referenceUsd) : null;
  const deviationPct = impliedUsd !== null && ref !== null ? Math.abs(impliedUsd - ref) / ref * 100 : null;
  const nativeBad = deviationPct !== null && maxDev !== null && deviationPct > maxDev;
  if (nativeBad) {
    why.push(`the route implies the native coin at $${impliedUsd.toFixed(2)} while the reference price is $${ref.toFixed(2)} - ${deviationPct.toFixed(1)}% apart, and the limit is ${maxDev}%: this is not the market price`);
  } else if (deviationPct === null) {
    // NOT CHECKED IS NOT "ALL GOOD". We name the cause that made the check impossible.
    why.push(ref === null
      ? "the reference price of the native coin is not known, so the price cannot be checked"
      : "the price of the token being paid is not known, so the price cannot be checked");
  } else if (maxDev === null) {
    why.push("the price limit is not declared for this route, so the price cannot be checked");
  }

  // THE CHECK TOOK PLACE - so the NATIVE PART did (a reference exists, a limit is declared). Stable-stable steps
  // do not enter here on purpose: an unmeasured or out-of-band step is already bad (see above), not "unchecked".
  //
  const checked = deviationPct !== null && maxDev !== null;
  const bad = nativeBad || stable.some((r) => !r.ok);
  // DOES IT BLOCK: a wrong price - yes (except a network marked tolerated); an unchecked price - also yes, by the
  // same logic that blocks an unknown required amount: "we did not check" must not be shown as "checked and fine".
  // On a testnet neither blocks.
  const blocks = tolerated ? false : (bad || !checked);
  return {
    checked, bad, tolerated: Boolean(tolerated), blocks,
    why: why.length ? why.join("; ") : null,
    impliedUsd, referenceUsd: ref, deviationPct,
    maxDeviationPct: maxDev, stableBandPct: band,
    tokenUsd: Number(tokenUsd) > 0 ? Number(tokenUsd) : null,
    stable,
  };
}

// ---------------------------------------------------------------------------
// WHY THERE IS NO ROUTE - IN WORDS, AND THOSE WORDS COME FROM THE DATA. The cause lies in the declaration itself
// (route.why): it was written by the person declaring the route, and it is confirmed by measurement. The same
// wording in the interface and in the report: once they diverge they explain one thing to the person and another
// to the operator.
// A route is NOT in the registry at all (the token is there, no declaration) - that is ALSO an honest answer, not
// "not found": the detour was not declared, and signing on it does not start.
export function noRouteWords({ paySymbol, wrappedSymbol, chainName, route = null }) {
  // A TEMPLATE, NOT STRING GLUING: the text is the same, but the substring `from "` no longer appears in the source
  // (the gluing was accidentally read by the SDK bare-import check as a specifier). Same rule, same words.
  const head = `no route from ${paySymbol} to ${wrappedSymbol} on ${chainName}`;
  const why = route && route.why ? String(route.why) : null;
  // THE VISIBLE TEXT HAS NEITHER "registry" NOR "DEX_ROUTES": those are names of OUR machinery, not what a person
  // needs to understand. The meaning is the same: a route is not found by brute force, it is declared by a person.
  return why ? head + ": " + why : head + ": no route for " + paySymbol + " is declared - routes are declared by hand, not searched";
}


// ---------------------------------------------------------------------------
// THE LEG VERDICT: MAY ONE SIGN ON IT. Two guards OF ONE FAMILY, both BLOCKING signing:
//   * AMOUNT COVERAGE - the route must give at least what the order requires (the escrow amount);
//   * PRICE - the route price must be market (priceGateVerdict): a wrong price means the same as a shortfall -
//     the deal will not settle.
// It differs from observations exactly in this: "does not cover" and "the price is wrong" are FACTS just like "no
// pool", and they must stop the person BEFORE signing, not be shown as a line in the price breakdown. Hence the
// rule: the function returns either { blocked: false } or { blocked: true, kind, reason } - and the caller MUST
// honour blocked.
// There are no liquidity verdicts here: "covers 0.4% short" is a number, not a judgement of pool quality.
//
//   kind: "unquoted"            - there is no quote yet (nothing to ask, no waiting allowed: block)
//         "no-route"            - no route: causes lie in leg.why (the registry declaration + the chain refusal)
//         "price-unchecked"     - the price cannot be checked (no native price reference): block - "we did not
//                                 check" must not be shown as "checked and fine"
//         "bad-price"           - the price is not market: numbers in verdict.price (blocks on a live network)
//         "unchecked"           - the required amount is unknown (no XMR/native rate to compute it)
//         "short"               - a route exists but the output is LESS than required: here is by how much
//         "bad-price-tolerated" - the price is wrong but the network is marked dexPriceGate: signing is NOT
//                                 blocked, and the wrongness is NAMED (a testnet: testing the flow, not the market)
//         "covers"              - all agrees: signing allowed (the page's other guards stay in force)
//
// COVERAGE NUMBERS ARE RETURNED WHENEVER THEY ARE KNOWN (needWei/getsWei/shortfallWei/covers) - even when signing
// is locked by price: the person must see WHAT the verdict came from, not only the word "blocked".
//
//
// THE OUTPUT MINIMUM OF THE FUTURE SWAP COMES FROM HERE TOO - from the required escrow amount, not "by eye". So a
// shortfall is impossible by construction and any surplus stays with the user: there is NO automatic conversion of
// the remainder in the code and there must not be - funding deposits exactly the order amount, everything else
// stays with the person.
export function dexLegVerdict(leg, requiredOutWei = null) {
  if (leg && leg.unwrap) return { blocked: false, kind: "unwrap", reason: null, price: null };
  if (!leg) return { blocked: true, kind: "unquoted", reason: "the swap leg has not been quoted yet", price: null };
  if (!leg.ok) return { blocked: true, kind: "no-route", reason: leg.why || "no route", price: null };
  // THE PRICE COMES FROM THE LEG ITSELF: quoteDexOut computes it from the same chain answer as the output. A leg
  // without a price check (someone assembled it by hand) does not confirm this guard - there is nothing here to
  // check it with, so such a leg has no price verdict either.
  const price = leg.price || null;
  const priceBad = Boolean(price && price.bad);
  const priceUnchecked = Boolean(price && price.checked === false);
  const priceBlocks = Boolean(price && price.blocks && (priceBad || priceUnchecked));
  // THE REQUIRED AMOUNT COMES IN AS AN ARGUMENT, NOT TAKEN FROM THE LEG ITSELF: the quote lives in a 20 s cache,
  // while the person can change the order size at any moment. If we took the required amount from the cached
  // answer, the verdict would lag behind what the person sees in the form - exactly the case where a guard "exists
  // but does not fire".
  const need = requiredOutWei !== null && requiredOutWei !== undefined && Number(requiredOutWei) > 0 ? BigInt(requiredOutWei) : null;
  const gets = BigInt(leg.amountOutWei);
  const coverage = need === null ? null : {
    needWei: need.toString(), getsWei: gets.toString(), covers: gets >= need,
    shortfallWei: (gets >= need ? 0n : need - gets).toString(),
  };
  const base = {
    ...(coverage || {}),
    price,
    routeLabel: leg.routeLabel || null,
    decimals: leg.wrapped ? leg.wrapped.decimals : null,
    wrappedSymbol: leg.wrapped ? leg.wrapped.symbol : null,
  };
  // ORDER OF CAUSES: first "signing is impossible at all" (no route - above; price unchecked; price wrong), then
  // "the amount is short", then "all agrees". It matters: with a wrong price, the coverage numbers can no longer
  // be believed.
  if (priceBlocks) return { blocked: true, ...base, kind: priceBad ? "bad-price" : "price-unchecked", reason: price.why };
  if (coverage === null) {
    return { blocked: true, ...base, kind: "unchecked", reason: "the required escrow amount is not known yet, so coverage cannot be checked" };
  }
  if (!coverage.covers) return { blocked: true, ...base, kind: "short", reason: "the declared route returns less than the order needs" };
  if (priceBad) return { blocked: false, ...base, kind: "bad-price-tolerated", reason: price.why };
  return { blocked: false, ...base, kind: "covers", reason: null };
}

// ---------------------------------------------------------------------------
// The main entry for the page: how much native the payment with this token gives ALONG THE DECLARED ROUTE.
//
//   token              - the payment token from the registry (address, decimals and price)
//   amountWei          - the payment amount in its smallest units
//   requiredOutWei     - HOW MUCH NATIVE THE ORDER REQUIRES (the escrow amount for this input size). This is NOT
//                        an observation but a feasibility condition: from it the "covers / does not cover" verdict
//                        is computed, and "does not cover" blocks signing (see dexLegVerdict).
//   route              - the DECLARED route from the registry (DEX_ROUTES[chainId][symbol]). There is no choice
//                        here and there must not be: what is declared is what is quoted, in ONE call. No
//                        declaration, or an empty one - an honest "no route" (the words come from route.why), and
//                        signing on it does not start.
//   tokens             - this network's tokens: the address and decimals are taken by the symbol from the step
//   referenceNativeUsd - the REFERENCE native price in dollars (the page's Chainlink). Without it the price check
//                        cannot take place, and that is no reason to skip it (see priceGateVerdict).
//   gates              - the price-check thresholds from the registry (DEX_PRICE_GATE)
//
// THERE ARE NO HUBS HERE ANY MORE: a detour via USDC/USDT is also a declared route, not a runtime search.
//
// Returns EITHER { ok: true, ... } with numbers from the chain, OR { ok: false, why } in words. Numbers and "why
// not" are not returned together: showing a person both means asking him to guess which of the two answers to
// believe.
// ---------------------------------------------------------------------------
export async function quoteDexOut(chain, { token, amountWei, requiredOutWei = null, route = null, tokens = [], referenceNativeUsd = null, gates = null } = {}, opts = {}) {
  const u = chain && chain.uniswap;
  if (!token || !token.address) return { ok: false, why: token && token.native ? "paying the native coin needs no DEX leg" : "no token address" };
  if (!u || !u.quoter || !u.wrapped) return { ok: false, why: "no verified Uniswap addresses for " + (chain && chain.name ? chain.name : "this network") };
  const amount = BigInt(amountWei || 0);
  if (amount <= 0n) return { ok: false, why: "amount not entered" };
  const wrapped = u.wrapped;
  const chainName = (chain && chain.name) || (chain && chain.id) || "this network";
  if (String(token.address).toLowerCase() === String(wrapped.address).toLowerCase()) {
    // The wrapped native is changed to native NOT in a pool: this is a WETH9 withdraw, one to one.
    return { ok: false, why: "this is the wrapped native coin: no pool needed, it unwraps 1:1", unwrap: true };
  }
  const declared = route || null;
  // THE NETWORK MARK: a wrong price on a testnet does not block (registry: the network's dexPriceGate). A missing
  // mark blocks, and that is the default: a silent "it will do" on a live network is unacceptable.
  const tolerated = String((chain && chain.dexPriceGate) || "") === "tolerated";
  // THE DECLARATION WE USE IS RETURNED WHOLE (with steps, pools and a measurement date): the interface and the
  // report must name not only WHAT came out but WHAT it was declared from.
  const declaration = declared
    ? {
        steps: (Array.isArray(declared.steps) ? declared.steps : []).map((s) => ({ to: s.to, fee: s.fee, pool: s.pool || null, verified: s.verified || null })),
        why: declared.why || null, unwrap: Boolean(declared.unwrap),
      }
    : null;
  // (1) NO ROUTE IS AN ANSWER FROM THE DATA, NOT AN ERROR. Empty steps means "no declared route": why there is
  // none is in route.why, and those words go to both the interface and the report (the same ones).
  if (!declared || !Array.isArray(declared.steps) || !declared.steps.length) {
    if (declared && declared.unwrap) return { ok: false, why: "this is the wrapped native coin: no pool needed, it unwraps 1:1", unwrap: true };
    return { ok: false, why: noRouteWords({ paySymbol: token.symbol, wrappedSymbol: wrapped.symbol, chainName, route: declared }), declared: true, declaration, steps: [] };
  }
  // (2) A PATH FROM THE DECLARED STEPS. Failing to assemble the declaration (a step names a token this network
  // lacks) is a DATA error and must be named differently from "no route": it shows the registry needs an edit.
  const path = declaredRoutePath({ token, tokens, wrapped, route: declared });
  if (!path || path.error) {
    return {
      ok: false, declared: true, dataError: true, declaration,
      why: "the declared route for " + token.symbol + " on " + chainName + " cannot be built: " + ((path && path.error) || "unknown reason"),
    };
  }
  const byAddr = new Map((Array.isArray(tokens) ? tokens : []).filter((t) => t && t.address).map((t) => [String(t.address).toLowerCase(), t]));
  const dec = (addr) => {
    if (String(addr).toLowerCase() === String(token.address).toLowerCase()) return token.decimals;
    if (String(addr).toLowerCase() === String(wrapped.address).toLowerCase()) return wrapped.decimals;
    const h = byAddr.get(String(addr).toLowerCase());
    return h && Number.isFinite(Number(h.decimals)) ? Number(h.decimals) : null;
  };
  // (3) A 20 s CACHE BY NETWORK, TOKEN, AMOUNT AND DECLARATION SIGNATURE. Changing the declaration asks a
  // DIFFERENT route, and the old answer does not fit the new question. The required amount does NOT enter the
  // key: it changes with the order size, while coverage and price are computed below - every time, from fresh numbers.
  const key = [chain.id, token.symbol, amount.toString(), routeSignature(declared)].join("|");
  let base = cached(key);
  if (base === undefined) {
    // ONE CALL FOR THE WHOLE PATH. There is no chain of "step 1 quote, then step 2 from its output" here and
    // there must not be: such a chain prices both steps against one pool state and gives an optimistically wrong number.
    const quote = await quotePath(chain, { route: { tokens: path.tokens, fees: path.fees, symbols: path.symbols, via: null }, amountInWei: amount }, opts);
    if (!quote.ok) return put(key, { ok: false, why: quote.why, declared: true });
    base = { ok: true, quote };
    put(key, base);
  }
  if (!base.ok) return { ...base, declaration };
  const q = base.quote;
  // ROUTE POOLS ARE READ WHENEVER A QUOTE EXISTS - one record per leg. This is a FACT the person needs next to
  // the number: "the route answered so much" by itself does not say how much lies in the pools on his path.
  // Reserves in wei WITHOUT decimals are unreadable to a person, so decimals ride alongside - substituting 18
  // "by similarity" would mean one day showing a 6-decimal token as 18-decimal.
  if (base.hops === undefined) {
    const hops = [];
    for (let i = 0; i < path.fees.length; i++) {
      const fee = path.fees[i];
      const from = path.tokens[i], to = path.tokens[i + 1];
      const declaredStep = (declared.steps && declared.steps[i]) || {};
      const poolRes = await poolAddress(chain, { tokenIn: from, tokenOut: to, fee }, opts);
      const pool = poolRes.ok ? poolRes.pool : null;
      const declaredPool = declaredStep.pool || null;
      hops.push({
        step: i + 1, from: path.symbols[i], to: path.symbols[i + 1], fee, feeLabel: feeTierLabel(fee),
        decimals: [dec(from), dec(to)],
        pool,
        // CHECKING THE DECLARED POOL ADDRESS AGAINST THE CHAIN. If the factory answers another pool, the
        // declaration is stale: in the tool's report that is a failure, here a fact next to the number (a person decides).
        declaredPool,
        poolMatchesDeclared: pool && declaredPool ? String(pool).toLowerCase() === String(declaredPool).toLowerCase() : null,
        verified: declaredStep.verified || null,
        // POOL STATE IS NO LONGER READ HERE. Three eth_call calls per leg (liquidity(), balanceOf(tokenIn),
        // balanceOf(tokenOut)) were gathered for one line in the interface - liquidity, pool reserves - and that
        // line is removed: after a link to the pool a person checks depth and state in the explorer. The poolState
        // function itself stays: the tool's report calls it, and the operator needs those numbers there. Here they
        // are needed by nobody, while the page asks for them on every refresh.
      });
    }
    base.hops = hops;
  }
  const hops = base.hops;
  // STEPS BETWEEN TWO STABLES ARE CHECKED BY THE QUOTE ITSELF (near 1:1, with no oracle at all). The step amount
  // is the route amount: in declared routes such a step comes FIRST, so for it this is exactly its amount (and
  // that is marked by the exact field on every row).
  if (base.stableSteps === undefined) {
    const stables = (gates && Array.isArray(gates.stables) ? gates.stables : []).map((s) => String(s).toUpperCase());
    const steps = [];
    for (let i = 0; i < path.fees.length; i++) {
      const fromSym = String(path.symbols[i]).toUpperCase(), toSym = String(path.symbols[i + 1]).toUpperCase();
      if (!stables.includes(fromSym) || !stables.includes(toSym)) continue;
      const stepQuote = await quoteTier(chain, { tokenIn: path.tokens[i], tokenOut: path.tokens[i + 1], amountInWei: amount, fee: path.fees[i] }, opts);
      steps.push({
        from: path.symbols[i], to: path.symbols[i + 1], fee: path.fees[i],
        inWei: amount.toString(), outWei: stepQuote.ok ? stepQuote.amountOutWei : null,
        inDecimals: dec(path.tokens[i]), outDecimals: dec(path.tokens[i + 1]),
        ok: Boolean(stepQuote.ok), why: stepQuote.ok ? null : stepQuote.why, exact: i === 0,
      });
    }
    base.stableSteps = steps;
  }
  // THE PRICE CHECK. Computed EVERY TIME, not cached with the quote: the native price reference is loaded
  // separately and may appear later than the pool answer - exactly the same reason the coverage verdict is not
  // cached here either.
  const price = priceGateVerdict({
    amountInWei: amount, amountOutWei: q.amountOutWei,
    inDecimals: token.decimals, outDecimals: wrapped.decimals,
    tokenUsd: Number(token.usd) > 0 ? Number(token.usd) : null,
    referenceUsd: referenceNativeUsd,
    stableSteps: base.stableSteps, tolerated, gates,
  });
  // THE PREFERRED SHAPE: "receive EXACTLY the required amount, spending no more than entered". It is asked on the
  // same winning path but IN REVERSE - the contract requires exactly that. The answer matters not only as a
  // number: it removes the question of a difference in amounts, because the output minimum becomes equal to the
  // required amount by construction. A refusal here is also an answer: the pool does not give exactly that much,
  // and then the usual input shape remains, with a minimum from the required amount.
  let exactOut = null;
  if (requiredOutWei !== null && requiredOutWei !== undefined && Number(requiredOutWei) > 0) {
    const eo = await quoteExactOutPath(chain, { route: q, amountOutWei: BigInt(requiredOutWei) }, opts);
    exactOut = eo.ok
      ? {
          ok: true, amountInWei: eo.amountInWei, gasEstimate: eo.gasEstimate,
          // IS THE ENTERED AMOUNT ENOUGH: the input amount is compared, because with this shape the answer is
          // exactly "how much to give". Any surplus stays with the user: no conversion of the remainder in the code.
          enough: BigInt(eo.amountInWei) <= amount,
          enteredWei: amount.toString(),
          spareInWei: (BigInt(eo.amountInWei) <= amount ? amount - BigInt(eo.amountInWei) : 0n).toString(),
          shortInWei: (BigInt(eo.amountInWei) <= amount ? 0n : BigInt(eo.amountInWei) - amount).toString(),
        }
      : { ok: false, why: eo.why };
  }
  // COVERAGE IS COMPUTED HERE, NOT TAKEN FROM THE CACHE: the pool and input amount are cached for 20 s, but the
  // required amount comes from the order and may change (the person adjusted the XMR size) - and then coverage
  // must be recomputed, not left stale. Computed in whole wei.
  const required = requiredOutWei !== null && requiredOutWei !== undefined && Number(requiredOutWei) > 0
    ? (() => {
        const need = BigInt(requiredOutWei);
        const gets = BigInt(q.amountOutWei);
        return {
          outWei: need.toString(),
          getsWei: gets.toString(),
          covers: gets >= need,
          shortfallWei: (gets >= need ? 0n : need - gets).toString(),
        };
      })()
    : null;
  return {
    ok: true,
    leg: "pool",
    venue: "Uniswap v3",
    payToken: token.symbol,
    wrapped,
    // THE DECLARED ROUTE THE PRICE WAS ASKED ON: the steps, their pools and the measurement date - whole, as in the registry.
    // The interface must show not only WHAT came out but WHAT it was declared from.
    declaredRoute: declaration,
    // THE PATH IS THE STEPS WITH FEES, not one step: a declared detour via a stable has two.
    route: { symbols: q.symbols.slice(), fees: q.fees.slice(), pools: path.pools.slice(), via: null, hops: q.fees.length },
    routeLabel: routeLabel(q),
    steps: routeSteps(q),
    fee: q.fees[q.fees.length - 1],
    feeLabel: q.fees.map((f) => feeTierLabel(f)).join(" / "),
    amountInWei: amount.toString(),
    amountOutWei: q.amountOutWei,
    gasEstimate: q.gasEstimate,
    // THE FEASIBILITY VERDICT: whether the route covers the required order amount. null means "the required amount
    // was not passed" - and then signing is blocked as unverified (see dexLegVerdict), not allowed.
    required,
    // THE PRICE CHECK: whether it was done, whether the price looks market, and whether it blocks signing on this network.
    price,
    // THE PREFERRED SHAPE (exact output): how much to give to receive exactly the required amount.
    // The question of a difference in amounts does not arise with it - the output minimum equals the required by construction.
    exactOut,
    hopsDetail: hops,
    // The single step (the former answer shape) - from the first leg of the path. They must not be read as "the
    // whole route's pool", and that is said here: a detour via a hub has two legs.
    pool: hops.length ? hops[0].pool : null,
    at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// WETH -> ETH: an unwrap at WETH9 itself, one to one, WITHOUT a pool.
//
// This is where the "unwrap, 1:1" line description comes from. The gas estimate does NOT enter here: to name the
// unwrap gas one needs an account that holds WETH and can pay for gas, and the page has no such account (and
// nothing may be sent at this step). The measured unwrap gas lies in the tool's report (the gas is measured via
// eth_estimateGas on a real WETH holder, which the tool finds from Transfer logs). Substituting that number into
// the interface as "this deal's gas" would be a fake: it is measured on someone else's account and another
// amount. So, honestly: gasEstimate === null.
// ---------------------------------------------------------------------------
export function unwrapLeg(chain) {
  const u = chain && chain.uniswap;
  if (!u || !u.wrapped) return { ok: false, why: "no verified wrapped native coin for this network" };
  const w = u.wrapped;
  return {
    ok: true,
    leg: "unwrap",
    venue: w.name || w.symbol,
    wrapped: w,
    rate: 1, // one to one by WETH9's definition: withdraw(wad) returns exactly wad of native
    gasEstimate: null,
    why: null,
  };
}
