# Test quality for money paths

A green suite is not evidence that a guard works. The rule is: every signed field has an adversarial case, and every
guard has a breaking run that shows the case goes red when the guard is removed.

## Five checks for a test suite

1. **Independent oracle.** Do not compute the expected value with the code under test. Pin at least one vector from
   another implementation and mutate field order, width and encoding.
2. **Adversarial environment.** Cover the failure modes of the real dependency: one Byzantine node among several,
   timeout, 429/5xx, partial batch, pending/reverted/missing receipt, a process restart and a failed storage write.
3. **Cross-field binding.** For every pair that makes the protocol safe, change one side while both values stay
   individually valid and require a named refusal. Examples: proof point vs funded point, signed role vs on-chain
   slot, signed amount vs event amount, decimals vs wei.
4. **Durable state and exactly-once.** Retries and restarts must not send a second payment or write a second terminal
   outcome. Assert the absence of a row, call or file after a refusal.
5. **Mutation sensitivity.** Delete the guard in a copy, run the CI command list, require a non-zero exit naming the
   intended case, restore byte for byte, and run green again.

## Definition of done for a guard

- A valid input stays green.
- A breaking input refuses with its own code and, for quantities, the numbers.
- Deleting the guard reddens the exact check for the exact reason.
- The check drives the public entry or the shipped copy, not only a helper beside it.
- If two implementations carry the same rule, one test drives both or one implementation is deleted.

## Writing the test

Name the case after the attack, not the function: "service chose a receiver", "relay widened allowedSender",
"node omitted a transaction". Build the fixture from the provider's documented answer, not from the request the
implementation just built: a fixture derived from the request cannot see a service that substitutes a field.

Do not add a test that only raises the count. Add the smallest case that fails for the right reason.

## Current teeth

`tools/check-action-state-teeth.mjs` proves the action-window guards: removing the unreadable-clock refusal, the
claim margin or the simulation refusal reddens `check:action-state`. Further guards must follow the same shape.
