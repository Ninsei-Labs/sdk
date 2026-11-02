package secp256k1

import (
	"bytes"
	"fmt"
	"math/big"
	"testing"

	"golang.org/x/crypto/sha3"
)

// TestHashToScalarRightAlignsShortReduction pins the SDK reduction. A digest whose reduced value has fewer
// than 32 big-endian bytes must land at the END of the 32-byte array. The reference's left-aligned copy
// (REVIEW.md R-REF-1) multiplies such a scalar by 256 per missing byte and this test reddens.
func TestHashToScalarRightAlignsShortReduction(t *testing.T) {
	c := NewCurve().(*CurveImpl)
	for i := 0; i < 100000; i++ {
		in := []byte(fmt.Sprintf("rref-1-%d", i))
		h := sha3.Sum512(in)
		rev := make([]byte, len(h))
		for j := range h {
			rev[j] = h[len(h)-1-j]
		}
		n := new(big.Int).SetBytes(rev)
		n.Mod(n, c.order)
		nb := n.Bytes()
		if len(nb) >= 32 {
			continue
		}
		want := make([]byte, 32)
		copy(want[32-len(nb):], nb)
		got, err := c.HashToScalar(in)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got.Encode(), want) {
			t.Fatalf("input %q: got %x, want right-aligned %x (R-REF-1 regression)", in, got.Encode(), want)
		}
		return
	}
	t.Fatal("no short SHA3-512 reduction found in 100000 inputs")
}
