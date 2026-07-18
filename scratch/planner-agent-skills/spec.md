# Planner Agent Skills — Discovery Spec

## Purpose

Design the initial release-owned skills for the embedded weekly-recipe-planner
agent. They should make food planning and cooking workflows practical in the
planner while preserving recipe provenance, untested observations, and durable
household feedback.

## Success Criteria

- The initial skill set supports one real end-to-end week: plan, source/import
  a recipe, make a planning-time adjustment, create prep and groceries, cook,
  and close out.
- The planner remains the operational surface; recipe/source/taste history is
  available through its backend and tools rather than being silently rewritten
  into prompts.
- Planning-time adaptations, cook-time observations, and proven recipe changes
  remain distinguishable.
- After using the skills on a real week, Eric can judge whether the workflows
  are natural enough to retain or need redesign.

## Initial Skill Scope

| Skill | Purpose and boundary |
|---|---|
| Meal planning | Propose either a complete week or incremental changes, chosen according to confidence; use known preferences, inventory inferred from prior plans/feedback, and available recipes. |
| Recipe discovery and import | Find source candidates, preserve provenance, favor sensible ingredient reuse and seasonal fit without making either an artificial limiter, extract them into the proper cooking-ready recipe format, and create a canonical recipe without a separate promotion confirmation. |
| Recipe adjustment | During planning, create an explicit planned/cooked adjustment informed by known tastes or source commentary. Do not promote that adjustment into the canonical recipe merely because it was proposed. |
| Prep-session design | Create a primary weekend prep session plus an optional midweek session for freshness-sensitive work. Final day-of recipe steps remain on the recipe, not forced into a prep session. |
| Grocery organization | Reuse the recipe ingredient objects directly, then group them into an actionable grocery view using explicit inventory plus reasonable inference from prior plans and feedback. |
| Feedback and closeout | Record cook outcomes against the original recipe and the exact cooked adjustment. Good, proven adjustments may later be promoted; untested wishes stay as comments for the next cooking/planning pass. |

## Recipe and Taste Model

- An adjustment proposed while planning is a plan/cook-specific variant until
  it has been cooked and received useful feedback.
- Positive evidence from a cooked adjustment can justify promotion into a
  reusable recipe variant or canonical recipe change.
- A post-cook wish without test evidence is stored as feedback/commentary on
  the original recipe; it becomes an input to the next adjustment, not an
  immediate recipe rewrite.
- Current accepted taste preferences remain separate from the dated history of
  tastes, observations, source commentary, and meal feedback.

## MoSCoW

| Must | Should | Could | Won't in the initial set |
|---|---|---|---|
| Plan a week; import/promote recipes; preserve source lineage; distinguish planned adjustments from validated recipe changes; create weekend/midweek prep; organize groceries from recipe ingredient objects; capture feedback | Infer plausible inventory; choose whole-week versus incremental planning by confidence; carry source commentary into planning | Richer taste-history synthesis and automatic promotion suggestions | Automatic canonical recipe rewrites from a single untested cook; treating ordinary day-of recipe steps as prep sessions |

## Validation Path

Use the initial skill set on one real week: plan from existing recipes, import
one new source into the cooking-ready format, make a planning-time adjustment,
create prep and groceries, cook, record feedback, then assess the workflow.

## Open Questions

- What evidence threshold promotes a successful cooked adjustment: one clearly
  positive cook, repeated success, or an explicit household decision?
- Which source commentary is sufficiently useful to retain as planning context,
  especially for NYT Cooking comments?
