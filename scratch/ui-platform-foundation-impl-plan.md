# Phase A Implementation Plan — UI Platform Foundation

## Recovery context

This is Phase A of `scratch/ui-platform-modernization-delivery-map.md`. The
whole-design map and architecture sketch are adjacent at
`scratch/ui-platform-modernization-arch.mmd`. Both independent challenge stances
signed off on the phase map after its user-intent and proof boundaries were
revised.

The worktree has concurrent planner/Prep/domain edits. This phase may change
the package/build configuration, global styling entry point, shared UI source,
and tests; it does not modify planner mutations, Prep behavior,
`planner-client.tsx`, or Codex transport/source authority.

## Completion contract

The application has a working Tailwind + shadcn foundation that builds in the
existing Vinext/Vite pipeline and can be consumed by later visual phases without
creating a second presentation system or a new planner/Codex authority. The
foundation is independently exercised by a read-only primitive fixture, while
untouched planner and native-Codex paths retain their current behavior.

## Architecture and fit

The foundation is presentation-only. It belongs below Week, Day, and the native
rail: semantic tokens and bounded local adapters are reused by those surfaces;
the existing planner authority and native thread source remain unchanged.

See `scratch/ui-platform-modernization-arch.mmd`; the renderer helper was not
available in this checkout, so its Mermaid source is the architecture trigger
surface.

## Implementation detail

1. Add the Vite-native Tailwind integration and initialize shadcn against the
   app’s real alias/global stylesheet without replacing the existing CSS reset
   or legacy surface rules. Map the existing paper/canvas/ink/celery/teal/
   saffron/harissa semantics into the generated theme tokens. Keep the legacy
   tokens available during migration; no bulk CSS deletion.
2. Add only the maintained primitive source needed as the bounded starting
   vocabulary: button, badge, separator, scroll area, tooltip, dialog/sheet,
   dropdown menu, textarea, skeleton, and toast feedback. Add a small local
   adapter layer that owns planner visual variants and composes those primitives;
   it accepts presentation props only and does not own planner or Codex state.
3. Add a non-product, read-only primitive fixture at `/__ui-foundation` that
   renders the foundation’s token and control states without planner mutations
   or Codex transport. It is not linked from planner navigation. Its independent
   browser proof uses representative phone, tablet, and desktop widths rather
   than pretending to be a D4/D7 planner-data fixture.
4. Replace the stale rendered-HTML assertion that forbids Tailwind with a
   positive configuration/build contract. Add pure token/variant tests and
   browser accessibility/focus/viewport evidence for the fixture.
5. Keep an adapter manifest in this plan’s evidence section: later phases must
   consume or extend these adapters before creating custom controls. Retained
   legacy CSS remains authoritative for unmigrated surfaces.

## Simplest viable choice

- **Library first:** Tailwind’s official Vite integration and shadcn-owned
  component source replace utility generation and accessible overlay/control
  mechanics that would otherwise grow in custom CSS and hand-rolled markup.
- **Provider-native:** use the Vite plugin rather than a bespoke PostCSS or
  build wrapper; use the shadcn CLI to generate maintained primitive source.
- **Deliberate non-goals:** no generic chat library, no ChatKit bridge, no
  shadcn preset overwrite, no Tailwind rewrite of the 3,762-line stylesheet,
  and no migration of Week/Day/rail behavior in this phase.

## Proof map

| Framework cell | Proof outcome | Concrete lane |
| --- | --- | --- |
| Merge: client contracts | The exported semantic token/variant mapping and adapter contract are stable and do not expose planner/Codex authority. | New `tests/client-ui-foundation.test.mjs`. |
| Merge: accessibility and fixture capability | The isolated fixture has accessible names/roles, keyboard focus, disabled states, contrast, and representative phone/tablet/desktop containment. | New `tests/e2e/ui-foundation.spec.ts`, using `tests/support/playwright-qa.ts`. |
| Merge: architecture closure | No new browser-local authority or alternate chat/planner path appears. | Existing `tests/architecture/authority-boundaries.test.mjs`; run `codex-client-surface` unchanged as guardrail. |
| Merge: baseline | Tailwind/shadcn configuration compiles in typecheck, production build, unit suite, and lint. | `npm test`; `npm run lint`. |
| RC: dev/start health | Both public origins report health after the build-tool change. | Start `dev` and local `start`; read `/api/health`. |
| QA: representative responsive browser evidence | The foundation fixture preserves visual tokens, focus, and geometry at phone/tablet/desktop widths. | Isolated Playwright/browser screenshots, console/network capture, and axe evidence. |

The adapter manifest is an implementation artifact, not a new TESTING.md proof
cell. It records Button, Badge, Separator, ScrollArea, Tooltip, Dialog/Sheet,
DropdownMenu, Textarea, Skeleton, and toast feedback as the initial vocabulary.

## Failure handling and stop rule

- If Tailwind/shadcn cannot build through the real Vinext/Vite pipeline, do not
  install a second CSS pipeline; capture the observed incompatibility and
  re-open the phase boundary.
- If shadcn initialization would overwrite existing global CSS or an installed
  surface, use its non-overwriting configuration path or stop for a merge
  decision—never overwrite user/concurrent changes.
- If a shared-file conflict makes retaining concurrent Prep/domain work unclear,
  stop and ask rather than overwrite it.
- Fix review blockers within this phase and rerun affected proof; do not start
  Phase B until the proof map and independent implementation review are current.

## Cycle record

- Build: pending
- Targeted proof: pending
- Browser evidence: pending
- Implementation review: pending
- Adapter manifest: pending

## Planning-blocking uncertainty disposition

- **Resolved:** Tailwind `4.3.3` plus `@tailwindcss/vite` `4.3.3`, placed
  before Vinext in the real Vite plugin list and importing theme/utilities
  without preflight, completed the actual Vinext/Vite/Cloudflare production
  build on 2026-07-17. This is the selected build path.
- **Resolved:** the fixture is an unlinked static `/__ui-foundation` route with
  no planner/Codex state; it is proven at representative viewports, not by
  fabricated D4/D7 fixture semantics.
- **Resolved:** the adapter manifest is non-gating plan evidence, not a new
  TESTING.md cell.
