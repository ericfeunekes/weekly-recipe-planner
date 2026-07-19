# Ingredient UX phase proposal

Status: formed proposal for challenge and user interview; no GitHub work items have been created or changed.

## Position

Design ingredient identity, measurement handling, instruction linking, and grocery projection as one coherent cross-surface model, then deliver it through one enabling foundation and two independently provable product phases. The foundation separates meal-local recipe wording from household ingredient identity and derived shopping state. After that contract exists, authoring/cooking surfaces and the grocery shopper surface can fan out without making either UI the source of truth.

## Locked invariants

1. **Recipe wording remains literal truth.** A household match, rename, merge, or matcher change cannot rewrite the amount/name saved on a meal-local ingredient occurrence. Source: `docs/functional-spine.md`, “Ingredient Identity, Measurements, And Instruction Use.”
2. **Instruction editing stays fast and line-oriented.** Preserve the current `amount | ingredient` interaction and its ability to reuse or add a recipe occurrence; canonical resolution works behind it rather than requiring a picker. Source: Eric's live-UI decision and `docs/functional-spine.md`, ING-5.
3. **Unsupported conversion is visible, not guessed.** Standard compatible quantities may total; non-standard or incompatible requirements such as `1 bunch` and `1/3 cup sliced` are concatenated for the shopper. Ingredient-specific conversion can come later. Source: Eric's correction and `docs/functional-spine.md`, ING-3.
4. **Groceries cover weekly requirements, not every named material.** Prepared components, outputs, finished dishes, leftovers, and reserved portions do not project merely because a step names them. Weekly requirements remain visible as `Needs source`, `Shop`, `Farm box`, or `On hand`; only Shop is a purchase. Source: audited live Groceries behavior and `docs/functional-spine.md`, ING-4.
5. **One mutation authority serves every ingress.** UI, embedded Codex, and Global Codex use the same typed, versioned, idempotent planner authority; rendered groups, routes, and browser state are not durable owners. Source: `docs/functional-spine.md`, Mutations and ING-6.
6. **Touched UI becomes route-ready shared UI, within scope.** During the planned TanStack Router migration, touched reusable controls/views leave `planner-client.tsx`; route files compose them and do not acquire planner state authority. Extraction is limited to the ingredient surfaces changed by this outcome. Source: `AGENTS.md`, UI system.

## Architecture grounding

### Current shape

- `RecipeIngredient` is a stable object on a meal, but its normalized name currently drives recipe-line deduplication, instruction linking, and grocery projection.
- `household-domain.ts` owns command validation/execution and the ingredient-to-grocery reconciliation. `household-persistence-upgrade.ts` and `household-bootstrap.ts` each contain another ingredient key/parser for legacy normalization.
- Every meal ingredient is required to have one grocery execution row. There is no separate grocery-eligibility concept and no household ingredient catalogue.
- `planner-client.tsx` owns the recipe textarea, instruction amount textarea, and grocery rendering. `components/planner-ui/recipe-content.tsx` already provides a shared read renderer for recipe/day/prep instruction content.
- The command registry and planner tool contract already provide the shared UI/Codex mutation boundary and optimistic-concurrency/idempotency conventions to extend.

### Forces

The detailed forces register is in `scratch/ingredient-ux-phase-planning/forces.md`. The load-bearing forces are stable occurrence identity, unresolved/resolved concept lifecycle, literal preservation, stale batch review, atomic apply, cross-ingress parity, restart-safe persistence, and explicit abstention for unsupported measurement conversions.

### Target ownership and dependency direction

1. **Ingredient semantics** are pure domain functions: literal parsing, safe normalized measurement, candidate scoring/explanation, and grocery-group read-model construction. They do not persist state or mutate planner records.
2. **Planner domain authority** owns the curated starter concepts and household additions/vocabulary, occurrence resolution, typed requirement/output/leftover role, grocery coverage/source and section/check execution state, version checks, events, undo, optimistic single-add correction, and atomic batch apply.
3. **Persistence upgrade** calls the canonical semantic/domain rules and preserves occurrence IDs and literal text. It does not keep an independent matcher/parser implementation.
4. **Shared application contracts** expose pure preview and version-bound apply to the UI and both Codex surfaces. A batch response preserves input order and returns one outcome per input.
5. **Shared ingredient UI** preserves the existing text editors, adds non-blocking candidate/review affordances, and renders grouped shopping requirements with child provenance. Route components only compose these controls.

Dependency direction: presentation and Codex adapters -> typed planner application contract -> planner domain authority -> pure ingredient semantics and household contracts. Persistence is an adapter around the same domain model, not a second semantic owner.

### Deliberate non-architecture

No external matching service, semantic-vector store, second database, cache, universal ontology, nutrition model, store-SKU catalogue, package optimizer, density/yield engine, or automatic instruction material graph is introduced. Edit distance may contribute to candidate ranking but is not itself the identity rule.

## Proposed issue graph

### Parent outcome — Make ingredients coherent from recipe entry through shopping and cooking

A household can enter familiar recipe wording, recognize equivalent ingredients across meals, keep useful ambiguity unresolved, use ingredients in instruction steps, and shop a grouped traceable list without prepared outputs or false conversions. The parent closes only when the foundation and both product phases pass the cross-surface UI/Codex/restart journey.

### Phase 1 — Establish household ingredient identity and safe quantity semantics

