import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  materializeOccurrence,
  isIngredientOccurrenceEdit,
  isInstructionInputEdit,
  instructionInputCorrelationsAreUnique,
  occurrenceEditIdentitiesAreUnique,
  normalizedCoreIngredientLiteral,
  parseLegacyIngredientLine,
  resolveNewInstructionInput,
  validateOccurrencePartition,
} from "../lib/ingredient-occurrence.ts";

const create = (correlationId) => ({
  kind: "create", correlationId, source: null, amount: "2", unit: null,
  ingredient: "red pepper", qualifier: null, conceptId: null,
  canonicalIngredientId: null,
});

test("shared occurrence grammar bounds text and create correlations", () => {
  assert.equal(isIngredientOccurrenceEdit(create("new-pepper")), true);
  assert.equal(isIngredientOccurrenceEdit({ ...create("new-pepper"), ingredient: "x".repeat(1_001) }), false);
  assert.equal(isIngredientOccurrenceEdit({ ...create("new-pepper"), ingredient: "" }), false);
  assert.equal(isIngredientOccurrenceEdit({ ...create("new-pepper"), amount: "x".repeat(301) }), false);
  const inputs = [
    { kind: "create", correlationId: "new-pepper", amount: "1", ingredient: "pepper" },
    { kind: "create", correlationId: "new-pepper", amount: "2", ingredient: "pepper" },
  ];
  assert.equal(inputs.every(isInstructionInputEdit), true);
  assert.equal(instructionInputCorrelationsAreUnique(inputs), false);
  assert.equal(occurrenceEditIdentitiesAreUnique([create("same"), create("same")]), false);
});

test("explicit occurrence partitions retain only named IDs and create hard-coded new IDs", () => {
  assert.equal(validateOccurrencePartition(["pepper-a", "pepper-b"], [
    { kind: "retain", occurrenceId: "pepper-b", source: null, amount: "2", unit: null, ingredient: "red pepper", qualifier: null, conceptId: null },
    create("new-pepper"),
  ], ["pepper-a"]), null);
  assert.match(validateOccurrencePartition(["pepper-a"], [create("new-pepper")], []), /exactly once/);
  assert.match(validateOccurrencePartition(["pepper-a"], [
    { kind: "retain", occurrenceId: "pepper-a", source: null, amount: "2", unit: null, ingredient: "red pepper", qualifier: null, conceptId: null },
  ], ["pepper-a"]), /retained and removed/);
});

test("occurrence partition rejects every ambiguous identity class", () => {
  const retain = (occurrenceId) => ({
    kind: "retain", occurrenceId, source: null, amount: "2", unit: null,
    ingredient: "red pepper", qualifier: null, conceptId: null,
  });
  const cases = [
    { previous: ["a", "a"], edits: [retain("a")], removed: [], message: /Existing occurrence IDs/ },
    { previous: ["a"], edits: [retain("a"), retain("a")], removed: [], message: /retained occurrence ID/ },
    { previous: ["a"], edits: [], removed: ["a", "a"], message: /removed occurrence ID/ },
    { previous: [], edits: [create("new"), create("new")], removed: [], message: /create correlation/ },
    { previous: ["a"], edits: [retain("unknown")], removed: ["a"], message: /unknown occurrence ID/ },
    { previous: ["a"], edits: [], removed: ["unknown"], message: /unknown occurrence ID/ },
    { previous: ["a"], edits: [retain("a")], removed: ["a"], message: /retained and removed/ },
    { previous: ["a", "b"], edits: [retain("a")], removed: [], message: /exactly once/ },
  ];
  for (const { previous, edits, removed, message } of cases) {
    assert.match(validateOccurrencePartition(previous, edits, removed), message);
  }
  assert.equal(validateOccurrencePartition(["a", "b"], [retain("b"), retain("a"), create("new")], []), null);
  assert.equal(validateOccurrencePartition(["a", "b"], [], ["b", "a"]), null);
});

test("new instruction matching only reuses one normalized occurrence", () => {
  const input = { kind: "create", correlationId: "input-1", amount: "1", ingredient: " Red   Pepper " };
  const one = [materializeOccurrence(create("new-pepper"), "hard-coded-pepper-id")];
  assert.equal(resolveNewInstructionInput(input, one), "hard-coded-pepper-id");
  assert.equal(resolveNewInstructionInput(input, [...one, materializeOccurrence(create("two"), "hard-coded-pepper-id-2")]), null);
  assert.equal(normalizedCoreIngredientLiteral(" Red   Pepper "), "red pepper");
});

test("legacy parsing preserves source and recognizes only explicit units", () => {
  assert.deepEqual(parseLegacyIngredientLine("2 tbsp red pepper"), { source: "2 tbsp red pepper", amount: "2", unit: "tbsp", ingredient: "red pepper", qualifier: null });
  assert.deepEqual(parseLegacyIngredientLine("pinch red pepper"), { source: "pinch red pepper", amount: "", unit: null, ingredient: "pinch red pepper", qualifier: null });
});

test("runtime, bootstrap, and persistence share the occurrence parser and matcher authority", () => {
  for (const relativePath of [
    "../lib/household-domain.ts",
    "../lib/household-bootstrap.ts",
    "../lib/household-persistence-upgrade.ts",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.doesNotMatch(source, /function (?:legacy)?ingredient(?:LineParts|Key)\b/u, relativePath);
    assert.match(source, /ingredient-occurrence\.ts/u, relativePath);
  }
});
