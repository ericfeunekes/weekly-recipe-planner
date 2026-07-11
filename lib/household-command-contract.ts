import {
  FEEDBACK_VALUES,
  LEFTOVER_QUALITIES,
  MEAL_SLOTS,
  MEAL_STATUSES,
  isIsoDate,
  isWeekId,
  type FeedbackValue,
  type GroceryItemContentInput,
  type GroceryItemPlanInput,
  type GroceryReconciliationItem,
  type InstructionStepContentInput,
  type InstructionStepPlanInput,
  type IsoDate,
  type LeftoverQuality,
  type MealSlot,
  type MealSnapshotInput,
  type MealStatus,
  type WeekId,
  type WeekPlanInput,
} from "./household-contract.ts";

type WeekScoped = { weekId: WeekId };

export type HouseholdCommand =
  | ({ type: "moveMeal"; mealId: string; targetDate: IsoDate; slot: MealSlot } & WeekScoped)
  | ({ type: "updateMealStatus"; mealId: string; status: MealStatus } & WeekScoped)
  | ({ type: "updateMealSnapshot"; mealId: string; changes: MealSnapshotInput } & WeekScoped)
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
  | ({ type: "resetInstructionTimer"; stepId: string } & WeekScoped)
  | ({
      type: "setPrepPlan";
      entries: Array<{ stepId: string; prepDate: IsoDate }>;
    } & WeekScoped)
  | ({ type: "movePrepReference"; referenceId: string; targetPosition: number } & WeekScoped)
  | ({ type: "reschedulePrepReference"; referenceId: string; prepDate: IsoDate } & WeekScoped)
  | ({ type: "removePrepReference"; referenceId: string } & WeekScoped)
  | ({ type: "addGroceryItem"; item: GroceryItemPlanInput } & WeekScoped)
  | ({
      type: "updateGroceryItem";
      itemId: string;
      changes: GroceryItemContentInput;
    } & WeekScoped)
  | ({ type: "removeGroceryItem"; itemId: string } & WeekScoped)
  | ({ type: "setGroceryItemChecked"; itemId: string; checked: boolean } & WeekScoped)
  | ({ type: "reconcileGroceries"; items: GroceryReconciliationItem[] } & WeekScoped)
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
      slot: MealSlot;
    } & WeekScoped)
  | ({ type: "consumeLeftover"; leftoverId: string } & WeekScoped)
  | ({ type: "archiveWeek" } & WeekScoped)
  | { type: "createWeekPlan"; weekStartDate: WeekId; plan: WeekPlanInput }
  | { type: "activateWeek"; weekId: WeekId }
  | { type: "handoffWeek"; currentWeekId: WeekId; nextWeekId: WeekId };

export const MAX_COMMAND_TEXT_LENGTH = 4_000;
export const MAX_ID_LENGTH = 200;
export const MAX_PREP_ENTRIES = 64;
export const MAX_MEALS_PER_WEEK = 14;
export const MAX_STEPS_PER_MEAL = 64;
export const MAX_STEP_INPUTS = 32;
export const MAX_INGREDIENT_LINES = 128;
export const MAX_GROCERY_ITEMS = 256;
export const MAX_TIMER_DURATION_SECONDS = 86_400;

