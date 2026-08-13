# Recording-Backed Partial Stream States

Use this reference when a Storybook story needs to show an in-flight assistant,
agent, or streaming markdown state and the repo has real event recordings,
trace fixtures, or reducer inputs available.

## Principle

Do not hand-invent partial streaming states when a realistic recording can be
replayed to the same point. A plausible partial state should come from the
runtime reducer, message adapter, or MSW scenario shape that production uses,
then be rendered through the component/story harness.

This matters because partial markdown and agent streams often behave
differently from final transcript content:

- A paragraph may be complete while the next table is missing a cell.
- A list item may be open but not yet followed by its nested child.
- A tool/reasoning block may be active while the durable assistant message is
  still incomplete.
- Source metadata may lag behind the prose that cites it.

## Workflow

1. Find the smallest real recording or event fixture that exercises the UI
   state of interest.
2. Choose named checkpoints that map to user-visible states, such as
   `after-first-paragraph`, `partial-table-row-missing-cell`,
   `source-arrived`, or
   `final-answer`.
3. Replay only the event prefix up to that checkpoint through the same reducer
   or adapter used by the app where practical.
4. Export the resulting client state or MSW scenario fixture, not a hand-written
   approximation.
5. Combine the partial stream state with realistic transcript/session context
   so the story reflects surrounding UI ownership.
6. Render that fixture through the same runtime/component seam the product uses
   whenever the story claims runtime proof. If the story extracts only the
   partial text and feeds it into prop-based primitives, label it as renderer or
   layout evidence; it does not prove runtime adapter behavior, source/citation
   metadata propagation, action visibility, or stream status ownership.
7. If a parent component suppresses or changes chrome based on a runtime-derived
   handoff signal, make the Storybook runtime wrapper derive the same signal
   from the same transcript/run/cache state. Do not manually pass the happy-path
   prop in a story and call it production-equivalent runtime proof.
8. For snapshot stories, make the checkpoint state load directly from the
   selected MSW/runtime fixture. Do not require the reviewer to click story-only
   controls to reach a named snapshot unless the click path itself is under
   review. If controls are useful for debugging, put them in a separately named
   harness story or keep them clearly outside the product surface.
9. Render that fixture in Storybook and verify the DOM shape. For markdown,
   inspect whether tables, lists, code blocks, and literal dollar signs behave
   correctly while incomplete.
10. Add executable Storybook play assertions for proof-critical snapshots, and
   include the story file in the repo's Storybook test scope. A runtime story
   that is never loaded by `test:storybook`, Playwright, or the repo's browser
   runner is manual evidence only.

## Snapshot Shape Choices

There are two credible shapes for recording-backed stream stories. Pick one
deliberately and name the story accordingly:

- **Deterministic checkpoint snapshot:** replay the recording prefix before the
  story renders, seed the real runtime/component seam with the derived state,
  and open directly into the named state. This is the preferred shape for
  `tool-active`, `partial-answer-visible`, terminal, empty, and error
  snapshots. It avoids transient races where the reviewer catches a generic
  `starting` state instead of the checkpoint.
- **Runtime interaction story:** mount the production-equivalent runtime and
  drive a send/cancel/stream sequence through `play` or visible controls. This
  proves the interaction path, not a static checkpoint. If controls, status
  labels, or trace/debug panes are visible, label the story as an interaction
  or debug harness and do not hand it to the user as the product snapshot.

Avoid the hybrid anti-pattern: a story named after a snapshot, but requiring a
story-only "Send" button to eventually reach the state. A test runner can wait
through that transition and pass while a human opening the story sees the wrong
content. If the user asks for "the tool-active story" or "the partial-answer
story", the iframe should already be in that state.

## Story Naming

Name the story after the checkpoint, not the implementation detail:

- `StreamingFirstParagraph`
- `StreamingPartialTableRowMissingCell`
- `StreamingSourceMetadataPending`
- `StreamingFinalAnswer`

If a state is synthetic because no recording exists, label it explicitly as
synthetic and do not call it runtime proof.

For paired stream-start handoff states, keep pre-answer and partial-answer
exports distinct. Do not name a tool-active/no-assistant-content checkpoint
`PartialAnswerVisible`, and do not combine mutually exclusive lifecycle states
in one story. The story name, checkpoint argument, note, and play assertion
should all describe the same state.

## Snapshot Assertions

Use assertions that match the snapshot's contract:

- Pre-answer tool/thinking checkpoint: runtime status has reached the streaming
  phase, transient status/tool/thinking chrome is visible, and assistant answer
  content that belongs after orchestrator text is absent.
- Partial-answer checkpoint: assistant content from orchestrator text is
  visible, transient thinking/tool chrome is absent, and the handoff signal was
  derived through the runtime wrapper rather than supplied manually.
- Terminal checkpoint: stale transient chrome is absent while final assistant
  content remains visible, if terminal persistence is part of the claim.

Wait for runtime transitions with the story test runner's `waitFor` or
equivalent. Do not assert status immediately after clicking send if the runtime
legitimately passes through a short `starting` state before `streaming`.

