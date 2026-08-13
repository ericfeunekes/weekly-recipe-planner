# Story Canvas Harness Discipline

Use this when a Storybook story is meant to prove a component state, runtime
snapshot, or MSW-backed UI and the story needs providers, mock state, controls,
or other harness scaffolding.

## Rule

The canvas that a user visually reviews should make the product surface
unambiguous. Render the actual imported component or composition under test,
wrapped in the minimum providers/runtime/MSW handlers needed to put it in the
state being proved. Do not mix story-only explanatory chrome into the product
surface and then present the result as app UI.

Acceptable harness code:

- decorators that provide theme, router, runtime, query client, i18n, or MSW;
- hidden or visually separated controls used only by a `play` function;
- a named debug story whose title/description says it is a harness;
- a production-equivalent runtime wrapper that derives the same state signals
  the app derives.

Risky harness code:

- fake headers, labels, or status bars inside the same visual frame as the
  component under test;
- story-only "Send" or "Cancel" controls in a snapshot story where the product
  component does not render those controls;
- visible status labels, scenario names, or recording notes that appear inside
  the same canvas as the component and force reviewers to infer which text is
  product UI versus harness UI;
- preambles explaining the recording or scenario in the canvas instead of in
  docs/parameters;
- manually supplied happy-path props when the production seam derives them from
  transcript, cache, runtime, or MSW state.

## Snapshot vs Interaction Stories

Choose the story type deliberately:

- **Snapshot/state story:** preselect the MSW scenario, fixture checkpoint, args,
  or runtime state so the story opens directly in the target UI state. This is
  the right shape for "show me tool-active", "partial answer visible",
  "empty", "error", or "disabled".
- **Interaction story:** include controls only when the interaction path is the
  behavior under proof. Keep controls outside the product component region or
  use Storybook `play` to drive them without making the user visually parse
  debug UI.
- **Debug harness story:** if controls, logs, or scenario labels are useful for
  development, name the story as a harness/debug surface and do not use it as
  final product visual evidence.

Runner-green is not enough to classify the story. A Storybook play function can
click controls, wait for the target state, and pass while the canvas a human
opens still starts in a misleading debug state. If the story is intended as a
snapshot, verify the initial iframe readback without interaction. If the target
state appears only after a click or timer, split it into a deterministic
snapshot story and a separately named interaction/debug story.

## MSW / Runtime State Discipline

When the app state should come from MSW or a runtime wrapper:

1. Import the real component or composition that owns the rendered UI.
2. Use decorators or a named wrapper to provide runtime context.
3. Select the scenario/checkpoint through args, parameters, or MSW handlers.
4. Derive production handoff signals inside the wrapper from the same
   transcript/cache/run state the app uses.
5. Add play assertions against visible product behavior, not story-only labels.
6. Open the iframe yourself and confirm the canvas contains only expected
   product UI plus any clearly separated harness controls.

For named runtime checkpoints, prefer applying the checkpoint before render
through the repo's reducer/adapter/MSW fixture helpers. A runtime wrapper that
auto-sends on mount may be useful for interaction proof, but it is weaker for
snapshot proof because the visible canvas can pause at a pre-checkpoint
`starting` or loading state.

## Good Wording

```text
This story is a product snapshot: it mounts ThreadSection with the MSW
tool-active checkpoint already applied. No extra controls are part of the
claimed surface.
```

```text
This story is a debug harness: the scenario controls are intentionally visible
for development and are not product UI. Use the checkpoint snapshot stories for
visual review.
```
