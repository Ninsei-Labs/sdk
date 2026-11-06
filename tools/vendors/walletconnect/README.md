# WalletConnect browser bundle

`assets/vendors/walletconnect/wc-browser.js` is a build-only artifact, not an upstream release. It contains
`@walletconnect/ethereum-provider` and the `qrcode` generator, with the low-level `EthereumProvider` used by
`engine/evm/session.js`.

## Source

The bundle was built in `arrakisswap-demo` at commit
`c466583d3e7b9eea538d4de4d61e23ccbbebfd16`. That commit's `package-lock.json` is checked in here unchanged as
`package-lock.json`; it is the only lock used by this build.

Direct versions:

| Package | Version |
|---|---|
| `@walletconnect/ethereum-provider` | `2.26.0` |
| `qrcode` | `1.5.4` |
| `viem` | `2.57.6` |
| `buffer` | `6.0.3` |
| `process` | `0.11.10` |
| `events` | `3.3.0` |
| `esbuild` | `0.28.2` |

`viem@2.57.6` is pinned in the lock. The later `2.57.7` changes the generated bundle; a rebuild with it is not
the committed artifact.

Reown AppKit is not imported. Its modal writes inline `<style>`, which the page CSP forbids; the SDK draws its own
modal in `engine/ui/walletModal.js`.

## Rebuild

```sh
cd tools/vendors/walletconnect
npm ci
npm run build
```

The command writes `assets/vendors/walletconnect/wc-browser.js` and prints its SHA-256. The expected value is
`fb64f27c1ec026811fe72bfff06da1f997bbf720569ea73be87818e2c5847eec`, also recorded in
`assets/vendors/MANIFEST.json`. `npm ci` is required: `npm install` may resolve different transitive versions.

The CI workflow `walletconnect-vendor.yml` reruns this build and fails if the output differs from the committed
bundle. The build dependencies are listed only here; they are not production dependencies of the SDK and are not
shipped in its tarball.
