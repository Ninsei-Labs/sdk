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
// WHERE THE RULE LIVES. "Locked by unlock_time is not an arrival" is ONE rule (issue #84). It is not copied here:
// it lives under www/js/monero/unlock.js, is mirrored byte-for-byte into the engine (sdk/engine/monero/unlock.js,
// guarded by tools/check-sdk-engine.mjs) and is read through the engine seam. The block parser is mirrored the
// same way (www/js/monero/scan.js) - a second copy would be a second truth about money.
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
    // KEEP THE NAME: `AbortSignal.timeout` is "TimeoutError" in a browser and "AbortError" in Node; the message
    // alone is not portable, and the arrival report has to say timeout rather than network.
    throw new SdkError("xmr-no-nodes", { node: node.url, name: String((error && error.name) || ""),
      why: String((error && error.message) || error).slice(0, 120) });
  }
  if (!res || res.ok !== true) throw new SdkError("xmr-no-nodes", { node: node.url, status: res ? res.status : null });
  try { return await res.json(); } catch (error) {
    // A BODY CUT BY THE TIMEOUT IS STILL A TIMEOUT. `res.json()` rejects after the signal fired; in Node and in
    // browsers that is a TimeoutError/AbortError, not a malformed answer.
    const name = String((error && error.name) || "");
    const timedOut = /^(TimeoutError|AbortError)$/.test(name) || /timeout|abort/i.test(name);
    throw new SdkError("xmr-no-nodes", { node: node.url, name, why: timedOut ? "timeout" : "bad-json" });
  }
}

async function getInfo(node, fetchImpl, timeoutMs) {
  const j = await call(node, "/json_rpc", { jsonrpc: "2.0", id: "info", method: "get_info" }, fetchImpl, timeoutMs);
  const r = j && j.result;
  if (!r || !Number.isFinite(Number(r.height))) throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-height" });
  // A BUSY NODE HAS NOT FINISHED ITS OWN VIEW. Its height is not evidence that the walk was complete.
  if (r.busy === true || r.busy_syncing === true || (typeof r.status === "string" && r.status && r.status !== "OK")) {
    throw new SdkError("xmr-no-nodes", { node: node.url, why: "busy" });
  }
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
  const wrappers = Array.isArray(j.txs) ? j.txs : [];
  const bodies = Array.isArray(j.txs_as_json) ? j.txs_as_json : [];
  // A PARTIAL ANSWER IS NOT AN EMPTY BLOCK. If the node returns fewer transactions than the block named, the walk
  // cannot conclude "no payment": that answer is unknown and must stop the refund path.
  if (bodies.length !== hashes.length || (wrappers.length && wrappers.length !== hashes.length)) {
    throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-transactions", want: hashes.length, got: bodies.length });
  }
  const out = bodies.map((s, i) => {
    let body;
    try { body = typeof s === "string" ? JSON.parse(s) : s; }
    catch { throw new SdkError("xmr-no-nodes", { node: node.url, why: "bad-json" }); }
    const w = wrappers[i] || {};
    body.tx_hash = String(w.tx_hash || body.tx_hash || "").replace(/^0x/, "").toLowerCase();
    body.block_height = w.block_height ?? null;
    body.confirmations = w.confirmations ?? null;
    return body;
  }).filter((body) => hashes.includes(String(body.tx_hash || "").toLowerCase()));
  if (out.length !== hashes.length) {
    throw new SdkError("xmr-no-nodes", { node: node.url, why: "partial-transactions", want: hashes.length, got: out.length });
  }
  return out;
}

