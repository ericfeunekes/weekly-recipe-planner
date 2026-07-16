import {
  DEFAULT_HOUSEHOLD_TIME_ZONE,
  FEEDBACK_VALUES,
  GROCERY_SOURCES,
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
  type Meal,
  type PrepSession,
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
  MAX_PREP_SESSIONS,
  MAX_STEP_INPUTS,
  MAX_STEPS_PER_MEAL,
  MAX_TIMER_DURATION_SECONDS,
  type HouseholdCommand,
} from "./household-command-contract.ts";
import { isSourceRecipe } from "./sourced-recipe-contract.ts";

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
  validateCanonicalBatchBase(
    state: HouseholdPlannerState,
    commands: readonly HouseholdCommand[],
  ): { ok: true } | { ok: false; operationIndex: number; message: string };
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
  ingredientIds: Set<string>,
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
    ["timerDurationSeconds", "timerStartedAt", "timerPaused", "note"],
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
      requireExactShape(issues, input, inputPath, ["amount", "ingredient", "ingredientId"]);
      if (!isText(input.amount, 300)) addIssue(issues, `${inputPath}.amount`, "Must be at most 300 characters.");
      if (!isText(input.ingredient, 1_000)) addIssue(issues, `${inputPath}.ingredient`, "Must be at most 1,000 characters.");
      if (!isId(input.ingredientId) || !ingredientIds.has(input.ingredientId)) {
        addIssue(issues, `${inputPath}.ingredientId`, "Must reference a recipe ingredient on this meal.");
      }
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
  if (value.timerPaused !== undefined && typeof value.timerPaused !== "boolean") {
    addIssue(issues, `${path}.timerPaused`, "Must be a Boolean.");
  }
  if (value.timerPaused === true && value.timerDurationSeconds === undefined) {
    addIssue(issues, `${path}.timerPaused`, "A paused timer requires a duration.");
  }
  if (value.timerPaused === true && value.timerStartedAt !== undefined) {
    addIssue(issues, `${path}.timerPaused`, "A timer cannot be running and paused.");
  }
  if (value.complete === true && value.timerStartedAt !== undefined) {
    addIssue(issues, `${path}.timerStartedAt`, "A completed step cannot retain a running timer.");
  }
  if (value.complete === true && value.timerPaused === true) {
    addIssue(issues, `${path}.timerPaused`, "A completed step cannot retain a paused timer.");
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
    ["yieldText", "sourceRecipe"],
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
  if (value.yieldText !== undefined && !isText(value.yieldText, 80, { nonempty: true })) {
    addIssue(issues, `${path}.yieldText`, "Must be a nonempty yield up to 80 characters.");
  }
  if (value.sourceRecipe !== undefined && !isSourceRecipe(value.sourceRecipe)) {
    addIssue(issues, `${path}.sourceRecipe`, "Must be a canonical informational source reference.");
  }
  if (!isText(value.subtitle, 1_000)) addIssue(issues, `${path}.subtitle`, "Must be at most 1,000 characters.");
  if (!isText(value.venue, 300, { nonempty: true })) addIssue(issues, `${path}.venue`, "Must be a nonempty venue up to 300 characters.");
  if (!MEAL_STATUSES.includes(value.status as (typeof MEAL_STATUSES)[number])) addIssue(issues, `${path}.status`, "Must be a supported meal status.");
  if (!["chicken", "salmon", "none"].includes(value.protein as string)) addIssue(issues, `${path}.protein`, "Must be a supported protein value.");
  for (const field of ["prepNote", "leftoverNote", "notes"] as const) {
    if (!isText(value[field], MAX_COMMAND_TEXT_LENGTH)) addIssue(issues, `${path}.${field}`, "Must be at most 4,000 characters.");
  }
  const ingredientIds = new Set<string>();
  if (!Array.isArray(value.ingredients) || value.ingredients.length > MAX_INGREDIENT_LINES) {
    addIssue(issues, `${path}.ingredients`, `Must contain at most ${MAX_INGREDIENT_LINES} ingredients.`);
  } else {
    value.ingredients.forEach((ingredient, index) => {
      const ingredientPath = `${path}.ingredients[${index}]`;
      if (!isRecord(ingredient)) {
        addIssue(issues, ingredientPath, "Must be a recipe ingredient object.");
        return;
      }
      requireExactShape(issues, ingredient, ingredientPath, ["id", "amount", "ingredient"]);
      if (!isId(ingredient.id)) addIssue(issues, `${ingredientPath}.id`, "Must be a nonempty bounded ID.");
      else if (ingredientIds.has(ingredient.id)) addIssue(issues, `${ingredientPath}.id`, "Must be unique on this meal.");
      else ingredientIds.add(ingredient.id);
      if (!isText(ingredient.amount, 300)) addIssue(issues, `${ingredientPath}.amount`, "Must be at most 300 characters.");
      if (!isText(ingredient.ingredient, 1_000, { nonempty: true })) addIssue(issues, `${ingredientPath}.ingredient`, "Must be a nonempty ingredient name up to 1,000 characters.");
    });
  }
  if (!Array.isArray(value.instructions) || value.instructions.length > MAX_STEPS_PER_MEAL) {
    addIssue(issues, `${path}.instructions`, `Must contain at most ${MAX_STEPS_PER_MEAL} steps.`);
  } else {
    value.instructions.forEach((step, index) => {
      const stepId = validateInstructionStep(step, `${path}.instructions[${index}]`, issues, ingredientIds);
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

function validateGroceryItem(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  ingredientsByMeal: Map<string, Set<string>>,
  groceryKeys: Set<string>,
): string | null {
  if (!isRecord(value)) {
    addIssue(issues, path, "Must be a grocery item object.");
    return null;
  }
  requireExactShape(issues, value, path, ["id", "mealId", "ingredientId", "section", "checked", "source"]);
  if (!isId(value.id)) addIssue(issues, `${path}.id`, "Must be a nonempty bounded ID.");
  if (!isId(value.mealId) || !ingredientsByMeal.has(value.mealId)) {
    addIssue(issues, `${path}.mealId`, "Must reference a meal in this week.");
  }
  if (
    !isId(value.ingredientId) ||
    typeof value.mealId !== "string" ||
    !ingredientsByMeal.get(value.mealId)?.has(value.ingredientId)
  ) {
    addIssue(issues, `${path}.ingredientId`, "Must reference a canonical ingredient on the linked meal.");
  }
  if (!GROCERY_SECTIONS.includes(value.section as (typeof GROCERY_SECTIONS)[number])) addIssue(issues, `${path}.section`, "Must be a supported grocery section.");
  if (typeof value.checked !== "boolean") addIssue(issues, `${path}.checked`, "Must be a Boolean.");
  if (!GROCERY_SOURCES.includes(value.source as (typeof GROCERY_SOURCES)[number])) addIssue(issues, `${path}.source`, "Must be a supported grocery source.");
  if (typeof value.mealId === "string" && typeof value.ingredientId === "string") {
    const key = `${value.mealId}\u0000${value.ingredientId}`;
    if (groceryKeys.has(key)) addIssue(issues, path, "May contain only one execution record per recipe ingredient.");
    groceryKeys.add(key);
  }
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
  requireExactShape(issues, data, `${path}.data`, ["meals", "prepSessions", "groceries", "leftovers", "feedback", "weekLesson"]);
  const mealIds = new Set<string>();
  const mealDates = new Map<string, IsoDate>();
  const mealStatuses = new Map<string, string>();
  const ingredientsByMeal = new Map<string, Set<string>>();
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
        if (isRecord(meal) && typeof meal.status === "string") mealStatuses.set(validated.id, meal.status);
        if (isRecord(meal) && Array.isArray(meal.ingredients)) {
          ingredientsByMeal.set(
            validated.id,
            new Set(
              meal.ingredients
                .filter(isRecord)
                .map((ingredient) => ingredient.id)
                .filter((ingredient): ingredient is string => typeof ingredient === "string"),
            ),
          );
        }
      }
      if (validated.date && validated.slot) {
        const key = `${validated.date}:${validated.slot}`;
        if (mealSlots.has(key)) addIssue(issues, `${mealPath}.slot`, "That date and slot is already occupied.");
        mealSlots.add(key);
      }
    });
  }

  const prepSessionIds = new Set<string>();
  const prepEntryIds = new Set<string>();
  let prepEntryCount = 0;
  if (!Array.isArray(data.prepSessions) || data.prepSessions.length > MAX_PREP_SESSIONS) {
    addIssue(issues, `${path}.data.prepSessions`, `Must contain at most ${MAX_PREP_SESSIONS} sessions.`);
  } else {
    data.prepSessions.forEach((session, index) => {
      const sessionPath = `${path}.data.prepSessions[${index}]`;
      if (!isRecord(session)) {
        addIssue(issues, sessionPath, "Must be a prep session object.");
        return;
      }
      requireExactShape(issues, session, sessionPath, ["id", "label", "steps"], ["prepDate"]);
      if (!isId(session.id)) addIssue(issues, `${sessionPath}.id`, "Must be a nonempty bounded ID.");
      else if (prepSessionIds.has(session.id)) addIssue(issues, `${sessionPath}.id`, "Must be unique within the week.");
      else prepSessionIds.add(session.id);
      if (!isText(session.label, MAX_COMMAND_TEXT_LENGTH, { nonempty: true })) {
        addIssue(issues, `${sessionPath}.label`, "Must be a nonempty bounded label.");
      }
      if (session.prepDate !== undefined && (!isIsoDate(session.prepDate) || (weekId && !weekContainsPrepDate(weekId, session.prepDate)))) {
        addIssue(issues, `${sessionPath}.prepDate`, "Must be an ISO date in the week prep interval.");
      }
      if (!Array.isArray(session.steps)) {
        addIssue(issues, `${sessionPath}.steps`, "Must be an array of session steps.");
        return;
      }
      prepEntryCount += session.steps.length;
      const sessionStepIds = new Set<string>();
      session.steps.forEach((entry, entryIndex) => {
        const entryPath = `${sessionPath}.steps[${entryIndex}]`;
        if (!isRecord(entry)) {
          addIssue(issues, entryPath, "Must be a prep-session step reference.");
          return;
        }
        requireExactShape(issues, entry, entryPath, ["id", "stepId"]);
        if (!isId(entry.id)) addIssue(issues, `${entryPath}.id`, "Must be a nonempty bounded ID.");
        else if (prepEntryIds.has(entry.id)) addIssue(issues, `${entryPath}.id`, "Must be unique within the week.");
        else prepEntryIds.add(entry.id);
        if (!isId(entry.stepId) || !stepIds.has(entry.stepId)) addIssue(issues, `${entryPath}.stepId`, "Must reference an instruction step in this week.");
        else if (sessionStepIds.has(entry.stepId)) addIssue(issues, `${entryPath}.stepId`, "May reference an instruction only once in one session.");
        else sessionStepIds.add(entry.stepId);
      });
    });
  }
  if (prepEntryCount > MAX_PREP_ENTRIES) {
    addIssue(issues, `${path}.data.prepSessions`, `Must contain at most ${MAX_PREP_ENTRIES} session references.`);
  }

  const groceryIds = new Set<string>();
  const groceryKeys = new Set<string>();
  if (!Array.isArray(data.groceries) || data.groceries.length > MAX_GROCERY_ITEMS) {
    addIssue(issues, `${path}.data.groceries`, `Must contain at most ${MAX_GROCERY_ITEMS} items.`);
  } else {
    data.groceries.forEach((item, index) => {
      const itemPath = `${path}.data.groceries[${index}]`;
      const id = validateGroceryItem(item, itemPath, issues, ingredientsByMeal, groceryKeys);
      if (!id) return;
      if (groceryIds.has(id)) addIssue(issues, `${itemPath}.id`, "Must be unique within the week.");
      groceryIds.add(id);
    });
    for (const [mealId, ingredientIds] of ingredientsByMeal) {
      for (const ingredientId of ingredientIds) {
        if (!groceryKeys.has(`${mealId}\u0000${ingredientId}`)) {
          addIssue(
            issues,
            `${path}.data.groceries`,
            "Must include one grocery execution record for every canonical recipe ingredient.",
          );
          break;
        }
      }
    }
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
      if (!isId(leftover.sourceMealId) || !mealIds.has(leftover.sourceMealId)) {
        addIssue(issues, `${leftoverPath}.sourceMealId`, "Must reference a meal in this week.");
      } else if (mealStatuses.get(leftover.sourceMealId) !== "cooked") {
        addIssue(issues, `${leftoverPath}.sourceMealId`, "Must reference the cooked meal that produced these leftovers.");
      }
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
    ...(meal.sourceRecipe === undefined
      ? {}
      : { sourceRecipe: { ...meal.sourceRecipe } }),
    ingredients: meal.ingredients.map((ingredient) => ({ ...ingredient })),
    instructions: meal.instructions.map(cloneStep),
  };
}