For deterministic checkpoint snapshots, prefer immediate assertions over
interaction waits. If an assertion needs to wait for the story to become its
named state, that is a sign the story is actually an interaction harness or the
fixture is not being applied before render.

## MSW Fixture Shape

When the repo uses MSW for Storybook, prefer a fixture helper with inputs like:

```ts
buildStreamingScenarioFromRecording({
  recording: t2ReviewRecording,
  stopAfter: "partial-table-row",
  transcript: completedPriorTurn,
});
```

The helper should return the same data shape the Storybook runtime wrapper or
MSW handler already consumes. Avoid story-local fake stores that bypass the
actual reducer, cache shape, or generated SDK contract.

## Delayed Replay For Local QA

When the live provider or downstream agent runtime is unavailable, a delayed
MSW replay can keep local UI QA moving without weakening the source of truth.
Use the same AG-UI recording and the same route/runtime handler that normal
MSW replay uses, but stream frames with a small delay so the local app behaves
like a live stream.

This is appropriate for proving browser-visible progressive behavior such as
slot handoff, markdown growth, scroll behavior, and component rendering while
the backend is down. It is **not** live-provider proof and should be reported
as "local app + MSW delayed replay from recording."

Guardrails:

- Add a distinct scenario name such as `replay-delayed`; do not slow every
  replay by default.
- Keep fast deterministic replay for unit/integration tests that do not need
  time.
- Use a replay clock that is long enough for humans to inspect but short enough
  not to turn the scenario into a flaky long-running test. For long recordings,
  avoid a flat per-event human-visible delay across the whole stream; it can
  make a 1k-event recording look hung. Prefer staged timing: slow the initial
  slot/tool/reasoning ownership window, then accelerate token-heavy or
  post-proof events so the story reaches terminal handoff promptly.
- Inspect event boundaries before selecting the staged timing: total event
  count, first visible slot event, first durable assistant-content event, and
  terminal event. Document those boundaries in comments near the replay helper
  so future recording updates can retune deliberately.
- Add at least one integration assertion that the delayed scenario does not
  flush assistant content immediately.
- Add a terminal assertion when the story claims handoff: after the accelerated
  phase, transient slot chrome is gone and durable assistant content is visible.
- If the live provider later recovers, rerun the live lane separately; a
  delayed replay never proves deployed runtime health.

## Metadata-Looking Fragments In Recordings

When a recording-backed story or running-app replay shows raw fragments such as
`{"confidence":"HIGH"}`, source/provenance JSON, or tool payload snippets, do a
raw-event classification pass before changing the renderer:

1. Search the recording for the visible fragment and print the surrounding
   events with event index, `type`, `seq`, `nodeId`, `messageId`, and `delta`.
2. Reconstruct only the relevant message stream by concatenating
   `TEXT_MESSAGE_CONTENT` deltas for each `messageId` and owner node.
3. Classify the fragment:
   - **Orchestrator/durable text:** the recording or upstream provider emitted
     it as assistant message content. The UI is faithfully rendering the stream;
     fix by replacing/repairing the recording or addressing the provider
     contract, not by hiding arbitrary JSON in the markdown component.
   - **Non-orchestrator/tool/subagent text:** it should remain transient and
     must not become durable assistant content. Add reducer/projection
     assertions that non-orchestrator deltas do not reach transcript/message
     rendering.
   - **Non-text metadata appended by replay code:** the replay/mock adapter is
     leaking metadata into text. Fix the replay projection and add a fixture
     regression at that adapter boundary.
4. Compare app-route replay and Storybook/runtime snapshot behavior. A partial
   checkpoint may stop before the bad tail; terminal running-app replay may be
   the only surface that exposes the leak.

Avoid broad text sanitizers as the first fix. They can mask real model output,
hide provider contract drift, or make the replay differ from the stream it is
supposed to prove.

When an upgraded fixture set moves the same concept from text deltas into
structured custom metadata, update the test/story contract instead of
preserving the old workaround. A good post-upgrade proof shape is:

- inventory every exported fixture and prove metadata-looking strings are absent
  from `TEXT_MESSAGE_CONTENT`;
- allow those values in structured metadata events such as citation occurrence
  payloads;
- add projection/rendering assertions that raw metadata and raw citation/source
  markers do not appear in the visible assistant prose;
- keep transcript/raw-event assertions separate so display cleanup does not
  rewrite the evidence of what the stream actually carried.

## Proof Bar

A recording-backed partial story is only credible when the evidence says:

- which recording/fixture was used
- which checkpoint/event boundary was used
- which reducer/adapter produced the state
- which Storybook story rendered it
- whether the story used the production runtime seam or a weaker prop-hydrated
  fixture seam
- whether the story file was wired into executable Storybook/browser tests or
  remained manual-only
- what remains synthetic or unproved
- whether visible story canvas chrome belongs to the actual component surface
  or is only a harness/debug aid
- whether a human opening the exact iframe sees the named state without
  interacting, or whether the story is explicitly an interaction/debug harness