// The amount of our own outputs in a matched transaction (a swap can be paid in several outputs). An output whose
// amount did not match its Pedersen commitment is NOT money: it contributes zero, and the caller names it.
const sumOutputs = (hit) => hit.outputs.reduce((n, o) => n + (o.amountVerified ? (o.amountAtomic || 0n) : 0n), 0n);

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
      const candidate = { txid: tx.tx_hash, height: h };
      if (score === 7) return candidate;
      if (!best || score > best.score || (score === best.score && amountAtomic > best.amountAtomic)) {
        best = { ...candidate, score, amountAtomic };
      }
    }
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
  // THE KEY MUST BELONG TO THE ADDRESS, NOT MERELY BE PASSED BESIDE IT. The scanner used to try both byte orders
  // of the view secret and accept the first match; a maker could pay to the address built from the other reading and
  // still get `arrived` while the person's wallet saw nothing. Decode the address, keep the matching view form, and
  // require its spend key to be the same key.
  let addressKeys;
  try { addressKeys = engine.xmrArrivalRead.decodeAddressKeys(request.address); }
  catch { throw new SdkError("bad-input", { field: "address", why: "not-a-monero-address" }); }
  // THE WATCHED ADDRESS IS A PRIMARY ADDRESS. A subaddress has a different payload layout and its view/spend points
  // are not the ones the joint-address builder produces; refusing it by name is clearer than a spurious spend-pub
  // mismatch. SDK-generated addresses are always primary.
  if (!addressKeys.network) throw new SdkError("bad-input", { field: "address", why: "subaddress-not-supported" });
  const spendPub = String(request.spendPub).replace(/^0x/, "").toLowerCase();
  if (!addressKeys.spendPub || spendPub !== String(addressKeys.spendPub).toLowerCase()) {
    throw new SdkError("xmr-address-mismatch", { field: "spendPub", address: request.address });
  }
  const viewForm = engine.xmrScan.viewKeyFormForAddress(request.viewSecret, addressKeys.viewPub);
  if (!viewForm) {
    throw new SdkError("xmr-address-mismatch", { field: "viewSecret", address: request.address });
  }
  const viewSecret = engine.xmrScan.viewSecretCandidates(request.viewSecret).find(([form]) => form === viewForm)?.[1] ?? request.viewSecret;
  const watched = { address: request.address, viewSecret, spendPub: addressKeys.spendPub };

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
  for (const { node, info } of live) {
    // A WITNESS THAT IS NOT SYNCHRONIZED HAS NOT SEEN THE RANGE. Counting its empty walk as absence would let two
    // nodes that restarted behind the payout height refund a paid swap; the same rule already guards the positive
    // branch below.
    if (!info.synced) {
      failed.push({ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" });
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
    // ABSENCE IS A CLAIM ABOUT MONEY, SO IT NEEDS TWO OPERATORS. One node can withhold a transaction and make
    // this walk look empty; a refund signed on that answer would take the depositor's ETH from a maker who paid.
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
    return { seen: false, state: "pending", absent: completedOperators.size >= 2, txid: txidHint, tip, completedOperators: [...completedOperators], checked: live.map((l) => ({ url: l.node.url, operator: l.node.operator, height: l.info.height })), failed };
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
    }));
    record.unlock = hit[0].unlock;
    // Confirmations of a block: top - height + 1, and top = info.height - 1 (see above), so this is height - located.
    record.confirmations = Number.isFinite(Number(body.confirmations)) ? Number(body.confirmations) : (info.height - located.height);
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

  // LOCKED IS NOT AN ARRIVAL, and the rule for that is the shared one (issue #84), mirrored from www/js.
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
      amountAtomic: amountAtomic.toString(), confirmations, operators: [...best.operators], agreedBy, checked: seen, failed };
  }
  if (confirmations < minConfirmations) {
    return { seen: false, state: "pending", why: "confirmations", txid: located.txid, height: located.height, blockHash: best.observation.blockHash,
      amountAtomic: amountAtomic.toString(), confirmations, needConfirmations: minConfirmations, agreedBy, checked: seen, failed };
  }
  return { seen: true, state: "arrived", txid: located.txid, height: located.height, blockHash: best.observation.blockHash,
    amountAtomic: amountAtomic.toString(), confirmations, needConfirmations: minConfirmations,
    operators: [...best.operators], agreedBy, checked: seen, failed };
}

// ---------------------------------------------------------------------------
// WITNESS-V1: FIXED BLOCK SLICES FOR THE SHADOW CHECK
// ---------------------------------------------------------------------------
//
// This is the client side of the read-only slice endpoint. It is deliberately a SEPARATE call from
// `verifyArrival`: the production decision still uses the exact walk until an independent operator serves
// witness-v1. `verifyArrivalShadow` runs both and compares them without changing ready, refund or any swap state.

export const WITNESS_SLICE_BLOCKS = 20;

export function witnessSliceIndex(height) {
  const value = Number(height);
  if (!Number.isSafeInteger(value) || value < 0) throw new SdkError("bad-input", { field: "height" });
  return Math.floor(value / WITNESS_SLICE_BLOCKS);
}

export function witnessSliceStart(index) {
  const value = Number(index);
  if (!Number.isSafeInteger(value) || value < 0) throw new SdkError("bad-input", { field: "slice" });
  return value * WITNESS_SLICE_BLOCKS;
}

