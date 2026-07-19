# Ingredient UX forces register

Behavior under consideration: the household and Codex enter literal recipe and
instruction ingredient lines, resolve them to shared household food concepts,
normalize only safe measurements, and shop from a grouped but fully traceable
weekly projection without losing recipe wording or execution state.

| Force | Status | Evidence in the behavior | Resolution decision |
| --- | --- | --- | --- |
| State and lifecycle | present | An occurrence can remain unresolved, resolve to a household concept, be corrected later, or survive a concept rename/merge while active grocery work exists. | Keep occurrence identity stable through resolution changes; make unresolved valid; concept merge/retirement preserves redirects, active references, history, and undo rather than hard deletion. Capture in `docs/functional-spine.md` ingredient acceptance outcomes. |
| Persistence | present | Household concepts, accepted vocabulary, occurrence resolutions, and Shop/Farm box/On hand/check state must survive restart and be shared by UI and Codex. | The planner data store is the sole durable authority and uses the existing transactional/versioned/evented mutation boundary. Rendered groups and matcher output are not stores. |
| Contracts and validation | present | Free-form single/list input, ambiguous names, unknown quantities, and stale reviewed batches cross UI and Codex boundaries. | Boundary parsing preserves every literal, returns one bounded result per input, supports explicit unresolved/new-concept outcomes, and binds apply to the reviewed input and current authority version. Invalid or stale apply has zero partial effect. |
| Internal typing | present | Recipe occurrence, household concept, instruction use, grocery execution row, measurement dimension, and prepared output are confusable identities that must not be interchanged. | Architecture must preserve distinct internal identities and typed quantity dimensions after boundary parsing; concept grouping never substitutes for occurrence or grocery execution identity. |
| Concurrency | present | UI, embedded Codex, Global Codex, and another browser can resolve ingredients or alter a meal/catalogue from the same base state. | Reuse the single OCC/idempotency/atomic batch authority; stale review conflicts and authoritative readback preserve reviewed intent without a second matcher-owned retry system. |
| Caching | absent | Household lookup is local and correctness requires the current concept catalogue and planner version before preview/apply. | No semantic match cache or stale catalogue read model is introduced. Pure recomputation is preferred until measured cost proves otherwise. |
| Failure and resilience | deferred | The first matcher and converter are deterministic/local and do not call an external food service; unsupported conversion is ordinary domain uncertainty. | Abstain and preserve literals instead of retrying or guessing. Revisit retry/circuit-breaker behavior only if a fallible external catalogue or conversion provider is later introduced. |
| Protocols and boundaries | present | UI and Codex must preview the same ordered list and apply the same reviewed decisions while recipe, instruction, grocery, and archive projections remain coherent. | One shared typed preview/apply contract crosses every ingress, with bounded inputs, stable per-input correlation, version/input binding, atomic effects, and authoritative readback. |

Deferred pressures are a universal ontology, nutrition/allergen inference, store
SKU/package optimization, density/yield knowledge, and automatic prepared-output
dependency scheduling. They must not shape the first delivery graph.
