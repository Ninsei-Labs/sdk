// THE XMR ARRIVAL CHECK - IN THE SDK CORE, ON TWO INDEPENDENT NODES.
//
// WHY HERE AND NOT IN OUR SERVICE. `ready` is the point of no return: after it the maker may take the ETH. Today
// the decision "the XMR arrived" is made by our backend (it holds the view key, scans our node, and the interface
// only shows that answer). The user cannot check it: if the answer is wrong - an indexer bug, a failure, a
// compromised server, a swapped node - the user marks ready under XMR that are not there and loses the ETH. So the
// decision moves into the client, which reads the chain itself with its own view key.
//
// TWO NODES OF DIFFERENT OPERATORS. A single node is a single truth that can lie. So `ready` opens only when at
// least two nodes belonging to DIFFERENT operators see THE WHOLE OBSERVATION THE SAME WAY: the same transaction in
// the same block, with the same output keys, the same decoded amounts (each backed by its Pedersen commitment) and
// the same unlock state. A failed or lagging node does not count and blocks nothing; a synced node that does not
// have the transaction, reports another block, or reports another amount is a DISAGREEMENT - the button stays closed
// and the screen says the nodes do not agree. When only one operator has confirmed, the core names that state
// (`one-node`) instead of waiting silently.
//
// WHERE THE RULE LIVES. "Locked by unlock_time is not an arrival" is ONE rule. It lives in the
// SDK's engine (engine/monero/unlock.js) and is read through the engine seam. The block parser lives beside it
// (engine/monero/scan.js) - a second copy would be a second truth about money.
//
// PRIVACY. Public nodes are asked for the WHOLE BLOCK (get_block plus /get_transactions over all of the block's
// hashes), never for a single transaction: otherwise a node links the user's IP to the trade. Requests carry
// `Content-Type: text/plain` (verified on every node in the default list - it avoids the CORS preflight).
//
// WHAT THE MAKER GIVES IS ONLY A REPORTED HINT. The maker's node may name the payout txid; the backend may relay
// it, but it does not narrow the walk and cannot hide another transfer. Every matching transfer is judged; the
// client scans blocks from the swap's birth height (a few dozen blocks).
import { SdkError } from "./errors.mjs";
import * as engine from "./engine.mjs";
import {
  WITNESS_SLICE_BLOCKS, parseWitnessSliceBody, witnessSliceEnd, witnessSliceIndex, witnessSliceStart,
} from "./witness-slice.mjs";

const isStr = (v) => typeof v === "string" && v.length > 0;
const intOf = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const txidOf = (v) => (isStr(v) ? v.trim().replace(/^0x/, "").toLowerCase() : null);
const hostOf = (url) => { try { return new URL(url).host; } catch { throw new SdkError("bad-input", { field: "nodes.url", unknown: url }); } };

// ONE FAILED REQUEST, IN THE SHAPE THE CALLER CAN SHOW. A node that did not answer is not evidence about the
// transaction; it is a visible reason: a timeout, a transport failure, an HTTP status or a bad answer. The list
// travels beside `checked`, so a pending or arrived verdict never hides a node that failed.
const failureOf = (error, node) => {
  const params = (error && error.params) || {};
  let code = "network";
  const why = params.why === undefined || params.why === null ? "" : String(params.why);
  // A BROWSER NAMES A TIMEOUT BY THE ERROR'S NAME, NOT ITS MESSAGE. Chromium says "signal timed out" where Node
  // says "The operation was aborted due to timeout"; the name is the one stable word. Check it before rewrapping
  // the answer as a bad one.
  const name = String(params.name || (error && error.name) || "");
  if (params.status !== undefined && params.status !== null) code = "http";
  else if (why === "cancelled") code = "cancelled";
  else if (/^(TimeoutError|AbortError)$/.test(name) || /timeout|abort/i.test(why) || /timeout|abort/i.test(name)) code = "timeout";
  else if (why === "bad-json" || why === "no-height" || why === "no-block" || why === "busy"
    || why === "partial-transactions" || why === "partial-answer" || why === "target-mismatch"
    || why === "spent-status" || why === "rpc-status" || why === "untrusted" || why === "ambiguous-answer"
    || why === "absence-unproven") code = "bad-answer";
  const out = { url: node.url, operator: node.operator, code };
  if (params.status !== undefined && params.status !== null) out.status = params.status;
  if (why) out.why = why;
  // A PARTIAL BATCH NAMES WHICH REQUEST FAILED. The outer failure list is what a caller sees; dropping the offset
  // here would make a multi-batch block look like one anonymous partial answer.
  for (const key of ["batchStart", "batchEnd", "total"]) {
    if (params[key] !== undefined && params[key] !== null) out[key] = params[key];
  }
  return out;
};

// A NODE LIST IS A LIST OF {url, operator}. The operator is what makes two nodes two witnesses: two nodes of one
// operator are one opinion. A plain string is accepted and its operator is the host - a user who adds their own
// node is the operator of it.
//
// `protocol` is an OPTIONAL capability, not a role. It is kept here so a slice-only witness can be named on the
// same list without inferring an endpoint from a standard daemon URL.
export function normalizeNodes(nodes) {
  if (!Array.isArray(nodes)) throw new SdkError("bad-input", { field: "nodes" });
  const out = [];
  for (const raw of nodes) {
    if (isStr(raw)) {
      const url = raw.replace(/\/+$/, "");
      out.push({ url, operator: hostOf(url) });
    } else if (raw && typeof raw === "object" && isStr(raw.url)) {
      const url = raw.url.replace(/\/+$/, "");
      const node = { url, operator: isStr(raw.operator) ? raw.operator : hostOf(url) };
      if (raw.protocol !== undefined && raw.protocol !== null) {
        if (!isStr(raw.protocol)) throw new SdkError("bad-input", { field: "nodes.protocol" });
        node.protocol = raw.protocol;
      }
      out.push(node);
    } else {
      throw new SdkError("bad-input", { field: "nodes", why: "each-node-is-url-or-url+operator" });
    }
  }
  if (!out.length) throw new SdkError("bad-input", { field: "nodes", why: "empty-list" });
  return out;
}

// ONE REQUEST. `text/plain` on purpose: the public nodes answer it without a preflight (verified on the whole
// default list). The response body is JSON even though the content type is not.
async function call(node, path, body, fetchImpl, timeoutMs, options = {}) {
  // THE IDLE BOUND IS ABOUT BYTES, NOT ABOUT A TOTAL REQUEST. A phone can stream a 100-transaction batch for
  // minutes as long as chunks keep arriving; it fails only when the stream stops. The old AbortSignal.timeout
  // covered the whole request and made every retry die at the same block.
  const controller = new AbortController();
  const external = options.signal;
  let idleTimer = null;
  let timedOut = false;
  const arm = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  };
  const onExternal = () => controller.abort();
  if (external && typeof external.addEventListener === "function") {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternal, { once: true });
  }
  const stop = () => {
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    if (external && typeof external.removeEventListener === "function") external.removeEventListener("abort", onExternal);
  };
  const failure = (error) => {
    if (error instanceof SdkError) return error;
    if (external && external.aborted) {
      return new SdkError("xmr-no-nodes", { node: node.url, name: "AbortError", why: "cancelled" });
    }
    if (timedOut) return new SdkError("xmr-no-nodes", { node: node.url, name: "TimeoutError", why: "timeout" });
    if (error && error.name === "SyntaxError") return new SdkError("xmr-no-nodes", { node: node.url, name: "SyntaxError", why: "bad-json" });
    return new SdkError("xmr-no-nodes", { node: node.url, name: String((error && error.name) || ""),
      why: String((error && error.message) || error).slice(0, 120) });
  };
  arm();
  let res;
  try {
    res = await fetchImpl(node.url + path, {
      method: "POST",
      headers: { "Content-Type": options.contentType || "text/plain" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    stop();
    throw failure(error);
  }
  if (!res || res.ok !== true) { stop(); throw new SdkError("xmr-no-nodes", { node: node.url, status: res ? res.status : null }); }
  try {
    // STREAM THE BODY WHEN THE TRANSPORT GIVES ONE. `getReader` is what lets the timer be reset per chunk; a
    // non-streaming test double falls back to `res.json` after counting one whole body.
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        if (value && value.byteLength) {
          if (typeof options.onBytes === "function") options.onBytes(value.byteLength);
          text += decoder.decode(value, { stream: true });
        }
      }
      text += decoder.decode();
      return JSON.parse(text);
    }
    if (typeof options.onBytes === "function") {
      try { options.onBytes((await res.clone().arrayBuffer()).byteLength); } catch { /* the body is the answer */ }
    }
    try {
      return await res.json();
    } catch (error) {
      if (timedOut || (external && external.aborted)) throw failure(error);
      throw new SdkError("xmr-no-nodes", { node: node.url, name: String((error && error.name) || ""), why: "bad-json" });
    }
  } catch (error) {
    throw failure(error);
  } finally {
    stop();
  }
}

async function getInfo(node, fetchImpl, timeoutMs, options = {}) {
  const j = await call(node, "/json_rpc", { jsonrpc: "2.0", id: "info", method: "get_info" }, fetchImpl, timeoutMs, options);
  const r = j && j.result;
  if (!r || !Number.isFinite(Number(r.height))) throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-height" });
  // A BUSY NODE HAS NOT FINISHED ITS OWN VIEW. Its height is not evidence that the walk was complete.
  if (r.busy === true || r.busy_syncing === true || (typeof r.status === "string" && r.status && r.status !== "OK")) {
    throw new SdkError("xmr-no-nodes", { node: node.url, why: "busy" });
  }
  // A MISSING `synchronized` FIELD IS NOT A SYNCHRONIZED NODE. Only an explicit true lets an empty walk count as
  // evidence of absence.
  return { height: Number(r.height), synced: r.synchronized === true, nettype: r.nettype || null };
}

// THE WHOLE BLOCK: its hash and ALL of its transaction hashes. This is the only form a public node is asked in.
async function getBlock(node, height, fetchImpl, timeoutMs, options = {}) {
  const j = await call(node, "/json_rpc", { jsonrpc: "2.0", id: "block", method: "get_block", params: { height } }, fetchImpl, timeoutMs, options);
  const r = j && j.result;
  if (!r) throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-block" });
  const hash = (r.block_header && r.block_header.hash) || null;
  const parent = (r.block_header && r.block_header.prev_hash) || null;
  const numTxes = r.block_header && Number.isFinite(Number(r.block_header.num_txes)) ? Number(r.block_header.num_txes) : null;
  let txHashes = Array.isArray(r.tx_hashes) ? r.tx_hashes : null;
  if (!txHashes) {
    const json = typeof r.json === "string" ? JSON.parse(r.json) : r.json;
    txHashes = (json && json.tx_hashes) || [];
  }
  return { hash, parent, numTxes, txHashes };
}

// ALL THE BLOCK'S TRANSACTIONS in bounded requests. Public monerod runs restricted and refuses more than 100
// hashes per `/get_transactions`; batching keeps the request shape legal without changing which txids are named.
const RESTRICTED_TRANSACTIONS_COUNT = 100;

async function getBlockTxs(node, hashes, fetchImpl, timeoutMs, options = {}) {
  if (!hashes.length) return [];
  const out = [];
  for (let start = 0; start < hashes.length; start += RESTRICTED_TRANSACTIONS_COUNT) {
    const batch = hashes.slice(start, start + RESTRICTED_TRANSACTIONS_COUNT);
    const batchOffset = { batchStart: start, batchEnd: start + batch.length, total: hashes.length };
    const j = await call(node, "/get_transactions", { txs_hashes: batch, decode_as_json: true }, fetchImpl, timeoutMs, options);
    const wrappers = Array.isArray(j.txs) ? j.txs : [];
    const bodies = Array.isArray(j.txs_as_json) ? j.txs_as_json : [];
    // A PARTIAL ANSWER IS NOT AN EMPTY BLOCK. If the node returns fewer transactions than the batch named, the walk
    // cannot conclude "no payment": that answer is unknown and must stop the refund path. The batch offset names the
    // exact request, not only the tail's size.
    if (bodies.length !== batch.length || (wrappers.length && wrappers.length !== batch.length)) {
      throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-transactions", want: batch.length, got: bodies.length, ...batchOffset });
    }
    const wanted = new Set(batch.map((hash) => String(hash).toLowerCase()));
    const parsed = bodies.map((s, i) => {
      let body;
      try { body = typeof s === "string" ? JSON.parse(s) : s; }
      catch { throw new SdkError("xmr-no-nodes", { node: node.url, why: "bad-json" }); }
      const w = wrappers[i] || {};
      body.tx_hash = String(w.tx_hash || body.tx_hash || "").replace(/^0x/, "").toLowerCase();
      body.block_height = w.block_height ?? null;
      body.confirmations = w.confirmations ?? null;
      return body;
    }).filter((body) => wanted.has(String(body.tx_hash || "").toLowerCase()));
    if (parsed.length !== batch.length) {
      throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-transactions", want: batch.length, got: parsed.length, ...batchOffset });
    }
    out.push(...parsed);
  }
  return out;
}

// The amount of our own outputs in a matched transaction (a swap can be paid in several outputs). An output whose
// amount did not match its Pedersen commitment is NOT money: it contributes zero, and the caller names it.
const sumOutputs = (hit) => hit.outputs.reduce((n, o) => n + (o.amountVerified ? (o.amountAtomic || 0n) : 0n), 0n);

// `Number(null)` IS 0. A missing confirmation count is not a mined transfer with zero confirmations; it is a
// missing field, so the block position supplies the fallback. This is used by every read that turns a daemon
// wrapper into a transfer.
const confirmationsOf = (tx, height, tipHeight) => {
  const raw = tx && tx.confirmations;
  if (raw === null || raw === undefined || raw === "") return Math.max(0, Number(tipHeight) - Number(height) + 1);
  const value = Number(raw);
  return Number.isFinite(value) ? value : Math.max(0, Number(tipHeight) - Number(height) + 1);
};

// A CALLER BUG IS NOT A NODE FAILURE. A throwing progress or checkpoint callback rejects the read with its own
// field; it must not appear in `failed` as if the daemon answered badly.
const callerFailure = (field, cause) => {
  const error = new SdkError("bad-input", { field, why: "callback-failed" });
  error.caller = true;
  error.cause = cause;
  return error;
};

// THE SAME TIE-BREAK IN THE EXACT AND THE SHADOW WALK. Score and amount decide first; two candidates that are
// equal on both are not interchangeable, because the report names one txid. The earlier block wins, and inside one
// block the lower txid wins - both walks see the same chain order.
const betterCandidate = (candidate, best) => {
  if (!best) return true;
  if (candidate.score !== best.score) return candidate.score > best.score;
  if (candidate.amountAtomic !== best.amountAtomic) return candidate.amountAtomic > best.amountAtomic;
  if (candidate.height !== best.height) return candidate.height < best.height;
  return String(candidate.txid).toLowerCase() < String(best.txid).toLowerCase();
};

/**
 * FIND THE BEST MATCHING TRANSFER. Blocks are walked from the swap's birth height upwards and the whole block is
 * asked for each height, so a public node never learns which transaction is ours. Every matching transfer is
 * judged: a full unlocked payout wins over dust or a locked one. The reported hint is not an input here.
 */
