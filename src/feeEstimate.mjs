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

/**
 * A PER-BYTE price -> the fee for a transaction of `bytes`/weight. Monero's `get_fee_estimate` returns `fee` and
 * `fees` in atomic units per byte; dividing by 1024 made every estimate 1024 times too low.
 */
export function feeForBytes(feePerByte, bytes) {
  let perByte;
  let size;
  try { perByte = BigInt(feePerByte); size = BigInt(bytes); } catch { throw new RangeError("feeForBytes: whole numbers only"); }
  if (perByte < 0n || size < 0n) throw new RangeError("feeForBytes: negative input");
  return (perByte * size).toString();
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
 * The answer is a price per byte (and the daemon's own priority list, and its quantization mask). The exact sum
 * needs the assembled transaction; `feeForBytes` is the arithmetic that gets there. Never throws - a refusal names
 * the problem.
 */
export async function moneroFeeEstimate({ url, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // TRAILING SLASHES WITHOUT A REGEX: a pattern anchored on a run of slashes is flagged as a slow expression on
  // hostile input, and this value can be typed by a person.
  let base = text(url);
  while (base.endsWith("/")) base = base.slice(0, -1);
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
  // THE DAEMON'S OWN UNITS. `fee` and each entry of `fees` are atomic units PER BYTE; `quantization_mask` is the
  // unit the final fee is rounded to. `fee_per_kb` was never sent, so the old read found nothing on a real node and
  // the old fallback then divided per-byte values by 1024.
  const feePerByte = atomicField(result, "fee", "feePerByte");
  const quantizationMask = atomicField(result, "quantization_mask", "quantizationMask");
  const list = result.fees ?? result.feesPerByte ?? null;
  let perPriority = null;
  if (Array.isArray(list)) {
    perPriority = [];
    for (const value of list) {
      try { perPriority.push(BigInt(value).toString()); } catch { perPriority = null; break; }
    }
  }
  if (feePerByte === null && !perPriority) return { ok: false, why: "no-estimate" };
  return { ok: true, url: base, feePerByte, perPriority, quantizationMask };
}
