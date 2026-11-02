// oracle: differential driver for the refdleq fork.
//
//	oracle prove  --x <be-hex> [--context s] [--bits N]
//	              [--no-sigs] [--strict-torsion] [--seed <hex>] [--out path|-]
//	oracle verify --file path|-  [same mode flags]
//
// The command always runs the SDK verifier mode:
// --bits 253 --strict-torsion --no-sigs --context <s>. Reference mode is not
// exposed.
// With --seed, crypto/rand.Reader is replaced by the same keccak-256 DRBG the
// JS harness uses, so both sides are individually reproducible.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"os"

	dleq "dleqreview/refdleq"
	"dleqreview/refdleq/ed25519"
	"dleqreview/refdleq/secp256k1"
	"golang.org/x/crypto/sha3"
)

const schema = "ninsei-dleq-vector/2"

type drbg struct{ state []byte }

func newDrbg(seed []byte) *drbg {
	s := make([]byte, 32)
	copy(s, seed)
	return &drbg{s}
}

func keccak(parts ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

func (d *drbg) Read(b []byte) (int, error) {
	off := 0
	var ctr uint32
	for off < len(b) {
		cb := []byte{byte(ctr >> 24), byte(ctr >> 16), byte(ctr >> 8), byte(ctr)}
		block := keccak(d.state, cb)
		take := 32
		if len(b)-off < take {
			take = len(b) - off
		}
		copy(b[off:], block[:take])
		d.state = keccak(d.state, block)
		off += take
		ctr++
	}
	return len(b), nil
}

type compat struct {
	Bits          uint64 `json:"bits"`
	Context       bool   `json:"context"`
	SecpHashLE    bool   `json:"secpHashLE"`
	Signatures    bool   `json:"signatures"`
	StrictTorsion bool   `json:"strictTorsion"`
	Knowledge     bool   `json:"knowledge"`
}

type vector struct {
	Schema      string                 `json:"schema"`
	GeneratedBy string                 `json:"generatedBy"`
	Compat      compat                 `json:"compat"`
	X           string                 `json:"x"`
	Context     string                 `json:"context"`
	Proof       dleq.VectorProof       `json:"proof"`
	Signatures  *sigPair               `json:"signatures,omitempty"`
	Expect      map[string]interface{} `json:"expect,omitempty"`
	Note        string                 `json:"note,omitempty"`
}

type sigPair struct {
	A string `json:"A"`
	B string `json:"B"`
}

type modeFlags struct {
	context       *string
	bits          *uint64
	noSigs        *bool
	strictTorsion *bool
}

func addModeFlags(fs *flag.FlagSet) *modeFlags {
	return &modeFlags{
		context:       fs.String("context", "", "context string prepended to challenges"),
		bits:          fs.Uint64("bits", 0, "bit count; 0 = reference rule min(255,252)=252"),
		noSigs:        fs.Bool("no-sigs", false, "omit knowledge signatures (SDK proofs carry none)"),
		strictTorsion: fs.Bool("strict-torsion", false, "prime-subgroup checks on curve B (SDK verifier)"),
	}
}

func (m *modeFlags) options() dleq.Options {
	var ctx []byte
	if *m.context != "" {
		ctx = []byte(*m.context)
	}
	return dleq.Options{
		Bits:           *m.bits,
		Context:        ctx,
		SkipSignatures: *m.noSigs,
		StrictTorsion:  *m.strictTorsion,
	}
}

func (m *modeFlags) resolvedBits() uint64 {
	if *m.bits != 0 {
		return *m.bits
	}
	return 252 // min(secp256k1 255, ed25519 252) in the reference
}

func (m *modeFlags) compat() compat {
	return compat{
		Bits:          m.resolvedBits(),
		Context:       *m.context != "",
		SecpHashLE:    true,
		Signatures:    !*m.noSigs,
		StrictTorsion: *m.strictTorsion,
		Knowledge:     true,
	}
}

// THIS TEST ORACLE IS SDK MODE ONLY. The secp256k1 challenge is read LE and right-aligned, matching dleq2.js. The
// reference's left-aligned reduction (R-REF-1) must never be selected here; the differential reference mode stays
// in dleq-review, where it is useful for proving the divergence.
func newCurves() (dleq.Curve, dleq.Curve) {
	return secp256k1.NewCurve(), ed25519.NewCurve()
}

func die(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "oracle: "+format+"\n", args...)
	os.Exit(2)
}

