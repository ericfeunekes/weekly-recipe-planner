---
name: meal-planning
description: Plans a household meal week or revises planned meal slots using recipes, current preferences, ingredient reuse, seasonal fit, inventory evidence, and household logistics. Use when the user asks to plan dinners, fill a week, move meals, choose between meal ideas, or revise a meal plan. Do not use for importing a new source recipe, creating prep queues, organizing groceries, or recording cooked outcomes; use the corresponding food skill.
---

# Meal Planning

Plan from canonical planner state, not recollection. Start with `planner.read`
for the relevant week and distinguish source facts, inventory inference,
planned trials, and accepted taste preferences in the explanation.

## Choose the collaboration shape

- When recipe fit, availability, and constraints are clear, propose a complete
  editable week.
- When they are not clear, offer 2–4 high-level directions before filling
  individual slots. Continue incrementally after the household chooses one.
- Favor ingredient reuse and seasonal fit when they make the week easier or
  better. They are positive signals, never vetoes.

Keep the plan practical: normally use no more than two primary proteins, vary
vegetables, leave room for leftovers/flexibility, and account for the actual
week's time and shopping cadence. State an inventory assumption as an
assumption, not as a fact.

## Make the week executable

Household food planning always targets the persistent production planner. A
Portless worktree is for validating code and the released skill bundle; it is
not a second planning surface. Read the production week before changing it.

Do not treat a set of recipe slots as a complete plan. For every selected meal,
make the eating date, long-cook start window, advance work, cross-day
dependency, freshness-sensitive handoff, planned leftovers, and day-of finish
clear. Classify advance work as a formal weekend or midweek prep session, a
one-off advance task for a later meal, or a meal-day action that remains with
that meal.

Compose the dinner that will actually be eaten. Inspect source serving
suggestions, planned sides, garnishes, sauces, referenced subrecipes, and
substitutions. Mark each as included, intentionally excluded, or awaiting a
household decision. Included non-source components are named plan additions,
with their reason and serving assumption; they never become source-recipe
ingredients.

Before applying, project every included component into usable planner
ingredient rows and every source instruction into a separately renderable
planner step when the source provides that boundary. Keep one consolidated
ingredient list for the composed meal: do not repeat an outer-recipe placeholder
and its expanded component ingredients.

## Apply changes safely

For any planner change, read the current planner version, call
`planner.preview` with the ordered batch, then call `planner.apply` only after a
successful preview. Read back the affected production week and report what
actually changed. Then open the rendered selected week and affected recipe
panel: verify meal titles, structured ingredient rows, separately visible
instructions, source and plan-component notes, and timing. An accepted command
is persistence evidence, not proof that the household can see a usable plan.
If the preview reports a conflict or domain rejection, refresh and revise; do
not retry stale operations.

If the planner does not expose a way to create meal slots or select an existing
canonical recipe, provide the complete plan as a reviewable proposal and name
the missing operation. Do not imply that a whole-week plan was applied.

Keep a recipe adjustment attached to the meal/week as a planned trial. Do not
rewrite a canonical recipe merely because the plan includes a variation.
Do not alter a sourced recipe while planning; route any proposed change through
`recipe-adjustments` and obtain the user's approval there.

## Boundaries

- Use `recipe-discovery-import` when a needed recipe must be found or brought
  in from a source.
- Use `prep-session-design` after the meal choices are sufficiently settled.
- Use `grocery-organization` to group the ingredient objects already projected
  from the approved meals.
- Use `meal-feedback` after cooking or a spontaneous meal; a plan is not
  evidence that an adjustment worked.
