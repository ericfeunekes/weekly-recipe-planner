# Issue #4 — Disable source-faithful import until host admission exists

Source Issue: https://github.com/ericfeunekes/weekly-recipe-planner/issues/4

## Grounded contract

RR7 permits direct typed recipe replacement with an informational `SourceRecipe`, but source-faithful web import remains unavailable unless the host binds the accepted replacement to the exact observed candidate. The existing candidate helper is not on the native host path. This is one executable child issue: no persistence, source capture, review verdict, recipe authority, or release-state work is required.

## Chosen approach

Add a `host_admission_required` registry exposure to `replaceMealRecipeFromSource`. The embedded planner schema and field guide enumerate only commands whose host admission is currently available. The existing native host authorization rejects the withheld command before planner preview/apply. Keep the typed command, its schema, its direct service/HTTP/global informational-reference behavior, and all planner authority/domain cells unchanged.

This is smaller than wiring `authorizeEmbeddedSourcedReplacements`: the latter would require exactly the candidate capture/verdict/persistence scope the Issue excludes. No library or new abstraction is warranted; the existing command registry is the capability source of truth.

## Proof map

1. Merge: registry/model-schema tests show the native manifest omits sourced replacement; authorization and native-effect-host tests show preview/apply reject it before planner service invocation; existing direct typed replacement schema/domain tests remain green.
2. RC: commit the change, run the public-command disposable installed-candidate probe, and run the no-auth Codex capability probe to read back installed skills/config/capabilities against the selected candidate.
3. QA: use the synthetic local capability provider and outbound-negative assertion in the no-auth probe. It proves the unavailable host capability before any external page content is consumed; no web-import journey is run.

## Files and steps

1. `lib/household-command-contract.ts`: classify only sourced replacement as host-admission-required while preserving its typed schema and informational source contract.
2. `lib/planner-tool-contract.ts`: derive native model enums/field guide from currently admitted commands; reject host-admission-required commands with an explicit unavailable message.
3. `tests/planner-tool-contract.test.mjs` and `tests/codex-native-planner-effect.test.mjs`: prove the manifest omission, rejection, and no call to planner preview/apply while retaining typed validation.
4. `.agents/skills/recipe-discovery-import/SKILL.md`: make current unavailability frontmatter and procedure unambiguous without changing the future restoration condition.
5. Run targeted merge tests, the repository gate, then disposable RC/QA commands from the clean committed candidate.

## Recovery context and stop triggers

Worktree: `/private/tmp/weekly-recipe-planner-issue4`; branch: `codex/issue-4-host-admission`; base: `14849d0fb066aea031d18046ed1495dfcac0f9dd`. Stop if satisfying the native gate requires source capture, a reviewer verdict, candidate persistence, or changes to direct HTTP/global typed replacement. Independent challenge remains pending until the implementation exists.
