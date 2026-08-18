import assert from "node:assert/strict";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { isHouseholdCommand } from "../lib/household-command-contract.ts";
import { householdDomain, validateHouseholdState } from "../lib/household-domain.ts";
import { findIngredientCandidates, ingredientCandidateDigest, isIngredientCandidatePreview } from "../lib/ingredient-catalogue.ts";
import { createPlannerToolSuccess, isPlannerPreviewData, serializePlannerToolResult } from "../lib/planner-tool-contract.ts";

function fixture() {
  let counter = 0;
  const context = { now: Date.parse("2026-08-16T12:00:00Z"), createId: (prefix) => `${prefix}-${++counter}` };
  return { state: createCanonicalSeed(context), context };
}

function apply(state, command, context) {
  const result = householdDomain.execute(state, command, context);
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  return result;
}

test("single add is optimistic, targets its opaque occurrence, and preserves recipe literals through resolution", () => {
  const { state, context } = fixture();
  const week = state.weeks.find((candidate) => candidate.id === state.activeWeekId);
  const meal = week.data.meals[0];
  const result = apply(state, {
    type: "addIngredientOccurrence", weekId: week.id, mealId: meal.id,
    occurrence: { kind: "create", correlationId: "scallions", source: "2 scallions, sliced", amount: "2", unit: null, ingredient: "scallions", qualifier: "sliced", conceptId: null, canonicalIngredientId: null },
  }, context);
  const occurrenceId = result.occurrenceResolutions[0].occurrenceId;
  const added = result.state.weeks[0].data.meals[0].ingredients.find((candidate) => candidate.id === occurrenceId);
  assert.deepEqual(added, { id: occurrenceId, source: "2 scallions, sliced", amount: "2", unit: null, ingredient: "scallions", qualifier: "sliced", conceptId: "green-onion", role: "weekly_requirement", canonicalIngredientId: null });
  assert.equal(result.target, occurrenceId);
});

test("current canonical state requires an explicitly migrated catalogue", () => {
  const { state, context } = fixture();
  delete state.ingredientCatalogue;
  assert.equal(validateHouseholdState(state).ok, false);
  const result = householdDomain.execute(state, { type: "captureWeekLesson", weekId: state.activeWeekId, weekLesson: "No implicit catalogue." }, context);
  assert.equal(result.ok, false);
  assert.match(result.message, /stored household state is invalid/i);
});

test("candidate query is ordered, bounded, and carries digest plus catalogue revision", () => {
  const { state, context } = fixture();
  const inputs = [
    { correlationId: "first", amount: "2", ingredient: "scallions" },
    { correlationId: "second", amount: "1", ingredient: "red onion" },
  ];
  const result = apply(state, { type: "previewIngredientCandidates", inputs }, context);
  assert.deepEqual(result.state, state);
  assert.equal(result.ingredientCandidatePreview.catalogueRevision, state.ingredientCatalogue.revision);
  assert.equal(result.ingredientCandidatePreview.inputDigest, ingredientCandidateDigest(inputs));
  assert.deepEqual(result.ingredientCandidatePreview.results.map((entry) => entry.correlationId), ["first", "second"]);
  assert.equal(result.ingredientCandidatePreview.results[0].candidates[0].conceptId, "green-onion");
});

test("maximum occurrence amount remains valid from provider command through candidate response", () => {
  const { state, context } = fixture();
  const command = { type: "previewIngredientCandidates", inputs: [{ correlationId: "max-amount", amount: "x".repeat(300), ingredient: "rice" }] };
  assert.equal(isHouseholdCommand(command), true);
  const result = apply(state, command, context);
  assert.equal(isIngredientCandidatePreview(result.ingredientCandidatePreview), true);
});

