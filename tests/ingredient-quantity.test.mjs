import assert from "node:assert/strict";
import test from "node:test";
import { deriveIngredientQuantity, projectWeeklyGroceryRequirements } from "../lib/ingredient-quantity.ts";

const occurrence = (overrides = {}) => ({
  occurrenceId: "onion-a", mealId: "meal-a", mealTitle: "Fried rice", ingredient: "green onion", qualifier: "sliced",
  amount: "1/3", unit: "cup", source: "1/3 cup sliced green onion", role: "weekly_requirement", concept: { id: "green-onion", label: "Green onion" },
  execution: { id: "grocery-a", section: "Produce", coverage: "shop", checked: false }, ...overrides,
});

test("structured amounts normalize exact integers, decimals, fractions, and counts without changing input", () => {
  const input = { amount: "0.125", unit: "kg" };
  assert.deepEqual(deriveIngredientQuantity(input), { kind: "quantity", dimension: "mass", quantity: { numerator: 1, denominator: 8 }, unit: "kg", display: "1/8 kg" });
  assert.deepEqual(input, { amount: "0.125", unit: "kg" });
  assert.deepEqual(deriveIngredientQuantity({ amount: "2", unit: null }), { kind: "quantity", dimension: "count", quantity: { numerator: 2, denominator: 1 }, unit: null, display: "2" });
});

test("ranges, modifiers, package units, and invalid fractions abstain while preserving literals", () => {
  for (const input of [
    { amount: "1-2", unit: "cup", source: "1-2 cups" },
    { amount: "about 1", unit: "cup", source: "about 1 cup" },
    { amount: "1", unit: "bunch", source: "1 bunch" },
    { amount: "1/0", unit: "cup", source: "1/0 cup" },
  ]) assert.equal(deriveIngredientQuantity(input).literal, input.source);
});

test("the bounded count, mass, and volume unit table is explicit and exact", () => {
  for (const [unit, dimension, canonical] of [
    [null, "count", null], ["count", "count", null], ["each", "count", null],
    ["mg", "mass", "mg"], ["g", "mass", "g"], ["kg", "mass", "kg"], ["oz", "mass", "oz"], ["lb", "mass", "lb"],
    ["tsp", "volume", "tsp"], ["tbsp", "volume", "tbsp"], ["fl oz", "volume", "fl oz"], ["cup", "volume", "cup"], ["mL", "volume", "mL"], ["L", "volume", "L"],
  ]) {
    const result = deriveIngredientQuantity({ amount: "1", unit });
    assert.equal(result.kind, "quantity");
    assert.equal(result.kind === "quantity" && result.dimension, dimension);
    assert.equal(result.kind === "quantity" && result.unit, canonical);
    assert.deepEqual(result.kind === "quantity" && result.quantity, { numerator: 1, denominator: 1 });
  }

  const projections = projectWeeklyGroceryRequirements([
    occurrence({ amount: "500", unit: "g", source: "500 g green onion" }),
    occurrence({ occurrenceId: "onion-b", amount: "0.5", unit: "kg", source: "0.5 kg green onion", execution: { id: "grocery-b", section: "Produce", coverage: "shop", checked: false } }),
  ]);
  assert.deepEqual(projections[0].quantities, [{ kind: "quantity", dimension: "mass", quantity: { numerator: 1000, denominator: 1 }, unit: "g", display: "1000 g" }]);
});

test("every cross-unit factor conserves its exact base-unit quantity", () => {
  const cases = [
    ["mg", "g", { numerator: 1, denominator: 1000 }],
    ["kg", "g", { numerator: 1000, denominator: 1 }],
    ["oz", "g", { numerator: 45359237, denominator: 1600000 }],
    ["lb", "g", { numerator: 45359237, denominator: 100000 }],
    ["tsp", "mL", { numerator: 5, denominator: 1 }],
    ["tbsp", "mL", { numerator: 15, denominator: 1 }],
    ["fl oz", "mL", { numerator: 473176473, denominator: 16000000 }],
    ["cup", "mL", { numerator: 250, denominator: 1 }],
    ["L", "mL", { numerator: 1000, denominator: 1 }],
  ];
  for (const [unit, baseUnit, expected] of cases) {
    const [group] = projectWeeklyGroceryRequirements([
      occurrence({ amount: "1", unit, source: `1 ${unit} green onion` }),
      occurrence({ occurrenceId: "onion-zero", amount: "0", unit: baseUnit, source: `0 ${baseUnit} green onion`, execution: { id: "grocery-zero", section: "Produce", coverage: "shop", checked: false } }),
    ]);
    assert.equal(group.quantities.length, 1, `${unit} remains one compatible total`);
    assert.deepEqual(group.quantities[0].kind === "quantity" && group.quantities[0].quantity, expected, `${unit} factor`);
    assert.equal(group.quantities[0].kind === "quantity" && group.quantities[0].unit, baseUnit, `${unit} base unit`);
  }
});

