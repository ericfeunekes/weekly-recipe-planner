export const MAX_PREP_ENTRIES = 64;

export const MEAL_STATUSES = [
  "planned",
  "moved",
  "cooking",
  "cooked",
  "leftover",
  "flex",
] as const;

export const FEEDBACK_VALUES = ["repeat", "modify", "drop"] as const;
export const LEFTOVER_QUALITIES = ["good", "mixed", "poor"] as const;

export type DomainCommand =
  | { type: "moveMeal"; mealId: string; targetDayIndex: number }
  | { type: "updateMealStatus"; mealId: string; status: (typeof MEAL_STATUSES)[number] }
  | {
      type: "updateMealSnapshot";
      mealId: string;
      changes: { title: string; venue: string; notes: string };
    }
  | { type: "toggleInstructionStep"; stepId: string }
  | { type: "updateInstructionStepNote"; stepId: string; note: string }
  | { type: "startInstructionTimer"; stepId: string }
  | { type: "resetInstructionTimer"; stepId: string }
  | {
      type: "setPrepPlan";
      entries: Array<{ stepId: string; due: string }>;
    }
  | { type: "movePrepReference"; referenceId: string; targetPosition: number }
  | { type: "reschedulePrepReference"; referenceId: string; due: string }
  | { type: "removePrepReference"; referenceId: string }
  | { type: "updateGroceryItem"; itemId: string }
  | { type: "reconcileGroceries" }
  | {
      type: "captureFeedback";
      mealId: string;
      value: (typeof FEEDBACK_VALUES)[number];
    }
  | { type: "captureWeekLesson"; weekLesson: string }
  | {
      type: "captureLeftoverQuality";
      leftoverId: string;
      quality: (typeof LEFTOVER_QUALITIES)[number];
    }
  | { type: "assignLeftover"; leftoverId: string; dayIndex: number }
  | { type: "consumeLeftover"; leftoverId: string }
  | { type: "archiveWeek" }
  | { type: "createWeekPlan" };

function commandSchema(type: string, properties: Record<string, unknown> = {}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", ...Object.keys(properties)],
    properties: {
      type: { type: "string", const: type },
      ...properties,
    },
  };
}

const idSchema = { type: "string", minLength: 1, maxLength: 200 };
const dayIndexSchema = { type: "integer", minimum: 0, maximum: 6 };
const dueSchema = { type: "string", minLength: 1, maxLength: 300 };
const prepEntrySchema = {
  type: "object",
  additionalProperties: false,
  required: ["stepId", "due"],
  properties: {
    stepId: idSchema,
    due: dueSchema,
  },
};

const DOMAIN_COMMAND_VARIANTS = [
  commandSchema("moveMeal", {
    mealId: idSchema,
    targetDayIndex: dayIndexSchema,
  }),
  commandSchema("updateMealStatus", {
    mealId: idSchema,
    status: { type: "string", enum: [...MEAL_STATUSES] },
  }),
  commandSchema("updateMealSnapshot", {
    mealId: idSchema,
    changes: {
      type: "object",
      additionalProperties: false,
      required: ["title", "venue", "notes"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 300 },
        venue: { type: "string", minLength: 1, maxLength: 300 },
        notes: { type: "string", maxLength: 4_000 },
      },
    },
  }),
  commandSchema("toggleInstructionStep", { stepId: idSchema }),
  commandSchema("updateInstructionStepNote", {
    stepId: idSchema,
    note: { type: "string", maxLength: 4_000 },
  }),
  commandSchema("startInstructionTimer", { stepId: idSchema }),
  commandSchema("resetInstructionTimer", { stepId: idSchema }),
  commandSchema("setPrepPlan", {
    entries: {
      type: "array",
      maxItems: MAX_PREP_ENTRIES,
      items: prepEntrySchema,
    },
  }),
  commandSchema("movePrepReference", {
    referenceId: idSchema,
    targetPosition: { type: "integer", minimum: 0, maximum: 63 },
  }),
  commandSchema("reschedulePrepReference", {
    referenceId: idSchema,
    due: dueSchema,
  }),
  commandSchema("removePrepReference", { referenceId: idSchema }),
  commandSchema("updateGroceryItem", { itemId: idSchema }),
  commandSchema("reconcileGroceries"),
  commandSchema("captureFeedback", {
    mealId: idSchema,
    value: { type: "string", enum: [...FEEDBACK_VALUES] },
  }),
  commandSchema("captureWeekLesson", {
    weekLesson: { type: "string", maxLength: 4_000 },
  }),
  commandSchema("captureLeftoverQuality", {
    leftoverId: idSchema,
    quality: { type: "string", enum: [...LEFTOVER_QUALITIES] },
  }),
  commandSchema("assignLeftover", {
    leftoverId: idSchema,
    dayIndex: dayIndexSchema,
  }),
  commandSchema("consumeLeftover", { leftoverId: idSchema }),
  commandSchema("archiveWeek"),
  commandSchema("createWeekPlan"),
];

