import {
  FEEDBACK_VALUES,
  GROCERY_SOURCES,
  LEFTOVER_QUALITIES,
  MEAL_STATUSES,
  isIsoDate,
  isWeekId,
  type FeedbackValue,
  type GrocerySource,
  type GroceryCoverage,
  type InstructionStepContentInput,
  type InstructionStepPlanInput,
  type IsoDate,
  type LeftoverQuality,
  type MealSnapshotInput,
  type MealStatus,
  type WeekId,
  type WeekPlanInput,
  type OccurrenceAwareWeekPlanInput,
} from "./household-contract.ts";
import {
  isIngredientOccurrenceEdit,
  isInstructionInputEdit,
  instructionInputCorrelationsAreUnique,
  MAX_OCCURRENCE_AMOUNT_LENGTH,
  MAX_OCCURRENCE_LITERAL_LENGTH,
  occurrenceEditIdentitiesAreUnique,
  type IngredientOccurrenceEdit,
  type InstructionInputEdit,
} from "./ingredient-occurrence.ts";
import {
  SOURCED_RECIPE_REPLACEMENT_SCHEMA,
  isSourcedRecipeReplacement,
  isLegacySourcedRecipeReplacement,
  type LegacySourcedRecipeReplacement,
  type SourcedRecipeReplacement,
} from "./sourced-recipe-contract.ts";

type WeekScoped = { weekId: WeekId };

export type HouseholdCommand =
  | ({ type: "moveMeal"; mealId: string; targetDate: IsoDate } & WeekScoped)
  | ({ type: "reorderMeals"; date: IsoDate; mealIds: string[] } & WeekScoped)
  | ({ type: "swapMealDays"; firstDate: IsoDate; secondDate: IsoDate } & WeekScoped)
  | ({ type: "updateMealStatus"; mealId: string; status: MealStatus } & WeekScoped)
  | ({ type: "editMealRecipe"; mealId: string; changes: Pick<MealSnapshotInput, "title" | "subtitle" | "venue" | "prepNote" | "leftoverNote" | "notes" | "yieldText">; occurrences: IngredientOccurrenceEdit[]; removedOccurrenceIds: string[] } & WeekScoped)
  | ({
      type: "replaceMealRecipeFromSource";
      mealId: string;
      recipe: SourcedRecipeReplacement;
    } & WeekScoped)
  | ({ type: "addInstructionStep"; mealId: string; position: number; step: { inputs: InstructionInputEdit[]; instruction: string; timerDurationSeconds?: number; note?: string } } & WeekScoped)
  | ({ type: "editInstructionStep"; stepId: string; changes: { inputs: InstructionInputEdit[]; instruction: string; timerDurationSeconds: number | null } } & WeekScoped)
  | ({ type: "moveInstructionStep"; stepId: string; targetPosition: number } & WeekScoped)
  | ({ type: "removeInstructionStep"; stepId: string } & WeekScoped)
  | ({ type: "setInstructionStepComplete"; stepId: string; complete: boolean } & WeekScoped)
  | ({ type: "updateInstructionStepNote"; stepId: string; note: string } & WeekScoped)
  | ({ type: "startInstructionTimer"; stepId: string } & WeekScoped)
  | ({ type: "pauseInstructionTimer"; stepId: string } & WeekScoped)
  | ({ type: "resetInstructionTimer"; stepId: string } & WeekScoped)
  | ({ type: "setInstructionTimerRemaining"; stepId: string; remainingSeconds: number } & WeekScoped)
  | ({ type: "addPrepStepsToDate"; prepDate: IsoDate; stepIds: string[]; targetPosition: number } & WeekScoped)
  | ({
      type: "combinePrepStepsOnDate";
      prepDate: IsoDate;
      sourceStepIds: string[];
      instruction: string;
      targetPosition: number;
    } & WeekScoped)
  | ({
      type: "updateCombinedPrepStep";
      entryId: string;
      instruction: string;
      discardFulfillment?: boolean;
    } & WeekScoped)
  | ({
      type: "setCombinedPrepStepComplete";
      entryId: string;
      complete: boolean;
    } & WeekScoped)
  | ({
      type: "expandCombinedPrepStep";
      entryId: string;
      discardFulfillment: boolean;
    } & WeekScoped)
  | ({ type: "movePrepStepsToDate"; sourcePrepDate: IsoDate; prepDate: IsoDate; entryIds: string[]; targetPosition: number } & WeekScoped)
  | ({ type: "removePrepStepsFromDate"; prepDate: IsoDate; entryIds: string[]; discardFulfillment?: boolean } & WeekScoped)
  | ({ type: "clearPrepDate"; prepDate: IsoDate; discardFulfillment?: boolean } & WeekScoped)
  | ({ type: "setGroceryItemsCoverage"; itemIds: string[]; coverage: GroceryCoverage } & WeekScoped)
  | ({ type: "setGroceryItemChecked"; itemId: string; checked: boolean } & WeekScoped)
  | ({ type: "captureFeedback"; mealId: string; value: FeedbackValue } & WeekScoped)
  | ({ type: "captureWeekLesson"; weekLesson: string } & WeekScoped)
  | ({
      type: "captureLeftoverQuality";
      leftoverId: string;
      quality: LeftoverQuality;
    } & WeekScoped)
  | ({
      type: "assignLeftover";
      leftoverId: string;
      targetDate: IsoDate;
    } & WeekScoped)
  | ({ type: "consumeLeftover"; leftoverId: string } & WeekScoped)
  | ({ type: "archiveWeek" } & WeekScoped)
  | { type: "createWeekPlan"; weekStartDate: WeekId; plan: OccurrenceAwareWeekPlanInput }
  | { type: "activateWeek"; weekId: WeekId }
  | { type: "handoffWeek"; currentWeekId: WeekId; nextWeekId: WeekId };

/**
 * A read-only record of the grocery reconciliation command that existed before
 * sources became first-class. It is deliberately not part of HouseholdCommand:
 * old events remain readable and undoable, but no new caller can submit it.
 */
export type HistoricalGroceryReconciliationCommand = {
  type: "reconcileGroceries";
  weekId: WeekId;
  items: Array<{
    id?: string;
    section: "Produce" | "Meat & seafood" | "Dairy" | "Pantry";
    item: string;
    detail: string;
    checked: boolean;
    farmBox: boolean;
  }>;
};

