import assert from "node:assert/strict";
import test from "node:test";

import { projectGroceryRequirements } from "../lib/grocery-projection.ts";

const catalogue = { revision: 1, concepts: [{ id: "onion", preferredLabel: "Green onion", vocabulary: [], defaultSection: "Produce" }] };
const ingredient = (id, amount, unit, qualifier, conceptId = "onion", role = "weekly_requirement") => ({ id, source: `${amount}${unit ? ` ${unit}` : ""} ${qualifier ?? ""} green onion`.trim(), amount, unit, ingredient: "green onion", qualifier, conceptId, role, canonicalIngredientId: null });
const week = () => ({ id: "2026-08-24", weekStartDate: "2026-08-24", status: "active", data: { meals: [
  { id: "meal-a", date: "2026-08-24", title: "A", subtitle: "", venue: "Home", status: "planned", protein: "none", prepNote: "", leftoverNote: "", notes: "", ingredients: [ingredient("a", "1", "cup", "sliced"), ingredient("output", "1", "cup", null, "onion", "output")], instructions: [] },
  { id: "meal-b", date: "2026-08-25", title: "B", subtitle: "", venue: "Home", status: "planned", protein: "none", prepNote: "", leftoverNote: "", notes: "", ingredients: [ingredient("b", "1", "bunch", "trimmed"), ingredient("c", "2", null, null, null)], instructions: [] },
], prepSessions: [], groceries: [
  { id: "g-a", mealId: "meal-a", ingredientId: "a", section: "Produce", coverage: "shop", checked: false },
  { id: "g-output", mealId: "meal-a", ingredientId: "output", section: "Produce", coverage: "shop", checked: false },
  { id: "g-b", mealId: "meal-b", ingredientId: "b", section: "Produce", coverage: "farm_box", checked: false },
  { id: "g-c", mealId: "meal-b", ingredientId: "c", section: "Pantry", coverage: "needs_source", checked: false },
], leftovers: [], feedback: {}, weekLesson: "" } });

test("grocery projection filters children before grouping and preserves units, literals, provenance, and unclassified children", () => {
  const all = projectGroceryRequirements(week(), catalogue, "all");
  const produce = all.sections.find((section) => section.section === "Produce");
  assert.equal(produce.groups.length, 1);
  assert.deepEqual(produce.groups[0].quantities.map((part) => part.kind === "quantity" ? part.display : part.literal), ["1 cup sliced", "1 bunch trimmed green onion"]);
  assert.equal(produce.groups[0].children[0].amount.unit, "cup");
  assert.equal(produce.groups[0].children[0].sourceRecipe, null);
  const pantry = all.sections.find((section) => section.section === "Pantry");
  assert.equal(pantry.groups[0].label, "Unclassified");
  assert.equal(pantry.groups[0].children[0].executionId, "g-c");
  assert.equal(projectGroceryRequirements(week(), catalogue, "to_buy").sections[0].groups[0].children.length, 1);
  assert.equal(projectGroceryRequirements(week(), catalogue, "farm_box").sections[0].groups[0].children.length, 1);
  assert.equal(projectGroceryRequirements(week(), catalogue, "needs_source").sections[0].groups[0].label, "Unclassified");
});

test("shopping-relevant qualifiers remain separate even when the concept and unit match", () => {
  const state = week();
  state.data.meals[1].ingredients[0] = ingredient("b", "1", "cup", "whole");
  const groups = projectGroceryRequirements(state, catalogue, "all").sections.find((section) => section.section === "Produce").groups;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].quantities.map((part) => part.display), ["1 cup sliced", "1 cup whole"]);
});

test("grocery projection totals only compatible children while retaining package, form, and unresolved literals", () => {
  const state = week();
  state.data.meals[0].ingredients.push(
    ingredient("d", "2", "cup", "sliced"),
    ingredient("e", "1", "package", "sliced"),
  );
  state.data.meals[1].ingredients.push(ingredient("f", "half", null, null, null));
  state.data.groceries.push(
    { id: "g-d", mealId: "meal-a", ingredientId: "d", section: "Produce", coverage: "shop", checked: false },
    { id: "g-e", mealId: "meal-a", ingredientId: "e", section: "Produce", coverage: "shop", checked: false },
    { id: "g-f", mealId: "meal-b", ingredientId: "f", section: "Pantry", coverage: "needs_source", checked: false },
  );

  const all = projectGroceryRequirements(state, catalogue, "all");
  const produce = all.sections.find((section) => section.section === "Produce");
  const sliced = produce.groups.find((group) => group.label === "Green onion");
  assert.deepEqual(sliced.quantities.map((part) => part.kind === "quantity" ? part.display : part.literal), ["3 cup sliced", "1 package sliced green onion", "1 bunch trimmed green onion"]);
  assert.deepEqual(sliced.children.map((child) => child.executionId), ["g-a", "g-d", "g-e", "g-b"]);
  const unclassified = all.sections.find((section) => section.section === "Pantry").groups[0];
  assert.equal(unclassified.label, "Unclassified");
  assert.deepEqual(unclassified.children.map((child) => child.executionId), ["g-c", "g-f"]);
  assert.deepEqual(unclassified.quantities, []);
});