async function locate(node, { expectedAtomic, address, viewSecret, spendPub, fromHeight, toHeight, nowSec, fetchImpl, timeoutMs }) {
  const from = Math.max(0, intOf(fromHeight) ?? 0);
  const to = intOf(toHeight);
  if (!Number.isFinite(to) || to < from) throw new SdkError("bad-input", { field: "fromHeight", got: fromHeight });
  let best = null;
  for (let h = from; h <= to; h++) {
    const { txHashes } = await getBlock(node, h, fetchImpl, timeoutMs);
    if (!txHashes.length) continue;
    // EVERY BLOCK IS WALKED. The reported hint cannot hide a full payout in another block.
    const txs = await getBlockTxs(node, txHashes, fetchImpl, timeoutMs);
    for (const tx of txs) {
      const hit = engine.xmrScan.matchTransaction(tx, [{ address, viewSecret, spendPub }], {
        height: h, tipHeight: Math.max(0, to), nowSec,
      });
      // LOCATE FINDS AN OUTPUT, NOT AN AMOUNT. The amount can be forged or unbacked; the verification step below
      // refuses it. Requiring a positive verified sum here made two nodes that agreed on a forged amount look like
      // "no transaction at all".
      if (!hit.length) continue;
      const amountAtomic = sumOutputs(hit[0]);
      const amountVerified = hit[0].outputs.every((o) => o.amountVerified === true);
      const locked = hit[0].unlock && hit[0].unlock.locked === true;
      // JUDGE EVERY MATCHING TRANSFER. A dust transfer before the full payout is a real candidate but a worse
      // one; a full unlocked payout wins over a full locked one. The verification step still compares the chosen
      // transaction across operators.
      const score = (amountAtomic >= expectedAtomic ? 4 : 0) + (amountVerified ? 2 : 0) + (locked ? 0 : 1);
      const candidate = { txid: tx.tx_hash, height: h, score, amountAtomic };
      // A perfect score does not end the walk: another perfect candidate can tie on score and amount, and the
      // deterministic tie-break must decide which txid the caller is told about.
      if (betterCandidate(candidate, best)) best = candidate;
    }
  }
  return best;
}

/**
 * A MATCHING TRANSFER CAN BE IN THE POOL BEFORE IT IS IN A BLOCK. The exact walk cannot see it, so the site would
 * say "waiting for the maker's XMR" with no txid for a whole block interval. The pool is read as a WHOLE (all
 * hashes, then the existing batched `/get_transactions`), never by the caller's txid: a node must not learn which
 * transfer is being watched.
 *
 * A pool match is INFORMATION ONLY. It never counts as seen or arrived, and it does not change the two-operator or
 * confirmation rules; one synced node's pool is enough to show the txid while the block arrives.
 */
async function findPoolTransfer(node, { expectedAtomic, watched, tip, nowSec, fetchImpl, timeoutMs }) {
  const body = await call(node, "/get_transaction_pool_hashes", {}, fetchImpl, timeoutMs);
  const hashes = Array.isArray(body.tx_hashes)
    ? body.tx_hashes.map((hash) => String(hash).replace(/^0x/, "").toLowerCase()).filter((hash) => /^[0-9a-f]{64}$/.test(hash))
    : [];
  if (!hashes.length) return null;
  const txs = await getBlockTxs(node, hashes, fetchImpl, timeoutMs);
  let best = null;
  for (const tx of txs) {
    // `height: null` is right here: the transaction has no block yet. The tip still decides whether its unlock
    // time has matured, exactly as the block walk does.
    const hit = engine.xmrScan.matchTransaction(tx, [watched], { height: null, tipHeight: Math.max(0, tip), nowSec });
    if (!hit.length) continue;
    // AN UNVERIFIED AMOUNT IS NOT SHOWN AS A POOL PAYMENT. The same Pedersen check that guards `locate` must pass
    // before the report names an amount; otherwise a node could invent one without a key.
    if (!hit[0].outputs.every((o) => o.amountVerified === true)) continue;
    const amountAtomic = sumOutputs(hit[0]);
    const locked = hit[0].unlock && hit[0].unlock.locked === true;
    const score = (amountAtomic >= expectedAtomic ? 4 : 0) + 2 + (locked ? 0 : 1);
    // A POOL HAS NO HEIGHT. The deterministic tie-break still uses the lower txid, so two answers name one transfer.
    const candidate = { txid: tx.tx_hash, height: 0, score, amountAtomic, locked };
    if (betterCandidate(candidate, best)) best = { ...candidate, node, unlock: hit[0].unlock || null };
  }
  return best;
}

/**
 * VERIFY THE ARRIVAL. Returns a verdict, and refuses WITH A CODE where the money cannot be declared an arrival:
 *   xmr-locked          - the outputs are barred by the transaction's unlock_time (until a height or a date);
 *   xmr-underpaid       - the amount is less than expected;
 *   xmr-nodes-disagree  - a synced node has no such transaction in that block or a different block hash there;
 *   xmr-no-nodes        - every node in the list is unreachable.
 * While the money is simply not there yet, or only one operator has confirmed, it returns a WAITING state
 * (`pending` / `one-node`) - never a silent success.
 */
export async function verifyArrival(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  // THE DEFAULT ARRIVAL IS THE ONE READ, WITH THE SALE'S EXACT RULE. The old exact walk is kept as
  // `verifyArrivalLegacy` only for the checks that pin its historical answers.
  return verifyArrivalFromRead({ ...request, amountRule: request.amountRule ?? "exact" });
}