export type HistoricalHouseholdCommand =
  | ({ type: "updateMealSnapshot"; mealId: string; changes: MealSnapshotInput } & WeekScoped)
  | ({ type: "addInstructionStep"; mealId: string; position: number; step: InstructionStepPlanInput } & WeekScoped)
  | ({ type: "updateInstructionStep"; stepId: string; changes: InstructionStepContentInput } & WeekScoped)
  | ({ type: "moveGroceryItemsToSource"; itemIds: string[]; source: GrocerySource } & WeekScoped)
  | ({ type: "replaceMealRecipeFromSource"; mealId: string; recipe: LegacySourcedRecipeReplacement } & WeekScoped)
  | { type: "createWeekPlan"; weekStartDate: WeekId; plan: WeekPlanInput };

export const MAX_COMMAND_TEXT_LENGTH = 4_000;
export const MAX_ID_LENGTH = 200;
export const MAX_PREP_ENTRIES = 64;
export const MAX_PREP_DATES = 32;
export const MAX_COMBINED_PREP_SOURCES = 16;
// Every day can contain one meal in each supported slot.
// This is an input-safety ceiling, not a meal-per-day product rule.
export const MAX_MEALS_PER_WEEK = 256;
export const MAX_STEPS_PER_MEAL = 64;
export const MAX_STEP_INPUTS = 32;
export const MAX_INGREDIENT_LINES = 128;
// Groceries are a 1:1 execution projection of canonical meal ingredients.
// Keep this derived from the command-plan ceilings so no valid plan can fail
// merely because its projected grocery rows outnumber an unrelated cap.
export const MAX_GROCERY_ITEMS = MAX_MEALS_PER_WEEK * MAX_INGREDIENT_LINES;
export const MAX_TIMER_DURATION_SECONDS = 86_400;
export const MAX_MEAL_TITLE_LENGTH = 300;
export const MAX_MEAL_SUBTITLE_LENGTH = 1_000;
export const MAX_MEAL_VENUE_LENGTH = 300;
export const MAX_GROCERY_ITEM_LENGTH = 1_000;
export const MAX_STEP_INPUT_AMOUNT_LENGTH = 300;
export const MAX_STEP_INPUT_INGREDIENT_LENGTH = 1_000;
export const MAX_INGREDIENT_LINE_LENGTH = 1_000;

const idSchema = { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH, pattern: "\\S" };
const textSchema = { type: "string", maxLength: MAX_COMMAND_TEXT_LENGTH };
const nonemptyTextSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_COMMAND_TEXT_LENGTH,
  pattern: "\\S",
};
const isoDateSchema = {
  type: "string",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
};
const weekIdSchema = isoDateSchema;
const timerDurationSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_TIMER_DURATION_SECONDS,
};
const nullableTimerDurationSchema = {
  anyOf: [timerDurationSchema, { type: "null" }],
};
const stepInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "ingredient"],
  properties: {
    amount: { type: "string", maxLength: MAX_STEP_INPUT_AMOUNT_LENGTH },
    ingredient: { type: "string", maxLength: MAX_STEP_INPUT_INGREDIENT_LENGTH },
  },
};
const stepPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputs", "instruction"],
  properties: {
    inputs: { type: "array", maxItems: MAX_STEP_INPUTS, items: stepInputSchema },
    instruction: nonemptyTextSchema,
    timerDurationSeconds: timerDurationSchema,
    note: textSchema,
  },
};
const stepContentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputs", "instruction", "timerDurationSeconds"],
  properties: {
    inputs: stepPlanSchema.properties.inputs,
    instruction: stepPlanSchema.properties.instruction,
    timerDurationSeconds: nullableTimerDurationSchema,
  },
};
const groceryItemIdsSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_GROCERY_ITEMS,
  uniqueItems: true,
  items: idSchema,
};
const mealSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "subtitle",
    "venue",
    "prepNote",
    "leftoverNote",
    "notes",
    "ingredients",
    "yieldText",
  ],
  properties: {
    title: { type: "string", minLength: 1, maxLength: MAX_MEAL_TITLE_LENGTH },
    subtitle: { type: "string", maxLength: MAX_MEAL_SUBTITLE_LENGTH },
    venue: { type: "string", minLength: 1, maxLength: MAX_MEAL_VENUE_LENGTH },
    prepNote: textSchema,
    leftoverNote: textSchema,
    notes: textSchema,
    ingredients: {
      type: "array",
      maxItems: MAX_INGREDIENT_LINES,
      items: { type: "string", maxLength: MAX_INGREDIENT_LINE_LENGTH },
    },
    yieldText: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 80 },
        { type: "null" },
      ],
    },
  },
};
const nullableOccurrenceLiteralSchema = { anyOf: [{ type: "string", maxLength: MAX_OCCURRENCE_LITERAL_LENGTH }, { type: "null" }] };
const occurrenceAmountSchema = { type: "string", maxLength: MAX_OCCURRENCE_AMOUNT_LENGTH };
const occurrenceCoreSchema = { type: "string", minLength: 1, maxLength: MAX_OCCURRENCE_LITERAL_LENGTH, pattern: "\\S" };
const occurrenceEditSchema = {
  anyOf: [
    { type: "object", additionalProperties: false, required: ["kind", "occurrenceId", "source", "amount", "unit", "ingredient", "qualifier", "conceptId"], properties: { kind: { const: "retain" }, occurrenceId: idSchema, source: nullableOccurrenceLiteralSchema, amount: occurrenceAmountSchema, unit: nullableOccurrenceLiteralSchema, ingredient: occurrenceCoreSchema, qualifier: nullableOccurrenceLiteralSchema, conceptId: nullableOccurrenceLiteralSchema } },
    { type: "object", additionalProperties: false, required: ["kind", "correlationId", "source", "amount", "unit", "ingredient", "qualifier", "conceptId", "canonicalIngredientId"], properties: { kind: { const: "create" }, correlationId: idSchema, source: nullableOccurrenceLiteralSchema, amount: occurrenceAmountSchema, unit: nullableOccurrenceLiteralSchema, ingredient: occurrenceCoreSchema, qualifier: nullableOccurrenceLiteralSchema, conceptId: nullableOccurrenceLiteralSchema, canonicalIngredientId: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] } } },
  ],
};
const recipeEditChangesSchema = {
  type: "object", additionalProperties: false,
  required: ["title", "subtitle", "venue", "prepNote", "leftoverNote", "notes", "yieldText"],
  properties: { title: { type: "string", minLength: 1, maxLength: MAX_MEAL_TITLE_LENGTH, pattern: "\\S" }, subtitle: { type: "string", maxLength: MAX_MEAL_SUBTITLE_LENGTH }, venue: { type: "string", minLength: 1, maxLength: MAX_MEAL_VENUE_LENGTH, pattern: "\\S" }, prepNote: textSchema, leftoverNote: textSchema, notes: textSchema, yieldText: { anyOf: [{ type: "string", minLength: 1, maxLength: 80, pattern: "\\S" }, { type: "null" }] } },
};
const instructionInputEditSchema = { anyOf: [
  { type: "object", additionalProperties: false, required: ["kind", "occurrenceId", "amount", "ingredient"], properties: { kind: { const: "retain" }, occurrenceId: idSchema, amount: occurrenceAmountSchema, ingredient: { type: "string", maxLength: MAX_OCCURRENCE_LITERAL_LENGTH } } },
  { type: "object", additionalProperties: false, required: ["kind", "correlationId", "amount", "ingredient"], properties: { kind: { const: "create" }, correlationId: idSchema, amount: occurrenceAmountSchema, ingredient: { type: "string", maxLength: MAX_OCCURRENCE_LITERAL_LENGTH } } },
] };
const occurrenceAwareMealPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "date", "title", "subtitle", "venue", "protein", "prepNote",
    "leftoverNote", "notes", "occurrences", "instructions",
  ],
  properties: {
    date: isoDateSchema,
    title: { type: "string", minLength: 1, maxLength: MAX_MEAL_TITLE_LENGTH, pattern: "\\S" },
    subtitle: { type: "string", maxLength: MAX_MEAL_SUBTITLE_LENGTH },
    venue: { type: "string", minLength: 1, maxLength: MAX_MEAL_VENUE_LENGTH, pattern: "\\S" },
    status: { type: "string", enum: [...MEAL_STATUSES] },
    protein: { type: "string", enum: ["chicken", "salmon", "none"] },
    prepNote: textSchema,
    leftoverNote: textSchema,
    notes: textSchema,
    occurrences: {
      type: "array",
      maxItems: MAX_INGREDIENT_LINES,
      items: occurrenceEditSchema.anyOf[1],
    },
    instructions: {
      type: "array",
      maxItems: MAX_STEPS_PER_MEAL,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["inputs", "instruction"],
        properties: {
          inputs: {
            type: "array",
            maxItems: MAX_STEP_INPUTS,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["occurrenceCorrelationId", "amount", "ingredient"],
              properties: {
                occurrenceCorrelationId: idSchema,
                amount: occurrenceAmountSchema,
                ingredient: { type: "string", minLength: 1, maxLength: MAX_OCCURRENCE_LITERAL_LENGTH, pattern: "\\S" },
              },
            },
          },
          instruction: nonemptyTextSchema,
          timerDurationSeconds: timerDurationSchema,
          note: textSchema,
        },
      },
    },
    yieldText: { type: "string", minLength: 1, maxLength: 80, pattern: "\\S" },
  },
};
const weekPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["meals"],
  properties: {
    meals: { type: "array", maxItems: MAX_MEALS_PER_WEEK, items: occurrenceAwareMealPlanSchema },
    weekLesson: textSchema,
  },
};

