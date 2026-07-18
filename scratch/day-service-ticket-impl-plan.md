# Phase C Implementation Plan — Day Cooking Ticket

## Completion contract

The existing Tonight destination becomes a day-scoped cooking ticket. It opens
today by default, and Week can select any dinner date then enter the same Day
surface. The ticket keeps the current authoritative meal status, canonical
instruction completion/timers/notes, ingredients, source, and leftovers; it
does not create copied cooking or Prep state. A selected non-today date is
readable and actionable under the same normal mutation authority.

## State and ownership

- `PlannerApp` owns the selected date as ephemeral presentation navigation
  state, cleared on explicit week selection and clamped at render time when a
  workspace update changes the selected week. Day deterministically defaults
  to today when present or the selected week’s Monday. It is not persisted,
  cached, or sent to Codex.
- `WeekView` emits a date selection through a new narrow callback. Its meal
  card supplies an explicit “Open day” action; recipe and edit retain their
  current overlay behavior.
- `TonightView` receives `selectedDate` and resolves meal/assigned leftover
  from that date. Canonical step and leftover commands retain their existing
  IDs and `weekId`; no domain/API/type contract changes are necessary.

## Presentation scope

Use the new shared primitive vocabulary for the ticket’s clear status/action
hierarchy where it fits, but retain existing timer/step components. Add a
compact date context with a restrained cooking accent, then make the working
instructions primary and ingredients/notes/leftovers secondary. No broad CSS
retirement belongs here.

## Proof and review bar

- Client contract proves Week date selection enters Day and a selected non-today
  entry resolves instead of falling back to today.
- Existing domain/client timer and Prep contracts remain green; a browser test
  opens a non-today Week meal into Day and verifies ticket title/date plus
  accessible containment at phone and desktop.
- Review holds the line on one mutation authority, no Prep copies, explicit
  non-today behavior, and a quiet active-status treatment.

## Cycle record

- Type, lint, and focused client contracts passed, including date clamping and
  explicit week-selector reset.
- Browser proof passed at phone and desktop: a non-today Week action opens Day,
  retains its exact rendered date, title, instructions, ingredients, and
  viewport containment.
- Independent review found hook-order, week-change, copy, and proof gaps; each
  was remediated and the focused rereview closed Phase C.