func cmdProve(args []string) {
	fs := flag.NewFlagSet("prove", flag.ExitOnError)
	m := addModeFlags(fs)
	xHex := fs.String("x", "", "witness as big-endian hex (display integer form)")
	seed := fs.String("seed", "", "hex seed for the deterministic DRBG (replaces crypto/rand.Reader)")
	out := fs.String("out", "-", "output path or - for stdout")
	_ = fs.Parse(args)

	if *xHex == "" {
		die("prove: --x is required")
	}
	if *seed != "" {
		seedBytes, err := hex.DecodeString(*seed)
		if err != nil {
			die("prove: bad --seed: %v", err)
		}
		rand.Reader = newDrbg(seedBytes)
	}

	xInt, ok := new(big.Int).SetString(strip0x(*xHex), 16)
	if !ok {
		die("prove: bad --x")
	}
	var x [32]byte
	xb := xInt.Bytes()
	copy(x[32-len(xb):], xb)
	x = le32(x) // the reference wants little-endian bytes

	curveA, curveB := newCurves()
	opts := m.options()
	proof, err := dleq.NewProofWithOptions(curveA, curveB, x, opts)
	if err != nil {
		die("prove: %v", err)
	}
	if err := proof.VerifyWithOptions(curveA, curveB, opts); err != nil {
		die("prove: self-verify failed: %v", err)
	}

	vp := proof.ToVector()
	xA := curveA.ScalarFromBytes(x)
	xB := curveB.ScalarFromBytes(x)
	pokA, err := dleq.MakePok(curveA, xA, proof.CommitmentA, *m.context, "A", false)
	if err != nil {
		die("prove: pok A: %v", err)
	}
	pokB, err := dleq.MakePok(curveB, xB, proof.CommitmentB, *m.context, "B", true)
	if err != nil {
		die("prove: pok B: %v", err)
	}
	vp.PokA = &pokA
	vp.PokB = &pokB
	v := vector{
		Schema:      schema,
		GeneratedBy: "go",
		Compat:      m.compat(),
		X:           fmt.Sprintf("%064x", xInt),
		Context:     *m.context,
		Proof:       vp,
		Expect:      map[string]interface{}{"verify": true},
	}
	if !*m.noSigs {
		v.Signatures = &sigPair{A: proof.SignatureAHex(), B: proof.SignatureBHex()}
	}
	writeJSON(*out, v)
}

func cmdVerify(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	m := addModeFlags(fs)
	file := fs.String("file", "-", "vector path or - for stdin")
	_ = fs.Parse(args)

	data, err := readAll(*file)
	if err != nil {
		die("verify: %v", err)
	}
	var v vector
	if err := json.Unmarshal(data, &v); err != nil {
		die("verify: bad vector: %v", err)
	}

	curveA, curveB := newCurves()
	// THE VECTOR'S CONTEXT IS THE TRANSCRIPT CONTEXT. `--context` is only an override; without it the verifier
	// must use the same value the generator wrote, not an empty string.
	opts := m.options()
	if len(opts.Context) == 0 {
		opts.Context = []byte(v.Context)
	}
	var proof dleq.Proof
	if err := proof.FromVector(v.Proof, curveA, curveB); err != nil {
		outcome(false, "decode: "+err.Error())
		return
	}
	if v.Signatures != nil {
		if err := proof.SetSignatures(v.Signatures.A, v.Signatures.B); err != nil {
			outcome(false, "decode signatures: "+err.Error())
			return
		}
	}
	if v.Proof.PokA == nil || v.Proof.PokB == nil {
		outcome(false, "proof: missing knowledge proofs")
		return
	}
	if err := dleq.VerifyPok(curveA, proof.CommitmentA, *v.Proof.PokA, v.Context, "A"); err != nil {
		outcome(false, "pokA: "+err.Error())
		return
	}
	if err := dleq.VerifyPok(curveB, proof.CommitmentB, *v.Proof.PokB, v.Context, "B"); err != nil {
		outcome(false, "pokB: "+err.Error())
		return
	}
	err = proof.VerifyWithOptions(curveA, curveB, opts)
	if err != nil {
		outcome(false, err.Error())
		return
	}
	outcome(true, "")
}

func outcome(ok bool, reason string) {
	if ok {
		fmt.Println(`{"ok":true}`)
		os.Exit(0)
	}
	b, _ := json.Marshal(map[string]string{"ok": "false", "reason": reason})
	fmt.Println(string(b))
	os.Exit(1)
}

func strip0x(s string) string {
	for len(s) > 1 && s[:2] == "0x" {
		s = s[2:]
	}
	return s
}

func le32(in [32]byte) (out [32]byte) {
	for i := 0; i < 32; i++ {
		out[i] = in[31-i]
	}
	return out
}

func readAll(path string) ([]byte, error) {
	if path == "-" {
		return os.ReadFile("/dev/stdin")
	}
	return os.ReadFile(path)
}

func writeJSON(path string, v interface{}) {
	b, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		die("marshal: %v", err)
	}
	b = append(b, '\n')
	if path == "-" {
		_, _ = os.Stdout.Write(b)
		return
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		die("write: %v", err)
	}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: oracle prove|verify [flags]")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "prove":
		cmdProve(os.Args[2:])
	case "verify":
		cmdVerify(os.Args[2:])
	default:
		fmt.Fprintln(os.Stderr, "usage: oracle prove|verify [flags]")
		os.Exit(2)
	}
}