test("maximum candidate batch stays inside the embedded result bound without re-echoing literals", () => {
  const { state, context } = fixture();
  const command = { type: "previewIngredientCandidates", inputs: Array.from({ length: 16 }, (_, index) => ({
    correlationId: `line-${index}-`.padEnd(200, "\0"), amount: `amount-${index}-`.padEnd(300, "\0"), ingredient: `ingredient-${index}-`.padEnd(1_000, "\0"),
  })) };
  assert.equal(isHouseholdCommand(command), true);
  const result = apply(state, command, context);
  const data = { status: "previewed", outcomes: [{ operationIndex: 0, summary: result.summary, target: result.target, changes: result.changes, occurrences: [], ingredientCandidatePreview: result.ingredientCandidatePreview }] };
  assert.equal(isPlannerPreviewData(data), true);
  assert.doesNotThrow(() => serializePlannerToolResult(createPlannerToolSuccess("max-candidate-batch", { plannerVersion: 0, syncRevision: 0 }, 1, data)));
});

test("inline concept creation, direct creation, vocabulary addition, and the max-16 query run through the domain", () => {
  const { state, context } = fixture();
  const week = state.weeks.find((candidate) => candidate.id === state.activeWeekId);
  const meal = week.data.meals[0];
  const occurrence = meal.ingredients[0];
  const inline = apply(state, {
    type: "resolveIngredientOccurrence", weekId: week.id, mealId: meal.id, occurrenceId: occurrence.id,
    decision: { kind: "create", preferredLabel: "Aleppo pepper", vocabulary: ["aleppo chilli"], defaultSection: "Pantry" },
  }, context);
  const inlineConceptId = inline.state.weeks[0].data.meals[0].ingredients[0].conceptId;
  assert.ok(inline.state.ingredientCatalogue.concepts.some(({ id }) => id === inlineConceptId));
  const direct = apply(inline.state, { type: "createIngredientConcept", conceptId: "sumac", preferredLabel: "Sumac", vocabulary: [], defaultSection: "Pantry" }, context);
  const vocabulary = apply(direct.state, { type: "addIngredientVocabulary", conceptId: "sumac", vocabulary: ["ground sumac"] }, context);
  const inputs = Array.from({ length: 16 }, (_, index) => ({ correlationId: `sumac-${index}`, amount: "1", ingredient: index === 0 ? "ground sumac" : `novel ingredient ${index}` }));
  const preview = apply(vocabulary.state, { type: "previewIngredientCandidates", inputs }, context);
  assert.equal(preview.ingredientCandidatePreview.results.length, 16);
  assert.deepEqual(preview.ingredientCandidatePreview.results[0].candidates[0], { conceptId: "sumac", preferredLabel: "Sumac", kind: "exact", reasons: ["accepted vocabulary"] });
});

test("ordered batch is bound to literal digest and catalogue revision", () => {
  const { state, context } = fixture();
  const week = state.weeks.find((candidate) => candidate.id === state.activeWeekId);
  const occurrences = week.data.meals[0].ingredients.slice(0, 2);
  const inputs = occurrences.map((occurrence, index) => ({ correlationId: `line-${index}`, occurrenceId: occurrence.id, amount: occurrence.amount, ingredient: occurrence.ingredient }));
  const accepted = apply(state, {
    type: "applyIngredientResolutionBatch", weekId: week.id,
    catalogueRevision: state.ingredientCatalogue.revision,
    inputDigest: ingredientCandidateDigest(inputs),
    decisions: inputs.map((input) => ({ ...input, decision: { kind: "unresolved" } })),
  }, context);
  assert.deepEqual(accepted.state.weeks[0].data.meals[0].ingredients.slice(0, 2).map(({ id, source, amount, unit, ingredient, qualifier }) => ({ id, source, amount, unit, ingredient, qualifier })), occurrences.map(({ id, source, amount, unit, ingredient, qualifier }) => ({ id, source, amount, unit, ingredient, qualifier })));
  const stale = householdDomain.execute(state, { type: "applyIngredientResolutionBatch", weekId: week.id, catalogueRevision: state.ingredientCatalogue.revision + 1, inputDigest: ingredientCandidateDigest(inputs), decisions: inputs.map((input) => ({ ...input, decision: { kind: "unresolved" } })) }, context);
  assert.equal(stale.ok, false);
  const tampered = householdDomain.execute(state, { type: "applyIngredientResolutionBatch", weekId: week.id, catalogueRevision: state.ingredientCatalogue.revision, inputDigest: ingredientCandidateDigest(inputs), decisions: inputs.map((input, index) => ({ ...input, amount: index ? input.amount : "changed", decision: { kind: "unresolved" } })) }, context);
  assert.equal(tampered.ok, false);
});

