// THE XMR ARRIVAL CHECK - IN THE SDK CORE, ON TWO INDEPENDENT NODES.
//
// WHY HERE AND NOT IN OUR SERVICE. `ready` is the point of no return: after it the maker may take the ETH. Today
// the decision "the XMR arrived" is made by our backend (it holds the view key, scans our node, and the interface
// only shows that answer). The user cannot check it: if the answer is wrong - an indexer bug, a failure, a
// compromised server, a swapped node - the user marks ready under XMR that are not there and loses the ETH. So the
// decision moves into the client, which reads the chain itself with its own view key.
//
// TWO NODES OF DIFFERENT OPERATORS. A single node is a single truth that can lie. So `ready` opens only when at
// least two nodes belonging to DIFFERENT operators see the transaction IN THE SAME BLOCK (the block hash matches)
// with the required number of confirmations. A failed or lagging node does not count and blocks nothing; a synced
// node that does not have the transaction in that block, or has a different block hash there, is a DISAGREEMENT -
// the button stays closed and the screen says the nodes do not agree. When only one operator has confirmed, the
// core names that state (`one-node`) instead of waiting silently.
//
// WHERE THE RULE LIVES. "Locked by unlock_time is not an arrival" is ONE rule (issue #84). It is not copied here:
// it lives under www/js/monero/unlock.js, is mirrored byte-for-byte into the engine (sdk/engine/monero/unlock.js,
// guarded by tools/check-sdk-engine.mjs) and is read through the engine seam. The block parser is mirrored the
// same way (www/js/monero/scan.js) - a second copy would be a second truth about money.
//
// PRIVACY. Public nodes are asked for the WHOLE BLOCK (get_block plus /get_transactions over all of the block's
// hashes), never for a single transaction: otherwise a node links the user's IP to the trade. Requests carry
// `Content-Type: text/plain` (verified on every node in the default list - it avoids the CORS preflight).
//
// WHAT THE MAKER GIVES IS ONLY A HINT. The maker's node may name the payout txid; the backend may relay it. It
// decides nothing - a fabricated txid simply fails the check. Without a txid the client scans blocks from the
// swap's birth height (a few dozen blocks).
import { SdkError } from "./errors.mjs";
import * as engine from "./engine.mjs";

const isStr = (v) => typeof v === "string" && v.length > 0;
const intOf = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const txidOf = (v) => (isStr(v) ? v.trim().replace(/^0x/, "").toLowerCase() : null);
const hostOf = (url) => { try { return new URL(url).host; } catch { throw new SdkError("bad-input", { field: "nodes.url", unknown: url }); } };

// A NODE LIST IS A LIST OF {url, operator}. The operator is what makes two nodes two witnesses: two nodes of one
// operator are one opinion. A plain string is accepted and its operator is the host - a user who adds their own
// node is the operator of it.
export function normalizeNodes(nodes) {
  if (!Array.isArray(nodes)) throw new SdkError("bad-input", { field: "nodes" });
  const out = [];
  for (const raw of nodes) {
    if (isStr(raw)) {
      const url = raw.replace(/\/+$/, "");
      out.push({ url, operator: hostOf(url) });
    } else if (raw && typeof raw === "object" && isStr(raw.url)) {
      const url = raw.url.replace(/\/+$/, "");
      out.push({ url, operator: isStr(raw.operator) ? raw.operator : hostOf(url) });
    } else {
      throw new SdkError("bad-input", { field: "nodes", why: "each-node-is-url-or-url+operator" });
    }
  }
  if (!out.length) throw new SdkError("bad-input", { field: "nodes", why: "empty-list" });
  return out;
}

// ONE REQUEST. `text/plain` on purpose: the public nodes answer it without a preflight (verified on the whole
// default list). The response body is JSON even though the content type is not.
async function call(node, path, body, fetchImpl, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(node.url + path, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    throw new SdkError("xmr-no-nodes", { node: node.url, why: String((error && error.message) || error).slice(0, 120) });
  }
  if (!res || res.ok !== true) throw new SdkError("xmr-no-nodes", { node: node.url, status: res ? res.status : null });
  try { return await res.json(); } catch { throw new SdkError("xmr-no-nodes", { node: node.url, why: "bad-json" }); }
}

