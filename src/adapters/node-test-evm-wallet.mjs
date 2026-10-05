// A TEST EVM WALLET FOR NODE: KEY FROM THE ENVIRONMENT, REFUSAL ON A PRODUCTION NETWORK.
//
// WHY A SEPARATE ADAPTER. The SDK had only the browser wallet (evm-wallet.mjs): it receives the page's ready-made
// EIP-1193 provider and signs via eth_sendTransaction - that is, the person's wallet does the signing. From Node
// there is nothing to sign with, and a live run on a local chain was impossible: the SDK refused at the very first
// step that needed a signature. This file closes exactly that hole - and only it.
//
// THIS IS A TOOL OF THE TEST CONTOUR, NOT A USER WALLET. The name shows it (node-test-*), and from that come two
// rules that are not up for discussion here:
//
//   1) THE KEY COMES ONLY FROM THE ENVIRONMENT OR FROM A FILE, the path to which also lives in the environment.
//      This module does NOT read command-line arguments AT ALL: a key in argv is visible in the shell history and
//      in the process list, that is, it leaks before anything is signed. The key's value is never printed: only the
//      address, transaction hashes and amounts go out.
//
//   2) ON A PRODUCTION NETWORK THE ADAPTER DOES NOT SIGN. The rule is not its own: it is already declared by the
//      engine (www/js/core/swap-flow.js: production = chain.escrow.mode === "live" && !chain.testnet) and the page
//      itself uses the same marker. A private "production network" marker would silently drift from the engine, and
//      then the test key would sign real money. So the rule is taken from the network registry, not written here.
//
// DEPENDENCIES. The signature is assembled the same way as the provider node's (rfq/evmSend.mjs): @noble/curves
// (secp256k1) and keccak256 - they are in the repository's devDependencies and already used in the project. There
// is neither DOM nor node:fs at the top level here: the adapters directory is the only place where the environment
// is allowed, but a static node:fs import would break the package's browser build, so the file is read via a
// dynamic import and only inside the key-loading function.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import keccakPkg from "keccak256";
import { SdkError } from "../errors.mjs";
import { config as engineConfig } from "../engine.mjs";

const keccak256 = (bytes) => new Uint8Array(keccakPkg(Buffer.from(bytes)));

// THE ENVIRONMENT VARIABLE NAMES - HERE, IN ONE PLACE: the run and the adapter must look at the same name,
// otherwise the key "is there" but the adapter does not see it.
export const KEY_ENV = "ARRAKIS_TEST_EVM_KEY";
export const KEY_FILE_ENV = "ARRAKIS_TEST_EVM_KEY_FILE";
export const RPC_ENV = "ARRAKIS_TEST_EVM_RPC";
export const CHAIN_ENV = "ARRAKIS_TEST_EVM_CHAIN";
export const CLAIMER_ENV = "ARRAKIS_TEST_EVM_CLAIMER";

// AN EXPLICIT WHITELIST OF TEST NETWORKS - HERE, NOT IN THE ENGINE, and WHY. The engine's "production network" rule
// (www/js/core/swap-flow.js: escrow.mode === "live" && !testnet) today does not trigger ON ANY recorded network: for
// the registry's production networks the escrow is marked "simulated", that is, by the letter of the rule they are
// not production. So the test key would also sign on mainnet - the engine would not notice, and the engine's rule
// must not be changed (it is shared by the page and all legs). So the "signing is ALLOWED here" marker is set
// separately and EXPLICITLY: only what is listed, and nothing more. First - the local anvil by chainId 31337.
export const TEST_CHAIN_IDS = Object.freeze([31337]);

const envOf = (name) => {
  const box = typeof process !== "undefined" && process ? process.env : null;
  const value = box ? box[name] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
export const envValue = envOf;

// --- ENCODINGS -----------------------------------------------------------------------------------------
const hexToBytes = (hex) => {
  const h = String(hex || "").replace(/^0x/, "");
  if (h.length === 0) return new Uint8Array(0);
  if (h.length % 2) throw new SdkError("bad-input", { field: "hex", why: "odd" });
  if (!/^[0-9a-fA-F]+$/.test(h)) throw new SdkError("bad-input", { field: "hex", why: "not-hex" });
  return Uint8Array.from(Buffer.from(h, "hex"));
};
const bytesToHex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
// Integers in RLP are encoded MINIMALLY, and zero is the empty string. A non-canonical encoding (an extra leading
// zero) makes the node reject the WHOLE transaction, even though the signature is valid.
const numToBytes = (value) => {
  const v = BigInt(value);
  if (v < 0n) throw new SdkError("bad-input", { field: "value", why: "negative" });
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes(hex);
};
const intFromBytes = (bytes) => numToBytes(BigInt(bytesToHex(bytes)));
const encodeLength = (len, offset) => {
  if (len < 56) return Uint8Array.from([offset + len]);
  const lenBytes = numToBytes(len);
  return Uint8Array.from([offset + 55 + lenBytes.length, ...lenBytes]);
};
const rlpItem = (item) => {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return Uint8Array.from([...encodeLength(item.length, 0x80), ...item]);
  }
  if (Array.isArray(item)) {
    const body = item.flatMap((x) => [...rlpItem(x)]);
    return Uint8Array.from([...encodeLength(body.length, 0xc0), ...body]);
  }
  throw new SdkError("bad-input", { field: "rlp" });
};