function cloneWeekData(data: WeekPlannerData): WeekPlannerData {
  return {
    meals: data.meals.map(cloneMeal),
    prepSessions: data.prepSessions.map((session) => ({
      ...session,
      steps: session.steps.map((entry) => ({ ...entry })),
    })),
    groceries: data.groceries.map((item) => ({ ...item })),
    leftovers: data.leftovers.map((leftover) => ({ ...leftover })),
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

function prepSessionEntryCount(sessions: PrepSession[]): number {
  return sessions.reduce((count, session) => count + session.steps.length, 0);
}

function findPrepSessionEntry(
  sessions: PrepSession[],
  entryId: string,
): { session: PrepSession; entryIndex: number } | null {
  for (const session of sessions) {
    const entryIndex = session.steps.findIndex((entry) => entry.id === entryId);
    if (entryIndex >= 0) return { session, entryIndex };
  }
  return null;
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

function ingredientKey(ingredient: string): string {
  return ingredient.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-CA");
}

function ingredientLineParts(line: string): { amount: string; ingredient: string } {
  const trimmed = line.trim();
  const match = /^((?:\d+\s+)?(?:\d+(?:[./]\d+)?|[¼½¾⅓⅔]))(?:\s+(cups?|tbsp|tsp|ml|l|g|kg|lb|lbs|oz|cans?|cloves?|bunch(?:es)?|pinches?|packages?|pkgs?|sprigs?|heads?|slices?))?\s+(.+)$/i.exec(trimmed);
  if (!match) return { amount: "", ingredient: trimmed };
  return { amount: [match[1], match[2]].filter(Boolean).join(" "), ingredient: match[3].trim() };
}

function formatIngredientLine(ingredient: { amount: string; ingredient: string }): string {
  return [ingredient.amount, ingredient.ingredient].filter(Boolean).join(" ");
}

function allIngredientIds(state: HouseholdPlannerState): Set<string> {
  return new Set(state.weeks.flatMap((week) => week.data.meals.flatMap((meal) => meal.ingredients.map((ingredient) => ingredient.id))));
}

function groceryIngredientKey(mealId: string, ingredientId: string): string {
  return `${mealId}\u0000${ingredientId}`;
}

function inferredGrocerySection(ingredient: string): GroceryItem["section"] {
  const normalized = ingredient.toLocaleLowerCase("en-CA");
  if (/\b(chicken|turkey|beef|pork|lamb|salmon|tuna|fish|shrimp|prawn|sausage|bacon)\b/.test(normalized)) {
    return "Meat & seafood";
  }
  if (/\b(milk|yog(?:h)?urt|cheese|feta|butter|cream|sour cream|ricotta|mozzarella|parmesan|egg)\b/.test(normalized)) {
    return "Dairy";
  }
  if (/\b(pepper|pea|cucumber|lemon|lime|onion|garlic|tomato|potato|carrot|celery|lettuce|spinach|kale|broccoli|cauliflower|zucchini|squash|mushroom|avocado|herb|basil|cilantro|parsley|ginger|apple|berry|orange|banana)\b/.test(normalized)) {
    return "Produce";
  }
  return "Pantry";
}

function groceryIngredientLabel(week: WeekPlan, grocery: GroceryItem): string {
  return week.data.meals
    .find((meal) => meal.id === grocery.mealId)
    ?.ingredients.find((ingredient) => ingredient.id === grocery.ingredientId)
    ?.ingredient ?? "recipe ingredient";
}

type GroceryProjectionResult = {
  added: number;
  removed: number;
};

/**
 * Treat groceries as execution state for canonical recipe-ingredient uses.
 * Recipe text and amounts deliberately live only on Meal.ingredients; this
 * reconciler retains the user-owned classifications while replacing the
 * projection whenever the canonical recipe changes.
 */
function reconcileGroceryProjection(
  context: HouseholdCommandContext,
  week: WeekPlan,
): GroceryProjectionResult | null {
  const desired = week.data.meals.flatMap((meal) =>
    meal.ingredients.map((ingredient) => ({ meal, ingredient })),
  );
  if (desired.length > MAX_GROCERY_ITEMS) return null;

  const existingByIngredient = new Map<string, GroceryItem>();
  for (const grocery of week.data.groceries) {
    const key = groceryIngredientKey(grocery.mealId, grocery.ingredientId);
    if (!existingByIngredient.has(key)) existingByIngredient.set(key, grocery);
  }
  const existingIds = new Set(week.data.groceries.map((grocery) => grocery.id));
  const projected: GroceryItem[] = [];
  let added = 0;

  for (const { meal, ingredient } of desired) {
    const key = groceryIngredientKey(meal.id, ingredient.id);
    const existing = existingByIngredient.get(key);
    if (existing) {
      projected.push(existing);
      continue;
    }
    const id = materializeId(context, "grocery", existingIds);
    if (!id) return null;
    projected.push({
      id,
      mealId: meal.id,
      ingredientId: ingredient.id,
      section: inferredGrocerySection(ingredient.ingredient),
      source: "shop",
      checked: false,
    });
    added += 1;
  }
  const removed = week.data.groceries.length - (projected.length - added);
  week.data.groceries = projected;
  return { added, removed };
}

function materializeRecipeIngredients(
  context: HouseholdCommandContext,
  lines: string[],
  existingIds: Set<string>,
): { ingredients: Meal["ingredients"] } | null {
  const ingredients: Meal["ingredients"] = [];
  const seenKeys = new Set<string>();
  for (const line of lines) {
    const parsed = ingredientLineParts(line);
    if (!parsed.ingredient || seenKeys.has(ingredientKey(parsed.ingredient))) continue;
    const id = materializeId(context, "ingredient", existingIds);
    if (!id) return null;
    seenKeys.add(ingredientKey(parsed.ingredient));
    ingredients.push({ id, ...parsed });
  }
  return { ingredients };
}

function reconcileRecipeIngredientLines(
  context: HouseholdCommandContext,
  meal: Meal,
  lines: string[],
  existingIds: Set<string>,
): { ingredients: Meal["ingredients"]; ingredientIdAliases: Map<string, string> } | null {
  const ingredients: Meal["ingredients"] = [];
  const seenKeys = new Set<string>();
  for (const line of lines) {
    const parsed = ingredientLineParts(line);
    const key = ingredientKey(parsed.ingredient);
    if (!parsed.ingredient || seenKeys.has(key)) continue;
    const existing = meal.ingredients.find((candidate) => ingredientKey(candidate.ingredient) === key);
    const id = existing?.id ?? materializeId(context, "ingredient", existingIds);
    if (!id) return null;
    seenKeys.add(key);
    ingredients.push({ id, ...parsed });
  }
  const ingredientIdAliases = new Map<string, string>();
  for (const existing of meal.ingredients) {
    const parsed = ingredientLineParts(formatIngredientLine(existing));
    const canonical = ingredients.find(
      (candidate) => ingredientKey(candidate.ingredient) === ingredientKey(parsed.ingredient),
    );
    if (canonical && canonical.id !== existing.id) ingredientIdAliases.set(existing.id, canonical.id);
  }
  const retainedIds = new Set(ingredients.map((ingredient) => ingredient.id));
  if (meal.instructions.some((step) => step.inputs.some((input) => !retainedIds.has(ingredientIdAliases.get(input.ingredientId) ?? input.ingredientId)))) {
    return null;
  }
  return { ingredients, ingredientIdAliases };
}

function linkInstructionInputs(
  context: HouseholdCommandContext,
  meal: Meal,
  inputs: Array<{ amount: string; ingredient: string }>,
  existingIds: Set<string>,
): InstructionStep["inputs"] | null {
  const linked: InstructionStep["inputs"] = [];
  for (const input of inputs) {
    const key = ingredientKey(input.ingredient);
    let ingredient = meal.ingredients.find((candidate) => ingredientKey(candidate.ingredient) === key);
    if (!ingredient) {
      const id = materializeId(context, "ingredient", existingIds);
      if (!id) return null;
      ingredient = { id, amount: input.amount, ingredient: input.ingredient };
      meal.ingredients.push(ingredient);
    }
    linked.push({ ...input, ingredientId: ingredient.id });
  }
  return linked;
}

function sessionReferencesAnyStep(session: PrepSession, stepIds: Set<string>): boolean {
  return session.steps.some((entry) => stepIds.has(entry.stepId));
}

function rejectMissingWeek(state: HouseholdPlannerState, weekId: string): HouseholdCommandExecution {
  return failure(state, "Week not found.", { weekId: `No canonical week exists for ${weekId}.` });
}

function rejectArchivedWeek(state: HouseholdPlannerState): HouseholdCommandExecution {
  return failure(state, "Archived weeks are read-only.");
}

function leftoverPortions(meal: Meal): number {
  const match = meal.leftoverNote.match(
    /\b(\d{1,2})(?:\s+[A-Za-z][A-Za-z'-]*){0,2}\s+(?:portions?|servings?|lunch(?:es)?)\b/i,
  );
  return match ? Number(match[1]) : 2;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export type SourcedRecipeReplacementEligibility =
  | { ok: true }
  | { ok: false; message: string };

export function validateSourcedRecipeReplacementEligibility(
  state: HouseholdPlannerState,
  command: Extract<HouseholdCommand, { type: "replaceMealRecipeFromSource" }>,
): SourcedRecipeReplacementEligibility {
  const week = findWeek(state, command.weekId);
  if (!week) return { ok: false, message: "Week not found." };
  if (week.status !== "planned" && week.status !== "active") {
    return { ok: false, message: "Only planned or active weeks accept sourced recipe replacement." };
  }
  const meal = week.data.meals.find((candidate) => candidate.id === command.mealId);
  if (!meal) return { ok: false, message: "Meal not found." };
  if (meal.status !== "planned" && meal.status !== "moved") {
    return { ok: false, message: "Only planned or moved meals accept sourced recipe replacement." };
  }
  if (meal.instructions.some((step) => step.complete)) {
    return { ok: false, message: "Completed instruction steps must be cleared in an earlier change." };
  }
  if (meal.instructions.some((step) => step.note !== undefined)) {
    return { ok: false, message: "Instruction notes must be cleared in an earlier change." };
  }
  if (meal.instructions.some((step) => step.timerStartedAt !== undefined)) {
    return { ok: false, message: "Running instruction timers must be stopped in an earlier change." };
  }
  const stepIds = new Set(meal.instructions.map((step) => step.id));
  if (week.data.prepSessions.some((session) => sessionReferencesAnyStep(session, stepIds))) {
    return { ok: false, message: "Prep-session references must be removed in an earlier change." };
  }
  return { ok: true };
}

export function validateCanonicalHouseholdBatchBase(
  state: HouseholdPlannerState,
  commands: readonly HouseholdCommand[],
): { ok: true } | { ok: false; operationIndex: number; message: string } {
  for (const [operationIndex, command] of commands.entries()) {
    if (command.type !== "replaceMealRecipeFromSource") continue;
    const eligible = validateSourcedRecipeReplacementEligibility(state, command);
    if (!eligible.ok) return { ...eligible, operationIndex };
  }
  return { ok: true };
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
      if (
        week.data.leftovers.some(
          (leftover) => leftover.sourceMealId === moving.id || leftover.sourceMealId === target?.id,
        )
      ) {
        return failure(state, "A meal with tracked leftovers cannot be moved or swapped.", {
          mealId: "Keep the cooked source meal on its recorded date.",
        });
      }
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
      if (
        command.status !== "cooked" &&
        week.data.leftovers.some((leftover) => leftover.sourceMealId === meal.id)
      ) {
        return failure(state, "A cooked meal with tracked leftovers cannot change status.", {
          status: "Undo the original cooked action before other changes depend on it.",
        });
      }
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
      const ingredientLines = (command.changes.ingredients as unknown[]).map((ingredient) =>
        typeof ingredient === "string"
          ? ingredient
          : isRecord(ingredient) && typeof ingredient.amount === "string" && typeof ingredient.ingredient === "string"
            ? formatIngredientLine({ amount: ingredient.amount, ingredient: ingredient.ingredient })
            : "",
      );
      const previous = {
        title: meal.title,
        subtitle: meal.subtitle,
        venue: meal.venue,
        prepNote: meal.prepNote,
        leftoverNote: meal.leftoverNote,
        notes: meal.notes,
        ingredients: meal.ingredients.map(formatIngredientLine),
        yieldText: meal.yieldText ?? null,
      };
      if (equalJson(previous, command.changes)) return failure(state, "Meal snapshot is unchanged.");
      meal.title = command.changes.title;
      meal.subtitle = command.changes.subtitle;
      meal.venue = command.changes.venue;
      meal.prepNote = command.changes.prepNote;
      meal.leftoverNote = command.changes.leftoverNote;
      meal.notes = command.changes.notes;
      const reconciledIngredients = reconcileRecipeIngredientLines(context, meal, ingredientLines, allIngredientIds(next));
      if (!reconciledIngredients) {
        return failure(state, "Keep recipe ingredients that are still used by an instruction step.", {
          ingredients: "Edit or remove the instruction use before removing its recipe ingredient.",
        });
      }
      for (const step of meal.instructions) {
        for (const input of step.inputs) {
          const canonicalIngredientId = reconciledIngredients.ingredientIdAliases.get(input.ingredientId);
          if (canonicalIngredientId) input.ingredientId = canonicalIngredientId;
        }
      }
      meal.ingredients = reconciledIngredients.ingredients;
      if (command.changes.yieldText === null) delete meal.yieldText;
      else meal.yieldText = command.changes.yieldText;
      const groceryProjection = reconcileGroceryProjection(context, week);
      if (!groceryProjection) return failure(state, "Could not project groceries for the updated recipe.");
      return success(state, next, `Updated ${meal.title}`, meal.id, [
        "Week-local recipe details were updated",
        ...(groceryProjection.added || groceryProjection.removed
          ? [`Groceries: ${groceryProjection.added} added, ${groceryProjection.removed} removed`]
          : []),
      ]);
    }

    case "replaceMealRecipeFromSource": {
      const eligible = validateSourcedRecipeReplacementEligibility(state, command);
      if (!eligible.ok) return failure(state, eligible.message);
      if (!week) return rejectMissingWeek(state, command.weekId);
      const meal = week.data.meals.find((item) => item.id === command.mealId);
      if (!meal) return failure(state, "Meal not found.");
      const existingStepIds = new Set(
        week.data.meals.flatMap((item) => item.instructions.map((step) => step.id)),
      );
      const ingredients = materializeRecipeIngredients(
        context,
        command.recipe.steps.flatMap((step) => step.inputs.map(formatIngredientLine)),
        allIngredientIds(next),
      );
      if (!ingredients) return failure(state, "Could not materialize recipe ingredient IDs.");
      const recipeMeal = { ...meal, ingredients: ingredients.ingredients };
      const instructions: InstructionStep[] = [];
      const createdIds: Record<string, string> = {};
      for (const [index, recipeStep] of command.recipe.steps.entries()) {
        const id = materializeId(context, "step", existingStepIds);
        if (!id) return failure(state, "Could not materialize a unique instruction-step ID.");
        createdIds[`instructionStep.${index}`] = id;
        const inputs = linkInstructionInputs(context, recipeMeal, recipeStep.inputs, allIngredientIds(next));
        if (!inputs) return failure(state, "Could not link recipe step ingredients.");
        instructions.push({
          id,
          inputs,
          instruction: recipeStep.instruction,
          complete: false,
          ...(recipeStep.timerDurationSeconds === undefined
            ? {}
            : { timerDurationSeconds: recipeStep.timerDurationSeconds }),
        });
      }
      meal.title = command.recipe.title;
      if (command.recipe.yieldText === undefined) delete meal.yieldText;
      else meal.yieldText = command.recipe.yieldText;
      meal.sourceRecipe = { ...command.recipe.source };
      meal.ingredients = recipeMeal.ingredients;
      meal.instructions = instructions;
      const groceryProjection = reconcileGroceryProjection(context, week);
      if (!groceryProjection) return failure(state, "Could not project groceries for the replaced recipe.");
      return success(
        state,
        next,
        `Replaced recipe for ${meal.title}`,
        meal.id,
        [
          "Recipe title, yield, ingredients, instructions, and source were replaced",
          ...(groceryProjection.added || groceryProjection.removed
            ? [`Groceries: ${groceryProjection.added} added, ${groceryProjection.removed} removed`]
            : []),
        ],
        createdIds,
      );
    }

    case "addInstructionStep": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const meal = week.data.meals.find((item) => item.id === command.mealId);
      if (!meal) return failure(state, "Meal not found.", { mealId: "Choose a meal in the selected week." });
      if (meal.instructions.length >= MAX_STEPS_PER_MEAL || command.position > meal.instructions.length) return failure(state, "Instruction position is outside the recipe.", { position: "Choose an insertion position in the current recipe." });
      const stepIds = new Set(week.data.meals.flatMap((item) => item.instructions.map((step) => step.id)));
      const id = materializeId(context, "step", stepIds);
      if (!id) return failure(state, "Could not materialize a unique instruction-step ID.");
      const inputs = linkInstructionInputs(context, meal, command.step.inputs, allIngredientIds(next));
      if (!inputs) return failure(state, "Could not link instruction-step ingredients.");
      const step: InstructionStep = {
        id,
        inputs,
        instruction: command.step.instruction,
        complete: false,
      };
      if (command.step.timerDurationSeconds !== undefined) step.timerDurationSeconds = command.step.timerDurationSeconds;
      if (command.step.note !== undefined && command.step.note !== "") step.note = command.step.note;
      meal.instructions.splice(command.position, 0, step);
      const groceryProjection = reconcileGroceryProjection(context, week);
      if (!groceryProjection) return failure(state, "Could not project groceries for the updated recipe.");
      return success(state, next, `Added a step to ${meal.title}`, id, [
        `Inserted at recipe position ${command.position}`,
        ...(groceryProjection.added
          ? [`Groceries: ${groceryProjection.added} added`]
          : []),
      ], { instructionStepId: id });
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
      const inputs = linkInstructionInputs(context, resolved.meal, command.changes.inputs, allIngredientIds(next));
      if (!inputs) return failure(state, "Could not link instruction-step ingredients.");
      resolved.step.inputs = inputs;
      resolved.step.instruction = command.changes.instruction;
      if (command.changes.timerDurationSeconds === null) delete resolved.step.timerDurationSeconds;
      else resolved.step.timerDurationSeconds = command.changes.timerDurationSeconds;
      if (durationChanged) {
        delete resolved.step.timerStartedAt;
        delete resolved.step.timerPaused;
      }
      const groceryProjection = reconcileGroceryProjection(context, week);
      if (!groceryProjection) return failure(state, "Could not project groceries for the updated recipe.");
      return success(state, next, "Updated instruction step", resolved.step.id, [
        durationChanged ? "Step content and timer duration updated; running timer reset" : "Step content updated",
        ...(groceryProjection.added
          ? [`Groceries: ${groceryProjection.added} added`]
          : []),
      ]);
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
      if (week.data.prepSessions.some((session) => session.steps.some((entry) => entry.stepId === command.stepId))) {
        return failure(state, "Remove this step from prep sessions before deleting it.", { stepId: "The step still has a prep-session reference." });
      }
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
      if (command.complete) {
        delete resolved.step.timerStartedAt;
        delete resolved.step.timerPaused;
      }
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
      const wasPaused = resolved.step.timerPaused === true;
      resolved.step.timerStartedAt = context.now;
      delete resolved.step.timerPaused;
      return success(state, next, wasPaused ? "Resumed instruction timer" : "Started instruction timer", resolved.step.id, [`Timer started at ${context.now}`]);
    }

    case "pauseInstructionTimer": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if (!resolved.step.timerDurationSeconds) return failure(state, "This instruction step has no timer duration.");
      if (resolved.step.timerStartedAt === undefined) return failure(state, "The instruction timer is not running.");
      const elapsed = Math.max(0, Math.floor((context.now - resolved.step.timerStartedAt) / 1_000));
      const remainingSeconds = Math.max(0, resolved.step.timerDurationSeconds - elapsed);
      if (remainingSeconds === 0) return failure(state, "The instruction timer has already elapsed. Reset it to run it again.");
      resolved.step.timerDurationSeconds = remainingSeconds;
      delete resolved.step.timerStartedAt;
      resolved.step.timerPaused = true;
      return success(state, next, "Paused instruction timer", resolved.step.id, [`Remaining time: ${remainingSeconds}s`]);
    }

    case "resetInstructionTimer": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if (resolved.step.timerStartedAt === undefined && resolved.step.timerPaused !== true) return failure(state, "The instruction timer has not been started.");
      delete resolved.step.timerStartedAt;
      delete resolved.step.timerPaused;
      return success(state, next, "Reset instruction timer", resolved.step.id, ["Persisted timer start cleared"]);
    }

    case "setInstructionTimerRemaining": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const resolved = findStep(week, command.stepId);
      if (!resolved) return failure(state, "Instruction step not found.", { stepId: "Choose a step in the selected week." });
      if (!resolved.step.timerDurationSeconds) return failure(state, "This instruction step has no timer duration.");
      if (resolved.step.complete) return failure(state, "Reopen the instruction step before setting its timer.");
      const elapsed = resolved.step.timerStartedAt === undefined
        ? 0
        : Math.max(0, Math.floor((context.now - resolved.step.timerStartedAt) / 1_000));
      const previousRemaining = Math.max(0, resolved.step.timerDurationSeconds - elapsed);
      if (previousRemaining === command.remainingSeconds) return failure(state, "Instruction timer time is unchanged.");
      const wasRunning = resolved.step.timerStartedAt !== undefined;
      const wasPaused = resolved.step.timerPaused === true;
      resolved.step.timerDurationSeconds = command.remainingSeconds;
      if (wasRunning) {
        resolved.step.timerStartedAt = context.now;
        delete resolved.step.timerPaused;
      }
      return success(
        state,
        next,
        "Set instruction timer",
        resolved.step.id,
        [
          `Remaining time: ${previousRemaining}s to ${command.remainingSeconds}s`,
          wasRunning ? "Timer continues from the edited time" : wasPaused ? "Timer remains paused" : "Timer remains stopped",
        ],
      );
    }

    case "createPrepSession": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      if (week.data.prepSessions.length >= MAX_PREP_SESSIONS) return failure(state, "The prep-session list is full.");
      if (command.prepDate !== null && !weekContainsPrepDate(week.id, command.prepDate)) {
        return failure(state, "Prep date is outside the allowed interval.", { prepDate: "Choose a date in this prep week." });
      }
      const id = materializeId(context, "prep-session", new Set(week.data.prepSessions.map((session) => session.id)));
      if (!id) return failure(state, "Could not materialize a unique prep-session ID.");
      const session: PrepSession = { id, label: command.label, steps: [] };
      if (command.prepDate !== null) session.prepDate = command.prepDate;
      week.data.prepSessions.push(session);
      return success(state, next, `Created prep session ${session.label}`, session.id, [session.prepDate ? `Prep date: ${session.prepDate}` : "Undated prep session"], { prepSessionId: session.id });
    }

    case "updatePrepSession": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const session = week.data.prepSessions.find((candidate) => candidate.id === command.sessionId);
      if (!session) return failure(state, "Prep session not found.", { sessionId: "Choose a prep session in the selected week." });
      if (command.prepDate !== null && !weekContainsPrepDate(week.id, command.prepDate)) {
        return failure(state, "Prep date is outside the allowed interval.", { prepDate: "Choose a date in this prep week." });
      }
      if (session.label === command.label && (session.prepDate ?? null) === command.prepDate) return failure(state, "Prep session is unchanged.");
      session.label = command.label;
      if (command.prepDate === null) delete session.prepDate;
      else session.prepDate = command.prepDate;
      return success(state, next, `Updated prep session ${session.label}`, session.id, [session.prepDate ? `Prep date: ${session.prepDate}` : "Prep date cleared"]);
    }

    case "movePrepSession": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const currentPosition = week.data.prepSessions.findIndex((session) => session.id === command.sessionId);
      if (currentPosition < 0) return failure(state, "Prep session not found.", { sessionId: "Choose a prep session in the selected week." });
      if (command.targetPosition >= week.data.prepSessions.length) return failure(state, "Prep-session position is outside the list.", { targetPosition: "Choose a current prep-session position." });
      if (currentPosition === command.targetPosition) return failure(state, "Prep session is already in that position.");
      const [session] = week.data.prepSessions.splice(currentPosition, 1);
      week.data.prepSessions.splice(command.targetPosition, 0, session);
      return success(state, next, "Reordered prep session", session.id, [`Session position: ${currentPosition} to ${command.targetPosition}`]);
    }

    case "removePrepSession": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const sessionIndex = week.data.prepSessions.findIndex((session) => session.id === command.sessionId);
      if (sessionIndex < 0) return failure(state, "Prep session not found.", { sessionId: "Choose a prep session in the selected week." });
      const [session] = week.data.prepSessions.splice(sessionIndex, 1);
      return success(state, next, `Removed prep session ${session.label}`, session.id, [`Removed ${session.steps.length} session references; recipe steps were unchanged`]);
    }

    case "addPrepSessionStep": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const session = week.data.prepSessions.find((candidate) => candidate.id === command.sessionId);
      if (!session) return failure(state, "Prep session not found.", { sessionId: "Choose a prep session in the selected week." });
      if (!findStep(week, command.stepId)) return failure(state, "Instruction step not found.", { stepId: "Choose an instruction in the selected week." });
      if (session.steps.some((entry) => entry.stepId === command.stepId)) return failure(state, "This instruction is already in the prep session.");
      if (prepSessionEntryCount(week.data.prepSessions) >= MAX_PREP_ENTRIES) return failure(state, "The prep-session list is full.");
      if (command.targetPosition > session.steps.length) return failure(state, "Prep-session position is outside this session.", { targetPosition: "Choose a position in the prep session." });
      const existingEntryIds = new Set(week.data.prepSessions.flatMap((candidate) => candidate.steps.map((entry) => entry.id)));
      const id = materializeId(context, "prep-session-step", existingEntryIds);
      if (!id) return failure(state, "Could not materialize a unique prep-session step ID.");
      session.steps.splice(command.targetPosition, 0, { id, stepId: command.stepId });
      return success(state, next, "Added instruction to prep session", id, [`Session: ${session.label}`, `Position: ${command.targetPosition}`], { prepSessionStepId: id });
    }

    case "movePrepSessionStep": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const session = week.data.prepSessions.find((candidate) => candidate.id === command.sessionId);
      if (!session) return failure(state, "Prep session not found.", { sessionId: "Choose a prep session in the selected week." });
      const currentPosition = session.steps.findIndex((entry) => entry.id === command.entryId);
      if (currentPosition < 0) return failure(state, "Prep-session step not found.", { entryId: "Choose a step in this prep session." });
      if (command.targetPosition >= session.steps.length) return failure(state, "Prep-session position is outside this session.", { targetPosition: "Choose a position in the prep session." });
      if (currentPosition === command.targetPosition) return failure(state, "Prep-session step is already in that position.");
      const [entry] = session.steps.splice(currentPosition, 1);
      session.steps.splice(command.targetPosition, 0, entry);
      return success(state, next, "Reordered prep-session step", entry.id, [`Session: ${session.label}`, `Position: ${currentPosition} to ${command.targetPosition}`]);
    }

    case "removePrepSessionStep": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const session = week.data.prepSessions.find((candidate) => candidate.id === command.sessionId);
      if (!session) return failure(state, "Prep session not found.", { sessionId: "Choose a prep session in the selected week." });
      const entryIndex = session.steps.findIndex((entry) => entry.id === command.entryId);
      if (entryIndex < 0) return failure(state, "Prep-session step not found.", { entryId: "Choose a step in this prep session." });
      const [entry] = session.steps.splice(entryIndex, 1);
      return success(state, next, "Removed instruction from prep session", entry.id, ["The canonical instruction and recipe order were preserved"]);
    }

    case "setPrepPlan": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const plannedStepIds = new Set<string>();
      for (const entry of command.entries) {
        if (plannedStepIds.has(entry.stepId) || !findStep(week, entry.stepId)) {
          return failure(state, "Legacy prep plan must contain each known instruction once.");
        }
        if (!weekContainsPrepDate(week.id, entry.prepDate)) return failure(state, "Prep date is outside the allowed interval.");
        plannedStepIds.add(entry.stepId);
      }
      const sessionIds = new Set(week.data.prepSessions.map((session) => session.id));
      const entryIds = new Set(week.data.prepSessions.flatMap((session) => session.steps.map((entry) => entry.id)));
      const sessionsByDate = new Map<IsoDate, PrepSession>();
      const sessions: PrepSession[] = [];
      for (const entry of command.entries) {
        let session = sessionsByDate.get(entry.prepDate);
        if (!session) {
          const id = materializeId(context, "prep-session", sessionIds);
          if (!id) return failure(state, "Could not materialize a legacy prep-session ID.");
          session = { id, label: `Prep ${entry.prepDate}`, prepDate: entry.prepDate, steps: [] };
          sessionsByDate.set(entry.prepDate, session);
          sessions.push(session);
        }
        const id = materializeId(context, "prep-session-step", entryIds);
        if (!id) return failure(state, "Could not materialize a legacy prep-session step ID.");
        session.steps.push({ id, stepId: entry.stepId });
      }
      if (equalJson(week.data.prepSessions, sessions)) return failure(state, "Prep plan is unchanged.");
      week.data.prepSessions = sessions;
      return success(state, next, `Migrated legacy prep plan into ${sessions.length} sessions`, `${week.id}:prep-sessions`, ["Recipe instruction order was unchanged"]);
    }

    case "movePrepReference": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const located = findPrepSessionEntry(week.data.prepSessions, command.referenceId);
      if (!located) return failure(state, "Prep-session step not found.", { referenceId: "Choose a prep-session step in the selected week." });
      if (command.targetPosition >= located.session.steps.length) return failure(state, "Prep position is outside the session.");
      const [entry] = located.session.steps.splice(located.entryIndex, 1);
      located.session.steps.splice(command.targetPosition, 0, entry);
      return success(state, next, "Reordered legacy prep reference", entry.id, [`Session: ${located.session.label}`]);
    }

    case "reschedulePrepReference": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      if (!weekContainsPrepDate(week.id, command.prepDate)) return failure(state, "Prep date is outside the allowed interval.");
      const located = findPrepSessionEntry(week.data.prepSessions, command.referenceId);
      if (!located) return failure(state, "Prep-session step not found.", { referenceId: "Choose a prep-session step in the selected week." });
      let destination = week.data.prepSessions.find((session) => session.prepDate === command.prepDate);
      if (!destination) {
        const id = materializeId(context, "prep-session", new Set(week.data.prepSessions.map((session) => session.id)));
        if (!id) return failure(state, "Could not materialize a prep-session ID.");
        destination = { id, label: `Prep ${command.prepDate}`, prepDate: command.prepDate, steps: [] };
        week.data.prepSessions.push(destination);
      }
      const [entry] = located.session.steps.splice(located.entryIndex, 1);
      destination.steps.push(entry);
      return success(state, next, "Rescheduled legacy prep reference", entry.id, [`Prep session: ${destination.label}`]);
    }

    case "removePrepReference": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const located = findPrepSessionEntry(week.data.prepSessions, command.referenceId);
      if (!located) return failure(state, "Prep-session step not found.", { referenceId: "Choose a prep-session step in the selected week." });
      const [entry] = located.session.steps.splice(located.entryIndex, 1);
      return success(state, next, "Removed legacy prep reference", entry.id, ["The canonical instruction and recipe order were preserved"]);
    }

    case "moveGroceryItemsToSource": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      if (!GROCERY_SOURCES.includes(command.source)) {
        return failure(state, "Choose a supported grocery source.", { source: "Choose Shop, Farm box, or On hand." });
      }
      if (new Set(command.itemIds).size !== command.itemIds.length) {
        return failure(state, "Choose each grocery item only once.", { itemIds: "Remove duplicate grocery items." });
      }
      const groceries = command.itemIds.map((itemId) => week.data.groceries.find((item) => item.id === itemId));
      const missingItemId = command.itemIds.find((_itemId, index) => !groceries[index]);
      if (missingItemId) return failure(state, "Grocery item not found.", { itemIds: `Could not find ${missingItemId} in the selected week.` });
      const moved = (groceries as GroceryItem[])
        .filter((grocery) => grocery.source !== command.source)
        .map((grocery) => ({ grocery, previousSource: grocery.source }));
      if (!moved.length) return failure(state, "Selected groceries already have that source.");
      for (const { grocery } of moved) grocery.source = command.source;
      const sourceLabel = command.source === "farm_box" ? "Farm box" : command.source === "on_hand" ? "On hand" : "Shop";
      return success(
        state,
        next,
        `Moved ${moved.length} ${moved.length === 1 ? "grocery" : "groceries"} to ${sourceLabel}`,
        `${week.id}:grocery-source:${command.source}`,
        moved.map(({ grocery, previousSource }) => `${groceryIngredientLabel(week, grocery)}: ${previousSource} to ${command.source}`),
      );
    }

    case "setGroceryItemChecked": {
      if (!week) return rejectMissingWeek(state, command.weekId);
      const grocery = week.data.groceries.find((item) => item.id === command.itemId);
      if (!grocery) return failure(state, "Grocery item not found.", { itemId: "Choose an item in the selected week." });
      if (grocery.checked === command.checked) return failure(state, "Grocery checked state is unchanged.");
      const previous = grocery.checked;
      grocery.checked = command.checked;
      const label = groceryIngredientLabel(week, grocery);
      return success(state, next, command.checked ? `Checked off ${label}` : `Returned ${label} to the list`, grocery.id, [`Checked: ${previous} to ${command.checked}`]);
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
      const destination = week.data.meals.find((meal) => meal.date === command.targetDate && meal.slot === command.slot);
      if (
        destination &&
        week.data.leftovers.some((item) => item.sourceMealId === destination.id)
      ) {
        return failure(state, "A dinner with tracked leftovers cannot be replaced.", {
          targetDate: "Choose a dinner that is not the source of another leftover record.",
        });
      }
      if (destination && ["cooking", "cooked", "leftover"].includes(destination.status)) {
        return failure(state, "A started or completed dinner cannot be replaced with leftovers.", {
          targetDate: "Choose an open or not-yet-started dinner slot.",
        });
      }
      leftover.state = "assigned";
      leftover.assignedDate = command.targetDate;
      leftover.assignedSlot = command.slot;
      let displacedMealTitle: string | null = null;
      let removedPrepCount = 0;
      const createdIds: Record<string, string> = {};
      let destinationMeal: Meal;
      if (destination) {
        destinationMeal = destination;
        displacedMealTitle = destination.title;
        const displacedStepIds = new Set(destination.instructions.map((step) => step.id));
        for (const session of week.data.prepSessions) {
          const retained = session.steps.filter((entry) => !displacedStepIds.has(entry.stepId));
          removedPrepCount += session.steps.length - retained.length;
          session.steps = retained;
        }
        delete week.data.feedback[destination.id];
      } else {
        const id = materializeId(
          context,
          "meal",
          new Set(week.data.meals.map((meal) => meal.id)),
        );
        if (!id) return failure(state, "Could not materialize a unique leftover-meal ID.");
        destinationMeal = {
          id,
          date: command.targetDate,
          slot: command.slot,
          title: leftover.label,
          subtitle: "",
          venue: sourceMeal.venue,
          status: "leftover",
          protein: "none",
          prepNote: "",
          leftoverNote: "",
          notes: "",
          ingredients: [],
          instructions: [],
        };
        week.data.meals.push(destinationMeal);
        createdIds.mealId = id;
      }
      destinationMeal.title = leftover.label;
      destinationMeal.subtitle = `${leftover.portions} portions from ${sourceMeal.title}`;
      destinationMeal.venue = sourceMeal.venue;
      destinationMeal.status = "leftover";
      destinationMeal.protein = "none";
      destinationMeal.prepNote = "";
      destinationMeal.leftoverNote = `Leftovers from ${sourceMeal.date}`;
      destinationMeal.notes = `This dinner uses leftovers from ${sourceMeal.title}.`;
      destinationMeal.ingredients = [];
      destinationMeal.instructions = [];
      const groceryProjection = reconcileGroceryProjection(context, week);
      if (!groceryProjection) return failure(state, "Could not project groceries for the leftover assignment.");
      return success(state, next, `Assigned ${leftover.label} leftovers`, leftover.id, [
        "State: available to assigned",
        `Assigned slot: ${command.targetDate}/${command.slot}`,
        destination
          ? `${displacedMealTitle} was replaced with ${leftover.label} leftovers`
          : `Created a leftover dinner for ${command.targetDate}/${command.slot}`,
        ...(removedPrepCount > 0 ? [`Removed ${removedPrepCount} displaced prep reference${removedPrepCount === 1 ? "" : "s"}`] : []),
        ...(groceryProjection.removed > 0 ? [`Removed ${groceryProjection.removed} displaced grocery ingredient${groceryProjection.removed === 1 ? "" : "s"}`] : []),
      ], createdIds);
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
      const ingredientIds = new Set<string>();
      const createdIds: Record<string, string> = {};
      const meals: Meal[] = [];
      for (let mealIndex = 0; mealIndex < command.plan.meals.length; mealIndex += 1) {
        const input = command.plan.meals[mealIndex];
        const mealId = materializeId(context, "meal", mealIds);
        if (!mealId) return failure(state, "Could not materialize a unique meal ID.");
        createdIds[`meal.${mealIndex}`] = mealId;
        const materializedIngredients = materializeRecipeIngredients(context, input.ingredients, ingredientIds);
        if (!materializedIngredients) return failure(state, "Could not materialize recipe ingredient IDs.");
        const meal: Meal = {
          id: mealId,
          date: input.date,
          slot: input.slot,
          title: input.title,
          ...(input.yieldText === undefined ? {} : { yieldText: input.yieldText }),
          subtitle: input.subtitle,
          venue: input.venue,
          status: input.status ?? "planned",
          protein: input.protein,
          prepNote: input.prepNote,
          leftoverNote: input.leftoverNote,
          notes: input.notes,
          ingredients: materializedIngredients.ingredients,
          instructions: [],
        };
        for (let stepIndex = 0; stepIndex < input.instructions.length; stepIndex += 1) {
          const stepInput = input.instructions[stepIndex];
          const stepId = materializeId(context, "step", stepIds);
          if (!stepId) return failure(state, "Could not materialize a unique instruction-step ID.");
          createdIds[`step.${mealIndex}.${stepIndex}`] = stepId;
          const inputs = linkInstructionInputs(context, meal, stepInput.inputs, ingredientIds);
          if (!inputs) return failure(state, "Could not link recipe step ingredients.");
          const step: InstructionStep = { id: stepId, inputs, instruction: stepInput.instruction, complete: false };
          if (stepInput.timerDurationSeconds !== undefined) step.timerDurationSeconds = stepInput.timerDurationSeconds;
          if (stepInput.note !== undefined && stepInput.note !== "") step.note = stepInput.note;
          meal.instructions.push(step);
        }
        meals.push(meal);
      }
      const createdWeek: WeekPlan = {
        id: command.weekStartDate,
        weekStartDate: command.weekStartDate,
        status: "planned",
        data: { meals, prepSessions: [], groceries: [], leftovers: [], feedback: {}, weekLesson: command.plan.weekLesson ?? "" },
      };
      const groceryProjection = reconcileGroceryProjection(context, createdWeek);
      if (!groceryProjection) return failure(state, "Could not project groceries for the new week.");
      createdWeek.data.groceries.forEach((grocery, index) => {
        createdIds[`grocery.${index}`] = grocery.id;
      });
      next.weeks.push(createdWeek);
      next.weeks.sort((left, right) => left.id.localeCompare(right.id));
      return success(state, next, `Created week plan for ${command.weekStartDate}`, command.weekStartDate, [`Created ${meals.length} meals and ${createdWeek.data.groceries.length} grocery items`, "Lifecycle: missing to planned"], createdIds);
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
  validateCanonicalBatchBase: validateCanonicalHouseholdBatchBase,
  execute: executeHouseholdCommand,
};
