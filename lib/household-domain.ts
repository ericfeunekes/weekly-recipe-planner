import {
  DEFAULT_HOUSEHOLD_TIME_ZONE,
  FEEDBACK_VALUES,
  LEFTOVER_QUALITIES,
  MEAL_SLOTS,
  MEAL_STATUSES,
  PREP_DAYS_AFTER_WEEK_START,
  PREP_DAYS_BEFORE_WEEK_START,
  WEEK_STATUSES,
  isIsoDate,
  isWeekId,
  type GroceryItem,
  type HouseholdPlannerState,
  type InstructionStep,
  type IsoDate,
  type Leftover,
  type Meal,
  type PrepReference,
  type WeekId,
  type WeekPlan,
  type WeekPlannerData,
} from "./household-contract.ts";
import {
  MAX_COMMAND_TEXT_LENGTH,
  MAX_GROCERY_ITEMS,
  MAX_ID_LENGTH,
  MAX_INGREDIENT_LINES,
  MAX_MEALS_PER_WEEK,
  MAX_PREP_ENTRIES,
  MAX_STEP_INPUTS,
  MAX_STEPS_PER_MEAL,
  MAX_TIMER_DURATION_SECONDS,
  type HouseholdCommand,
} from "./household-command-contract.ts";

export type HouseholdStateValidation =
  | { ok: true }
  | {
      ok: false;
      issues: Array<{ path: string; message: string }>;
    };

export type HouseholdCommandExecution =
  | {
      ok: true;
      state: HouseholdPlannerState;
      summary: string;
      target: string;
      changes: string[];
      createdIds: Record<string, string>;
    }
  | {
      ok: false;
      state: HouseholdPlannerState;
      message: string;
      fieldErrors?: Record<string, string>;
    };

export type HouseholdCommandContext = {
  now: number;
  createId(prefix: string): string;
};

export interface HouseholdDomainPort {
  validateState(state: HouseholdPlannerState): HouseholdStateValidation;
  execute(
    state: HouseholdPlannerState,
    command: HouseholdCommand,
    context: HouseholdCommandContext,
  ): HouseholdCommandExecution;
}

type ValidationIssue = { path: string; message: string };
type StepLocation = {
  meal: Meal;
  mealIndex: number;
  step: InstructionStep;
  stepIndex: number;
};

