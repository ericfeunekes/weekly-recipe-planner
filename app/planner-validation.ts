import {
  MAX_COMMAND_TEXT_LENGTH,
  MAX_INGREDIENT_LINE_LENGTH,
  MAX_INGREDIENT_LINES,
  MAX_MEAL_SUBTITLE_LENGTH,
  MAX_MEAL_TITLE_LENGTH,
  MAX_MEAL_VENUE_LENGTH,
  MAX_STEP_INPUT_AMOUNT_LENGTH,
  MAX_STEP_INPUT_INGREDIENT_LENGTH,
  MAX_STEP_INPUTS,
  MAX_TIMER_DURATION_SECONDS,
} from "../lib/household-command-contract.ts";
import {
  MAX_OCCURRENCE_AMOUNT_LENGTH,
  MAX_OCCURRENCE_LITERAL_LENGTH,
} from "../lib/ingredient-occurrence.ts";

export type ValidationIssues = Record<string, string>;
const MIN_TIMER_MINUTES = 0.5;

/**
 * The recipe editor keeps these fields as rows rather than flattening them
 * back into display text. `occurrenceId` and `correlationId` are deliberately
 * not validated here: they are opaque command identities owned by the
 * occurrence command validator.
 */
export type IngredientOccurrenceDraft = {
  source: string;
  amount: string;
  unit: string;
  ingredient: string;
  qualifier: string;
};

export type InstructionInputDraft = {
  amount: string;
  ingredient: string;
};

function limitMessage(label: string, limit: number): string {
  return `${label} must be ${limit.toLocaleString("en-CA")} characters or fewer.`;
}

export function hasValidationIssues(issues: ValidationIssues): boolean {
  return Object.keys(issues).length > 0;
}

export function validateStepDraft(input: {
  inputs: string | readonly InstructionInputDraft[];
  instruction: string;
  timerMinutes: string;
}): ValidationIssues {
  const issues: ValidationIssues = {};
  const instruction = input.instruction.trim();
  if (!instruction) issues.instruction = "Enter an instruction.";
  else if (instruction.length > MAX_COMMAND_TEXT_LENGTH) {
    issues.instruction = limitMessage("Instruction", MAX_COMMAND_TEXT_LENGTH);
  }

  const lines = typeof input.inputs === "string"
    ? input.inputs.split("\n").filter((line) => line.trim())
    : input.inputs;
  if (lines.length > MAX_STEP_INPUTS) {
    issues.inputs = `Use no more than ${MAX_STEP_INPUTS} amount lines.`;
  } else {
    const invalidLine = lines.findIndex((line) => {
      const [amount, ...ingredient] = typeof line === "string"
        ? line.split("|")
        : [line.amount, line.ingredient];
      return amount.trim().length > MAX_STEP_INPUT_AMOUNT_LENGTH ||
        ingredient.join("|").trim().length > MAX_STEP_INPUT_INGREDIENT_LENGTH;
    });
    if (invalidLine >= 0) {
      issues.inputs = `Amount line ${invalidLine + 1} is too long. Keep the amount under ${MAX_STEP_INPUT_AMOUNT_LENGTH} characters and the ingredient under ${MAX_STEP_INPUT_INGREDIENT_LENGTH.toLocaleString("en-CA")}.`;
    }
  }

  if (input.timerMinutes.trim()) {
    const minutes = Number(input.timerMinutes);
    const maximumMinutes = MAX_TIMER_DURATION_SECONDS / 60;
    if (!Number.isFinite(minutes) || minutes < MIN_TIMER_MINUTES || minutes > maximumMinutes) {
      issues.timer = `Timer must be at least ${MIN_TIMER_MINUTES} and no more than ${maximumMinutes.toLocaleString("en-CA")} minutes.`;
    }
  }
  return issues;
}

export function validateMealDraft(input: {
  title: string;
  subtitle: string;
  venue: string;
  prepNote: string;
  leftoverNote: string;
  notes: string;
  ingredients: string | readonly IngredientOccurrenceDraft[];
}): ValidationIssues {
  const issues: ValidationIssues = {};
  const title = input.title.trim();
  const venue = input.venue.trim();
  if (!title) issues.title = "Enter a meal title.";
  else if (title.length > MAX_MEAL_TITLE_LENGTH) {
    issues.title = limitMessage("Title", MAX_MEAL_TITLE_LENGTH);
  }
  if (!venue) issues.venue = "Enter where this meal will be served.";
  else if (venue.length > MAX_MEAL_VENUE_LENGTH) {
    issues.venue = limitMessage("Venue", MAX_MEAL_VENUE_LENGTH);
  }
  if (input.subtitle.trim().length > MAX_MEAL_SUBTITLE_LENGTH) {
    issues.subtitle = limitMessage("Subtitle", MAX_MEAL_SUBTITLE_LENGTH);
  }
  for (const [field, label, value] of [
    ["prepNote", "Prep note", input.prepNote],
    ["leftoverNote", "Leftover note", input.leftoverNote],
    ["notes", "Recipe note", input.notes],
  ] as const) {
    if (value.trim().length > MAX_COMMAND_TEXT_LENGTH) {
      issues[field] = limitMessage(label, MAX_COMMAND_TEXT_LENGTH);
    }
  }

  const ingredients = typeof input.ingredients === "string"
    ? input.ingredients.split("\n").filter((line) => line.trim())
    : input.ingredients;
  if (ingredients.length > MAX_INGREDIENT_LINES) {
    issues.ingredients = `Use no more than ${MAX_INGREDIENT_LINES} ingredient lines.`;
  } else if (typeof input.ingredients !== "string") {
    const invalidRow = input.ingredients.findIndex((ingredient) =>
      ingredient.ingredient.trim().length === 0 ||
      ingredient.amount.length > MAX_OCCURRENCE_AMOUNT_LENGTH ||
      [ingredient.source, ingredient.unit, ingredient.ingredient, ingredient.qualifier]
        .some((field) => field.length > MAX_OCCURRENCE_LITERAL_LENGTH)
    );
    if (invalidRow >= 0) {
      issues.ingredients = `Ingredient row ${invalidRow + 1} needs a core ingredient, an amount of ${MAX_OCCURRENCE_AMOUNT_LENGTH.toLocaleString("en-CA")} characters or fewer, and other fields of ${MAX_OCCURRENCE_LITERAL_LENGTH.toLocaleString("en-CA")} characters or fewer.`;
    }
  } else {
    const invalidLine = input.ingredients.split("\n").filter((line) => line.trim()).findIndex(
      (line) => line.trim().length > MAX_INGREDIENT_LINE_LENGTH,
    );
    if (invalidLine >= 0) {
      issues.ingredients = `Ingredient line ${invalidLine + 1} must be ${MAX_INGREDIENT_LINE_LENGTH.toLocaleString("en-CA")} characters or fewer.`;
    }
  }
  return issues;
}