function commandSchema(type: string, properties: Record<string, unknown> = {}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", ...Object.keys(properties)],
    properties: { type: { type: "string", const: type }, ...properties },
  };
}

function weekCommandSchema(type: string, properties: Record<string, unknown> = {}) {
  return commandSchema(type, { weekId: weekIdSchema, ...properties });
}

function weekCommandSchemaWithOptional(
  type: string,
  properties: Record<string, unknown>,
  optionalProperties: Record<string, unknown>,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "weekId", ...Object.keys(properties)],
    properties: {
      type: { type: "string", const: type },
      weekId: weekIdSchema,
      ...properties,
      ...optionalProperties,
    },
  };
}

const HOUSEHOLD_COMMAND_SCHEMAS = {
  moveMeal: weekCommandSchema("moveMeal", { mealId: idSchema, targetDate: isoDateSchema }),
  reorderMeals: weekCommandSchema("reorderMeals", { date: isoDateSchema, mealIds: { type: "array", minItems: 1, maxItems: MAX_MEALS_PER_WEEK, items: idSchema } }),
  swapMealDays: weekCommandSchema("swapMealDays", { firstDate: isoDateSchema, secondDate: isoDateSchema }),
  updateMealStatus: weekCommandSchema("updateMealStatus", { mealId: idSchema, status: { type: "string", enum: [...MEAL_STATUSES] } }),
  updateMealSnapshot: weekCommandSchema("updateMealSnapshot", { mealId: idSchema, changes: mealSnapshotSchema }),
  editMealRecipe: weekCommandSchema("editMealRecipe", { mealId: idSchema, changes: recipeEditChangesSchema, occurrences: { type: "array", maxItems: MAX_INGREDIENT_LINES, items: occurrenceEditSchema }, removedOccurrenceIds: { type: "array", maxItems: MAX_INGREDIENT_LINES, uniqueItems: true, items: idSchema } }),
  replaceMealRecipeFromSource: weekCommandSchema("replaceMealRecipeFromSource", {
    mealId: idSchema,
    recipe: SOURCED_RECIPE_REPLACEMENT_SCHEMA,
  }),
  addInstructionStep: weekCommandSchema("addInstructionStep", { mealId: idSchema, position: { type: "integer", minimum: 0, maximum: MAX_STEPS_PER_MEAL - 1 }, step: { type: "object", additionalProperties: false, required: ["inputs", "instruction"], properties: { inputs: { type: "array", maxItems: MAX_STEP_INPUTS, items: instructionInputEditSchema }, instruction: nonemptyTextSchema, timerDurationSeconds: timerDurationSchema, note: textSchema } } }),
  updateInstructionStep: weekCommandSchema("updateInstructionStep", { stepId: idSchema, changes: stepContentSchema }),
  editInstructionStep: weekCommandSchema("editInstructionStep", { stepId: idSchema, changes: { type: "object", additionalProperties: false, required: ["inputs", "instruction", "timerDurationSeconds"], properties: { inputs: { type: "array", maxItems: MAX_STEP_INPUTS, items: instructionInputEditSchema }, instruction: nonemptyTextSchema, timerDurationSeconds: nullableTimerDurationSchema } } }),
  moveInstructionStep: weekCommandSchema("moveInstructionStep", { stepId: idSchema, targetPosition: { type: "integer", minimum: 0, maximum: MAX_STEPS_PER_MEAL - 1 } }),
  removeInstructionStep: weekCommandSchema("removeInstructionStep", { stepId: idSchema }),
  setInstructionStepComplete: weekCommandSchema("setInstructionStepComplete", { stepId: idSchema, complete: { type: "boolean" } }),
  updateInstructionStepNote: weekCommandSchema("updateInstructionStepNote", { stepId: idSchema, note: textSchema }),
  startInstructionTimer: weekCommandSchema("startInstructionTimer", { stepId: idSchema }),
  pauseInstructionTimer: weekCommandSchema("pauseInstructionTimer", { stepId: idSchema }),
  resetInstructionTimer: weekCommandSchema("resetInstructionTimer", { stepId: idSchema }),
  setInstructionTimerRemaining: weekCommandSchema("setInstructionTimerRemaining", { stepId: idSchema, remainingSeconds: timerDurationSchema }),
  addPrepStepsToDate: weekCommandSchema("addPrepStepsToDate", {
    prepDate: isoDateSchema,
    stepIds: { type: "array", minItems: 1, maxItems: MAX_PREP_ENTRIES, items: idSchema },
    targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES - 1 },
  }),
  combinePrepStepsOnDate: weekCommandSchema("combinePrepStepsOnDate", {
    prepDate: isoDateSchema,
    sourceStepIds: {
      type: "array",
      minItems: 2,
      maxItems: MAX_COMBINED_PREP_SOURCES,
      uniqueItems: true,
      items: idSchema,
    },
    instruction: nonemptyTextSchema,
    targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES },
  }),
  updateCombinedPrepStep: weekCommandSchemaWithOptional("updateCombinedPrepStep", {
    entryId: idSchema,
    instruction: nonemptyTextSchema,
  }, {
    discardFulfillment: { type: "boolean" },
  }),
  setCombinedPrepStepComplete: weekCommandSchema("setCombinedPrepStepComplete", {
    entryId: idSchema,
    complete: { type: "boolean" },
  }),
  expandCombinedPrepStep: weekCommandSchema("expandCombinedPrepStep", {
    entryId: idSchema,
    discardFulfillment: { type: "boolean" },
  }),
  movePrepStepsToDate: weekCommandSchema("movePrepStepsToDate", {
    sourcePrepDate: isoDateSchema,
    prepDate: isoDateSchema,
    entryIds: { type: "array", minItems: 1, maxItems: MAX_PREP_ENTRIES, items: idSchema },
    targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES },
  }),
  removePrepStepsFromDate: weekCommandSchemaWithOptional("removePrepStepsFromDate", {
    prepDate: isoDateSchema,
    entryIds: { type: "array", minItems: 1, maxItems: MAX_PREP_ENTRIES, items: idSchema },
  }, {
    discardFulfillment: { type: "boolean" },
  }),
  clearPrepDate: weekCommandSchemaWithOptional("clearPrepDate", { prepDate: isoDateSchema }, {
    discardFulfillment: { type: "boolean" },
  }),
  moveGroceryItemsToSource: weekCommandSchema("moveGroceryItemsToSource", {
    itemIds: groceryItemIdsSchema,
    source: { type: "string", enum: [...GROCERY_SOURCES] },
  }),
  setGroceryItemsCoverage: weekCommandSchema("setGroceryItemsCoverage", { itemIds: groceryItemIdsSchema, coverage: { type: "string", enum: ["needs_source", ...GROCERY_SOURCES] } }),
  setGroceryItemChecked: weekCommandSchema("setGroceryItemChecked", { itemId: idSchema, checked: { type: "boolean" } }),
  captureFeedback: weekCommandSchema("captureFeedback", { mealId: idSchema, value: { type: "string", enum: [...FEEDBACK_VALUES] } }),
  captureWeekLesson: weekCommandSchema("captureWeekLesson", { weekLesson: textSchema }),
  captureLeftoverQuality: weekCommandSchema("captureLeftoverQuality", { leftoverId: idSchema, quality: { type: "string", enum: [...LEFTOVER_QUALITIES] } }),
  assignLeftover: weekCommandSchema("assignLeftover", { leftoverId: idSchema, targetDate: isoDateSchema }),
  consumeLeftover: weekCommandSchema("consumeLeftover", { leftoverId: idSchema }),
  archiveWeek: weekCommandSchema("archiveWeek"),
  createWeekPlan: commandSchema("createWeekPlan", { weekStartDate: weekIdSchema, plan: weekPlanSchema }),
  activateWeek: commandSchema("activateWeek", { weekId: weekIdSchema }),
  handoffWeek: commandSchema("handoffWeek", { currentWeekId: weekIdSchema, nextWeekId: weekIdSchema }),
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isText(value: unknown, maxLength = MAX_COMMAND_TEXT_LENGTH, allowEmpty = true) {
  return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
}

