# Substrate Versus Rendering Proof

Use this reference when a task touches a non-visual substrate that eventually
feeds UI state: reducers, stream consumers, transcript/read-model patchers,
cache/refetch handoffs, event parsers, persistence projection, or state-machine
owners.

## Rule

Do not make Storybook or Storybook Playwright the load-bearing proof for the
substrate contract. First prove the producer/owner state through the real owner
path, then use Storybook to prove that a known state renders correctly.

Good split:

- Substrate proof: real or deliberately varied events reduce through the owner
  reducer/patcher/cache/projection path and the final or checkpointed state
  matches expectation.
- Rendering proof: component, Storybook, or browser tests consume that known
  projected state and prove the visible UI.

Bad split:

- A prop-hydrated story proves a renderer can display citations, sources,
  progress, or lifecycle state, and the report claims the stream, transcript,
  cache, or persistence path works.
- A Storybook runtime story hides a missing reducer/cache/refetch assertion and
  becomes the only evidence for final state correctness.
- A fixture has source-looking or status-looking data, but no non-vacuity guard
  proves the event family needed for the claim actually appeared.

## Seeded Checkpoints Are Not Runtime Proof

For streaming/status UI, seeded checkpoint stories and runtime-backed stories
are different proof layers.

Seeded checkpoint stories usually:

- replay a recorded prefix or construct a state snapshot outside the browser;
- mount the component with precomputed messages/state;
- prove browser rendering of that known state.

Runtime-backed stories should:

- drive the local runtime hook or provider path;
- exercise MSW/fake stream, reducer, cache/projection, and visible DOM together;
- prove the stream/runtime handoff reaches the claimed state.

If a Playwright file opens seeded checkpoint iframes, do not describe that lane
as "streaming e2e" or "runtime proof" without qualification. Say "browser
rendering of checkpoint state." Reserve "runtime proof" for stories that
actually drive the runtime owner path.

When a file mixes both story types, report them separately. This avoids the
common false confidence where a seeded Storybook snapshot stays green while
`send -> stream -> cache -> projection -> render` is broken.

## Event-Stream Metadata Pattern

For event streams where metadata arrives separately from visible text or final
content, require proof at these boundaries:

1. **Fixture capability:** assert the recording/fixture actually contains the
   relevant event families, such as source events, occurrence/status events,
   terminal events, or ordering variants. Fail loudly if a fixture update drops
   the family.
2. **Owner routing:** assert the stream owner emits the right state/patch
   operations for each event family. Metadata-looking events should not be
   ignored just because visible text still renders.
3. **State mutation:** assert the patcher/cache/read-model stores metadata in
   the intended state shape, idempotently and without creating a sidecar.
4. **Projection:** assert the read model projects component-ready fields only
   when ownership and completeness are proven. Withhold ambiguous or pending
   metadata rather than showing resolved-looking UI.
5. **Terminal replacement:** if the normal lifecycle refetches or replaces
   local active state at completion, assert post-refetch projection still
   matches stable fields from the streamed path. A green streaming-local proof
   is incomplete if terminal truth drops the metadata.
6. **Rendering:** after the above, use Storybook/Playwright/component tests to
   prove the projected state renders, links, highlights, or lays out correctly.

## Reporting Language

Use calibrated proof wording:

- "Reducer/cache/projection proof shows the final transcript state matches the
  expected stream metadata."
- "Storybook Playwright proves the projected citation/source state renders in a
  browser."
- "This is rendering smoke only; substrate correctness is covered by the
  reducer/runtime/cache tests named above."

Avoid:

- "Storybook proves the stream contract" unless the story truly drives the same
  stream owner path and also asserts the owner state.
- "E2E proof" for a local Storybook or prop-hydrated story.
- "Sources/citations work" when only a component rendered already-assembled
  props.
- "Runtime proof" for checkpoint stories that use seeded state or mocked
  framework primitives.
