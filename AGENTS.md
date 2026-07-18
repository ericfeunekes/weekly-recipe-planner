# Weekly Recipe Planner

Use `make dev-start` from a worktree to run that worktree through Portless.
It receives a unique local URL and refreshes the single shared development
Codex home from the worktree's `deployment/codex` bundle. `make dev-status`
and `make dev-stop` manage that worktree runtime.

There are two persistent Codex homes: the shared development home and the
production home. Worktree code, instructions, and skills are tested through
the former; deployment promotes the approved release bundle into the latter
without replacing its retained authentication or native runtime history.

Do not run production from a mutable checkout. `make promote` is the only
operator-facing production release command: it requires committed `main`,
creates a disposable worktree for that exact revision, and invokes the internal
`make deploy` primitive there. `make deploy` is not a recovery interface and
must not be run directly from a development checkout. The remaining
non-destructive activation, recovery, and production-mounted proof obligations
are defined in `docs/functional-spine.md`, `docs/TESTING.md`, and `docs/QA.md`.

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
