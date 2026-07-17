# Grocery projection and interaction remediation

## Context

Groceries are an active-week execution surface, not a separate shopping-list
product. The user has made the contract explicit: every canonical recipe
ingredient for a selected-week meal must appear automatically in Groceries;
Groceries only stores the execution classification of that ingredient (for
example, Shop, Farm box, On hand, section, and checked state).

This revises the earlier source/provenance plan. That plan addressed visible
source filtering and recipe links, but it left the sibling free-text grocery
model intact. It contains no root-closure locator for that deeper contract, so
the projection root remains open rather than being treated as a completed prior
fix.

## Current evidence and worktree drift

The shared worktree is materially changed in `planner-client`, household
contract/domain/persistence, and grocery tests. Those changes are concurrent
work, not evidence that the following roots are closed: current source still
has independent `GroceryItem` text/details plus `mealIds`, no ingredient
reference, and no reconciliation after ingredient mutations.

The source findings came from browser QA and a read-only RCA, not an upstream
`code-analysis:review` run. Therefore no review disposition exists to carry
forward. The explicit user contract makes clusters 1 and 2 must-fix; cluster 3
is required usability work because it caused a false data-loss observation in
the completed QA run.

## Lane record

| Cluster | Coverage | Result |
| --- | --- | --- |
| Ingredient projection contract | `projection_siblings` | Complete sibling sweep across domain, persistence, ingress, UI, docs, and tests. |
| Row selection and controls | `interaction_siblings` | Complete sibling sweep across the React pointer-event surface. |
| Proof bar | In-process synthesis | Current test contract provides real temporary SQLite, loopback HTTP, and seeded Playwright authorities; no capability gap. |
| Structural framing | In-process forces + ownership analysis | A small projection boundary is sufficient; no new service or generalized rule engine is justified. |

## Forces register

Behavior under remediation: a canonical recipe ingredient appears exactly once
in the active week’s grocery execution view; recipe and instruction edits
reconcile it atomically while preserving its classification by stable identity;
controls act without accidentally entering selection; moves visibly confirm
their destination.

| Force | Status | Behavior evidence | Resolution |
| --- | --- | --- | --- |
| Persistence | Present | Ingredient identity and source/checked state must survive restart, undo, events, and cached readback. | One ingredient-keyed execution record in household state; migrate every persisted household JSON envelope atomically. |
| Contracts and validation | Present | Browser, HTTP, Codex, and Global callers all submit typed commands and must no longer create detached groceries. | Retire free-form grocery mutation from the active command registry; validate projection coverage and ingredient references at the shared domain boundary. |
| Internal typing | Present | `mealIds` cannot identify which of a meal’s ingredients a grocery represents. | Replace it with an explicit `{ mealId, ingredientId }` identity; derive visible name, amount, and recipe link. |
| Concurrency | Present | Two clients may edit recipes/classification through the existing OCC authority. | Reconcile within the same domain command transition; keep existing version-conflict behavior rather than adding a second writer or single-flight layer. |
| State and lifecycle | Absent | Source and checked are independent classification fields, not exclusive workflow phases with leases, recovery, or terminal states. | Model them as fields on the execution record; do not introduce a lifecycle state machine. |
| Caching | Absent | Grocery readback must reflect the just-accepted recipe/classification command. | No projection cache; render from authoritative household state. |
| Failure and resilience | Deferred | Projection is in-process domain work with no new remote dependency. | Preserve existing command failure/undo behavior; revisit only if ingredient classification later uses a remote inventory provider. |
| Protocols and boundaries | Present | State and command shapes flow through HTTP, Codex tools, Global ingress, events, and persistent tool readback. | Change the shared contract once and prove every ingress forwards it without a private grocery mapper. |

## Remediation routes

### 1. Ingredient projection is missing — must fix, class-level structural change

**Root pattern.** `Meal.ingredients` is canonical and has stable IDs, whereas
`GroceryItem` is a separately authored free-text record with optional
`mealIds`. `createWeekPlan`, recipe snapshot updates, sourced replacements,
instruction edits that call `linkInstructionInputs`, legacy imports, and
leftover replacement all permit a state where ingredients and groceries drift.

**Sibling extent.** The affected mutation paths are
`createWeekPlan`, `updateMealSnapshot`, `replaceMealRecipeFromSource`,
`addInstructionStep`, `updateInstructionStep`, and `assignLeftover`.
The changed model propagates through household contract/command registry,
bootstrap/import, dynamic tool descriptions, API/global readbacks, SQLite
workspace/undo/event/proposed-command/tool-result normalization, tests, docs,
and the grocery UI. `moveMeal`, status, timers, prep, archive/handoff, and
instruction reorder/removal do not alter canonical ingredient membership and
are sweep-confirmed out of this reconciliation set.

