# Phase E Implementation Plan — Shared Controls and CSS Retirement

## Completion contract

Planner controls that share the same action vocabulary use the installed
shadcn Button primitive through a small local adapter. The remaining global CSS
contains layout and domain-specific presentation only; superseded generic
button rules are removed only after every caller has migrated with responsive
browser proof.

## Incremental sequence

1. Expand the adapter vocabulary for primary, secondary, quiet, destructive,
   and icon actions, including the existing 44px operational target.
2. Migrate shell and Day actions first, then bounded Prep, Groceries, Closeout,
   and drawer groups. Keep domain-specific classes only for layout.
3. After each group, delete only its unreachable generic button selector or
   modifier and rerun that view's focused browser contract.
4. Finish with a whole-app lint/typecheck, rendered HTML, responsive planner
   browser suite, and an independent CSS/interaction review.

## Guardrails

- Do not convert buttons that encode native Codex state here; Phase D owns that
  surface.
- Preserve all accessible names, `aria-pressed`, disabled predicates, drag
  affordances, and focus-return references.
- No bulk rewrite of the remaining global CSS. A selector may disappear only
  after search proves it unreachable.

## Current micro-cycle record

- The adapter now covers primary, secondary, quiet, and destructive actions at
  the existing 44px operating target.
- Bootstrap, offline/recovery, and the Day ticket's state-changing actions use
  the adapter; domain-specific layout classes and all Prep/Grocery controls are
  intentionally untouched in this first group.
- `npm run typecheck`, `npm run lint`, Day client tests, and phone/desktop Day
  browser proof pass. The next group is the shared drawer and collection
  controls, followed by selector-by-selector CSS deletion.
- The mobile authority test exposed that browser offline state depended on a
  later poll. It now becomes read-only immediately and remains so until the
  user explicitly presses Reconnect. Its post-reload step explicitly chooses
  the scheduled Prep date, preserving Prep's established week-start default
  while proving the real operational row.
- All planner callers now use `PlannerActionButton` or `PlannerIconButton`;
  the legacy generic `primary-button`, `secondary-button`, and `icon-button`
  rules have been removed. Context-specific sizing rules now target the local
  adapter hooks only.
- Browser-offline state is read-only immediately, performs one observable
  failed workspace read, and remains sticky until the user presses Reconnect.
  The mobile/iPad authority scenario passes this recovery flow.
- `npm run typecheck`, `npm run lint`, Prep drag/drop, mobile/iPad authority,
  and all applicable responsive UI-contract scenarios pass after retirement.
