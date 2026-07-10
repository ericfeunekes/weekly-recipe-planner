# Testing And QA Contract

This document is the proof authority for the family-readiness implementation.
The detailed behavior and proof matrix live in
`docs/family-readiness-remediation-plan.md`; this file assigns those claims to
repeatable gates and repository paths.

## Merge Gate

Every implementation merge must keep these deterministic cells green:

| Cell | Required boundary | Owning paths |
|---|---|---|
| Domain contracts | Pure canonical state transitions and invariants | `tests/domain-*.test.mjs` |
| Store transactions | Real temporary SQLite file, OCC, receipts, rollback, restart | `tests/store-*.test.mjs`, `tests/planner-service-*.test.mjs` |
| HTTP contracts | Real loopback application routes with fake Codex transport | `tests/http-*.test.mjs`, `tests/runtime-*.test.mjs` |
| Chat lifecycle | Durable transitions, bounded prompts, late-result fencing, atomic terminal command | `tests/chat-service-*.test.mjs`, `tests/codex-adapter-*.test.mjs` |
| Client contracts | Readback ordering, offline/conflict behavior, draft retention | `tests/client-*.test.mjs` |
| Architecture closure | No browser/shared-localStorage authority or alternate mutation path | `tests/architecture/**` |
| Baseline | Typecheck, production web build, lint, existing unit tests | `npm test`, `npm run lint` |

Owner lanes edit their own unit/contract test files. The proof lane owns only
shared support and cross-boundary paths: `tests/support/**`,
`tests/integration/**`, `tests/e2e/**`, and `tests/architecture/**`.

## Release-Candidate Gate

Before the controlled dinner pilot or broad family-ready claim:

- From the repository root, run
  `mise exec -C /private/tmp node@22.15.0 -- npm --prefix "$PWD" test` against
  a real file database. Using the neutral working directory makes this proof
  independent of per-worktree mise trust state. The current Cloudflare Vite
  plugin imports `node:module.registerHooks`, which is unavailable in Node
  22.13.0; 22.15.0 is therefore the proven floor.
- Start both `dev` and local `start`; call `/api/health` through each public web
  origin.
- Run two independent Playwright browser contexts through conflict recovery,
  restart, offline/read-only, the exact dinner journey, mobile dialog behavior,
  and representative navigation.
- Verify export readback, strict v2 bootstrap, restart interruption, and no
  production shared writes in React/localStorage.

## Exploratory QA Gate

After deterministic proof is current-state:

- Exercise representative iPhone, iPad, and desktop viewports with console and
  network capture.
- Repeat the two-client dinner workflow against a disposable real database.
- Run the live ChatGPT-login smoke separately from deterministic tests and
  record authentication/transport failures as environment evidence rather than
  weakening the fake-adapter gate.
- Do not claim Tailscale reachability, service supervision, or the deferred
  expanded Codex runtime from this evidence.

Exploratory evidence is written to the gitignored directory
`outputs/qa/<run-id>/`. Every run contains `summary.md` with the commit SHA,
runtime commands, database fixture, viewports, outcomes, failures, and links to
its captured screenshots, console log, and network log. Live ChatGPT smoke
results use a separate subsection and never store credentials or raw auth
material. The implementation must add the owned entrypoint
`scripts/smoke-live-chat.mjs`, exposed as `npm run smoke:live-chat`; it must
always target a disposable data directory and remain outside `npm test`.
Closeout names the exact run directory used for the final claim.