const idSchema = { type: "string", minLength: 1, maxLength: MAX_ID_LENGTH };
const textSchema = { type: "string", maxLength: MAX_COMMAND_TEXT_LENGTH };
const nonemptyTextSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_COMMAND_TEXT_LENGTH,
};
const groceryItemTextSchema = {
  type: "string",
  minLength: 1,
  maxLength: 1_000,
};
const isoDateSchema = {
  type: "string",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
};
const weekIdSchema = isoDateSchema;
const timerDurationSchema = {
  anyOf: [
    { type: "integer", minimum: 1, maximum: MAX_TIMER_DURATION_SECONDS },
    { type: "null" },
  ],
};
const nullableTextSchema = {
  anyOf: [textSchema, { type: "null" }],
};
const stepInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "ingredient"],
  properties: {
    amount: { type: "string", maxLength: 300 },
    ingredient: { type: "string", maxLength: 1_000 },
  },
};
const stepPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputs", "instruction", "timerDurationSeconds", "note"],
  properties: {
    inputs: { type: "array", maxItems: MAX_STEP_INPUTS, items: stepInputSchema },
    instruction: nonemptyTextSchema,
    timerDurationSeconds: timerDurationSchema,
    note: nullableTextSchema,
  },
};
const stepContentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputs", "instruction", "timerDurationSeconds"],
  properties: {
    inputs: stepPlanSchema.properties.inputs,
    instruction: stepPlanSchema.properties.instruction,
    timerDurationSeconds: timerDurationSchema,
  },
};
const groceryContentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["section", "item", "detail", "farmBox"],
  properties: {
    section: {
      type: "string",
      enum: ["Produce", "Meat & seafood", "Dairy", "Pantry"],
    },
    item: groceryItemTextSchema,
    detail: textSchema,
    farmBox: { type: "boolean" },
  },
};
const groceryPlanSchema = {
  ...groceryContentSchema,
  required: [...groceryContentSchema.required, "checked"],
  properties: {
    ...groceryContentSchema.properties,
    checked: { anyOf: [{ type: "boolean" }, { type: "null" }] },
  },
};
const reconciliationItemSchema = {
  ...groceryContentSchema,
  required: [...groceryPlanSchema.required, "id"],
  properties: {
    ...groceryPlanSchema.properties,
    id: { anyOf: [idSchema, { type: "null" }] },
  },
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
  ],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 300 },
    subtitle: { type: "string", maxLength: 1_000 },
    venue: { type: "string", minLength: 1, maxLength: 300 },
    prepNote: textSchema,
    leftoverNote: textSchema,
    notes: textSchema,
    ingredients: {
      type: "array",
      maxItems: MAX_INGREDIENT_LINES,
      items: { type: "string", maxLength: 1_000 },
    },
  },
};
const mealPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "date",
    "slot",
    "title",
    "subtitle",
    "venue",
    "protein",
    "prepNote",
    "leftoverNote",
    "notes",
    "ingredients",
    "instructions",
    "status",
  ],
  properties: {
    ...mealSnapshotSchema.properties,
    date: isoDateSchema,
    slot: { type: "string", enum: [...MEAL_SLOTS] },
    status: {
      anyOf: [
        { type: "string", enum: [...MEAL_STATUSES] },
        { type: "null" },
      ],
    },
    protein: { type: "string", enum: ["chicken", "salmon", "none"] },
    instructions: {
      type: "array",
      maxItems: MAX_STEPS_PER_MEAL,
      items: stepPlanSchema,
    },
  },
};
const weekPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["meals", "groceries", "weekLesson"],
  properties: {
    meals: { type: "array", maxItems: MAX_MEALS_PER_WEEK, items: mealPlanSchema },
    groceries: {
      type: "array",
      maxItems: MAX_GROCERY_ITEMS,
      items: groceryPlanSchema,
    },
    weekLesson: nullableTextSchema,
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

export const HOUSEHOLD_COMMAND_SCHEMA = {
  anyOf: [
    weekCommandSchema("moveMeal", { mealId: idSchema, targetDate: isoDateSchema, slot: { type: "string", enum: [...MEAL_SLOTS] } }),
    weekCommandSchema("updateMealStatus", { mealId: idSchema, status: { type: "string", enum: [...MEAL_STATUSES] } }),
    weekCommandSchema("updateMealSnapshot", { mealId: idSchema, changes: mealSnapshotSchema }),
    weekCommandSchema("addInstructionStep", { mealId: idSchema, position: { type: "integer", minimum: 0, maximum: MAX_STEPS_PER_MEAL - 1 }, step: stepPlanSchema }),
    weekCommandSchema("updateInstructionStep", { stepId: idSchema, changes: stepContentSchema }),
    weekCommandSchema("moveInstructionStep", { stepId: idSchema, targetPosition: { type: "integer", minimum: 0, maximum: MAX_STEPS_PER_MEAL - 1 } }),
    weekCommandSchema("removeInstructionStep", { stepId: idSchema }),
    weekCommandSchema("setInstructionStepComplete", { stepId: idSchema, complete: { type: "boolean" } }),
    weekCommandSchema("updateInstructionStepNote", { stepId: idSchema, note: textSchema }),
    weekCommandSchema("startInstructionTimer", { stepId: idSchema }),
    weekCommandSchema("resetInstructionTimer", { stepId: idSchema }),
    weekCommandSchema("setPrepPlan", {
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
    weekCommandSchema("movePrepReference", { referenceId: idSchema, targetPosition: { type: "integer", minimum: 0, maximum: MAX_PREP_ENTRIES - 1 } }),
    weekCommandSchema("reschedulePrepReference", { referenceId: idSchema, prepDate: isoDateSchema }),
    weekCommandSchema("removePrepReference", { referenceId: idSchema }),
    weekCommandSchema("addGroceryItem", { item: groceryPlanSchema }),
    weekCommandSchema("updateGroceryItem", { itemId: idSchema, changes: groceryContentSchema }),
    weekCommandSchema("removeGroceryItem", { itemId: idSchema }),
    weekCommandSchema("setGroceryItemChecked", { itemId: idSchema, checked: { type: "boolean" } }),
    weekCommandSchema("reconcileGroceries", { items: { type: "array", maxItems: MAX_GROCERY_ITEMS, items: reconciliationItemSchema } }),
    weekCommandSchema("captureFeedback", { mealId: idSchema, value: { type: "string", enum: [...FEEDBACK_VALUES] } }),
    weekCommandSchema("captureWeekLesson", { weekLesson: textSchema }),
    weekCommandSchema("captureLeftoverQuality", { leftoverId: idSchema, quality: { type: "string", enum: [...LEFTOVER_QUALITIES] } }),
    weekCommandSchema("assignLeftover", { leftoverId: idSchema, targetDate: isoDateSchema, slot: { type: "string", enum: [...MEAL_SLOTS] } }),
    weekCommandSchema("consumeLeftover", { leftoverId: idSchema }),
    weekCommandSchema("archiveWeek"),
    commandSchema("createWeekPlan", { weekStartDate: weekIdSchema, plan: weekPlanSchema }),
    commandSchema("activateWeek", { weekId: weekIdSchema }),
    commandSchema("handoffWeek", { currentWeekId: weekIdSchema, nextWeekId: weekIdSchema }),
  ],
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
  return hasKeys(value, ["amount", "ingredient"]) && isText(value.amount, 300) && isText(value.ingredient, 1_000);
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
  return hasKeys(value, ["title", "subtitle", "venue", "prepNote", "leftoverNote", "notes", "ingredients"]) && hasMealSnapshotFields(value);
}

function hasMealSnapshotFields(value: Record<string, unknown>) {
  return (
    isText(value.title, 300, false) &&
    isText(value.subtitle, 1_000) &&
    isText(value.venue, 300, false) &&
    isText(value.prepNote) &&
    isText(value.leftoverNote) &&
    isText(value.notes) &&
    Array.isArray(value.ingredients) &&
    value.ingredients.length <= MAX_INGREDIENT_LINES &&
    value.ingredients.every((ingredient) => isText(ingredient, 1_000))
  );
}

function isGroceryContent(
  value: unknown,
  allowChecked = false,
  allowId = false,
  requireChecked = false,
) {
  const optional = [allowChecked ? "checked" : "", allowId ? "id" : ""].filter(Boolean);
  if (!hasKeys(value, ["section", "item", "detail", "farmBox"], optional)) return false;
  if (!["Produce", "Meat & seafood", "Dairy", "Pantry"].includes(value.section as string)) return false;
  if (!isText(value.item, 1_000, false) || !isText(value.detail) || typeof value.farmBox !== "boolean") return false;
  if (requireChecked && typeof value.checked !== "boolean") return false;
  if (value.checked !== undefined && typeof value.checked !== "boolean") return false;
  return value.id === undefined || isId(value.id);
}

function isMealPlan(value: unknown) {
  if (!hasKeys(value, ["date", "slot", "title", "subtitle", "venue", "protein", "prepNote", "leftoverNote", "notes", "ingredients", "instructions"], ["status"])) return false;
  if (!isIsoDate(value.date) || !MEAL_SLOTS.includes(value.slot as MealSlot)) return false;
  if (value.status !== undefined && !MEAL_STATUSES.includes(value.status as MealStatus)) return false;
  if (!["chicken", "salmon", "none"].includes(value.protein as string)) return false;
  if (!hasMealSnapshotFields(value)) return false;
  return Array.isArray(value.instructions) && value.instructions.length <= MAX_STEPS_PER_MEAL && value.instructions.every((step) => isStepPlan(step));
}

function isWeekPlan(value: unknown): value is WeekPlanInput {
  return (
    hasKeys(value, ["meals", "groceries"], ["weekLesson"]) &&
    Array.isArray(value.meals) &&
    value.meals.length <= MAX_MEALS_PER_WEEK &&
    value.meals.every(isMealPlan) &&
    Array.isArray(value.groceries) &&
    value.groceries.length <= MAX_GROCERY_ITEMS &&
    value.groceries.every((item) => isGroceryContent(item, true)) &&
    (value.weekLesson === undefined || isText(value.weekLesson))
  );
}

function isWeekCommand(value: Record<string, unknown>, fields: string[]) {
  return hasKeys(value, ["type", "weekId", ...fields]) && isWeekId(value.weekId);
}

export function isHouseholdCommand(value: unknown): value is HouseholdCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "moveMeal":
      return isWeekCommand(value, ["mealId", "targetDate", "slot"]) && isId(value.mealId) && isIsoDate(value.targetDate) && MEAL_SLOTS.includes(value.slot as MealSlot);
    case "updateMealStatus":
      return isWeekCommand(value, ["mealId", "status"]) && isId(value.mealId) && MEAL_STATUSES.includes(value.status as MealStatus);
    case "updateMealSnapshot":
      return isWeekCommand(value, ["mealId", "changes"]) && isId(value.mealId) && isMealSnapshot(value.changes);
    case "addInstructionStep":
      return isWeekCommand(value, ["mealId", "position", "step"]) && isId(value.mealId) && isIntegerInRange(value.position, 0, MAX_STEPS_PER_MEAL - 1) && isStepPlan(value.step);
    case "updateInstructionStep":
      return isWeekCommand(value, ["stepId", "changes"]) && isId(value.stepId) && isStepContent(value.changes);
    case "moveInstructionStep":
      return isWeekCommand(value, ["stepId", "targetPosition"]) && isId(value.stepId) && isIntegerInRange(value.targetPosition, 0, MAX_STEPS_PER_MEAL - 1);
    case "removeInstructionStep":
    case "startInstructionTimer":
    case "resetInstructionTimer":
      return isWeekCommand(value, ["stepId"]) && isId(value.stepId);
    case "setInstructionStepComplete":
      return isWeekCommand(value, ["stepId", "complete"]) && isId(value.stepId) && typeof value.complete === "boolean";
    case "updateInstructionStepNote":
      return isWeekCommand(value, ["stepId", "note"]) && isId(value.stepId) && isText(value.note);
    case "setPrepPlan": {
      if (!isWeekCommand(value, ["entries"]) || !Array.isArray(value.entries) || value.entries.length > MAX_PREP_ENTRIES) return false;
      const stepIds = new Set<string>();
      return value.entries.every((entry) => {
        if (!hasKeys(entry, ["stepId", "prepDate"]) || !isId(entry.stepId) || !isIsoDate(entry.prepDate) || stepIds.has(entry.stepId)) return false;
        stepIds.add(entry.stepId);
        return true;
      });
    }
    case "movePrepReference":
      return isWeekCommand(value, ["referenceId", "targetPosition"]) && isId(value.referenceId) && isIntegerInRange(value.targetPosition, 0, MAX_PREP_ENTRIES - 1);
    case "reschedulePrepReference":
      return isWeekCommand(value, ["referenceId", "prepDate"]) && isId(value.referenceId) && isIsoDate(value.prepDate);
    case "removePrepReference":
      return isWeekCommand(value, ["referenceId"]) && isId(value.referenceId);
    case "addGroceryItem":
      return isWeekCommand(value, ["item"]) && isGroceryContent(value.item, true);
    case "updateGroceryItem":
      return isWeekCommand(value, ["itemId", "changes"]) && isId(value.itemId) && isGroceryContent(value.changes);
    case "removeGroceryItem":
      return isWeekCommand(value, ["itemId"]) && isId(value.itemId);
    case "setGroceryItemChecked":
      return isWeekCommand(value, ["itemId", "checked"]) && isId(value.itemId) && typeof value.checked === "boolean";
    case "reconcileGroceries": {
      if (!isWeekCommand(value, ["items"]) || !Array.isArray(value.items) || value.items.length > MAX_GROCERY_ITEMS || !value.items.every((item) => isGroceryContent(item, true, true, true))) return false;
      const ids = value.items.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []));
      return new Set(ids).size === ids.length;
    }
    case "captureFeedback":
      return isWeekCommand(value, ["mealId", "value"]) && isId(value.mealId) && FEEDBACK_VALUES.includes(value.value as FeedbackValue);
    case "captureWeekLesson":
      return isWeekCommand(value, ["weekLesson"]) && isText(value.weekLesson);
    case "captureLeftoverQuality":
      return isWeekCommand(value, ["leftoverId", "quality"]) && isId(value.leftoverId) && LEFTOVER_QUALITIES.includes(value.quality as LeftoverQuality);
    case "assignLeftover":
      return isWeekCommand(value, ["leftoverId", "targetDate", "slot"]) && isId(value.leftoverId) && isIsoDate(value.targetDate) && MEAL_SLOTS.includes(value.slot as MealSlot);
    case "consumeLeftover":
      return isWeekCommand(value, ["leftoverId"]) && isId(value.leftoverId);
    case "archiveWeek":
      return isWeekCommand(value, []);
    case "createWeekPlan":
      return hasKeys(value, ["type", "weekStartDate", "plan"]) && isWeekId(value.weekStartDate) && isWeekPlan(value.plan);
    case "activateWeek":
      return hasKeys(value, ["type", "weekId"]) && isWeekId(value.weekId);
    case "handoffWeek":
      return hasKeys(value, ["type", "currentWeekId", "nextWeekId"]) && isWeekId(value.currentWeekId) && isWeekId(value.nextWeekId) && value.currentWeekId !== value.nextWeekId;
    default:
      return false;
  }
}