**Target boundary.** Make `Meal.ingredients` the sole ingredient source. Store
only a compact `GroceryIngredientState` keyed by `{ mealId, ingredientId }`:
`section`, `source`, and `checked`. Derive item name, amount, category row,
and the read-only recipe-summary link from the referenced meal/ingredient at
read/render time. One canonical ingredient occurrence gets one grocery row;
cross-recipe purchase aggregation is intentionally not introduced in this
pass because its quantity semantics are a separate product decision.

**Implementation stages.**

1. Change the household contract and validators so current grocery state has a
   required ingredient reference and no caller-owned name, amount, or
   `mealIds`. Add a pure, private reconciliation helper that creates defaults
   for new ingredients, preserves state for retained identity keys, and removes
   state for deleted ingredients.
2. Call that helper in the six mutation paths above, within the same domain
   transition and before the accepted event/readback is built. `assignLeftover`
   must remove the displaced meal’s ingredient states rather than trimming only
   `mealIds`.
3. Retire active `addGroceryItem`, content-replacing `updateGroceryItem`, and
   `removeGroceryItem`; retain `moveGroceryItemsToSource` and checked-state
   mutation against projected row IDs. Add the smallest explicit section
   classification command only if the existing UI still needs to change it.
   Update bootstrap, import, tool guidance, and all public schemas at the same
   time so no ingress keeps an alternate grocery authoring path.
4. Replace the Grocery view’s direct grocery-content rendering with a derived
   projection adapter. Keep compact rows and the read-only recipe summary; no
   manual Add form or editable grocery name/amount returns.
5. Migrate persisted workspace state, undo snapshots, event command/batch
   payloads, proposed commands, and tool-result envelopes through the one
   normalizer used by `sqlite-store`. Historical commands remain readable
   history, but cannot become current executable free-form grocery mutations.

**Resolved migration decision (2026-07-15).** Existing legacy rows can have
empty or multi-meal `mealIds`, so they cannot always be mapped safely to one
ingredient. Drop unmatched or ambiguous rows from the active grocery view while
keeping immutable historical events. The new contract forbids detached
groceries. An unambiguous exact meal-and-ingredient match may carry
section/source/checked automatically.

**Closure proof.**

- Domain tests create an ingredient-only week and assert one projected default
  row per canonical ingredient; update a recipe with lemon; replace from a
  source; add/edit an instruction that introduces an ingredient; and replace a
  meal with leftovers. Each proves exact membership plus retained source and
  checked state for unchanged `{mealId, ingredientId}` keys.
- Contract/API/Global tests reject retired free-form commands, accept
  classification commands, and read back projected groceries from every shared
  ingress.
- Real temporary SQLite tests open a legacy database containing workspace,
  undo, direct and batch events, proposed commands, and cached tool results;
  they prove idempotent migration, a successful subsequent command, restart,
  and undo state that still satisfies projection coverage.
- Playwright edits a recipe, saves a new ingredient, opens Groceries, and
  observes that ingredient plus its recipe summary after refresh/reload.

### 2. Grocery row event ordering is wrong — must fix, one class-level UI fix

**Root pattern.** The row’s `onMouseDown` enables selection mode before the
interactive-target guard inside `selectRow`. A child’s click-level
`stopPropagation` arrives too late; switching modes can unmount the checkbox
before its default toggle.

**Sibling extent.** Checkbox, recipe-summary link, source select, drag handle,
and delete share the same late-guard problem. The explicit selection button is
an intentional exception because it stops `mousedown` and opts into selection.
The only other current production ancestor pointer handlers are modal overlays
that correctly require `target === currentTarget`; no wider UI refactor is
needed.

**Route.** Extract one shared “row target is selectable” predicate and apply it
before changing `selectionMode` or selected IDs. The full non-control row
surface selects; explicit selection control preserves Enter/Space behavior;
checkbox, recipe summary, source, delete, and drag handle retain their own
action without changing selection state.

**Closure proof.** Playwright must cover full-card click, Shift range, Ctrl and
Meta toggle, explicit-selection Enter/Space, checkbox completion without bulk
mode, recipe summary without bulk mode, source change and delete without bulk
mode, and a two-item drag whose submitted command and destination-filter
readback retain both IDs.

### 3. Successful source moves look like data loss — must fix, direct UX change

**Root pattern.** The default To Buy filter intentionally hides non-Shop items;
an accepted move clears selection but gives no confirmation or path to the
destination. Prior QA therefore misclassified a successful source mutation as
a deletion.

**Sibling extent.** Dropdown and drag target both call the same move helper;
the domain changes only `source`, and the sole deletion path is the trash
command. The mobile E2E and domain test already prove retained identity under
the destination filter.