export const DOMAIN_COMMAND_SCHEMA = {
  anyOf: DOMAIN_COMMAND_VARIANTS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(
  value: unknown,
  maxLength: number,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
) {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isId(value: unknown) {
  return isBoundedString(value, 200, { allowEmpty: false });
}

function isDayIndex(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

function isPrepPlanEntries(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_PREP_ENTRIES) return false;

  const stepIds = new Set<string>();
  for (const entry of value) {
    if (
      !hasExactKeys(entry, ["stepId", "due"]) ||
      !isId(entry.stepId) ||
      !isBoundedString(entry.due, 300, { allowEmpty: false }) ||
      stepIds.has(entry.stepId as string)
    ) {
      return false;
    }
    stepIds.add(entry.stepId as string);
  }
  return true;
}

export function isDomainCommand(value: unknown): value is DomainCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "moveMeal":
      return (
        hasExactKeys(value, ["type", "mealId", "targetDayIndex"]) &&
        isId(value.mealId) &&
        isDayIndex(value.targetDayIndex)
      );
    case "reconcileGroceries":
    case "archiveWeek":
    case "createWeekPlan":
      return hasExactKeys(value, ["type"]);
    case "updateMealStatus":
      return (
        hasExactKeys(value, ["type", "mealId", "status"]) &&
        isId(value.mealId) &&
        MEAL_STATUSES.includes(value.status as (typeof MEAL_STATUSES)[number])
      );
    case "updateMealSnapshot":
      return (
        hasExactKeys(value, ["type", "mealId", "changes"]) &&
        isId(value.mealId) &&
        hasExactKeys(value.changes, ["title", "venue", "notes"]) &&
        isBoundedString(value.changes.title, 300, { allowEmpty: false }) &&
        isBoundedString(value.changes.venue, 300, { allowEmpty: false }) &&
        isBoundedString(value.changes.notes, 4_000)
      );
    case "toggleInstructionStep":
    case "startInstructionTimer":
    case "resetInstructionTimer":
      return hasExactKeys(value, ["type", "stepId"]) && isId(value.stepId);
    case "updateInstructionStepNote":
      return (
        hasExactKeys(value, ["type", "stepId", "note"]) &&
        isId(value.stepId) &&
        isBoundedString(value.note, 4_000)
      );
    case "setPrepPlan":
      return hasExactKeys(value, ["type", "entries"]) && isPrepPlanEntries(value.entries);
    case "movePrepReference":
      return (
        hasExactKeys(value, ["type", "referenceId", "targetPosition"]) &&
        isId(value.referenceId) &&
        Number.isInteger(value.targetPosition) &&
        Number(value.targetPosition) >= 0 &&
        Number(value.targetPosition) <= 63
      );
    case "reschedulePrepReference":
      return (
        hasExactKeys(value, ["type", "referenceId", "due"]) &&
        isId(value.referenceId) &&
        isBoundedString(value.due, 300, { allowEmpty: false })
      );
    case "removePrepReference":
      return hasExactKeys(value, ["type", "referenceId"]) && isId(value.referenceId);
    case "updateGroceryItem":
      return hasExactKeys(value, ["type", "itemId"]) && isId(value.itemId);
    case "captureFeedback":
      return (
        hasExactKeys(value, ["type", "mealId", "value"]) &&
        isId(value.mealId) &&
        FEEDBACK_VALUES.includes(value.value as (typeof FEEDBACK_VALUES)[number])
      );
    case "captureWeekLesson":
      return (
        hasExactKeys(value, ["type", "weekLesson"]) &&
        isBoundedString(value.weekLesson, 4_000)
      );
    case "captureLeftoverQuality":
      return (
        hasExactKeys(value, ["type", "leftoverId", "quality"]) &&
        isId(value.leftoverId) &&
        LEFTOVER_QUALITIES.includes(value.quality as (typeof LEFTOVER_QUALITIES)[number])
      );
    case "assignLeftover":
      return (
        hasExactKeys(value, ["type", "leftoverId", "dayIndex"]) &&
        isId(value.leftoverId) &&
        isDayIndex(value.dayIndex)
      );
    case "consumeLeftover":
      return hasExactKeys(value, ["type", "leftoverId"]) && isId(value.leftoverId);
    default:
      return false;
  }
}