export async function verifyArrivalLegacy(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  if (request.amountRule !== undefined && request.amountRule !== null) return verifyArrivalFromRead(request);
  const nodes = normalizeNodes(request.nodes);
  if (!isStr(request.address)) throw new SdkError("bad-input", { field: "address" });
  if (request.viewSecret === undefined || request.viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
  if (request.spendPub !== undefined && request.spendPub !== null && !isStr(request.spendPub)) throw new SdkError("bad-input", { field: "spendPub" });
  let expectedAtomic;
  try { expectedAtomic = BigInt(request.expectedAtomic); } catch { throw new SdkError("bad-input", { field: "expectedAtomic" }); }
  if (expectedAtomic <= 0n) throw new SdkError("bad-input", { field: "expectedAtomic" });
  const minConfirmations = Math.max(1, intOf(request.minConfirmations) ?? 1);
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const nowSec = Number.isFinite(Number(request.nowSec)) ? Number(request.nowSec) : Math.floor(Date.now() / 1000);
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 20000;
  const txidHint = txidOf(request.txid);
  // THE KEY MUST BELONG TO THE ADDRESS, AND THE RULE LIVES IN THE ENGINE. Both facade paths call the same binding;
  // a public `scanRange` cannot accept the other byte-order reading while the facade refuses it.
  const bound = engine.xmrScan.watchedAddressVerdict({
    address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub,
  });
  if (!bound.ok) {
    if (bound.code === "bad-input") throw new SdkError("bad-input", { field: bound.field || "address", why: bound.why });
    throw new SdkError(bound.code, { field: bound.field || "address", address: request.address });
  }
  const viewSecret = bound.viewSecret;
  const spendPub = bound.spendPub;
  const watched = { address: request.address, viewSecret, spendPub };

  // 1. THE TIP, and with it the first proof that ANY node answers. All nodes down is a named refusal, not silence.
  const live = [];
  const failed = [];
  for (const node of nodes) {
    try { const info = await getInfo(node, fetchImpl, timeoutMs); live.push({ node, info }); }
    catch (error) { failed.push(failureOf(error, node)); /* a failed node does not count and blocks nothing */ }
  }
  if (!live.length) throw new SdkError("xmr-no-nodes", { tried: nodes.map((n) => n.url), nodes: failed });
  const tip = Math.max(...live.map((l) => l.info.height));
  // THE REPORTED HEIGHT IS THE NEXT BLOCK, NOT A REACHABLE ONE. monerod's get_info returns height = "the block that
  // will be mined next", so get_block(height) refuses with "greater than current top block". The backend already
  // knows this (app/watcher.mjs: "take top = height - 1"), and a live run against the contour's own node found the
  // same off-by-one here: walking to `tip` inclusive threw xmr-no-nodes on the very last block instead of returning
  // `pending`. The reachable top is one below.
  const top = Math.max(0, tip - 1);

  // 2. LOCATE: from the birth height, by whole blocks. The first reachable node does the walk.
  let located = null;
  const completedOperators = new Set();
  const staleWitnesses = [];
  for (const { node, info } of live) {
    // A WITNESS THAT IS NOT SYNCHRONIZED HAS NOT SEEN THE RANGE. Counting its empty walk as absence would let two
    // nodes that restarted behind the payout height refund a paid swap; the same rule already guards the positive
    // branch below. The stale entry is reported only when it is evidence about absence; an arrived verdict has a
    // synced witness and must not carry a stale one as a failure.
    if (!info.synced) {
      staleWitnesses.push({ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" });
      continue;
    }
    try {
      located = await locate(node, { expectedAtomic, address: request.address, viewSecret, spendPub, fromHeight: request.fromHeight, toHeight: top, nowSec, fetchImpl, timeoutMs });
      if (!located) completedOperators.add(node.operator);
    } catch (error) {
      failed.push(failureOf(error, node));
      located = null;
    }
    if (located) break;
  }
  if (!located) {
    // A POOL TRANSFER IS NOT AN ARRIVAL, BUT ITS TXID IS REAL INFORMATION. Read the whole pool on every synced
    // node and return the match before the absence path: one node's pool is enough to show the id, while `seen`
    // stays false and the confirmation rule stays untouched.
    let poolHit = null;
    const poolFailed = [];
    const poolChecked = new Set();
    for (const { node, info } of live) {
      if (!info.synced) { continue; }
      try {
        const hit = await findPoolTransfer(node, {
          expectedAtomic, watched, tip: top, nowSec, fetchImpl, timeoutMs,
        });
        poolChecked.add(node.operator);
        if (hit) { poolHit = hit; break; }
      } catch (error) {
        poolFailed.push({ ...failureOf(error, node), why: "pool-read" });
      }
    }
    if (poolHit) {
      return {
        seen: false, state: "pool", absent: false, txid: poolHit.txid, height: null,
        amountAtomic: poolHit.amountAtomic.toString(), amountVerified: true,
        confirmations: 0, locked: poolHit.locked, unlock: poolHit.unlock,
        tip, operators: [poolHit.node.operator], poolFrom: { url: poolHit.node.url, operator: poolHit.node.operator },
        checked: live.map((l) => ({
          url: l.node.url, operator: l.node.operator, height: l.info.height, synchronized: l.info.synced,
          state: l.node === poolHit.node ? "pool" : "pool-no-match",
        })),
        failed: [...failed, ...poolFailed],
      };
    }
    failed.push(...poolFailed);
    failed.push(...staleWitnesses);
    // ABSENCE IS A CLAIM ABOUT MONEY, SO IT NEEDS TWO OPERATORS. One node can withhold a transaction and make
    // this walk look empty; a refund signed on that answer would take the depositor's ETH from a maker who paid.
    // ONLY A NODE WHOSE POOL WAS ALSO READ COUNTS. A completed block walk with a failed pool read is unknown
    // about the mempool, and a transfer relayed only there must not become `absent: true`.
    const absenceOperators = [...completedOperators].filter((operator) => poolChecked.has(operator));
    // Only when no node finished the walk is every node unreachable.
    if (!completedOperators.size) {
      // A LIVE BUT UNSYNCHRONIZED NODE IS UNKNOWN, NOT ABSENT. Returning pending keeps the refund closed while
      // naming the stale witness in `failed`; xmr-no-nodes would say the nodes did not answer, which they did.
      if (live.some((entry) => !entry.info.synced)) {
        return { seen: false, state: "pending", absent: false, txid: txidHint, tip,
          completedOperators: [], checked: live.map((l) => ({ url: l.node.url, operator: l.node.operator, height: l.info.height, synchronized: l.info.synced })), failed };
      }
      throw new SdkError("xmr-no-nodes", { tried: nodes.map((n) => n.url), nodes: failed });
    }
    return { seen: false, state: "pending", absent: absenceOperators.length >= 2, txid: txidHint, tip, completedOperators: absenceOperators, checked: live.map((l) => ({ url: l.node.url, operator: l.node.operator, height: l.info.height, synchronized: l.info.synced })), failed };
  }

  // 3. VERIFY ON EVERY NODE: the SAME block hash, the SAME transaction inside it, the confirmations and the money.
  const seen = [];
  for (const node of nodes) {
    const record = { url: node.url, operator: node.operator };
    let info;
    try { info = await getInfo(node, fetchImpl, timeoutMs); }
    catch (error) { record.state = "down"; record.failure = failureOf(error, node); failed.push(record.failure); seen.push(record); continue; }
    // A LAGGING NODE IS NOT A WITNESS and is not a disagreement: it simply cannot see the block yet.
    if (!info.synced || info.height < located.height) { record.state = "stale"; record.height = info.height; seen.push(record); continue; }
    // A WITNESS THAT ANSWERED HAS A HEIGHT, whether it is still confirming or already arrived; the caller can say
    // "answered, height N" without inferring it from the block only when the state is stale.
    record.height = info.height;
    let block;
    try { block = await getBlock(node, located.height, fetchImpl, timeoutMs); }
    catch (error) { record.state = "down"; record.failure = failureOf(error, node); failed.push(record.failure); seen.push(record); continue; }
    record.blockHash = block.hash;
    // A SYNCED NODE WITHOUT THIS TRANSACTION IN THAT BLOCK IS A DISAGREEMENT (it may hold a different block hash).
    if (!block.hash || !block.txHashes.includes(located.txid)) { record.state = "no-tx"; seen.push(record); continue; }
    let body = null;
    try { body = (await getBlockTxs(node, block.txHashes, fetchImpl, timeoutMs)).find((t) => t.tx_hash === located.txid) || null; }
    catch (error) { record.state = "down"; record.failure = failureOf(error, node); failed.push(record.failure); seen.push(record); continue; }
    if (!body) { record.state = "no-tx"; seen.push(record); continue; }
    // THE LOCK IS JUDGED AT THE WITNESS'S TIP, NOT AT THE BLOCK THAT MINED THE TRANSFER. `located.height` stays for
    // confirmations; a height lock that has matured is no longer `xmr-locked`.
    const hit = engine.xmrScan.matchTransaction(body, [watched], {
      height: located.height,
      tipHeight: Math.max(0, info.height - 1),
      nowSec,
    });
    if (!hit.length) { record.state = "no-output"; seen.push(record); continue; }
    record.state = "ok";
    record.amountAtomic = sumOutputs(hit[0]);
    record.amountVerified = hit[0].outputs.every((o) => o.amountVerified === true);
    record.outputs = hit[0].outputs.map((o) => ({
      index: o.index,
      key: String(o.key || "").replace(/^0x/, "").toLowerCase(),
      amountAtomic: o.amountVerified ? String(o.amountAtomic ?? null) : null,
      amountVerified: o.amountVerified === true,
      derivation: String(o.derivation || "").replace(/^0x/, "").toLowerCase(),
    }));
    record.unlock = hit[0].unlock;
    // Confirmations of a block: top - height + 1, and top = info.height - 1 (see above), so this is height - located.
    record.confirmations = confirmationsOf(body, located.height, info.height);
    // A NODE THAT CHANGED THE AMOUNT IS A DISAGREEMENT, NOT A WITNESS. The commitment check above is what
    // makes this observable: without it an altered ecdhInfo.amount would still look like a valid output.
    if (!record.amountVerified) { record.state = "amount-unverified"; seen.push(record); continue; }
    // THE WHOLE OBSERVATION, NOT A BLOCK HASH. Two nodes must agree on the transaction id, the block, every
    // output key and amount, and the unlock state. A block hash alone let one node change the amount and still
    // form its own group; that is exactly the finding this closes.
    record.observation = {
      txid: located.txid,
      blockHash: String(block.hash || "").replace(/^0x/, "").toLowerCase(),
      outputs: record.outputs,
      unlock: record.unlock ? {
        locked: record.unlock.locked === true,
        untilHeight: record.unlock.untilHeight ?? null,
        untilTime: record.unlock.untilTime ?? null,
      } : null,
    };
    seen.push(record);
  }

  // A DISAGREEMENT CLOSES THE BUTTON - it is named, and the nodes and observations travel in the params.
  const disagreeing = seen.filter((r) => r.state === "no-tx" || r.state === "no-output" || r.state === "amount-unverified");
  if (disagreeing.length) {
    throw new SdkError("xmr-nodes-disagree", {
      txid: located.txid, height: located.height,
      nodes: disagreeing.map((r) => ({ url: r.url, operator: r.operator, blockHash: r.blockHash || null, why: r.state, outputs: r.outputs || null })),
      agreed: seen.filter((r) => r.state === "ok").map((r) => ({ url: r.url, operator: r.operator, blockHash: r.blockHash })),
      failed,
    });
  }

  const okay = seen.filter((r) => r.state === "ok");
  if (!okay.length) return { seen: false, state: "pending", txid: located.txid, height: located.height, checked: seen, failed };

  // THE OBSERVATIONS MUST BE IDENTICAL. Grouping by the whole observation (not just the block hash) means a
  // node that reports a different amount, output key or unlock state does not count as agreeing with anyone.
  const byObservation = new Map();
  for (const r of okay) {
    const key = JSON.stringify(r.observation);
    if (!byObservation.has(key)) byObservation.set(key, { observation: r.observation, operators: new Set(), nodes: [] });
    const g = byObservation.get(key);
    g.operators.add(r.operator);
    g.nodes.push(r);
  }
  if (byObservation.size > 1) {
    throw new SdkError("xmr-nodes-disagree", {
      txid: located.txid, height: located.height,
      nodes: okay.map((r) => ({ url: r.url, operator: r.operator, blockHash: r.blockHash || null, outputs: r.outputs, why: "observation" })),
      agreed: [], failed,
    });
  }
  const best = [...byObservation.values()][0];
  // A node that is further along is not a liar: the minimum is the figure every witness can support. What
  // matters is that the transaction itself is identical; confirmations only decide when the button opens.
  const confirmations = Math.min(...best.nodes.map((r) => r.confirmations));
  const amountAtomic = best.nodes[0].amountAtomic;
  const agreedBy = best.nodes.map((r) => ({ url: r.url, operator: r.operator, blockHash: r.blockHash, confirmations: r.confirmations }));

  // LOCKED IS NOT AN ARRIVAL, and the rule for that is the shared one, in the SDK engine.
  const locked = best.nodes.find((r) => r.unlock && r.unlock.locked);
  if (locked) {
    const until = locked.unlock;
    throw new SdkError("xmr-locked", { txid: located.txid, height: located.height, address: request.address,
      untilHeight: until.untilHeight ?? null, untilTime: until.untilTime ?? null, failed });
  }

  // THE AMOUNT IS NOT LESS THAN EXPECTED. A shortfall is named rather than shown as a completed swap. The figure
  // comes from the agreed observation, never from the largest answer of one node: that maximum was the defect.
  if (amountAtomic < expectedAtomic) {
    throw new SdkError("xmr-underpaid", { txid: located.txid, height: located.height, got: amountAtomic.toString(), want: expectedAtomic.toString(), failed });
  }

  if (best.operators.size < 2) {
    return { seen: false, state: "one-node", txid: located.txid, height: located.height, blockHash: best.observation.blockHash,
      amountAtomic: amountAtomic.toString(), outputs: best.observation.outputs, confirmations, operators: [...best.operators], agreedBy, checked: seen, failed };
  }
  if (confirmations < minConfirmations) {
    return { seen: false, state: "pending", why: "confirmations", txid: located.txid, height: located.height, blockHash: best.observation.blockHash,
      amountAtomic: amountAtomic.toString(), outputs: best.observation.outputs, confirmations, needConfirmations: minConfirmations, agreedBy, checked: seen, failed };
  }
  return { seen: true, state: "arrived", txid: located.txid, height: located.height, blockHash: best.observation.blockHash,
    amountAtomic: amountAtomic.toString(), outputs: best.observation.outputs, confirmations, needConfirmations: minConfirmations,
    operators: [...best.operators], agreedBy, checked: seen, failed };
}

/**
 * RECOVERY READ CANNOT USE THE QUOTE'S AMOUNT. A seller may send less than the quote (an exchange fee), more, or
 * several transfers. The recovery path therefore walks the same whole blocks and returns EVERY matching transfer
 * with its verified outputs, instead of choosing one candidate shaped by `expectedAtomic`.
 */
function recoveryObservation(tx, hit, node, { height, blockHash, confirmations, pool = false }) {
  const outputs = hit[0].outputs.map((o) => ({
    index: o.index,
    key: String(o.key || "").replace(/^0x/, "").toLowerCase(),
    amountAtomic: o.amountVerified ? String(o.amountAtomic ?? null) : null,
    amountVerified: o.amountVerified === true,
    derivation: String(o.derivation || "").replace(/^0x/, "").toLowerCase(),
  }));
  const amountAtomic = sumOutputs(hit[0]);
  return {
    txid: String(tx.tx_hash || "").replace(/^0x/, "").toLowerCase(),
    height, blockHash, confirmations, pool,
    outputs,
    amountAtomic: amountAtomic.toString(),
    amountVerified: hit[0].outputs.every((o) => o.amountVerified === true),
    locked: !!(hit[0].unlock && hit[0].unlock.locked),
    unlock: hit[0].unlock || null,
    url: node.url, operator: node.operator,
  };
}

// THE TRUSTED NODE'S SPENT ANSWER. Key images are linkable, so only the selected primary node gets them; a witness
// never does. A short, long or non-integer list is unreadable, not "unspent". Status 1 is a confirmed spend,
// status 2 is a spend still in the pool.
async function readSpentStatus(node, tracked, fetchImpl, timeoutMs, options = {}) {
  if (!tracked.provided || tracked.byImage.size === 0) return { spends: [], complete: true, failed: [] };
  const images = [...tracked.byImage.values()].map((record) => record.keyImage);
  try {
    const body = await call(node, "/is_key_image_spent", { key_images: images }, fetchImpl, timeoutMs,
      { ...options, contentType: "application/json" });
    if (!body || body.status !== "OK") throw new SdkError("xmr-no-nodes", { node: node.url, why: "rpc-status" });
    const statuses = body && Array.isArray(body.spent_status) ? body.spent_status : null;
    if (!statuses || statuses.length !== images.length
        || !statuses.every((value) => Number.isInteger(value) && value >= 0 && value <= 2)) {
      throw new SdkError("xmr-no-nodes", { node: node.url, why: "spent-status" });
    }
    const spends = [];
    statuses.forEach((status, index) => {
      if (status !== 1 && status !== 2) return;
      const record = tracked.byImage.get(images[index]);
      spends.push({ keyImage: images[index], outputKey: record ? record.outputKey : null,
        txid: null, height: null, blockHash: null, pool: status === 2, source: "spent-status" });
    });
    return { spends, complete: true, failed: [] };
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    return { spends: [], complete: false, failed: [{ ...failureOf(error, node), why: "spent-status" }] };
  }
}

const UNKNOWN_TOTALS = { receivedAtomic: null, spentAtomic: null, unspentAtomic: null, withdrawalState: "unknown" };

// THE WINDOW'S MONEY, IN ONE PLACE. A window whose received amount is known is "empty", "unspent", "withdrawn" or
// "partly-withdrawn"; an output whose amount is unverified makes every total unknown, never a partial sum.
function recoveryTotals(transfers, tracked, spends) {
  if (!tracked.provided) return { receivedAtomic: null, spentAtomic: null, unspentAtomic: null, withdrawalState: "unknown" };
  const spent = new Set(spends.map((spend) => spend.keyImage));
  let received = 0n;
  let spentTotal = 0n;
  let complete = true;
  for (const transfer of transfers) {
    for (const output of transfer.outputs || []) {
      if (!output.amountVerified || output.amountAtomic === null || output.amountAtomic === undefined) {
        complete = false;
        continue;
      }
      const keyImage = tracked.byOutput.get(String(output.key || "").toLowerCase());
      if (!keyImage) { complete = false; continue; }
      received += BigInt(output.amountAtomic);
      if (spent.has(keyImage)) spentTotal += BigInt(output.amountAtomic);
    }
  }
  if (!complete) return { receivedAtomic: null, spentAtomic: null, unspentAtomic: null, withdrawalState: "unknown" };
  const unspent = received - spentTotal;
  const withdrawalState = received === 0n ? "empty"
    : spentTotal === 0n ? "unspent"
      : spentTotal === received ? "withdrawn" : "partly-withdrawn";
  return { receivedAtomic: received.toString(), spentAtomic: spentTotal.toString(),
    unspentAtomic: unspent.toString(), withdrawalState };
}

// A TRANSFER'S CONFIRMATIONS AND LOCK ARE FACTS ABOUT THE TIP, NOT ABOUT THE READ THAT FOUND IT. A checkpoint
// stores the observation, but resuming at a later tip must not keep the old counts or the old lock state.
function refreshTransferState(transfers, { tipHeight, nowSec }) {
  for (const transfer of transfers) {
    if (transfer.pool || !Number.isSafeInteger(Number(transfer.height))) continue;
    transfer.confirmations = Math.max(0, Number(tipHeight) - Number(transfer.height) + 1);
    if (transfer.unlock && typeof transfer.unlock === "object") {
      const untilHeight = Number(transfer.unlock.untilHeight);
      const untilTime = Number(transfer.unlock.untilTime);
      transfer.locked = Number.isFinite(untilTime) && untilTime > 0
        ? Number(nowSec) < untilTime
        : (Number.isFinite(untilHeight) && untilHeight > 0 ? Number(tipHeight) < untilHeight : false);
      // THE NESTED LOCK IS PART OF THE SAME FACT. A consumer that reads `unlock.locked` must not see the stored
      // state after the height or time has passed; the cold and resumed answers have to agree field by field.
      transfer.unlock = { ...transfer.unlock, locked: transfer.locked };
    }
  }
  return transfers;
}

// KEY IMAGES OF THE FUNDING OUTPUTS, SUPPLIED BY THE CALLER. A recovery read carries the view key and the public
// spend key, not the private spend key: it must not derive key images itself. `sweep.keyImages` returns these from
// an arrival; mapping them back to output keys is what makes a spend local instead of a `is_key_image_spent` call.
function normalizeKeyImages(value) {
  const empty = { provided: false, byImage: new Map(), byOutput: new Map() };
  if (value === undefined || value === null) return empty;
  if (!Array.isArray(value)) throw new SdkError("bad-input", { field: "keyImages" });
  const byImage = new Map();
  const byOutput = new Map();
  value.forEach((entry, position) => {
    const raw = typeof entry === "string" ? entry : entry && entry.keyImage;
    const keyImage = typeof raw === "string" ? raw.replace(/^0x/, "").toLowerCase() : "";
    if (!hash64(keyImage)) throw new SdkError("bad-input", { field: "keyImages", why: "key-image", position });
    if (byImage.has(keyImage)) throw new SdkError("bad-input", { field: "keyImages", why: "duplicate", position });
    const outputKey = entry && typeof entry === "object" && typeof entry.outputKey === "string"
      ? entry.outputKey.replace(/^0x/, "").toLowerCase() : null;
    if (outputKey !== null && !hash64(outputKey)) throw new SdkError("bad-input", { field: "keyImages", why: "output-key", position });
    const record = { keyImage, outputKey };
    byImage.set(keyImage, record);
    if (outputKey) byOutput.set(outputKey, keyImage);
  });
  return { provided: true, byImage, byOutput };
}

function spendsOfTx(tx, tracked, node, { height, blockHash, pool = false }) {
  if (!tracked.provided) return [];
  const records = [];
  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  for (const entry of vin) {
    const raw = entry && entry.key && entry.key.k_image;
    const keyImage = typeof raw === "string" ? raw.replace(/^0x/, "").toLowerCase() : "";
    if (!hash64(keyImage) || !tracked.byImage.has(keyImage)) continue;
    records.push({
      keyImage, outputKey: tracked.byImage.get(keyImage).outputKey,
      txid: String(tx.tx_hash || "").replace(/^0x/, "").toLowerCase(),
      height, blockHash, pool,
    });
  }
  return records;
}

function addSpends(target, records) {
  for (const spend of records) {
    const previous = target.get(spend.keyImage);
    if (!previous || (previous.pool && !spend.pool)) target.set(spend.keyImage, spend);
  }
}

function availableAtomicOf(transfers, tracked, spends, minConfirmations = 1) {
  if (!tracked.provided) return null;
  const spent = new Set(spends.map((spend) => spend.keyImage));
  let total = 0n;
  let complete = true;
  for (const transfer of transfers) {
    if (transfer.pool || transfer.locked || Number(transfer.confirmations) < minConfirmations) continue;
    for (const output of transfer.outputs || []) {
      if (!output.amountVerified || output.amountAtomic === null || output.amountAtomic === undefined) continue;
      const keyImage = tracked.byOutput.get(String(output.key || "").toLowerCase());
      if (!keyImage) { complete = false; continue; }
      if (!spent.has(keyImage)) total += BigInt(output.amountAtomic);
    }
  }
  return complete ? total.toString() : null;
}

async function scanRecoveryBlocks(node, { watched, fromHeight, toHeight, nowSec, fetchImpl, timeoutMs }) {
  const transfers = [];
  const failures = [];
  let complete = true;
  for (let height = fromHeight; height <= toHeight; height++) {
    let block;
    try { block = await getBlock(node, height, fetchImpl, timeoutMs); }
    catch (error) { failures.push({ ...failureOf(error, node), height }); complete = false; break; }
    if (!block.txHashes.length) continue;
    let txs;
    try { txs = await getBlockTxs(node, block.txHashes, fetchImpl, timeoutMs); }
    catch (error) { failures.push({ ...failureOf(error, node), height }); complete = false; break; }
    for (const tx of txs) {
      const hit = engine.xmrScan.matchTransaction(tx, [watched], {
        height, tipHeight: Math.max(0, toHeight), nowSec,
      });
      if (!hit.length) continue;
      const confirmations = confirmationsOf(tx, height, toHeight);
      transfers.push(recoveryObservation(tx, hit, node, { height, blockHash: block.hash, confirmations }));
    }
  }
  return { transfers, failures, complete };
}

async function scanRecoveryPoolState(node, { watched, tracked, tip, nowSec, fetchImpl, timeoutMs, txid = null }) {
  const body = await call(node, "/get_transaction_pool_hashes", {}, fetchImpl, timeoutMs);
  const hashes = Array.isArray(body.tx_hashes)
    ? body.tx_hashes.map((hash) => String(hash).replace(/^0x/, "").toLowerCase()).filter((hash) => /^[0-9a-f]{64}$/.test(hash))
    : [];
  if (!hashes.length) return { transfers: [], spends: [], target: null };
  const txs = await getBlockTxs(node, hashes, fetchImpl, timeoutMs);
  const transfers = [];
  const spends = [];
  let target = null;
  for (const tx of txs) {
    if (txid !== null && target === null && String(tx.tx_hash || "").replace(/^0x/, "").toLowerCase() === txid) {
      target = { txid, height: null, blockHash: null, pool: true };
    }
    spends.push(...spendsOfTx(tx, tracked, node, { height: null, blockHash: null, pool: true }));
    const hit = engine.xmrScan.matchTransaction(tx, [watched], { height: null, tipHeight: Math.max(0, tip), nowSec });
    if (!hit.length) continue;
    transfers.push(recoveryObservation(tx, hit, node, { height: null, blockHash: null, confirmations: 0, pool: true }));
  }
  return { transfers, spends, target };
}

async function scanRecoveryPool(node, { watched, tip, nowSec, fetchImpl, timeoutMs }) {
  const state = await scanRecoveryPoolState(node, { watched, tracked: normalizeKeyImages(null), tip, nowSec, fetchImpl, timeoutMs });
  return state.transfers;
}

// ---------------------------------------------------------------------------
// THE PRIMARY RECOVERY READ.
//
// One chosen node walks the whole range. The checkpoint is caller-owned storage; the SDK never persists it and never
// silently trusts it. A checkpoint is a claim about a block hash, not a claim about money: an anchor that moved, a
// digest that does not describe its own contents, or a chain that does not connect is a replay from the start.
//
// The walk is deliberately independent of `verifyRecovery`'s two-node decision. This function returns one node's
// complete history and its progress; independent confirmation stays a separate, later step.
const CHECKPOINT_VERSION = 1;
const HASH64 = /^[0-9a-f]{64}$/;
const hash64 = (value) => typeof value === "string" && HASH64.test(value.replace(/^0x/, "").toLowerCase());
const normalizedHash = (value) => String(value || "").replace(/^0x/, "").toLowerCase();

function checkpointDigest(record) {
  const text = JSON.stringify({
    version: record.version, network: record.network, address: record.address, fromHeight: record.fromHeight,
    toHeight: record.toHeight ?? null, keyImages: record.keyImages ?? [], through: record.through,
    transfers: record.transfers, outputs: record.outputs, spends: record.spends,
  });
  return engine.xmrScan.bytesToHex(engine.xmrScan.keccak(new TextEncoder().encode(text)));
}

function checkpointRecord({ network, address, fromHeight, toHeight = null, keyImages = [], through, transfers, spends = [], kind = null }) {
  const record = {
    version: CHECKPOINT_VERSION, network, address, fromHeight, toHeight, keyImages, through,
    transfers,
    outputs: transfers.flatMap((transfer) => transfer.outputs.map((output) => ({
      txid: transfer.txid, height: transfer.height, blockHash: transfer.blockHash, ...output,
    }))),
    spends,
  };
  if (kind) record.kind = kind;
  if (kind === "witness") record.grid = WITNESS_SLICE_BLOCKS;
  record.digest = checkpointDigest(record);
  return record;
}

function validCheckpoint(record, identity) {
  if (!record || typeof record !== "object" || record.version !== CHECKPOINT_VERSION) return null;
  if (record.kind && record.kind !== "primary") return null;
  if (record.network !== identity.network || record.address !== identity.address || record.fromHeight !== identity.fromHeight) return null;
  if ((record.toHeight ?? null) !== (identity.toHeight ?? null)) return null;
  if (JSON.stringify(record.keyImages ?? []) !== JSON.stringify(identity.keyImages ?? [])) return null;
  if (!Array.isArray(record.transfers) || !Array.isArray(record.outputs) || !Array.isArray(record.spends)) return null;
  if (!record.through || !Number.isSafeInteger(record.through.height) || !hash64(record.through.hash)) return null;
  if (record.through.height < identity.fromHeight) return null;
  if (record.digest !== checkpointDigest(record)) return null;
  return record;
}

function validWitnessCheckpoint(record, identity) {
  if (!record || typeof record !== "object" || record.version !== CHECKPOINT_VERSION) return null;
  if (record.kind !== "witness" || record.grid !== WITNESS_SLICE_BLOCKS) return null;
  if (record.network !== identity.network || record.address !== identity.address || record.fromHeight !== identity.fromHeight) return null;
  if ((record.toHeight ?? null) !== (identity.toHeight ?? null)) return null;
  if (JSON.stringify(record.keyImages ?? []) !== JSON.stringify(identity.keyImages ?? [])) return null;
  if (!Array.isArray(record.transfers) || !Array.isArray(record.outputs) || !Array.isArray(record.spends)) return null;
  if (!record.through || !Number.isSafeInteger(record.through.height) || !hash64(record.through.hash)) return null;
  if (record.through.height < identity.fromHeight) return null;
  if (record.digest !== checkpointDigest(record)) return null;
  return record;
}

// THE BLOCK HASH OF A PRESENT HASH IS A SMALL EXTRA READ, NOT A WALK. A trusted node that already answered for the
// transaction usually has the header; a header read that fails leaves the hash null but does not turn a present
// transaction into an absence.
async function getBlockHashAt(node, height, fetchImpl, timeoutMs, options = {}) {
  const body = await call(node, "/json_rpc", {
    jsonrpc: "2.0", id: "header", method: "get_block_header_by_height", params: { height },
  }, fetchImpl, timeoutMs, options);
  const result = body && body.result;
  const hash = result && result.block_header && result.block_header.hash;
  return hash64(hash) ? normalizedHash(hash) : null;
}

// ONE HASH QUESTION, WITH THE TWO VALID ABSENCE SHAPES. A real restricted monerod omits `txs` and `txs_as_json`
// when it does not know the hash and names it in `missed_tx`; an empty pair with the same name is the same fact.
// A present hash and a missed hash in one answer, a missing or foreign `missed_tx`, an untrusted answer and a
// partial wrapper are all ambiguous and never an absence.
async function readWithdrawalHash({ node, targetTxid, fetchImpl, timeoutMs, signal }) {
  const body = await call(node, "/get_transactions", { txs_hashes: [targetTxid], decode_as_json: true },
    fetchImpl, timeoutMs, { signal });
  if (!body || body.status !== "OK") throw new SdkError("xmr-no-nodes", { node: node.url, why: "rpc-status" });
  if (body.untrusted === true) throw new SdkError("xmr-no-nodes", { node: node.url, why: "untrusted" });
  const wrappers = Array.isArray(body.txs) ? body.txs : null;
  const bodies = Array.isArray(body.txs_as_json) ? body.txs_as_json : null;
  const missed = body.missed_tx === undefined || body.missed_tx === null ? [] : (
    Array.isArray(body.missed_tx) ? body.missed_tx.map(normalizedHash) : null);
  if (missed === null) throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-answer" });
  if (wrappers !== null || bodies !== null) {
    if (wrappers === null || bodies === null) {
      throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-answer" });
    }
    if (wrappers.length > 1 || bodies.length > 1 || wrappers.length !== bodies.length) {
      throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-answer" });
    }
    if (wrappers.length === 1) {
      // THE NODE NAMED BOTH A FOUND HASH AND A MISS. That is not a present or an absent answer; the caller must
      // keep the bytes and retry the read.
      if (missed.length) throw new SdkError("xmr-no-nodes", { node: node.url, why: "ambiguous-answer" });
      const wrapper = wrappers[0] || {};
      if (normalizedHash(wrapper.tx_hash) !== targetTxid) {
        throw new SdkError("xmr-no-nodes", { node: node.url, why: "target-mismatch" });
      }
      const rawHeight = wrapper.block_height;
      const height = rawHeight === null || rawHeight === undefined || rawHeight === "" ? null : Number(rawHeight);
      // A POOL TRANSACTION HAS NO BLOCK. `in_pool` is the explicit marker; an absent or zero height is the same
      // fact on daemons that omit it.
      const pool = wrapper.in_pool === true || height === null || height === 0;
      if (!pool && (!Number.isSafeInteger(height) || height < 0)) {
        throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-answer" });
      }
      const target = { txid: targetTxid, height: pool ? null : height, blockHash: null, pool };
      if (!pool) {
        try { target.blockHash = await getBlockHashAt(node, height, fetchImpl, timeoutMs, { signal }); }
        catch { target.blockHash = null; }
      }
      return { target, absent: false };
    }
  }
  // AN ABSENCE MUST BE NAMED BY THE NODE ITSELF. Empty lists alone do not say whether the transaction is missing
  // or whether the node did not answer the question.
  if (missed.length !== 1 || missed[0] !== targetTxid) {
    throw new SdkError("xmr-no-nodes", { node: node.url, why: "absence-unproven" });
  }
  return { target: null, absent: true };
}

// THE LATER CHECK OF A SIGNED WITHDRAWAL, WITHOUT A BLOCK WALK. The token is gone and the caller still has the
// transaction id and the key images that were verified before signing. A trusted node can answer both facts
// directly: `/get_transactions` says whether this exact hash is in a block or in the pool, and
// `/is_key_image_spent` says whether each input moved. This is deliberately narrower than `readRecovery`: no block
// range is read, so a start height and a chain walk are not part of the answer. Every partial, malformed or
// substituted answer is incomplete, never an absence.
export async function readWithdrawalState(request = {}) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const node = normalizeNodes([request.node])[0];
  const targetTxid = normalizedHash(request.txid);
  if (!hash64(targetTxid)) throw new SdkError("bad-input", { field: "txid" });
  const tracked = normalizeKeyImages(request.keyImages);
  if (!tracked.provided || tracked.byImage.size === 0) {
    throw new SdkError("bad-input", { field: "keyImages", why: "empty" });
  }
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0
    ? Number(request.timeoutMs) : 20000;
  const signal = request.signal && typeof request.signal.addEventListener === "function" ? request.signal : null;
  const images = [...tracked.byImage.values()].map((record) => record.keyImage);

  // The hash first. One request names exactly one transaction; a node that answers with another hash, more than one
  // transaction or a partial wrapper has not answered this question.
  let first;
  try {
    first = await readWithdrawalHash({ node, targetTxid, fetchImpl, timeoutMs, signal });
  } catch (error) {
    return { target: null, spends: [], complete: false, failed: [failureOf(error, node)] };
  }
  // A PRESENT HASH IS THE WHOLE ANSWER. It never permits a resend, so the inputs do not need to be sent to the
  // node for this verdict.
  if (first.target) return { target: first.target, spends: [], complete: true, failed: [] };

  // The hash is absent. The only way absence may permit a resend is a complete key-image answer: every requested
  // image must come back with a known status. A short, long or non-integer list is unreadable, not "unspent".
  try {
    const body = await call(node, "/is_key_image_spent", { key_images: images }, fetchImpl, timeoutMs,
      { signal, contentType: "application/json" });
    if (!body || body.status !== "OK") throw new SdkError("xmr-no-nodes", { node: node.url, why: "rpc-status" });
    if (body.untrusted === true) throw new SdkError("xmr-no-nodes", { node: node.url, why: "untrusted" });
    const statuses = body && Array.isArray(body.spent_status) ? body.spent_status : null;
    if (!statuses || statuses.length !== images.length
        || !statuses.every((value) => Number.isInteger(value) && value >= 0 && value <= 2)) {
      throw new SdkError("xmr-no-nodes", { node: node.url, why: "spent-status" });
    }
    const spends = [];
    statuses.forEach((status, index) => {
      if (status === 1 || status === 2) spends.push({ keyImage: images[index], pool: status === 2 });
    });
    // THE HASH IS ASKED AGAIN AFTER THE INPUTS. The person's own transaction can land between the two answers;
    // then the second answer is present, and it must not become inputs-spent (or a reason to resend).
    let after;
    try {
      after = await readWithdrawalHash({ node, targetTxid, fetchImpl, timeoutMs, signal });
    } catch (error) {
      return { target: null, spends: [], complete: false, failed: [failureOf(error, node)] };
    }
    if (after.target) return { target: after.target, spends: [], complete: true, failed: [] };
    return { target: null, spends, complete: true, failed: [] };
  } catch (error) {
    return { target: null, spends: [], complete: false, failed: [failureOf(error, node)] };
  }
}

/**
 * THE FIRST BLOCK PAST `t1`, FROM THE TRUSTED NODE. Monero blocks carry a timestamp, not the order's clock; the
 * margin covers the blocks whose timestamp is behind the wall clock when they are mined. The client passes the
 * returned height as `toHeight`, so the read stops at the swap window instead of walking to the head. A `t1` beyond
 * the node's tip returns the tip: there is no later block to read yet.
 */
export async function recoveryEndHeight(request = {}) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const node = normalizeNodes([request.node])[0];
  const t1 = Number(request.t1);
  if (!Number.isSafeInteger(t1) || t1 <= 0 || t1 > 253402300799) {
    throw new SdkError("bad-input", { field: "t1", why: "seconds" });
  }
  const marginSeconds = request.marginSeconds === null || request.marginSeconds === undefined
    ? 7200 : Number(request.marginSeconds);
  if (!Number.isSafeInteger(marginSeconds) || marginSeconds < 0) throw new SdkError("bad-input", { field: "marginSeconds" });
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 20000;
  const info = await getInfo(node, fetchImpl, timeoutMs);
  const tip = Number(info.height);
  if (!Number.isSafeInteger(tip) || tip < 0) throw new SdkError("xmr-no-nodes", { node: node.url, why: "height" });
  const target = t1 + marginSeconds;
  const header = async (height) => {
    const body = await call(node, "/json_rpc", {
      jsonrpc: "2.0", id: "header", method: "get_block_header_by_height", params: { height },
    }, fetchImpl, timeoutMs);
    const result = body && body.result;
    const raw = result && result.block_header;
    const stamp = Number(raw && raw.timestamp);
    if (!raw || !Number.isSafeInteger(Number(raw.height)) || Number(raw.height) !== height
        || !Number.isSafeInteger(stamp) || stamp <= 0) {
      throw new SdkError("xmr-no-nodes", { node: node.url, why: "header", height });
    }
    return { height, timestamp: stamp, hash: hash64(raw.hash) ? normalizedHash(raw.hash) : null };
  };
  let low = 0;
  let high = tip;
  const top = await header(tip);
  if (top.timestamp < target) return { toHeight: tip, tip, t1, marginSeconds, block: top, beyondTip: true };
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const entry = await header(middle);
    if (entry.timestamp >= target) high = middle;
    else low = middle + 1;
  }
  const block = low === tip ? top : await header(low);
  return { toHeight: low, tip, t1, marginSeconds, block, beyondTip: false };
}

