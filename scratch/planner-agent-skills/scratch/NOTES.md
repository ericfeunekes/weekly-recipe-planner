# Planner Agent Skills — Notes

## Discovery, 2026-07-18

- Recipe adjustment has two distinct moments. During planning, it can adapt a
  recipe for known household tastes or source commentary. After cooking,
  feedback does not automatically rewrite the recipe: a successful adjustment
  becomes promotion evidence; an untested wish remains a comment for next time.
- Taste history must remain separate from current accepted taste preferences.
- Typical prep shape is one larger Saturday/Sunday session, with an optional
  Wednesday/Thursday freshness session. Final day-of recipe steps stay with
  the recipe.
- Recipe discovery/import includes promotion into the proper cooking-ready
  recipe format; no separate confirmation is required to create the canonical
  recipe.
- Grocery reconciliation may infer inventory from prior plans and feedback.
- Meal planning can propose a complete week or work incrementally; select the
  mode based on confidence.
- The first validation is a real end-to-end week after the initial skills are
  created. Workflow quality, not the draft skill prose, decides what remains.

## Phase transition

- Eric confirmed the Phase 0 scope on 2026-07-18. Begin the landscape survey.

## Survey findings

- The food-domain `AGENTS.md` names Meal Planning, Finding Recipes, Adapting
  Recipes, and Recipe Library Management, but their referenced `SKILL.md`
  files are not present in the opened vault. Treat the durable food notes as
  the actual current contract rather than assuming those draft skills exist.
- `meal-planning-approach.md` requires 2-4 high-level approaches before
  specific recipes unless Eric requests a complete plan; at most two primary
  proteins; vegetable variety; seasonal/logistical fit; Monday farm-box-first
  shopping; and exact grocery variants/quantities.
- `meal-plans/README.md` assigns week-only recipe changes to the weekly plan,
  keeps source recipes stable, and makes shopping/prep/meal completion
  operational records.
- `recipes/README.md` assigns source lineage to the canonical recipe; dated
  cooks/outcomes remain in feedback. Stable adaptations preserve the source,
  while week-only changes remain in the plan.
- `meal-feedback.md` provides concrete evidence for the proposed
  adjustment-promotion rule: an unsuccessful sauce adaptation and a
  seasonality/component observation stay as "next time" trials, not source
  rewrites.
- `taste-profile.md` is current accepted preference; it must not be conflated
  with dated feedback and candidate signals.
- The surveyed `wardrobe-advisor` skill demonstrates a useful pattern for
  current semantic context plus dated periodic evidence, but its mandatory
  interview-first behavior does not fit every planner request. The planner
  skills should choose complete versus incremental collaboration by confidence.
- The surveyed `home-instrumentation-planning` skill is a stronger structural
  reference for this work: begin from the decision, name a completion contract,
  keep observed/inferred/assumed facts distinct, and report the proof boundary.
  The food skills should use the same discipline for source text, inventory
  inference, planned changes, and cook outcomes.
- The surveyed `ynab-household-budgeting` skill is a useful ownership reference:
  keep the operational system, source evidence, proposed interpretation, and
  external mutation distinct. Planner skills should similarly distinguish the
  planner's operational records, vault/source evidence, proposed meal changes,
  and a canonical recipe promotion.

## Comparative conclusion

- There is no existing local food `SKILL.md` implementation to adapt. The food
  notes are the source contract, and the weekly planner needs a new, compact,
  release-owned skill set rather than a copied vault skill.
- Every skill needs the same evidence labels: **source fact**, **inference**,
  **planned trial**, **cooked outcome**, and **accepted current preference**.
  The labels prevent an inferred pantry item or an untested cooking wish from
  silently becoming a recipe fact.
- The skills need planner-specific read/preview/apply operations, plus a
  brokered recipe/source corpus. They must not claim that direct vault access,
  web/NYT retrieval, extraction, source import, pantry inference, or recipe
  promotion is available until its corresponding app-server operation exists.
- The skill boundary should follow the food lifecycle, not UI pages: choose a
  meal plan; discover/import a source; make a trial; organize prep; buy the
  remainder; close out and retain evidence. The adjustment and closeout skills
  deliberately meet at the planned-trial/cooked-outcome boundary.

## Starting operating approaches for review

1. **Meal planning:** establish the planning confidence first. When high,
   propose a complete editable week; when constraints or recipe fit are still
   uncertain, present 2-4 high-level directions and fill slots incrementally.
   Apply known taste preferences, at most two primary proteins, seasonal and
   logistical constraints, and explicitly labeled pantry inferences. Create or
   update planner rows only through a preview/apply operation.
2. **Recipe discovery and import:** search personal/corpus sources first, then
   approved external sources. Treat ingredient reuse across the week and
   seasonal fit as positive selection signals, never artificial limits.
   Preserve source URL/identity, extraction date, evidence boundary, and
   lineage; normalize the selected source into the cooking-ready recipe schema
   and create its canonical recipe immediately. Do not merge apparent
   duplicates without lineage review.
