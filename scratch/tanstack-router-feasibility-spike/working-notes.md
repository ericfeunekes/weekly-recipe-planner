# Spike Working Notes: TanStack Router direct-path feasibility in Vinext

## Done Checklist

- [x] Create a disposable worktree and record its exact ref.
- [x] Add the minimum code-based router and Week + Day route host only in that worktree.
- [x] Build and prove the direct hard-path/server composition boundary.
- [x] Promote the result into the unknowns register.
- [x] Remove the disposable worktree and unpromoted experimental artifacts.

## Running Notes

### 2026-07-18 — charter opened

- What I did: resolved documentation, code-grounding, proof-harness, and user-intent questions.
- Evidence links: `../tanstack-router-feasibility-unknowns.md`.
- What changed: only Vinext direct-path composition remains empirical.
- New unknowns: none outside the bounded spike.
- Next: run the temporary-worktree composition probe.

### 2026-07-18 — result: positive, with an SSR constraint

- What I did: created detached worktree `/private/tmp/weekly-recipe-tanstack-router-spike` at `89bff99`; installed `@tanstack/react-router`; added code routes for `/` and `/weeks/$weekId/day/$date` plus `app/[...plannerPath]/page.tsx`; built with `npm run build`.
- Evidence links: Vinext build listed dynamic `/:plannerPath+`. A built server initially returned HTTP 500 on the direct route (`MatchesInner ... firstId`) because a browser-created router rendered during SSR. Adding a client-only mounting gate produced HTTP 200 for `/weeks/2026-07-06/day/2026-07-09` and the Vinext route payload identified that direct route.
- What changed: later implementation must activate this browser router client-side or explicitly design TanStack's isomorphic SSR integration. No Node authority, `/api` proxy, front controller, or deployed mount change was required.
- New unknowns: none that block planning. The planned first slice must prove Eric's selected Week + Day interactions in the existing D4 Playwright harness; this spike intentionally did not alter the planner state model to do so.
- Next: proceed to phase planning only when requested.
