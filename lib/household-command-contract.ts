import {
  FEEDBACK_VALUES,
  GROCERY_SOURCES,
  LEFTOVER_QUALITIES,
  MEAL_STATUSES,
  isIsoDate,
  isWeekId,
  type FeedbackValue,
  type GrocerySource,
  type InstructionStepContentInput,
  type InstructionStepPlanInput,
  type IsoDate,
  type LeftoverQuality,
  type MealSnapshotInput,
  type MealStatus,
  type WeekId,
  type WeekPlanInput,
} from "./household-contract.ts";
import {
  SOURCED_RECIPE_REPLACEMENT_SCHEMA,
  isSourcedRecipeReplacement,
  type SourcedRecipeReplacement,
} from "./sourced-recipe-contract.ts";

type WeekScoped = { weekId: WeekId };

export type HouseholdCommand =
  | ({ type: "moveMeal"; mealId: string; targetDate: IsoDate } & WeekScoped)
  | ({ type: "reorderMeals"; date: IsoDate; mealIds: string[] } & WeekScoped)
  | ({ type: "swapMealDays"; firstDate: IsoDate; secondDate: IsoDate } & WeekScoped)
  | ({ type: "updateMealStatus"; mealId: string; status: MealStatus } & WeekScoped)
  | ({ type: "updateMealSnapshot"; mealId: string; changes: MealSnapshotInput } & WeekScoped)
  | ({
      type: "replaceMealRecipeFromSource";
      mealId: string;
      recipe: SourcedRecipeReplacement;
    } & WeekScoped)
  | ({
      type: "addInstructionStep";
      mealId: string;
      position: number;
      step: InstructionStepPlanInput;
    } & WeekScoped)
  | ({
      type: "updateInstructionStep";
      stepId: string;
      changes: InstructionStepContentInput;
    } & WeekScoped)
  | ({ type: "moveInstructionStep"; stepId: string; targetPosition: number } & WeekScoped)
  | ({ type: "removeInstructionStep"; stepId: string } & WeekScoped)
  | ({ type: "setInstructionStepComplete"; stepId: string; complete: boolean } & WeekScoped)
  | ({ type: "updateInstructionStepNote"; stepId: string; note: string } & WeekScoped)
  | ({ type: "startInstructionTimer"; stepId: string } & WeekScoped)
  | ({ type: "pauseInstructionTimer"; stepId: string } & WeekScoped)
  | ({ type: "resetInstructionTimer"; stepId: string } & WeekScoped)
  | ({ type: "setInstructionTimerRemaining"; stepId: string; remainingSeconds: number } & WeekScoped)
  | ({ type: "createPrepSession"; label: string; prepDate: IsoDate | null } & WeekScoped)
  | ({ type: "updatePrepSession"; sessionId: string; label: string; prepDate: IsoDate | null } & WeekScoped)
  | ({ type: "movePrepSession"; sessionId: string; targetPosition: number } & WeekScoped)
  | ({ type: "removePrepSession"; sessionId: string } & WeekScoped)
  | ({ type: "addPrepSessionStep"; sessionId: string; stepId: string; targetPosition: number } & WeekScoped)
  | ({ type: "addPrepSessionSteps"; sessionId: string; stepIds: string[]; targetPosition: number } & WeekScoped)
  | ({ type: "movePrepSessionStep"; sessionId: string; entryId: string; targetPosition: number } & WeekScoped)
  | ({ type: "movePrepSessionSteps"; sourceSessionId: string; sessionId: string; entryIds: string[]; targetPosition: number } & WeekScoped)
  | ({ type: "removePrepSessionStep"; sessionId: string; entryId: string } & WeekScoped)
  | ({
      type: "setPrepPlan";
      entries: Array<{ stepId: string; prepDate: IsoDate }>;
    } & WeekScoped)
  | ({ type: "movePrepReference"; referenceId: string; targetPosition: number } & WeekScoped)
  | ({ type: "reschedulePrepReference"; referenceId: string; prepDate: IsoDate } & WeekScoped)
  | ({ type: "removePrepReference"; referenceId: string } & WeekScoped)
  | ({
      type: "moveGroceryItemsToSource";
      itemIds: string[];
      source: GrocerySource;
    } & WeekScoped)
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
  | { type: "createWeekPlan"; weekStartDate: WeekId; plan: WeekPlanInput }
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

