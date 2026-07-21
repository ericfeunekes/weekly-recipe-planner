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

The current planner models prep as dated direct references to canonical
instruction steps plus explicitly authored combined batch holders. Use
`planner.read`, then `planner.preview`, then `planner.apply` to add, combine,
edit, complete, expand, move, or remove that work. A combined holder owns two or
more source instruction occurrences and may consolidate quantities only when
the projection is safe; ambiguous or unsupported literals remain visible.
Checking the holder records that the shared batch was prepared while leaving
canonical recipe-step completion unchanged.

Treat a combined holder as the exclusive Prep owner of its source steps. Do not
also add those steps as direct Prep references. If a source instruction or its
ingredient occurrence membership changes, re-read the live source, revise the
holder, and clear its review warning before completing it. Expanding restores
direct references in contribution order. Editing, expanding, removing, or
clearing a completed holder discards recorded fulfillment and must be explicitly
acknowledged in the previewed operation. Never duplicate or rewrite canonical
recipe instructions merely to make a prep queue.

Revisit prep after meal-plan changes. Use `grocery-organization` only after the
ingredient objects are settled.