async function getInfo(node, fetchImpl, timeoutMs) {
  const j = await call(node, "/json_rpc", { jsonrpc: "2.0", id: "info", method: "get_info" }, fetchImpl, timeoutMs);
  const r = j && j.result;
  if (!r || !Number.isFinite(Number(r.height))) throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-height" });
  return { height: Number(r.height), synced: r.synchronized !== false, nettype: r.nettype || null };
}

// THE WHOLE BLOCK: its hash and ALL of its transaction hashes. This is the only form a public node is asked in.
async function getBlock(node, height, fetchImpl, timeoutMs) {
  const j = await call(node, "/json_rpc", { jsonrpc: "2.0", id: "block", method: "get_block", params: { height } }, fetchImpl, timeoutMs);
  const r = j && j.result;
  if (!r) throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-block" });
  const hash = (r.block_header && r.block_header.hash) || null;
  let txHashes = Array.isArray(r.tx_hashes) ? r.tx_hashes : null;
  if (!txHashes) {
    const json = typeof r.json === "string" ? JSON.parse(r.json) : r.json;
    txHashes = (json && json.tx_hashes) || [];
  }
  return { hash, txHashes };
}

// ALL THE BLOCK'S TRANSACTIONS in one request (never a single-hash request to a public node).
async function getBlockTxs(node, hashes, fetchImpl, timeoutMs) {
  if (!hashes.length) return [];
  const j = await call(node, "/get_transactions", { txs_hashes: hashes, decode_as_json: true }, fetchImpl, timeoutMs);
  const wrappers = j.txs || [];
  return (j.txs_as_json || []).map((s, i) => {
    const body = typeof s === "string" ? JSON.parse(s) : s;
    const w = wrappers[i] || {};
    body.tx_hash = String(w.tx_hash || body.tx_hash || "").replace(/^0x/, "").toLowerCase();
    body.block_height = w.block_height ?? null;
    body.confirmations = w.confirmations ?? null;
    return body;
  });
}

// The amount of our own outputs in a matched transaction (a swap can be paid in several outputs).
const sumOutputs = (hit) => hit.outputs.reduce((n, o) => n + (o.amountAtomic || 0n), 0n);

/**
 * FIND THE TRANSACTION, IF IT IS THERE. Blocks are walked from the swap's birth height upwards and the whole block
 * is asked for each height, so a public node never learns which transaction is ours. A txid hint only shortens the
 * work: a block without that hash is still fetched whole, but its transactions are not parsed.
 */
