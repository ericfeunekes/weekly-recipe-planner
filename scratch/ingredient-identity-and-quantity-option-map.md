# Ingredient identity and quantity option map

## Frame

Question: how should the planner normalize ingredient identity and quantities so recipe entry/import, instruction uses, Prep, Groceries, and Codex batch operations share one explainable contract without rewriting source-faithful meal snapshots or turning the app into a food-ontology product?

Current constraints:

- The product center remains the meal-local `RecipeSnapshot`, not a canonical recipe library.
- Grocery rows are execution projections from recipe ingredient occurrences and retain household-owned source/check state.
- Instruction uses reference recipe-local ingredient IDs.
- UI and Codex mutations use the same typed, versioned planner authority.
- TanStack Router migration should extract shared touched components rather than copy route markup.

Evaluation criteria:

- no ingredient, quantity, instruction link, or grocery execution state is silently lost;
- ambiguous matches abstain and remain usable;
- literal recipe wording and normalized computation can coexist;
- grocery grouping is explainable and reversible;
- UI and Codex can preview and apply the same batch artifact;
- the first slice stays small enough to prove with real current data.

## The missing identity layers

One global string is too little. The system may need to distinguish:

1. source literal: `2 scallions, thinly sliced`;
2. recipe occurrence: stable meal-local ingredient ID and display amount/name;
3. household ingredient concept: `green onion` with accepted aliases;
4. purchasable form: `1 bunch green onions`;
5. instruction use: `half the onions`;
6. prepared output: `caramelized onions`;
7. grocery requirement and its Shop/Farm box/On hand/check state.

These layers do not all need first-class tables immediately, but the contract must not collapse them accidentally.

## Option families

### A. Optional household catalog overlay

Keep recipe occurrences and their display text authoritative. Add an optional stable household concept reference plus aliases and coarse form/qualifier data. Matching or later catalog edits never rewrite archived or meal-local display text.

Useful when cross-meal grouping and household vocabulary are durable benefits. Main risk: ontology creep.

### B. Projection-time alias and grouping memory

Keep identity meal-local and store only confirmed alias/grouping decisions used by grocery projection. Canonical ingredients become a derived view, not a second product center.

Useful when shopping consolidation is the goal. Main risk: weaker reusable ingredient knowledge and repeated matching.

### C. Canonicalization gate

Require every new ingredient to resolve before the recipe becomes grocery-ready. Exact matches can pass automatically; ambiguous rows require match, create-new, or unresolved.

Useful for deterministic data. Main risk: clerical friction blocks meal planning.

### D. Exception-only batch preflight

Save recipes with unresolved identity allowed. Before apply, return one typed result per input but show humans only novel, ambiguous, materially consequential, or conversion-incompatible rows. Preserve Accept, Not the same, Same this time, Teach household, and Unresolved outcomes.

Useful for UI/Codex parity and household attention. Main risk: systematic matcher errors can hide behind confidence unless automation is consequence-weighted.

### E. Late-bound typed quantities

Always retain the raw amount string. Optionally parse scalar/range, rational value, unit, dimension, package size, and modifiers. Convert only within compatible dimensions; volume-to-mass requires ingredient-specific evidence; cooked/raw yield and purchase rounding are separate policies.

Useful for scaling and grocery totals without fake precision. Main risk: parsed and literal values can drift unless edits name which representation changed.

### F. Prepared-output material graph

Model steps as consuming ingredients/components and producing prepared outputs. Grocery projection follows purchasable leaves only.

This is the cleanest explanation for sauces, cooked grains, reserved portions, and formed cakes, but it risks turning manual Prep into a dependency-graph product. A lightweight role on ingredient occurrences may cover the first need.

### G. Collision-driven canonicalization

Do not build a global cleanup queue. Ask only when active-week occurrences collide during grouping, scaling, substitution, or source classification.

This uncomfortable option minimizes ontology gardening and household attention. It risks inconsistent long-term data when dormant recipes return.

## Matcher contract

Edit distance is one weak signal, not the matcher. A safer pipeline is:

