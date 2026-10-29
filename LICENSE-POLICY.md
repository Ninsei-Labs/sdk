# Dependency license policy

The SDK is published as a public package under MIT. Its production dependency tree must stay compatible with
that promise: a dependency with a copyleft, source-available, unknown or missing licence is a decision for a
person, not something that enters a release by accident.

## Allowed licences

A production dependency may use one of these licences:

- MIT
- MIT-0
- ISC
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- Unlicense
- 0BSD
- CC0-1.0
- BlueOak-1.0.0

An SPDX expression is read as written: `MIT OR Apache-2.0` is allowed when one branch is allowed, and
`MIT AND ISC` is allowed when every branch is allowed. A `WITH` exception keeps the base licence's decision.
`SEE LICENSE IN ...`, `UNLICENSED`, `UNKNOWN`, and every licence outside the list are refused.

## How the check runs

`pnpm licenses list --prod --json` reads the installed production tree, including transitive packages. The
check is implemented in `tools/check-licenses.mjs`; CI runs it in the **License Compliance** workflow on every
pull request and every push to `main`.

```sh
pnpm run check:licenses
```

The command prints the packages grouped by licence. If any package is outside the allowlist, it prints each
package and its licence, then exits non-zero.

Development dependencies are not part of the published package and are not covered by this check.
