// CODE TABLES. The single place where the codes are named: they are read by the SDK, by the check and by the README.
//
// Why codes and not texts: wording, translations and tone are the interface's business. The core must name a
// state so that it can be translated and coloured without parsing a string (issue #32, requirement 2).

export const STEP_CODES = [
  "awaiting_funding",
  "funded",
  "maker_locking",
  "xmr_locked",
  "ready",
  "claimed",
  "swept",
];

export const TERMINAL_CODES = ["success", "refunded_eth", "xmr_returned", "closed"];

export const CHECK_CODES = [
  "balance",
  "gas",
  "allowance",
  "consent",
  "network",
  "settlement-network",
  "stale",
  "deadline",
  "range",
  "size",
  "escrow-state",
  "escrow-points",
  "counterparty",
  "slots",
  "unchecked",
  "unknown",
];

export const ERROR_CODES = [
  "not-implemented",
  "bad-input",
  "wallet-not-connected",
  "wallet-rejected",
  "wrong-chain",
  "quote-unavailable",
  "quote-refused",
  "quote-stale",
  // THE ORDER-QUOTE SIGNATURE (EIP-712, quote format v7). Four different refusals, because the interface owes the
  // person a different piece of advice for each:
  //   quote-signature-invalid - the signature does not recover to any address: it is malformed or made for other bytes;
  //   quote-key-mismatch      - the signature is valid but belongs to a key other than the one the quote names;
  //   quote-field-unbound     - a field the signature must cover is absent, so nothing can be verified;
  //   quote-expired           - the quote's own validUntil has passed.
  "quote-signature-invalid",
  "quote-key-mismatch",
  "quote-field-unbound",
  "quote-expired",
  // WHO OWNS THE KEY - ASKED OF THE CHAIN (maker registry, providerOf). The signature alone proves only that
  // SOME key signed; these four name what the registry (and the interface's policy) said:
  //   quote-registry-unchecked  - there was no way to ask the chain, so the claim stays unproven;
  //   quote-key-unknown         - the registry has no provider for this key (nobody owns it);
  //   quote-provider-mismatch   - the registry maps the key to a DIFFERENT provider than the quote names;
  //   quote-provider-not-allowed - the chain confirms the provider, but this interface does not admit it (policy).
  "quote-registry-unchecked",
  "quote-key-unknown",
  "quote-provider-mismatch",
  "quote-provider-not-allowed",
  // THE FACTORY THAT WILL VERIFY THE QUOTE AND WHERE ITS FEE GOES (issue #103). The factory is taken from
  // the provider's REGISTRY RECORD and its CODE is checked against the interface's known builds (extcodehash):
  //   quote-factory-unchecked    - no way to read the factory / its code, so the claim stays unproven;
  //   quote-factory-unknown      - the record names no factory (zero);
  //   quote-factory-mismatch     - the signed quote names a DIFFERENT factory than the record;
  //   quote-factory-code-unknown - the factory's code is not a build this interface knows.
  "quote-factory-unchecked",
  "quote-factory-unknown",
  "quote-factory-mismatch",
  "quote-factory-code-unknown",
  "recovery-declined",
  "recovery-failed",
  "storage-unavailable",
  "server-unavailable",
  // A REFUSAL BY OUR SERVICE, AND IT DELIBERATELY DIFFERS FROM A CONNECTION FAILURE: the connection never got
  // through - server-unavailable, while the service answered and did not accept - server-refused (with the
  // status and its own reason). The advice to the interface differs: "retry" versus "investigate".
  "server-refused",
  // A TIMEOUT WAITING FOR XMR TO ARRIVE - a separate code. "We did not wait long enough" is a state of the
  // money, not a breakdown and not an empty response: mixing it with other refusals, the interface could not
  // tell "not arrived yet" from "broken".
  "xmr-timeout",
  // XMR IS ON THE ADDRESS BUT BARRED BY THE TRANSACTION'S unlock_time (issue #84). Distinct from `xmr-timeout`:
  // that one means "nothing arrived within the wait", this one means "money is there and CANNOT be spent until a
  // height or a date". Marking ready under it would hand the escrow to the maker for funds he cannot be paid from -
  // so the core refuses with its own code, and the `until` boundary travels in params.
  "xmr-locked",
  // THE XMR ARRIVAL CHECK ON TWO NODES (issue #85). The decision "the XMR arrived" is made by the client, and a
  // single node is a single truth that can lie. Each code names a different reason the button must stay closed:
  //   xmr-nodes-disagree - a synced node has no such transaction in that block or a different block hash there;
  //   xmr-no-nodes       - every node in the list is unreachable, so nothing can be confirmed;
  //   xmr-underpaid      - the arrived amount is less than the expected one;
  //   xmr-too-late       - less time remains before the ready deadline than the required confirmations take.
  "xmr-nodes-disagree",
  "xmr-no-nodes",
  "xmr-underpaid",
  "xmr-too-late",
  "contract-reverted",
  "insufficient-funds",
  // CLAIM GAS FOR THE XMR SELLER (issue #78). The seller comes from Monero and has no coin on the EVM side to pay
  // for the claim, so the maker may send it - but only when asked for, and only after the core has CONFIRMED the
  // gas actually arrived. The three codes name the three states the interface must not blur together:
  //   gas-refused-by-maker - the maker declines to pay the claim gas, and the refusal is shown BEFORE the deal;
  //   gas-not-arrived      - the gas was ordered but the recipient's balance did not grow;
  //   gas-too-little       - gas arrived, but below what a claim costs (an unmeasured requirement counts here too).
  "gas-refused-by-maker",
  "gas-not-arrived",
  "gas-too-little",
  "unknown",
];

