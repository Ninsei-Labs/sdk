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
  else if (/^(TimeoutError|AbortError)$/.test(name) || /timeout|abort/i.test(why) || /timeout|abort/i.test(name)) code = "timeout";
  else if (why === "bad-json" || why === "no-height" || why === "no-block" || why === "busy" || why === "partial-transactions") code = "bad-answer";
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
  let res;
  const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
  let signal = timeout;
  const external = options.signal;
  if (external && typeof external.addEventListener === "function") {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (external.aborted) abort();
    else external.addEventListener("abort", abort, { once: true });
    if (timeout) timeout.addEventListener("abort", abort, { once: true });
    signal = controller.signal;
  }
  try {
    res = await fetchImpl(node.url + path, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
      signal: signal || undefined,
    });
  } catch (error) {
    // KEEP THE NAME: `AbortSignal.timeout` is "TimeoutError" in a browser and "AbortError" in Node; the message
    // alone is not portable, and the arrival report has to say timeout rather than network.
    throw new SdkError("xmr-no-nodes", { node: node.url, name: String((error && error.name) || ""),
      why: String((error && error.message) || error).slice(0, 120) });
  }
  if (!res || res.ok !== true) throw new SdkError("xmr-no-nodes", { node: node.url, status: res ? res.status : null });
  if (typeof options.onBytes === "function") {
    try { options.onBytes((await res.clone().arrayBuffer()).byteLength); } catch { /* the body is the answer */ }
  }
  try { return await res.json(); } catch (error) {
    // A BODY CUT BY THE TIMEOUT IS STILL A TIMEOUT. `res.json()` rejects after the signal fired; in Node and in
    // browsers that is a TimeoutError/AbortError, not a malformed answer.
    const name = String((error && error.name) || "");
    const timedOut = /^(TimeoutError|AbortError)$/.test(name) || /timeout|abort/i.test(name);
    throw new SdkError("xmr-no-nodes", { node: node.url, name, why: timedOut ? "timeout" : "bad-json" });
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
  const nodes = normalizeNodes(request.nodes);
  if (!isStr(request.address)) throw new SdkError("bad-input", { field: "address" });
  if (request.viewSecret === undefined || request.viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
  if (!isStr(request.spendPub)) throw new SdkError("bad-input", { field: "spendPub" });
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

async function scanRecoveryPoolState(node, { watched, tracked, tip, nowSec, fetchImpl, timeoutMs }) {
  const body = await call(node, "/get_transaction_pool_hashes", {}, fetchImpl, timeoutMs);
  const hashes = Array.isArray(body.tx_hashes)
    ? body.tx_hashes.map((hash) => String(hash).replace(/^0x/, "").toLowerCase()).filter((hash) => /^[0-9a-f]{64}$/.test(hash))
    : [];
  if (!hashes.length) return { transfers: [], spends: [] };
  const txs = await getBlockTxs(node, hashes, fetchImpl, timeoutMs);
  const transfers = [];
  const spends = [];
  for (const tx of txs) {
    spends.push(...spendsOfTx(tx, tracked, node, { height: null, blockHash: null, pool: true }));
    const hit = engine.xmrScan.matchTransaction(tx, [watched], { height: null, tipHeight: Math.max(0, tip), nowSec });
    if (!hit.length) continue;
    transfers.push(recoveryObservation(tx, hit, node, { height: null, blockHash: null, confirmations: 0, pool: true }));
  }
  return { transfers, spends };
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
    through: record.through, transfers: record.transfers, outputs: record.outputs, spends: record.spends,
  });
  return engine.xmrScan.bytesToHex(engine.xmrScan.keccak(new TextEncoder().encode(text)));
}