const DAY_MS = 86_400_000;
const GROCERY_SECTIONS = ["Produce", "Meat & seafood", "Dairy", "Pantry"] as const;
const LEFTOVER_STATES = ["available", "assigned", "consumed"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isText(
  value: unknown,
  maxLength: number,
  { nonempty = false }: { nonempty?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (!nonempty || value.trim().length > 0)
  );
}

function isId(value: unknown): value is string {
  return isText(value, MAX_ID_LENGTH, { nonempty: true });
}

function addIssue(issues: ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function requireExactShape(
  issues: ValidationIssue[],
  value: Record<string, unknown>,
  path: string,
  required: string[],
  optional: string[] = [],
): void {
  if (!hasOnlyKeys(value, required, optional)) {
    addIssue(issues, path, "Contains missing or unsupported fields.");
  }
}

function dateOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

export function addIsoDateDays(value: IsoDate, days: number): IsoDate {
  const date = new Date((dateOrdinal(value) + days) * DAY_MS);
  return date.toISOString().slice(0, 10) as IsoDate;
}

export function weekContainsDate(weekId: WeekId, date: IsoDate): boolean {
  const difference = dateOrdinal(date) - dateOrdinal(weekId);
  return difference >= 0 && difference <= 6;
}

export function weekContainsPrepDate(weekId: WeekId, date: IsoDate): boolean {
  const difference = dateOrdinal(date) - dateOrdinal(weekId);
  return difference >= -PREP_DAYS_BEFORE_WEEK_START && difference <= PREP_DAYS_AFTER_WEEK_START;
}

export function mondayForIsoDate(value: IsoDate): WeekId {
  const ordinal = dateOrdinal(value);
  const day = new Date(ordinal * DAY_MS).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return addIsoDateDays(value, -daysSinceMonday) as WeekId;
}

export function isoDateInTimeZone(now: number, timeZone = DEFAULT_HOUSEHOLD_TIME_ZONE): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}` as IsoDate;
}

function validateTimeZone(value: unknown): boolean {
  if (!isText(value, 100, { nonempty: true })) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validateInstructionStep(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string | null {
  if (!isRecord(value)) {
    addIssue(issues, path, "Must be an instruction step object.");
    return null;
  }
  requireExactShape(
    issues,
    value,
    path,
    ["id", "inputs", "instruction", "complete"],
    ["timerDurationSeconds", "timerStartedAt", "note"],
  );
  if (!isId(value.id)) addIssue(issues, `${path}.id`, "Must be a nonempty bounded ID.");
  if (!Array.isArray(value.inputs) || value.inputs.length > MAX_STEP_INPUTS) {
    addIssue(issues, `${path}.inputs`, `Must contain at most ${MAX_STEP_INPUTS} amount lines.`);
  } else {
    value.inputs.forEach((input, inputIndex) => {
      const inputPath = `${path}.inputs[${inputIndex}]`;
      if (!isRecord(input)) {
        addIssue(issues, inputPath, "Must be an amount and ingredient object.");
        return;
      }
      requireExactShape(issues, input, inputPath, ["amount", "ingredient"]);
      if (!isText(input.amount, 300)) addIssue(issues, `${inputPath}.amount`, "Must be at most 300 characters.");
      if (!isText(input.ingredient, 1_000)) addIssue(issues, `${inputPath}.ingredient`, "Must be at most 1,000 characters.");
    });
  }
  if (!isText(value.instruction, MAX_COMMAND_TEXT_LENGTH, { nonempty: true })) {
    addIssue(issues, `${path}.instruction`, "Must be a nonempty bounded instruction.");
  }
  if (typeof value.complete !== "boolean") addIssue(issues, `${path}.complete`, "Must be a Boolean.");
  if (
    value.timerDurationSeconds !== undefined &&
    (!Number.isSafeInteger(value.timerDurationSeconds) ||
      Number(value.timerDurationSeconds) < 1 ||
      Number(value.timerDurationSeconds) > MAX_TIMER_DURATION_SECONDS)
  ) {
    addIssue(issues, `${path}.timerDurationSeconds`, "Must be a positive bounded whole number of seconds.");
  }
  if (
    value.timerStartedAt !== undefined &&
    (!Number.isSafeInteger(value.timerStartedAt) || Number(value.timerStartedAt) < 0)
  ) {
    addIssue(issues, `${path}.timerStartedAt`, "Must be a safe nonnegative server timestamp.");
  }
  if (value.timerStartedAt !== undefined && value.timerDurationSeconds === undefined) {
    addIssue(issues, `${path}.timerStartedAt`, "A running timer requires a duration.");
  }
  if (value.complete === true && value.timerStartedAt !== undefined) {
    addIssue(issues, `${path}.timerStartedAt`, "A completed step cannot retain a running timer.");
  }
  if (value.note !== undefined && !isText(value.note, MAX_COMMAND_TEXT_LENGTH)) {
    addIssue(issues, `${path}.note`, "Must be at most 4,000 characters.");
  }
  return typeof value.id === "string" ? value.id : null;
}

function validateMeal(
  value: unknown,
  path: string,
  weekId: WeekId | null,
  issues: ValidationIssue[],
  stepIds: Set<string>,
): { id: string | null; date: IsoDate | null; slot: string | null } {
  if (!isRecord(value)) {
    addIssue(issues, path, "Must be a meal object.");
    return { id: null, date: null, slot: null };
  }
  requireExactShape(
    issues,
    value,
    path,
    [
      "id",
      "date",
      "slot",
      "title",
      "subtitle",
      "venue",
      "status",
      "protein",
      "prepNote",
      "leftoverNote",
      "notes",
      "ingredients",
      "instructions",
    ],
  );
  if (!isId(value.id)) addIssue(issues, `${path}.id`, "Must be a nonempty bounded ID.");
  if (!isIsoDate(value.date)) {
    addIssue(issues, `${path}.date`, "Must be an ISO calendar date.");
  } else if (weekId && !weekContainsDate(weekId, value.date)) {
    addIssue(issues, `${path}.date`, "Must fall inside its Monday-start week.");
  }
  if (!MEAL_SLOTS.includes(value.slot as (typeof MEAL_SLOTS)[number])) {
    addIssue(issues, `${path}.slot`, "Must be a supported meal slot.");
  }
  if (!isText(value.title, 300, { nonempty: true })) addIssue(issues, `${path}.title`, "Must be a nonempty title up to 300 characters.");
  if (!isText(value.subtitle, 1_000)) addIssue(issues, `${path}.subtitle`, "Must be at most 1,000 characters.");
  if (!isText(value.venue, 300, { nonempty: true })) addIssue(issues, `${path}.venue`, "Must be a nonempty venue up to 300 characters.");
  if (!MEAL_STATUSES.includes(value.status as (typeof MEAL_STATUSES)[number])) addIssue(issues, `${path}.status`, "Must be a supported meal status.");
  if (!["chicken", "salmon", "none"].includes(value.protein as string)) addIssue(issues, `${path}.protein`, "Must be a supported protein value.");
  for (const field of ["prepNote", "leftoverNote", "notes"] as const) {
    if (!isText(value[field], MAX_COMMAND_TEXT_LENGTH)) addIssue(issues, `${path}.${field}`, "Must be at most 4,000 characters.");
  }
  if (!Array.isArray(value.ingredients) || value.ingredients.length > MAX_INGREDIENT_LINES) {
    addIssue(issues, `${path}.ingredients`, `Must contain at most ${MAX_INGREDIENT_LINES} lines.`);
  } else {
    value.ingredients.forEach((ingredient, index) => {
      if (!isText(ingredient, 1_000)) addIssue(issues, `${path}.ingredients[${index}]`, "Must be at most 1,000 characters.");
    });
  }
  if (!Array.isArray(value.instructions) || value.instructions.length > MAX_STEPS_PER_MEAL) {
    addIssue(issues, `${path}.instructions`, `Must contain at most ${MAX_STEPS_PER_MEAL} steps.`);
  } else {
    value.instructions.forEach((step, index) => {
      const stepId = validateInstructionStep(step, `${path}.instructions[${index}]`, issues);
      if (!stepId) return;
      if (stepIds.has(stepId)) addIssue(issues, `${path}.instructions[${index}].id`, "Must be unique within the week.");
      stepIds.add(stepId);
    });
  }
  return {
    id: typeof value.id === "string" ? value.id : null,
    date: isIsoDate(value.date) ? value.date : null,
    slot: typeof value.slot === "string" ? value.slot : null,
  };
}

function validateGroceryItem(value: unknown, path: string, issues: ValidationIssue[]): string | null {
  if (!isRecord(value)) {
    addIssue(issues, path, "Must be a grocery item object.");
    return null;
  }
  requireExactShape(issues, value, path, ["id", "section", "item", "detail", "checked", "farmBox"]);
  if (!isId(value.id)) addIssue(issues, `${path}.id`, "Must be a nonempty bounded ID.");
  if (!GROCERY_SECTIONS.includes(value.section as (typeof GROCERY_SECTIONS)[number])) addIssue(issues, `${path}.section`, "Must be a supported grocery section.");
  if (!isText(value.item, 1_000, { nonempty: true })) addIssue(issues, `${path}.item`, "Must be a nonempty item up to 1,000 characters.");
  if (!isText(value.detail, MAX_COMMAND_TEXT_LENGTH)) addIssue(issues, `${path}.detail`, "Must be at most 4,000 characters.");
  if (typeof value.checked !== "boolean") addIssue(issues, `${path}.checked`, "Must be a Boolean.");
  if (typeof value.farmBox !== "boolean") addIssue(issues, `${path}.farmBox`, "Must be a Boolean.");
  return typeof value.id === "string" ? value.id : null;
}

function validateWeek(value: unknown, path: string, issues: ValidationIssue[]): {
  id: string | null;
  status: string | null;
} {
  if (!isRecord(value)) {
    addIssue(issues, path, "Must be a week plan object.");
    return { id: null, status: null };
  }
  requireExactShape(issues, value, path, ["id", "weekStartDate", "status", "data"]);
  const weekId = isWeekId(value.id) ? value.id : null;
  if (!weekId) addIssue(issues, `${path}.id`, "Must be a Monday ISO week ID.");
  if (!isWeekId(value.weekStartDate)) {
    addIssue(issues, `${path}.weekStartDate`, "Must be a Monday ISO date.");
  } else if (weekId && value.weekStartDate !== weekId) {
    addIssue(issues, `${path}.weekStartDate`, "Must match the week ID.");
  }
  if (!WEEK_STATUSES.includes(value.status as (typeof WEEK_STATUSES)[number])) addIssue(issues, `${path}.status`, "Must be a supported week status.");
  if (!isRecord(value.data)) {
    addIssue(issues, `${path}.data`, "Must be week planner data.");
    return { id: typeof value.id === "string" ? value.id : null, status: typeof value.status === "string" ? value.status : null };
  }
  const data = value.data;
  requireExactShape(issues, data, `${path}.data`, ["meals", "prep", "groceries", "leftovers", "farmBoxReconciled", "feedback", "weekLesson"]);
  const mealIds = new Set<string>();
  const mealDates = new Map<string, IsoDate>();
  const mealSlots = new Set<string>();
  const stepIds = new Set<string>();
  if (!Array.isArray(data.meals) || data.meals.length > MAX_MEALS_PER_WEEK) {
    addIssue(issues, `${path}.data.meals`, `Must contain at most ${MAX_MEALS_PER_WEEK} meals.`);
  } else {
    data.meals.forEach((meal, index) => {
      const mealPath = `${path}.data.meals[${index}]`;
      const validated = validateMeal(meal, mealPath, weekId, issues, stepIds);
      if (validated.id) {
        if (mealIds.has(validated.id)) addIssue(issues, `${mealPath}.id`, "Must be unique within the week.");
        mealIds.add(validated.id);
        if (validated.date) mealDates.set(validated.id, validated.date);
      }
      if (validated.date && validated.slot) {
        const key = `${validated.date}:${validated.slot}`;
        if (mealSlots.has(key)) addIssue(issues, `${mealPath}.slot`, "That date and slot is already occupied.");
        mealSlots.add(key);
      }
    });
  }

  const prepIds = new Set<string>();
  const prepStepIds = new Set<string>();
  const prepPositions = new Map<string, number[]>();
  let previousPrep: { prepDate: IsoDate; position: number } | null = null;
  if (!Array.isArray(data.prep) || data.prep.length > MAX_PREP_ENTRIES) {
    addIssue(issues, `${path}.data.prep`, `Must contain at most ${MAX_PREP_ENTRIES} references.`);
  } else {
    data.prep.forEach((reference, index) => {
      const referencePath = `${path}.data.prep[${index}]`;
      if (!isRecord(reference)) {
        addIssue(issues, referencePath, "Must be a prep reference object.");
        return;
      }
      requireExactShape(issues, reference, referencePath, ["id", "stepId", "prepDate", "position"]);
      if (!isId(reference.id)) addIssue(issues, `${referencePath}.id`, "Must be a nonempty bounded ID.");
      else if (prepIds.has(reference.id)) addIssue(issues, `${referencePath}.id`, "Must be unique within the week.");
      else prepIds.add(reference.id);
      if (!isId(reference.stepId) || !stepIds.has(reference.stepId)) addIssue(issues, `${referencePath}.stepId`, "Must reference an instruction step in this week.");
      else if (prepStepIds.has(reference.stepId)) addIssue(issues, `${referencePath}.stepId`, "A step may appear in prep only once.");
      else prepStepIds.add(reference.stepId);
      if (!isIsoDate(reference.prepDate) || (weekId && !weekContainsPrepDate(weekId, reference.prepDate))) {
        addIssue(issues, `${referencePath}.prepDate`, "Must be an ISO date in the week prep interval.");
      }
      if (!Number.isSafeInteger(reference.position) || Number(reference.position) < 0) {
        addIssue(issues, `${referencePath}.position`, "Must be a nonnegative integer.");
      } else if (isIsoDate(reference.prepDate)) {
        const position = Number(reference.position);
        const positions = prepPositions.get(reference.prepDate) ?? [];
        positions.push(position);
        prepPositions.set(reference.prepDate, positions);
        if (
          previousPrep &&
          (reference.prepDate < previousPrep.prepDate ||
            (reference.prepDate === previousPrep.prepDate &&
              position <= previousPrep.position))
        ) {
          addIssue(
            issues,
            referencePath,
            "Prep references must be grouped chronologically and ordered by position within each date.",
          );
        }
        previousPrep = { prepDate: reference.prepDate, position };
      }
    });
  }
  for (const [prepDate, positions] of prepPositions) {
    const sorted = [...positions].sort((left, right) => left - right);
    if (sorted.some((position, index) => position !== index)) {
      addIssue(issues, `${path}.data.prep`, `Positions for ${prepDate} must be contiguous from zero.`);
    }
  }

  const groceryIds = new Set<string>();
  if (!Array.isArray(data.groceries) || data.groceries.length > MAX_GROCERY_ITEMS) {
    addIssue(issues, `${path}.data.groceries`, `Must contain at most ${MAX_GROCERY_ITEMS} items.`);
  } else {
    data.groceries.forEach((item, index) => {
      const itemPath = `${path}.data.groceries[${index}]`;
      const id = validateGroceryItem(item, itemPath, issues);
      if (!id) return;
      if (groceryIds.has(id)) addIssue(issues, `${itemPath}.id`, "Must be unique within the week.");
      groceryIds.add(id);
    });
  }

  const leftoverIds = new Set<string>();
  const assignedSlots = new Set<string>();
  if (!Array.isArray(data.leftovers)) {
    addIssue(issues, `${path}.data.leftovers`, "Must be an array.");
  } else {
    data.leftovers.forEach((leftover, index) => {
      const leftoverPath = `${path}.data.leftovers[${index}]`;
      if (!isRecord(leftover)) {
        addIssue(issues, leftoverPath, "Must be a leftover object.");
        return;
      }
      requireExactShape(issues, leftover, leftoverPath, ["id", "sourceMealId", "label", "portions", "state"], ["assignedDate", "assignedSlot", "quality"]);
      if (!isId(leftover.id)) addIssue(issues, `${leftoverPath}.id`, "Must be a nonempty bounded ID.");
      else if (leftoverIds.has(leftover.id)) addIssue(issues, `${leftoverPath}.id`, "Must be unique within the week.");
      else leftoverIds.add(leftover.id);
      if (!isId(leftover.sourceMealId) || !mealIds.has(leftover.sourceMealId)) addIssue(issues, `${leftoverPath}.sourceMealId`, "Must reference a meal in this week.");
      if (!isText(leftover.label, 1_000, { nonempty: true })) addIssue(issues, `${leftoverPath}.label`, "Must be a nonempty label up to 1,000 characters.");
      if (!Number.isSafeInteger(leftover.portions) || Number(leftover.portions) < 1) addIssue(issues, `${leftoverPath}.portions`, "Must be a positive whole number.");
      if (!LEFTOVER_STATES.includes(leftover.state as (typeof LEFTOVER_STATES)[number])) addIssue(issues, `${leftoverPath}.state`, "Must be a supported leftover state.");
      if (leftover.quality !== undefined && !LEFTOVER_QUALITIES.includes(leftover.quality as (typeof LEFTOVER_QUALITIES)[number])) addIssue(issues, `${leftoverPath}.quality`, "Must be a supported quality.");
      if (leftover.state === "assigned") {
        if (!isIsoDate(leftover.assignedDate) || (weekId && !weekContainsDate(weekId, leftover.assignedDate))) addIssue(issues, `${leftoverPath}.assignedDate`, "Assigned leftovers require a date inside the week.");
        if (!MEAL_SLOTS.includes(leftover.assignedSlot as (typeof MEAL_SLOTS)[number])) addIssue(issues, `${leftoverPath}.assignedSlot`, "Assigned leftovers require a supported slot.");
        const sourceDate =
          typeof leftover.sourceMealId === "string"
            ? mealDates.get(leftover.sourceMealId)
            : undefined;
        if (
          sourceDate &&
          isIsoDate(leftover.assignedDate) &&
          dateOrdinal(leftover.assignedDate) <= dateOrdinal(sourceDate)
        ) {
          addIssue(
            issues,
            `${leftoverPath}.assignedDate`,
            "Assigned leftovers must be used after their source meal.",
          );
        }
        if (isIsoDate(leftover.assignedDate) && typeof leftover.assignedSlot === "string") {
          const key = `${leftover.assignedDate}:${leftover.assignedSlot}`;
          if (assignedSlots.has(key)) addIssue(issues, leftoverPath, "Only one leftover may be assigned to a date and slot.");
          assignedSlots.add(key);
        }
      } else if (leftover.assignedDate !== undefined || leftover.assignedSlot !== undefined) {
        addIssue(issues, leftoverPath, "Only assigned leftovers may retain an assignment.");
      }
    });
  }
  if (typeof data.farmBoxReconciled !== "boolean") addIssue(issues, `${path}.data.farmBoxReconciled`, "Must be a Boolean.");
  if (!isRecord(data.feedback)) {
    addIssue(issues, `${path}.data.feedback`, "Must be a meal feedback record.");
  } else {
    for (const [mealId, feedback] of Object.entries(data.feedback)) {
      if (!mealIds.has(mealId)) addIssue(issues, `${path}.data.feedback.${mealId}`, "Must reference a meal in this week.");
      if (!FEEDBACK_VALUES.includes(feedback as (typeof FEEDBACK_VALUES)[number])) addIssue(issues, `${path}.data.feedback.${mealId}`, "Must be repeat, modify, or drop.");
    }
  }
  if (!isText(data.weekLesson, MAX_COMMAND_TEXT_LENGTH)) addIssue(issues, `${path}.data.weekLesson`, "Must be at most 4,000 characters.");
  return {
    id: typeof value.id === "string" ? value.id : null,
    status: typeof value.status === "string" ? value.status : null,
  };
}

export function validateHouseholdState(state: HouseholdPlannerState): HouseholdStateValidation {
  const value = state as unknown;
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, issues: [{ path: "$", message: "Must be a household planner state object." }] };
  requireExactShape(issues, value, "$", ["householdTimeZone", "activeWeekId", "weeks"]);
  if (!validateTimeZone(value.householdTimeZone)) addIssue(issues, "$.householdTimeZone", "Must be a valid IANA time zone.");
  if (value.activeWeekId !== null && !isWeekId(value.activeWeekId)) addIssue(issues, "$.activeWeekId", "Must be null or a Monday ISO week ID.");
  if (!Array.isArray(value.weeks)) {
    addIssue(issues, "$.weeks", "Must be an array.");
    return { ok: false, issues };
  }
  const weekIds = new Set<string>();
  const activeWeekIds: string[] = [];
  value.weeks.forEach((week, index) => {
    const weekPath = `$.weeks[${index}]`;
    const validated = validateWeek(week, weekPath, issues);
    if (validated.id) {
      if (weekIds.has(validated.id)) addIssue(issues, `${weekPath}.id`, "Must be unique in the household.");
      weekIds.add(validated.id);
      if (validated.status === "active") activeWeekIds.push(validated.id);
    }
  });
  if (activeWeekIds.length > 1) addIssue(issues, "$.weeks", "At most one week may be active.");
  if (value.activeWeekId === null && activeWeekIds.length !== 0) addIssue(issues, "$.activeWeekId", "Must identify the active week.");
  if (typeof value.activeWeekId === "string" && (activeWeekIds.length !== 1 || activeWeekIds[0] !== value.activeWeekId)) addIssue(issues, "$.activeWeekId", "Must match the single active week.");
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function cloneStep(step: InstructionStep): InstructionStep {
  return {
    ...step,
    inputs: step.inputs.map((input) => ({ ...input })),
  };
}

function cloneMeal(meal: Meal): Meal {
  return {
    ...meal,
    ingredients: [...meal.ingredients],
    instructions: meal.instructions.map(cloneStep),
  };
}

function cloneWeekData(data: WeekPlannerData): WeekPlannerData {
  return {
    meals: data.meals.map(cloneMeal),
    prep: data.prep.map((reference) => ({ ...reference })),
    groceries: data.groceries.map((item) => ({ ...item })),
    leftovers: data.leftovers.map((leftover) => ({ ...leftover })),
    farmBoxReconciled: data.farmBoxReconciled,
    feedback: { ...data.feedback },
    weekLesson: data.weekLesson,
  };
}

export function cloneHouseholdState(state: HouseholdPlannerState): HouseholdPlannerState {
  return {
    householdTimeZone: state.householdTimeZone,
    activeWeekId: state.activeWeekId,
    weeks: state.weeks.map((week) => ({ ...week, data: cloneWeekData(week.data) })),
  };
}

function fieldErrorsFromValidation(validation: Extract<HouseholdStateValidation, { ok: false }>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of validation.issues) errors[issue.path] ??= issue.message;
  return errors;
}

function failure(
  state: HouseholdPlannerState,
  message: string,
  fieldErrors?: Record<string, string>,
): HouseholdCommandExecution {
  return fieldErrors ? { ok: false, state, message, fieldErrors } : { ok: false, state, message };
}

function success(
  original: HouseholdPlannerState,
  next: HouseholdPlannerState,
  summary: string,
  target: string,
  changes: string[],
  createdIds: Record<string, string> = {},
): HouseholdCommandExecution {
  const validation = validateHouseholdState(next);
  if (!validation.ok) {
    return failure(original, "The command would produce invalid household state.", fieldErrorsFromValidation(validation));
  }
  return { ok: true, state: next, summary, target, changes, createdIds };
}

function findWeek(state: HouseholdPlannerState, weekId: WeekId): WeekPlan | null {
  return state.weeks.find((week) => week.id === weekId) ?? null;
}

function findStep(week: WeekPlan, stepId: string): StepLocation | null {
  for (let mealIndex = 0; mealIndex < week.data.meals.length; mealIndex += 1) {
    const meal = week.data.meals[mealIndex];
    const stepIndex = meal.instructions.findIndex((step) => step.id === stepId);
    if (stepIndex >= 0) return { meal, mealIndex, step: meal.instructions[stepIndex], stepIndex };
  }
  return null;
}

function sortPrep(prep: PrepReference[]): PrepReference[] {
  return [...prep].sort(
    (left, right) =>
      left.prepDate.localeCompare(right.prepDate) ||
      left.position - right.position ||
      left.id.localeCompare(right.id),
  );
}

function normalizePrepDate(prep: PrepReference[], prepDate: IsoDate): void {
  const ordered = prep
    .filter((reference) => reference.prepDate === prepDate)
    .sort((left, right) => left.position - right.position);
  ordered.forEach((reference, position) => {
    reference.position = position;
  });
}

function materializeId(
  context: HouseholdCommandContext,
  prefix: string,
  existing: Set<string>,
): string | null {
  let id: string;
  try {
    id = context.createId(prefix);
  } catch {
    return null;
  }
  if (!isId(id) || existing.has(id)) return null;
  existing.add(id);
  return id;
}

function rejectMissingWeek(state: HouseholdPlannerState, weekId: string): HouseholdCommandExecution {
  return failure(state, "Week not found.", { weekId: `No canonical week exists for ${weekId}.` });
}

function rejectArchivedWeek(state: HouseholdPlannerState): HouseholdCommandExecution {
  return failure(state, "Archived weeks are read-only.");
}

function leftoverPortions(meal: Meal): number {
  const match = meal.leftoverNote.match(/\b(\d+)\b/);
  return match ? Math.max(1, Number(match[1])) : 2;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function executeHouseholdCommand(
  state: HouseholdPlannerState,
  command: HouseholdCommand,
  context: HouseholdCommandContext,
): HouseholdCommandExecution {
  const currentValidation = validateHouseholdState(state);
  if (!currentValidation.ok) return failure(state, "Stored household state is invalid.", fieldErrorsFromValidation(currentValidation));
  if (!Number.isSafeInteger(context.now) || context.now < 0) return failure(state, "The server clock is invalid.", { now: "Must be a safe nonnegative timestamp." });

  const next = cloneHouseholdState(state);
  const weekId = "weekId" in command ? command.weekId : null;
  const week = weekId ? findWeek(next, weekId) : null;
  if (weekId && !week) return rejectMissingWeek(state, weekId);
  if (week?.status === "archived") return rejectArchivedWeek(state);

  switch (command.type) {
    case "moveMeal": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      if (!weekContainsDate(week.id, command.targetDate)) return failure(state, "Target date is outside the week.", { targetDate: "Choose a date inside the selected week." });
      const moving = week.data.meals.find((meal) => meal.id === command.mealId);
      if (!moving) return failure(state, "Meal not found.", { mealId: "Choose a meal in the selected week." });
      if (moving.date === command.targetDate && moving.slot === command.slot) return failure(state, "The meal is already in that slot.");
      const originalDate = moving.date;
      const originalSlot = moving.slot;
      const target = week.data.meals.find((meal) => meal.date === command.targetDate && meal.slot === command.slot);
      moving.date = command.targetDate;
      moving.slot = command.slot;
      moving.status = "moved";
      if (target) {
        target.date = originalDate;
        target.slot = originalSlot;
        if (target.status !== "flex") target.status = "moved";
      }
      for (const leftover of week.data.leftovers) {
        if (leftover.state !== "assigned") continue;
        if (leftover.assignedDate === originalDate && leftover.assignedSlot === originalSlot) {
          leftover.assignedDate = command.targetDate;
          leftover.assignedSlot = command.slot;
        } else if (leftover.assignedDate === command.targetDate && leftover.assignedSlot === command.slot) {
          leftover.assignedDate = originalDate;
          leftover.assignedSlot = originalSlot;
        }
      }
      return success(
        state,
        next,
        target ? `Swapped ${moving.title} with ${target.title}` : `Moved ${moving.title}`,
        moving.id,
        target
          ? [`${originalDate}/${originalSlot} to ${command.targetDate}/${command.slot}`, `${target.id} moved to ${originalDate}/${originalSlot}`]
          : [`${originalDate}/${originalSlot} to ${command.targetDate}/${command.slot}`, "The source slot is now empty"],
      );
    }

    case "updateMealStatus": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const meal = week.data.meals.find((item) => item.id === command.mealId);
      if (!meal) return failure(state, "Meal not found.", { mealId: "Choose a meal in the selected week." });
      if (meal.status === command.status) return failure(state, "Meal status is unchanged.");
      const previous = meal.status;
      meal.status = command.status;
      const createdIds: Record<string, string> = {};
      const changes = [`Status: ${previous} to ${command.status}`];
      if (
        command.status === "cooked" &&
        meal.protein !== "none" &&
        !week.data.leftovers.some((leftover) => leftover.sourceMealId === meal.id)
      ) {
        const id = materializeId(context, "leftover", new Set(week.data.leftovers.map((leftover) => leftover.id)));
        if (!id) return failure(state, "Could not materialize a unique leftover ID.");
        const portions = leftoverPortions(meal);
        week.data.leftovers.push({ id, sourceMealId: meal.id, label: meal.title, portions, state: "available" });
        createdIds.leftoverId = id;
        changes.push(`${portions} leftover portions are available`);
      }
      return success(state, next, `Marked ${meal.title} ${command.status}`, meal.id, changes, createdIds);
    }

    case "updateMealSnapshot": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const meal = week.data.meals.find((item) => item.id === command.mealId);
      if (!meal) return failure(state, "Meal not found.", { mealId: "Choose a meal in the selected week." });
      const previous = {
        title: meal.title,
        subtitle: meal.subtitle,
        venue: meal.venue,
        prepNote: meal.prepNote,
        leftoverNote: meal.leftoverNote,
        notes: meal.notes,
        ingredients: meal.ingredients,
      };
      if (equalJson(previous, command.changes)) return failure(state, "Meal snapshot is unchanged.");
      Object.assign(meal, command.changes, { ingredients: [...command.changes.ingredients] });
      return success(state, next, `Updated ${meal.title}`, meal.id, ["Week-local recipe details were updated"]);
    }

    case "addInstructionStep": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const meal = week.data.meals.find((item) => item.id === command.mealId);
      if (!meal) return failure(state, "Meal not found.", { mealId: "Choose a meal in the selected week." });
      if (meal.instructions.length >= MAX_STEPS_PER_MEAL || command.position > meal.instructions.length) return failure(state, "Instruction position is outside the recipe.", { position: "Choose an insertion position in the current recipe." });
      const stepIds = new Set(week.data.meals.flatMap((item) => item.instructions.map((step) => step.id)));
      const id = materializeId(context, "step", stepIds);
      if (!id) return failure(state, "Could not materialize a unique instruction-step ID.");
      const step: InstructionStep = {
        id,
        inputs: command.step.inputs.map((input) => ({ ...input })),
        instruction: command.step.instruction,
        complete: false,
      };
      if (command.step.timerDurationSeconds !== undefined) step.timerDurationSeconds = command.step.timerDurationSeconds;
      if (command.step.note !== undefined && command.step.note !== "") step.note = command.step.note;
      meal.instructions.splice(command.position, 0, step);
      return success(state, next, `Added a step to ${meal.title}`, id, [`Inserted at recipe position ${command.position}`], { instructionStepId: id });
    }

    case "updateInstructionStep": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      const previous = {
        inputs: resolved.step.inputs,
        instruction: resolved.step.instruction,
        timerDurationSeconds: resolved.step.timerDurationSeconds ?? null,
      };
      if (equalJson(previous, command.changes)) return failure(state, "Instruction step is unchanged.");
      const durationChanged = (resolved.step.timerDurationSeconds ?? null) !== command.changes.timerDurationSeconds;
      resolved.step.inputs = command.changes.inputs.map((input) => ({ ...input }));
      resolved.step.instruction = command.changes.instruction;
      if (command.changes.timerDurationSeconds === null) delete resolved.step.timerDurationSeconds;
      else resolved.step.timerDurationSeconds = command.changes.timerDurationSeconds;
      if (durationChanged) delete resolved.step.timerStartedAt;
      return success(state, next, "Updated instruction step", resolved.step.id, [durationChanged ? "Step content and timer duration updated; running timer reset" : "Step content updated"]);
    }

    case "moveInstructionStep": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if (command.targetPosition >= resolved.meal.instructions.length) return failure(state, "Instruction position is outside the recipe.", { targetPosition: "Choose a position in the current recipe." });
      if (command.targetPosition === resolved.stepIndex) return failure(state, "Instruction step is already in that position.");
      resolved.meal.instructions.splice(resolved.stepIndex, 1);
      resolved.meal.instructions.splice(command.targetPosition, 0, resolved.step);
      return success(state, next, "Reordered instruction step", resolved.step.id, [`Recipe position: ${resolved.stepIndex} to ${command.targetPosition}`]);
    }

    case "removeInstructionStep": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if (week.data.prep.some((reference) => reference.stepId === command.stepId)) return failure(state, "Remove this step from prep before deleting it.", { stepId: "The step still has a prep reference." });
      resolved.meal.instructions.splice(resolved.stepIndex, 1);
      return success(state, next, "Removed instruction step", resolved.step.id, ["Recipe order was compacted"]);
    }

    case "setInstructionStepComplete": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if (resolved.step.complete === command.complete) return failure(state, "Instruction completion is unchanged.");
      const previous = resolved.step.complete;
      resolved.step.complete = command.complete;
      if (command.complete) delete resolved.step.timerStartedAt;
      return success(state, next, command.complete ? "Completed instruction step" : "Reopened instruction step", resolved.step.id, [`Complete: ${previous} to ${command.complete}`, command.complete ? "Running timer cleared" : "Timer remains stopped"]);
    }

    case "updateInstructionStepNote": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if ((resolved.step.note ?? "") === command.note) return failure(state, "Instruction note is unchanged.");
      if (command.note === "") delete resolved.step.note;
      else resolved.step.note = command.note;
      return success(state, next, command.note ? "Updated instruction note" : "Cleared instruction note", resolved.step.id, [command.note ? "Step note saved" : "Step note removed"]);
    }

    case "startInstructionTimer": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if (!resolved.step.timerDurationSeconds) return failure(state, "This instruction step has no timer duration.");
      if (resolved.step.complete) return failure(state, "Reopen the instruction step before starting its timer.");
      if (resolved.step.timerStartedAt !== undefined) return failure(state, "The instruction timer is already running.");
      resolved.step.timerStartedAt = context.now;
      return success(state, next, "Started instruction timer", resolved.step.id, [`Timer started at ${context.now}`]);
    }

    case "resetInstructionTimer": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if (resolved.step.timerStartedAt === undefined) return failure(state, "The instruction timer is not running.");
      delete resolved.step.timerStartedAt;
      return success(state, next, "Reset instruction timer", resolved.step.id, ["Persisted timer start cleared"]);
    }

    case "setPrepPlan": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      for (const entry of command.entries) {
        if (!findStep(week, entry.stepId)) return failure(state, "Prep plan references an unknown instruction step.", { stepId: entry.stepId });
        if (!weekContainsPrepDate(week.id, entry.prepDate)) return failure(state, "Prep date is outside the allowed interval.", { prepDate: entry.prepDate });
      }
      const existingByStep = new Map(week.data.prep.map((reference) => [reference.stepId, reference]));
      const existingIds = new Set(week.data.prep.map((reference) => reference.id));
      const perDatePosition = new Map<IsoDate, number>();
      const createdIds: Record<string, string> = {};
      const prep: PrepReference[] = [];
      for (const entry of command.entries) {
        const existing = existingByStep.get(entry.stepId);
        const id = existing?.id ?? materializeId(context, "prep", existingIds);
        if (!id) return failure(state, "Could not materialize a unique prep-reference ID.");
        if (!existing) createdIds[`prepReference.${entry.stepId}`] = id;
        const position = perDatePosition.get(entry.prepDate) ?? 0;
        perDatePosition.set(entry.prepDate, position + 1);
        prep.push({ id, stepId: entry.stepId, prepDate: entry.prepDate, position });
      }
      const sorted = sortPrep(prep);
      if (equalJson(week.data.prep, sorted)) return failure(state, "Prep plan is unchanged.");
      week.data.prep = sorted;
      return success(state, next, `Set prep plan with ${sorted.length} steps`, `${week.id}:prep`, ["Prep is grouped by date and manually ordered", "Recipe instruction order was unchanged"], createdIds);
    }

    case "movePrepReference": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const reference = week.data.prep.find((item) => item.id === command.referenceId);
      if (!reference) return failure(state, "Prep reference not found.", { referenceId: "Choose a prep reference in the selected week." });
      const sameDate = week.data.prep.filter((item) => item.prepDate === reference.prepDate).sort((left, right) => left.position - right.position);
      const currentPosition = sameDate.findIndex((item) => item.id === reference.id);
      if (command.targetPosition >= sameDate.length) return failure(state, "Prep position is outside that date's list.", { targetPosition: "Choose a position in the current prep date." });
      if (currentPosition === command.targetPosition) return failure(state, "Prep reference is already in that position.");
      sameDate.splice(currentPosition, 1);
      sameDate.splice(command.targetPosition, 0, reference);
      sameDate.forEach((item, position) => {
        item.position = position;
      });
      week.data.prep = sortPrep(week.data.prep);
      return success(state, next, "Reordered prep step", reference.id, [`Position: ${currentPosition} to ${command.targetPosition} on ${reference.prepDate}`]);
    }

    case "reschedulePrepReference": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const reference = week.data.prep.find((item) => item.id === command.referenceId);
      if (!reference) return failure(state, "Prep reference not found.", { referenceId: "Choose a prep reference in the selected week." });
      if (!weekContainsPrepDate(week.id, command.prepDate)) return failure(state, "Prep date is outside the allowed interval.", { prepDate: command.prepDate });
      if (reference.prepDate === command.prepDate) return failure(state, "Prep date is unchanged.");
      const sourceDate = reference.prepDate;
      reference.prepDate = command.prepDate;
      reference.position = week.data.prep.filter((item) => item.id !== reference.id && item.prepDate === command.prepDate).length;
      normalizePrepDate(week.data.prep, sourceDate);
      week.data.prep = sortPrep(week.data.prep);
      return success(state, next, "Rescheduled prep step", reference.id, [`Prep date: ${sourceDate} to ${command.prepDate}`, "Appended to the destination date"]);
    }

    case "removePrepReference": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const index = week.data.prep.findIndex((item) => item.id === command.referenceId);
      if (index < 0) return failure(state, "Prep reference not found.", { referenceId: "Choose a prep reference in the selected week." });
      const [reference] = week.data.prep.splice(index, 1);
      normalizePrepDate(week.data.prep, reference.prepDate);
      week.data.prep = sortPrep(week.data.prep);
      return success(state, next, "Removed step from prep", reference.id, ["The instruction step and recipe order were preserved"]);
    }

    case "addGroceryItem": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      if (week.data.groceries.length >= MAX_GROCERY_ITEMS) return failure(state, "The grocery list is full.");
      const id = materializeId(context, "grocery", new Set(week.data.groceries.map((item) => item.id)));
      if (!id) return failure(state, "Could not materialize a unique grocery-item ID.");
      const grocery: GroceryItem = { id, ...command.item, checked: command.item.checked ?? false };
      week.data.groceries.push(grocery);
      return success(state, next, `Added ${grocery.item}`, id, ["Grocery item added to the week"], { groceryItemId: id });
    }

    case "updateGroceryItem": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const grocery = week.data.groceries.find((item) => item.id === command.itemId);
      if (!grocery) return failure(state, "Grocery item not found.", { itemId: "Choose an item in the selected week." });
      const previous = { section: grocery.section, item: grocery.item, detail: grocery.detail, farmBox: grocery.farmBox };
      if (equalJson(previous, command.changes)) return failure(state, "Grocery item is unchanged.");
      Object.assign(grocery, command.changes);
      return success(state, next, `Updated ${grocery.item}`, grocery.id, ["Grocery item details updated"]);
    }

    case "removeGroceryItem": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const index = week.data.groceries.findIndex((item) => item.id === command.itemId);
      if (index < 0) return failure(state, "Grocery item not found.", { itemId: "Choose an item in the selected week." });
      const [grocery] = week.data.groceries.splice(index, 1);
      return success(state, next, `Removed ${grocery.item}`, grocery.id, ["Grocery item removed from the week"]);
    }

    case "setGroceryItemChecked": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const grocery = week.data.groceries.find((item) => item.id === command.itemId);
      if (!grocery) return failure(state, "Grocery item not found.", { itemId: "Choose an item in the selected week." });
      if (grocery.checked === command.checked) return failure(state, "Grocery checked state is unchanged.");
      const previous = grocery.checked;
      grocery.checked = command.checked;
      return success(state, next, command.checked ? `Checked off ${grocery.item}` : `Returned ${grocery.item} to the list`, grocery.id, [`Checked: ${previous} to ${command.checked}`]);
    }

    case "reconcileGroceries": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const existing = new Map(week.data.groceries.map((item) => [item.id, item]));
      const usedIds = new Set<string>();
      const createdIds: Record<string, string> = {};
      const groceries: GroceryItem[] = [];
      for (let index = 0; index < command.items.length; index += 1) {
        const item = command.items[index];
        let id = item.id;
        if (id) {
          if (!existing.has(id)) return failure(state, "Grocery reconciliation contains an unknown ID.", { [`items[${index}].id`]: "Only existing server IDs may be supplied." });
          if (usedIds.has(id)) return failure(state, "Grocery reconciliation contains a duplicate ID.", { [`items[${index}].id`]: "Each existing item may appear once." });
          usedIds.add(id);
        } else {
          id = materializeId(context, "grocery", new Set([...existing.keys(), ...usedIds])) ?? undefined;
          if (!id) return failure(state, "Could not materialize a unique grocery-item ID.");
          usedIds.add(id);
          createdIds[`groceryItem.${index}`] = id;
        }
        groceries.push({ id, section: item.section, item: item.item, detail: item.detail, checked: item.checked, farmBox: item.farmBox });
      }
      if (week.data.farmBoxReconciled && equalJson(week.data.groceries, groceries)) return failure(state, "Grocery reconciliation is unchanged.");
      week.data.groceries = groceries;
      week.data.farmBoxReconciled = true;
      return success(state, next, "Reconciled weekly groceries", `${week.id}:groceries`, ["The week grocery list was replaced with the reconciled list"], createdIds);
    }

    case "captureFeedback": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      if (!week.data.meals.some((meal) => meal.id === command.mealId)) return failure(state, "Meal not found.", { mealId: "Choose a meal in the selected week." });
      if (week.data.feedback[command.mealId] === command.value) return failure(state, "Meal feedback is unchanged.");
      const previous = week.data.feedback[command.mealId] ?? "unset";
      week.data.feedback[command.mealId] = command.value;
      return success(state, next, `Set meal feedback to ${command.value}`, command.mealId, [`Feedback: ${previous} to ${command.value}`]);
    }

    case "captureWeekLesson": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      if (week.data.weekLesson === command.weekLesson) return failure(state, "Planning lesson is unchanged.");
      week.data.weekLesson = command.weekLesson;
      return success(state, next, "Updated the week planning lesson", `${week.id}:lesson`, ["Planning lesson revised"]);
    }

    case "captureLeftoverQuality": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const leftover = week.data.leftovers.find((item) => item.id === command.leftoverId);
      if (!leftover) return failure(state, "Leftover record not found.", { leftoverId: "Choose leftovers in the selected week." });
      if (leftover.quality === command.quality) return failure(state, "Leftover quality is unchanged.");
      const previous = leftover.quality ?? "unset";
      leftover.quality = command.quality;
      return success(state, next, `Rated ${leftover.label} leftovers ${command.quality}`, leftover.id, [`Quality: ${previous} to ${command.quality}`]);
    }

    case "assignLeftover": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const leftover = week.data.leftovers.find((item) => item.id === command.leftoverId);
      if (!leftover) return failure(state, "Leftover record not found.", { leftoverId: "Choose leftovers in the selected week." });
      if (leftover.state !== "available") return failure(state, "Only available leftovers can be assigned.");
      if (!weekContainsDate(week.id, command.targetDate)) return failure(state, "Leftover target is outside the week.", { targetDate: "Choose a date inside the selected week." });
      const sourceMeal = week.data.meals.find((meal) => meal.id === leftover.sourceMealId);
      if (!sourceMeal) return failure(state, "Leftover source meal not found.");
      if (dateOrdinal(command.targetDate) <= dateOrdinal(sourceMeal.date)) return failure(state, "Leftovers must be assigned after their source meal.", { targetDate: "Choose a later date in the week." });
      if (week.data.leftovers.some((item) => item.state === "assigned" && item.assignedDate === command.targetDate && item.assignedSlot === command.slot)) return failure(state, "That date and slot already has assigned leftovers.");
      leftover.state = "assigned";
      leftover.assignedDate = command.targetDate;
      leftover.assignedSlot = command.slot;
      const destination = week.data.meals.find((meal) => meal.date === command.targetDate && meal.slot === command.slot);
      if (destination) {
        destination.status = "leftover";
        destination.subtitle = `${leftover.portions} portions from ${leftover.label}`;
        destination.leftoverNote = `Assigned from ${sourceMeal.date}`;
      }
      return success(state, next, `Assigned ${leftover.label} leftovers`, leftover.id, [`State: available to assigned`, `Assigned slot: ${command.targetDate}/${command.slot}`, destination ? `${destination.title} now uses assigned leftovers` : "The empty slot now has assigned leftovers"]);
    }

    case "consumeLeftover": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const leftover = week.data.leftovers.find((item) => item.id === command.leftoverId);
      if (!leftover) return failure(state, "Leftover record not found.", { leftoverId: "Choose leftovers in the selected week." });
      if (leftover.state !== "assigned" || !leftover.assignedDate || !leftover.assignedSlot) return failure(state, "Only assigned leftovers can be consumed.");
      const assignedDate = leftover.assignedDate;
      const assignedSlot = leftover.assignedSlot;
      leftover.state = "consumed";
      delete leftover.assignedDate;
      delete leftover.assignedSlot;
      const destination = week.data.meals.find((meal) => meal.date === assignedDate && meal.slot === assignedSlot);
      if (destination?.status === "leftover") destination.status = "cooked";
      return success(state, next, `Marked ${leftover.label} leftovers consumed`, leftover.id, ["State: assigned to consumed", destination ? "Destination meal marked cooked" : "Assignment cleared"]);
    }

    case "archiveWeek": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      if (week.status !== "active" || next.activeWeekId !== week.id) return failure(state, "Only the active week can be archived.");
      week.status = "archived";
      next.activeWeekId = null;
      return success(state, next, "Archived the week", week.id, ["Lifecycle: active to archived", "There is no active week"]);
    }

    case "createWeekPlan": {
      if (next.weeks.some((item) => item.id === command.weekStartDate)) return failure(state, "A week already exists for that Monday.", { weekStartDate: "Choose a missing Monday." });
      const mealIds = new Set<string>();
      const stepIds = new Set<string>();
      const groceryIds = new Set<string>();
      const createdIds: Record<string, string> = {};
      const meals: Meal[] = [];
      for (let mealIndex = 0; mealIndex < command.plan.meals.length; mealIndex += 1) {
        const input = command.plan.meals[mealIndex];
        const mealId = materializeId(context, "meal", mealIds);
        if (!mealId) return failure(state, "Could not materialize a unique meal ID.");
        createdIds[`meal.${mealIndex}`] = mealId;
        const instructions: InstructionStep[] = [];
        for (let stepIndex = 0; stepIndex < input.instructions.length; stepIndex += 1) {
          const stepInput = input.instructions[stepIndex];
          const stepId = materializeId(context, "step", stepIds);
          if (!stepId) return failure(state, "Could not materialize a unique instruction-step ID.");
          createdIds[`step.${mealIndex}.${stepIndex}`] = stepId;
          const step: InstructionStep = { id: stepId, inputs: stepInput.inputs.map((amount) => ({ ...amount })), instruction: stepInput.instruction, complete: false };
          if (stepInput.timerDurationSeconds !== undefined) step.timerDurationSeconds = stepInput.timerDurationSeconds;
          if (stepInput.note !== undefined && stepInput.note !== "") step.note = stepInput.note;
          instructions.push(step);
        }
        meals.push({
          id: mealId,
          date: input.date,
          slot: input.slot,
          title: input.title,
          subtitle: input.subtitle,
          venue: input.venue,
          status: input.status ?? "planned",
          protein: input.protein,
          prepNote: input.prepNote,
          leftoverNote: input.leftoverNote,
          notes: input.notes,
          ingredients: [...input.ingredients],
          instructions,
        });
      }
      const groceries: GroceryItem[] = [];
      for (let index = 0; index < command.plan.groceries.length; index += 1) {
        const input = command.plan.groceries[index];
        const id = materializeId(context, "grocery", groceryIds);
        if (!id) return failure(state, "Could not materialize a unique grocery-item ID.");
        createdIds[`grocery.${index}`] = id;
        groceries.push({ id, section: input.section, item: input.item, detail: input.detail, checked: input.checked ?? false, farmBox: input.farmBox });
      }
      next.weeks.push({
        id: command.weekStartDate,
        weekStartDate: command.weekStartDate,
        status: "planned",
        data: { meals, prep: [], groceries, leftovers: [], farmBoxReconciled: false, feedback: {}, weekLesson: command.plan.weekLesson ?? "" },
      });
      next.weeks.sort((left, right) => left.id.localeCompare(right.id));
      return success(state, next, `Created week plan for ${command.weekStartDate}`, command.weekStartDate, [`Created ${meals.length} meals and ${groceries.length} grocery items`, "Lifecycle: missing to planned"], createdIds);
    }

    case "activateWeek": {
      const target = findWeek(next, command.weekId);
      if (!target) return rejectMissingWeek(state, command.weekId);
      if (target.status !== "planned") return failure(state, "Only a planned week can be activated.");
      if (next.activeWeekId !== null) return failure(state, "Another week is already active.", { weekId: next.activeWeekId });
      target.status = "active";
      next.activeWeekId = target.id;
      return success(state, next, `Activated week ${target.id}`, target.id, ["Lifecycle: planned to active"]);
    }

    case "handoffWeek": {
      const current = findWeek(next, command.currentWeekId);
      const following = findWeek(next, command.nextWeekId);
      if (!current) return rejectMissingWeek(state, command.currentWeekId);
      if (!following) return rejectMissingWeek(state, command.nextWeekId);
      if (current.status !== "active" || next.activeWeekId !== current.id) return failure(state, "The current handoff week is not active.", { currentWeekId: "Choose the active week." });
      if (following.status !== "planned") return failure(state, "The next handoff week is not planned.", { nextWeekId: "Choose a planned week." });
      current.status = "archived";
      following.status = "active";
      next.activeWeekId = following.id;
      return success(state, next, `Handed off to week ${following.id}`, `${current.id},${following.id}`, [`${current.id}: active to archived`, `${following.id}: planned to active`]);
    }
  }
}

export const householdDomain: HouseholdDomainPort = {
  validateState: validateHouseholdState,
  execute: executeHouseholdCommand,
};
