# Weekly Recipe Planner

Use `make dev-start` from a worktree to run that worktree through Portless.
It receives a unique local URL and refreshes the single shared development
Codex home with independent copies resolved from the installed production
instruction and skill links. `make dev-status` and `make dev-stop` manage that
worktree runtime.

There are two persistent Codex homes: the shared development home and the
production home. Worktree code is tested through the former, while its agent
instructions and skills start as production-derived copies. Deployment
promotes the approved release bundle into production without replacing its
retained authentication, native runtime history, or managed links.

## Agent instruction source boundary

This repository-root `AGENTS.md` is developer and operator guidance only. It is
not an embedded-planner instruction source and must never be copied, linked, or
staged into the installed application or production `CODEX_HOME`. Root
`AGENTS.override.md` and `CLAUDE.md` files have the same non-release status.

The released embedded-planner instructions live only in
`deployment/codex/AGENTS.md`; released planner skills live in
`.agents/skills/`. Production exposes those two installed-app targets through
the managed `CODEX_HOME/AGENTS.md` and `CODEX_HOME/.agents/skills` symlinks.
Development and QA copy their resolved production contents rather than linking
back to a mutable worktree. Drafts may be tested locally, but moving an update
to production requires the explicit manual promotion path; never update through
or replace either production link.

`scripts/support/deployment-staging-filter.mjs` mechanically excludes the root
instruction files while retaining `deployment/codex/AGENTS.md` and
`.agents/skills/`. Preserve that distinction and its
`tests/deployment-staging-filter.test.mjs` proof whenever release staging or
agent-source paths change.

Do not run production logic from a mutable checkout. `make promote` is the only
candidate-producing production command; `make recover` is recovery-only. Both
obtain their implementation from a disposable detached `refs/heads/main`
worktree. Recovery keeps a ready selected app or restores the immediately
previous app and proves readiness; it cannot stage or select new candidate
bytes. Application deployment never migrates, copies, restores, or prunes the
household SQLite authority. The remaining activation, recovery, and mounted
proof obligations are defined in `docs/functional-spine.md`, `docs/TESTING.md`,
and `docs/QA.md`.

## UI system

Tailwind is the default styling surface. When a task touches a stylesheet or
CSS Module, migrate the affected component or surface to Tailwind in that same
change; do not add component layout or variant rules to CSS. Keep global CSS
only for tokens, reset/base rules, keyframes, and unavoidable browser or
third-party selectors. If an exception is necessary, name why in the hand-off.

Before styling a control, inspect `components/ui`, `components/planner-ui`, and
the semantic tokens in `app/globals.css`. Reuse the existing primitive,
variant, and token where its meaning fits. A shared visual change requires
checking every consumer and analogous control; add a primitive or token only
when no existing semantic role fits, and state that role in the change.

Treat the TanStack Router migration as an incremental component-boundary
migration. When a planner surface is touched, extract the reusable view or
control from `app/planner-client.tsx` when the same concept has multiple
consumers or will become independently routed; route files compose those shared
components rather than copying their markup. Keep planner queries, canonical
state, and mutation authority outside route-specific presentation components,
keep the extraction bounded to the touched surface, and verify every existing
consumer after the move.

## Food workflow skills

Release-owned planner skills are in `.agents/skills/` and ship with every
worktree and production release. Use the smallest matching skill:

- `meal-planning` — choose and revise the week's meals.
- `recipe-discovery-import` — find and source/import a recipe.
- `recipe-adjustments` — create a deliberate recipe trial without rewriting it.
- `prep-session-design` — organize weekend or midweek prep queues.
- `grocery-organization` — group recipe-derived grocery objects for shopping.
- `meal-feedback` — interview meal outcomes and maintain taste evidence.

All food workflow skills follow `.agents/skills/food-skill-runtime-contract.md`: planner
mutations are `read → preview → apply`; source facts, inventory inference,
planned trials, and cooked evidence stay distinct. The skills name missing
app-server operations rather than working around them with direct storage
access.

Food planning writes to the persistent production planner only. Portless
worktrees validate code and the release-owned Codex bundle; they do not carry a
household plan. A completed food-planning mutation has production readback and
a rendered-week check for the meal, ingredients, instructions, source/plan
notes, and timing.

Taste profiles are semantic memory: the food vault's shared
`taste-profiles/TASTE_PROFILE.md` and person-specific
`taste-profiles/<person>/TASTE_PROFILE.md` retain only current high-level
preferences, constraints, and planning concepts. Dated meal evidence and
concrete examples stay in the feedback ledger and person/family evidence pages;
promote a fact only after clear confirmation or repeated, specific evidence.
