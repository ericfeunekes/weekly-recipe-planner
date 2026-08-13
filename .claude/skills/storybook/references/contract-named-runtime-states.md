# Contract-Named Runtime States

Use this when a Storybook story, checkpoint, or browser assertion is named for a
runtime state such as `stale-no-owner`, `fallback`, `empty`, `terminal`,
`error`, `partial-answer`, `tool-active`, or `reasoning-active`.

## Rule

The story title/export name, docs description, selected fixture/checkpoint, play
assertions, and browser/e2e assertions must all describe the same semantic
state. Do not update a failing assertion to match the current UI if the story
name or checkpoint says the opposite state should be visible.

## Review Pattern

When a contract-named story fails:

1. Read the story export name and docs description.
2. Read the checkpoint selector or fixture comment that creates the state.
3. Read the owning domain/testing doc for that state's contract.
4. Compare the play/browser assertion against the contract.
5. If the assertion accepts the wrong semantic state, treat it as false-green
   proof and fix the implementation or checkpoint, not just the expected text.

## Examples

- A `stale-no-owner` story should prove stale semantic ownership releases to
  generic/no-owner copy. It should not pass when a stale tool label is visible.
- A `tool-active` story can prove a friendly tool label only when the selected
  checkpoint actually represents a fresh tool owner. A pre-debounce or
  pre-semantic state should assert generic/no-owner copy instead.
- A `partial-answer-visible` story should assert the assistant answer is visible
  and transient chrome is hidden for the active run. It should not pass by
  rendering both states at once.

## Pitfalls

- Recording-derived checkpoints can become stale after state-machine changes.
  Re-check the event index and timed `advanceSlot` behavior instead of reusing
  the old expected label.
- Browser proof that asserts text only is weak when the semantic state matters.
  Assert owner metadata, absence of contradictory content, and the visible copy.
- A green Storybook Playwright run is not proof if the story name and assertion
  disagree about the contract being tested.
