// THE WALLET OUTSIDE AND WITHOUT KNOWLEDGE OF THE CHAIN (issue #32, requirement 4; extensibility for Tron and Solana).
//
// The SDK core knows neither EIP-1193, nor WalletConnect, nor the Solana wallet-standard. It knows the ADAPTER
// INTERFACE: vm, connect, disconnect, address, chainId, subscribe, driver - and requires the adapter to be for
// the SAME vm as the settlement network. The interface brings the wallet:
// `import { evmWallet } from "@ninsei-labs/sdk/adapters"`.
//
// It opens no windows and does not reach into others' settings: for EVM the network is switched through the
// provider, for other VMs it may not exist at all - then the honest answer is `not-implemented`, not a silent
// "nothing happened".
import { ERROR_CODES } from "./codes.mjs";
import { SdkError, fail } from "./errors.mjs";

const REQUIRED = ["connect", "disconnect", "address", "chainId", "subscribe", "driver"];

/** The adapter's refusal code, if it is declared by the contract; otherwise `unknown` (the adapter's text does not go out). */
const codeOf = (error) => (error && ERROR_CODES.includes(error.code) ? error.code : "unknown");

// THE OTHER SIDE OF THE SWAP IS MONERO. It cannot be the settlement network: Monero has no leg contract, so its
// wallet arrives as an adapter with this VM, and it reads the balance itself - there is no leg to delegate that to.
const XMR_VM = "monero";
// THE ATOMIC UNIT OF XMR: 1 XMR = 10^12 piconero (12 decimal places). monero-ts returns getUnlockedBalance in
// these, and sweep takes the free remainder in them too; the core does NOT reconvert these units.
const XMR_TOKEN = { token: "xmr", symbol: "XMR", decimals: 12 };
// THE STAGE AT WHICH SWITCHING THE NETWORK OF OTHER VMs WILL ARRIVE: stage 2 (sdk/README.md, "Stages") - the demo
// screens move onto the SDK. Until then the wallet switches the network itself, and that is NAMED by a code with
// the stage number, not swallowed.
const SWITCH_STAGE = 2;

