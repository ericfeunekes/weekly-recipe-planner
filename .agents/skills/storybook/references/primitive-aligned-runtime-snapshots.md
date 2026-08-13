# Primitive-Aligned Runtime Snapshots

Use this reference when a Storybook story combines runtime/MSW/checkpoint state
with a visual component that already has primitive or composition stories.

## Lesson

A runtime snapshot can be semantically correct and visually wrong. Passing the
right MSW state, checkpoint, or runtime adapter only proves state ownership; it
does not prove the rendered element follows the design system. If the snapshot
uses custom status bars, borders, labels, layout wrappers, or story-only chrome
instead of the established primitive, the user will see a false app surface.

## What To Check

For every visible runtime-owned slot:

- Identify the primitive or composition story that owns the visual language.
- Compare the selected runtime element against that primitive/composition, not
  only against state assertions.
- Inspect the exact iframe or user-visible docs canvas after tests pass.
- If a browser comment targets one element, treat that element as the review
  unit and trace whether it is rendered by the expected imported primitive.
- Fix the product component when the component itself uses a custom wrapper; fix
  the story when only the story harness bypasses the primitive.

## Common Failure Shape

```text
Recording/checkpoint state is correct.
Storybook play assertions pass.
The docs page shows the selected status/loading row.
But the row is a custom full-width bordered div instead of the existing
thinking/status primitive used by the component stories and design reference.
```

This is not a QA wording issue. It is a component/story composition issue.

## Remediation Pattern

1. Open the primitive story and the runtime snapshot side by side.
2. Move the runtime slot into the same stack/layout as real messages or child
   content when that is how production should render it.
3. Render the existing primitive for active tool/reasoning/loading/status text
   instead of plain text in custom chrome.
4. Keep the runtime/checkpoint state deterministic so the snapshot opens
   directly in the target state.
5. Re-run executable Storybook tests and visually inspect the exact iframe.

## Proof Language

Prefer:

```text
The runtime checkpoint story renders the imported message surface and the
status row uses the existing assistant thinking primitive. Browser readback
shows the user message followed by the primitive status row.
```

Avoid:

```text
The checkpoint story passes because the status text appears.
```

The second claim ignores visual ownership and can miss the exact mismatch a
designer or reviewer will notice.
