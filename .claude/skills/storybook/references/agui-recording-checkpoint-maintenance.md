# AG-UI Recording Checkpoint Maintenance

Use this reference when Storybook or UI tests need persisted streaming
snapshots from recorded agent events.

## Rule

Persisted checkpoint stories must be **recording-derived**, not hand-built.

The durable path is:

1. Pick an SDK AG-UI recording that already represents the product behavior.
2. Choose a meaningful event boundary from that recording.
3. Replay the prefix through the shared event-stepper / reducer / transcript
   patcher.
4. Project durable messages from the replayed transcript.
5. Render the real component or production-equivalent harness from the resulting
   `streamingRun + transcript` state.

Do not manually construct `StreamingRunState`, transcript runs, `ChatMessage[]`,
or story-only message text for a checkpoint that is supposed to prove runtime
streaming behavior.

## Fixture Inventory Before Story Mapping

When the SDK/package that provides recordings changes, do a fresh inventory
before touching story IDs or assertions. Do not assume old recording names,
event counts, or fixture families still exist.

For every exported fixture, record at least:

- fixture id and provenance/source type;
- semantic event count and terminal event/outcome;
- event-family histogram (`RUN_*`, `TEXT_*`, `TOOL_*`, `REASONING_*`,
  `CUSTOM`, keepalive/transport frames);
- whether orchestrator text exists and roughly how much;
- whether any non-orchestrator/sub-agent text exists;
- whether `REASONING_*` exists;
- which tools/custom events are present;
- whether metadata-looking strings such as `confidence`, `HIGH`, JSON
  fragments, source envelopes, or citation markers appear in
  `TEXT_MESSAGE_CONTENT` versus metadata/custom events.

Use that matrix to choose fixtures for each story state. A clean short fixture
may be best for named checkpoint snapshots; a long fixture may be best for
browser/progressive/metadata-leak checks; an error fixture may be best for
`RUN_ERROR`; a tool-only fixture may not prove assistant text rendering at all.

Add or update a fixture inventory/support test when the story matrix depends on
recording capabilities. The test should prove which checkpoint families are
supported and which fail loudly because the fixture set lacks the required
event family. This prevents future SDK upgrades from silently turning a
recording-backed story into synthetic or vacuous evidence.

## Checkpoint Set

For streaming slot and assistant-content handoff, prefer a small named set:

- `stream-start`: optimistic user message exists, no semantic AG-UI block has
  claimed the slot yet.
- `reasoning-active`: reasoning block owns the slot.
- `tool-active-while-reasoning-fresh`: tool events have reduced, but the fresh
  reasoning owner still holds the visible slot.
- `tool-active-after-reasoning-release`: reasoning closed or became stale, then
  the real timed slot tick moved ownership to the tool block.
- `partial-answer-visible`: first orchestrator assistant content exists and
  transient slot chrome is hidden.
- `terminal-complete`: final assistant content remains and stale transient
  chrome is absent.

Add `terminal-error-before-answer`, `sub-agent-active`, or `stale-no-owner`
only when the product has a distinct visible behavior to prove.

Do not force the whole preferred set if the current recordings do not contain
the needed event family. For example, if the available SDK AG-UI recordings
contain tool calls and sub-agent text but no `REASONING_*` events, persist the
tool/sub-agent checkpoints and leave `reasoning-active` /
`tool-active-while-reasoning-fresh` / `tool-active-after-reasoning-release`
unsupported or failing loudly with a clear error. The maintenance action is to
capture or select a recording with real reasoning events, not to fabricate a
reasoning `StreamingRunState` in Storybook.

Apply the same discipline to non-orchestrator/sub-agent text. If the fixture set
has no non-orchestrator `TEXT_MESSAGE_CONTENT`, do not claim sub-agent coverage
from a real recording. Keep synthetic sub-agent tests separate and label them
synthetic; the recording-backed matrix should state that sub-agent checkpoints
are unsupported until a suitable fixture ships.

## Selector Comments

Every named checkpoint selector should carry a short code comment explaining
why that boundary was chosen. Good comments mention user-visible semantics, not
only event numbers.

Examples:

```ts
// First TOOL_CALL_START before any orchestrator text. If the recording changes,
// keep this checkpoint before the first orchestrator TEXT_MESSAGE_CONTENT so it
// continues proving "tool/status chrome visible, no assistant answer invented."
toolActive: firstEvent(EventType.TOOL_CALL_START);

// First orchestrator content after at least one readable sentence has emerged.
// If tokenization changes, adjust the content-length threshold rather than
// hard-coding a stale seq number.
partialAnswerVisible: firstOrchestratorTextAfter(80);
```

Timed handoff comments should name both parts:

```ts
// Replay through the event where reasoning closes, then apply the same
// advanceSlot(atMs) tick the runtime uses. This proves the timed claim policy;
// it is not a hand-built tool-active state.
toolAfterReasoningRelease: {
  prefix: throughReasoningEnd,
  advanceSlotAt: toolLastDeltaAt + 500,
}
```

## Tests

Pair each persisted checkpoint with executable proof:

- selector test: the named boundary resolves and withholds terminal events;
- stepper/replay test: `streamingRun + transcript` has the expected state;
- component or Storybook play assertion: visible chrome/content matches the
  checkpoint contract.

If a recording update breaks one of these, update the selector/comment together
so future agents can see whether the semantic checkpoint moved or the product
behavior changed.

When a named checkpoint is intentionally unsupported for the current recording
set, add a selector test that proves it fails for the expected reason. That
keeps the missing state visible without letting Storybook imply proof that the
recording cannot support.

For package fixture upgrades, include tests that keep raw metadata out of
visible text. A useful pattern is:

- concatenate `TEXT_MESSAGE_CONTENT` per fixture and assert no raw confidence /
  JSON metadata leaks there;
- allow confidence/citation metadata in structured `CUSTOM` events when that is
  the contract;
- verify the rendered story/component does not show raw metadata fragments;
- if raw citation/source markers are intentionally stripped for display, test
  that at the projection/adapter layer while keeping transcript/raw fixture
  content available for runtime proof.

## Pitfalls

- Do not persist snapshots that require the reviewer to click a story-only
  `Send` button to reach the state. That is an interaction/debug story, not a
  checkpoint snapshot.
- Do not "complete" a state matrix by substituting adjacent event families.
  Sub-agent completion text is not reasoning, tool activity is not assistant
  content, and a terminal complete state is not a partial-answer snapshot.
- Do not update only the story IDs after a recording package changes. Also
  update checkpoint selector comments, story descriptions, Playwright text
  expectations, fixture-support docs, and any claims about event counts or
  recording coverage. Stale counts and old fixture names are evidence drift.
- Do not use docs-page canvases as the canonical proof for stateful runtime
  checkpoints; docs pages mount multiple stories and can share state. Use
  isolated `iframe.html?id=<story-id>&viewMode=story` URLs.
- Do not treat "recording-derived" as sufficient visual proof if the story
  bypasses the product primitive. The rendered slot must still compose the same
  loading/thinking/status primitive used by the component story or design
  source.
