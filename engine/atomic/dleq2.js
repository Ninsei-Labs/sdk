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
// BOTH CURVES READ LITTLE-ENDIAN BY DECISION. That matches ed25519 in the reference; go-dleq's secp256k1 side
// reads big-endian. Security is neutral (either endianness gives a uniform challenge), but the wire forms differ.
// THE BIT COUNT IS 253, NOT THE REFERENCE'S 252. 253 is bitlen(l), the smaller of the two orders. The reference
// uses a conservative 252 for ed25519; it rejects witnesses in [2^252, 2^253), which Ninsei accepts. Honest halves
// are below l < 2^253, so the ranges agree; vector kat-05 pins the boundary.
// KNOWLEDGE PROOFS CLOSE THE PURE-MULTIPLE GAP. The bit proof only proves that the G-components share x. Without
// a Schnorr proof of knowledge per curve, a counterparty could quote X = x*G + rho*H: the bit proof still
// verifies, but the on-chain reveal needs rho*log(H), so the order locks up. `pokA`/`pokB` prove X = x*G for each
// curve and are checked before the 253 bit parts. This is the guard MRL-0010 derivatives add.
// STRICT SUBGROUP CHECK. ed25519 has cofactor 8, so a point may carry a small-order component. [8]*P != 0 was the
// old test; it rejected a purely small-order point but not a point with a small component. [l]*P = 0 pins every
// intermediate equation to the prime-order subgroup. This is canonical-form enforcement and defense-in-depth,
// not the soundness fix: the review could not construct an accepting torsion proof even without it.
// N3: UNCOMPRESSED secp256k1 POINTS (65-byte 04||x||y) ARE ACCEPTED. The point parser canonicalises them to the
// compressed form before the challenge, so the transcript is the same; this is leniency, not a second encoding.
// N4: SCALARS AT OR ABOVE THE ORDER ARE REDUCED, NOT REFUSED, matching the reference. A non-canonical sig scalar
// therefore verifies as its residue; requiring < ord would add strictness without rejecting an honest proof.
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
    const s = h.replace(/^0x/i, "");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  const bigToHex = (v) => v.toString(16).padStart(64, "0");
  function bytesToBig(b) { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; }
  // READ LEAST-SIGNIFICANT FIRST FOR BOTH CURVES BY DECISION. This is ed25519's order in the reference; go-dleq
  // reduces secp256k1 big-endian. Either choice is uniform and secure; the difference is wire compatibility, not
  // soundness. The prover and verifier here use the same rule, so a Ninsei proof is self-consistent.
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

  // THE SAME WORK, TWO WAYS TO DRAIN IT. The synchronous entry points drain the iterator immediately; the
  // chunked entry points await between steps so a browser can paint. There is one implementation of the
  // arithmetic, not a second "async" copy of it.
  function drain(iterator) {
    let step = iterator.next();
    while (!step.done) step = iterator.next();
    return step.value;
  }
  const nextTurn = async (yieldTo) => {
    if (typeof yieldTo === "function") return await yieldTo();
    if (globalThis.scheduler && typeof globalThis.scheduler.yield === "function") return await globalThis.scheduler.yield();
    return await new Promise((resolve) => setTimeout(resolve, 0));
  };

  // Per-bit commitments: C_i = b_i*G + r_i*G', with sum(r_i*2^i) = 0, so sum(C_i*2^i) = x*G.
  // The iterator yields after every bit; the chunked caller decides how many yields make one turn.
  function* commitmentsSteps(curve, x) {
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
      yield i + 1;
    }
    return { rs, cs };
  }
  function commitments(curve, x) { return drain(commitmentsSteps(curve, x)); }
  function modInv(a, m) {
    let [old_r, r] = [a % m, m], [old_s, s] = [1n, 0n];
    while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
    if (old_r !== 1n) throw new Error("modInv: not invertible");
    return ((old_s % m) + m) % m;
  }
  function* sumCommitmentsSteps(curve, cs) {
    let sum = cs[0];
    for (let i = 1; i < cs.length; i++) {
      sum = addP(sum, mul(curve, 2n ** BigInt(i) % curve.order, cs[i]));
      yield { phase: "sum", done: i, total: cs.length };
    }
    return sum;
  }
  function sumCommitments(curve, cs) { return drain(sumCommitmentsSteps(curve, cs)); }

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

  // SCHNORR PROOF OF KNOWLEDGE, ONE PER CURVE. The bit proof proves only that the G-components of XA and XB
  // share x; it does not prove that either point is a pure multiple of G. A prover can put rho*H into X, adjust
  // the last blinder, and still satisfy every bit equation. This proof closes that gap: it shows X = x*G, so a
  // H-component cannot hide in the claimed point. The challenge binds the context, the point and the nonce point;
  // a proof made for another order or another curve does not verify.
  function knowledgeProof(curve, x, X, context, label) {
    const k = randScalar(curve);
    const R = mul(curve, k);
    const e = challenge(curve, [ctxUtf8(context), ctxUtf8("ninsei-dleq-pok|" + label), encP(X), encP(R)]);
    return { R: enc(R), s: bigToHex((k + e * x) % curve.order) };
  }
  function verifyKnowledge(curve, X, pok, context, label) {
    if (!pok || typeof pok !== "object") return false;
    if (typeof pok.R !== "string" || typeof pok.s !== "string") return false;
    let R, s;
    try {
      R = curve.P.fromHex(pok.R.replace(/^0x/i, ""));
      s = BigInt(String(pok.s).startsWith("0X") ? "0x" + String(pok.s).slice(2) : String(pok.s).startsWith("0x") ? pok.s : "0x" + pok.s);
    } catch { return false; }
    const e = challenge(curve, [ctxUtf8(context), ctxUtf8("ninsei-dleq-pok|" + label), encP(X), encP(R)]);
    return mul(curve, s).equals(addP(R, mPublic(curve, X, e)));
  }

  // STEP 1. PREPARATION. The commitments depend on the running sum, so the order of the arithmetic is fixed;
  // the iterator yields between bits, which is enough for the chunked caller to keep the page alive. Per-bit
  // data is prepared here - exactly what step 2 needs: the bit, its commitments and its randomness. THE HALF IS
  // NO LONGER HERE, and that is the key property.
  function* prepareProofSteps(x, context) {
    x = typeof x === "bigint" ? x : BigInt(x);
    const XA = mul(curves.A, x), XB = mul(curves.B, x);
    yield { phase: "prepare", done: 0, total: BITS };
    const itA = commitmentsSteps(curves.A, x), itB = commitmentsSteps(curves.B, x);
    for (let i = 0; i < BITS; i++) {
      const a = itA.next(), b = itB.next();
      if (a.done || b.done) throw new Error("prepareProof: commitments ended early");
      yield { phase: "prepare", done: i + 1, total: BITS };
    }
    const cA = itA.next().value, cB = itB.next().value;
    const bits = [];
    for (let i = 0; i < BITS; i++) {
      bits.push({
        i,
        bit: bit(x, i) === 1n ? 1 : 0,
        cA: enc(cA.cs[i]), cB: enc(cB.cs[i]),
        rA: bigToHex(cA.rs[i]), rB: bigToHex(cB.rs[i]),
      });
    }
    yield { phase: "know", done: BITS, total: BITS };
    return {
      XA: enc(XA), XB: enc(XB), context: String(context == null ? "" : context),
      pokA: knowledgeProof(curves.A, x, XA, context, "A"),
      pokB: knowledgeProof(curves.B, x, XB, context, "B"),
      bits,
    };
  }
  function prepareProof(x, context) { return drain(prepareProofSteps(x, context)); }
  async function prepareProofChunked(x, context, options = {}) {
    const chunkBits = Number.isSafeInteger(options.chunkBits) && options.chunkBits > 0
      ? Math.min(options.chunkBits, BITS) : 8;
    const it = prepareProofSteps(x, context);
    let seen = 0;
    for (;;) {
      const step = it.next();
      if (step.done) return step.value;
      seen += 1;
      if (typeof options.onPrepare === "function") options.onPrepare(step.value);
      if (seen % chunkBits === 0) await nextTurn(options.yieldTo);
    }
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
    return { XA: prepared.XA, XB: prepared.XB, pokA: prepared.pokA, pokB: prepared.pokB, proofs };
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

  // THE CHUNKED PROOF IS THE SAME PROOF, WITH TURNS. Preparation and every bit come from the iterators above;
  // this function only decides when to give the event loop a chance to paint. The page stays responsive while
  // the arithmetic is still the one implementation.
  async function proveChunked(x, context, options = {}) {
    const chunkBits = Number.isSafeInteger(options.chunkBits) && options.chunkBits > 0
      ? Math.min(options.chunkBits, BITS) : 4;
    const prepared = await prepareProofChunked(x, context, {
      chunkBits: Number.isSafeInteger(options.prepareChunkBits) && options.prepareChunkBits > 0
        ? options.prepareChunkBits : 8,
      yieldTo: options.yieldTo,
      onPrepare: options.onPrepare,
    });
    const parts = [];
    for (let i = 0; i < BITS; i++) {
      parts.push(proveBit(prepared.bits[i], prepared.context));
      if ((i + 1) % chunkBits === 0 || i === BITS - 1) {
        if (typeof options.onBit === "function") options.onBit(i + 1, BITS);
        await nextTurn(options.yieldTo);
      }
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
  function* verifySteps(proof, context, options = {}) {
    if (!proof || typeof proof !== "object") return { ok: false, reason: "proof: an object is expected" };
    if (typeof proof.XA !== "string" || typeof proof.XB !== "string") return { ok: false, reason: "proof: no XA or XB" };
    if (!Array.isArray(proof.proofs)) return { ok: false, reason: "proof: no parts list" };
    if (proof.proofs.length !== BITS) return { ok: false, reason: "proof: " + proof.proofs.length + " parts, expected " + BITS };
    const requireKnowledge = options.requireKnowledge !== false;
    const P = (curve, h) => curve.P.fromHex(String(h).replace(/^0x/i, ""));
    let XA, XB, csA, csB;
    try {
      XA = P(curves.A, proof.XA); XB = P(curves.B, proof.XB);
      if (!torsionFree(curves.B, XB)) return { ok: false, reason: "proof: XB is not in the prime-order subgroup" };
    } catch (e) {
      return { ok: false, reason: "proof: XA or XB is unparsable (" + String((e && e.message) || e) + ")" };
    }
    // THE PURE-MULTIPLE GUARD COMES BEFORE THE BIT LOOP. It is optional only so old vectors can still be checked
    // as historical artifacts; every proof produced by this module carries both fields and SDK callers require
    // them. A missing or tampered `pokA`/`pokB` is a refusal, never a skipped check.
    if (requireKnowledge) {
      try {
        if (!verifyKnowledge(curves.A, XA, proof.pokA, context, "A")) return { ok: false, reason: "proof: the secp256k1 knowledge proof did not verify" };
        if (!verifyKnowledge(curves.B, XB, proof.pokB, context, "B")) return { ok: false, reason: "proof: the ed25519 knowledge proof did not verify" };
      } catch (e) {
        return { ok: false, reason: "proof: the knowledge proof is unparsable (" + String((e && e.message) || e) + ")" };
      }
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
    const sumA = yield* sumCommitmentsSteps(curves.A, csA);
    if (!sumA.equals(XA)) return { ok: false, reason: "the commitment sum does not give X on secp256k1" };
    const sumB = yield* sumCommitmentsSteps(curves.B, csB);
    if (!sumB.equals(XB)) return { ok: false, reason: "the commitment sum does not give X on ed25519" };
    for (let i = 0; i < proof.proofs.length; i++) {
      const item = proof.proofs[i];
      try {
        if (!torsionFree(curves.B, csB[i])) return { ok: false, reason: "bit " + i + ": the commitment is not in the prime-order subgroup" };
        const cA = item.cA, cB = item.cB;
        // ONLY THE SIX PROTOCOL SCALARS ARE READ. Unknown fields in `sig` are ignored (N2), and a missing one
        // still refuses: Object.entries would try to parse an unknown key as a scalar and throw.
        const sig = {};
        for (const k of ["eA", "eB", "a0", "a1", "b0", "b1"]) {
          const v = item.sig[k];
          const text = String(v);
          sig[k] = BigInt(/^0x/i.test(text) ? text : "0x" + text);
        }
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
      yield { phase: "verify", done: i + 1, total: proof.proofs.length };
    }
    return { ok: true };
  }
  function verify(proof, context, options = {}) { return drain(verifySteps(proof, context, options)); }

  // THE CHUNKED VERIFIER IS THE SAME VERIFIER, WITH TURNS. The sum and the bit loop are the expensive parts;
  // the phase-aware chunk keeps the browser paint budget without adding a second verification path.
  async function verifyChunked(proof, context, options = {}) {
    const it = verifySteps(proof, context, options);
    let phase = null, count = 0;
    for (;;) {
      const step = it.next();
      if (step.done) return step.value;
      const nextPhase = step.value && step.value.phase ? step.value.phase : null;
      if (nextPhase !== phase) { phase = nextPhase; count = 0; }
      count += 1;
      if (typeof options.onProgress === "function") options.onProgress(step.value);
      const every = phase === "sum" ? 16 : 4;
      if (count % every === 0) await nextTurn(options.yieldTo);
    }
  }
  return { BITS, curves, prove, proveChunked, verify, verifyChunked, prepareProof, prepareProofChunked, proveBit, assembleProof, torsionFree };
}
