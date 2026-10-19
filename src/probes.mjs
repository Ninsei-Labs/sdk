// IS THE NODE A WITHDRAWAL CAN USE, AND WHAT DOES IT SAY ABOUT ITSELF.
//
// The sweep page ran its own preflight: a request to get_info, a check for the height, a guess about the network.
// Every interface that withdraws needs the same answer, and a preflight that disagrees with the wallet builder is a
// page that says "ready" and then fails to open a wallet.
//
// ONE REQUEST, ONE ANSWER. `get_info` is what the node can be asked without a wallet: height, nettype, sync state and
// version. The answer names WHY it is not usable instead of a bare false - "unreachable" and "this node reports an
// unknown network" are different problems for the person.
//
// A TIMEOUT IS A REFUSAL, NOT A HANG: the request is abandoned after `timeoutMs` (8 seconds by default).
import { networkFromNode } from "../engine/monero/nodeNetwork.js";

const DEFAULT_TIMEOUT_MS = 8000;

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * Ask a Monero node for `get_info`.
 *
 * `fetchImpl` is injected (the browser's `fetch` by default) so a Node consumer and a test can pass their own.
 * The answer never throws: `{ ok: false, why }` names the problem.
 */
export async function probeMoneroNode({ url, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = text(url).replace(/\/+$/, "");
  if (!base) return { ok: false, why: "no-url" };
  if (typeof fetchImpl !== "function") return { ok: false, why: "no-fetch" };
  const started = Date.now();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)) : null;
  let response;
  try {
    response = await fetchImpl(base + "/json_rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
      signal: controller ? controller.signal : undefined,
    });
  } catch (error) {
    const aborted = error && (error.name === "AbortError" || error.code === "ABORT_ERR");
    return { ok: false, why: aborted ? "timeout" : "unreachable", ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response || !response.ok) {
    return { ok: false, why: "http", status: response ? response.status : null, ms: Date.now() - started };
  }
  let body = null;
  try { body = await response.json(); } catch { return { ok: false, why: "not-json", ms: Date.now() - started }; }
  if (!body || body.error) {
    return { ok: false, why: "rpc", rpc: body && body.error ? body.error.code ?? null : null, ms: Date.now() - started };
  }
  const info = body.result || {};
  const height = Number(info.height);
  if (!Number.isInteger(height) || height < 0) return { ok: false, why: "no-height", ms: Date.now() - started };
  // THE NETWORK THE NODE NAMES must be one the wallet builder accepts; an unknown word is not "probably stagenet".
  const network = networkFromNode(info);
  if (!network) return { ok: false, why: "nettype", nettype: info.nettype ?? null, ms: Date.now() - started };
  return {
    ok: true,
    url: base,
    height,
    network,
    nettype: info.nettype ?? null,
    synchronized: info.synchronized === true,
    version: info.version ?? null,
    status: info.status ?? null,
    ms: Date.now() - started,
  };
}
