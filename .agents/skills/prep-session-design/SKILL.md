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

The current planner models prep as dated references to canonical instruction
steps. Use `planner.read`, then `planner.preview`, then `planner.apply` to add,
move, or remove those references. Do not duplicate or rewrite recipe
instructions just to make a prep queue. If the desired task is not expressible
as a canonical step, return it as a reviewable proposed task and name the
missing capability rather than fabricating a durable record.

Revisit prep after meal-plan changes. Use `grocery-organization` only after the
ingredient objects are settled.