export function witnessSliceEnd(index) {
  return witnessSliceStart(index) + WITNESS_SLICE_BLOCKS - 1;
}

const witnessHash = (value) => {
  const text = String(value || "").replace(/^0x/, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
};

function assertWitnessSliceBody(body, { network, index }) {
  if (!body || typeof body !== "object") throw new SdkError("xmr-no-nodes", { why: "bad-witness-slice" });
  if (Number(body.version) !== 1) throw new SdkError("xmr-no-nodes", { why: "bad-witness-version" });
  if (String(body.network) !== String(network)) throw new SdkError("xmr-no-nodes", { why: "witness-network" });
  if (Number(body.grid) !== WITNESS_SLICE_BLOCKS) throw new SdkError("xmr-no-nodes", { why: "witness-grid" });
  if (Number(body.slice) !== index) throw new SdkError("xmr-no-nodes", { why: "witness-slice" });
  if (Number(body.from) !== witnessSliceStart(index) || Number(body.to) !== witnessSliceEnd(index)) {
    throw new SdkError("xmr-no-nodes", { why: "witness-bounds" });
  }
  if (!Array.isArray(body.blocks) || body.blocks.length !== WITNESS_SLICE_BLOCKS) {
    throw new SdkError("xmr-no-nodes", { why: "witness-block-count" });
  }
  const blocks = body.blocks.map((block, i) => {
    if (!block || Number(block.height) !== witnessSliceStart(index) + i) {
      throw new SdkError("xmr-no-nodes", { why: "witness-height" });
    }
    const hash = witnessHash(block.hash);
    if (!hash) throw new SdkError("xmr-no-nodes", { why: "witness-hash" });
    if (!Array.isArray(block.txids)) throw new SdkError("xmr-no-nodes", { why: "witness-txids" });
    const txids = block.txids.map((txid) => {
      const value = witnessHash(txid);
      if (!value) throw new SdkError("xmr-no-nodes", { why: "witness-txid" });
      return value;
    });
    return { height: Number(block.height), hash, txids };
  });
  return { version: 1, network: String(network), grid: WITNESS_SLICE_BLOCKS, slice: index,
    from: body.from, to: body.to, blocks };
}

async function readWitnessSlice(node, index, { network, fetchImpl, timeoutMs }) {
  if (node.protocol !== "witness-v1") throw new SdkError("xmr-no-nodes", { node: node.url, why: "no-slice-witness" });
  const body = await call(node, "/v1/witness/slice",
    { version: 1, network, grid: WITNESS_SLICE_BLOCKS, slice: index }, fetchImpl, timeoutMs);
  return assertWitnessSliceBody(body, { network, index });
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

// FIND A PAYMENT THROUGH SLICES. The exact `fromHeight` is local: the witness sees only slice indexes.
async function locateInSlices(node, { expectedAtomic, address, viewSecret, spendPub, fromHeight, toHeight, nowSec, network, fetchImpl, timeoutMs }) {
  const first = witnessSliceIndex(fromHeight);
  const last = witnessSliceIndex(toHeight);
  let best = null;
  let completed = true;
  for (let index = first; index <= last; index++) {
    const slice = await readWitnessSlice(node, index, { network, fetchImpl, timeoutMs });
    const txs = await readSliceTransactions(node, slice, { fetchImpl, timeoutMs });
    for (const block of slice.blocks) {
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
        const candidate = { txid, height: block.height, blockHash: block.hash, amountAtomic, score };
        if (!best || score > best.score || (score === best.score && amountAtomic > best.amountAtomic)) best = candidate;
      }
    }
    // THE WHOLE SLICE WAS READ. A perfect candidate lets the walk stop after this slice, not after a block:
    // the last witness request is still a fixed slice, never the payout height. `completed` means the full
    // requested slice range was walked, so it stays false on an early stop.
    if (best && best.score === 7) {
      completed = index === last;
      break;
    }
  }
  return { located: best, completed };
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
  let addressKeys;
  try { addressKeys = engine.xmrArrivalRead.decodeAddressKeys(request.address); }
  catch { throw new SdkError("bad-input", { field: "address", why: "not-a-monero-address" }); }
  if (!addressKeys.network) throw new SdkError("bad-input", { field: "address", why: "subaddress-not-supported" });
  const network = request.network || addressKeys.network;
  const fetchImpl = typeof request.fetch === "function" ? request.fetch : globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SdkError("bad-input", { field: "fetch" });
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) && Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 20000;
  const nowSec = Number.isFinite(Number(request.nowSec)) ? Number(request.nowSec) : Math.floor(Date.now() / 1000);
  const fromHeight = Number(request.fromHeight);
  if (!Number.isSafeInteger(fromHeight) || fromHeight <= 0) throw new SdkError("bad-input", { field: "fromHeight" });
  let expectedAtomic;
  try { expectedAtomic = BigInt(request.expectedAtomic); } catch { throw new SdkError("bad-input", { field: "expectedAtomic" }); }
  if (expectedAtomic <= 0n) throw new SdkError("bad-input", { field: "expectedAtomic" });
  if (!isStr(request.spendPub)) throw new SdkError("bad-input", { field: "spendPub" });
  if (request.viewSecret === undefined || request.viewSecret === null) throw new SdkError("bad-input", { field: "viewSecret" });
  const spendPub = String(request.spendPub).replace(/^0x/, "").toLowerCase();
  if (spendPub !== String(addressKeys.spendPub).toLowerCase()) {
    throw new SdkError("xmr-address-mismatch", { field: "spendPub", address: request.address });
  }
  const viewForm = engine.xmrScan.viewKeyFormForAddress(request.viewSecret, addressKeys.viewPub);
  if (!viewForm) throw new SdkError("xmr-address-mismatch", { field: "viewSecret", address: request.address });
  const viewSecret = engine.xmrScan.viewSecretCandidates(request.viewSecret).find(([form]) => form === viewForm)?.[1] ?? request.viewSecret;

  let exact = null;
  let exactError = null;
  try { exact = await verifyArrival(request); }
  catch (error) { exactError = { code: error && error.code ? error.code : "unknown", params: (error && error.params) || {} }; }

  const checked = [];
  const failed = [];
  let located = null;
  let completed = false;
  for (const node of witnessNodes) {
    if (node.protocol !== "witness-v1") { failed.push({ url: node.url, operator: node.operator, code: "no-slice-witness" }); continue; }
    let info;
    try { info = await getInfo(node, fetchImpl, timeoutMs); }
    catch (error) { failed.push(failureOf(error, node)); checked.push({ url: node.url, operator: node.operator, state: "down" }); continue; }
    if (!info.synced) {
      failed.push({ url: node.url, operator: node.operator, code: "stale", why: "not-synchronized" });
      checked.push({ url: node.url, operator: node.operator, state: "stale", height: info.height });
      continue;
    }
    const top = Math.max(0, info.height - 1);
    checked.push({ url: node.url, operator: node.operator, state: "ok", height: info.height });
    try {
      const found = await locateInSlices(node, {
        expectedAtomic, address: request.address, viewSecret, spendPub, fromHeight, toHeight: top,
        nowSec, network, fetchImpl, timeoutMs,
      });
      completed = completed || found.completed;
      if (found.located && (!located || found.located.score > located.score)) {
        located = found.located;
        located.operator = node.operator;
        located.url = node.url;
      }
    } catch (error) {
      failed.push(failureOf(error, node));
    }
  }

  const witness = located
    ? { state: "seen", txid: located.txid, height: located.height, blockHash: located.blockHash,
        amountAtomic: located.amountAtomic.toString(), operator: located.operator, url: located.url, completed, checked, failed }
    : { state: "pending", txid: null, height: null, blockHash: null, amountAtomic: null, completed, checked, failed };

  const problems = [];
  let agrees = null;
  if (exactError) problems.push("exact:" + exactError.code);
  if (located && exact && exact.txid) {
    if (String(exact.txid).toLowerCase() !== located.txid) problems.push("txid");
    if (Number(exact.height) !== located.height) problems.push("height");
    if (String(exact.blockHash || "").toLowerCase() !== located.blockHash) problems.push("blockHash");
    if (String(exact.amountAtomic ?? "") !== located.amountAtomic.toString()) problems.push("amount");
    agrees = problems.length === 0;
  } else if (located) {
    problems.push("exact:no-transaction");
    agrees = false;
  } else if (exact && exact.absent === true) {
    // ABSENCE NEEDS THE WHOLE SLICE WALK, NOT A SILENT WITNESS. A server that is down, stale or answered a
    // partial slice has not shown that the money is absent; its missing answer must not become agreement.
    if (witness.completed && witness.failed.length === 0) agrees = true;
    else {
      agrees = false;
      problems.push("witness:not-completed");
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
