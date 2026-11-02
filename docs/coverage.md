# Security invariants and coverage

A coverage percentage alone is not evidence that a security property holds. This repository keeps two separate
instruments:

1. `tools/security-invariants.mjs` — the reviewable map: every invariant names the files it constrains and the
   scripts that exercise it. `tools/check-security-invariants.mjs` is an **inventory lint**: it refuses an
   invariant with no check, a missing script, a dangling file, or a critical file that no invariant names. It does
   not execute the mapped scripts and does not prove that a particular assertion still checks the invariant; the
   scripts' own breaking runs and the review of their assertions carry that part.
2. `pnpm run coverage` — a baseline line-coverage report from Node's own V8 instrumentation. It is intentionally
   labelled **line coverage**, not branch or mutation coverage.

## Invariants

The current map covers sender/chain binding (`SEND-01`), quote policy and TTL (`QUOTE-POLICY-01`,
`QUOTE-TTL-01`), DLEQ knowledge proofs (`DLEQ-01`), recovery derivation (`RECOVERY-01`), storage failures and
isolation (`STORE-01`), relay transcript/retry (`RELAY-01`), terminal state (`STATE-01`), XMR arrival
(`ARRIVAL-01`) and the production adapter surface (`ADAPTER-01`).

The map is deliberately small. A new security-critical file must be added to `SECURITY_CRITICAL_FILES` and to at
least one invariant; a new invariant must point at a real check script.

## Coverage command

```sh
pnpm run coverage
```

The command runs the regular SDK check battery with `NODE_V8_COVERAGE` enabled, merges the child-process coverage,
and writes `coverage/coverage-summary.json`. Only `src/` and `engine/` JavaScript modules are counted; tests, tools,
vendored assets and generated browser bundles are excluded.

The report counts executable lines only: comments, blank lines and lines with no V8 range are not part of the
denominator. Equal V8 ranges from different processes are merged by summing their counts before the innermost range
is chosen, so a module loaded with count 0 by the parent and executed by a child is not reported as uncovered.

Every `.mjs`/`.js` file under `src/` and `engine/` is listed as inventory. A file that no check loaded is marked
`loaded: false` and counted in `totals.unloadedFiles`; its executable line count is unknown without V8, so it is not
folded into the percentage. It is a baseline and a trend signal, not a release gate by itself.

## What is still missing

- Branch coverage needs instrumentation that V8's raw format does not expose directly. It should be added with a
  dedicated coverage tool only after an explicit dependency decision.
- A numeric gate should be set per critical module, not for the whole package. Start with “no regression against
  the baseline”, then add per-file minimums where the invariant map shows a small, stable surface.
- Mutation testing remains a separate contour; the existing `*-teeth.mjs` checks are targeted breaking runs, not a
  full mutation score.
