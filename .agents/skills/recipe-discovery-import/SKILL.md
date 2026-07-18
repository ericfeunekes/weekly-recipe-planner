---
name: recipe-discovery-import
description: Finds and verifies source-faithful recipe candidates with provenance, and prepares them for import when the host can enforce fidelity. Use when the user asks to find a recipe, search NYT Cooking or the web, import a recipe, compare recipe candidates, or add a source recipe to the meal plan. Do not use merely to adapt an already selected recipe; use recipe-adjustments instead.
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
are positive ranking signals, not artificial limits. Selection never authorizes
changing a source recipe.

## Preserve the source recipe exactly

Import the title, yield, ingredient amounts and names, instruction text, step
order, and explicit timers precisely as the source presents them. Do not
substitute, simplify, scale, normalize wording, merge/split steps, alter an
ingredient, or fold a comment into the recipe. The only structural omission is
an optional field the source did not provide.

Keep source identity, URL, retrieval time, and comments separate from the
cooking-ready recipe. Bring useful comments in only as attributed notes or
suggestions. A comment that suggests a change is not a change to the recipe.
If it appears worth trying, ask the user before invoking `recipe-adjustments`.

Maintain three distinct layers:

1. the immutable, source-faithful recipe capture;
2. attributed source notes and commentary; and
3. planner-only meal components, scheduling, and serving notes.

Create a mechanical ingredient-object projection beside the untouched source
ingredient list. Each projected row retains its literal source string and
records quantity, unit, ingredient, preparation, qualifier, and a
`structure-status`. Ambiguous ranges, alternatives, and "to taste" remain
partial rather than guessed. Planner-ready formatting must not overwrite the
source capture.

Keep the source capture's instruction shape unchanged. For the planner
projection, render each explicit source step separately. If a raw source block
contains explicitly numbered actions on one line, split only at those explicit
boundaries while retaining each action's source wording and punctuation exactly;
do not invent, merge, or rewrite actions.

When a recipe refers to a defined subrecipe or component, import that component
as its own source-faithful recipe. Keep the outer recipe's wording unchanged.
For a composed meal, expose the component's direct ingredients in the one
consolidated planner ingredient list, omit the opaque placeholder, and record
batch yield, amount used, and any hold or freezer remainder. Do not merge the
two source recipes or duplicate their full ingredient lists. If the referenced
component cannot be identified, mark it unresolved and ask rather than invent
ingredients.

## Require independent fidelity verification

Before any import applies, create a deterministic field-by-field diff between
the captured source recipe and the candidate: title, yield, ingredient order,
amounts, ingredient text, instruction text, step order, explicit timers,
capitalization, punctuation, and source notes. Every field must be exact. If
the source capture cannot support this comparison, do not import yet.

Then send the source capture and candidate to one bounded independent worker
that did not extract the recipe. Require a structured verdict of `exact`,
`mismatch`, or `incomplete`, with every difference named. The review also
checks projection integrity: literal source coverage, component traceability,
and no duplicate or unexplained planner ingredient rows. Do not apply an import
unless the mechanical comparison is exact and the independent verdict is
`exact`. A mismatch or ambiguity stops the import for user review; never repair
it by silently editing the candidate.

The current native planner preview/apply path does not invoke the host's
candidate-binding helper and does not capture the source recipe or independent
verdict. Source-faithful import is therefore unavailable in the deployed host.
After mechanical and independent verification, present the exact candidate and
the verification result for review, but do not call `planner.preview` or
`planner.apply` with `replaceMealRecipeFromSource` and do not report an import as
stored. Resume only when host capability readback explicitly proves that the
applied replacement is bound to this source capture and verdict.

Do not invent typed provenance fields the planner does not expose, and do not
use direct storage access as a substitute for the missing host operation.

Use `recipe-adjustments` for a planned variation after import. Use
`meal-planning` to decide where an imported recipe belongs in the week.