// GUARD KIND -> CHECK CODE. Kinds come from the engine (www/js/core/preSignGuards.js), codes are our public
// vocabulary. The table is checked by machine: every kind the engine can return must be here, otherwise the
// interface gets a code that is not in the contract.
export const KIND_TO_CHECK = {
  // size and range
  "in-range": "range",
  "above-max": "range",
  "below-min": "range",
  "range-unstated": "range",
  "size-unstated": "size",
  "amount-unstated": "size",
  "unit-mismatch": "range",
  // money
  "balance-enough": "balance",
  "balance-short": "balance",
  "balance-unchecked": "balance",
  "gas-enough": "gas",
  "gas-short": "gas",
  "reserve-unstated": "gas",
  "native-unchecked": "gas",
  // token allowance
  "not-needed": "allowance",
  "allowed": "allowance",
  "allowance-short": "allowance",
  "allowance-unchecked": "allowance",
  "consent-missing": "consent",
  // network
  "network-match": "network",
  "network-unknown": "network",
  "wallet-unknown": "network",
  "wallet-network": "network",
  "settlement-network": "settlement-network",
  // counterparty: a stand-in chain or a stand-in counterparty in the sandbox
  "real-provider": "counterparty",
  "stand-in-provider": "counterparty",
  "standin-on-production": "counterparty",
  // quote freshness
  "fresh": "stale",
  "stale": "stale",
  "no-ttl": "stale",
  "untimed": "stale",
  "expired": "stale",
  // deadlines
  "deadlines-ok": "deadline",
  "deadlines-unstated": "deadline",
  "ready-by-in-past": "deadline",
  "t1-not-after-ready-by": "deadline",
  "ready-window-too-short": "deadline",
  "claim-window-too-short": "deadline",
  // A DEADLINE TOO FAR AHEAD (issue #88 - a concurrent edit in this tree): the order's t1 is a year away, and the
  // ETH cannot be returned until then. It shares the `deadline` code with the other two extremes.
  "deadline-too-far": "deadline",
  // escrow state
  "new": "escrow-state",
  "already-funded": "escrow-state",
  "already-claimed": "escrow-state",
  "already-refunded": "escrow-state",
  "state-unchecked": "escrow-state",
  "off-step": "escrow-state",
  // points and halves
  "points-match": "escrow-points",
  "point-mismatch": "escrow-points",
  "commit-mismatch": "escrow-points",
  "points-unchecked": "escrow-points",
  // order book slots
  "slots-match": "slots",
  "slots-unchecked": "slots",
  // misc
  "unchecked": "unchecked",
};

export const checkCodeFor = (kind) => KIND_TO_CHECK[kind] || "unknown";
