import {
  MAX_COMMAND_TEXT_LENGTH,
  MAX_GROCERY_ITEM_LENGTH,
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

export type ValidationIssues = Record<string, string>;
const MIN_TIMER_MINUTES = 0.5;

function limitMessage(label: string, limit: number): string {
  return `${label} must be ${limit.toLocaleString("en-CA")} characters or fewer.`;
}

export function hasValidationIssues(issues: ValidationIssues): boolean {
  return Object.keys(issues).length > 0;
}

export function validateStepDraft(input: {
  inputs: string;
  instruction: string;
  timerMinutes: string;
}): ValidationIssues {
  const issues: ValidationIssues = {};
  const instruction = input.instruction.trim();
  if (!instruction) issues.instruction = "Enter an instruction.";
  else if (instruction.length > MAX_COMMAND_TEXT_LENGTH) {
    issues.instruction = limitMessage("Instruction", MAX_COMMAND_TEXT_LENGTH);
  }

  const lines = input.inputs.split("\n").filter((line) => line.trim());
  if (lines.length > MAX_STEP_INPUTS) {
    issues.inputs = `Use no more than ${MAX_STEP_INPUTS} amount lines.`;
  } else {
    const invalidLine = lines.findIndex((line) => {
      const [amount, ...ingredient] = line.split("|");
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

export function validateGroceryDraft(input: {
  item: string;
  detail: string;
}): ValidationIssues {
  const issues: ValidationIssues = {};
  const item = input.item.trim();
  if (!item) issues.item = "Enter a grocery item.";
  else if (item.length > MAX_GROCERY_ITEM_LENGTH) {
    issues.item = limitMessage("Grocery item", MAX_GROCERY_ITEM_LENGTH);
  }
  if (input.detail.trim().length > MAX_COMMAND_TEXT_LENGTH) {
    issues.detail = limitMessage("Grocery detail", MAX_COMMAND_TEXT_LENGTH);
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
  ingredients: string;
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

  const ingredients = input.ingredients.split("\n").filter((line) => line.trim());
  if (ingredients.length > MAX_INGREDIENT_LINES) {
    issues.ingredients = `Use no more than ${MAX_INGREDIENT_LINES} ingredient lines.`;
  } else {
    const invalidLine = ingredients.findIndex(
      (line) => line.trim().length > MAX_INGREDIENT_LINE_LENGTH,
    );
    if (invalidLine >= 0) {
      issues.ingredients = `Ingredient line ${invalidLine + 1} must be ${MAX_INGREDIENT_LINE_LENGTH.toLocaleString("en-CA")} characters or fewer.`;
    }
  }
  return issues;
}