test("reviewed batch creates new occurrences in order and cannot cross its week boundary", () => {
  const { state, context } = fixture();
  const week = state.weeks.find((candidate) => candidate.id === state.activeWeekId);
  const meal = week.data.meals[0];
  const occurrence = { kind: "create", correlationId: "new-line", source: "3 scallions, sliced", amount: "3", unit: null, ingredient: "scallions", qualifier: "sliced", conceptId: null, canonicalIngredientId: null };
  const inputs = [{ correlationId: occurrence.correlationId, mealId: meal.id, source: occurrence.source, amount: occurrence.amount, unit: occurrence.unit, ingredient: occurrence.ingredient, qualifier: occurrence.qualifier, conceptId: occurrence.conceptId, canonicalIngredientId: occurrence.canonicalIngredientId }];
  const created = apply(state, {
    type: "applyIngredientResolutionBatch", weekId: week.id, catalogueRevision: state.ingredientCatalogue.revision,
    inputDigest: ingredientCandidateDigest(inputs),
    decisions: [{ correlationId: occurrence.correlationId, mealId: meal.id, occurrence, decision: { kind: "existing", conceptId: "green-onion" } }],
  }, context);
  assert.equal(created.occurrenceResolutions.length, 1);
  const added = created.state.weeks[0].data.meals[0].ingredients.at(-1);
  assert.deepEqual({ source: added.source, amount: added.amount, ingredient: added.ingredient, qualifier: added.qualifier, conceptId: added.conceptId }, { source: occurrence.source, amount: "3", ingredient: "scallions", qualifier: "sliced", conceptId: "green-onion" });

  const archived = structuredClone(week);
  archived.id = "2026-08-03";
  archived.weekStartDate = archived.id;
  archived.status = "archived";
  archived.data.meals[0].ingredients.push({ ...archived.data.meals[0].ingredients[0], id: "archived-only-occurrence" });
  state.weeks.push(archived);
  const foreign = archived.data.meals[0].ingredients.at(-1);
  const foreignInputs = [{ correlationId: "foreign", occurrenceId: foreign.id, amount: foreign.amount, ingredient: foreign.ingredient }];
  const rejected = householdDomain.execute(state, { type: "applyIngredientResolutionBatch", weekId: week.id, catalogueRevision: state.ingredientCatalogue.revision, inputDigest: ingredientCandidateDigest(foreignInputs), decisions: [{ ...foreignInputs[0], decision: { kind: "unresolved" } }] }, context);
  assert.equal(rejected.ok, false);
});

test("a later invalid batch decision rolls back earlier occurrence and concept creation", () => {
  const { state, context } = fixture();
  const week = state.weeks.find((candidate) => candidate.id === state.activeWeekId);
  const meal = week.data.meals[0];
  const occurrence = { kind: "create", correlationId: "new-spice", source: "1 tsp urfa pepper", amount: "1", unit: "tsp", ingredient: "urfa pepper", qualifier: null, conceptId: null, canonicalIngredientId: null };
  const inputs = [
    { correlationId: occurrence.correlationId, mealId: meal.id, source: occurrence.source, amount: occurrence.amount, unit: occurrence.unit, ingredient: occurrence.ingredient, qualifier: occurrence.qualifier, conceptId: occurrence.conceptId, canonicalIngredientId: occurrence.canonicalIngredientId },
    { correlationId: "missing", occurrenceId: "missing-occurrence", amount: "1", ingredient: "missing" },
  ];
  const result = householdDomain.execute(state, {
    type: "applyIngredientResolutionBatch", weekId: week.id, catalogueRevision: state.ingredientCatalogue.revision,
    inputDigest: ingredientCandidateDigest(inputs), decisions: [
      { correlationId: occurrence.correlationId, mealId: meal.id, occurrence, decision: { kind: "create", preferredLabel: "Urfa pepper", vocabulary: [], defaultSection: "Pantry" } },
      { ...inputs[1], decision: { kind: "unresolved" } },
    ],
  }, context);
  assert.equal(result.ok, false);
  assert.deepEqual(result.state, state);
});