**Route.** On accepted bulk move, either switch to the destination filter or
show an assertive “Moved N to …” confirmation with a View action. Prefer the
confirmation plus View action so a user can continue working in To Buy without
an unexpected view switch.

**Closure proof.** Browser test asserts the move posts no remove command, the
row leaves To Buy for the expected reason, the confirmation names the count and
destination, View reaches the destination filter, and the same row ID/source is
present after refresh.

## Proof-bar assessment

This repo already has the required realistic-local infrastructure:

- pure domain transitions (`tests/domain-*.test.mjs`);
- real temporary SQLite files with restart, transaction, event, undo, and
  receipt coverage (`tests/store-*.test.mjs`);
- loopback HTTP application tests (`tests/http-*.test.mjs`);
- seeded Playwright authorities and axe checks (`tests/support/e2e-runtime.mjs`,
  `tests/e2e/*.spec.ts`).

The work crosses no new external service or missing stateful dependency, so
there is **no capability gap**. The missing tests are usage gaps in these
existing layers. A refused ad-hoc dev-server connection is not a proof
capability gap because the E2E harness starts its own disposable authority.

## Revised completion contract

**Prior contract:** groceries were compact source/provenance rows for an
active-week list, with manual grocery content still represented by the domain.

**Revised contract:** every selected-week canonical ingredient has exactly one
ingredient-keyed grocery execution record; no current command or UI can create,
rename, or delete a detached grocery. Ingredient-changing commands reconcile
that record atomically, classification survives retained identity, legacy data
is migrated according to the explicit disposition above, controls do not alter
selection accidentally, and moves communicate their filtered destination.

## Next-review readiness bar

Do not re-invoke review until all of the following are true:

1. The approved disposition removes unmatched or ambiguous legacy rows from the
   active view while preserving immutable historical events.
2. The shared contract, domain reconciler, all ingredient-changing siblings,
   ingress/tool/docs, and persistence normalizer move together; search confirms
   no active free-form grocery command or `mealIds` provenance model remains.
3. Domain, real SQLite restart/undo, HTTP/Global, and Playwright proof cells
   above are implemented and green, including touch/drag behavior and the
   false-deletion filter case.
4. `npm run typecheck`, `npm run lint`, production build, and the applicable
   deterministic suite pass against the final integrated worktree.
5. A final scoped `git status` and staged-diff read confirms the plan’s tests,
   fixtures, and docs are packaged with the implementation.

## Review remediation revision (2026-07-16)

The independent implementation review found three remaining must-fix defects.
They are in the frozen grocery-projection contract, not follow-up polish.

| Root pattern | Correct behavior | Class-level remediation | Proof |
| --- | --- | --- | --- |
| Ambiguous legacy state is order-sensitive | A legacy classification carries forward only when exactly one legacy row maps to one canonical `{ mealId, ingredientId }`; a duplicate exact mapping defaults to inferred section, Shop, and unchecked. | Track ambiguous identity keys during `normalizeLegacyGroceryProjection`; on a second match, delete the retained classification and permanently exclude that key from subsequent retention. Apply through the existing workspace/undo/payload normalizer only; event command JSON stays immutable. | Extend the real temporary SQLite migration fixture with two exact legacy rows carrying conflicting classification, then assert the reopened workspace and undo snapshot use the canonical default while the historical command payload is unchanged. |
| Projection cardinality contradicts accepted plan input | Every command-valid plan must project one grocery per canonical ingredient. The product has one dinner slot on each of seven days, so its executable maximum is 7 meals x 128 ingredient lines. | Align `MAX_MEALS_PER_WEEK` with the actual dinner-slot model, then define the grocery execution ceiling from `MAX_MEALS_PER_WEEK * MAX_INGREDIENT_LINES` and use that shared ceiling at schema, domain, bootstrap, move-batch, and historic-event validation sites. | Construct and execute a maximum-size seven-dinner `createWeekPlan`, assert acceptance, exact 896 grocery identities, and state validation; assert the command/schema rejects an eighth meal. |
| Combined range modifiers are not standard multi-select | Shift replaces with the anchor range; Ctrl/Meta+Shift unions that range with the existing selection, preserving the anchor. | Apply additive range selection in the one `selectRow` path without changing the existing control-target guard or checkbox behavior. | Extend the seeded mobile Playwright scenario to click a full non-control card surface, then prove Ctrl/Meta+Shift retains the pre-existing selection. Confirm with an Agent Browser gesture on the live app. |

The review identified no new ownership boundary or missing local-test capability.
The remedial work stays within the approved grocery projection and interaction
contract: no manual grocery authoring and no separate shopping-list model are
reintroduced.
