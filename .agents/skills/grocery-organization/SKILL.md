---
name: grocery-organization
description: Organizes the planner's recipe-derived ingredient objects into an actionable grocery view using inventory evidence and shopping-source groupings. Use when the user asks for groceries, what to buy, farm-box grouping, shopping organization, or to check off grocery items. Do not use to invent or recalculate a separate grocery list.
---

# Grocery Organization

Recipe ingredient objects are the source of truth. Read the approved week and
organize the grocery projection that comes from those objects; do not rewrite
ingredient names, amounts, or recipe links into a separate hand-maintained
shopping model.

Use explicit household inventory first. You may infer likely inventory from
prior plans, feedback, and usage patterns, but label it as an inference and ask
or leave it unresolved when the uncertainty could change the shop. Group items
by the useful shopping source or trip, such as farm box versus store, while
retaining each item's connection to its recipe ingredient.

Use the planner's `read → preview → apply` lifecycle for execution-state
changes, including grouping existing items by source and checking items off.
Report the groupings and uncertain assumptions, not a fictional calculated
remainder. A new meal or recipe change changes grocery objects upstream; return
to `meal-planning` or `recipe-discovery-import` rather than editing grocery
text to compensate.