async function locate(node, { txid, address, viewSecret, spendPub, fromHeight, toHeight, nowSec, fetchImpl, timeoutMs }) {
  const from = Math.max(0, intOf(fromHeight) ?? 0);
  const to = intOf(toHeight);
  if (!Number.isFinite(to) || to < from) throw new SdkError("bad-input", { field: "fromHeight", got: fromHeight });
  for (let h = from; h <= to; h++) {
    const { txHashes } = await getBlock(node, h, fetchImpl, timeoutMs);
    if (!txHashes.length) continue;
    if (txid && !txHashes.includes(txid)) continue;        // the hint says it is not in this block
    const txs = await getBlockTxs(node, txHashes, fetchImpl, timeoutMs);
    for (const tx of txs) {
      if (txid && tx.tx_hash !== txid) continue;
      const hit = engine.xmrScan.matchTransaction(tx, [{ address, viewSecret, spendPub }], { height: h, nowSec });
      if (hit.length && sumOutputs(hit[0]) > 0n) return { txid: tx.tx_hash, height: h };
    }
  }
  return null;
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
  const watched = { address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub };

  // 1. THE TIP, and with it the first proof that ANY node answers. All nodes down is a named refusal, not silence.
  const live = [];
  for (const node of nodes) {
    try { const info = await getInfo(node, fetchImpl, timeoutMs); live.push({ node, info }); }
    catch { /* a failed node does not count and blocks nothing */ }
  }
  if (!live.length) throw new SdkError("xmr-no-nodes", { tried: nodes.map((n) => n.url) });
  const tip = Math.max(...live.map((l) => l.info.height));
  // THE REPORTED HEIGHT IS THE NEXT BLOCK, NOT A REACHABLE ONE. monerod's get_info returns height = "the block that
  // will be mined next", so get_block(height) refuses with "greater than current top block". The backend already
  // knows this (app/watcher.mjs: "берем top = height - 1"), and a live run against the contour's own node found the
  // same off-by-one here: walking to `tip` inclusive threw xmr-no-nodes on the very last block instead of returning
  // `pending`. The reachable top is one below.
  const top = Math.max(0, tip - 1);

  // 2. LOCATE: from the birth height, by whole blocks. The first reachable node does the walk.
  let located = null;
  let walkError = null;
  for (const { node } of live) {
    try { located = await locate(node, { txid: txidHint, address: request.address, viewSecret: request.viewSecret, spendPub: request.spendPub, fromHeight: request.fromHeight, toHeight: top, nowSec, fetchImpl, timeoutMs }); }
    catch (error) { walkError = error; located = null; }
    if (located) break;
  }
  if (!located) {
    if (walkError && walkError.code === "xmr-no-nodes") throw walkError;
    return { seen: false, state: "pending", txid: txidHint, tip, checked: live.map((l) => ({ url: l.node.url, operator: l.node.operator, height: l.info.height })) };
  }

  // 3. VERIFY ON EVERY NODE: the SAME block hash, the SAME transaction inside it, the confirmations and the money.
  const seen = [];
  for (const node of nodes) {
    const record = { url: node.url, operator: node.operator };
    let info;
    try { info = await getInfo(node, fetchImpl, timeoutMs); }
    catch { record.state = "down"; seen.push(record); continue; }
    // A LAGGING NODE IS NOT A WITNESS and is not a disagreement: it simply cannot see the block yet.
    if (!info.synced || info.height < located.height) { record.state = "stale"; record.height = info.height; seen.push(record); continue; }
    let block;
    try { block = await getBlock(node, located.height, fetchImpl, timeoutMs); }
    catch { record.state = "down"; seen.push(record); continue; }
    record.blockHash = block.hash;
    // A SYNCED NODE WITHOUT THIS TRANSACTION IN THAT BLOCK IS A DISAGREEMENT (it may hold a different block hash).
    if (!block.hash || !block.txHashes.includes(located.txid)) { record.state = "no-tx"; seen.push(record); continue; }
    let body = null;
    try { body = (await getBlockTxs(node, block.txHashes, fetchImpl, timeoutMs)).find((t) => t.tx_hash === located.txid) || null; }
    catch { record.state = "down"; seen.push(record); continue; }
    if (!body) { record.state = "no-tx"; seen.push(record); continue; }
    const hit = engine.xmrScan.matchTransaction(body, [watched], { height: located.height, nowSec });
    if (!hit.length) { record.state = "no-output"; seen.push(record); continue; }
    record.state = "ok";
    record.amountAtomic = sumOutputs(hit[0]);
    record.unlock = hit[0].unlock;
    // Confirmations of a block: top - height + 1, and top = info.height - 1 (see above), so this is height - located.
    record.confirmations = Number.isFinite(Number(body.confirmations)) ? Number(body.confirmations) : (info.height - located.height);
    seen.push(record);
  }

  // A DISAGREEMENT CLOSES THE BUTTON - it is named, and the nodes and hashes travel in the params.
  const disagreeing = seen.filter((r) => r.state === "no-tx" || r.state === "no-output");
  if (disagreeing.length) {
    throw new SdkError("xmr-nodes-disagree", {
      txid: located.txid, height: located.height,
      nodes: disagreeing.map((r) => ({ url: r.url, operator: r.operator, blockHash: r.blockHash || null, why: r.state })),
      agreed: seen.filter((r) => r.state === "ok").map((r) => ({ url: r.url, operator: r.operator, blockHash: r.blockHash })),
    });
  }

  const okay = seen.filter((r) => r.state === "ok");
  if (!okay.length) return { seen: false, state: "pending", txid: located.txid, height: located.height, checked: seen };

  // LOCKED IS NOT AN ARRIVAL, and the rule for that is the shared one (issue #84), mirrored from www/js.
  const locked = okay.find((r) => r.unlock && r.unlock.locked);
  if (locked) {
    const until = locked.unlock;
    throw new SdkError("xmr-locked", { txid: located.txid, height: located.height, address: request.address,
      untilHeight: until.untilHeight ?? null, untilTime: until.untilTime ?? null });
  }

  // THE AMOUNT IS NOT LESS THAN EXPECTED. A shortfall is named rather than shown as a completed swap.
  const amountAtomic = okay.reduce((best, r) => (r.amountAtomic > best ? r.amountAtomic : best), 0n);
  if (amountAtomic < expectedAtomic) {
    throw new SdkError("xmr-underpaid", { txid: located.txid, height: located.height, got: amountAtomic.toString(), want: expectedAtomic.toString() });
  }

  // AGREEMENT: the same block hash, held by at least two DIFFERENT operators, with the required confirmations.
  const byHash = new Map();
  for (const r of okay) {
    const key = r.blockHash;
    if (!byHash.has(key)) byHash.set(key, { blockHash: key, operators: new Set(), nodes: [] });
    const g = byHash.get(key);
    g.operators.add(r.operator);
    g.nodes.push(r);
  }
  let best = null;
  for (const g of byHash.values()) if (!best || g.operators.size > best.operators.size) best = g;
  const confirmations = Math.min(...best.nodes.map((r) => r.confirmations));
  const agreedBy = best.nodes.map((r) => ({ url: r.url, operator: r.operator, blockHash: r.blockHash, confirmations: r.confirmations }));

  if (best.operators.size < 2) {
    return { seen: false, state: "one-node", txid: located.txid, height: located.height, blockHash: best.blockHash,
      amountAtomic: amountAtomic.toString(), confirmations, operators: [...best.operators], agreedBy, checked: seen };
  }
  if (confirmations < minConfirmations) {
    return { seen: false, state: "pending", why: "confirmations", txid: located.txid, height: located.height, blockHash: best.blockHash,
      amountAtomic: amountAtomic.toString(), confirmations, needConfirmations: minConfirmations, agreedBy, checked: seen };
  }
  return { seen: true, state: "arrived", txid: located.txid, height: located.height, blockHash: best.blockHash,
    amountAtomic: amountAtomic.toString(), confirmations, needConfirmations: minConfirmations,
    operators: [...best.operators], agreedBy, checked: seen };
}

/**
 * IS THERE STILL TIME FOR THE CONFIRMATIONS? Ten confirmations of Monero are about twenty minutes, and the ready
 * deadline does not move. If less than that is left, the client must NAME it and not start - waiting silently would
 * start a trade that cannot be finished in time. Returns seconds left; refuses with `xmr-too-late` otherwise.
 */
export function assertTimeForConfirmations({ readyBySec, nowSec, minConfirmations, blockTimeSec } = {}) {
  const readyBy = Number(readyBySec);
  const now = Number.isFinite(Number(nowSec)) ? Number(nowSec) : Math.floor(Date.now() / 1000);
  const count = Math.max(1, intOf(minConfirmations) ?? 1);
  const block = Number.isFinite(Number(blockTimeSec)) && Number(blockTimeSec) > 0 ? Number(blockTimeSec) : 120;
  if (!Number.isFinite(readyBy) || readyBy <= 0) return null;   // no deadline known - nothing to compare against
  const needSec = count * block;
  const leftSec = Math.floor(readyBy - now);
  if (leftSec < needSec) throw new SdkError("xmr-too-late", { needSec, leftSec, minConfirmations: count, readyBy: Math.floor(readyBy) });
  return leftSec;
}
