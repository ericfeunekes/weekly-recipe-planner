---
name: recipe-discovery-import
description: Finds, evaluates, and imports source recipes with provenance into the planner's cooking-ready recipe form. Use when the user asks to find a recipe, search NYT Cooking or the web, import a recipe, compare recipe candidates, or add a source recipe to the meal plan. Do not use merely to adapt an already selected recipe; use recipe-adjustments instead.
---

# Recipe Discovery and Import

Start with host-exposed recipe or corpus reads, then use public web search for
external discovery. The current deployed runtime does **not** expose Chrome
Bridge, browser/computer control, apps, or connectors. For authenticated
personal sources such as NYT Cooking, say that this runtime cannot retrieve the
source and use only the permitted source path. When a future runtime explicitly
adds Chrome Bridge, use it—not the Chrome plugin—for that personal-browser
boundary.

Evaluate candidates for the meal's outcome, household tastes, effort, ingredient
reuse across the week, seasonal fit, and source quality. Reuse and seasonality
are positive ranking signals, not artificial limits.

## Preserve lineage before promotion

Keep the source identity, URL, retrieval time, and useful commentary separate
from cooking-ready instructions. Never present a search snippet or inferred
ingredient list as source-verified extraction. Respect source and paywall
boundaries; summarize useful commentary instead of copying restricted content.

The current import boundary is meal-scoped. Normalize a selected, permitted
source into the cooking-ready source-replacement form for a selected meal,
using `planner.read`, `planner.preview`, `planner.apply`, and host readback.
Say explicitly that this creates a meal recipe snapshot, not a canonical recipe
library entry. Do not perform duplicate merging, canonical-library promotion,
or source-lineage management until the host exposes dedicated operations and
this skill is revised for them. Never work around a missing operation with
filesystem, database, shell, or direct API access.

Use `recipe-adjustments` for a planned variation after import. Use
`meal-planning` to decide where an imported recipe belongs in the week.
