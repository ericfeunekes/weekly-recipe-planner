# Slot Placeholder vs Production Harness

Use this when a Storybook composition renders a child through a slot:
composer slots, toolbar slots, panels, drawers, message zones, headers, shell
regions, or any "parent owns placement, child owns behavior" boundary.

## Rule

A placeholder child proves only that the parent reserves space and positions the
slot. It does **not** prove the child component's:

- actual DOM shape or accessibility semantics;
- measured height, overflow, wrapping, or responsive behavior;
- focus, keyboard, disabled, submit, or cancel behavior;
- provider/runtime requirements;
- production icon/text/control states.

If closeout, review, or the user-facing claim says the composed shipped surface
is ready, add a story that mounts the real child component or a named
production-equivalent harness in that slot. Keep mock/placeholder stories, but
label them as layout-only evidence.

## Recommended Story Split

Use two tiers when both layout and production behavior matter:

- `Default` or `Layout Only`:
  parent composition with a clearly named placeholder child. This proves spacing
  and optional-child absence states only.
- `Default Production <Child>` or `Runtime Harness`:
  same parent composition with the real child component or named harness. This
  is the story eligible for final visual completion evidence.

For future behavior, keep a separate future-state story. Do not pass a no-op
callback into the default story just to make deferred controls look interactive.

## Closeout Checklist

Before saying Storybook proves a composed surface:

1. Identify which owner owns the slot and which owner owns the child behavior.
2. Open the placeholder/layout story only for slot-reservation evidence.
3. Open the production-child/harness story for shipped-surface visual evidence.
4. Inspect the exact iframe and DOM for the real child markers, not just the
   manager index.
5. If `index.json` lists the story but the iframe says the CSF export is
   missing, treat it as stale Storybook cache/process state. Stop stale
   listeners, clear Storybook caches, restart on a fresh port, and re-open the
   iframe before accepting the visual proof.

## Good Wording

```text
The mock-composer story proves layout reservation only. The production-composer
story is the completion evidence for the shipped landing composition.
```

```text
The placeholder toolbar item is intentionally non-interactive in the current
story; the future interactive state is separate and does not prove production
wiring.
```
