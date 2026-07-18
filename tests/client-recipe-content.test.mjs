import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Day, Prep, and recipe summary share canonical recipe instruction and ingredient renderers", async () => {
  const [planner, recipeContent] = await Promise.all([
    readFile(new URL("../app/planner-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/planner-ui/recipe-content.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(planner, /import \{ RecipeIngredientList, RecipeInstructionContent \} from "@\/components\/planner-ui\/recipe-content"/);
  assert.match(planner, /function MealIngredientList\(/);
  assert.match(planner, /<MealIngredientList meal=\{meal\} week=\{week\} disabled=\{disabled\} mutate=\{mutate\}/);
  assert.match(planner, /<InstructionStepLine[\s\S]*?className="border-b border-border py-3/);
  assert.match(planner, /type: "setInstructionStepComplete", weekId: week\.id, stepId: step\.id/);
  assert.match(planner, /type: "setGroceryItemChecked", weekId: week\.id, itemId: item\.id, checked/);
  assert.match(recipeContent, /export function RecipeIngredientList/);
  assert.match(recipeContent, /export function RecipeInstructionContent/);
  assert.match(recipeContent, /<RecipeIngredientList items=\{step\.inputs\} variant="step"/);
});