export function createWallet({ settlement, leg }) {
  let adapter = null;
  let cached = { connected: false, address: null, chainId: null, chainMatches: false };
  const listeners = new Set();
  let detach = null;

  const settle = async (notify = true) => {
    if (!adapter) return cached;
    const [address, chainId] = await Promise.all([
      Promise.resolve(adapter.address()).catch(() => null),
      Promise.resolve(adapter.chainId()).catch(() => null),
    ]);
    const connected = typeof address === "string" && address.length > 0;
    cached = {
      connected,
      address: connected ? address : null,
      chainId: chainId === undefined ? null : chainId,
      chainMatches: connected && leg.sameChain(chainId, settlement),
    };
    if (notify) for (const handler of listeners) handler(cached);
    return cached;
  };

  const close = () => {
    if (typeof detach === "function") detach();
    detach = null;
  };

  return {
    use(next) {
      if (!next || typeof next !== "object") fail("bad-input", { field: "adapter" });
      const missing = REQUIRED.filter((name) => typeof next[name] !== "function");
      if (missing.length) fail("bad-input", { field: "adapter", missing });
      if (typeof next.vm !== "string" || !next.vm) fail("bad-input", { field: "adapter.vm" });
      // ANOTHER VM IS NOT SUBSTITUTED: the wallet is good either for the settlement network or for Monero - the
      // other side of the swap (which has neither a leg driver nor the settlement network's chainId). Anything
      // else is a refusal naming the vm.
      const acceptedVms = [settlement.vm, XMR_VM];
      if (!acceptedVms.includes(next.vm)) fail("bad-input", { field: "adapter.vm", expected: settlement.vm, accepted: acceptedVms, got: next.vm });
      close();
      adapter = next;
      detach = adapter.subscribe(() => { settle().catch(() => {}); });
      cached = { connected: false, address: null, chainId: null, chainMatches: false };
      settle().catch(() => {});
      return undefined;
    },
    // THE STATE IS RETURNED FROM MEMORY: reading from the wallet is asynchronous, while the interface needs the
    // answer in the same render tick. Fresh reads are done by connect(), switchChain() and wallet events - they
    // update the memory.
    status: () => cached,
    async connect({ chainId = null } = {}) {
      if (!adapter) fail("wallet-not-connected");
      try {
        // THE SETTLEMENT NETWORK IS NAMED ONLY TO ITS OWN WALLET: we do not tell the Monero wallet a foreign
        // chainId - its network is set by the Monero network, and an EVM chainId means nothing to it.
        const want = chainId === null && adapter.vm === settlement.vm ? leg.walletChainId(settlement) : chainId;
        await adapter.connect(want === null ? {} : { chainId: want });
      } catch (error) {
        throw new SdkError(codeOf(error), { vm: adapter.vm });
      }
      return settle();
    },
    async disconnect() {
      if (adapter) await Promise.resolve(adapter.disconnect()).catch(() => {});
      close();
      adapter = null;
      return void (await settle());
    },
    address: () => cached.address,
    async switchChain(chainId) {
      if (!adapter) fail("wallet-not-connected");
      if (!Number.isFinite(Number(chainId))) fail("bad-input", { field: "chainId" });
      // THE SETTLEMENT NETWORK IS SWITCHED BY THE SETTLEMENT WALLET, and only if it can. For another VM switching
      // the network lives only in the wallet itself - then a NAMED refusal with the stage number, not silence: the
      // interface will show its own action instead of deciding everything has already switched.
      if (adapter.vm !== settlement.vm || typeof adapter.switchChain !== "function") {
        fail("not-implemented", { surface: "wallet.switchChain", vm: adapter.vm, stage: SWITCH_STAGE });
      }
      try {
        await adapter.switchChain(Number(chainId));
      } catch (error) {
        throw new SdkError(codeOf(error), { vm: adapter.vm });
      }
      // DO NOT TAKE IT ON TRUST - CHECK IT: the wallet could "switch" and remain on the previous network. We
      // re-read the wallet's network (settle) and refuse if it is not the right one: otherwise a foreign balance
      // would look like your own, and the signature would go to the wrong chain.
      const status = await settle();
      if (!status.chainMatches) fail("wrong-chain", { got: status.chainId, want: leg.walletChainId(settlement) });
      return status;
    },
    /**
     * BALANCES in minimal units (string): the native coin and the settlement network's tokens.
     * They are read by the leg driver; an unread balance comes as null, not zero.
     */
    async balances(tokens) {
      if (!adapter) fail("wallet-not-connected");
      const status = cached.connected ? cached : await settle(false);
      if (!status.connected) fail("wallet-not-connected");
      // THE MONERO BALANCE IS THE WALLET'S OWN BUSINESS. Neither the leg nor the network check apply here: Monero
      // has no leg driver and no settlement-network chainId. The wallet returns the free remainder BY THE SAME
      // method as the XMR withdrawal (unlockedBalance; in monero-ts that is getUnlockedBalance), and in the same
      // atomic units.
      // THE UNITS ARE NOT RECONVERTED: an atomic unit arrives (1 XMR = 10^12), and BigInt turns it into a string -
      // exactly as in sweep.mjs. The core keeps no unit arithmetic of its own.
      if (adapter.vm === XMR_VM) {
        const wantedXmr = Array.isArray(tokens) && tokens.length ? tokens.map((t) => String(t).toLowerCase()) : [XMR_TOKEN.token];
        const unknownXmr = wantedXmr.find((id) => id !== XMR_TOKEN.token);
        if (unknownXmr !== undefined) fail("bad-input", { field: "tokens", unknown: unknownXmr });
        if (typeof adapter.unlockedBalance !== "function") fail("not-implemented", { surface: "wallet.balances", vm: XMR_VM });
        const amount = BigInt(await adapter.unlockedBalance()).toString();
        return [{ token: XMR_TOKEN.token, symbol: XMR_TOKEN.symbol, decimals: XMR_TOKEN.decimals, amount }];
      }
      // ON A FOREIGN NETWORK THE BALANCE IS NOT READ: it is a number from a different network, and it would look like an empty wallet.
      if (!status.chainMatches) fail("wrong-chain", { got: status.chainId, want: leg.walletChainId(settlement) });
      if (typeof leg.balances !== "function") fail("not-implemented", { surface: "wallet.balances", vm: settlement.vm });
      const all = settlement.tokens || [];
      const wanted = Array.isArray(tokens) && tokens.length ? tokens.map((t) => String(t).toLowerCase()) : all.map((t) => t.id);
      const picked = [];
      for (const id of wanted) {
        const token = all.find((t) => t.id === id);
        if (!token) fail("bad-input", { field: "tokens", unknown: id });
        picked.push(token);
      }
      return leg.balances({ driver: adapter.driver(), address: status.address, tokens: picked });
    },
    subscribe(handler) {
      if (typeof handler !== "function") fail("bad-input", { field: "handler" });
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    // INTERNAL, FOR THE LEG DRIVER: the provider/wallet client itself. It is not in the contract: the interface
    // does not need it, and the leg takes it from the SDK in one place.
    driver: () => (adapter ? adapter.driver() : null),
  };
}