3. **Recipe adjustment:** when planning, create a named trial attached to the
   week and original recipe, with rationale from current tastes or sourced
   commentary. It is a cooking variant, not a recipe rewrite. After cooking,
   only a specific, positively confirmed result can become a promotion
   candidate; an untested wish stays as feedback on the original recipe for the
   next cook.
4. **Prep-session design:** derive work from the approved plan into a main
   Saturday/Sunday session and, only when justified by freshness, a
   Wednesday/Thursday session. Keep day-of finishing steps in the recipe. Each
   prep task names the meal/recipe, ingredients or output, storage, and its
   handoff to the cook.
5. **Grocery organization:** retain recipe ingredient objects as the source of
   truth and identify useful grocery groupings from them. Use explicit
   inventory first and prior plan/feedback evidence as an inference only; flag
   uncertainty rather than presenting it as confirmed.
6. **Feedback and closeout:** record dated results against the original recipe,
   week, and exact cooked trial. Classify outcomes as a proven change,
   next-time hypothesis, source/commentary note, or candidate taste signal.
   Update the current taste profile only after evidence warrants it; retain the
   full history separately.

## Review corrections, 2026-07-18

- Recipe discovery/import should deliberately consider ingredient reuse across
  the week and seasonal ingredients as positive selection signals, but neither
  is a veto: a strong recipe may still be worth importing or planning when it
  introduces a new ingredient or is out of season.
- Grocery work is not a fresh quantity-calculation engine. Recipe ingredient
  objects remain the source of truth; the skill identifies useful groupings and
  applies inventory evidence to the resulting grocery view.
- The app server should expose broadly useful planner capabilities, rather
  than narrowing the embedded agent to a small special-purpose tool subset.
  For work outside the planner/corpus, the agent may use web search and the
  Chrome Bridge (not the Chrome plugin) when the task needs Eric's real Chrome
  profile or authenticated surface. The skill must still distinguish observed
  source evidence from an inference and must report an unavailable operation.

## Analysis decision

- Proceed with six narrow skills sharing a small common evidence and lifecycle
  vocabulary, rather than one large all-purpose food-agent instruction. This
  keeps requests routable and makes app-server capability gaps visible during
  the first real-week validation.
- Pending Eric review: use the six approaches above as the Phase 2 design basis
  before prototyping or packaging any skill.

## Domain analysis and packaging decision

- The concrete skill target is the embedded agent's release-owned instruction
  surface at `.agents/skills/`, loaded from the immutable application bundle.
  The planner host is the only durable-effect authority.
- The current host exposes `planner.read`, `planner.preview`, and
  `planner.apply`. Reads provide canonical state; previews validate an ordered
  batch without effects; apply commits an atomic batch and returns canonical
  readback. Every durable planner change follows that order.
- Recipe import is currently meal-scoped: a sourced candidate can replace a
  selected meal. A canonical recipe-library operation and durable detailed
  cooking-feedback/taste-history operations are not yet exposed. The skills
  must name those gaps, never emulate them with direct storage access.
- Groceries are a 1:1 execution projection of recipe ingredient objects. Prep
  is a date-owned queue of references to canonical instruction steps.
- The desired Chrome Bridge path is a target runtime capability. Skills may use
  it only after it is exposed; they must not substitute the Chrome plugin.
- Adopt-or-build: **build six repo-local skills.** No surveyed skill covers the
  source-lineage, planned-trial, meal-plan, prep-queue, ingredient-object, and
  feedback-promotion boundaries together.
- Current contract inspection is the first prototype: it validated the
  read/preview/apply lifecycle, meal-scoped source replacement, prep queue,
  grocery grouping, and meal-level feedback. The first real week is the
  remaining end-to-end prototype and will produce evidence in `reps/`.

## Fresh scenario evaluation

- Five representative prompts routed cleanly to the corresponding skills:
  whole-week planning, sourced seasonal import, planned adjustment, weekend plus
  midweek prep, and cooked feedback.
- The review found no direct-storage or Chrome-plugin escape path. It found
  five wording gaps: do not imply a meal-slot/recipe-library operation exists;
  name the full lifecycle for meal-scoped import; treat prep storage annotations
  as explanatory until fields exist; name host-exposed corpus reads rather than
  assuming access; and state the exact currently supported closeout fields.
- Patched all five into the initial skill set. The untouched holdout is a
  real-week end-to-end use, not tuned against these written scenarios.

## Independent review and resolution

- The reviewer found three current-runtime overclaims: conditional Chrome Bridge
  guidance could still steer the shipped runtime toward a prohibited capability;
  canonical library import was described even though import is meal-scoped; and
  closeout language could make non-persisted classifications sound durable.
- Resolved by making the current absence of Chrome Bridge explicit, restricting
  import to meal snapshots until dedicated library operations exist, and
  distinguishing response-level feedback classification from the narrow current
  persisted feedback/leftover/week-lesson fields.
- Independent re-review approved the corrected files with no remaining
  findings. The initial skill set is ready for the real-week improvement cycle;
  its first durable usage evidence belongs in `reps/`.