function isId(value: unknown): value is string {
  return isText(value, MAX_ID_LENGTH, false);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number) {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isStepInput(value: unknown) {
  return hasKeys(value, ["amount", "ingredient"]) &&
    isText(value.amount, MAX_STEP_INPUT_AMOUNT_LENGTH) &&
    isText(value.ingredient, MAX_STEP_INPUT_INGREDIENT_LENGTH);
}

function isRecipeEditChanges(value: unknown): boolean {
  if (!hasKeys(value, ["title", "subtitle", "venue", "prepNote", "leftoverNote", "notes", "yieldText"])) return false;
  return isText(value.title, MAX_MEAL_TITLE_LENGTH, false) &&
    isText(value.subtitle, MAX_MEAL_SUBTITLE_LENGTH) &&
    isText(value.venue, MAX_MEAL_VENUE_LENGTH, false) &&
    isText(value.prepNote) &&
    isText(value.leftoverNote) &&
    isText(value.notes) &&
    (value.yieldText === null || isText(value.yieldText, 80, false));
}

function isStepPlan(value: unknown, { allowNullDuration = false } = {}) {
  if (!hasKeys(value, ["inputs", "instruction"], ["timerDurationSeconds", "note"])) return false;
  if (!Array.isArray(value.inputs) || value.inputs.length > MAX_STEP_INPUTS || !value.inputs.every(isStepInput)) return false;
  if (!isText(value.instruction, MAX_COMMAND_TEXT_LENGTH, false)) return false;
  if (value.note !== undefined && !isText(value.note)) return false;
  if (value.timerDurationSeconds === undefined) return true;
  return (
    (allowNullDuration && value.timerDurationSeconds === null) ||
    isIntegerInRange(value.timerDurationSeconds, 1, MAX_TIMER_DURATION_SECONDS)
  );
}

function isStepContent(value: unknown) {
  return (
    hasKeys(value, ["inputs", "instruction", "timerDurationSeconds"]) &&
    Array.isArray(value.inputs) &&
    value.inputs.length <= MAX_STEP_INPUTS &&
    value.inputs.every(isStepInput) &&
    isText(value.instruction, MAX_COMMAND_TEXT_LENGTH, false) &&
    (value.timerDurationSeconds === null ||
      isIntegerInRange(value.timerDurationSeconds, 1, MAX_TIMER_DURATION_SECONDS))
  );
}

function isMealSnapshot(value: unknown): value is MealSnapshotInput {
  return hasKeys(value, ["title", "subtitle", "venue", "prepNote", "leftoverNote", "notes", "ingredients", "yieldText"]) &&
    hasMealSnapshotFields(value) &&
    (value.yieldText === null || isText(value.yieldText, 80, false));
}

function hasMealSnapshotFields(value: Record<string, unknown>) {
  return (
    isText(value.title, MAX_MEAL_TITLE_LENGTH, false) &&
    isText(value.subtitle, MAX_MEAL_SUBTITLE_LENGTH) &&
    isText(value.venue, MAX_MEAL_VENUE_LENGTH, false) &&
    isText(value.prepNote) &&
    isText(value.leftoverNote) &&
    isText(value.notes) &&
    Array.isArray(value.ingredients) &&
    value.ingredients.length <= MAX_INGREDIENT_LINES &&
    value.ingredients.every((ingredient) => isText(ingredient, MAX_INGREDIENT_LINE_LENGTH))
  );
}

function isMealPlan(value: unknown) {
  if (!hasKeys(value, ["date", "title", "subtitle", "venue", "protein", "prepNote", "leftoverNote", "notes", "ingredients", "instructions"], ["status", "yieldText"])) return false;
  if (!isIsoDate(value.date)) return false;
  if (value.status !== undefined && !MEAL_STATUSES.includes(value.status as MealStatus)) return false;
  if (!["chicken", "salmon", "none"].includes(value.protein as string)) return false;
  if (!hasMealSnapshotFields(value)) return false;
  if (value.yieldText !== undefined && !isText(value.yieldText, 80, false)) return false;
  return Array.isArray(value.instructions) && value.instructions.length <= MAX_STEPS_PER_MEAL && value.instructions.every((step) => isStepPlan(step));
}

function isWeekPlan(value: unknown): value is WeekPlanInput {
  return (
    hasKeys(value, ["meals"], ["weekLesson"]) &&
    Array.isArray(value.meals) &&
    value.meals.length <= MAX_MEALS_PER_WEEK &&
    value.meals.every(isMealPlan) &&
    (value.weekLesson === undefined || isText(value.weekLesson))
  );
}

function isCorrelatedInstructionInput(value: unknown): boolean {
  return hasKeys(value, ["occurrenceCorrelationId", "amount", "ingredient"]) &&
    isId(value.occurrenceCorrelationId) &&
    isText(value.amount, MAX_STEP_INPUT_AMOUNT_LENGTH) &&
    isText(value.ingredient, MAX_STEP_INPUT_INGREDIENT_LENGTH, false);
}

function isOccurrenceAwareMealPlan(value: unknown): boolean {
  if (!hasKeys(
    value,
    ["date", "title", "subtitle", "venue", "protein", "prepNote", "leftoverNote", "notes", "occurrences", "instructions"],
    ["status", "yieldText"],
  )) return false;
  if (!isIsoDate(value.date) ||
    (value.status !== undefined && !MEAL_STATUSES.includes(value.status as MealStatus)) ||
    !["chicken", "salmon", "none"].includes(value.protein as string) ||
    !isText(value.title, MAX_MEAL_TITLE_LENGTH, false) ||
    !isText(value.subtitle, MAX_MEAL_SUBTITLE_LENGTH) ||
    !isText(value.venue, MAX_MEAL_VENUE_LENGTH, false) ||
    !isText(value.prepNote) || !isText(value.leftoverNote) || !isText(value.notes) ||
    (value.yieldText !== undefined && !isText(value.yieldText, 80, false)) ||
    !Array.isArray(value.occurrences) || value.occurrences.length > MAX_INGREDIENT_LINES ||
    !value.occurrences.every((occurrence) =>
      isRecord(occurrence) && occurrence.kind === "create" && isIngredientOccurrenceEdit(occurrence)) ||
    !Array.isArray(value.instructions) || value.instructions.length > MAX_STEPS_PER_MEAL
  ) return false;
  const correlations = new Set(value.occurrences.map((occurrence) => occurrence.correlationId));
  if (correlations.size !== value.occurrences.length) return false;
  return value.instructions.every((step) =>
    hasKeys(step, ["inputs", "instruction"], ["timerDurationSeconds", "note"]) &&
    Array.isArray(step.inputs) && step.inputs.length <= MAX_STEP_INPUTS &&
    step.inputs.every((input) =>
      isCorrelatedInstructionInput(input) && correlations.has(input.occurrenceCorrelationId)) &&
    isText(step.instruction, MAX_COMMAND_TEXT_LENGTH, false) &&
    (step.timerDurationSeconds === undefined ||
      isIntegerInRange(step.timerDurationSeconds, 1, MAX_TIMER_DURATION_SECONDS)) &&
    (step.note === undefined || isText(step.note))
  );
}

function isOccurrenceAwareWeekPlan(value: unknown): value is OccurrenceAwareWeekPlanInput {
  if (!(hasKeys(value, ["meals"], ["weekLesson"]) &&
    Array.isArray(value.meals) && value.meals.length <= MAX_MEALS_PER_WEEK &&
    value.meals.every(isOccurrenceAwareMealPlan) &&
    (value.weekLesson === undefined || isText(value.weekLesson)))) return false;
  const plan = value as OccurrenceAwareWeekPlanInput;
  const correlations = plan.meals.flatMap((meal) =>
    meal.occurrences.map((occurrence) => occurrence.correlationId));
  return new Set(correlations).size === correlations.length;
}

function isWeekCommand(value: Record<string, unknown>, fields: string[]) {
  return hasKeys(value, ["type", "weekId", ...fields]) && isWeekId(value.weekId);
}

function isWeekCommandWithOptional(
  value: Record<string, unknown>,
  fields: string[],
  optionalFields: string[],
) {
  return hasKeys(value, ["type", "weekId", ...fields], optionalFields) && isWeekId(value.weekId);
}

export type HouseholdCommandScope = "workspace" | "week";
export type HouseholdCommandExposure = "ordinary" | "explicit_foreground" | "host_admission_required";

type HouseholdCommandRegistryEntry = {
  schema: Record<string, unknown>;
  scope: HouseholdCommandScope;
  exposure: HouseholdCommandExposure;
  validate(value: Record<string, unknown>): boolean;
};

export const HOUSEHOLD_COMMAND_REGISTRY = {
  moveMeal: { schema: HOUSEHOLD_COMMAND_SCHEMAS.moveMeal, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "targetDate"]) && isId(value.mealId) && isIsoDate(value.targetDate) },
  reorderMeals: { schema: HOUSEHOLD_COMMAND_SCHEMAS.reorderMeals, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["date", "mealIds"]) && isIsoDate(value.date) && Array.isArray(value.mealIds) && value.mealIds.length >= 1 && value.mealIds.length <= MAX_MEALS_PER_WEEK && value.mealIds.every(isId) && new Set(value.mealIds).size === value.mealIds.length },
  swapMealDays: { schema: HOUSEHOLD_COMMAND_SCHEMAS.swapMealDays, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["firstDate", "secondDate"]) && isIsoDate(value.firstDate) && isIsoDate(value.secondDate) && value.firstDate !== value.secondDate },
  updateMealStatus: { schema: HOUSEHOLD_COMMAND_SCHEMAS.updateMealStatus, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "status"]) && isId(value.mealId) && MEAL_STATUSES.includes(value.status as MealStatus) },
  editMealRecipe: { schema: HOUSEHOLD_COMMAND_SCHEMAS.editMealRecipe, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "changes", "occurrences", "removedOccurrenceIds"]) && isId(value.mealId) && isRecipeEditChanges(value.changes) && Array.isArray(value.occurrences) && value.occurrences.length <= MAX_INGREDIENT_LINES && value.occurrences.every(isIngredientOccurrenceEdit) && occurrenceEditIdentitiesAreUnique(value.occurrences) && Array.isArray(value.removedOccurrenceIds) && value.removedOccurrenceIds.length <= MAX_INGREDIENT_LINES && value.removedOccurrenceIds.every(isId) && new Set(value.removedOccurrenceIds).size === value.removedOccurrenceIds.length },
  // The typed command remains the informational-source contract for direct callers.
  // The embedded host must not expose or admit it until it can bind an exact observed candidate.
  replaceMealRecipeFromSource: { schema: HOUSEHOLD_COMMAND_SCHEMAS.replaceMealRecipeFromSource, scope: "week", exposure: "host_admission_required", validate: (value) => isWeekCommand(value, ["mealId", "recipe"]) && isId(value.mealId) && isSourcedRecipeReplacement(value.recipe) },
  addInstructionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.addInstructionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "position", "step"]) && isId(value.mealId) && isIntegerInRange(value.position, 0, MAX_STEPS_PER_MEAL - 1) && isRecord(value.step) && hasKeys(value.step, ["inputs", "instruction"], ["timerDurationSeconds", "note"]) && Array.isArray(value.step.inputs) && value.step.inputs.length <= MAX_STEP_INPUTS && value.step.inputs.every(isInstructionInputEdit) && instructionInputCorrelationsAreUnique(value.step.inputs) && isText(value.step.instruction, MAX_COMMAND_TEXT_LENGTH, false) && (value.step.timerDurationSeconds === undefined || isIntegerInRange(value.step.timerDurationSeconds, 1, MAX_TIMER_DURATION_SECONDS)) && (value.step.note === undefined || isText(value.step.note, MAX_COMMAND_TEXT_LENGTH)) },
  editInstructionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.editInstructionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "changes"]) && isId(value.stepId) && hasKeys(value.changes, ["inputs", "instruction", "timerDurationSeconds"]) && Array.isArray(value.changes.inputs) && value.changes.inputs.length <= MAX_STEP_INPUTS && value.changes.inputs.every(isInstructionInputEdit) && instructionInputCorrelationsAreUnique(value.changes.inputs) && isText(value.changes.instruction, MAX_COMMAND_TEXT_LENGTH, false) && (value.changes.timerDurationSeconds === null || isIntegerInRange(value.changes.timerDurationSeconds, 1, MAX_TIMER_DURATION_SECONDS)) },
  moveInstructionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.moveInstructionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "targetPosition"]) && isId(value.stepId) && isIntegerInRange(value.targetPosition, 0, MAX_STEPS_PER_MEAL - 1) },
  removeInstructionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.removeInstructionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId"]) && isId(value.stepId) },
  setInstructionStepComplete: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setInstructionStepComplete, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "complete"]) && isId(value.stepId) && typeof value.complete === "boolean" },
  updateInstructionStepNote: { schema: HOUSEHOLD_COMMAND_SCHEMAS.updateInstructionStepNote, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "note"]) && isId(value.stepId) && isText(value.note) },
  startInstructionTimer: { schema: HOUSEHOLD_COMMAND_SCHEMAS.startInstructionTimer, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId"]) && isId(value.stepId) },
  pauseInstructionTimer: { schema: HOUSEHOLD_COMMAND_SCHEMAS.pauseInstructionTimer, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId"]) && isId(value.stepId) },
  resetInstructionTimer: { schema: HOUSEHOLD_COMMAND_SCHEMAS.resetInstructionTimer, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId"]) && isId(value.stepId) },
  setInstructionTimerRemaining: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setInstructionTimerRemaining, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "remainingSeconds"]) && isId(value.stepId) && isIntegerInRange(value.remainingSeconds, 1, MAX_TIMER_DURATION_SECONDS) },
  addPrepStepsToDate: { schema: HOUSEHOLD_COMMAND_SCHEMAS.addPrepStepsToDate, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["prepDate", "stepIds", "targetPosition"]) && isIsoDate(value.prepDate) && Array.isArray(value.stepIds) && value.stepIds.length >= 1 && value.stepIds.length <= MAX_PREP_ENTRIES && value.stepIds.every(isId) && new Set(value.stepIds).size === value.stepIds.length && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES - 1) },
  combinePrepStepsOnDate: { schema: HOUSEHOLD_COMMAND_SCHEMAS.combinePrepStepsOnDate, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["prepDate", "sourceStepIds", "instruction", "targetPosition"]) && isIsoDate(value.prepDate) && Array.isArray(value.sourceStepIds) && value.sourceStepIds.length >= 2 && value.sourceStepIds.length <= MAX_COMBINED_PREP_SOURCES && value.sourceStepIds.every(isId) && new Set(value.sourceStepIds).size === value.sourceStepIds.length && isText(value.instruction, MAX_COMMAND_TEXT_LENGTH, false) && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES) },
  updateCombinedPrepStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.updateCombinedPrepStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommandWithOptional(value, ["entryId", "instruction"], ["discardFulfillment"]) && isId(value.entryId) && isText(value.instruction, MAX_COMMAND_TEXT_LENGTH, false) && (value.discardFulfillment === undefined || typeof value.discardFulfillment === "boolean") },
  setCombinedPrepStepComplete: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setCombinedPrepStepComplete, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["entryId", "complete"]) && isId(value.entryId) && typeof value.complete === "boolean" },
  expandCombinedPrepStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.expandCombinedPrepStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["entryId", "discardFulfillment"]) && isId(value.entryId) && typeof value.discardFulfillment === "boolean" },
  movePrepStepsToDate: { schema: HOUSEHOLD_COMMAND_SCHEMAS.movePrepStepsToDate, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sourcePrepDate", "prepDate", "entryIds", "targetPosition"]) && isIsoDate(value.sourcePrepDate) && isIsoDate(value.prepDate) && Array.isArray(value.entryIds) && value.entryIds.length >= 1 && value.entryIds.length <= MAX_PREP_ENTRIES && value.entryIds.every(isId) && new Set(value.entryIds).size === value.entryIds.length && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES) },
  removePrepStepsFromDate: { schema: HOUSEHOLD_COMMAND_SCHEMAS.removePrepStepsFromDate, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommandWithOptional(value, ["prepDate", "entryIds"], ["discardFulfillment"]) && isIsoDate(value.prepDate) && Array.isArray(value.entryIds) && value.entryIds.length >= 1 && value.entryIds.length <= MAX_PREP_ENTRIES && value.entryIds.every(isId) && new Set(value.entryIds).size === value.entryIds.length && (value.discardFulfillment === undefined || typeof value.discardFulfillment === "boolean") },
  clearPrepDate: { schema: HOUSEHOLD_COMMAND_SCHEMAS.clearPrepDate, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommandWithOptional(value, ["prepDate"], ["discardFulfillment"]) && isIsoDate(value.prepDate) && (value.discardFulfillment === undefined || typeof value.discardFulfillment === "boolean") },
  setGroceryItemsCoverage: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setGroceryItemsCoverage, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["itemIds", "coverage"]) && Array.isArray(value.itemIds) && value.itemIds.length >= 1 && value.itemIds.length <= MAX_GROCERY_ITEMS && value.itemIds.every(isId) && new Set(value.itemIds).size === value.itemIds.length && ["needs_source", ...GROCERY_SOURCES].includes(value.coverage as GroceryCoverage) },
  setGroceryItemChecked: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setGroceryItemChecked, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["itemId", "checked"]) && isId(value.itemId) && typeof value.checked === "boolean" },
  captureFeedback: { schema: HOUSEHOLD_COMMAND_SCHEMAS.captureFeedback, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "value"]) && isId(value.mealId) && FEEDBACK_VALUES.includes(value.value as FeedbackValue) },
  captureWeekLesson: { schema: HOUSEHOLD_COMMAND_SCHEMAS.captureWeekLesson, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["weekLesson"]) && isText(value.weekLesson) },
  captureLeftoverQuality: { schema: HOUSEHOLD_COMMAND_SCHEMAS.captureLeftoverQuality, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["leftoverId", "quality"]) && isId(value.leftoverId) && LEFTOVER_QUALITIES.includes(value.quality as LeftoverQuality) },
  assignLeftover: { schema: HOUSEHOLD_COMMAND_SCHEMAS.assignLeftover, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["leftoverId", "targetDate"]) && isId(value.leftoverId) && isIsoDate(value.targetDate) },
  consumeLeftover: { schema: HOUSEHOLD_COMMAND_SCHEMAS.consumeLeftover, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["leftoverId"]) && isId(value.leftoverId) },
  archiveWeek: { schema: HOUSEHOLD_COMMAND_SCHEMAS.archiveWeek, scope: "week", exposure: "explicit_foreground", validate: (value) => isWeekCommand(value, []) },
  createWeekPlan: { schema: HOUSEHOLD_COMMAND_SCHEMAS.createWeekPlan, scope: "workspace", exposure: "ordinary", validate: (value) => hasKeys(value, ["type", "weekStartDate", "plan"]) && isWeekId(value.weekStartDate) && isOccurrenceAwareWeekPlan(value.plan) },
  activateWeek: { schema: HOUSEHOLD_COMMAND_SCHEMAS.activateWeek, scope: "workspace", exposure: "ordinary", validate: (value) => hasKeys(value, ["type", "weekId"]) && isWeekId(value.weekId) },
  handoffWeek: { schema: HOUSEHOLD_COMMAND_SCHEMAS.handoffWeek, scope: "workspace", exposure: "ordinary", validate: (value) => hasKeys(value, ["type", "currentWeekId", "nextWeekId"]) && isWeekId(value.currentWeekId) && isWeekId(value.nextWeekId) && value.currentWeekId !== value.nextWeekId },
} satisfies Record<HouseholdCommand["type"], HouseholdCommandRegistryEntry>;

function schemaAllowsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === "null") return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some(schemaAllowsNull);
}

function makeProviderStrict(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(makeProviderStrict);
  if (!isRecord(schema)) return schema;
  const transformed: Record<string, unknown> = { ...schema };
  if (Array.isArray(schema.anyOf)) transformed.anyOf = schema.anyOf.map(makeProviderStrict);
  if (schema.items !== undefined) transformed.items = makeProviderStrict(schema.items);
  if (schema.type === "object" && isRecord(schema.properties)) {
    const canonicalRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    transformed.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, propertySchema]) => {
        const strictProperty = makeProviderStrict(propertySchema);
        return [
          key,
          canonicalRequired.has(key) || schemaAllowsNull(strictProperty)
            ? strictProperty
            : { anyOf: [strictProperty, { type: "null" }] },
        ];
      }),
    );
    transformed.required = Object.keys(schema.properties);
  }
  return transformed;
}

function normalizeAgainstCanonicalSchema(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value;
  if (Array.isArray(schema.anyOf)) {
    if (value === null) return null;
    const nonNull = schema.anyOf.find((candidate) => !schemaAllowsNull(candidate));
    return nonNull === undefined ? value : normalizeAgainstCanonicalSchema(value, nonNull);
  }
  if (schema.type === "array" && Array.isArray(value)) {
    return value.map((entry) => normalizeAgainstCanonicalSchema(entry, schema.items));
  }
  if (schema.type !== "object" || !isRecord(schema.properties) || !isRecord(value)) return value;
  const properties = schema.properties;
  const canonicalRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const propertySchema = properties[key];
      if (propertySchema === undefined) return [[key, entry]];
      if (entry === null && !canonicalRequired.has(key)) return [];
      return [[key, normalizeAgainstCanonicalSchema(entry, propertySchema)]];
    }),
  );
}

