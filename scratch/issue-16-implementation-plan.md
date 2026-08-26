# Issue 16 — Improve ingredient authoring and Recipe/Prep context

Status: planning only. This plan authorizes no implementation, documentation, GitHub, schema, or household-data mutation.

## Outcome and protected contract

Deliver one compact, occurrence-aware ingredient authoring/review surface and one small shared Recipe/Prep ingredient presentation. A manual meal remains a dated, editable recipe snapshot. An imported meal remains that same editable dated snapshot with its pinned `sourceRecipe` unchanged by ordinary recipe edits. Concept resolution remains a separate reference-only action; it must not rewrite recipe literals, occurrence identity, instruction links, or grocery execution state. No culinary edit is automatic.

Preserve:

- the existing manual instruction editor's `amount | ingredient` visual and keyboard interaction, including hidden retain occurrence IDs and creation correlations;
- opaque meal-local occurrence IDs, immutable `canonicalIngredientId` correlation, and instruction links;
- existing `editMealRecipe` / `editInstructionStep` source-edit invalidation: changes to contributing instruction wording, input membership, or linked occurrence literals reopen each affected combined Prep holder, clear completion, set `needsReview`, and hide prepared-in-batch claims until reconfirmed;
- browser, embedded Codex, and Global Codex sharing the existing typed planner authority; and
- Recipe/Prep presentation remaining presentation only, with state and mutations owned by the planner client/service.

