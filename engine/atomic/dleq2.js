// GENERATED FILE - a byte-for-byte copy of the engine module www/js/atomic/dleq2.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// DLEQ ACROSS CURVES: a proof that one scalar stands behind points on secp256k1 and ed25519.
// Ported from go-dleq (prove.go, verify.go) to @noble/curves.
// THE CHALLENGE IS COMPUTED AS IN THE ORIGINAL: SHA3-512 and WIDE REDUCTION. The old edition used keccak256
// (32 bytes) reduced mod the order, which was BIASED (~2^-128) and differed from the reference; named by the
// audit and closed here. Now: a 64-byte hash, read LEAST-SIGNIFICANT first and reduced mod the order, exactly
// what ed25519 HashToScalar does. CONSEQUENCE: old proofs do not verify, so the context version was raised
// (ninsei-order-v3), else a live quote with an old proof would break silently.
// STRICT SUBGROUP CHECK. ed25519 has cofactor 8, so a point may carry a small-order component; the check
// "multiply by 8 is non-zero" lets it through and makes the equalities degenerate. We check strictly: [l]*P = 0.
// IMPORTANT: the primitives are audited (@noble/curves), THIS implementation is not.
//
//
//

export function createDleq2({ ed25519, secp256k1, keccak256, sha3_512, randomBytes }) {
  // SHA3-512 IS MANDATORY: without it the challenge cannot be computed, and a silent fallback to keccak256 would
  // be exactly the bug closed here. The refusal is loud and immediate.
  if (typeof sha3_512 !== "function") throw new Error("createDleq2: sha3_512 is required (SHA3-512 from @noble/hashes)");
  const ED_ORDER = ed25519.Point.Fn.ORDER, SEC_ORDER = secp256k1.Point.Fn.ORDER;
  // The secret lives in the bit length of the SMALLER order: this lifts the ks < min(l, n) limit.
  const BITS = Math.min(ED_ORDER.toString(2).length, SEC_ORDER.toString(2).length);

  const curves = {
    A: {
      name: "secp256k1", P: secp256k1.Point, order: SEC_ORDER,
      G: secp256k1.Point.BASE,
      Galt: secp256k1.Point.fromHex("0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"),
    },
    B: {
      name: "ed25519", P: ed25519.Point, order: ED_ORDER,
      G: ed25519.Point.BASE,
      Galt: ed25519.Point.fromHex("8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94"),
    },
  };

  // PRECOMPUTATION FOR THE SECOND BASE POINT. It is multiplied four times per bit, plus once in the commitments -
  // about a thousand times per proof, all of it WITHOUT a table. Measured: without a table 2.84 ms (secp256k1) and
  // 2.86 ms (ed25519); W=8 gives 0.905 ms and 0.422 ms with a table built once (226 ms). W=10 adds 13% but builds
  // 3x slower; W=12 is 2.4 s. true means lazy: the table is built at the first multiplication, so importing the
  // module is cheap and the first computation pays once.
  curves.A.Galt.precompute(8);
  curves.B.Galt.precompute(8);

  // THE CONTEXT GOES IN AS RAW UTF-8 BYTES. The old ctxHex built hex from charCodeAt, which broke for any char
  // above 0x7F (the prover and verifier could compute DIFFERENT challenges). The canonical order context is ASCII,
  // so live quotes do not change. The encoder is our own, not TextEncoder, to avoid a global in the worker.
  const ctxUtf8 = (context) => {
    const t = String(context == null ? "" : context);
    const out = [];
    for (let i = 0; i < t.length; i++) {
      let c = t.codePointAt(i);
      if (c > 0xffff) i++;                                  // surrogate pair: codePointAt already returned it whole
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };
  const enc = (x) => (typeof x === "string" ? x : x.toHex ? x.toHex() : String(x));
  function hexBytes(h) {
    const s = h.replace(/^0x/, "");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  const bigToHex = (v) => v.toString(16).padStart(64, "0");
  function bytesToBig(b) { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; }
  // READ LEAST-SIGNIFICANT FIRST, as ed25519 in the reference. Not style: the reverse order gives a different
  // challenge and the proof would not match the other side.
  function bytesToBigLE(b) { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; }
  function concat(parts) {
    const t = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(t);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  // Challenge: the same preimage, but reduced to a scalar by each curve's own rules. The ORDER CONTEXT is not
  // here - it enters parts via the preimage assembly. One mechanic for both sides, else the prover and verifier
  // would compute different challenges.
  function challenge(curve, parts) {
    const h = sha3_512(concat(parts.map((p) => (typeof p === "string" ? hexBytes(p) : p))));
    if (h.length !== 64) throw new Error("challenge: sha3_512 returned " + h.length + " bytes instead of 64");
    return bytesToBigLE(h) % curve.order;
  }
  // A RANDOM SCALAR IS ALSO WIDE-REDUCED: 64 random bytes mod the order. The old loop took 32 bytes and rejected
  // anything out of range: biased (~2^-128). Zero is theoretically possible (about 2^-252) and is replaced by one
  // - for commitments that is just non-zero randomness, not a refusal.
  function randScalar(curve) {
    const v = bytesToBigLE(randomBytes(64)) % curve.order;
    return v === 0n ? 1n : v;
  }
  function bit(x, i) { return (x >> BigInt(i)) & 1n; }
  // Multiplication by a PUBLIC scalar. In DLEQ all scalars are part of the proof the counterparty receives, so
  // constant time protects nothing and costs a lot: multiply 3.1 ms vs multiplyUnsafe 0.62 ms on ed25519. About
  // ten multiplications per bit, and the difference was most of those 20 seconds.
  //
  // ZERO IS LEGAL HERE. A zero bit gives b*G at b=0, and a zero-reduced challenge also occurs. The old code
  // returned the neutral element, which is correct. Zero returns the curve neutral element; multiplyUnsafe(0) is
  // not called at all - it throws.
  function mPublic(curve, point, scalar) {
    // The scalar arrives as a number or a hex string: scalars are stored as hex to survive JSON, and both forms
    // are normalised here.
    const raw = typeof scalar === "bigint" ? scalar : BigInt(scalar);
    const s = ((raw % curve.order) + curve.order) % curve.order;
    if (s === 0n) return curve.P.ZERO;
    // A POINT WITH A TABLE IS MULTIPLIED VIA multiply, the rest via multiplyUnsafe. Not interchangeable:
    // multiplyUnsafe ignores the table and stays 3-6x costlier on the second base point, while multiply WITHOUT
    // a table is costlier than multiplyUnsafe (measured 7.1 ms vs 2.8). The choice is tied to the point.
    if (point === curve.Galt) return point.multiply(s);
    return point.multiplyUnsafe(s);
  }

  // Point from a scalar on the second base point of the curve.
  function mul(curve, s, base) {
    return mPublic(curve, base || curve.G, typeof s === "bigint" ? s : BigInt(s));
  }
  const addP = (a, b) => a.add(b);
  const subP = (a, b) => a.subtract(b);
  const encP = (p) => hexBytes(p.toHex());
  const encS = (s) => hexBytes(bigToHex(s));

  // Per-bit commitments: C_i = b_i*G + r_i*G', with sum(r_i*2^i) = 0, so sum(C_i*2^i) = x*G.
  function commitments(curve, x) {
    const rs = [], cs = [];
    let sum = 0n, pow = 1n;
    for (let i = 0; i < BITS; i++) {
      if (i === BITS - 1) {
        const inv = modInv(pow, curve.order);
        rs[i] = ((curve.order - (sum % curve.order)) * inv) % curve.order;
      } else {
        rs[i] = randScalar(curve);
        sum = (sum + rs[i] * pow) % curve.order;
        pow = (pow * 2n) % curve.order;
      }
      const b = bit(x, i);
      cs.push(addP(mul(curve, b), mul(curve, rs[i], curve.Galt)));
    }
    return { rs, cs };
  }
  function modInv(a, m) {
    let [old_r, r] = [a % m, m], [old_s, s] = [1n, 0n];
    while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
    if (old_r !== 1n) throw new Error("modInv: not invertible");
    return ((old_s % m) + m) % m;
  }
  function sumCommitments(curve, cs) {
    let sum = cs[0];
    for (let i = 1; i < cs.length; i++) sum = addP(sum, mul(curve, 2n ** BigInt(i) % curve.order, cs[i]));
    return sum;
  }

  // OR proof "commitment to 0 or to 1" for one bit, on both curves at once.
  //
  // IT TAKES A BIT, NOT A HALF: a bit needs exactly one bit of the half and its randomness. So the step is
  // self-contained - it needs neither the half nor other bits, so it can go to another thread without the key.
  function ringSig(bitValue, i, cA, cB, rA, rB, context) {
    const j = randScalar(curves.A), k = randScalar(curves.B);
    const pre = (p1, p2) => [ctxUtf8(context), encP(cA), encP(cB), encP(p1), encP(p2)];
    const eA = challenge(curves.A, pre(mul(curves.A, j, curves.A.Galt), mul(curves.B, k, curves.B.Galt)), context);
    const eB = challenge(curves.B, pre(mul(curves.A, j, curves.A.Galt), mul(curves.B, k, curves.B.Galt)), context);
    const b = bitValue === 1n || bitValue === 1 ? 1n : 0n;
    if (b === 0n) {
      const a0 = randScalar(curves.A), b0 = randScalar(curves.B);
      const cAm1 = subP(cA, curves.A.G), cBm1 = subP(cB, curves.B.G);
      const eA0 = challenge(curves.A, pre(subP(mul(curves.A, a0, curves.A.Galt), mPublic(curves.A, cAm1, eA)),
                                        subP(mul(curves.B, b0, curves.B.Galt), mPublic(curves.B, cBm1, eB))), context);
      const eB0 = challenge(curves.B, pre(subP(mul(curves.A, a0, curves.A.Galt), mPublic(curves.A, cAm1, eA)),
                                        subP(mul(curves.B, b0, curves.B.Galt), mPublic(curves.B, cBm1, eB))), context);
      return { eA: eA0, eB: eB0, a0, a1: (j + eA0 * rA) % curves.A.order, b0, b1: (k + eB0 * rB) % curves.B.order };
    }
    const a1 = randScalar(curves.A), b1 = randScalar(curves.B);
    const eA1 = challenge(curves.A, pre(subP(mul(curves.A, a1, curves.A.Galt), mPublic(curves.A, cA, eA)),
                                      subP(mul(curves.B, b1, curves.B.Galt), mPublic(curves.B, cB, eB))), context);
    const eB1 = challenge(curves.B, pre(subP(mul(curves.A, a1, curves.A.Galt), mPublic(curves.A, cA, eA)),
                                      subP(mul(curves.B, b1, curves.B.Galt), mPublic(curves.B, cB, eB))), context);
    return { eA, eB, a0: (j + eA1 * rA) % curves.A.order, a1, b0: (k + eB1 * rB) % curves.B.order, b1 };
  }

  // Scalars go to hex: the proof must survive JSON and the thread boundary.
  const sigOut = (s) => ({ eA: bigToHex(s.eA), eB: bigToHex(s.eB), a0: bigToHex(s.a0), a1: bigToHex(s.a1), b0: bigToHex(s.b0), b1: bigToHex(s.b1) });

  // STEP 1. PREPARATION. Computed SEQUENTIALLY and whole: commitments depend on the running sum, so this step is
  // not split. Per-bit data is prepared here - exactly what step 2 needs: the bit, its commitments and its
  // randomness. THE HALF IS NO LONGER HERE, and that is the key property.
  function prepareProof(x, context) {
    const XA = mul(curves.A, x), XB = mul(curves.B, x);
    const cA = commitments(curves.A, x), cB = commitments(curves.B, x);
    const bits = [];
    for (let i = 0; i < BITS; i++) {
      bits.push({
        i,
        bit: bit(x, i) === 1n ? 1 : 0,
        cA: enc(cA.cs[i]), cB: enc(cB.cs[i]),
        rA: bigToHex(cA.rs[i]), rB: bigToHex(cB.rs[i]),
      });
    }
    return { XA: enc(XA), XB: enc(XB), context: String(context == null ? "" : context), bits };
  }

  // STEP 2. PROVE ONE BIT. Called on the prepared data, self-contained, knowing neither the half nor other bits.
  // So the steps are independent and parallelisable.
  function proveBit(part, context) {
    const sig = ringSig(part.bit === 1 ? 1n : 0n, part.i,
      curves.A.P.fromHex(String(part.cA).replace(/^0x/, "")),
      curves.B.P.fromHex(String(part.cB).replace(/^0x/, "")),
      BigInt("0x" + String(part.rA).replace(/^0x/, "")),
      BigInt("0x" + String(part.rB).replace(/^0x/, "")),
      context);
    return { i: part.i, cA: part.cA, cB: part.cB, sig: sigOut(sig) };
  }

  // STEP 3. ASSEMBLE. Nothing to add: the part order IS the bit order, checked below.
  function assembleProof(prepared, parts) {
    const byIndex = new Map(parts.map((p) => [p.i, p]));
    const proofs = [];
    for (let i = 0; i < BITS; i++) {
      const item = byIndex.get(i);
      if (!item) throw new Error("assembleProof: no part for bit " + i);
      proofs.push({ cA: item.cA, cB: item.cB, sig: item.sig });
    }
    return { XA: prepared.XA, XB: prepared.XB, proofs };
  }

  // prove REMAINS THE SAME FUNCTION, assembled from the same three steps: no second implementation appeared.
  function prove(x, context, onBit) {
    const prepared = prepareProof(x, context);
    const parts = [];
    for (let i = 0; i < BITS; i++) {
      // Progress during the count. 253 bits is those ten seconds, and without interim messages the interface
      // cannot show the work is running. Reported every 16 bits and at the last.
      if (onBit && (i % 16 === 0 || i === BITS - 1)) onBit(i + 1, BITS);
      parts.push(proveBit(prepared.bits[i], prepared.context));
    }
    return assembleProof(prepared, parts);
  }

  // STRICT SUBGROUP CHECK, NOT JUST SMALL ORDER. The old edition checked [8]*P != 0: it rejected a purely
  // small-order point but let a point with a small COMPONENT through, so a degenerate equality passed. Strict:
  // [l]*P = 0. secp256k1 is not checked: cofactor 1, the whole group is prime order.
  function torsionFree(curve, point) {
    if (curve.name !== "ed25519") return true;
    // WHAT IS COUNTED HERE. isTorsionFree() in @noble/curves is exactly [n]*P = 0, i.e. the point is in the
    // prime-order subgroup. Writing it via multiplyUnsafe(order) FAILS: the library requires a scalar below the
    // order, so the check term would look like a refusal.
    try { return point.isTorsionFree() === true; } catch { return false; }
  }
  // FORM IS CHECKED BEFORE COUNTING. The old loop ran over the received list length: a short proof proved
  // ANOTHER representation, a long one burned check time. An honest path always sends exactly BITS parts. An
  // unparsable field returns a refusal, not an exception: the caller must get {ok:false}, not crash.
  function verify(proof, context) {
    if (!proof || typeof proof !== "object") return { ok: false, reason: "proof: an object is expected" };
    if (typeof proof.XA !== "string" || typeof proof.XB !== "string") return { ok: false, reason: "proof: no XA or XB" };
    if (!Array.isArray(proof.proofs)) return { ok: false, reason: "proof: no parts list" };
    if (proof.proofs.length !== BITS) return { ok: false, reason: "proof: " + proof.proofs.length + " parts, expected " + BITS };
    const P = (curve, h) => curve.P.fromHex(String(h).replace(/^0x/, ""));
    let XA, XB, csA, csB;
    try {
      XA = P(curves.A, proof.XA); XB = P(curves.B, proof.XB);
      if (!torsionFree(curves.B, XB)) return { ok: false, reason: "proof: XB is not in the prime-order subgroup" };
    } catch (e) {
      return { ok: false, reason: "proof: XA or XB is unparsable (" + String((e && e.message) || e) + ")" };
    }
    // THE BIT NUMBER IS NAMED HERE TOO: without it, "somewhere in the proof" is indistinguishable from any of
    // the 253 commitments being corrupt.
    try {
      csA = proof.proofs.map((item, i) => {
        try { return P(curves.A, item.cA); } catch (e) { throw new Error("bit " + i + ": " + String((e && e.message) || e)); }
      });
      csB = proof.proofs.map((item, i) => {
        try { return P(curves.B, item.cB); } catch (e) { throw new Error("bit " + i + ": " + String((e && e.message) || e)); }
      });
    } catch (e) {
      return { ok: false, reason: "proof: " + String((e && e.message) || e) };
    }
    if (!sumCommitments(curves.A, csA).equals(XA)) return { ok: false, reason: "the commitment sum does not give X on secp256k1" };
    if (!sumCommitments(curves.B, csB).equals(XB)) return { ok: false, reason: "the commitment sum does not give X on ed25519" };
    for (let i = 0; i < proof.proofs.length; i++) {
      const item = proof.proofs[i];
      try {
        if (!torsionFree(curves.B, csB[i])) return { ok: false, reason: "bit " + i + ": the commitment is not in the prime-order subgroup" };
        const cA = item.cA, cB = item.cB;
        const sig = Object.fromEntries(Object.entries(item.sig).map(([k, v]) => [k, BigInt(String(v).startsWith("0x") ? v : "0x" + v)]));
        const pA = P(curves.A, cA), pB = P(curves.B, cB);
        const pre = (q1, q2) => [ctxUtf8(context), encP(pA), encP(pB), encP(q1), encP(q2)];
        const aG = mul(curves.A, sig.a1, curves.A.Galt), eCA = mPublic(curves.A, pA, sig.eA);
        const bH = mul(curves.B, sig.b1, curves.B.Galt), eCB = mPublic(curves.B, pB, sig.eB);
        const eA = challenge(curves.A, pre(subP(aG, eCA), subP(bH, eCB)), context);
        const eB = challenge(curves.B, pre(subP(aG, eCA), subP(bH, eCB)), context);
        const aG0 = mul(curves.A, sig.a0, curves.A.Galt), ecA = mPublic(curves.A, subP(pA, curves.A.G), eA);
        const bH0 = mul(curves.B, sig.b0, curves.B.Galt), ecB = mPublic(curves.B, subP(pB, curves.B.G), eB);
        const eA0 = challenge(curves.A, pre(subP(aG0, ecA), subP(bH0, ecB)), context);
        const eB0 = challenge(curves.B, pre(subP(aG0, ecA), subP(bH0, ecB)), context);
        if (eA0 !== sig.eA || eB0 !== sig.eB) return { ok: false, reason: "bit " + i + ": challenges did not match" };
      } catch (e) {
        return { ok: false, reason: "bit " + i + ": fields are unparsable (" + String((e && e.message) || e) + ")" };
      }
    }
    return { ok: true };
  }

  return { BITS, curves, prove, verify, prepareProof, proveBit, assembleProof, torsionFree };
}
