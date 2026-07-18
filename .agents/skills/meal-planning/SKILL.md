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

## Apply changes safely

For any planner change, read the current planner version, call
`planner.preview` with the ordered batch, then call `planner.apply` only after a
successful preview. Read back the affected week and report what actually
changed. If the preview reports a conflict or domain rejection, refresh and
revise; do not retry stale operations.

If the planner does not expose a way to create meal slots or select an existing
canonical recipe, provide the complete plan as a reviewable proposal and name
the missing operation. Do not imply that a whole-week plan was applied.

Keep a recipe adjustment attached to the meal/week as a planned trial. Do not
rewrite a canonical recipe merely because the plan includes a variation.

## Boundaries

- Use `recipe-discovery-import` when a needed recipe must be found or brought
  in from a source.
- Use `prep-session-design` after the meal choices are sufficiently settled.
- Use `grocery-organization` to group the ingredient objects already projected
  from the approved meals.
- Use `meal-feedback-closeout` after cooking; a plan is not evidence that an
  adjustment worked.