function checkpointRecord({ network, address, fromHeight, through, transfers, spends = [], kind = null }) {
  const record = {
    version: CHECKPOINT_VERSION, network, address, fromHeight, through,
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
  if (!Array.isArray(record.transfers) || !Array.isArray(record.outputs) || !Array.isArray(record.spends)) return null;
  if (!record.through || !Number.isSafeInteger(record.through.height) || !hash64(record.through.hash)) return null;
  if (record.through.height < identity.fromHeight) return null;
  if (record.digest !== checkpointDigest(record)) return null;
  return record;
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
  const fromHeight = request.fromHeight === null || request.fromHeight === undefined ? null : intOf(request.fromHeight);
  if (fromHeight === null || fromHeight < 0) throw new SdkError("bad-input", { field: "fromHeight" });
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
  let info;
  try { info = await getInfo(node, fetchImpl, timeoutMs, { signal }); }
  catch (error) {
    return { transfers: [], tip: null, fromHeight, minConfirmations,
      complete: false, through: null, checkpoint: null, blocked: false, failed: [failureOf(error, node)] };
  }
  const network = isStr(request.network) ? request.network : info.nettype;
  if (!isStr(network)) throw new SdkError("bad-input", { field: "network" });
  if (addressNetwork && info.nettype && addressNetwork !== info.nettype) {
    throw new SdkError("bad-input", { field: "node", why: "node-network-mismatch" });
  }
  if (!info.synced) {
    return { transfers: [], tip: info.height, fromHeight, minConfirmations,
      complete: false, through: null, checkpoint: null, blocked: true,
      failed: [{ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" }] };
  }
  const top = Math.max(0, info.height - 1);
  if (top < fromHeight) {
    return { transfers: [], tip: info.height, fromHeight, minConfirmations, complete: true, through: null,
      checkpoint: null, blocked: false, failed: [] };
  }
  const identity = { network, address: request.address, fromHeight };
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
        return { transfers, tip: info.height, fromHeight, minConfirmations, complete: false, through,
          spends: [...spendMap.values()],
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
        const failure = failureOf(error, node);
        failure.height = height;
        return { transfers, tip: info.height, fromHeight, minConfirmations, complete: false, through,
          spends: [...spendMap.values()],
          checkpoint: through ? checkpointRecord({ ...identity, through, transfers, spends: [...spendMap.values()] }) : null, blocked: false, failed: [failure] };
      }
      for (const tx of txs) {
        addSpends(spendMap, spendsOfTx(tx, tracked, node, { height, blockHash: block.hash }));
        const hit = engine.xmrScan.matchTransaction(tx, [watched], { height, tipHeight: top, nowSec: request.nowSec });
        if (!hit.length) continue;
        const confirmations = confirmationsOf(tx, height, top);
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
    try {
      const pool = await scanRecoveryPoolState(node, {
        watched, tracked, tip: top, nowSec: request.nowSec, fetchImpl, timeoutMs,
      });
      const known = new Set(transfers.map((transfer) => transfer.txid));
      for (const transfer of pool.transfers) {
        if (known.has(transfer.txid)) continue;
        known.add(transfer.txid);
        transfers.push(transfer);
      }
      addSpends(spendMap, pool.spends);
    } catch (error) {
      poolFailure = { ...failureOf(error, node), why: "pool-read" };
    }
    spends = [...spendMap.values()];
    const confirmedSpends = spends.filter((spend) => spend.pool !== true);
    const confirmedTransfers = transfers.filter((transfer) => transfer.pool !== true);
    if (poolFailure) {
      return { transfers, tip: info.height, fromHeight, minConfirmations, complete: false, through,
        spends,
        checkpoint: through ? checkpointRecord({ ...identity, through, transfers: confirmedTransfers, spends: confirmedSpends }) : null,
        blocked: false, failed: [poolFailure] };
    }
    return { transfers, tip: info.height, fromHeight, minConfirmations, complete: true, through,
      spends, availableAtomic: availableAtomicOf(transfers, tracked, spends, minConfirmations),
      availableSource: { url: node.url, operator: node.operator },
      checkpoint: through ? checkpointRecord({ ...identity, through, transfers: confirmedTransfers, spends: confirmedSpends }) : null,
      blocked: false, failed: [] };
  };
  for (;;) {
    try {
      return await run(prior);
    } catch (error) {
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
      return { transfers: [], tip: info.height, fromHeight, minConfirmations, complete: false, through: null,
        checkpoint: null, blocked: false, failed: [failure] };
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
    return { transfers: [], tip: null, fromHeight, through: null, complete: false, checkpoint: null, blocked: false, failed: [failureOf(error, node)] };
  }
  const network = isStr(request.network) ? request.network : info.nettype;
  if (!isStr(network)) throw new SdkError("bad-input", { field: "network" });
  if (addressNetwork && info.nettype && addressNetwork !== info.nettype) {
    throw new SdkError("bad-input", { field: "node", why: "node-network-mismatch" });
  }
  if (!info.synced) {
    return { transfers: [], tip: info.height, fromHeight, through: null, complete: false, checkpoint: null, blocked: true,
      failed: [{ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" }] };
  }
  const top = Math.max(0, info.height - 1);
  if (tipHeightRaw !== null && tipHeightRaw > top) {
    return { transfers: [], tip: info.height, fromHeight, through: null, complete: false, checkpoint: null, blocked: false,
      failed: [{ url: node.url, operator: node.operator, code: "stale", why: "witness-behind", height: top, wanted: tipHeightRaw }] };
  }
  const targetTop = tipHeightRaw === null ? top : Math.min(tipHeightRaw, top);
  if (targetTop < fromHeight) {
    return { transfers: [], tip: info.height, fromHeight, through: null, complete: true, checkpoint: null, blocked: false, failed: [] };
  }
  const identity = { network, address: request.address, fromHeight };
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
    return { transfers: prior ? prior.transfers : [], tip: info.height, fromHeight, through: prior ? prior.through : null,
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
    for (let window = fromWindow; window <= lastWindow; window += 1) {
      const start = witnessSliceStart(window);
      const end = Math.min(witnessSliceEnd(window), targetTop);
      for (let height = start; height <= end; height += 1) {
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
          const failure = failureOf(error, node);
          failure.height = height;
          const keptThrough = through || (startRecord ? startRecord.through : null);
          const keptTransfers = through ? transfers : (startRecord ? startRecord.transfers : transfers);
          const keptSpends = through ? [...spendMap.values()] : (startRecord ? startRecord.spends : []);
          return { transfers: keptTransfers, tip: info.height, fromHeight, complete: false, through: keptThrough,
            spends: keptSpends,
            checkpoint: keptThrough ? checkpointRecord({ ...identity, through: keptThrough, transfers: keptTransfers, spends: keptSpends, kind: "witness" }) : null,
            blocked: false, failed: [failure] };
        }
        if (priorThrough && height === priorThrough.height && normalizedHash(block.hash) !== priorThrough.hash) throw new Error("reorg");
        for (const tx of txs) {
          addSpends(spendMap, spendsOfTx(tx, tracked, node, { height, blockHash: block.hash }));
          const hit = engine.xmrScan.matchTransaction(tx, [watched], { height, tipHeight: targetTop, nowSec: request.nowSec });
          if (!hit.length || height < fromHeight) continue;
          const confirmations = confirmationsOf(tx, height, targetTop);
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
    return { transfers, tip: info.height, fromHeight, complete: true, through, spends,
      availableAtomic: availableAtomicOf(transfers, tracked, spends, minConfirmations),
      checkpoint: through ? checkpointRecord({ ...identity, through, transfers, spends, kind: "witness" }) : null,
      blocked: false, failed: [] };
  };
  for (;;) {
    try {
      return await run(prior);
    } catch (error) {
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
      return { transfers: [], tip: info.height, fromHeight, complete: false, through: null, checkpoint: null, blocked: false, failed: [failure] };
    }
  }
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
  if (!isStr(request.address)) throw new SdkError("bad-input", { field: "address" });
  if (request.viewSecret === undefined || request.viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
  if (!isStr(request.spendPub)) throw new SdkError("bad-input", { field: "spendPub" });
  const fromHeight = intOf(request.fromHeight);
  if (fromHeight === null || fromHeight < 0) throw new SdkError("bad-input", { field: "fromHeight" });
  const minConfirmations = Math.max(1, intOf(request.minConfirmations) ?? 1);
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const nowSec = Number.isFinite(Number(request.nowSec)) ? Number(request.nowSec) : Math.floor(Date.now() / 1000);
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 20000;
  const bound = engine.xmrScan.watchedAddressVerdict({
    address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub,
  });
  if (!bound.ok) {
    if (bound.code === "bad-input") throw new SdkError("bad-input", { field: bound.field || "address", why: bound.why });
    throw new SdkError(bound.code, { field: bound.field || "address", address: request.address });
  }
  const watched = { address: request.address, viewSecret: bound.viewSecret, spendPub: bound.spendPub };

  const tracked = normalizeKeyImages(request.keyImages);
  const live = [];
  const failed = [];
  for (const node of nodes) {
    try { live.push({ node, info: await getInfo(node, fetchImpl, timeoutMs) }); }
    catch (error) { failed.push(failureOf(error, node)); }
  }
  if (!live.length) throw new SdkError("xmr-no-nodes", { tried: nodes.map((n) => n.url), nodes: failed });
  const tip = Math.max(...live.map((entry) => entry.info.height));
  const top = Math.max(0, tip - 1);
  const observations = new Map();
  const spendMap = new Map();
  const checked = [];
  let complete = true;
  let availableAtomic = null;
  let primarySpends = [];

  for (let index = 0; index < live.length; index += 1) {
    const { node, info } = live[index];
    checked.push({ url: node.url, operator: node.operator, height: info.height, synchronized: info.synced });
    if (!info.synced) {
      failed.push({ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" });
      complete = false;
      continue;
    }
    const nodeTop = Math.max(0, Math.min(top, info.height - 1));
    let read;
    try {
      const common = {
        address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub,
        fromHeight, minConfirmations, network: request.network, keyImages: request.keyImages,
        nowSec, timeoutMs, idleTimeoutMs: request.idleTimeoutMs ?? request.timeoutMs, fetch: fetchImpl,
      };
      read = index === 0
        ? await readRecovery({ ...common, node })
        : await readRecoveryWitness({ ...common, node, tipHeight: nodeTop });
    } catch (error) {
      failed.push(failureOf(error, node));
      complete = false;
      continue;
    }
    if (index > 0) {
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
      }
    }
    for (const transfer of read.transfers) {
      if (!observations.has(transfer.txid)) observations.set(transfer.txid, []);
      observations.get(transfer.txid).push(transfer);
    }
    if (index === 0) primarySpends = read.spends || [];
    addSpends(spendMap, read.spends || []);
    if (availableAtomic === null && read.availableAtomic !== null && read.availableAtomic !== undefined) {
      availableAtomic = read.availableAtomic;
    }
    failed.push(...(read.failed || []));
    if (read.complete !== true) complete = false;
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
  const availableForVerdict = spendsDisagreements.length ? null : availableAtomic;
  const ready = transfers.some((transfer) => transfer.agreed && transfer.confirmed && !transfer.locked);
  const agreed = transfers.some((transfer) => transfer.agreed);
  return {
    state: ready ? "ready" : (agreed ? "pending" : (transfers.length ? "one-node" : "none")),
    transfers,
    tip,
    fromHeight,
    minConfirmations,
    complete: spendsDisagreements.length ? false : complete,
    spends,
    spendsDisagreements,
    availableAtomic: availableForVerdict,
    availableSource: live.length ? { url: live[0].node.url, operator: live[0].node.operator } : null,
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
