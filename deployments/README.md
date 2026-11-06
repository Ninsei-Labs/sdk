# Deployment pins

`deployments/<vm>/<network>.json` is a reviewed copy of the contract repository's release manifest. It is the source
for `engine/core/deployments.generated.js`; the SDK never reads the contracts repository at runtime.

`tools/gen-deployment-pins.mjs --write` generates the module, and `--check` fails when the committed module is stale.
The manifest names the network, CAIP-2, status, release, anchor and artifacts. EVM artifacts carry `factory`,
`cashier`, `registry` and `implementation`, plus typed transaction references.

Do not edit `deployments.generated.js` by hand. A redeploy copies the new manifest here, regenerates the module, and
runs `node tools/check-deployment-pins.mjs` before release.
