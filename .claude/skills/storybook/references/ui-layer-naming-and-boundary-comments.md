# UI Layer Naming And Boundary Comments

Use this when Storybook review exposes confusing component names, stale
architecture levels, or a gap between the visible story surface and the actual
product layers.

## When To Rename

Rename active code when the current names encode migration history instead of
ownership. Examples:

- `*Adapter` when the component is now the real product layer, not temporary
  glue.
- `*New`, `*V2`, or `*SectionNew` when the old layer is no longer the active
  alternative.
- `*Container` compatibility exports that make callers or stories bypass the
  current owner.

Do not solve this only by moving Storybook titles. If code, tests, docs, and
imports still use the old names, future work will keep reasoning from the old
architecture.

## Boundary Comments

Add concise module-level comments to every renamed layer that say:

- what this layer owns;
- what the adjacent parent owns;
- what the adjacent child owns;
- what must not be added here.

Keep the comments operational, not historical. Good comments describe current
ownership:

```text
MessageZone owns the preparing overlay and hands runtime state to Thread.
OuterShell owns frame layout and composer docking.
```

Avoid comments that preserve migration ambiguity:

```text
Temporary compatibility adapter for the current message pane.
```

## Storybook Alignment

After a rename, verify the served Storybook index and sidebar:

- composed surfaces should be under composition-level namespaces;
- runtime/provider/MSW/cache flows should remain under runtime-level namespaces;
- retired compatibility stories should be deleted or moved under retired/debug;
- play assertions and browser specs should use the new story ids and component
  names.

If the Storybook docs page still shows old story groups or old controls, verify
server identity and restart the correct worktree before assuming the source
change failed.

## Proof Updates

Update the proof surface with the rename:

- direct component tests;
- real-runtime tests;
- Storybook/Vitest include lists;
- Storybook Playwright specs;
- active architecture/testing docs.

Historical planning/debt docs may keep old names when they describe old debt,
but current-facing docs, runbooks, test descriptions, and comments should not.