/** The account address for a private key: the last 20 bytes of the keccak256 of the UNcompressed point. */
export function addressOfPrivateKey(privateKeyHex) {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKeyHex), false);
  return "0x" + Buffer.from(keccak256(pub.slice(1))).toString("hex").slice(-40);
}

/**
 * SIGNING A LEGACY TRANSACTION (type 0, EIP-155). Legacy specifically, not 1559: it has no dependency on fee
 * history, and a local chain accepts it everywhere. Three things that are easy to get silently wrong (all three
 * were already caught in rfq/evmSend.mjs by checking against the Foundry reference, and all three are repeated
 * here deliberately):
 *   prehash: false - Ethereum signs the ALREADY computed keccak hash; the library by default hashes the passed
 *     data once more, and the signature becomes valid in form and completely foreign;
 *   recovery is the FIRST byte of the 65-byte signature (not the last);
 *   r and s go into RLP with minimal encoding, not full 32 bytes.
 */
export function signLegacyTx({ privateKey, nonce, gasPrice, gasLimit, to, data = "0x", value = 0, chainId }) {
  const signing = rlpItem([
    numToBytes(nonce), numToBytes(gasPrice), numToBytes(gasLimit), hexToBytes(to),
    numToBytes(value), hexToBytes(data), numToBytes(chainId), new Uint8Array(0), new Uint8Array(0),
  ]);
  const digest = keccak256(signing);
  const sig = secp256k1.sign(digest, hexToBytes(privateKey), { format: "recovered", prehash: false });
  if (sig.length !== 65) throw new SdkError("bad-input", { field: "signature", got: sig.length });
  const recovery = Number(sig[0]);
  if (recovery !== 0 && recovery !== 1) throw new SdkError("bad-input", { field: "signature", why: "recovery" });
  const r = intFromBytes(sig.slice(1, 33));
  const s = intFromBytes(sig.slice(33, 65));
  const v = BigInt(recovery) + 35n + BigInt(chainId) * 2n;
  const raw = rlpItem([
    numToBytes(nonce), numToBytes(gasPrice), numToBytes(gasLimit), hexToBytes(to),
    numToBytes(value), hexToBytes(data), numToBytes(v), r, s,
  ]);
  return { raw: bytesToHex(raw), hash: bytesToHex(keccak256(raw)) };
}

// --- LOADING THE KEY ------------------------------------------------------------------------------------
/**
 * The key from the environment or from a file. THE LOADER LIVES NEXT TO THE ADAPTER ON PURPOSE: it is the only
 * entry point for the key, and if the caller could pass the key as an argument, the rule "never from argv" would
 * rest on an honest word.
 * Returns { privateKey, address, from } - from names the source ("env" or "file"), the key itself goes out only in
 * this field and is never printed anywhere.
 */
export async function testPrivateKeyFromEnv() {
  let raw = envOf(KEY_ENV);
  let from = "env";
  if (!raw) {
    const file = envOf(KEY_FILE_ENV);
    if (!file) throw new SdkError("bad-input", { field: "privateKey", missing: [KEY_ENV, KEY_FILE_ENV] });
    // DYNAMIC IMPORT: a static node:fs would end up in the package's browser build, though it is needed only here.
    const fs = await import("node:fs");
    raw = String(fs.readFileSync(file, "utf8")).trim().split(/\r?\n/)[0].trim();
    from = "file";
  }
  const hex = raw.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new SdkError("bad-input", { field: "privateKey", why: "shape" });
  return { privateKey: "0x" + hex.toLowerCase(), address: addressOfPrivateKey(hex), from };
}

