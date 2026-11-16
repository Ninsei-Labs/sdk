# Testing

These rules apply to every test in every Ninsei Labs repository, whatever its language. Each repository's
AGENTS.md links here and adds only what is its own: its commands, and which of its code moves money or keeps
state.

A test is worth having when it fails on the mistake it is there to catch. Every rule below serves that.

## What a new test must prove

- The commit message names the behaviour the test protects and a plausible mistake it catches. Prefer another
  input to an existing property or table over a separate test for each finding, and say why when a separate
  test is needed. Test count and coverage alone do not justify a test.
- A test for a bug is a property of the bug's class, with the reported case as one input. A test of the one
  scenario passes when the same mistake comes back in another form.
- For a bug fix, show that the test fails before the fix and passes after it. For a new test of money, state,
  keys or a protection that has no failing revision, plant the mistake it names in an isolated copy and show
  which assertion fails. Never leave the planted change in the patch. Record the command and the result in the
  commit message, not in a new report file.
- Assert what the program returns, sends or records, including errors and side effects. Expected values come
  from the contract or an example worked out independently, never from the production function or a copy of
  its algorithm. An assertion about the test's own inputs or calculations proves nothing about the program.
- Check that a collection has the expected count or members before checking its items: a loop over an empty
  result must not pass a test that needs results. Check amounts with their assets, units and networks where
  these change the behaviour.
- A canned answer does not prove the request was right. Check the request fields the behaviour depends on,
  such as the size, asset, network, fee or reduce-only flag.
- A test is named after the behaviour it pins and lives beside the code it tests. The name says only what the
  test exercises: a restart test restarts, and parsing an example is not evidence of a live contract.
- A test named for a behaviour must fail when that behaviour breaks. Prove it once with the planted change: a
  test that stays green on the bug its name describes gives false comfort.
- Keep a regression test after its bug is fixed. Remove or merge it only when its behaviour is obsolete or
  another test demonstrably catches the same mistake.

## Boundaries, fees and units

- Pin both sides of every threshold, boundary and deadline: the value itself, one unit below and one above. A
  test that checks only values far from the edge stays green when the edge moves.
- Exercise every fee path with a non-zero fee. With a zero fee, a fee that is dropped, doubled or charged to the
  wrong side gives the same result as the right one.
- Check the units wherever they change: atomic units against whole coins, gas against wei, basis points
  against percent. A unit mistake is off by a round factor that a loose check lets through.

## Fakes and fixtures

- A fake of an external service follows the service's documented contract or a recorded answer, never the
  client's own types. A fake built from the client's types agrees with the client by construction, so it
  cannot see the contract drift.
- Fixtures use the real domain of each field, every value the service can send: monerod's `spent_status` is 0,
  1 or 2, not a boolean. A fixture with only the common values hides the branch for the others. A synthetic
  example says so where it is defined.
- An interface or adapter is also tested through an implementation built only from its declared types. The
  real implementation may give more than the declaration promises, and code that leans on the extra breaks with
  the next implementation.

## Running the code

- A grep or regex over source text never replaces running the code. It checks how the code is written, not
  what it does, so it passes on wrong code that matches and fails on right code that does not. A lint rule
  about how tests are written is a different thing (see Enforcement): it sits beside the run, never in its place.
- No sleeps and no wall-clock timing. Inject the clock and the time budgets, and wait for a named event. A
  test that sleeps is slow on a quiet machine and flaky on a busy one.
- A package's own tests catch its own bugs. A bug caught only by another package's tests is caught by luck:
  that test can change for its own reasons, and the bug then gets through.

## Flaky tests

- A test that passes only when it runs again is broken. CI never retries a failed test to make a run green: a
  retry hides the fault the first failure showed.
- A flaky test is fixed, or moved out of the blocking run under a marker that names its issue. A scheduled job
  keeps running it and reports each failure. No test leaves the blocking run without an issue and an owner.

## Randomness and forks

- A test with random inputs, orders or seeds prints the seed when it fails and reads the seed back from an
  environment variable, so the failure can be run again from the log.
- A test against a fork of a live chain pins its block number. Without the pin, a new block changes the result
  and nobody can rerun yesterday's failure.

## Breaking runs

A breaking run, by hand or by a mutation tool, plants mistakes to show that the tests catch them. Besides
deleting guards, it moves boundaries by one unit, swaps operands and changes constants. A deleted guard is the
easiest mistake to catch; the ones that get through are an edge moved by one, two arguments swapped or a
constant changed.

## Tests that money and state code must have

Code that moves money, keeps state, holds keys or enforces a protection has tests for:

- a restart at any point, and a reconnection after a gap;
- a delayed or lost answer, and a partial fill or payment;
- a write that fails (fault injection), followed by recovery;
- events in every order the API allows;
- NaN, infinities, negative, zero and huge inputs.

## Contracts that hold funds

- A fuzzing handler calls every external function from several actors, and the invariants are checked after
  every call: the funds held equal the funds paid in less the funds paid out, and no order ends both claimed and
  refunded.
- The fuzzer chooses the time, around every deadline as well as far from it. A harness that only moves the clock
  to fixed points never reaches the deadline itself.
- Every revert condition has a test that triggers it with every other condition met, so the test fails for that
  reason alone. A test that reverts for an earlier reason stays green when the guard it names is gone.
- Deployment and upgrade run on a fork at a pinned block.

## Fuzzing

- Every parser of outside input (network answers, files, keys, what people type) has a fuzz target. Its seeds
  come from the contract and the recorded answers and run with the ordinary tests.
- The targets also run with a time budget in a scheduled job that is skipped when nothing has changed since the
  last run. CI minutes cost money: fuzz the parsers that read outside input, and keep each budget short.
- An input the fuzzer finds that breaks a parser becomes a seed, so every run checks it again.

## Measurements

A measurement without a pass or fail requirement is a benchmark, not a test. Keep setup out of the measured
loop, and fail on setup or read errors. Correctness checks of money, recovery and protections stay ordinary
tests even when they also run a large workload.

## Getting to green

- Never delete, skip or loosen a failing test, or change an expected value, to make a run pass. When behaviour
  changes on purpose, the same commit changes the expectation and its message says why.
- Production code has no branch that only tests take: the test then checks a path no user runs.

## Enforcement

- A rule that shows in the text of a test is a lint check that blocks merge: a sleep or a wall clock in a test, a
  skip without an issue, a parser without a fuzz target. Written rules alone do not hold; the patterns that break
  tests are easy to miss in a diff.
- Reviewers check the rest of this file by hand.
- Lint checks how tests are written. It never replaces running them.
