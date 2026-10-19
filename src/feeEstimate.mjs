// WHAT A TRANSACTION WILL COST, ASKED FROM THE NODE THAT WILL CARRY IT.
//
// THE FEE = THE PRICE OF A BYTE × THE SIZE OF THE TRANSACTION. The price belongs to the network, not to the wallet:
// on Monero it moves with the median block load, so it is not set but ASKED - `get_fee_estimate` returns a price per
// kilobyte for several priorities. The size is known only after the transaction is assembled (rings, inputs, outputs),
// so this module answers the PRICE, and `feeForBytes` is the only arithmetic that turns it into a sum.
//
// The page used to learn the fee only after signing; a person deciding whether to withdraw should see it before.
//
// THE DAEMON ANSWERS IN snake_case AND THE LIBRARY RENAMES IT - both forms are accepted. A field the node did not send
// is null, never zero: zero is a legal price and would read as a free transaction.
const DEFAULT_TIMEOUT_MS = 8000;

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** A per-KB price -> the fee for a transaction of `bytes`, rounded UP: one unit short is still short. */
export function feeForBytes(feePerKB, bytes) {
  let perKB;
  let size;
  try { perKB = BigInt(feePerKB); size = BigInt(bytes); } catch { throw new RangeError("feeForBytes: whole numbers only"); }
  if (perKB < 0n || size < 0n) throw new RangeError("feeForBytes: negative input");
  return ((perKB * size + 1023n) / 1024n).toString();
}

const atomicField = (source, ...names) => {
  for (const name of names) {
    const value = source[name];
    if (value === undefined || value === null || value === "") continue;
    try { return BigInt(value).toString(); } catch { continue; }
  }
  return null;
};

/**
 * ASK A NODE WHAT A TRANSACTION WILL COST.
 *
 * The answer is a price per kilobyte (and the median, and the daemon's own priority list). The exact sum needs the
 * assembled transaction; `feeForBytes` is the arithmetic that gets there. Never throws - a refusal names the problem.
 */
export async function moneroFeeEstimate({ url, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = text(url).replace(/\/+$/, "");
  if (!base) return { ok: false, why: "no-url" };
  if (typeof fetchImpl !== "function") return { ok: false, why: "no-fetch" };
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)) : null;
  let response;
  try {
    response = await fetchImpl(base + "/json_rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_fee_estimate" }),
      signal: controller ? controller.signal : undefined,
    });
  } catch (error) {
    const aborted = error && (error.name === "AbortError" || error.code === "ABORT_ERR");
    return { ok: false, why: aborted ? "timeout" : "unreachable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response || !response.ok) return { ok: false, why: "http", status: response ? response.status : null };
  let body = null;
  try { body = await response.json(); } catch { return { ok: false, why: "not-json" }; }
  if (!body || body.error) return { ok: false, why: "rpc", rpc: body && body.error ? body.error.code ?? null : null };
  const result = body.result || {};
  const feePerKB = atomicField(result, "fee_per_kb", "feePerKB");
  const medianFeePerKB = atomicField(result, "median_fee_per_kb", "medianFeePerKB");
  const list = result.fees ?? result.feesPerKB ?? null;
  let perPriority = null;
  if (Array.isArray(list)) {
    perPriority = [];
    for (const value of list) {
      try { perPriority.push(BigInt(value).toString()); } catch { perPriority = null; break; }
    }
  }
  if (feePerKB === null && medianFeePerKB === null && !perPriority) return { ok: false, why: "no-estimate" };
  return { ok: true, url: base, feePerKB, medianFeePerKB, perPriority };
}
