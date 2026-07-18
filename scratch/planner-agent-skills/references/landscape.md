# Planner Food-Skill Landscape

## Sources surveyed

| Source | Reusable lesson | Deliberate adaptation |
|---|---|---|
| Food domain notes | Canonical ownership, provenance, dated feedback, weekly plan boundaries | Convert the written vault contract into actions on the planner surface. |
| `wardrobe-advisor` | Separate current semantic context from dated history | Do not require an interview for every request; planning confidence decides whether to work whole-week or incrementally. |
| `home-instrumentation-planning` | Start from the decision; make evidence and proof boundaries explicit | Treat source material, pantry inference, and cooking results as different evidence classes. |
| `ynab-household-budgeting` | Keep source records, proposals, operating records, and applied changes distinct | Keep source recipe, planned trial, cook outcome, and canonical promotion distinct. |

## Capability dependencies

The skills are behavioral instructions, not a substitute for app-server
capabilities. Each planner action should be backed by explicit operations:

| Workflow | Required planner/app-server operations |
|---|---|
| Planning | Read plan, recipes, preferences, inventory evidence; preview and apply plan changes |
| Discovery/import | Search corpus/broker, web search, or Chrome Bridge as appropriate; retrieve permitted source metadata/content; normalize/extract; create canonical recipe with lineage; surface ingredient reuse and seasonal fit as positive signals, not gates |
| Adjustment | Read original recipe and evidence; create planned trial; later propose/promote confirmed change |
| Prep | Read approved plan; preview and apply prep sessions/tasks |
| Groceries | Read recipe ingredient objects and inventory evidence; preview and apply useful groupings in the grocery view without replacing the ingredient objects |
| Closeout | Record cook outcome and feedback; create promotion candidate; update accepted taste preference only through an explicit operation |

If an operation does not exist, the skill should state the gap and produce the
smallest reviewable draft, not imply that an external write or source import
occurred.

The embedded agent should have a broad planner tool surface. Use web search for
public research; use Chrome Bridge when the task requires Eric's authenticated
Chrome profile or a visible personal web surface. Do not substitute the Chrome
plugin for that personal-browser boundary.