export const HOUSEHOLD_COMMAND_SCHEMA = {
  anyOf: Object.values(HOUSEHOLD_COMMAND_REGISTRY).map((entry) => entry.schema),
} as const;

export const HOUSEHOLD_COMMAND_PROVIDER_SCHEMA = makeProviderStrict(
  HOUSEHOLD_COMMAND_SCHEMA,
) as typeof HOUSEHOLD_COMMAND_SCHEMA;

export const HOUSEHOLD_COMMAND_AUTHORITY_MANIFEST = {
  schemaVersion: "household-command-v1",
  hashVersion: "canonical-json-v1",
  commands: Object.fromEntries(
    Object.entries(HOUSEHOLD_COMMAND_REGISTRY).map(([type, entry]) => [
      type,
      { scope: entry.scope, exposure: entry.exposure },
    ]),
  ),
  permanentlyDeniedOperations: [
    "undoLatest",
    "workspaceBootstrap",
    "seedReset",
    "legacyImport",
    "arbitraryRestore",
    "backupAdmin",
    "developmentControls",
    "actorAssignment",
  ],
  limits: {
    toolCallsPerTurn: 32,
    operationsPerApply: 16,
    argumentBytes: 65_536,
    resultBytes: 131_072,
    recentHistoryEvents: 20,
  },
} as const;

