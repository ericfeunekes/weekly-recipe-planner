# Weekly Recipe Planner

Use `make dev-start` from a worktree to run that worktree through Portless.
It receives a unique local URL and refreshes the single shared development
Codex home from the worktree's `deployment/codex` bundle. `make dev-status`
and `make dev-stop` manage that worktree runtime.

There are two persistent Codex homes: the shared development home and the
production home. Worktree code, instructions, and skills are tested through
the former; deployment promotes the approved release bundle into the latter
without replacing its retained authentication or native runtime history.

Do not run production from a mutable checkout. For an initialized installation,
`make deploy` stops the service, stages the current source against production
data, activates it, and restarts the service. Use the lower-level
`deploy-stage`, `deploy-activate`, `deploy-recover`, and `deploy-rollback`
targets only for first install, intervention, or recovery. On a first install
only, `deploy-stage` also accepts `AGENT_SOURCE=/absolute/authenticated-agent-home`
for the one-time authentication bootstrap. Subsequent deployments retain
production auth and native history while refreshing the release-owned bundle.

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

## Food workflow skills

Release-owned planner skills are in `.agents/skills/` and ship with every
worktree and production release. Use the smallest matching skill:

- `meal-planning` — choose and revise the week's meals.
- `recipe-discovery-import` — find and source/import a recipe.
- `recipe-adjustments` — create a deliberate recipe trial without rewriting it.
- `prep-session-design` — organize weekend or midweek prep queues.
- `grocery-organization` — group recipe-derived grocery objects for shopping.
- `meal-feedback-closeout` — record cooked outcomes and promotion evidence.

All six follow `.agents/skills/food-skill-runtime-contract.md`: planner
mutations are `read → preview → apply`; source facts, inventory inference,
planned trials, and cooked evidence stay distinct. The skills name missing
app-server operations rather than working around them with direct storage
access.
