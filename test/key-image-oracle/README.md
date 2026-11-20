# Key-image oracle

A deliberately separate implementation of Monero's key-image primitive, used only by the SDK's differential
tests. It is built on [`monero-ed25519`](https://crates.io/crates/monero-ed25519), whose `Point::biased_hash` is a
constant-time Elligator 2 implementation of Monero's `ge_fromfe_frombytes_vartime` plus `ge_mul8`. It does not
import or copy `engine/monero/keyImage.js`.

## Build

```sh
cargo build --release
```

## Check both directions

From the SDK root:

```sh
node tools/check-key-image-oracle.mjs
```

The test makes the SDK generate output keys and images for the Rust binary to recompute, then makes Rust generate
them for the SDK to verify. The committed `tools/fixtures/key-image-rust-vectors.json` is the static Rust -> SDK
direction; the script covers the live binary and the derivation path in both directions.

## Stand check

`tools/check-key-image-stand.mjs` drives a real monerod and monero-ts wallet. It is opt-in because it needs a
daemon:

```sh
docker run -d --name sdk-xmr-check -p 38081:38081 -p 38082:38082 \
  ninsei-stand/monero:0.18.5.4 --testnet --offline --fixed-difficulty 1 \
  --rpc-bind-ip=0.0.0.0 --rpc-bind-port=38081 --confirm-external-bind --non-interactive \
  --no-igd --hide-my-port --data-dir /tmp/xmrdata
KEY_IMAGE_STAND=1 node tools/check-key-image-stand.mjs
```

It creates a buy payment to the primary address, a refunded-sale payment to a subaddress, and a multi-output
payment that carries additional transaction keys in extra tag `0x04`. Each output's `monero-ts getKeyImage()` is
compared with the SDK and with the Rust oracle.
