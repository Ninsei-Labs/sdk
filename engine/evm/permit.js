// GENERATED FILE - a byte-for-byte copy of the engine module www/js/evm/permit.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// TOKEN ALLOWANCE FOR BUYING WITHOUT OWN ETH: what the token supports and what is missing.
//
// WHAT IS HERE AND WHAT IS NOT. Only selectors, calldata assembly and an HONEST verdict on whether a signature
// allowance suffices. No conclusion like "USDC has permit" is written from memory: that is a guess, and a guess
// about a token's accounting function costs money. The capability is PROBED by reading the chain, and the verdict
// can say "unknown" as a third value.
//
// WHAT IS ALREADY CHECKED FOR OUR SWAP LEG: the allowance is needed by the ROUTER as a normal approve. The
// router of this build does NOT know Permit2 (permit2() reverts; the transfer is paid by TransferHelper.safeTransferFrom
// from msg.sender). So Permit2 sits in the registry for a FUTURE funding path.
//
// WHY THERE IS NO SINGLE-TRANSACTION PATH HERE, AND IT IS NOT AN OVERSIGHT. The router sees msg.sender as the payer.
// A user without ETH cannot send approve, swap or deposit. Only an EXECUTOR CONTRACT could deposit for them and
// pull USDC by their signature (an EOA cannot present someone else's signature). No such contract exists here, so
// usdcWithoutEthVerdict REFUSES to call the path executable and says what is missing.
//
// THE DEPOSITOR SIGNATURE IS A DIFFERENT ALLOWANCE. It lets a relayer SEND the order-creation transaction, but
// not pull the token. Pulling USDC needs a separate TOKEN allowance (approve or permit) addressed to the puller.

// ERC-20 and EIP-2612 selectors. Next to each is the signature string it was computed from, and a check
// recomputes keccak256 of those strings, so a selector cannot diverge from its signature silently.
export const ERC20_METHOD = {
  approve: { hex: "0x095ea7b3", signature: "approve(address,uint256)" },
  allowance: { hex: "0xdd62ed3e", signature: "allowance(address,address)" },
  balanceOf: { hex: "0x70a08231", signature: "balanceOf(address)" },
};
export const EIP2612_METHOD = {
  permit: { hex: "0xd505accf", signature: "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)" },
  nonces: { hex: "0x7ecebe00", signature: "nonces(address)" },
  DOMAIN_SEPARATOR: { hex: "0x3644e515", signature: "DOMAIN_SEPARATOR()" },
};

const hexBody = (s) => String(s === undefined || s === null ? "" : s).replace(/^0x/, "");
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const addrWord = (a) => hexBody(a).toLowerCase().padStart(64, "0");
const uintWord = (v) => BigInt(v).toString(16).padStart(64, "0");
const wordBytes = (hex) => {
  const b = hexBody(hex);
  // AN EMPTY ANSWER IS "NOT READ", NOT "ZERO BYTES". This is how eth_call answers for an address without code.
  if (b.length === 0) return null;
  return b.length % 2 ? null : b.length / 2;
};

// calldata for a signature allowance (EIP-2612). Signature is r || s || v (65 bytes); v in {27,28}.
export function encodePermit({ owner, spender, value, deadline, signature }) {
  if (!isAddr(owner) || !isAddr(spender)) throw new Error("permit: owner and spender must be addresses");
  const hex = hexBody(signature);
  if (hex.length !== 130) throw new Error("permit: the signature must be 65 bytes, got " + hex.length / 2);
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) throw new Error("permit: v outside {27,28}: " + v);
  return EIP2612_METHOD.permit.hex +
    addrWord(owner) + addrWord(spender) + uintWord(value) + uintWord(deadline) +
    uintWord(v) + hex.slice(0, 64) + hex.slice(64, 128);
}