1. parse amount/unit/name/qualifiers while preserving the literal line;
2. normalize case, whitespace, punctuation, pluralization, and known unit spellings;
3. exact preferred-name and accepted-alias lookup;
4. token/qualifier-aware candidate retrieval within plausible category/form;
5. edit-distance or another lexical score as one ranking feature;
6. consequence-weighted thresholds and an explicit abstain result.

Semantic aliases such as scallion/green onion will not be found by edit distance. Short or similar strings such as dill/milk and chili powder/chile powder make edit-distance auto-merging dangerous. Fresh/dried, whole/ground, raw/cooked, bone-in/boneless, and allergen-relevant forms should require much stronger evidence.

Suggested pure preflight shape:

```ts
type IngredientResolutionPreview = {
  plannerVersion: number;
  catalogRevision: number;
  inputHash: string;
  items: Array<{
    clientId: string;
    raw: string;
    parsed: ParsedIngredientLine;
    candidates: Array<{
      ingredientConceptId: string;
      label: string;
      reasons: MatchReason[];
      consequence: "low" | "material" | "high";
    }>;
    disposition: "exact" | "suggested" | "unresolved" | "invalid";
    warnings: string[];
  }>;
};
```

Apply should bind to the same planner version, catalog revision, input hash, and stable client IDs. Stale proposals rebase while preserving unaffected human decisions. Preflight itself creates no aliases or planner state.

## Quantity and conversion boundaries

- Dimensions: mass, volume, count, package, and informal measures.
- Exact conversion: only within a dimension, such as grams to kilograms.
- Ingredient-specific conversion: volume to mass requires a density/version/source.
- Transformation: raw to cooked yield is not a unit conversion.
- Purchase rounding: recipe math and store quantities are separate decisions.
- Packages: preserve both count and labeled size, such as `1 x 540 mL can`.
- Non-numeric language: retain `to taste`, `as needed`, `for garnish`, alternatives, and ranges without inventing a number.
- Aggregation: group only the same household concept with compatible form, role, and units; otherwise show separate child requirements.

## Trust, correction, and lifecycle

- Show a named reason, not an unexplained confidence percentage.
- Make correction scope explicit: this occurrence, this source/recipe, or household-wide.
- Retain negative evidence so rejected suggestions are not repeated.
- Give every merge/alias/conversion a current explanation and reversible provenance.
- Never hard-delete a referenced concept; merge through redirects and migrate references atomically.
- Surface downstream blast radius before a catalog merge: meals, instructions, prep references, groceries, source/check state, and staged proposals.
- Preserve unresolved identity as valid recipe state; it may block aggregation, never cooking.

## Promising directions

1. **Layered occurrence plus optional household concept.** Preserves the current RecipeSnapshot center while enabling durable aliases and grouping.
2. **Exception-only, version-bound batch preflight.** Gives UI and Codex one safe review/apply contract and minimizes household attention.
3. **Raw-first, partial quantity algebra.** Adds exact conversions incrementally and refuses unsupported conversions rather than guessing.

Prepared-output graphs are set aside for the first slice. Start with an occurrence role such as `purchasable`, `prepared_component`, or `leftover` so Groceries can stop projecting non-purchasable outputs without introducing a full dependency graph.

## First discriminating probes

1. Run the current household ingredient corpus through a lossless parser and record parse coverage, duplicate suppression, and qualifiers.
2. Build a golden ambiguity set: scallion/green onion, chili/chile powder, fresh/ground ginger, rice varieties, raw/cooked salmon, package sizes, and prepared outputs.
3. Prototype the batch preflight as a pure function and inspect only the exception-review UI; do not persist a catalog yet.
4. Decide whether the catalog belongs inside the planner's existing versioned authority or needs its own revision before defining apply commands.

## Not decided

- durable global catalog versus projection-time grouping memory;
- exact qualifier/form vocabulary;
- whether household-wide alias learning is automatic, explicit, or promotion-based;
- whether grouped grocery checking propagates to child requirements;
- catalog authority/version ownership;
- how much purchase-form rounding the planner should own.