Out of scope: grocery grouping/Week coverage (#17); TanStack Router installation (#6); prep notes (#11); canonical import/admission orchestration (#43); library management; prep scheduling; source-recipe rewriting; schema/migration changes; or a new food ontology.

## Current evidence and decisions

- `lib/household-contract.ts` models each ingredient as a meal-local `RecipeIngredient` with opaque `id`, literal/source fields, `conceptId`, and `canonicalIngredientId`; instruction inputs reference `occurrenceId`.
- `lib/ingredient-occurrence.ts` enforces retain/create partitions and resolves a *new* instruction input only when a core match is unique. Duplicate/ambiguous names deliberately create a new occurrence instead of choosing one.
- `lib/household-domain.ts` already provides `previewIngredientCandidates`, `addIngredientOccurrence`, `resolveIngredientOccurrence`, and `applyIngredientResolutionBatch`. Resolution changes only `conceptId`; `editMealRecipe` preserves `sourceRecipe`; `replaceMealRecipeFromSource` creates a new pinned snapshot.
- `editMealRecipe` and `editInstructionStep` already call `invalidateCombinedPrepForStep` for the relevant literal/input/writing changes. The planner updates the combined entry's ordered source ingredient IDs, marks it `needsReview`, and clears its completion. Do not duplicate this policy in UI state.
- `components/planner-ui/recipe-content.tsx` is the only existing shared ingredient renderer but its recipe view collapses imported rows to `source`, which hides the structured amount/unit/core/qualifier. `components/planner-ui/prep-view.tsx` separately renders combined projections and direct Prep inherits `RecipeInstructionContent`; provenance is only locally rendered.
- `app/planner-client.tsx` owns draft/edit state and currently contains the occurrence editor and compact instruction control. Its mutation façade exposes only acceptance, not the authoritative created-occurrence correlations needed to open a post-save review for exactly the rows just added.

Decision: add no domain commands, persistence fields, migrations, router state, or grocery behaviour. Keep the existing authority and expose its accepted occurrence results to the client component that needs them.

## Implementation plan

1. Extract a small occurrence-authoring/review composition from `app/planner-client.tsx` into `components/planner-ui/ingredient-authoring.tsx` (or the nearest existing planner-ui ownership file).

   - Accept controlled `IngredientOccurrenceEdit[]`, the retained/source IDs needed for accessible row actions, and callbacks supplied by the meal editor; preserve retain IDs on reorder/edit, use fresh correlations for add/copy/split, and retain the current atomic removal intent.
   - Keep the existing field order and row controls for manual recipes. Do not put a picker, concept label, or resolution selection into the compact instruction amount/ingredient rows. The instruction editor continues to submit the current retain/create `InstructionInputEdit` protocol and relies on existing unique-only resolution.
   - Add a non-blocking, post-save **Review ingredient concepts** affordance. It calls existing `previewIngredientCandidates`, displays candidate reasons/ambiguity, and submits only an explicit `applyIngredientResolutionBatch` decision. The review component accepts both newly created occurrence results and existing occurrence IDs, so manual post-add review and later batch review use exactly one occurrence-aware surface. Review at most 16 occurrences at a time, matching the existing preview/apply contract; after each accepted batch refresh state and re-preview any remaining selection against the current catalogue revision (especially when that batch created a concept).
   - Offer explicit per-row choices: leave unresolved, choose a suggested existing household concept, or create one with label/vocabulary/default section. Creation and every resolution are explicit; the component never changes amount, unit, core, qualifier, source wording, canonical correlation, instruction membership, grocery coverage, or checked state.
   - On a recipe save containing creates, open the review from the accepted `occurrenceResults` returned by the authoritative command. Do not infer created identities from text or reparse the refreshed workspace. A save with no creates still offers review over selected/current occurrences. Adding one occurrence must not reset unrelated step completion or timers.

2. Narrowly extend the browser mutation plumbing in `app/planner-client.tsx` / `app/planner-api.ts` so the shared mutation executor can receive the existing accepted/replayed planner decision (especially `occurrenceResults`) while retaining current retry, version-conflict, refresh, and error ownership.

   - Keep normal callers able to use the existing boolean/onAccepted shape. For an `editMealRecipe` containing create correlations, have the executor itself pair the submitted correlations with the accepted/replayed `occurrenceResults` and seed the ephemeral post-save review state. This is deliberately executor-owned rather than an optional volatile callback: interrupted response → reload → authority-journal retry must reopen review for the authoritative IDs without text matching. The review state itself need not persist after that accepted/replayed result has been consumed.
   - Do not manufacture client IDs, store candidate review state durably, or create a browser-only mutation path. The draft/review UI is ephemeral; preview/apply continues through `/api/operations/preview` and the existing command endpoint.
   - Preserve operation recovery for `editMealRecipe`: a retry uses the same retain IDs/correlations and cannot silently convert its input into a different occurrence partition.

3. Rework the meal drawer to compose the new authoring/review control without changing its recipe command boundary.

   - Continue issuing one `editMealRecipe` with all retained rows, explicit removals, and newly created correlations. Keep the current source/title/yield/note fields and validation.
   - Make source-pinned imported copies legible in the drawer and recipe summary: show the pinned canonical revision/provenance alongside an explicit “editable meal copy” explanation. Ordinary edits preserve the source tuple; only the existing host-admitted replacement command can replace it.
   - Leave combined-Prep consequence display to the refreshed authoritative Prep/Recipe projections (`Needs review` and suppression of prepared claims), rather than reconstructing or separately messaging an invalidation count in the UI. A literal edit/removal that affects an input used by a combined entry must take the same invalidation path as the existing instruction editor; a concept-only review must not invalidate it.

4. Evolve `components/planner-ui/recipe-content.tsx` into the small shared Recipe/Prep ingredient/provenance renderer and consume it from Recipe summary/drawer, direct Prep rows/source picker, and the existing combined-Prep projection where its data shape fits.

   - Add a presentation variant for a full occurrence that renders source wording and the structured amount, unit, ingredient, and qualifier distinctly and consistently. For imported occurrences, show both: the source line for fidelity and the structured fields for cooking context; for manual rows without source, retain the familiar compact literal presentation.
   - Keep `RecipeInstructionContent` and direct Prep’s same `InstructionStep` reference. It must not create a copied ingredient record or introduce route-owned state.
   - Add one provenance fragment reusable by Recipe and Prep: title/date context plus source kind and pinned canonical revision (or web identity), without duplicating prep scheduling controls. Combined Prep continues to render live derived aggregates and contributing sources from `prep-projection.ts`.
   - Use existing Tailwind primitives/tokens. Verify wrapping and no horizontal overflow at 320px phone, 768px tablet, and desktop; keep controls keyboard reachable with programmatic labels/descriptions.

5. Add focused proof at the actual seams.

   - **Component/unit:** test the authoring/review transformations: retained IDs survive reorder/copy/split; create correlations are fresh; no text rematch is used; review decisions alter only `conceptId`; an ambiguous suggested core is never silently resolved. Test renderer variants for imported source+structured fields and manual fallbacks.
   - **Domain/integration:** extend `tests/domain-household.test.mjs` and `tests/ingredient-resolution-lifecycle.test.mjs` only where needed to lock the intended UI use of existing commands: sourced recipe ordinary edit preserves the pinned source tuple; occurrence/canonical correlations and instruction links survive; resolution leaves literals and grocery execution intact; literal/input edits invalidate combined Prep, while concept-only resolution does not. Run the existing HTTP/embedded/Global ingress parity suite to prove no new authority path was added.
   - **Browser:** extend `tests/e2e/ingredient-occurrence-editor.spec.ts` with a manual add → accepted occurrence-result → suggestions → explicit resolve/create/unresolved flow, duplicate/ambiguous safety, keyboard flow, and preservation of unrelated instruction completion. Simulate an interrupted response followed by reload and exact authority-journal replay, then assert post-save review opens against the returned opaque IDs. Include 17+ selected occurrences to prove the UI never sends an oversized review/apply and re-previews later chunks after a concept-creating decision. Cover an imported recipe fixture: source wording plus amount/unit/core/qualifier appear in Recipe and Prep; normal dated-copy title/yield/ingredient/instruction edits preserve pinned revision; no automatic culinary content changes occur.
   - **Combined Prep browser lifecycle:** extend `tests/e2e/prep-combined-entry.spec.ts` to edit contributing occurrence wording and input membership through the new authoring path, assert “Prepared in batch” is suppressed in Recipe and Prep, the Prep holder becomes `Needs review`/incomplete, then reconfirm; assert concept-only review does not invalidate. Restart the QA runtime, reload, undo the latest edit, and verify the authoritative restored state and prepared badge/holder state.
   - **Responsive/a11y:** run those flows at 320×844, 768×1024, and 1280×900, verify no `scrollWidth > clientWidth` on the ingredient/provenance containers, focus return from modal/review, labels/announcements, and axe through the repo’s existing Playwright QA helper.

6. Verify after implementation in proportion to the changed surfaces: focused node/component/domain/integration tests; the focused Playwright specs against `make dev-start`’s isolated Portless runtime (including restart); then `npm run typecheck`, `npm run lint`, `npm run build`, and the repository’s relevant full test command. Record any unrelated pre-existing failure separately; do not weaken tests.

## Planning review considerations resolved

1. **Could authoring create a second ingredient or grocery authority?** No. The `RecipeIngredient` remains the single literal/identity authority and `GroceryItem` continues to derive from it. The review uses existing concept commands only; it does not persist a UI copy or mutate grocery execution.

2. **Could a shared renderer accidentally own Prep or route state?** No. It receives already-authoritative recipe/step/projection data and emits no mutation. Prep selection, drag, scheduling, and combined entry lifecycle stay in `PrepView` and the household reducer.

3. **Could a new authoring path bypass combined-Prep invalidation?** It must not. Recipe literal/input changes go through existing `editMealRecipe`/`editInstructionStep`, which already invalidate affected combined entries. Concept review intentionally uses resolution-only commands, so it has no invalidation effect. The lifecycle test explicitly distinguishes these cases, and the UI reads its visible consequence from refreshed authoritative state rather than duplicating reducer logic.

## Dependencies and handoffs

- Requires the landed occurrence identity, ingredient catalogue/resolution, quantity, and combined-Prep contracts already present at `e8044c0d6e594c8ff6db6139b16dea5a927375c2`.
- This plan consumes #18’s source-step/occurrence lineage and invalidation behaviour; it does not modify #18’s stored model.
- Leave #17 grocery grouping/coverage UI, #6 routing, #11 prep notes, and #43 canonical import orchestration to their owners. A future reusable culinary variant remains a food-workflow decision, not a side effect of this issue.

## Flags for owner decision

No unresolved product, authority, or data-model decision blocks this plan. The only implementation choice is a narrow presentation naming/location for the extracted authoring component; it does not change behaviour or ownership. No competing approach is retained because adding new persistence/commands or a blocking concept picker would violate the established contract.
