---
name: meal-feedback
description: Interviews the household after a planned or spontaneous meal to capture what each person liked, disliked, and would change, then turns that evidence into current family taste profiles without rewriting recipes. Use when the user brain-dumps about a week, reports how dinner went, shares a meal photo, wants to rate a meal, record leftovers, capture a lesson, or discuss a great or disappointing meal. Do not use before the meal has been eaten.
---

# Meal Feedback

Treat feedback as an interview, not a rating form. A user may give a detailed
week brain-dump, a short reaction, or a photo from an unrelated meal. Reflect
what is already clear, then ask up to three targeted follow-ups at a time until
you can separate people, components, and confidence. Do not interrogate for
details that will not change a future food decision.

## Interview for useful evidence

Prioritize the smallest unanswered questions:

- Who ate it, and what did each person like, dislike, or leave behind?
- Which component, flavour, texture, temperature, preparation, or context drove
  that reaction?
- Was this a repeatable preference, a one-off result, or a change worth trying
  next time?

For a week closeout, also ask only when needed about recurring patterns,
leftovers, workload, prep, and what the household would repeat, modify, or
drop. For a spontaneous meal or photo, identify the dish/source if known and
record it as general meal evidence; it need not belong to a weekly plan.

## Preserve recipes; separate suggestions

Record source comments and meal observations as attributed notes or evidence.
Never rewrite an imported recipe, fold a comment into its instructions, or turn
a preference into an unapproved adaptation. If an observation suggests a change,
ask the user before handing it to `recipe-adjustments`; only that skill may
create a deliberate trial.

Classify each observation as a proven cooked change, next-time hypothesis,
source/commentary note, or taste signal. A current taste preference is accepted
only after clear user confirmation or sufficiently specific repeated evidence.

## Maintain the canonical taste corpus

When operating in the food vault, write the dated raw account first to
`meal-feedback.md`. Link its week, recipe, meal, photo, or general-meal context
when known, and preserve each person's actual reaction there. A spontaneous meal
belongs in that ledger too; it simply has no weekly-plan link.

Then maintain `taste-profiles/` only for the distilled signal that will help a
future food decision:

- `TASTE_PROFILE.md`, `eric/TASTE_PROFILE.md`, `emma/TASTE_PROFILE.md`, and
  `ezme/TASTE_PROFILE.md` hold semantic memory: current accepted preferences,
  constraints, and planning concepts. They are not example repositories.
- Each person's `loved.md`, `avoid.md`, and `context-and-uncertain.md` holds
  curated examples and candidate signals linked back to the dated ledger.
  Recluster these pages when their shape stops helping future planning; do not
  force a taxonomy prematurely.

Do not copy every brain-dump detail into a profile page. Link the profile signal
to its ledger entry whenever both are updated. Promote a semantic-memory fact
only after clear user confirmation or sufficiently specific repeated evidence.
In the embedded planner runtime, use a feedback or profile operation only when
the host exposes one; otherwise report the update that remains to be persisted
and never access vault files directly.

## Planner closeout

Use `planner.read` before closeout. Where supported, record meal-level
repeat/modify/drop feedback, leftover quality, and a week lesson through
`planner.preview` then `planner.apply`, and report host readback. Rich
person-level evidence and profile updates remain separate from those narrow
planner fields.

Use `meal-planning` when the feedback changes a future week. Use
`recipe-adjustments` only after the user approves a specific change.