/**
 * READ ONE NODE FROM `fromHeight` TO ITS HEAD.
 *
 * The checkpoint object is `{ read(), save(record), discard() }` or omitted. `onProgress` receives
 * `{ phase, through, blocksVerified, blocksTotal, bytes, operator }`. `signal` cancels the read; `idleTimeoutMs`
 * bounds a request, not the whole walk, so a long range may take as long as it keeps advancing. A failed body,
 * a short transaction list, a moved anchor or a broken parent link makes the answer incomplete, never empty.
 */
export async function readRecovery(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const nodes = request.node !== undefined ? normalizeNodes([request.node]) : normalizeNodes(request.nodes);
  const node = nodes[0];
  if (!isStr(request.address)) throw new SdkError("bad-input", { field: "address" });
  if (request.viewSecret === undefined || request.viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
  if (!isStr(request.spendPub)) throw new SdkError("bad-input", { field: "spendPub" });
  const fromHeight = intOf(request.fromHeight);
  if (fromHeight === null || fromHeight < 0) throw new SdkError("bad-input", { field: "fromHeight" });
  const toHeight = request.toHeight === null || request.toHeight === undefined ? null : intOf(request.toHeight);
  if (request.toHeight !== null && request.toHeight !== undefined && (toHeight === null || toHeight < fromHeight)) {
    throw new SdkError("bad-input", { field: "toHeight" });
  }
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const idleRaw = request.idleTimeoutMs === null || request.idleTimeoutMs === undefined ? null : Number(request.idleTimeoutMs);
  const totalRaw = request.timeoutMs === null || request.timeoutMs === undefined ? null : Number(request.timeoutMs);
  const timeoutMs = idleRaw !== null && Number.isFinite(idleRaw) && idleRaw > 0
    ? idleRaw
    : (totalRaw !== null && Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : 20000);
  const minConfirmationsRaw = request.minConfirmations === null || request.minConfirmations === undefined ? null : Number(request.minConfirmations);
  const minConfirmations = minConfirmationsRaw !== null && Number.isFinite(minConfirmationsRaw)
    ? Math.max(1, Math.trunc(minConfirmationsRaw))
    : 1;
  const signal = request.signal && typeof request.signal.addEventListener === "function" ? request.signal : null;
  const checkpoint = request.checkpoint && typeof request.checkpoint === "object" ? request.checkpoint : null;
  const onProgress = typeof request.onProgress === "function" ? request.onProgress : () => {};
  const bound = engine.xmrScan.watchedAddressVerdict({ address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub });
  if (!bound.ok) {
    if (bound.code === "bad-input") throw new SdkError("bad-input", { field: bound.field || "address", why: bound.why });
    throw new SdkError(bound.code, { field: bound.field || "address", address: request.address });
  }
  const addressNetwork = bound.keys && bound.keys.network ? bound.keys.network : null;
  if (request.network !== undefined && request.network !== null && addressNetwork && request.network !== addressNetwork) {
    throw new SdkError("bad-input", { field: "network", why: "address-network-mismatch" });
  }
  const watched = { address: request.address, viewSecret: bound.viewSecret, spendPub: bound.spendPub };
  const tracked = normalizeKeyImages(request.keyImages);
  const spentStatus = request.spentStatus !== false;
  const targetTxid = request.txid === undefined || request.txid === null ? null : normalizedHash(request.txid);
  if (targetTxid !== null && !hash64(targetTxid)) throw new SdkError("bad-input", { field: "txid" });
  let target = null;
  let info;
  try { info = await getInfo(node, fetchImpl, timeoutMs, { signal }); }
  catch (error) {
    if (signal && signal.aborted) {
      throw new SdkError("xmr-no-nodes", { node: node.url, name: "AbortError", why: "cancelled" });
    }
    return { transfers: [], tip: null, fromHeight, toHeight, minConfirmations, ...UNKNOWN_TOTALS,
      target, complete: false, through: null, checkpoint: null, blocked: false, failed: [failureOf(error, node)] };
  }
  const network = isStr(request.network) ? request.network : info.nettype;
  if (!isStr(network)) throw new SdkError("bad-input", { field: "network" });
  if (addressNetwork && info.nettype && addressNetwork !== info.nettype) {
    throw new SdkError("bad-input", { field: "node", why: "node-network-mismatch" });
  }
  if (!info.synced) {
    return { transfers: [], tip: info.height, fromHeight, toHeight, minConfirmations, ...UNKNOWN_TOTALS,
      target, complete: false, through: null, checkpoint: null, blocked: true,
      failed: [{ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" }] };
  }
  const tipTop = Math.max(0, info.height - 1);
  const top = toHeight === null ? tipTop : Math.min(tipTop, toHeight);
  if (top < fromHeight) {
    // A RANGE ABOVE THE TIP HAS NO BLOCKS, BUT THE POOL IS STILL READ. The old early return called an empty
    // block range complete without asking the pool, so a withdrawal already waiting there looked absent.
    let transfers = [];
    let spends = [];
    let poolFailure = null;
    let failures = [];
    try {
      const pool = await scanRecoveryPoolState(node, {
        watched, tracked, tip: tipTop, nowSec: request.nowSec, fetchImpl, timeoutMs, txid: targetTxid,
      });
      if (pool.target) target = pool.target;
      transfers = pool.transfers;
      spends = pool.spends;
    } catch (error) {
      poolFailure = { ...failureOf(error, node), why: "pool-read" };
      failures = [poolFailure];
    }
    if (spentStatus && tracked.provided && tracked.byImage.size) {
      const status = await readSpentStatus(node, tracked, fetchImpl, timeoutMs, { signal });
      if (status.spends.length) {
        const merged = new Map(spends.map((spend) => [spend.keyImage, spend]));
        addSpends(merged, status.spends);
        spends = [...merged.values()];
      }
      if (!status.complete) {
        failures = [...failures, status.failed[0]];
        if (!poolFailure) poolFailure = status.failed[0];
      }
    }
    const totals = poolFailure
      ? { receivedAtomic: null, spentAtomic: null, unspentAtomic: null, withdrawalState: "unknown" }
      : recoveryTotals(transfers, tracked, spends);
    return { transfers, tip: info.height, fromHeight, toHeight, minConfirmations, target,
      complete: poolFailure === null, through: null, spends, ...totals, checkpoint: null, blocked: false,
      ...(poolFailure
        ? { failed: failures }
        : { availableAtomic: availableAtomicOf(transfers, tracked, spends, minConfirmations),
          availableSource: { url: node.url, operator: node.operator }, failed: [] }) };
  }
  const keyImages = [...tracked.byImage.values()].sort((a, b) => a.keyImage.localeCompare(b.keyImage))
    .map((entry) => ({ keyImage: entry.keyImage, outputKey: entry.outputKey }));
  const identity = { network, address: request.address, fromHeight, toHeight, keyImages };
  let bytes = 0;
  const countBytes = (n) => { if (Number.isFinite(n) && n > 0) bytes += n; };
  let prior = null;
  if (checkpoint && typeof checkpoint.read === "function") {
    try { prior = validCheckpoint(checkpoint.read(), identity); }
    catch (error) { throw callerFailure("checkpoint.read", error); }
    if (!prior && typeof checkpoint.discard === "function") {
      try { checkpoint.discard(); }
      catch (error) { throw callerFailure("checkpoint.discard", error); }
    }
  }
  let replay = 0;
  const run = async (startRecord) => {
    target = null;
    let transfers = [];
    let spends = [];
    const spendMap = new Map();
    let through = null;
    let blocksVerified = 0;
    let previousHash = null;
    if (startRecord) {
      transfers = startRecord.transfers.slice();
      spends = startRecord.spends.slice();
      addSpends(spendMap, spends);
      through = { height: startRecord.through.height, hash: normalizedHash(startRecord.through.hash) };
      blocksVerified = through.height - fromHeight + 1;
      previousHash = through.hash;
      // A stored height is a claim. The block at that height must still carry the same hash, or the chain moved.
      let anchor;
      try {
        anchor = await getBlock(node, through.height, fetchImpl, timeoutMs, { signal, onBytes: countBytes });
      } catch (error) {
        const failure = failureOf(error, node);
        failure.height = through.height;
        return { transfers, tip: info.height, fromHeight, toHeight, minConfirmations, ...UNKNOWN_TOTALS, complete: false, through,
          target, spends: [...spendMap.values()],
          checkpoint: checkpointRecord({ ...identity, through, transfers, spends: [...spendMap.values()] }), blocked: false, failed: [failure] };
      }
      if (!anchor.hash || normalizedHash(anchor.hash) !== through.hash) throw new Error("reorg");
    }
    const total = top - fromHeight + 1;
    const emit = () => {
      try {
        onProgress({
          phase: "blocks", through: through ? through.height : null, blocksVerified, blocksTotal: total,
          bytes, operator: node.operator,
        });
      } catch (error) { throw callerFailure("onProgress", error); }
    };
    emit();
    for (let height = through ? through.height + 1 : fromHeight; height <= top; height += 1) {
      if (signal && signal.aborted) throw new SdkError("xmr-no-nodes", { node: node.url, name: "AbortError", why: "cancelled" });
      let block;
      let txs = [];
      try {
        block = await getBlock(node, height, fetchImpl, timeoutMs, { signal, onBytes: countBytes });
        if (!hash64(block.hash)) throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-block", height });
        if (block.numTxes !== null && block.txHashes.length !== block.numTxes) throw new SdkError("xmr-no-nodes", { node: node.url, why: "block-incomplete", height });
        if (previousHash && (!block.parent || normalizedHash(block.parent) !== previousHash)) throw new Error("reorg");
        if (!block.txHashes.every((hash) => hash64(hash))) throw new SdkError("xmr-no-nodes", { node: node.url, why: "block-incomplete", height });
        if (block.txHashes.length) txs = await getBlockTxs(node, block.txHashes, fetchImpl, timeoutMs, { signal, onBytes: countBytes });
      } catch (error) {
        if (String(error && error.message) === "reorg") throw error;
        if (signal && signal.aborted) throw error;
        const failure = failureOf(error, node);
        failure.height = height;
        return { transfers, tip: info.height, fromHeight, toHeight, minConfirmations, ...UNKNOWN_TOTALS, complete: false, through,
          target, spends: [...spendMap.values()],
          checkpoint: through ? checkpointRecord({ ...identity, through, transfers, spends: [...spendMap.values()] }) : null, blocked: false, failed: [failure] };
      }
      for (const tx of txs) {
        if (targetTxid !== null && target === null && normalizedHash(tx.tx_hash) === targetTxid) {
          target = { txid: targetTxid, height, blockHash: normalizedHash(block.hash), pool: false };
        }
        addSpends(spendMap, spendsOfTx(tx, tracked, node, { height, blockHash: block.hash }));
        const hit = engine.xmrScan.matchTransaction(tx, [watched], { height, tipHeight: tipTop, nowSec: request.nowSec });
        if (!hit.length) continue;
        const confirmations = confirmationsOf(tx, height, tipTop);
        transfers.push(recoveryObservation(tx, hit, node, { height, blockHash: block.hash, confirmations }));
      }
      through = { height, hash: normalizedHash(block.hash) };
      previousHash = through.hash;
      blocksVerified += 1;
      if (checkpoint && typeof checkpoint.save === "function") {
        try { checkpoint.save(checkpointRecord({ ...identity, through, transfers, spends: [...spendMap.values()] })); }
        catch (error) { throw callerFailure("checkpoint.save", error); }
      }
      emit();
    }
    let poolFailure = null;
    let failures = [];
    // A CLOSED WINDOW DOES NOT READ THE POOL. A pool transaction has no height; after `t1` it may be a late transfer
    // that the swap window excludes. The open window still reads it as before.
    const windowClosed = toHeight !== null && top < tipTop;
    if (!windowClosed) {
      try {
        const pool = await scanRecoveryPoolState(node, {
          watched, tracked, tip: tipTop, nowSec: request.nowSec, fetchImpl, timeoutMs, txid: targetTxid,
        });
        if (target === null && pool.target) target = pool.target;
        const known = new Set(transfers.map((transfer) => transfer.txid));
        for (const transfer of pool.transfers) {
          if (known.has(transfer.txid)) continue;
          known.add(transfer.txid);
          transfers.push(transfer);
        }
        addSpends(spendMap, pool.spends);
      } catch (error) {
        poolFailure = { ...failureOf(error, node), why: "pool-read" };
        failures = [poolFailure];
      }
    }
    if (spentStatus && tracked.provided && tracked.byImage.size) {
      const status = await readSpentStatus(node, tracked, fetchImpl, timeoutMs, { signal });
      addSpends(spendMap, status.spends);
      if (!status.complete) {
        failures = [...failures, status.failed[0]];
        if (!poolFailure) poolFailure = status.failed[0];
      }
    }
    spends = [...spendMap.values()];
    refreshTransferState(transfers, { tipHeight: tipTop, nowSec: request.nowSec ?? Math.floor(Date.now() / 1000) });
    const totals = poolFailure
      ? { receivedAtomic: null, spentAtomic: null, unspentAtomic: null, withdrawalState: "unknown" }
      : recoveryTotals(transfers, tracked, spends);
    const confirmedSpends = spends.filter((spend) => spend.pool !== true);
    const confirmedTransfers = transfers.filter((transfer) => transfer.pool !== true);
    if (poolFailure) {
      return { transfers, tip: info.height, fromHeight, toHeight, minConfirmations, ...UNKNOWN_TOTALS, complete: false, through,
        target, spends, ...totals,
        checkpoint: through ? checkpointRecord({ ...identity, through, transfers: confirmedTransfers, spends: confirmedSpends }) : null,
        blocked: false, failed: failures };
    }
    return { transfers, tip: info.height, fromHeight, toHeight, minConfirmations, complete: true, through,
      target, spends, ...totals, availableAtomic: availableAtomicOf(transfers, tracked, spends, minConfirmations),
      availableSource: { url: node.url, operator: node.operator },
      checkpoint: through ? checkpointRecord({ ...identity, through, transfers: confirmedTransfers, spends: confirmedSpends }) : null,
      blocked: false, failed: [] };
  };
  for (;;) {
    try {
      return await run(prior);
    } catch (error) {
      if (signal && signal.aborted) throw error;
      if (error && error.caller) throw error;
      if (String(error && error.message) === "reorg" && replay === 0) {
        replay += 1;
        prior = null;
        if (checkpoint && typeof checkpoint.discard === "function") {
          try { checkpoint.discard(); }
          catch (discardError) { throw callerFailure("checkpoint.discard", discardError); }
        }
        continue;
      }
      const failure = failureOf(error, node);
      return { transfers: [], tip: info.height, fromHeight, toHeight, minConfirmations, ...UNKNOWN_TOTALS, complete: false, through: null,
        target, checkpoint: null, blocked: false, failed: [failure] };
    }
  }
}

/**
 * THE WITNESS READ ON A PLAIN MONEROD.
 *
 * The witness is asked for whole fixed windows of the zero-aligned grid, never for the order's exact start, a payout
 * height, a single transaction or a key image. Every height of a window is read, then every transaction hash in those
 * blocks; a matching transfer never stops the walk. The residual leak is the grid bucket that contains the start.
 *
 * `tipHeight` is the top the primary read reached. When it is above this witness, the witness is behind and the
 * answer is incomplete; when it is omitted, the witness's own top is the target. A checkpoint re-reads the whole
 * window that contains it, so a cold and a resumed read of the same window issue the same requests.
 */
export async function readRecoveryWitness(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const nodes = request.node !== undefined ? normalizeNodes([request.node]) : normalizeNodes(request.nodes);
  const node = nodes[0];
  if (!isStr(request.address)) throw new SdkError("bad-input", { field: "address" });
  if (request.viewSecret === undefined || request.viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
  if (!isStr(request.spendPub)) throw new SdkError("bad-input", { field: "spendPub" });
  const fromHeight = request.fromHeight === null || request.fromHeight === undefined ? null : intOf(request.fromHeight);
  if (fromHeight === null || fromHeight < 0) throw new SdkError("bad-input", { field: "fromHeight" });
  const toHeight = request.toHeight === null || request.toHeight === undefined ? null : intOf(request.toHeight);
  if (request.toHeight !== null && request.toHeight !== undefined && (toHeight === null || toHeight < fromHeight)) {
    throw new SdkError("bad-input", { field: "toHeight" });
  }
  // KEY IMAGES ARE LINKABLE. The witness is a third party and never receives them; spent status belongs to the
  // selected trusted primary node.
  if (request.keyImages !== undefined && request.keyImages !== null) {
    throw new SdkError("bad-input", { field: "keyImages", why: "witness-key-images" });
  }
  const tipHeightRaw = request.tipHeight === null || request.tipHeight === undefined ? null : intOf(request.tipHeight);
  if (request.tipHeight !== null && request.tipHeight !== undefined && (tipHeightRaw === null || tipHeightRaw < 0)) {
    throw new SdkError("bad-input", { field: "tipHeight" });
  }
  const minConfirmationsRaw = request.minConfirmations === null || request.minConfirmations === undefined ? null : Number(request.minConfirmations);
  const minConfirmations = minConfirmationsRaw !== null && Number.isFinite(minConfirmationsRaw)
    ? Math.max(1, Math.trunc(minConfirmationsRaw))
    : 1;
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const idleRaw = request.idleTimeoutMs === null || request.idleTimeoutMs === undefined ? null : Number(request.idleTimeoutMs);
  const totalRaw = request.timeoutMs === null || request.timeoutMs === undefined ? null : Number(request.timeoutMs);
  const timeoutMs = idleRaw !== null && Number.isFinite(idleRaw) && idleRaw > 0
    ? idleRaw
    : (totalRaw !== null && Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : 20000);
  const signal = request.signal && typeof request.signal.addEventListener === "function" ? request.signal : null;
  const checkpoint = request.checkpoint && typeof request.checkpoint === "object" ? request.checkpoint : null;
  const onProgress = typeof request.onProgress === "function" ? request.onProgress : () => {};
  const bound = engine.xmrScan.watchedAddressVerdict({ address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub });
  if (!bound.ok) {
    if (bound.code === "bad-input") throw new SdkError("bad-input", { field: bound.field || "address", why: bound.why });
    throw new SdkError(bound.code, { field: bound.field || "address", address: request.address });
  }
  const addressNetwork = bound.keys && bound.keys.network ? bound.keys.network : null;
  if (request.network !== undefined && request.network !== null && addressNetwork && request.network !== addressNetwork) {
    throw new SdkError("bad-input", { field: "network", why: "address-network-mismatch" });
  }
  const watched = { address: request.address, viewSecret: bound.viewSecret, spendPub: bound.spendPub };
  const tracked = normalizeKeyImages(request.keyImages);
  let info;
  try { info = await getInfo(node, fetchImpl, timeoutMs, { signal }); }
  catch (error) {
    return { transfers: [], tip: null, fromHeight, toHeight, ...UNKNOWN_TOTALS, through: null, complete: false, checkpoint: null, blocked: false, failed: [failureOf(error, node)] };
  }
  const network = isStr(request.network) ? request.network : info.nettype;
  if (!isStr(network)) throw new SdkError("bad-input", { field: "network" });
  if (addressNetwork && info.nettype && addressNetwork !== info.nettype) {
    throw new SdkError("bad-input", { field: "node", why: "node-network-mismatch" });
  }
  if (!info.synced) {
    return { transfers: [], tip: info.height, fromHeight, toHeight, ...UNKNOWN_TOTALS, through: null, complete: false, checkpoint: null, blocked: true,
      failed: [{ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" }] };
  }
  const top = Math.max(0, info.height - 1);
  const wantedTop = toHeight === null ? tipHeightRaw : (tipHeightRaw === null ? toHeight : Math.min(tipHeightRaw, toHeight));
  if (wantedTop !== null && wantedTop > top) {
    return { transfers: [], tip: info.height, fromHeight, toHeight, ...UNKNOWN_TOTALS, through: null, complete: false, checkpoint: null, blocked: false,
      failed: [{ url: node.url, operator: node.operator, code: "stale", why: "witness-behind", height: top, wanted: wantedTop }] };
  }
  const targetTop = wantedTop === null ? top : Math.min(wantedTop, top);
  const observedTip = tipHeightRaw === null ? top : tipHeightRaw;
  if (targetTop < fromHeight) {
    return { transfers: [], tip: info.height, fromHeight, toHeight, ...UNKNOWN_TOTALS, through: null, complete: true, checkpoint: null, blocked: false, failed: [] };
  }
  const identity = { network, address: request.address, fromHeight, toHeight, keyImages: [] };
  let prior = null;
  if (checkpoint && typeof checkpoint.read === "function") {
    try { prior = validWitnessCheckpoint(checkpoint.read(), identity); }
    catch (error) { throw callerFailure("checkpoint.read", error); }
    if (!prior && typeof checkpoint.discard === "function") {
      try { checkpoint.discard(); }
      catch (error) { throw callerFailure("checkpoint.discard", error); }
    }
  }
  const firstWindow = witnessSliceIndex(fromHeight);
  const startWindow = prior ? witnessSliceIndex(prior.through.height) : firstWindow;
  const lastWindow = witnessSliceIndex(targetTop);
  if (startWindow > lastWindow) {
    if (prior) refreshTransferState(prior.transfers, { tipHeight: observedTip, nowSec: request.nowSec ?? Math.floor(Date.now() / 1000) });
    return { transfers: prior ? prior.transfers : [], tip: info.height, fromHeight, toHeight, ...UNKNOWN_TOTALS, through: prior ? prior.through : null,
      complete: true, checkpoint: prior ? checkpointRecord({ ...identity, through: prior.through, transfers: prior.transfers, spends: prior.spends, kind: "witness" }) : null,
      blocked: false, failed: [] };
  }
  let bytes = 0;
  const countBytes = (n) => { if (Number.isFinite(n) && n > 0) bytes += n; };
  const total = targetTop - witnessSliceStart(firstWindow) + 1;
  let replay = 0;
  const run = async (startRecord) => {
    const fromWindow = startRecord ? witnessSliceIndex(startRecord.through.height) : firstWindow;
    const windowStart = witnessSliceStart(fromWindow);
    let transfers = startRecord ? startRecord.transfers.filter((transfer) => transfer.height < windowStart) : [];
    let spends = [];
    const spendMap = new Map();
    if (startRecord) {
      spends = startRecord.spends.filter((spend) => spend.height === null || spend.height < windowStart);
      addSpends(spendMap, spends);
    }
    let through = null;
    let previousHash = null;
    let blocksVerified = 0;
    const priorThrough = startRecord ? startRecord.through : null;
    const emit = () => {
      try {
        onProgress({ phase: "witness", through: through ? through.height : null, blocksVerified, blocksTotal: total,
          bytes, operator: node.operator, window: through ? witnessSliceIndex(through.height) : fromWindow });
      } catch (error) { throw callerFailure("onProgress", error); }
    };
    emit();
    const sliceWitness = node.protocol === "witness-v1";
    for (let window = fromWindow; window <= lastWindow; window += 1) {
      const start = witnessSliceStart(window);
      let slice = null;
      let sliceTxs = null;
      let sliceError = null;
      if (sliceWitness) {
        try {
          slice = await readWitnessSlice(node, window, { network, fetchImpl, timeoutMs, tipHeight: targetTop });
          sliceTxs = await readSliceTransactions(node, slice, { fetchImpl, timeoutMs });
        } catch (error) {
          sliceError = error;
        }
      }
      const end = slice === null ? Math.min(witnessSliceEnd(window), targetTop) : Math.min(slice.to, targetTop);
      for (let height = start; height <= end; height += 1) {
        if (signal && signal.aborted) throw new SdkError("xmr-no-nodes", { node: node.url, name: "AbortError", why: "cancelled" });
        let block;
        let txs = [];
        try {
          if (sliceWitness) {
            if (sliceError) throw sliceError;
            const witnessBlock = slice.blocks[height - start];
            if (!witnessBlock || witnessBlock.height !== height) {
              throw new SdkError("xmr-no-nodes", { node: node.url, why: "witness-height", height });
            }
            if (!witnessBlock.prev_hash || witnessBlock.num_txes === null) {
              throw new SdkError("xmr-no-nodes", { node: node.url, why: "witness-header-missing", height });
            }
            block = { hash: witnessBlock.hash, parent: witnessBlock.prev_hash,
              numTxes: witnessBlock.num_txes, txHashes: witnessBlock.txids };
            if (witnessBlock.txids.length) {
              txs = witnessBlock.txids.map((txid) => sliceTxs.get(txid));
              if (txs.some((tx) => !tx)) {
                throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-transactions", height });
              }
            }
          } else {
            block = await getBlock(node, height, fetchImpl, timeoutMs, { signal, onBytes: countBytes });
            if (block.txHashes.length) txs = await getBlockTxs(node, block.txHashes, fetchImpl, timeoutMs, { signal, onBytes: countBytes });
          }
          if (!hash64(block.hash)) throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-block", height });
          if (block.numTxes !== null && block.txHashes.length !== block.numTxes) throw new SdkError("xmr-no-nodes", { node: node.url, why: "block-incomplete", height });
          if (previousHash && (!block.parent || normalizedHash(block.parent) !== previousHash)) throw new Error("reorg");
          if (!block.txHashes.every((hash) => hash64(hash))) throw new SdkError("xmr-no-nodes", { node: node.url, why: "block-incomplete", height });
        } catch (error) {
          if (String(error && error.message) === "reorg") throw error;
          if (signal && signal.aborted) throw error;
          const failure = failureOf(error, node);
          failure.height = height;
          const keptThrough = through || (startRecord ? startRecord.through : null);
          const keptTransfers = through ? transfers : (startRecord ? startRecord.transfers : transfers);
          const keptSpends = through ? [...spendMap.values()] : (startRecord ? startRecord.spends : []);
          return { transfers: keptTransfers, tip: info.height, fromHeight, toHeight, ...UNKNOWN_TOTALS, complete: false, through: keptThrough,
            spends: keptSpends,
            checkpoint: keptThrough ? checkpointRecord({ ...identity, through: keptThrough, transfers: keptTransfers, spends: keptSpends, kind: "witness" }) : null,
            blocked: false, failed: [failure] };
        }
        if (priorThrough && height === priorThrough.height && normalizedHash(block.hash) !== priorThrough.hash) throw new Error("reorg");
        for (const tx of txs) {
          addSpends(spendMap, spendsOfTx(tx, tracked, node, { height, blockHash: block.hash }));
          const hit = engine.xmrScan.matchTransaction(tx, [watched], { height, tipHeight: observedTip, nowSec: request.nowSec });
          if (!hit.length || height < fromHeight) continue;
          const confirmations = confirmationsOf(tx, height, observedTip);
          transfers.push(recoveryObservation(tx, hit, node, { height, blockHash: block.hash, confirmations }));
        }
        through = { height, hash: normalizedHash(block.hash) };
        previousHash = through.hash;
        blocksVerified += 1;
        if (checkpoint && typeof checkpoint.save === "function") {
          try { checkpoint.save(checkpointRecord({ ...identity, through, transfers, spends: [...spendMap.values()], kind: "witness" })); }
          catch (error) { throw callerFailure("checkpoint.save", error); }
        }
        emit();
      }
    }
    spends = [...spendMap.values()];
    refreshTransferState(transfers, { tipHeight: observedTip, nowSec: request.nowSec ?? Math.floor(Date.now() / 1000) });
    return { transfers, tip: info.height, fromHeight, toHeight, complete: true, through, spends,
      ...recoveryTotals(transfers, tracked, spends),
      availableAtomic: availableAtomicOf(transfers, tracked, spends, minConfirmations),
      checkpoint: through ? checkpointRecord({ ...identity, through, transfers, spends, kind: "witness" }) : null,
      blocked: false, failed: [] };
  };
  for (;;) {
    try {
      return await run(prior);
    } catch (error) {
      if (signal && signal.aborted) throw error;
      if (error && error.caller) throw error;
      if (String(error && error.message) === "reorg" && replay === 0) {
        replay += 1;
        prior = null;
        if (checkpoint && typeof checkpoint.discard === "function") {
          try { checkpoint.discard(); }
          catch (discardError) { throw callerFailure("checkpoint.discard", discardError); }
        }
        continue;
      }
      const failure = failureOf(error, node);
      return { transfers: [], tip: info.height, fromHeight, toHeight, ...UNKNOWN_TOTALS, complete: false, through: null, checkpoint: null, blocked: false, failed: [failure] };
    }
  }
}

/**
 * THE ARRIVAL DECISION OVER ONE READ. It uses `verifyRecovery` (primary read plus plain-daemon witnesses) and applies
 * the owner's amount rule to the same observations:
 *   - `at-least` (buy): the sum of distinct verified outputs across confirmed, unlocked transfers must reach the quote;
 *   - `exact` (sale): the sum of confirmed, unlocked transfers must equal the signed amount.
 * An incomplete read is unknown; a one-node transfer is not an arrival.
 */
export async function verifyArrivalFromRead(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const rule = request.amountRule === undefined || request.amountRule === null ? "at-least" : request.amountRule;
  if (rule !== "at-least" && rule !== "exact") throw new SdkError("bad-input", { field: "amountRule" });
  let expectedAtomic;
  try { expectedAtomic = BigInt(request.expectedAtomic); } catch { throw new SdkError("bad-input", { field: "expectedAtomic" }); }
  if (expectedAtomic <= 0n) throw new SdkError("bad-input", { field: "expectedAtomic" });
  const fromHeight = intOf(request.fromHeight);
  if (fromHeight === null || fromHeight < 0) throw new SdkError("bad-input", { field: "fromHeight" });
  const recovery = await verifyRecovery({
    nodes: request.nodes, address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub,
    fromHeight, toHeight: request.toHeight, minConfirmations: request.minConfirmations, nowSec: request.nowSec,
    timeoutMs: request.timeoutMs, fetch: request.fetch, keyImages: request.keyImages, spentStatus: request.spentStatus,
    checkpoint: request.checkpoint, onProgress: request.onProgress, signal: request.signal,
  });
  const transfers = recovery.transfers || [];
  const agreed = transfers.filter((transfer) => transfer.agreed === true);
  const usable = agreed.filter((transfer) => transfer.confirmed && !transfer.pool && !transfer.locked);
  const chosen = [];
  const seenOutputs = new Set();
  let total = 0n;
  if (rule === "exact") {
    for (const transfer of usable) {
      let contributed = false;
      for (const output of transfer.outputs || []) {
        if (!output.amountVerified || output.amountAtomic === null || output.amountAtomic === undefined) continue;
        const id = output.key ? String(output.key) + ":" + String(output.amountAtomic) : transfer.txid + ":" + output.index;
        if (seenOutputs.has(id)) continue;
        seenOutputs.add(id);
        total += BigInt(output.amountAtomic);
        contributed = true;
      }
      if (contributed) chosen.push(transfer);
    }
  } else {
    for (const transfer of usable) {
      let contributed = false;
      for (const output of transfer.outputs || []) {
        if (!output.amountVerified || output.amountAtomic === null || output.amountAtomic === undefined) continue;
        const id = output.key ? String(output.key) + ":" + String(output.amountAtomic) : transfer.txid + ":" + output.index;
        if (seenOutputs.has(id)) continue;
        seenOutputs.add(id);
        total += BigInt(output.amountAtomic);
        contributed = true;
      }
      if (contributed) chosen.push(transfer);
    }
  }
  // THE DISPLAYED AMOUNT IS WHAT THE CHAIN SHOWS, EVEN WHEN IT IS NOT ENOUGH. A confirming, locked or short
  // transfer still has a txid and a verified amount; `total` alone would report zero for a payment that is right
  // there and would make the screen lose the fact it is waiting for confirmations.
  const source = agreed.length ? agreed : transfers;
  const displayed = [];
  const displayedOutputs = new Set();
  let displayTotal = 0n;
  for (const transfer of source) {
    let contributed = false;
    for (const output of transfer.outputs || []) {
      if (!output.amountVerified || output.amountAtomic === null || output.amountAtomic === undefined) continue;
      const id = output.key ? String(output.key) + ":" + String(output.amountAtomic) : transfer.txid + ":" + output.index;
      if (displayedOutputs.has(id)) continue;
      displayedOutputs.add(id);
      displayTotal += BigInt(output.amountAtomic);
      contributed = true;
    }
    if (contributed) displayed.push(transfer);
  }
  const seenByAmount = rule === "exact" ? total === expectedAtomic : total >= expectedAtomic;
  const poolHit = transfers.find((transfer) => transfer.pool);
  const completedOperators = recovery.completedOperators || [];
  const requiredOperators = Number(recovery.requiredOperators) || 2;
  const quorate = completedOperators.length >= requiredOperators;
  const seen = seenByAmount && (recovery.complete === true || (rule === "at-least" && quorate));
  // ABSENCE IS THE STRONGEST ANSWER: it lets a buyer take the ETH back. It is allowed only when every configured
  // operator finished the range (and the pool, while the window is open), and there are enough operators to form a
  // quorum. A failing third operator or a one-node read must leave the answer unknown, never absent.
  const absent = transfers.length === 0 && !poolHit && recovery.complete === true && quorate;
  const lockedTransfer = source.find((transfer) => transfer.locked === true) || null;
  const need = Number(recovery.minConfirmations) || 1;
  const confirming = source.some((transfer) => !transfer.pool && !transfer.confirmed && Number(transfer.confirmations) < need);
  let state;
  if (seen) state = "arrived";
  else if (poolHit) state = "pool";
  else if (recovery.complete !== true) state = "unknown";
  else if (source.length === 0) state = "pending";
  else if (lockedTransfer) state = "locked";
  else if (confirming) state = "confirming";
  else if (agreed.length === 0) state = rule === "exact" ? "unknown" : "one-node";
  else if (total < expectedAtomic) state = "short";
  else if (rule === "exact" && total > expectedAtomic) state = "over";
  else state = "pending";
  const comparison = displayTotal === expectedAtomic ? "exact" : displayTotal < expectedAtomic ? "short" : "over";
  const outputs = [];
  const outputKeys = new Set();
  for (const transfer of (chosen.length ? chosen : displayed)) {
    for (const output of transfer.outputs || []) {
      const id = output.key ? String(output.key) + ":" + String(output.amountAtomic) : transfer.txid + ":" + output.index;
      if (outputKeys.has(id)) continue;
      outputKeys.add(id);
      outputs.push({ ...output, txid: transfer.txid, height: transfer.height, blockHash: transfer.blockHash });
    }
  }
  const first = (chosen[0] || displayed[0] || poolHit || null);
  return {
    seen, state,
    absent,
    completedOperators: absent ? completedOperators : undefined,
    txid: first ? first.txid : txidOf(request.txid),
    height: first ? first.height : null,
    blockHash: first ? first.blockHash : null,
    amountAtomic: displayTotal.toString(),
    amountVerified: displayed.length > 0 && displayed.every((transfer) => transfer.outputs.every((output) => output.amountVerified === true)),
    amountRule: rule,
    amountComparison: comparison,
    shortfallAtomic: displayTotal < expectedAtomic ? (expectedAtomic - displayTotal).toString() : "0",
    overageAtomic: displayTotal > expectedAtomic ? (displayTotal - expectedAtomic).toString() : "0",
    confirmations: source.length ? Math.min(...source.map((transfer) => Number(transfer.confirmations))) : 0,
    needConfirmations: recovery.minConfirmations,
    tip: recovery.tip,
    operators: [...new Set(source.flatMap((transfer) => transfer.operators || []))],
    checked: recovery.checked,
    failed: recovery.failed,
    outputs,
    transfers: chosen.length ? chosen : displayed,
    locked: lockedTransfer !== null,
    unlock: lockedTransfer ? lockedTransfer.unlock : null,
    agreedBy: source.flatMap((transfer) => transfer.agreedBy || []),
  };
}

/**
 * THE RECOVERY READ. Unlike `verifyArrival`, it has no expected amount and never calls a short transfer a refusal:
 * it returns every matching transfer from the order's start height, including a transfer still in the pool. Each
 * transfer carries its verified outputs and the operators that agreed on the same observation. A transfer seen by
 * one operator is returned with `agreed: false`; a recovery UI must decide whether to wait for the second operator.
 */
export async function verifyRecovery(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  const nodes = normalizeNodes(request.nodes);
  const primaryNode = nodes[0];
  if (!isStr(request.address)) throw new SdkError("bad-input", { field: "address" });
  if (request.viewSecret === undefined || request.viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
  if (request.spendPub !== undefined && request.spendPub !== null && !isStr(request.spendPub)) throw new SdkError("bad-input", { field: "spendPub" });
  const fromHeight = intOf(request.fromHeight);
  if (fromHeight === null || fromHeight < 0) throw new SdkError("bad-input", { field: "fromHeight" });
  const toHeight = request.toHeight === null || request.toHeight === undefined ? null : intOf(request.toHeight);
  if (request.toHeight !== null && request.toHeight !== undefined && (toHeight === null || toHeight < fromHeight)) {
    throw new SdkError("bad-input", { field: "toHeight" });
  }
  const minConfirmations = Math.max(1, intOf(request.minConfirmations) ?? 1);
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const nowSec = Number.isFinite(Number(request.nowSec)) ? Number(request.nowSec) : Math.floor(Date.now() / 1000);
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 20000;
  const signal = request.signal && typeof request.signal.addEventListener === "function" ? request.signal : null;
  const checkpoint = request.checkpoint && typeof request.checkpoint === "object" ? request.checkpoint : null;
  const onProgress = typeof request.onProgress === "function" ? request.onProgress : null;
  const bound = engine.xmrScan.watchedAddressVerdict({
    address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub,
  });
  if (!bound.ok) {
    if (bound.code === "bad-input") throw new SdkError("bad-input", { field: bound.field || "address", why: bound.why });
    throw new SdkError(bound.code, { field: bound.field || "address", address: request.address });
  }
  const watched = { address: request.address, viewSecret: bound.viewSecret, spendPub: bound.spendPub };
  const spendPub = bound.spendPub;

  const tracked = normalizeKeyImages(request.keyImages);
  const live = [];
  const failed = [];
  for (const node of nodes) {
    try { live.push({ node, info: await getInfo(node, fetchImpl, timeoutMs) }); }
    catch (error) { failed.push(failureOf(error, node)); }
  }
  if (!live.length) throw new SdkError("xmr-no-nodes", { tried: nodes.map((n) => n.url), nodes: failed });
  const checked = live.map((entry) => ({ url: entry.node.url, operator: entry.node.operator,
    height: entry.info.height, synchronized: entry.info.synced }));
  // THE PRIMARY IS THE FIRST CONFIGURED NODE. A witness that happens to answer first is never promoted and never
  // receives the exact-start walk or key images; without the primary the read is incomplete.
  const primaryLive = live.find((entry) => entry.node === primaryNode);
  const addressNetwork = bound.keys && bound.keys.network ? bound.keys.network : null;
  const earlyNetwork = isStr(request.network) ? request.network : addressNetwork;
  if (!primaryLive) {
    return { state: "none", transfers: [], tip: null, fromHeight, toHeight, minConfirmations, complete: false,
      completedOperators: [], spends: [], spendsDisagreements: [], ...UNKNOWN_TOTALS, availableAtomic: null,
      availableSource: null, network: earlyNetwork,
      requiredOperators: earlyNetwork === "mainnet" ? 3 : 2, checked, failed };
  }
  const tip = primaryLive.info.height;
  const top = Math.max(0, tip - 1);
  const network = isStr(request.network) ? request.network : (primaryLive.info.nettype || addressNetwork);
  if (!isStr(network)) throw new SdkError("bad-input", { field: "network" });
  const requiredOperators = network === "mainnet" ? 3 : 2;
  const observations = new Map();
  const spendMap = new Map();
  // A CONFIGURED NODE THAT DID NOT ANSWER `get_info` IS NOT PART OF A COMPLETE READ. `at-least` may still settle on
  // the operator quorum; `exact` and absence may not.
  let complete = failed.length === 0;
  const completedOperators = new Set();
  let availableAtomic = null;
  let primarySpends = [];

  for (let index = 0; index < live.length; index += 1) {
    const { node, info } = live[index];
    const isPrimary = node === primaryNode;
    if (!info.synced) {
      failed.push({ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" });
      complete = false;
      continue;
    }
    // A WITNESS AHEAD OF THE PRIMARY PROVES THAT THE PRIMARY IS BEHIND. Reading the witness only to the primary's
    // top would then turn a payment it can already see into a false absence. No source is promoted instead. A
    // one-block propagation skew therefore yields unknown until the next poll: safe, and self-healing.
    if (!isPrimary && Number(info.height) > Number(tip)) {
      failed.push({ url: node.url, operator: node.operator, code: "stale", why: "witness-ahead" });
      complete = false;
      continue;
    }
    // EVERY WITNESS IS READ TO THE PRIMARY'S VERIFIED TOP. A witness below it cannot answer the top blocks, so its
    // read is incomplete. A witness ahead of the primary has already been refused above, not clamped or promoted.
    const nodeTop = top;
    let read;
    let poolComplete = true;
    try {
      const common = {
        address: request.address, viewSecret: request.viewSecret, spendPub,
        fromHeight, toHeight, minConfirmations, network,
        nowSec, timeoutMs, idleTimeoutMs: request.idleTimeoutMs ?? request.timeoutMs, fetch: fetchImpl,
        spentStatus: request.spentStatus,
      };
      // THE WITNESS NEVER GETS KEY IMAGES. Its job is agreement on the block data; spent status belongs to the
      // trusted primary node. `spentStatus: false` reaches this read too, so a caller that opted out sends none.
      read = isPrimary
        ? await readRecovery({ ...common, node, keyImages: request.keyImages, checkpoint, onProgress, signal })
        : await readRecoveryWitness({ ...common, node, tipHeight: nodeTop, onProgress, signal });
    } catch (error) {
      failed.push(failureOf(error, node));
      complete = false;
      continue;
    }
    if (!isPrimary && !(toHeight !== null && toHeight < top)) {
      try {
        const pool = await scanRecoveryPoolState(node, {
          watched, tracked, tip: nodeTop, nowSec, fetchImpl, timeoutMs,
        });
        for (const transfer of pool.transfers) {
          if (!observations.has(transfer.txid)) observations.set(transfer.txid, []);
          observations.get(transfer.txid).push(transfer);
        }
        addSpends(spendMap, pool.spends);
      } catch (error) {
        failed.push({ ...failureOf(error, node), why: "pool-read" });
        complete = false;
        poolComplete = false;
      }
    }
    for (const transfer of read.transfers) {
      if (!observations.has(transfer.txid)) observations.set(transfer.txid, []);
      observations.get(transfer.txid).push(transfer);
    }
    if (isPrimary) primarySpends = read.spends || [];
    addSpends(spendMap, read.spends || []);
    if (availableAtomic === null && read.availableAtomic !== null && read.availableAtomic !== undefined) {
      availableAtomic = read.availableAtomic;
    }
    failed.push(...(read.failed || []));
    if (read.complete !== true) complete = false;
    else if (poolComplete) completedOperators.add(node.operator);
  }

  const transfers = [];
  for (const [txid, list] of observations) {
    // A TRANSFER IS AGREED ONLY ON THE SAME OBSERVATION. Different blocks, outputs, amounts or unlock states are
    // separate observations, not a majority vote that hides a lie.
    const groups = new Map();
    for (const observation of list) {
      const key = JSON.stringify({
        height: observation.height, blockHash: observation.blockHash, outputs: observation.outputs,
        amountAtomic: observation.amountAtomic, amountVerified: observation.amountVerified,
        locked: observation.locked, pool: observation.pool,
        unlock: observation.unlock ? { locked: observation.unlock.locked, untilHeight: observation.unlock.untilHeight ?? null, untilTime: observation.unlock.untilTime ?? null } : null,
      });
      if (!groups.has(key)) groups.set(key, { observation, nodes: [] });
      groups.get(key).nodes.push(observation);
    }
    const ranked = [...groups.values()].sort((a, b) => b.nodes.length - a.nodes.length
      || String(a.observation.operator).localeCompare(String(b.observation.operator)));
    const best = ranked[0];
    const operators = [...new Set(best.nodes.map((entry) => entry.operator))];
    const confirmations = Math.min(...best.nodes.map((entry) => Number(entry.confirmations)));
    transfers.push({
      txid,
      height: best.observation.height,
      blockHash: best.observation.blockHash,
      pool: best.observation.pool,
      confirmations,
      confirmed: confirmations >= minConfirmations && !best.observation.pool,
      amountAtomic: best.observation.amountAtomic,
      amountVerified: best.observation.amountVerified,
      outputs: best.observation.outputs,
      locked: best.observation.locked,
      unlock: best.observation.unlock,
      operators,
      agreed: operators.length >= 2,
      agreedBy: best.nodes.map((entry) => ({ url: entry.url, operator: entry.operator, confirmations: entry.confirmations })),
      disagreements: ranked.length > 1
        ? ranked.slice(1).map((entry) => ({ operators: [...new Set(entry.nodes.map((node) => node.operator))], amountAtomic: entry.observation.amountAtomic }))
        : [],
    });
  }
  transfers.sort((a, b) => (a.height === null ? Number.MAX_SAFE_INTEGER : a.height) - (b.height === null ? Number.MAX_SAFE_INTEGER : b.height)
    || String(a.txid).localeCompare(String(b.txid)));

  const spends = [...spendMap.values()];
  const primarySpendSet = new Set(primarySpends.map((spend) => spend.keyImage));
  const spendsDisagreements = spends.filter((spend) => !primarySpendSet.has(spend.keyImage));
  const completeVerdict = complete && spendsDisagreements.length === 0;
  // A SPEND ONLY A WITNESS SAW IS NOT A SETTLED FIGURE. The same conservatism that withholds `availableAtomic`
  // makes the window totals unknown rather than including a disputed spend.
  const totals = completeVerdict
    ? recoveryTotals(transfers, tracked, spends)
    : { receivedAtomic: null, spentAtomic: null, unspentAtomic: null, withdrawalState: "unknown" };
  const availableForVerdict = spendsDisagreements.length ? null : availableAtomic;
  const ready = transfers.some((transfer) => transfer.agreed && transfer.confirmed && !transfer.locked);
  const agreed = transfers.some((transfer) => transfer.agreed);
  return {
    state: ready ? "ready" : (agreed ? "pending" : (transfers.length ? "one-node" : "none")),
    transfers,
    tip,
    fromHeight,
    toHeight,
    minConfirmations,
    network,
    requiredOperators,
    complete: completeVerdict,
    completedOperators: [...completedOperators],
    spends,
    spendsDisagreements,
    ...totals,
    availableAtomic: availableForVerdict,
    availableSource: primaryLive ? { url: primaryLive.node.url, operator: primaryLive.node.operator } : null,
    checked,
    failed,
  };
}

// ---------------------------------------------------------------------------
// WITNESS-V1: FIXED BLOCK SLICES FOR THE SHADOW CHECK
// ---------------------------------------------------------------------------
//
// This is the client side of the read-only slice endpoint. It is deliberately a SEPARATE call from
// `verifyArrival`: the production decision still uses the exact walk until an independent operator serves
// witness-v1. `verifyArrivalShadow` runs both and compares them without changing ready, refund or any swap state.

export { WITNESS_SLICE_BLOCKS, witnessSliceEnd, witnessSliceIndex, witnessSliceStart, parseWitnessSliceBody };

async function readWitnessSlice(node, index, { network, fetchImpl, timeoutMs, tipHeight = null }) {
  if (node.protocol !== "witness-v1") throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-slice-witness" });
  const body = await call(node, "/v1/witness/slice",
    { version: 1, network, grid: WITNESS_SLICE_BLOCKS, slice: index }, fetchImpl, timeoutMs);
  return parseWitnessSliceBody(body, { network, index, tipHeight });
}

// ALL THE TRANSACTIONS OF A SLICE, IN ONE REQUEST. The request names the whole slice's txids, not the one
// transaction an order is looking for.
async function readSliceTransactions(node, slice, { fetchImpl, timeoutMs }) {
  const txids = [...new Set(slice.blocks.flatMap((block) => block.txids))];
  if (!txids.length) return new Map();
  if (txids.length > 4096) throw new SdkError("xmr-no-nodes", { node: node.url, why: "slice-too-large", count: txids.length });
  const txs = await getBlockTxs(node, txids, fetchImpl, timeoutMs);
  return new Map(txs.map((tx) => [String(tx.tx_hash || "").toLowerCase(), tx]));
}

// THE TOP THE WALK MUST REACH. A witness may be behind the exact nodes, and a walk that stops at the witness's
// own top must not count as a completed walk: the blocks above it were never read by any source that claimed
// absence. The exact `verifyArrival` reports its tip on the absence path and the checked heights on the arrived
// path; both are the highest top the exact sources actually read.
function exactTopOf(exact) {
  if (!exact || typeof exact !== "object") return null;
  // THE HEIGHTS THAT BELONG TO A SYNCED EXACT NODE. A stale node can report a height far above the chain it has
  // actually read; using its number as the target would keep every honest witness below it. Prefer the checked
  // heights when they exist, and fall back to the tip only for an answer that carries no checked entries.
  const heights = Array.isArray(exact.checked)
    ? exact.checked
      .filter((entry) => entry && entry.synchronized !== false && entry.state !== "stale" && entry.state !== "down")
      .map((entry) => intOf(entry.height))
      .filter((height) => height !== null && height > 0)
    : [];
  if (Array.isArray(exact.checked) && exact.checked.length) {
    return heights.length ? Math.max(0, Math.max(...heights) - 1) : null;
  }
  const tip = intOf(exact.tip);
  if (tip !== null && tip > 0) return Math.max(0, tip - 1);
  return null;
}

// FIND A PAYMENT THROUGH SLICES. The exact `fromHeight` is local: the witness sees only slice indexes.
async function locateInSlices(node, { expectedAtomic, address, viewSecret, spendPub, fromHeight, toHeight, targetTop = toHeight, nowSec, network, fetchImpl, timeoutMs }) {
  const target = intOf(targetTop);
  if (target === null) throw new SdkError("bad-input", { field: "targetTop" });
  // A WITNESS BEHIND THE FIRST BLOCK HAS NOT READ THE RANGE. The slice walk below would otherwise mark its last
  // slice complete and let a lagging witness vouch for a payment it never saw.
  if (target < fromHeight || toHeight < fromHeight) return { located: null, completed: false };
  const first = witnessSliceIndex(fromHeight);
  const last = witnessSliceIndex(Math.min(toHeight, target));
  let best = null;
  let completed = false;
  let servedTop = null;
  let failure = null;
  for (let index = first; index <= last; index++) {
    let slice;
    let txs;
    try {
      // The witness reads its tip at slice time, so a block can arrive between the tip read and this request. The
      // parser accepts a newer tip and rejects one below the top the walk started from.
      slice = await readWitnessSlice(node, index, { network, fetchImpl, timeoutMs, tipHeight: toHeight });
      txs = await readSliceTransactions(node, slice, { fetchImpl, timeoutMs });
    } catch (error) {
      // A CANDIDATE FOUND BEFORE THE FAILURE IS STILL A CANDIDATE. The slice walk is evidence, and a later
      // refused slice does not erase the transaction already read from an earlier one. The caller records the
      // failure beside the located candidate; an absence still requires the whole walk.
      failure = error;
      break;
    }
    // THE HIGHEST BLOCK THE WITNESS ACTUALLY SERVED. A newer tip can arrive inside the last slice; the caller
    // uses this to raise the common target, so a walk that stopped at 115 cannot complete a target of 116.
    servedTop = servedTop === null ? slice.to : Math.max(servedTop, slice.to);
    for (const block of slice.blocks) {
      // THE SLICE IS A FIXED WINDOW; THE SWAP STARTS AT `fromHeight`. Blocks before the birth height may contain
      // an earlier transfer to the same address, and counting them would make the slice walk disagree with the
      // exact walk that starts at the birth height.
      if (block.height < fromHeight) continue;
      for (const txid of block.txids) {
        const tx = txs.get(txid);
        if (!tx) continue;
        const hit = engine.xmrScan.matchTransaction(tx, [{ address, viewSecret, spendPub }], {
          height: block.height, tipHeight: Math.max(0, toHeight), nowSec,
        });
        if (!hit.length) continue;
        const amountAtomic = sumOutputs(hit[0]);
        const amountVerified = hit[0].outputs.every((o) => o.amountVerified === true);
        const locked = hit[0].unlock && hit[0].unlock.locked === true;
        const score = (amountAtomic >= expectedAtomic ? 4 : 0) + (amountVerified ? 2 : 0) + (locked ? 0 : 1);
        const candidate = { txid, height: block.height, blockHash: block.hash, amountAtomic, locked, score };
        if (betterCandidate(candidate, best)) best = candidate;
      }
    }
    // THE WHOLE SLICE WAS READ. A perfect candidate does not end the walk: a later slice can contain a newer tip,
    // and the witness must still prove it reached the common target. Completion is judged by the LAST BLOCK the
    // witness actually served, not by the slice index: a witness can stop inside the same 20-block window as the
    // target and still be behind it.
    if (index === last) completed = slice.to >= target;
  }
  return { located: best, completed, servedTop, failure };
}

/**
 * RUN THE PRODUCTION CHECK AND THE SLICE CHECK SIDE BY SIDE.
 *
 * This is a shadow: it returns the exact verdict, the slice reading and the differences. It never flips
 * `ready`, signs anything or changes a swap. It is the first step before a slice-only default.
 *
 * `witnessNodes` must name at least one `{url, operator, protocol: "witness-v1"}` node. A URL without the
 * protocol is not guessed into an endpoint.
 */
export async function verifyArrivalShadow(request) {
  if (!request || typeof request !== "object") throw new SdkError("bad-input", { field: "request" });
  if (request.witnessNodes === undefined || request.witnessNodes === null) {
    throw new SdkError("bad-input", { field: "witnessNodes", why: "required" });
  }
  const witnessNodes = normalizeNodes(request.witnessNodes);
  if (!witnessNodes.some((node) => node.protocol === "witness-v1")) {
    throw new SdkError("bad-input", { field: "witnessNodes", why: "no-witness-v1" });
  }
  // THE SAME ENGINE BINDING AS `verifyArrival`. The shadow path does not carry a second copy of the view/spend rule.
  if (!isStr(request.address)) throw new SdkError("bad-input", { field: "address" });
  if (!isStr(request.spendPub)) throw new SdkError("bad-input", { field: "spendPub" });
  if (request.viewSecret === undefined || request.viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
  const bound = engine.xmrScan.watchedAddressVerdict({
    address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub,
  });
  if (!bound.ok) {
    if (bound.code === "bad-input") throw new SdkError("bad-input", { field: bound.field || "address", why: bound.why });
    throw new SdkError(bound.code, { field: bound.field || "address", address: request.address });
  }
  const network = request.network || bound.keys.network;
  const viewSecret = bound.viewSecret;
  const spendPub = bound.spendPub;
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 20000;
  const nowSec = Number.isFinite(Number(request.nowSec)) ? Number(request.nowSec) : Math.floor(Date.now() / 1000);
  const fromHeight = Number(request.fromHeight);
  if (!Number.isSafeInteger(fromHeight) || fromHeight <= 0) throw new SdkError("bad-input", { field: "fromHeight" });
  let expectedAtomic;
  try { expectedAtomic = BigInt(request.expectedAtomic); } catch { throw new SdkError("bad-input", { field: "expectedAtomic" }); }
  if (expectedAtomic <= 0n) throw new SdkError("bad-input", { field: "expectedAtomic" });

  let exact = null;
  let exactError = null;
  try { exact = await verifyArrival(request); }
  catch (error) { exactError = { code: error && error.code ? error.code : "unknown", params: (error && error.params) || {} }; }

  const checked = [];
  const failed = [];
  const staleWitnesses = [];
  const readable = [];
  const observations = [];
  // THE WALK MUST REACH THE HIGHEST TOP ANY SOURCE READ. A witness that is behind the exact nodes OR behind another
  // witness cannot prove absence in the blocks it has not seen; its own `toHeight` is therefore not the completion
  // target. Collect every top first, then walk against the common target.
  const exactTop = exactTopOf(exact);
  let highestTop = exactTop;
  for (const node of witnessNodes) {
    if (node.protocol !== "witness-v1") { failed.push({ url: node.url, operator: node.operator, code: "no-slice-witness" }); continue; }
    let info;
    try { info = await getInfo(node, fetchImpl, timeoutMs); }
    catch (error) { failed.push(failureOf(error, node)); checked.push({ url: node.url, operator: node.operator, state: "down" }); continue; }
    if (!info.synced) {
      staleWitnesses.push({ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" });
      checked.push({ url: node.url, operator: node.operator, state: "stale", height: info.height });
      continue;
    }
    const top = Math.max(0, info.height - 1);
    const entry = { url: node.url, operator: node.operator, state: "ok", height: info.height };
    checked.push(entry);
    highestTop = highestTop === null ? top : Math.max(highestTop, top);
    readable.push({ node, top, entry });
  }
  const walkResults = [];
  for (const { node, top, entry } of readable) {
    const targetTop = highestTop === null ? top : Math.max(top, highestTop);
    try {
      const found = await locateInSlices(node, {
        expectedAtomic, address: request.address, viewSecret, spendPub, fromHeight, toHeight: top,
        targetTop,
        nowSec, network, fetchImpl, timeoutMs,
      });
      walkResults.push({ node, top, entry, found });
    } catch (error) {
      entry.state = "error";
      failed.push(failureOf(error, node));
    }
  }

  // THE TARGET CAN MOVE DURING THE WALK. A witness may serve a tip newer than every `get_info` top, and the
  // parser accepts it; the earlier target would let the other witnesses complete against a block they never read.
  // Raise the target to the highest served tip and judge completion again, after every walk.
  for (const { found } of walkResults) {
    if (found.servedTop === null || found.servedTop === undefined) continue;
    highestTop = highestTop === null ? found.servedTop : Math.max(highestTop, found.servedTop);
  }

  let located = null;
  let completed = false;
  const completedWitnessOperators = new Set();
  for (const { node, entry, found } of walkResults) {
    const finalCompleted = Boolean(found.completed && found.servedTop !== null
      && highestTop !== null && found.servedTop >= highestTop);
    if (found.failure) {
      failed.push(failureOf(found.failure, node));
      entry.state = "error";
    } else {
      entry.state = finalCompleted ? "ok" : (found.located ? "partial" : "behind");
    }
    completed = completed || finalCompleted;
    if (finalCompleted) completedWitnessOperators.add(node.operator || node.url);
    if (found.located) {
      observations.push({
        operator: node.operator || node.url, url: node.url, seen: true, completed: finalCompleted,
        txid: found.located.txid, height: found.located.height, blockHash: found.located.blockHash,
        amountAtomic: found.located.amountAtomic.toString(), locked: found.located.locked === true,
      });
      if (!located || found.located.score > located.score) {
        located = found.located;
        located.operator = node.operator;
        located.url = node.url;
      }
    } else if (finalCompleted) {
      observations.push({ operator: node.operator || node.url, url: node.url, seen: false, completed: true,
        txid: null, height: null, blockHash: null, amountAtomic: null, locked: null });
    }
  }

  if (!located) failed.push(...staleWitnesses);
  const completedOperators = [...completedWitnessOperators];
  const independentOperators = completedOperators.filter((operator) => String(operator).toLowerCase() !== "ninsei");

  // ONE OPINION PER OPERATOR, THEN COMPARE THE OPINIONS. A second instance of the same operator may repeat the
  // first, but it may not silently contradict it; a different operator that reports another block, amount or
  // unlock state is a disagreement even when its own walk completed. Without this the first matching candidate
  // hid the contradiction only because of its score or iteration order.
  const normalizedObservation = (observation) => ({
    operator: String(observation.operator || observation.url || ""),
    seen: observation.seen === true,
    txid: observation.txid === null || observation.txid === undefined ? null : String(observation.txid).toLowerCase(),
    height: observation.height === null || observation.height === undefined ? null : Number(observation.height),
    blockHash: observation.blockHash === null || observation.blockHash === undefined
      ? null : String(observation.blockHash).toLowerCase(),
    amountAtomic: observation.amountAtomic === null || observation.amountAtomic === undefined
      ? null : String(observation.amountAtomic),
    locked: observation.locked === null || observation.locked === undefined ? null : observation.locked === true,
  });
  const observationField = (a, b) => {
    for (const field of ["seen", "txid", "height", "blockHash", "amountAtomic", "locked"]) {
      if (a[field] !== b[field]) return field;
    }
    return null;
  };
  const groups = new Map();
  for (const observation of observations) {
    const normalized = normalizedObservation(observation);
    const key = normalized.operator.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(normalized);
  }
  const witnessDisagreements = [];
  for (const [operator, entries] of groups) {
    for (let i = 1; i < entries.length; i += 1) {
      const field = observationField(entries[0], entries[i]);
      if (field) witnessDisagreements.push({ operators: [operator], field, against: "same-operator" });
    }
  }
  const representatives = [...groups.values()].map((entries) => entries[0]);
  for (let i = 1; i < representatives.length; i += 1) {
    const field = observationField(representatives[0], representatives[i]);
    if (field) witnessDisagreements.push({ operators: [representatives[0].operator, representatives[i].operator], field });
  }
  // A QUORUM OF WALKERS IS NOT A QUORUM OF ANSWERS. Compute this after the witness-to-witness comparison: two
  // completed operators that disagree have not agreed on anything, even though each reached the target.
  const required = 2;
  const witnessQuorum = { required, completed: completedOperators, independent: independentOperators,
    ok: (network === "mainnet" ? independentOperators.length : completedOperators.length) >= required
      && witnessDisagreements.length === 0 };
  const witnessEvidence = { observations: representatives, disagreements: witnessDisagreements };

  const witness = located
    ? { state: "seen", txid: located.txid, height: located.height, blockHash: located.blockHash,
        amountAtomic: located.amountAtomic.toString(), operator: located.operator, url: located.url, completed, checked, failed,
        ...witnessEvidence, quorum: witnessQuorum }
    : { state: "pending", txid: null, height: null, blockHash: null, amountAtomic: null, completed, checked, failed,
        ...witnessEvidence, quorum: witnessQuorum };

  const problems = [];
  let agrees = null;
  if (exactError) problems.push("exact:" + exactError.code);
  if (located && exact && exact.txid) {
    const add = (token) => { if (!problems.includes(token)) problems.push(token); };
    for (const observation of representatives) {
      if (!observation.seen) {
        add("witness:txid");
        witnessDisagreements.push({ operators: [observation.operator], field: "seen", against: "exact" });
        continue;
      }
      if (String(exact.txid).toLowerCase() !== observation.txid) {
        add("txid");
        witnessDisagreements.push({ operators: [observation.operator], field: "txid", against: "exact" });
      }
      if (Number(exact.height) !== observation.height) {
        add("height");
        witnessDisagreements.push({ operators: [observation.operator], field: "height", against: "exact" });
      }
      if (String(exact.blockHash || "").toLowerCase() !== observation.blockHash) {
        add("blockHash");
        witnessDisagreements.push({ operators: [observation.operator], field: "blockHash", against: "exact" });
      }
      if (String(exact.amountAtomic ?? "") !== observation.amountAtomic) {
        add("amount");
        witnessDisagreements.push({ operators: [observation.operator], field: "amountAtomic", against: "exact" });
      }
    }
    if (checked.some((entry) => entry.state !== "ok")) add("witness:not-completed");
    if (witnessDisagreements.length) add("witness:disagreement");
    agrees = problems.length === 0;
  } else if (located) {
    problems.push("exact:no-transaction");
    agrees = false;
  } else if (exact && exact.absent === true) {
    // ABSENCE NEEDS THE WHOLE SLICE WALK AND TWO DISTINCT OPERATORS. A server that is down, stale or answered a
    // partial slice has not shown that the money is absent; one completed operator is also not the exact path's
    // quorum and must not become agreement. Two instances of one operator count once.
    if (witness.completed && witness.failed.length === 0 && witness.quorum.ok && !witnessDisagreements.length) agrees = true;
    else {
      agrees = false;
      problems.push(witness.completed && witness.failed.length === 0 ? "witness:no-quorum" : "witness:not-completed");
      if (witnessDisagreements.length) problems.push("witness:disagreement");
    }
  }
  return { exact, exactError, witness, agrees, problems };
}

/**
 * IS THERE STILL TIME FOR THE CONFIRMATIONS? Ten confirmations of Monero are about twenty minutes, and the ready
 * deadline does not move. If less than that is left, the client must NAME it and not start - waiting silently would
 * start a trade that cannot be finished in time. Returns seconds left; refuses with `xmr-too-late` otherwise.
 */
export function assertTimeForConfirmations({ readyBySec, nowSec, minConfirmations, blockTimeSec, minLeadSec = null } = {}) {
  const readyBy = Number(readyBySec);
  const now = Number.isFinite(Number(nowSec)) ? Number(nowSec) : Math.floor(Date.now() / 1000);
  const count = Math.max(1, intOf(minConfirmations) ?? 1);
  const block = Number.isFinite(Number(blockTimeSec)) && Number(blockTimeSec) > 0 ? Number(blockTimeSec) : 120;
  if (!Number.isFinite(readyBy) || readyBy <= 0) return null;   // no deadline known - nothing to compare against
  // THE NODE'S LEAD WINS WHEN IT IS LONGER. A maker that advertises a 2400 s minimum cannot be paid in the old
  // 1200 s; the client uses the longer of the two so its own confirmations and the maker's settlement both fit.
  const nodeLead = Number.isFinite(Number(minLeadSec)) && Number(minLeadSec) > 0 ? Number(minLeadSec) : 0;
  const needSec = Math.max(count * block, nodeLead);
  const leftSec = Math.floor(readyBy - now);
  if (leftSec < needSec) throw new SdkError("xmr-too-late", { needSec, leftSec, minConfirmations: count, readyBy: Math.floor(readyBy) });
  return leftSec;
}