export const encodeNonces = (owner) => EIP2612_METHOD.nonces.hex + addrWord(owner);
export const encodeDomainSeparator = () => EIP2612_METHOD.DOMAIN_SEPARATOR.hex;
export const encodeApprove = ({ spender, amountWei }) => ERC20_METHOD.approve.hex + addrWord(spender) + uintWord(amountWei);

/**
 * Whether THIS address supports a signature allowance (EIP-2612). The answer has THREE states: "not checked"
 * must differ from "no".
 *   supported === true  - code exists, DOMAIN_SEPARATOR answers 32 bytes, nonces(owner) answers 32 bytes, and the bytecode has the permit selector;
 *   supported === false - code exists, but a signal is MISSING (then a signature allowance is unavailable);
 *   supported === null  - could not read (no code / empty answer): this is NOT "no permit", it is "unknown".
 */
export function permitSupportVerdict({ code = null, domainSeparator = null, nonces = null, owner = null } = {}) {
  const codeHex = hexBody(code);
  if (codeHex.length === 0) return { supported: null, kind: "no-code", reason: "no code at the token address - not a token, the allowance cannot be read" };
  if (!isAddr(owner)) return { supported: null, kind: "no-owner", reason: "no owner given - cannot read nonces(owner)" };
  const dsBytes = wordBytes(domainSeparator);
  if (dsBytes === null) return { supported: null, kind: "domain-unread", reason: "DOMAIN_SEPARATOR did not answer 32 bytes: could not read" };
  if (dsBytes !== 32) return { supported: false, kind: "domain-empty", reason: "DOMAIN_SEPARATOR returned " + dsBytes + " bytes instead of 32: no EIP-712 domain declared" };
  const nonceBytes = wordBytes(nonces);
  if (nonceBytes === null) return { supported: null, kind: "nonces-unread", reason: "nonces(owner) did not answer: could not read" };
  if (nonceBytes !== 32) return { supported: false, kind: "nonces-empty", reason: "nonces(owner) returned " + nonceBytes + " bytes instead of 32: no EIP-2612 counter" };
  if (!codeHex.toLowerCase().includes(EIP2612_METHOD.permit.hex.slice(2))) {
    return { supported: false, kind: "permit-selector-absent", reason: "the token bytecode has no permit selector: no signature allowance" };
  }
  return { supported: true, kind: "eip2612", reason: "the token declares an EIP-712 domain, a nonces counter and the permit selector" };
}

/**
 * Whether a token purchase WITHOUT own ETH is possible in a single transaction. The verdict says exactly what
 * is missing and does NOT hand out calldata until the path is fully executable.
 * @param {{ orchestrator?: string|null, permitSupported?: boolean|null, token?: string|null }} args
 */
export function usdcWithoutEthVerdict({ orchestrator = null, permitSupported = null, token = null } = {}) {
  // THE FIRST AND MAIN REFUSAL, and it is not about the token. The swap pays msg.sender (the router), and only
  // a CONTRACT can present someone else's pull signature. Without an executor the one-transaction path does
  // not exist AT ALL, regardless of the token.
  if (!isAddr(orchestrator)) {
    return {
      ok: false, blocked: true, kind: "no-orchestrator",
      reason: "no executor contract: only a contract could pull a token by the user signature and deposit native into the escrow in one transaction, and this build has none. The depositor signature without it lets a relayer SEND the order creation, but not pull the token",
    };
  }
  if (permitSupported === false) {
    return {
      ok: false, blocked: true, kind: "token-no-permit",
      reason: "the token has no signature allowance (EIP-2612): the allowance must be a separate approve, i.e. a separate transaction - the path does not assemble into one transaction",
    };
  }
  if (permitSupported !== true) {
    return {
      ok: false, blocked: true, kind: "permit-unproven",
      reason: "unknown whether the token supports a signature allowance: \"not checked\" is not \"possible\". The capability must be read from the chain before assembling the path",
    };
  }
  return { ok: true, blocked: false, kind: "one-tx-possible", reason: "an executor is present and the token declares EIP-2612: the one-transaction path assembles" };
}