export function normalizeHouseholdCommand(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") return value;
  const entry = HOUSEHOLD_COMMAND_REGISTRY[value.type as HouseholdCommand["type"]];
  return entry ? normalizeAgainstCanonicalSchema(value, entry.schema) : value;
}

export function isHouseholdCommand(value: unknown): value is HouseholdCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const entry = HOUSEHOLD_COMMAND_REGISTRY[value.type as HouseholdCommand["type"]];
  return Boolean(entry?.validate(value));
}

export function isHistoricalGroceryReconciliationCommand(
  value: unknown,
): value is HistoricalGroceryReconciliationCommand {
  if (!isRecord(value) || !hasKeys(value, ["type", "weekId", "items"])) return false;
  if (value.type !== "reconcileGroceries" || !isWeekId(value.weekId) || !Array.isArray(value.items)) {
    return false;
  }
  return value.items.length <= MAX_GROCERY_ITEMS && value.items.every((item) => {
    if (!hasKeys(item, ["section", "item", "detail", "checked", "farmBox"], ["id"])) {
      return false;
    }
    return ["Produce", "Meat & seafood", "Dairy", "Pantry"].includes(item.section as string) &&
      isText(item.item, MAX_GROCERY_ITEM_LENGTH, false) &&
      isText(item.detail) &&
      typeof item.checked === "boolean" &&
      typeof item.farmBox === "boolean" &&
      (item.id === undefined || isId(item.id));
  });
}

