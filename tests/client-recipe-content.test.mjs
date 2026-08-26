import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ingredientOccurrenceDisplayText } from "../lib/ingredient-occurrence.ts";

test("recipe occurrence display preserves source or composes every structured literal field", () => {
  assert.equal(ingredientOccurrenceDisplayText({
    id: "source-row", source: "1½ large fennel bulbs, sliced", amount: "1½", unit: "bulb",
    ingredient: "fennel", qualifier: "large, sliced", conceptId: null,
    role: "weekly_requirement", canonicalIngredientId: null,
  }), "1½ large fennel bulbs, sliced");
  assert.equal(ingredientOccurrenceDisplayText({
    id: "structured-row", source: null, amount: "3", unit: "tbsp", ingredient: "harissa paste",
    qualifier: "divided", conceptId: null, role: "weekly_requirement", canonicalIngredientId: null,
  }), "3 tbsp harissa paste divided");
});

test("Day, Prep, and recipe summary share canonical recipe instruction and ingredient renderers", async () => {
  const [planner, recipeContent, authoring] = await Promise.all([
    readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/planner-ui/recipe-content.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/planner-ui/ingredient-authoring.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(planner, /RecipeIngredientList, RecipeInstructionContent, RecipeProvenance/);
  assert.match(planner, /<IngredientAuthoring occurrences=\{draftOccurrences\}/);
  assert.match(planner, /function MealIngredientList\(/);
  assert.match(planner, /<MealIngredientList meal=\{meal\} week=\{week\} disabled=\{disabled\} mutate=\{mutate\}/);
  assert.match(planner, /<InstructionStepLine[\s\S]*?className="border-b border-border py-3/);
  assert.match(planner, /type: "setInstructionStepComplete", weekId: week\.id, stepId: step\.id/);
  assert.match(planner, /type: "editInstructionStep",/);
  assert.match(planner, /type: "addInstructionStep",/);
  assert.match(planner, /occurrenceId: input\.occurrenceId/);
  assert.match(planner, /correlationId: createRequestId\(\)/);
  assert.match(planner, /type: "editMealRecipe",/);
  assert.match(planner, /removedOccurrenceIds:/);
  assert.match(planner, /type: "setGroceryItemChecked", weekId: week\.id, itemId: item\.id, checked/);
  assert.match(recipeContent, /export function RecipeIngredientList/);
  assert.match(recipeContent, /export function RecipeInstructionContent/);
  assert.match(recipeContent, /export function RecipeProvenance/);
  assert.match(recipeContent, /Editable meal copy/);
  assert.match(recipeContent, /occurrenceId/);
  assert.match(recipeContent, /<RecipeIngredientList items=\{step\.inputs\} variant="step"/);
  assert.match(authoring, /export function IngredientAuthoring/);
  assert.match(authoring, /occurrenceId/);
  assert.match(authoring, /correlationId/);
  assert.match(authoring, /Remove ingredient \$\{index \+ 1\} and linked instruction inputs/);
});
