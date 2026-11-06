# DLEQ test oracles

Test-only oracles for the cross-curve DLEQ scheme. Nothing here is part of the published package or the browser
bundle; `package.json` `files` does not include `test/`.

## What each side does

- `go/` — a fork of go-dleq with full `prove` and `verify`, a deterministic keccak DRBG, and SDK mode only:
  SHA3-512 read little-endian on both curves, `BITS = 253`, UTF-8 context, right-aligned scalar reduction.
  The reference implementation's left-aligned reduction (the review's R-REF-1) is **not** selected here; the
  differential reference mode remains in the private `dleq-review` repository.
- `rust/` — an independently written verifier (from the construction and the reference source), extended to
  `ninsei-dleq-vector/2` with `pokA`/`pokB` and the pure-multiple refusal. It does not generate proofs.

The Go oracle requires Go 1.27.3 or newer and generates the proofs. The Rust verifier requires Rust 1.99 or newer.
The SDK and Rust both verify the Go proofs; the SDK prover is also checked by Go and Rust. The JS runner is
`tools/check-dleq-oracle.mjs`. It also replays the committed JS fixtures through all three verifiers and checks that
a wrong context, a wrong public point, a low-order ed25519 point and a different witness are refused.

## Build and run

```sh
# Go
cd test/dleq-oracle/go
go build -buildvcs=false -o oracle ./cmd/oracle

# Rust
cd test/dleq-oracle/rust
cargo build --release --locked

# from the SDK root
DLEQ_GO_BIN=test/dleq-oracle/go/oracle \
DLEQ_RUST_BIN=test/dleq-oracle/rust/target/release/dleq-verify \
node tools/check-dleq-oracle.mjs
```

The corpus uses fixed witnesses, contexts and DRBG seeds; proofs are regenerated on every run. `Cargo.lock` and
`go.sum` pin the test dependencies.

## Provenance

The Go tree is derived from `AthanorLabs/go-dleq` (LGPL-3.0-only; see `LICENSE-GO-DLEQ`) and the review harness in `dleq-review`. The Rust verifier (Rust 1.99 or newer)
is the review's from-spec verifier. Keep the copyright/licence notices when editing either tree.