export const MAX_COMMAND_TEXT_LENGTH = 4_000;
export const MAX_ID_LENGTH = 200;
export const MAX_PREP_ENTRIES = 64;
export const MAX_PREP_SESSIONS = 32;
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

const idSchema = { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH };
const textSchema = { type: "string", maxLength: MAX_COMMAND_TEXT_LENGTH };
const nonemptyTextSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_COMMAND_TEXT_LENGTH,
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
const nullablePrepDateSchema = {
  anyOf: [isoDateSchema, { type: "null" }],
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
const mealPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "date",
    "title",
    "subtitle",
    "venue",
    "protein",
    "prepNote",
    "leftoverNote",
    "notes",
    "ingredients",
    "instructions",
  ],
  properties: {
    ...mealSnapshotSchema.properties,
    date: isoDateSchema,
    status: { type: "string", enum: [...MEAL_STATUSES] },
    protein: { type: "string", enum: ["chicken", "salmon", "none"] },
    instructions: {
      type: "array",
      maxItems: MAX_STEPS_PER_MEAL,
      items: stepPlanSchema,
    },
    yieldText: { type: "string", minLength: 1, maxLength: 80 },
  },
};
const weekPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["meals"],
  properties: {
    meals: { type: "array", maxItems: MAX_MEALS_PER_WEEK, items: mealPlanSchema },
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

const HOUSEHOLD_COMMAND_SCHEMAS = {
  moveMeal: weekCommandSchema("moveMeal", { mealId: idSchema, targetDate: isoDateSchema }),
  reorderMeals: weekCommandSchema("reorderMeals", { date: isoDateSchema, mealIds: { type: "array", minItems: 1, maxItems: MAX_MEALS_PER_WEEK, items: idSchema } }),
  swapMealDays: weekCommandSchema("swapMealDays", { firstDate: isoDateSchema, secondDate: isoDateSchema }),
  updateMealStatus: weekCommandSchema("updateMealStatus", { mealId: idSchema, status: { type: "string", enum: [...MEAL_STATUSES] } }),
  updateMealSnapshot: weekCommandSchema("updateMealSnapshot", { mealId: idSchema, changes: mealSnapshotSchema }),
  replaceMealRecipeFromSource: weekCommandSchema("replaceMealRecipeFromSource", {
    mealId: idSchema,
    recipe: SOURCED_RECIPE_REPLACEMENT_SCHEMA,
  }),
  addInstructionStep: weekCommandSchema("addInstructionStep", { mealId: idSchema, position: { type: "integer", minimum: 0, maximum: MAX_STEPS_PER_MEAL - 1 }, step: stepPlanSchema }),
  updateInstructionStep: weekCommandSchema("updateInstructionStep", { stepId: idSchema, changes: stepContentSchema }),
  moveInstructionStep: weekCommandSchema("moveInstructionStep", { stepId: idSchema, targetPosition: { type: "integer", minimum: 0, maximum: MAX_STEPS_PER_MEAL - 1 } }),
  removeInstructionStep: weekCommandSchema("removeInstructionStep", { stepId: idSchema }),
  setInstructionStepComplete: weekCommandSchema("setInstructionStepComplete", { stepId: idSchema, complete: { type: "boolean" } }),
  updateInstructionStepNote: weekCommandSchema("updateInstructionStepNote", { stepId: idSchema, note: textSchema }),
  startInstructionTimer: weekCommandSchema("startInstructionTimer", { stepId: idSchema }),
  pauseInstructionTimer: weekCommandSchema("pauseInstructionTimer", { stepId: idSchema }),
  resetInstructionTimer: weekCommandSchema("resetInstructionTimer", { stepId: idSchema }),
  setInstructionTimerRemaining: weekCommandSchema("setInstructionTimerRemaining", { stepId: idSchema, remainingSeconds: timerDurationSchema }),
  createPrepSession: weekCommandSchema("createPrepSession", { label: nonemptyTextSchema, prepDate: nullablePrepDateSchema }),
  updatePrepSession: weekCommandSchema("updatePrepSession", { sessionId: idSchema, label: nonemptyTextSchema, prepDate: nullablePrepDateSchema }),
  movePrepSession: weekCommandSchema("movePrepSession", { sessionId: idSchema, targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_SESSIONS - 1 } }),
  removePrepSession: weekCommandSchema("removePrepSession", { sessionId: idSchema }),
  addPrepSessionStep: weekCommandSchema("addPrepSessionStep", { sessionId: idSchema, stepId: idSchema, targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES - 1 } }),
  addPrepSessionSteps: weekCommandSchema("addPrepSessionSteps", {
    sessionId: idSchema,
    stepIds: { type: "array", minItems: 1, maxItems: MAX_PREP_ENTRIES, items: idSchema },
    targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES - 1 },
  }),
  movePrepSessionStep: weekCommandSchema("movePrepSessionStep", { sessionId: idSchema, entryId: idSchema, targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES - 1 } }),
  movePrepSessionSteps: weekCommandSchema("movePrepSessionSteps", {
    sourceSessionId: idSchema,
    sessionId: idSchema,
    entryIds: { type: "array", minItems: 1, maxItems: MAX_PREP_ENTRIES, items: idSchema },
    targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES },
  }),
  removePrepSessionStep: weekCommandSchema("removePrepSessionStep", { sessionId: idSchema, entryId: idSchema }),
  setPrepPlan: weekCommandSchema("setPrepPlan", {
      entries: {
        type: "array",
        maxItems: MAX_PREP_ENTRIES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["stepId", "prepDate"],
          properties: { stepId: idSchema, prepDate: isoDateSchema },
        },
      },
    }),
  movePrepReference: weekCommandSchema("movePrepReference", { referenceId: idSchema, targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES - 1 } }),
  reschedulePrepReference: weekCommandSchema("reschedulePrepReference", { referenceId: idSchema, prepDate: isoDateSchema }),
  removePrepReference: weekCommandSchema("removePrepReference", { referenceId: idSchema }),
  moveGroceryItemsToSource: weekCommandSchema("moveGroceryItemsToSource", {
    itemIds: groceryItemIdsSchema,
    source: { type: "string", enum: [...GROCERY_SOURCES] },
  }),
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

