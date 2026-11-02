// Forked from github.com/athanorlabs/go-dleq/verify.go (MIT).
// ORACLE patches, kept minimal and marked:
//   - Options (see prove.go): Bits, Context, SkipSignatures mirror the SDK;
//     StrictTorsion adds the SDK's prime-subgroup checks on curve B.
//   - The proof part count is checked up front (the reference indexes blindly;
//     the SDK verifier refuses a count that is not exactly BITS).
package dleq

import (
	"errors"
	"fmt"
	"os"
)

// torsionChecker is implemented by the ORACLE's ed25519 PointImpl.
type torsionChecker interface {
	TorsionFree() bool
}

// Verify verifies the proof is valid against the given curves.
// TODO: encode curves into proof somehow?
func (p *Proof) Verify(curveA, curveB Curve) error {
	return p.VerifyWithOptions(curveA, curveB, Options{})
}

// VerifyWithOptions is the ORACLE verifier. The command passes the SDK options;
// Options{} keeps the upstream defaults for direct callers.
func (p *Proof) VerifyWithOptions(curveA, curveB Curve, opts Options) error {
	bits := opts.Bits
	if bits == 0 {
		bits = min(curveA.BitSize(), curveB.BitSize())
	}

	// ORACLE ADDED: the SDK verifier refuses any part count that is not exactly
	// BITS; the reference would panic or ignore trailing parts.
	if uint64(len(p.proofs)) != bits {
		return fmt.Errorf("proof has %d parts, expected %d", len(p.proofs), bits)
	}

	commitmentsA := make([]commitment, len(p.proofs))
	for i := range commitmentsA {
		commitmentsA[i] = p.proofs[i].commitmentA
	}

	err := verifyCommitmentsSum(curveA, commitmentsA, p.CommitmentA)
	if err != nil {
		return fmt.Errorf("failed to verify commitment on curve A: %w", err)
	}

	commitmentsB := make([]commitment, len(p.proofs))
	for i := range commitmentsB {
		commitmentsB[i] = p.proofs[i].commitmentB
	}

	err = verifyCommitmentsSum(curveB, commitmentsB, p.CommitmentB)
	if err != nil {
		return fmt.Errorf("failed to verify commitment on curve B: %w", err)
	}

	// ORACLE ADDED: the SDK requires every curve-B point to be in the
	// prime-order subgroup; the reference has no such check.
	if opts.StrictTorsion {
		if tc, ok := p.CommitmentB.(torsionChecker); ok && !tc.TorsionFree() {
			return errors.New("commitment B is not in the prime-order subgroup")
		}
		for i := range p.proofs {
			if tc, ok := p.proofs[i].commitmentB.commitment.(torsionChecker); ok && !tc.TorsionFree() {
				return fmt.Errorf("bit %d: commitment is not in the prime-order subgroup", i)
			}
		}
	}

	if !opts.SkipSignatures {
		// verify signatures
		ok := curveA.Verify(p.CommitmentA, p.CommitmentA, p.signatureA.inner)
		if !ok {
			return fmt.Errorf("failed to verify signature on commitment A")
		}

		ok = curveB.Verify(p.CommitmentB, p.CommitmentB, p.signatureB.inner)
		if !ok {
			return fmt.Errorf("failed to verify signature on commitment B")
		}
	}

	// now calculate challenges and verify
	for i := uint64(0); i < bits; i++ {
		proof := p.proofs[i]

		aG := curveA.ScalarMul(proof.ringSig.a1, curveA.AltBasePoint())
		eCA := proof.commitmentA.commitment.ScalarMul(proof.ringSig.eCurveA)

		bH := curveB.ScalarMul(proof.ringSig.b1, curveB.AltBasePoint())
		eCB := proof.commitmentB.commitment.ScalarMul(proof.ringSig.eCurveB)

		eA1, err := hashToScalar(
			curveA,
			opts.Context,
			proof.commitmentA.commitment,
			proof.commitmentB.commitment,
			aG.Sub(eCA),
			bH.Sub(eCB),
		)
		if err != nil {
			return err
		}

		eB1, err := hashToScalar(
			curveB,
			opts.Context,
			proof.commitmentA.commitment,
			proof.commitmentB.commitment,
			aG.Sub(eCA),
			bH.Sub(eCB),
		)
		if err != nil {
			return err
		}

		commitmentAMinusOne := proof.commitmentA.commitment.Sub(curveA.BasePoint())
		commitmentBMinusOne := proof.commitmentB.commitment.Sub(curveB.BasePoint())

		aG = curveA.ScalarMul(proof.ringSig.a0, curveA.AltBasePoint())
		bH = curveB.ScalarMul(proof.ringSig.b0, curveB.AltBasePoint())
		ecA := commitmentAMinusOne.ScalarMul(eA1)
		ecB := commitmentBMinusOne.ScalarMul(eB1)

		t1 := aG.Sub(ecA)
		t2 := bH.Sub(ecB)
		if os.Getenv("ORACLE_DEBUG") != "" {
			fmt.Fprintf(os.Stderr, "bit %d branch0: aG0=%x ecA=%x t1=%x | bH0=%x ecB=%x t2=%x\n",
				i, aG.Encode(), ecA.Encode(), t1.Encode(), bH.Encode(), ecB.Encode(), t2.Encode())
		}

		eA0, err := hashToScalar(
			curveA,
			opts.Context,
			proof.commitmentA.commitment,
			proof.commitmentB.commitment,
			t1,
			t2,
		)
		if err != nil {
			return err
		}

		eB0, err := hashToScalar(
			curveB,
			opts.Context,
			proof.commitmentA.commitment,
			proof.commitmentB.commitment,
			t1,
			t2,
		)
		if err != nil {
			return err
		}

		if !eA0.Eq(proof.ringSig.eCurveA) || !eB0.Eq(proof.ringSig.eCurveB) {
			if os.Getenv("ORACLE_DEBUG") != "" {
				fmt.Fprintf(os.Stderr, "bit %d: eA1'=%x eB1'=%x | eA0'=%x vs %x | eB0'=%x vs %x\n",
					i, eA1.Encode(), eB1.Encode(), eA0.Encode(), proof.ringSig.eCurveA.Encode(), eB0.Encode(), proof.ringSig.eCurveB.Encode())
			}
			return errors.New("invalid proof")
		}
		if os.Getenv("ORACLE_DEBUG") != "" && i < 3 {
			fmt.Fprintf(os.Stderr, "bit %d: eA1'=%x eB1'=%x ok\n", i, eA1.Encode(), eB1.Encode())
		}
	}

	return nil
}
