// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/halves.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Half of a Monero key for the XMR <-> EVM atomic swap.
// The Monero spend key is the sum of two halves: ks = ks_a + ks_b (mod l); spending needs both.
// One half must work on edwards25519 (Monero) and secp256k1 (EVM), so the scalar stays below the smaller
// group order (min(l, n)) - that is what makes the equal-log proof converge on both groups.
// SECURITY: the audited primitives are @noble/curves, NOT this layer. Do not use with real money before a separate review.
// Dependencies are passed in from outside (browser: the vendored bundle; checks: node_modules). The module pulls nothing itself.

export function createHalves({ ed25519, secp256k1, keccak256, randomBytes }) {
  for (const [name, v] of [["ed25519", ed25519], ["secp256k1", secp256k1], ["keccak256", keccak256], ["randomBytes", randomBytes]]) {
    if (!v) throw new Error("createHalves: not passed " + name);
  }
  const ED_ORDER = ed25519.Point.Fn.ORDER;
  const SECP_ORDER = secp256k1.Point.Fn.ORDER;
  // The smaller group order: a half must fit into both groups (paper section 4.3).
  const LIMIT = ED_ORDER < SECP_ORDER ? ED_ORDER : SECP_ORDER;

  // Rejection sampling gives a uniform distribution; a modulo reduction would skew it towards small values.
  function newHalf() {
    for (let i = 0; i < 256; i++) {
      const bytes = randomBytes(32);
      let v = 0n;
      for (const b of bytes) v = (v << 8n) | BigInt(b);
      if (v > 0n && v < LIMIT) return v;
    }
    throw new Error("newHalf: could not get a scalar in 256 attempts");
  }

  // DERIVE THE HALF FROM A SECRET, NOT RANDOMNESS: the provider node derives it again from its key and the
  // order binding, so the same order always gives the same half, and only the secret holder can compute it.
  //
  // Rejection sampling, not modulo, as in newHalf: the half feeds a Monero address and must be uniform.
  // The attempt counter is part of the hash, so the same order and secret give the same half.
  //
  // WHY keccak, NOT HMAC: keccak is a sponge, so the order domain/secret/binding/counter is safe, and the
  // module needs no node:crypto (it runs in the browser too).
  // Half domains. Quoting and payout both take them from here: if the strings diverge, the node derives a
  // half that matches neither its commitment nor the assembled address.
  const HALF_DOMAIN = "ninsei-order-half-v1";          // spend half
  const VIEW_HALF_DOMAIN = "ninsei-order-view-v1";     // view half

  function halfFromSeed(seedBytes, binding, domain = HALF_DOMAIN) {
    if (!seedBytes || seedBytes.length < 16) throw new Error("halfFromSeed: secret shorter than 16 bytes");
    if (!binding) throw new Error("halfFromSeed: order binding not set");
    const dom = new TextEncoder().encode(domain + "|" + String(binding) + "|");
    for (let counter = 0; counter < 256; counter++) {
      // The attempt counter is an explicit 4-byte field, not a byte tweak.
      const input = new Uint8Array(dom.length + seedBytes.length + 4);
      input.set(dom, 0);
      input.set(seedBytes, dom.length);
      input[dom.length + seedBytes.length] = (counter >>> 24) & 0xff;
      input[dom.length + seedBytes.length + 1] = (counter >>> 16) & 0xff;
      input[dom.length + seedBytes.length + 2] = (counter >>> 8) & 0xff;
      input[dom.length + seedBytes.length + 3] = counter & 0xff;
      const bytes = keccak256(input);
      let v = 0n;
      for (const b of bytes) v = (v << 8n) | BigInt(b);
      if (v > 0n && v < LIMIT) return v;
    }
    throw new Error("halfFromSeed: could not get a scalar in 256 attempts");
  }

  function pointFromHex(P, hex) { return P.fromHex(hex.startsWith("0x") ? hex.slice(2) : hex); }

  // A HALF MAY COME AS A STRING, AND THAT IS NORMAL: the recovery file stores halves as hex (BigInt cannot
  // go into JSON). Convert here to cover all callers at once.
  function toScalar(v) {
    if (typeof v === "bigint") return v;
    if (typeof v === "string") {
      const t = v.trim().replace(/^0x/, "");
      if (!/^[0-9a-fA-F]{1,64}$/.test(t)) throw new Error("half does not look like a number: " + v.slice(0, 12));
      return BigInt("0x" + t);
    }
    if (typeof v === "number") return BigInt(v);
    throw new Error("half of unknown type: " + typeof v);
  }
  function hex(P) { return P.toHex(); }

  // Public halves on both curves: Ks_i = ks_i*G (edwards25519), Bs_i = ks_i*H (secp256k1).
  function publicHalves(half) {
    return {
      ed: hex(ed25519.Point.BASE.multiply(toScalar(half))),
      secp: hex(secp256k1.Point.BASE.multiply(toScalar(half))),
    };
  }

  // Sum of halves: privately (mod l) and publicly (point addition). The second equality is what the joint address rests on.
  function combineHalves(a, b) { return (toScalar(a) + toScalar(b)) % ED_ORDER; }
  function combinePublic(edHexA, edHexB) {
    return hex(pointFromHex(ed25519.Point, edHexA).add(pointFromHex(ed25519.Point, edHexB)));
  }

  return { LIMIT, ED_ORDER, SECP_ORDER, HALF_DOMAIN, VIEW_HALF_DOMAIN, newHalf, halfFromSeed, publicHalves, combineHalves, combinePublic };
}
