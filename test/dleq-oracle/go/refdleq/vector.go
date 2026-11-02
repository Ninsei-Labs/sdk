// ORACLE ADDED: JSON vector conversion in the shared schema (js/lib.mjs).
// Hex fields are lowercase without 0x, matching the SDK JSON surface exactly.
package dleq

import (
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

type VectorSig struct {
	EA string `json:"eA"`
	EB string `json:"eB"`
	A0 string `json:"a0"`
	A1 string `json:"a1"`
	B0 string `json:"b0"`
	B1 string `json:"b1"`
}

type VectorPart struct {
	CA string    `json:"cA"`
	CB string    `json:"cB"`
	Sig VectorSig `json:"sig"`
}

type VectorPok struct {
	R string `json:"R"`
	S string `json:"s"`
}

type VectorProof struct {
	XA     string       `json:"XA"`
	XB     string       `json:"XB"`
	PokA   *VectorPok   `json:"pokA,omitempty"`
	PokB   *VectorPok   `json:"pokB,omitempty"`
	Proofs []VectorPart `json:"proofs"`
}

func toHex(b []byte) string { return hex.EncodeToString(b) }

func fromHex(s string) ([]byte, error) {
	s = strings.TrimPrefix(s, "0x")
	return hex.DecodeString(s)
}

func (p *Proof) SignatureAHex() string { return toHex(p.signatureA.inner) }
func (p *Proof) SignatureBHex() string { return toHex(p.signatureB.inner) }

// SetSignatures restores the reference knowledge-signatures on a vector that
// carries them; without them a signatures-on verify cannot pass.
func (p *Proof) SetSignatures(aHex, bHex string) error {
	a, err := fromHex(aHex)
	if err != nil {
		return err
	}
	b, err := fromHex(bHex)
	if err != nil {
		return err
	}
	p.signatureA.inner = a
	p.signatureB.inner = b
	return nil
}

func (p *Proof) ToVector() VectorProof {
	vp := VectorProof{
		XA:     toHex(p.CommitmentA.Encode()),
		XB:     toHex(p.CommitmentB.Encode()),
		Proofs: make([]VectorPart, len(p.proofs)),
	}
	for i, bp := range p.proofs {
		vp.Proofs[i] = VectorPart{
			CA: toHex(bp.commitmentA.commitment.Encode()),
			CB: toHex(bp.commitmentB.commitment.Encode()),
			Sig: VectorSig{
				EA: toHex(bp.ringSig.eCurveA.Encode()),
				// The shared schema stores scalars as big-endian display
				// integers (the SDK's bigToHex). edwards25519 encodes scalars
				// little-endian, so the curve-B fields are reversed here and
				// re-reversed by FromVector's decodeScalarMod.
				EB: revHex(bp.ringSig.eCurveB.Encode()),
				A0: toHex(bp.ringSig.a0.Encode()),
				A1: toHex(bp.ringSig.a1.Encode()),
				B0: revHex(bp.ringSig.b0.Encode()),
				B1: revHex(bp.ringSig.b1.Encode()),
			},
		}
	}
	return vp
}

func revHex(b []byte) string {
	r := make([]byte, len(b))
	for i := range b {
		r[i] = b[len(b)-1-i]
	}
	return toHex(r)
}

// FromVector decodes the JSON surface the way the SDK verifier reads it:
// scalars are display integers in hex and are reduced mod the group order
// (never refused for being non-canonical), points are decoded per the curve.
func (p *Proof) FromVector(vp VectorProof, curveA, curveB Curve) error {
	var err error
	p.CommitmentA, err = decodePoint(curveA, vp.XA)
	if err != nil {
		return fmt.Errorf("XA: %w", err)
	}
	p.CommitmentB, err = decodePoint(curveB, vp.XB)
	if err != nil {
		return fmt.Errorf("XB: %w", err)
	}
	p.proofs = make([]bitProof, len(vp.Proofs))
	for i, part := range vp.Proofs {
		bp := bitProof{}
		bp.commitmentA.commitment, err = decodePoint(curveA, part.CA)
		if err != nil {
			return fmt.Errorf("bit %d cA: %w", i, err)
		}
		bp.commitmentB.commitment, err = decodePoint(curveB, part.CB)
		if err != nil {
			return fmt.Errorf("bit %d cB: %w", i, err)
		}
		bp.ringSig.eCurveA, err = decodeScalarMod(curveA, part.Sig.EA)
		if err != nil {
			return fmt.Errorf("bit %d eA: %w", i, err)
		}
		bp.ringSig.eCurveB, err = decodeScalarMod(curveB, part.Sig.EB)
		if err != nil {
			return fmt.Errorf("bit %d eB: %w", i, err)
		}
		bp.ringSig.a0, err = decodeScalarMod(curveA, part.Sig.A0)
		if err != nil {
			return fmt.Errorf("bit %d a0: %w", i, err)
		}
		bp.ringSig.a1, err = decodeScalarMod(curveA, part.Sig.A1)
		if err != nil {
			return fmt.Errorf("bit %d a1: %w", i, err)
		}
		bp.ringSig.b0, err = decodeScalarMod(curveB, part.Sig.B0)
		if err != nil {
			return fmt.Errorf("bit %d b0: %w", i, err)
		}
		bp.ringSig.b1, err = decodeScalarMod(curveB, part.Sig.B1)
		if err != nil {
			return fmt.Errorf("bit %d b1: %w", i, err)
		}
		p.proofs[i] = bp
	}
	return nil
}

func decodePoint(curve Curve, s string) (Point, error) {
	b, err := fromHex(s)
	if err != nil {
		return nil, err
	}
	return curve.DecodeToPoint(b)
}

// decodeScalarMod mirrors the SDK: a scalar is a big-endian display integer,
// reduced mod the group order. ed25519 scalars travel as little-endian
// canonical bytes internally, so the reduction result is re-encoded LE.
func decodeScalarMod(curve Curve, s string) (Scalar, error) {
	b, err := fromHex(s)
	if err != nil {
		return nil, err
	}
	v := new(big.Int).SetBytes(b)
	order := curveOrder(curve)
	if order == nil {
		return nil, errors.New("unknown curve order")
	}
	v.Mod(v, order)
	if isEd25519(curve) {
		le := intToLE32(v)
		var arr [32]byte
		copy(arr[:], le)
		return curve.ScalarFromBytes(arr), nil
	}
	be := intToBE32(v)
	return curve.DecodeToScalar(be[:])
}

func isEd25519(curve Curve) bool {
	// The ed25519 implementation reports a 32-byte compressed point and 252
	// bit size; secp256k1 reports 33 bytes and 255. That is enough to tell
	// them apart for the re-encoding rule.
	return curve.CompressedPointSize() == 32
}

func curveOrder(curve Curve) *big.Int {
	if isEd25519(curve) {
		// ed25519 group order l
		l, _ := new(big.Int).SetString("7237005577332262213973186563042994240857116359379907606001950938285454250989", 10)
		return l
	}
	n, _ := new(big.Int).SetString("115792089237316195423570985008687907852837564279074904382605163141518161494337", 10)
	return n
}

func intToLE32(v *big.Int) []byte {
	be := v.Bytes()
	out := make([]byte, 32)
	for i := 0; i < len(be) && i < 32; i++ {
		out[i] = be[len(be)-1-i]
	}
	return out
}

func intToBE32(v *big.Int) [32]byte {
	var out [32]byte
	be := v.Bytes()
	copy(out[32-len(be):], be)
	return out
}

// MakePok builds the SDK's Schnorr proof of knowledge for X = x*G. The scalar
// is encoded big-endian (the SDK's display integer); `little` is true for
// ed25519, whose native scalar encoding is little-endian.
func MakePok(curve Curve, x Scalar, X Point, context, label string, little bool) (VectorPok, error) {
	k := curve.NewRandomScalar()
	r := curve.ScalarBaseMul(k)
	e, err := pokChallenge(curve, X, r, context, label)
	if err != nil {
		return VectorPok{}, err
	}
	s := k.Add(e.Mul(x))
	return VectorPok{R: toHex(r.Encode()), S: scalarHex(s, little)}, nil
}

// VerifyPok checks s*G == R + e*X with the same context and curve label the
// SDK uses. A missing or malformed field is a refusal, not a skipped check.
func VerifyPok(curve Curve, X Point, pok VectorPok, context, label string, little bool) error {
	rb, err := fromHex(pok.R)
	if err != nil {
		return fmt.Errorf("pok R: %w", err)
	}
	r, err := curve.DecodeToPoint(rb)
	if err != nil {
		return fmt.Errorf("pok R: %w", err)
	}
	s, err := scalarFromHex(curve, pok.S, little)
	if err != nil {
		return fmt.Errorf("pok s: %w", err)
	}
	e, err := pokChallenge(curve, X, r, context, label)
	if err != nil {
		return err
	}
	lhs := curve.ScalarBaseMul(s)
	rhs := r.Add(curve.ScalarMul(e, X))
	if !lhs.Equals(rhs) {
		return errors.New("pok did not verify")
	}
	return nil
}

func pokChallenge(curve Curve, X, R Point, context, label string) (Scalar, error) {
	pre := make([]byte, 0, len(context)+len(label)+len(X.Encode())+len(R.Encode())+20)
	pre = append(pre, []byte(context)...)
	pre = append(pre, []byte("ninsei-dleq-pok|"+label)...)
	pre = append(pre, X.Encode()...)
	pre = append(pre, R.Encode()...)
	return curve.HashToScalar(pre)
}

func scalarHex(s Scalar, little bool) string {
	b := s.Encode()
	if little {
		return revHex(b)
	}
	return toHex(b)
}

func scalarFromHex(curve Curve, value string, little bool) (Scalar, error) {
	b, err := fromHex(value)
	if err != nil {
		return nil, err
	}
	if len(b) > 32 {
		return nil, errors.New("scalar too long")
	}
	padded := make([]byte, 32)
	copy(padded[32-len(b):], b)
	if little {
		for i := 0; i < 16; i++ {
			padded[i], padded[31-i] = padded[31-i], padded[i]
		}
	}
	return curve.DecodeToScalar(padded)
}