// --- A READ PROVIDER ------------------------------------------------------------------------------------
/**
 * An EIP-1193-compatible provider over HTTP JSON-RPC. Needed where the SDK reads the chain with the leg driver
 * (leg.balances -> eth_getBalance/eth_call) and as the reader for the lock step. THERE IS DELIBERATELY NO SIGNING
 * HERE: eth_sendTransaction answers with a refusal, because this adapter must sign with its own key, not the node -
 * otherwise the key would end up with the node, and the rule "key only from the environment" would stop meaning
 * anything.
 */
export function evmRpcProvider(url) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new SdkError("bad-input", { field: "rpcUrl" });
  const call = async (method, params = []) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new SdkError("server-unavailable", { rpc: method, status: res.status });
    const body = await res.json();
    if (body && body.error) throw new SdkError("server-unavailable", { rpc: method, why: String(body.error.message || "").slice(0, 80) });
    return body ? body.result : null;
  };
  const provider = {
    url,
    request({ method, params = [] }) {
      if (method === "eth_sendTransaction") {
        throw new SdkError("not-implemented", { surface: "provider.eth_sendTransaction" });
      }
      if (method === "eth_requestAccounts") return Promise.resolve([]);
      return call(method, params);
    },
  };
  return provider;
}

/**
 * CONTRACT READ FOR THE LOCK SEAM: { to, data } -> hex. Exactly the shape the engine expects (www/js/evm/
 * session.js, readContract), so it is dropped into the SDK WITHOUT an adapter. This is a CHAIN READ, not a node
 * substitution: the calls go to the real node at the rpcUrl address.
 */
export function evmRpcReader({ url }) {
  const provider = evmRpcProvider(url);
  return ({ to, data } = {}) => {
    if (!to || !data) throw new SdkError("bad-input", { field: "eth_call" });
    return provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
  };
}

// --- THE PRODUCTION-NETWORK MARKER ----------------------------------------------------------------------
/**
 * A PRODUCTION NETWORK - BY THE ENGINE'S RULE, NOT ITS OWN. The marker is taken from www/js/core/config.js (the
 * testnet field) and www/js/core/swap-flow.js (escrow.mode === "live"): on a production network there is a live
 * escrow and NO testnet marker. An unknown network is also considered production: there is nothing to prove it is a
 * test one, and an error in that direction costs a test key signing over real money.
 */
export function isProductionChain(chainId) {
  const chain = typeof engineConfig.chainByChainId === "function" ? engineConfig.chainByChainId(Number(chainId)) : null;
  if (!chain) return { production: true, reason: "unknown-chain", chain: null };
  const escrow = chain.escrow && typeof chain.escrow === "object" ? chain.escrow : null;
  const production = Boolean(escrow && escrow.mode === "live" && !chain.testnet);
  return { production, reason: production ? "production" : "testnet", chain };
}

// --- THE ADAPTER ----------------------------------------------------------------------------------------
/**
 * A test EVM wallet: the same interface as the page's wallet (vm, connect, disconnect, address, chainId, subscribe,
 * driver + send/receipt), but the signature is its own and the chain is read directly.
 *
 * IT ACCEPTS ONLY AN ALREADY-LOADED KEY: the loader is testPrivateKeyFromEnv above, and there is no other entry.
 * rpcUrl and chainId come from outside, but as VALUES (not the key), and the adapter keeps no factory address at
 * all: the addresses come from the SDK/engine's network registry, and a second source of truth about addresses must
 * not be introduced.
 */
