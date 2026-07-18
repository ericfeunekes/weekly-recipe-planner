---
name: meal-feedback-closeout
description: Closes out a cooked meal by classifying its outcome and recording the planner fields the current host supports without silently changing a recipe or taste profile. Use when the user says how dinner went, wants to rate a meal, record leftovers, capture a lesson, or decide whether a recipe change worked. Do not use before the meal has been cooked.
---

# Meal Feedback and Closeout

Classify feedback against the original recipe, the week/meal, and the exact
cooked trial when that information is available in the conversation. Separate
four outcomes:

- **Proven change:** a specific adjustment was cooked and clearly helped.
- **Next-time hypothesis:** a wish or observation that still needs a trial.
- **Source/commentary note:** useful attributed context, not household proof.
- **Taste signal:** candidate evidence for a future preference change.

Do not silently rewrite a recipe or current taste profile. A proven change can
inform the next planning/adjustment pass; an untested wish remains a next-time
hypothesis. The current host cannot durably attach either classification to a
recipe, trial, taste history, or promotion record.

Use `planner.read` before closeout. Where the current host supports it, record
the meal-level repeat/modify/drop feedback, leftover quality, and week lesson
through `planner.preview` then `planner.apply`. Report the accepted readback.
Retain the richer classification in the response and name the missing durable
operation. Do not present it as stored closeout state, and do not substitute a
recipe rewrite or direct storage access.

Use `recipe-adjustments` when a next-time hypothesis is being turned into the
next deliberate trial.