/** Retired wire grammars are readable/replay-only and are never provider-admitted. */
export function isHistoricalHouseholdCommand(value: unknown): value is HistoricalHouseholdCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "updateMealSnapshot": return isWeekCommand(value, ["mealId", "changes"]) && isId(value.mealId) && isMealSnapshot(value.changes);
    case "addInstructionStep": return isWeekCommand(value, ["mealId", "position", "step"]) && isId(value.mealId) && isIntegerInRange(value.position, 0, MAX_STEPS_PER_MEAL - 1) && isStepPlan(value.step);
    case "updateInstructionStep": return isWeekCommand(value, ["stepId", "changes"]) && isId(value.stepId) && isStepContent(value.changes);
    case "moveGroceryItemsToSource": return isWeekCommand(value, ["itemIds", "source"]) && Array.isArray(value.itemIds) && value.itemIds.every(isId) && GROCERY_SOURCES.includes(value.source as GrocerySource);
    case "replaceMealRecipeFromSource": return isWeekCommand(value, ["mealId", "recipe"]) && isId(value.mealId) && isLegacySourcedRecipeReplacement(value.recipe);
    case "createWeekPlan": return hasKeys(value, ["type", "weekStartDate", "plan"]) && isWeekId(value.weekStartDate) && isWeekPlan(value.plan);
    default: return false;
  }
}