test("compatible subsets still total while incompatible singleton dimensions preserve literals", () => {
  const [group] = projectWeeklyGroceryRequirements([
    occurrence(),
    occurrence({ occurrenceId: "onion-b", mealId: "meal-b", mealTitle: "Salad", amount: "1", unit: "tbsp", source: "1 tbsp", execution: { id: "grocery-b", section: "Produce", coverage: "on_hand", checked: true } }),
    occurrence({ occurrenceId: "onion-c", mealId: "meal-c", mealTitle: "Tacos", amount: "2", unit: null, source: "2", execution: { id: "grocery-c", section: "Produce", coverage: "farm_box", checked: false } }),
  ]);
  assert.deepEqual(group.quantities, [
    { kind: "quantity", dimension: "volume", quantity: { numerator: 295, denominator: 3 }, unit: "mL", display: "98 1/3 mL" },
    { kind: "literal", literal: "2", reason: "incompatible" },
  ]);
});

test("unsupported literals remain visible beside compatible concept totals", () => {
  const [group] = projectWeeklyGroceryRequirements([
    occurrence(),
    occurrence({ occurrenceId: "onion-b", amount: "1", unit: "bunch", source: "1 bunch green onion", execution: { id: "grocery-b", section: "Produce", coverage: "shop", checked: false } }),
  ]);
  assert.deepEqual(group.quantities, [
    { kind: "quantity", dimension: "volume", quantity: { numerator: 1, denominator: 3 }, unit: "cup", display: "1/3 cup" },
    { kind: "literal", literal: "1 bunch green onion", reason: "unit" },
  ]);
});

test("projection filters non-requirements before grouping and leaves unresolved occurrences separate", () => {
  const projected = projectWeeklyGroceryRequirements([
    occurrence({ role: "output", occurrenceId: "stock" }),
    occurrence({ occurrenceId: "unknown-a", ingredient: "mystery greens", concept: null }),
    occurrence({ occurrenceId: "unknown-b", ingredient: "mystery greens", concept: null, execution: { id: "grocery-b", section: "Produce", coverage: "shop", checked: false } }),
  ]);
  assert.deepEqual(projected.map((group) => group.key), ["occurrence:unknown-a", "occurrence:unknown-b"]);
});

test("grouping is deterministic and execution state and provenance remain on children only", () => {
  const inputs = [
    occurrence(),
    occurrence({ occurrenceId: "onion-b", mealId: "meal-b", mealTitle: "Salad", execution: { id: "grocery-b", section: "Produce", coverage: "on_hand", checked: true } }),
    occurrence({ occurrenceId: "onion-pantry", execution: { id: "grocery-c", section: "Pantry", coverage: "shop", checked: false } }),
  ];
  const first = projectWeeklyGroceryRequirements(inputs);
  assert.deepEqual(projectWeeklyGroceryRequirements(inputs), first);
  assert.deepEqual(first.map((group) => group.key), ["concept:Pantry:green-onion", "concept:Produce:green-onion"]);
  assert.deepEqual(first[1].children.map(({ occurrenceId, mealId, mealTitle, coverage, checked }) => ({ occurrenceId, mealId, mealTitle, coverage, checked })), [
    { occurrenceId: "onion-a", mealId: "meal-a", mealTitle: "Fried rice", coverage: "shop", checked: false },
    { occurrenceId: "onion-b", mealId: "meal-b", mealTitle: "Salad", coverage: "on_hand", checked: true },
  ]);
  assert.equal("coverage" in first[1], false);
  assert.equal("checked" in first[1], false);
  assert.deepEqual(projectWeeklyGroceryRequirements([...inputs].reverse()), first);
});
