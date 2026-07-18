# Phase B Implementation Plan — Prep-Free Week Agenda

## Completion contract

Week is a dinner-and-leftovers agenda only: on every breakpoint it shows each
day’s meals, meal status, recipe/edit actions, and a quiet current-day marker.
It contains no Prep indicator, count, pressure summary, shortcut, or navigation.
The standalone Prep view and its canonical dated queues are untouched.

## Smallest change

1. Remove every Week-only Prep presentation: per-day `prepSessions` derivation,
   `meal.prepNote`, Prep button, and mobile Prep pressure control; retain the
   grocery compact control.
2. Remove only the now-dead Week Prep CSS. Do not edit any Prep-view styles or
   domain/API code.
3. Keep Week navigation restricted to the retained grocery compact control;
   remove every Prep-specific navigation path.
4. Extend the client/rendered contract to inspect the `WeekView` source slice:
   it may not contain `prepSessions`, `day-prep-indicator`, `Batch prep`, or
   `onNavigate("prep")`; the standalone Prep boundary remains covered by
   existing Prep tests.

## Proof and review bar

- `npm run typecheck`, focused source contract test, and existing Prep drag/drop
  test prove the component boundary did not change canonical prep behavior.
- Browser Week proof at representative desktop and phone viewports verifies no
  Prep affordance while grocery and meal actions remain usable; axe and
  containment remain clean.
- Review compares only Week presentation and dead Week CSS against this
  contract. Day service ticket, shared-control migration, and Codex rail are
  deliberately out of scope.

## Cycle record

- Source/type proof passed: `npm run typecheck` and
  `tests/client-week-agenda.test.mjs`.
- Browser proof passed: `tests/e2e/week-agenda.spec.ts` verifies phone and
  desktop Week surfaces have no Prep text, indicator, count, or button while
  retaining the applicable dinner/grocery affordance, containment, and axe.
- Independent review found a recipe-level `meal.prepNote` leak, which was
  removed and added to the source/browser contracts. Focused rereview passed.
