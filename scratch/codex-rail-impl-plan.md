# Phase D Implementation Plan — Native Codex Rail Presentation

## Completion contract

The rail and mobile drawer use the shared Tailwind/shadcn presentation layer
without becoming a generic chat system. Native task history, thread selection,
new-thread creation, one composer, streamed items, worker drill-down,
listed-option questions, read-only approvals, interruption, and planner-effect
readback keep their current source/transport ownership and observable behavior.

## Structural boundary

- Presentation work is confined to `codex-thread-rail.tsx`, its CSS module, and
  shared primitive adapters.
- `codex-thread-source.ts`, `codex-thread-api.ts`, native DTO projection, and
  planner-effect callback are preservation surfaces: no semantic rewrites.
- Extract only small visual shell primitives first (rail frame/header, status
  line, transcript item, composer/action row); they receive state/handlers from
  the existing rail rather than own conversation state.

## Incremental sequence

1. Replace rail frame/header/history/composer styling with Tailwind utilities
   and the installed Button, ScrollArea, Textarea, Badge, Separator, and
   Tooltip primitives. Retain native event handlers and aria labels exactly.
2. Migrate item/activity/question/worker visual sections in bounded groups;
   preserve their current conditions and IDs.
3. Delete only CSS selectors made unreachable by each group. No bulk rewrite of
   unread CSS and no chat-library dependency.

## Proof and review bar

- Existing Codex source/rail client contracts keep selected-thread convergence,
  interrupt targeting, worker read-only behavior, questions, and planner apply
  readback intact.
- Browser tests prove history/new/select, send, interrupt state, worker
  drill-down, listed answer, approval display, and desktop/mobile containment.
- Review compares presentation diff against the native contracts and explicitly
  rejects generic-chat affordances or a second source of state.

## Current micro-cycle record

- Shell, composer, task-history, archive/select, and listed-question controls
  now compose the installed Button and Textarea primitives while retaining all
  existing handlers and native predicates.
- An admission-reconciliation race surfaced in the native runtime: a stale
  thread projection could erase a newer `turn/started` binding. The session now
  retains that binding until its exact turn is observed terminal, and the
  deterministic provider projects successful `planner.apply` activity so the
  canvas can recognize the durable mutation.
- Codex planner application now clears the workspace ETag before its required
  re-read, making that read authoritative rather than conditional.
- `npm run typecheck`, `npm run lint`, the rail/source client contracts, and
  all six `tests/e2e/codex-follow-up.spec.ts` scenarios pass. Independent
  review reported no actionable findings.
