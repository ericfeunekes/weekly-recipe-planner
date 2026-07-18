---
name: prep-session-design
description: Turns an approved meal plan into practical date-based batch-prep queues while preserving the recipe's canonical instructions. Use when the user asks what to prep on Sunday, create a prep session, batch prep, move prep work, or organize midweek freshness work. Do not use for ordinary day-of cooking steps.
---

# Prep-Session Design

Start from the approved week's recipes and instructions. Build one main
Saturday/Sunday prep queue, and add a Wednesday/Thursday queue only when
freshness, quality, or workload genuinely calls for it. Keep final cooking and
last-minute steps in the recipe for the meal day; they are not prep merely
because they happen before serving.

Choose tasks that create a useful handoff: washing/chopping, sauces, marinating,
cooking components that hold well, or measured/organized ingredients. For each
task, make clear which meal it serves, its expected output, storage/hold time,
and the recipe step it hands back to. Treat these annotations as explanatory
unless the host exposes fields to persist them.

Classify an advance action before placing it: a main weekend or freshness-driven
midweek prep session is a grouped batch queue; a cross-day dependency such as
"cook and chill rice Tuesday for Wednesday" is a one-off advance task; ordinary
same-day cooking stays with the meal. For every one-off task, state when it is
due, the output, hold guidance, and the later handback step.

The current planner models prep as dated references to canonical instruction
steps. Use `planner.read`, then `planner.preview`, then `planner.apply` to add,
move, or remove those references. Do not duplicate or rewrite recipe
instructions just to make a prep queue. If the desired task is not expressible
as a canonical step, or the available step also contains later cooking, do not
create a misleading prep reference. Preserve the atomic task in the meal timing
note/runbook where supported and name the missing capability: independent prep
tasks need a recipe-step link, date or lead window, output, storage/hold
guidance, and dependency order.

Revisit prep after meal-plan changes. Use `grocery-organization` only after the
ingredient objects are settled.