export function nodeTestEvmWallet({ privateKey, rpcUrl, chainId = null, id = "node-test" } = {}) {
  const hex = String(privateKey || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new SdkError("bad-input", { field: "privateKey" });
  const key = "0x" + hex.toLowerCase();
  const owner = addressOfPrivateKey(key);
  const provider = evmRpcProvider(rpcUrl);
  let connected = false;

  const remoteChainId = async () => Number(BigInt(await provider.request({ method: "eth_chainId" })));

  // REFUSAL ON A PRODUCTION NETWORK - ONE POINT THROUGH WHICH EVERY SIGNATURE PASSES. The check stands here, not in
  // connect(), deliberately: connect may happen once and early, while the node's network may change later (or turn
  // out to be the wrong one at the moment of signing). We ask the network OF THE NODE right before signing.
  const assertTestContour = async () => {
    const remote = await remoteChainId();
    // A NETWORK OUTSIDE THE WHITELIST IS A REFUSAL NAMING THE NETWORK, BEFORE ANY SIGNATURE. This is the FIRST line
    // of defense and it does not depend on how the network is marked in the registry (the production marker is the
    // second line below, and today it may not trigger).
    if (!TEST_CHAIN_IDS.includes(Number(remote))) {
      throw new SdkError("wrong-chain", {
        why: "test-contour-network-not-allowed", chainId: remote, allowed: [...TEST_CHAIN_IDS],
      });
    }
    // THE SECOND LINE - THE ENGINE'S PRODUCTION-NETWORK RULE (not rewritten here, taken from the registry). It stays
    // for the case where a network from the list is later marked production: then the signature still stops.
    const view = isProductionChain(remote);
    if (view.production) {
      throw new SdkError("wrong-chain", {
        why: "test-contour-refuses-live-network", chainId: remote, reason: view.reason,
        escrowMode: view.chain && view.chain.escrow ? view.chain.escrow.mode : null,
        testnet: view.chain ? Boolean(view.chain.testnet) : null,
      });
    }
    if (chainId !== null && Number(chainId) !== remote) {
      throw new SdkError("wrong-chain", { got: remote, want: Number(chainId) });
    }
    return remote;
  };

  return {
    vm: "evm",
    id,
    // The address going out is what is anyway visible in every transaction. The key is not handed out by any method.
    async connect(options = {}) {
      const want = options && options.chainId !== undefined && options.chainId !== null ? Number(options.chainId) : chainId;
      const remote = await remoteChainId();
      if (want !== null && want !== undefined && Number(want) !== remote) {
        throw new SdkError("wrong-chain", { got: remote, want: Number(want) });
      }
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    address() {
      return owner;
    },
    async chainId() {
      return remoteChainId();
    },
    // NO SUBSCRIPTION: a local run has no "wallet changed network" event, while a poll timer would keep the process
    // alive after the last transaction. We return an unsubscribe function, as the adapter interface requires.
    subscribe() {
      return () => {};
    },
    driver() {
      return provider;
    },
    /**
     * SENDING: sign with its own key and eth_sendRawTransaction. The nonce is taken by pending, the gas price - from
     * the node, the gas limit - from the caller (the lock passes its own; if it did not, we estimate with a margin).
     * None of these numbers is invented: a guessed gas limit costs a signature, and a guessed nonce costs a lost
     * transaction.
     */
    async send({ to, data = "0x", value = 0n, gas = null }) {
      if (!connected) throw new SdkError("wallet-not-connected");
      if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new SdkError("bad-input", { field: "send.to" });
      const remote = await assertTestContour();
      const valueWei = BigInt(value === undefined || value === null ? 0 : value);
      const nonce = Number(BigInt(await provider.request({ method: "eth_getTransactionCount", params: [owner, "pending"] })));
      const gasPrice = BigInt(await provider.request({ method: "eth_gasPrice" }));
      let gasLimit = gas === null || gas === undefined ? null : BigInt(gas);
      if (gasLimit === null) {
        const est = BigInt(await provider.request({
          method: "eth_estimateGas",
          params: [{ from: owner, to, value: "0x" + valueWei.toString(16), data }],
        }));
        gasLimit = (est * 12n) / 10n;
      }
      const signed = signLegacyTx({
        privateKey: key, nonce, gasPrice, gasLimit, to, data,
        value: valueWei, chainId: remote,
      });
      const hash = await provider.request({ method: "eth_sendRawTransaction", params: [signed.raw] });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new SdkError("server-unavailable", { step: "send-raw" });
      }
      // THE HASH IS CHECKED AGAINST THE LOCALLY COMPUTED ONE. A discrepancy means the node accepted a transaction
      // different from the one we signed - and that must be found out here, not from missing money.
      if (hash.toLowerCase() !== signed.hash.toLowerCase()) {
        throw new SdkError("contract-reverted", { step: "hash-mismatch", node: hash, local: signed.hash });
      }
      return hash;
    },
    /**
     * THE RECEIPT: asked once and returned as is (null - not in a block yet). THE ARGUMENT SHAPE IS ACCEPTED BOTH
     * WAYS: a hash string and an object { hash }. This is not "just in case": the adapter contract declares
     * receipt(txHash: string), while the lock path in the SDK calls the receipt as receipt({ hash }) - the engine's
     * waitReceipt passes an object (www/js/evm/funding.js), and lock.mjs passes it into the adapter without
     * normalisation. A strict adapter answers bad-input to this, the refusal is swallowed by the wait, and the
     * escrow address is silently replaced with the PREDICTED one - that is, the "address from the receipt" check
     * stops working without saying so.
     */
    async receipt(txHash) {
      const hash = typeof txHash === "string" ? txHash : (txHash && typeof txHash.hash === "string" ? txHash.hash : null);
      if (!hash) throw new SdkError("bad-input", { field: "receipt.txHash" });
      const r = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
      return r || null;
    },
  };
}
