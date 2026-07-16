import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COMMAND_TEXT_LENGTH,
  MAX_INGREDIENT_LINE_LENGTH,
  MAX_INGREDIENT_LINES,
  MAX_STEP_INPUTS,
} from "../lib/household-command-contract.ts";
import {
  hasValidationIssues,
  validateMealDraft,
  validateStepDraft,
} from "../app/planner-validation.ts";

test("step draft validation reports the exact field that exceeds shared limits", () => {
  assert.deepEqual(validateStepDraft({
    inputs: "1 cup | rice",
    instruction: "Rinse the rice.",
    timerMinutes: "12",
  }), {});

  const issues = validateStepDraft({
    inputs: Array.from({ length: MAX_STEP_INPUTS + 1 }, () => "1 | item").join("\n"),
    instruction: "x".repeat(MAX_COMMAND_TEXT_LENGTH + 1),
    timerMinutes: "1441",
  });
  assert.match(issues.inputs, /no more than 32 amount lines/i);
  assert.match(issues.instruction, /4,000 characters or fewer/i);
  assert.match(issues.timer, /no more than 1,440 minutes/i);
  assert.match(
    validateStepDraft({ inputs: "", instruction: "Stir.", timerMinutes: "0.25" }).timer,
    /at least 0.5/i,
  );
  assert.equal(hasValidationIssues(issues), true);
});

test("meal draft validation covers required fields and per-line ingredient limits", () => {
  const base = {
    title: "Dinner",
    subtitle: "",
    venue: "Home",
    prepNote: "",
    leftoverNote: "",
    notes: "",
    ingredients: "rice\nwater",
  };
  assert.deepEqual(validateMealDraft(base), {});
  assert.match(validateMealDraft({ ...base, title: "" }).title, /meal title/i);
  assert.match(validateMealDraft({ ...base, venue: "" }).venue, /where this meal/i);
  assert.match(
    validateMealDraft({ ...base, ingredients: "x".repeat(MAX_INGREDIENT_LINE_LENGTH + 1) }).ingredients,
    /ingredient line 1/i,
  );
  assert.match(
    validateMealDraft({
      ...base,
      ingredients: Array.from({ length: MAX_INGREDIENT_LINES + 1 }, () => "item").join("\n"),
    }).ingredients,
    /no more than 128 ingredient lines/i,
  );
});