function isWeekCommand(value: Record<string, unknown>, fields: string[]) {
  return hasKeys(value, ["type", "weekId", ...fields]) && isWeekId(value.weekId);
}

export type HouseholdCommandScope = "workspace" | "week";
export type HouseholdCommandExposure = "ordinary" | "explicit_foreground";

type HouseholdCommandRegistryEntry = {
  schema: Record<string, unknown>;
  scope: HouseholdCommandScope;
  exposure: HouseholdCommandExposure;
  validate(value: Record<string, unknown>): boolean;
};

function validatePrepPlan(value: Record<string, unknown>): boolean {
  if (!isWeekCommand(value, ["entries"]) || !Array.isArray(value.entries) || value.entries.length > MAX_PREP_ENTRIES) return false;
  const stepIds = new Set<string>();
  return value.entries.every((entry) => {
    if (!hasKeys(entry, ["stepId", "prepDate"]) || !isId(entry.stepId) || !isIsoDate(entry.prepDate) || stepIds.has(entry.stepId)) return false;
    stepIds.add(entry.stepId);
    return true;
  });
}

export const HOUSEHOLD_COMMAND_REGISTRY = {
  moveMeal: { schema: HOUSEHOLD_COMMAND_SCHEMAS.moveMeal, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "targetDate"]) && isId(value.mealId) && isIsoDate(value.targetDate) },
  reorderMeals: { schema: HOUSEHOLD_COMMAND_SCHEMAS.reorderMeals, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["date", "mealIds"]) && isIsoDate(value.date) && Array.isArray(value.mealIds) && value.mealIds.length >= 1 && value.mealIds.length <= MAX_MEALS_PER_WEEK && value.mealIds.every(isId) && new Set(value.mealIds).size === value.mealIds.length },
  swapMealDays: { schema: HOUSEHOLD_COMMAND_SCHEMAS.swapMealDays, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["firstDate", "secondDate"]) && isIsoDate(value.firstDate) && isIsoDate(value.secondDate) && value.firstDate !== value.secondDate },
  updateMealStatus: { schema: HOUSEHOLD_COMMAND_SCHEMAS.updateMealStatus, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "status"]) && isId(value.mealId) && MEAL_STATUSES.includes(value.status as MealStatus) },
  updateMealSnapshot: { schema: HOUSEHOLD_COMMAND_SCHEMAS.updateMealSnapshot, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "changes"]) && isId(value.mealId) && isMealSnapshot(value.changes) },
  replaceMealRecipeFromSource: { schema: HOUSEHOLD_COMMAND_SCHEMAS.replaceMealRecipeFromSource, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "recipe"]) && isId(value.mealId) && isSourcedRecipeReplacement(value.recipe) },
  addInstructionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.addInstructionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "position", "step"]) && isId(value.mealId) && isIntegerInRange(value.position, 0, MAX_STEPS_PER_MEAL - 1) && isStepPlan(value.step) },
  updateInstructionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.updateInstructionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "changes"]) && isId(value.stepId) && isStepContent(value.changes) },
  moveInstructionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.moveInstructionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "targetPosition"]) && isId(value.stepId) && isIntegerInRange(value.targetPosition, 0, MAX_STEPS_PER_MEAL - 1) },
  removeInstructionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.removeInstructionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId"]) && isId(value.stepId) },
  setInstructionStepComplete: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setInstructionStepComplete, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "complete"]) && isId(value.stepId) && typeof value.complete === "boolean" },
  updateInstructionStepNote: { schema: HOUSEHOLD_COMMAND_SCHEMAS.updateInstructionStepNote, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "note"]) && isId(value.stepId) && isText(value.note) },
  startInstructionTimer: { schema: HOUSEHOLD_COMMAND_SCHEMAS.startInstructionTimer, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId"]) && isId(value.stepId) },
  pauseInstructionTimer: { schema: HOUSEHOLD_COMMAND_SCHEMAS.pauseInstructionTimer, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId"]) && isId(value.stepId) },
  resetInstructionTimer: { schema: HOUSEHOLD_COMMAND_SCHEMAS.resetInstructionTimer, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId"]) && isId(value.stepId) },
  setInstructionTimerRemaining: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setInstructionTimerRemaining, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["stepId", "remainingSeconds"]) && isId(value.stepId) && isIntegerInRange(value.remainingSeconds, 1, MAX_TIMER_DURATION_SECONDS) },
  createPrepSession: { schema: HOUSEHOLD_COMMAND_SCHEMAS.createPrepSession, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["label", "prepDate"]) && isText(value.label, MAX_COMMAND_TEXT_LENGTH, false) && (value.prepDate === null || isIsoDate(value.prepDate)) },
  updatePrepSession: { schema: HOUSEHOLD_COMMAND_SCHEMAS.updatePrepSession, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sessionId", "label", "prepDate"]) && isId(value.sessionId) && isText(value.label, MAX_COMMAND_TEXT_LENGTH, false) && (value.prepDate === null || isIsoDate(value.prepDate)) },
  movePrepSession: { schema: HOUSEHOLD_COMMAND_SCHEMAS.movePrepSession, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sessionId", "targetPosition"]) && isId(value.sessionId) && isIntegerInRange(value.targetPosition, 0, MAX_PREP_SESSIONS - 1) },
  removePrepSession: { schema: HOUSEHOLD_COMMAND_SCHEMAS.removePrepSession, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sessionId"]) && isId(value.sessionId) },
  addPrepSessionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.addPrepSessionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sessionId", "stepId", "targetPosition"]) && isId(value.sessionId) && isId(value.stepId) && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES - 1) },
  addPrepSessionSteps: { schema: HOUSEHOLD_COMMAND_SCHEMAS.addPrepSessionSteps, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sessionId", "stepIds", "targetPosition"]) && isId(value.sessionId) && Array.isArray(value.stepIds) && value.stepIds.length >= 1 && value.stepIds.length <= MAX_PREP_ENTRIES && value.stepIds.every(isId) && new Set(value.stepIds).size === value.stepIds.length && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES - 1) },
  movePrepSessionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.movePrepSessionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sessionId", "entryId", "targetPosition"]) && isId(value.sessionId) && isId(value.entryId) && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES - 1) },
  movePrepSessionSteps: { schema: HOUSEHOLD_COMMAND_SCHEMAS.movePrepSessionSteps, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sourceSessionId", "sessionId", "entryIds", "targetPosition"]) && isId(value.sourceSessionId) && isId(value.sessionId) && Array.isArray(value.entryIds) && value.entryIds.length >= 1 && value.entryIds.length <= MAX_PREP_ENTRIES && value.entryIds.every(isId) && new Set(value.entryIds).size === value.entryIds.length && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES) },
  removePrepSessionStep: { schema: HOUSEHOLD_COMMAND_SCHEMAS.removePrepSessionStep, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["sessionId", "entryId"]) && isId(value.sessionId) && isId(value.entryId) },
  setPrepPlan: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setPrepPlan, scope: "week", exposure: "ordinary", validate: validatePrepPlan },
  movePrepReference: { schema: HOUSEHOLD_COMMAND_SCHEMAS.movePrepReference, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["referenceId", "targetPosition"]) && isId(value.referenceId) && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES - 1) },
  reschedulePrepReference: { schema: HOUSEHOLD_COMMAND_SCHEMAS.reschedulePrepReference, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["referenceId", "prepDate"]) && isId(value.referenceId) && isIsoDate(value.prepDate) },
  removePrepReference: { schema: HOUSEHOLD_COMMAND_SCHEMAS.removePrepReference, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["referenceId"]) && isId(value.referenceId) },
  moveGroceryItemsToSource: { schema: HOUSEHOLD_COMMAND_SCHEMAS.moveGroceryItemsToSource, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["itemIds", "source"]) && Array.isArray(value.itemIds) && value.itemIds.length >= 1 && value.itemIds.length <= MAX_GROCERY_ITEMS && value.itemIds.every(isId) && new Set(value.itemIds).size === value.itemIds.length && GROCERY_SOURCES.includes(value.source as GrocerySource) },
  setGroceryItemChecked: { schema: HOUSEHOLD_COMMAND_SCHEMAS.setGroceryItemChecked, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["itemId", "checked"]) && isId(value.itemId) && typeof value.checked === "boolean" },
  captureFeedback: { schema: HOUSEHOLD_COMMAND_SCHEMAS.captureFeedback, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["mealId", "value"]) && isId(value.mealId) && FEEDBACK_VALUES.includes(value.value as FeedbackValue) },
  captureWeekLesson: { schema: HOUSEHOLD_COMMAND_SCHEMAS.captureWeekLesson, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["weekLesson"]) && isText(value.weekLesson) },
  captureLeftoverQuality: { schema: HOUSEHOLD_COMMAND_SCHEMAS.captureLeftoverQuality, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["leftoverId", "quality"]) && isId(value.leftoverId) && LEFTOVER_QUALITIES.includes(value.quality as LeftoverQuality) },
  assignLeftover: { schema: HOUSEHOLD_COMMAND_SCHEMAS.assignLeftover, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["leftoverId", "targetDate"]) && isId(value.leftoverId) && isIsoDate(value.targetDate) },
  consumeLeftover: { schema: HOUSEHOLD_COMMAND_SCHEMAS.consumeLeftover, scope: "week", exposure: "ordinary", validate: (value) => isWeekCommand(value, ["leftoverId"]) && isId(value.leftoverId) },
  archiveWeek: { schema: HOUSEHOLD_COMMAND_SCHEMAS.archiveWeek, scope: "week", exposure: "explicit_foreground", validate: (value) => isWeekCommand(value, []) },
  createWeekPlan: { schema: HOUSEHOLD_COMMAND_SCHEMAS.createWeekPlan, scope: "workspace", exposure: "ordinary", validate: (value) => hasKeys(value, ["type", "weekStartDate", "plan"]) && isWeekId(value.weekStartDate) && isWeekPlan(value.plan) },
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
