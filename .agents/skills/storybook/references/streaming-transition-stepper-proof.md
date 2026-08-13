# Streaming Transition Stepper Proof

Use this reference when a Storybook/runtime UI needs to prove **slot ownership
over time**, not just static streaming snapshots.

## Core Lesson

Static checkpoint stories prove that selected states render correctly. They do
not prove ownership transitions such as:

- reasoning owns the slot until it closes or goes stale;
- tool activity reduces in the background without stealing a fresh slot;
- a timed debounce/tick lets the next eligible block claim ownership;
- the slot disappears as soon as active-run assistant content lands.

For those claims, create **one shared event-stepper fixture** that advances the
same state pair the UI consumes:

```text
streamingRun + transcript
```

All transition tests, checkpoint replays, and snapshot stories should derive
from that one fixture path. Avoid separate local helpers that each replay
events slightly differently.

## Stepper Shape

A useful event stepper exposes:

- `step()` to apply the next event;
- `stepThrough(indexOrCheckpoint)` to pause at meaningful boundaries;
- `stepAll()` for full replay;
- `advanceSlot(atMs)` for debounce/stale ownership ticks;
- `snapshot()` returning `streamingRun`, `transcript`, applied events, and
  patches.

The stepper should call the same reducer and transcript patcher the runtime
uses. If the UI projects messages, tests should project from the stepper
snapshot, for example:

```text
messages = composeMessages(snapshot.transcript)
slotState = snapshot.streamingRun
activeAssistantContent = hasAssistantContentForActiveRun(
  snapshot.transcript,
  snapshot.streamingRun.runId,
)
```

## Proof Layers

Use the same stepper at multiple layers:

- **Reducer/state tests:** assert `activeSlot.kind`, `blockId`, patch sequence,
  transcript message count/content, and explicit timed ownership ticks.
- **Component tests:** rerender the imported component from each stepper
  snapshot and assert the visible slot changes or disappears.
- **Storybook snapshots:** load meaningful pause points from the same helper so
  a human opening the story sees the named state immediately.
- **Interaction/browser tests:** optionally drive the stepper or a runtime
  wrapper over time when the claim is animated/progressive browser behavior.

## Minimum Ownership Matrix

Cover these cases before claiming streaming slot ownership is proven:

1. Initial stream start shows transient thinking/status chrome and no assistant
   content.
2. A reasoning/tool/sub-agent block can claim the slot.
3. Fresh current owner holds while other blocks reduce in the background.
4. Closed owner releases.
5. Stale owner releases only after the explicit timed tick/debounce boundary.
6. Next eligible block claims after release/tick.
7. First orchestrator assistant content clears or suppresses transient chrome.
8. Terminal complete/error/cancel leaves no stale visible slot.

## Assistant Message Append Matrix

The same stepper process should prove assistant-message streaming when the UI
claim is "the answer is streaming," not only "the thinking slot changes."
Static checkpoint proof is not enough for this claim; a future regression can
still render duplicate assistant bubbles or remount the message on each delta.

Cover these cases before claiming assistant-message streaming is proven:

1. Before the first orchestrator text event, the transcript/projected messages
   contain the user seed and zero assistant messages.
2. `TEXT_MESSAGE_START` / first `TEXT_MESSAGE_CONTENT` creates exactly one
   assistant message in the transcript and in the projected message list.
3. A later orchestrator delta appends to the same transcript message key and
   the same rendered assistant message, not a second assistant bubble.
4. The transient thinking/status slot is hidden once active-run assistant
   content exists.
5. Non-orchestrator/tool/sub-agent text remains out of the durable assistant
   message.
6. Terminal/refetch state preserves one user/assistant pair without duplicating
   the in-flight run.

When the product uses a framework runtime such as assistant-ui, include at
least one real-runtime/message-zone test for this append behavior. Transcript
unit proof can show the data is correct, but it does not prove the rendered
message adapter updates in place.

## Pruning Guidance

Once the stepper exists, prune weaker tests that assert the same behavior by
hand-building isolated `streamingRun` objects or applying one-off local event
loops. Keep lower-level reducer tests only when they protect a different
invariant, such as malformed deltas, per-node frame isolation, or terminal
slot content preservation.

Do not delete useful checks just because they mention the same slot. Delete or
simplify the ones that:

- bypass transcript state when the UI depends on transcript state;
- manually pass a happy-path handoff prop instead of deriving it;
- use a local replay loop that can drift from the canonical stepper;
- prove only text presence where the contract is ownership transition.

## Storybook Implication

Storybook should not become the transition engine unless the story is explicitly
an interaction/debug story. For docs/snapshot stories, generate deterministic
checkpoint state with the stepper and render the actual component surface
directly. Use a separate interaction story or browser test for step-by-step
animation or live send/cancel behavior.

## Proof Language

Prefer:

```text
The slot ownership sequence is proved by one event-stepper fixture. Reducer
tests assert ownership and timed ticks; component tests rerender from each
stepper snapshot; Storybook snapshots use the same checkpoint state for visual
inspection.
```

Avoid:

```text
We have a reasoning story, a tool story, and a partial-answer story, so
ownership is proven.
```

The second claim proves state coverage, not transition correctness.