test("rename and merge move concept references without rewriting active or archived literals", () => {
  const { state, context } = fixture();
  const week = state.weeks[0];
  const active = week.data.meals[0].ingredients[0];
  active.conceptId = "chicken-thigh";
  const archived = structuredClone(week);
  archived.id = "2026-08-03";
  archived.weekStartDate = "2026-08-03";
  archived.status = "archived";
  const shift = (value) => new Date(Date.parse(`${value}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  archived.data.meals.forEach((meal) => { meal.date = shift(meal.date); });
  archived.data.prepSessions.forEach((session) => { session.prepDate = shift(session.prepDate); });
  archived.data.leftovers.forEach((leftover) => { if (leftover.assignedDate) leftover.assignedDate = shift(leftover.assignedDate); });
  archived.data.meals[0].ingredients[0].conceptId = "chicken-thigh";
  state.weeks.push(archived);
  const before = state.weeks.map((candidate) => candidate.data.meals[0].ingredients[0]).map(({ id, source, amount, unit, ingredient, qualifier }) => ({ id, source, amount, unit, ingredient, qualifier }));
  const renamed = apply(state, { type: "renameIngredientConcept", conceptId: "chicken-thigh", preferredLabel: "Chicken thighs" }, context);
  assert.equal(findIngredientCandidates(renamed.state.ingredientCatalogue, [{ correlationId: "old-label", amount: "1", ingredient: "Chicken thigh" }])[0].candidates[0].kind, "exact");
  const merged = apply(renamed.state, { type: "mergeIngredientConcepts", survivorConceptId: "chicken-breast", mergedConceptIds: ["chicken-thigh"], collisionPolicy: "preferTarget" }, context);
  assert.deepEqual(merged.state.weeks.map((candidate) => candidate.data.meals[0].ingredients[0]).map(({ id, source, amount, unit, ingredient, qualifier }) => ({ id, source, amount, unit, ingredient, qualifier })), before);
  assert.deepEqual(merged.state.weeks.map((candidate) => candidate.data.meals[0].ingredients[0].conceptId), ["chicken-breast", "chicken-breast"]);
});

test("rename retains the old exact label and merge capacity obeys reject versus prefer-target", () => {
  const { state, context } = fixture();
  const renamed = apply(state, { type: "renameIngredientConcept", conceptId: "garlic", preferredLabel: "Fresh garlic" }, context);
  const oldLabel = findIngredientCandidates(renamed.state.ingredientCatalogue, [{ correlationId: "garlic", amount: "1", ingredient: "Garlic" }])[0];
  assert.deepEqual(oldLabel.candidates[0], { conceptId: "garlic", preferredLabel: "Fresh garlic", kind: "exact", reasons: ["accepted vocabulary"] });

  const milk = renamed.state.ingredientCatalogue.concepts.find(({ id }) => id === "milk");
  const butter = renamed.state.ingredientCatalogue.concepts.find(({ id }) => id === "butter");
  milk.vocabulary = Array.from({ length: 32 }, (_, index) => `milk alias ${index}`);
  butter.vocabulary = Array.from({ length: 32 }, (_, index) => `butter alias ${index}`);
  const rejected = householdDomain.execute(renamed.state, { type: "mergeIngredientConcepts", survivorConceptId: "milk", mergedConceptIds: ["butter"], collisionPolicy: "reject" }, context);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /capacity/);
  const preferred = apply(renamed.state, { type: "mergeIngredientConcepts", survivorConceptId: "milk", mergedConceptIds: ["butter"], collisionPolicy: "preferTarget" }, context);
  assert.equal(preferred.state.ingredientCatalogue.concepts.some(({ id }) => id === "butter"), false);
  assert.equal(preferred.state.ingredientCatalogue.concepts.find(({ id }) => id === "milk").vocabulary.length, 32);
  assert.ok(preferred.changes.some((change) => /omitted 33 overflow/i.test(change)));
});