**Outcome:** The planner can preserve a meal's literal ingredient occurrences while resolving them to shared household concepts, suggesting reversible corrections after a single add, preflighting and atomically applying a reviewed batch, normalizing only safe compatible measurements, and explicitly classifying ingredient execution role and grocery coverage.

**Why it is independently provable:** Domain, persistence, HTTP/tool-contract, concurrency, event/undo, and restart tests can prove this without shipping either final presentation. The contract is useful to both downstream surfaces and removes the current three-way overload of normalized recipe names.

**Scope:** An app-provided curated starter concept catalogue with household additions/vocabulary and default shopping sections; stable occurrence links; unresolved/resolved/renamed/merged lifecycle; optimistic single add with reversible in-place suggestions; bounded-list preflight; explainable candidate results with edit distance as one signal; version-bound atomic batch apply; partial measurement normalization; typed requirement/output/leftover role; `Needs source`/Shop/Farm box/On hand coverage; safe migration preserving literals, IDs, instruction links, and grocery execution state; removal of duplicated semantic ownership.

**Excludes:** Final ingredient editor/review presentation, final grouped grocery presentation, ingredient-specific conversions, package optimization, and a prepared-material graph.

**Proof:** ING-01 through ING-04 and ING-07/08 at domain/contract/persistence boundaries; restart and stale-review evidence; architecture closure showing one matcher/parser authority and no alternate UI/Codex mutation path.

**Blocks:** Phase 2 and Phase 3.

### Phase 2 — Improve ingredient authoring and cooking-context UX

**Outcome:** A household can keep typing recipe ingredients and instruction amounts in the existing compact line-oriented interactions, receive calm non-blocking match/review help outside the protected step editor, add missing step ingredients once, and read ingredient context consistently in Week, Recipe, Day, and Prep.

**Why it is independently provable:** It has a distinct user contract and viewport/accessibility proof boundary. It consumes Phase 1 but does not depend on grocery grouping.

**Scope:** Extract the touched recipe ingredient editor and shared ingredient presentation from `planner-client.tsx`; retain text-first recipe editing; show post-add suggestions and batch exception review in recipe entry/import without forcing resolution; treat the existing instruction-step editor as a protected regression surface and only wire identity resolution behind its unchanged `amount | ingredient` interaction; fix recipe-drawer ingredient layout/overflow; make recipe provenance clear where Prep ingredient/step context otherwise becomes ambiguous; add the bounded bought/Farm box/leftover discoverability cue identified on Week; reuse the existing canonical read components across Week, Recipe, Day, and Prep.

**Excludes:** New route state authority, picker-only entry, grocery grouping, recipe-library management, and automatic prep scheduling.

**Proof:** ING-02, ING-03, and ING-06 plus mobile/tablet/desktop and keyboard/accessibility evidence on Week, Recipe, Day, and Prep; UI and Codex readback agree after review/apply.

**Depends on:** Phase 1. May run in parallel with Phase 3 after the shared contracts settle.

### Phase 3 — Replace grocery occurrence noise with a shopper-readable projection

**Outcome:** Groceries show every weekly ingredient requirement with explicit coverage, grouped by household ingredient concept, with compatible quantities totaled, incompatible/non-standard literals concatenated, Shop isolated as `To buy`, and every contributing meal, source, section, and check state still operable.

**Why it is independently provable:** It owns the shopper journey and derived-projection rules. It consumes Phase 1 but does not depend on authoring-surface rollout.

**Scope:** Project only weekly-requirement occurrences; build a grouped read model without creating group-owned durable state; show compatible totals and visible literal requirements such as `1 bunch + 1/3 cup sliced`; retain contributing meals and stable child identities; expose `Needs source`, correct Shop/Farm box/On hand filters, and make concept-default sections correctable without resetting existing row classification; route edits back to recipe occurrence or grocery-owned classification; extract the touched grocery controls/view from `planner-client.tsx`.

**Excludes:** General household shopping, pantry quantities, group records as a second execution authority, store packages/SKUs, automatic optimal purchase quantities, and unsupported conversions.

**Proof:** ING-04/05 and GROC-01 through GROC-10 across domain projection, HTTP/tool parity, two-client state, responsive UI, filters, provenance navigation, restart, and undo.

**Depends on:** Phase 1. May run in parallel with Phase 2 after the shared contracts settle.

## Decisions reserved for Eric's interview

1. How broad the app-provided starter catalogue should be and how its curated labels/default sections are maintained alongside household additions.
2. Whether a grouped grocery heading has a bulk check/source action or remains a presentation-only heading over independently actionable requirements.
3. Whether existing ingredients migrate as weekly requirements by default and are reviewed, or migration attempts an automatic initial exclusion of prepared outputs.

## Proof map

- Domain contracts and transitions: identity lifecycle, measurement abstention, eligibility, projection, merge preservation.
- Store/persistence: migration, restart, atomic batch apply, event/undo, stable archived literals.
- HTTP and Codex contracts: equivalent post-add suggestion/correction and ordered batch preflight/apply semantics, version conflicts, idempotent receipts.
- Client contracts: text-first editor remains authoritative interaction; grouped rows retain child action identity.
- Representative household journey: enter/import -> review candidates -> add to step -> plan/prep -> grocery projection -> source/check -> reload/undo.
- Architecture closure: no independent browser matcher authority, no duplicate ingredient parser in bootstrap or migration, no independently editable grocery copy, and touched route files only compose shared components.

## Challenge disposition

Pending independent challenge. This section must be replaced with accepted, rebutted, deferred, and unresolved findings before the phase cut is presented for approval.
