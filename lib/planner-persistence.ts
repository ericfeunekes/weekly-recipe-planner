import type {
  GroceryItem,
  InstructionStep,
  Leftover,
  Meal,
  PlannerData,
  PrepReference,
  StepInput,
} from "./planner-domain";

type LegacyPrepTask = {
  id: string;
  due: string;
  complete: boolean;
};

const MEAL_STATUSES = new Set<Meal["status"]>([
  "planned",
  "moved",
  "cooking",
  "cooked",
  "leftover",
  "flex",
]);
const PROTEINS = new Set<Meal["protein"]>(["chicken", "salmon", "none"]);
const GROCERY_SECTIONS = new Set<GroceryItem["section"]>([
  "Produce",
  "Meat & seafood",
  "Dairy",
  "Pantry",
]);
const LEFTOVER_STATES = new Set<Leftover["state"]>([
  "available",
  "assigned",
  "consumed",
]);
const LEFTOVER_QUALITIES = new Set<NonNullable<Leftover["quality"]>>([
  "good",
  "mixed",
  "poor",
]);
const FEEDBACK_VALUES = new Set<PlannerData["feedback"][string]>([
  "repeat",
  "modify",
  "drop",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(
  value: unknown,
  maxLength: number,
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isId(value: unknown): value is string {
  return isBoundedString(value, 200, { allowEmpty: false });
}

function isDayIndex(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

function cloneStepInput(input: StepInput): StepInput {
  return { amount: input.amount, ingredient: input.ingredient };
}

function cloneInstructionStep(step: InstructionStep): InstructionStep {
  const cloned: InstructionStep = {
    id: step.id,
    inputs: step.inputs.map(cloneStepInput),
    instruction: step.instruction,
    complete: step.complete,
  };
  if (step.timerDurationSeconds !== undefined) {
    cloned.timerDurationSeconds = step.timerDurationSeconds;
  }
  if (step.timerStartedAt !== undefined) cloned.timerStartedAt = step.timerStartedAt;
  if (step.note !== undefined) cloned.note = step.note;
  return cloned;
}

function decodeStepInput(value: unknown): StepInput | null {
  if (
    !isRecord(value) ||
    !isBoundedString(value.amount, 300) ||
    !isBoundedString(value.ingredient, 1_000)
  ) {
    return null;
  }
  return { amount: value.amount, ingredient: value.ingredient };
}

function decodeInstructionStep(value: unknown): InstructionStep | null {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !Array.isArray(value.inputs) ||
    !isBoundedString(value.instruction, 4_000) ||
    typeof value.complete !== "boolean"
  ) {
    return null;
  }

  const inputs = value.inputs.map(decodeStepInput);
  if (inputs.some((input) => input === null)) return null;
  if (
    value.timerDurationSeconds !== undefined &&
    (!Number.isFinite(value.timerDurationSeconds) ||
      Number(value.timerDurationSeconds) <= 0)
  ) {
    return null;
  }
  if (
    value.timerStartedAt !== undefined &&
    (!Number.isSafeInteger(value.timerStartedAt) || Number(value.timerStartedAt) < 0)
  ) {
    return null;
  }
  if (value.note !== undefined && !isBoundedString(value.note, 4_000)) return null;

  const step: InstructionStep = {
    id: value.id,
    inputs: inputs as StepInput[],
    instruction: value.instruction,
    complete: value.complete,
  };
  if (value.timerDurationSeconds !== undefined) {
    step.timerDurationSeconds = Number(value.timerDurationSeconds);
  }
  if (value.timerStartedAt !== undefined) {
    step.timerStartedAt = Number(value.timerStartedAt);
  }
  if (value.note !== undefined) step.note = value.note;
  return step;
}

function decodeInstructionSteps(
  value: unknown,
  fallback: InstructionStep[],
): InstructionStep[] {
  if (!Array.isArray(value)) return fallback.map(cloneInstructionStep);
  const decoded = value.map(decodeInstructionStep);
  if (decoded.some((step) => step === null)) return fallback.map(cloneInstructionStep);
  const steps = decoded as InstructionStep[];
  if (new Set(steps.map((step) => step.id)).size !== steps.length) {
    return fallback.map(cloneInstructionStep);
  }
  return steps;
}

function cloneMeal(meal: Meal): Meal {
  return {
    id: meal.id,
    dayIndex: meal.dayIndex,
    title: meal.title,
    subtitle: meal.subtitle,
    venue: meal.venue,
    status: meal.status,
    protein: meal.protein,
    prepNote: meal.prepNote,
    leftoverNote: meal.leftoverNote,
    notes: meal.notes,
    ingredients: [...meal.ingredients],
    instructions: meal.instructions.map(cloneInstructionStep),
  };
}

function readString(
  value: unknown,
  fallback: string,
  maxLength: number,
  allowEmpty = true,
): string {
  return isBoundedString(value, maxLength, { allowEmpty }) ? value : fallback;
}

function decodeMeal(value: Record<string, unknown>, seeded: Meal): Meal {
  const ingredients =
    Array.isArray(value.ingredients) &&
    value.ingredients.every((ingredient) => isBoundedString(ingredient, 1_000))
      ? [...value.ingredients]
      : [...seeded.ingredients];
  return {
    id: seeded.id,
    dayIndex: isDayIndex(value.dayIndex) ? value.dayIndex : seeded.dayIndex,
    title: readString(value.title, seeded.title, 300, false),
    subtitle: readString(value.subtitle, seeded.subtitle, 1_000),
    venue: readString(value.venue, seeded.venue, 300, false),
    status: MEAL_STATUSES.has(value.status as Meal["status"])
      ? (value.status as Meal["status"])
      : seeded.status,
    protein: PROTEINS.has(value.protein as Meal["protein"])
      ? (value.protein as Meal["protein"])
      : seeded.protein,
    prepNote: readString(value.prepNote, seeded.prepNote, 4_000),
    leftoverNote: readString(value.leftoverNote, seeded.leftoverNote, 4_000),
    notes: readString(value.notes, seeded.notes, 4_000),
    ingredients,
    instructions: decodeInstructionSteps(value.instructions, seeded.instructions),
  };
}

function decodeMeals(value: unknown, seeded: Meal[]): Meal[] {
  const fallback = seeded.map(cloneMeal);
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    !value.every((meal) => isRecord(meal) && isId(meal.id))
  ) {
    return fallback;
  }
  const storedById = new Map<string, Record<string, unknown>>();
  for (const meal of value as Array<Record<string, unknown> & { id: string }>) {
    if (storedById.has(meal.id)) return fallback;
    storedById.set(meal.id, meal);
  }
  return seeded.map((seedMeal) => {
    const stored = storedById.get(seedMeal.id);
    return stored ? decodeMeal(stored, seedMeal) : cloneMeal(seedMeal);
  });
}

function decodePrepReference(value: unknown): PrepReference | null {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.stepId) ||
    !isBoundedString(value.due, 300, { allowEmpty: false }) ||
    !Number.isInteger(value.position) ||
    Number(value.position) < 0
  ) {
    return null;
  }
  return {
    id: value.id,
    stepId: value.stepId,
    due: value.due,
    position: Number(value.position),
  };
}

function isLegacyPrepTask(value: unknown): value is LegacyPrepTask {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isBoundedString(value.due, 300, { allowEmpty: false }) &&
    typeof value.complete === "boolean"
  );
}

function clonePrepReference(reference: PrepReference): PrepReference {
  return {
    id: reference.id,
    stepId: reference.stepId,
    due: reference.due,
    position: reference.position,
  };
}

function decodePrep(
  value: unknown,
  seeded: PrepReference[],
  meals: Meal[],
): { meals: Meal[]; prep: PrepReference[] } {
  if (!Array.isArray(value)) {
    return { meals, prep: seeded.map(clonePrepReference) };
  }
  if (value.every(isLegacyPrepTask)) {
    const legacyById = new Map(value.map((task) => [task.id, task]));
    const prep = seeded.map((reference) => ({
      ...clonePrepReference(reference),
      due: legacyById.get(reference.id)?.due ?? reference.due,
    }));
    const completionByStepId = new Map(
      prep.flatMap((reference) => {
        const complete = legacyById.get(reference.id)?.complete;
        return complete === undefined ? [] : [[reference.stepId, complete] as const];
      }),
    );
    return {
      meals: meals.map((meal) => ({
        ...cloneMeal(meal),
        instructions: meal.instructions.map((step) => {
          const complete = completionByStepId.get(step.id);
          return complete === undefined
            ? cloneInstructionStep(step)
            : { ...cloneInstructionStep(step), complete };
        }),
      })),
      prep,
    };
  }

  const decoded = value.map(decodePrepReference);
  if (decoded.some((reference) => reference === null)) {
    return { meals, prep: seeded.map(clonePrepReference) };
  }
  const availableStepIds = new Set(
    meals.flatMap((meal) => meal.instructions.map((step) => step.id)),
  );
  const referencedStepIds = new Set<string>();
  const referenceIds = new Set<string>();
  const prep = (decoded as PrepReference[])
    .sort((left, right) => left.position - right.position)
    .filter((reference) => {
      if (
        !availableStepIds.has(reference.stepId) ||
        referencedStepIds.has(reference.stepId) ||
        referenceIds.has(reference.id)
      ) {
        return false;
      }
      referencedStepIds.add(reference.stepId);
      referenceIds.add(reference.id);
      return true;
    })
    .map((reference, position) => ({ ...reference, position }));
  return { meals, prep };
}

function decodeGroceryItem(value: unknown): GroceryItem | null {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !GROCERY_SECTIONS.has(value.section as GroceryItem["section"]) ||
    !isBoundedString(value.item, 1_000, { allowEmpty: false }) ||
    !isBoundedString(value.detail, 4_000) ||
    typeof value.checked !== "boolean" ||
    typeof value.farmBox !== "boolean"
  ) {
    return null;
  }
  return {
    id: value.id,
    section: value.section as GroceryItem["section"],
    item: value.item,
    detail: value.detail,
    checked: value.checked,
    farmBox: value.farmBox,
  };
}

function cloneGroceryItem(item: GroceryItem): GroceryItem {
  return {
    id: item.id,
    section: item.section,
    item: item.item,
    detail: item.detail,
    checked: item.checked,
    farmBox: item.farmBox,
  };
}

function decodeGroceries(value: unknown, seeded: GroceryItem[]): GroceryItem[] {
  const fallback = seeded.map(cloneGroceryItem);
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return fallback;
  const decoded = value.map(decodeGroceryItem);
  if (decoded.some((item) => item === null)) return fallback;
  const groceries = decoded as GroceryItem[];
  if (new Set(groceries.map((item) => item.id)).size !== groceries.length) return fallback;
  return groceries;
}

function readLegacyLeftoverAssignments(
  value: unknown,
  meals: Meal[],
): Map<string, number> {
  if (!Array.isArray(value)) return new Map();

  const dayByMealId = new Map(meals.map((meal) => [meal.id, meal.dayIndex]));
  const assignments = new Map<string, number | null>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !isId(candidate.id) || !isId(candidate.leftoverId)) {
      continue;
    }
    const dayIndex = dayByMealId.get(candidate.id);
    if (dayIndex === undefined) continue;
    const existing = assignments.get(candidate.leftoverId);
    assignments.set(
      candidate.leftoverId,
      existing === undefined || existing === dayIndex ? dayIndex : null,
    );
  }

  return new Map(
    [...assignments].flatMap(([leftoverId, dayIndex]) =>
      dayIndex === null ? [] : [[leftoverId, dayIndex]],
    ),
  );
}

function decodeLeftover(
  value: unknown,
  mealIds: Set<string>,
  legacyAssignments: Map<string, number>,
): Leftover | null {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.sourceMealId) ||
    !mealIds.has(value.sourceMealId) ||
    !isBoundedString(value.label, 1_000, { allowEmpty: false }) ||
    !Number.isInteger(value.portions) ||
    Number(value.portions) <= 0 ||
    !LEFTOVER_STATES.has(value.state as Leftover["state"])
  ) {
    return null;
  }
  if (value.assignedDayIndex !== undefined && !isDayIndex(value.assignedDayIndex)) return null;
  const assignedDayIndex =
    value.assignedDayIndex === undefined
      ? legacyAssignments.get(value.id)
      : Number(value.assignedDayIndex);
  if (value.state === "assigned" && assignedDayIndex === undefined) return null;
  if (
    value.quality !== undefined &&
    !LEFTOVER_QUALITIES.has(value.quality as NonNullable<Leftover["quality"]>)
  ) {
    return null;
  }

  const leftover: Leftover = {
    id: value.id,
    sourceMealId: value.sourceMealId,
    label: value.label,
    portions: Number(value.portions),
    state: value.state as Leftover["state"],
  };
  if (assignedDayIndex !== undefined) leftover.assignedDayIndex = assignedDayIndex;
  if (value.quality !== undefined) {
    leftover.quality = value.quality as NonNullable<Leftover["quality"]>;
  }
  return leftover;
}

function cloneLeftover(leftover: Leftover): Leftover {
  const cloned: Leftover = {
    id: leftover.id,
    sourceMealId: leftover.sourceMealId,
    label: leftover.label,
    portions: leftover.portions,
    state: leftover.state,
  };
  if (leftover.assignedDayIndex !== undefined) {
    cloned.assignedDayIndex = leftover.assignedDayIndex;
  }
  if (leftover.quality !== undefined) cloned.quality = leftover.quality;
  return cloned;
}

function decodeLeftovers(
  value: unknown,
  seeded: Leftover[],
  mealIds: Set<string>,
  legacyAssignments: Map<string, number>,
): Leftover[] {
  const fallback = seeded.map(cloneLeftover);
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) return fallback;
  const decoded = value.map((leftover) =>
    decodeLeftover(leftover, mealIds, legacyAssignments),
  );
  if (decoded.some((leftover) => leftover === null)) return fallback;
  const leftovers = decoded as Leftover[];
  if (new Set(leftovers.map((leftover) => leftover.id)).size !== leftovers.length) {
    return fallback;
  }
  return leftovers;
}

function decodeFeedback(
  value: unknown,
  seeded: PlannerData["feedback"],
  mealIds: Set<string>,
): PlannerData["feedback"] {
  const fallback = { ...seeded };
  if (value === undefined) return fallback;
  if (!isRecord(value)) return fallback;
  const entries = Object.entries(value);
  if (
    entries.some(
      ([mealId, feedback]) =>
        !isId(mealId) ||
        !mealIds.has(mealId) ||
        !FEEDBACK_VALUES.has(feedback as PlannerData["feedback"][string]),
    )
  ) {
    return fallback;
  }
  return Object.fromEntries(entries) as PlannerData["feedback"];
}

export function migrateStoredPlannerData(
  value: unknown,
  seeded: PlannerData,
): PlannerData {
  if (!isRecord(value)) {
    const meals = seeded.meals.map(cloneMeal);
    const mealIds = new Set(meals.map((meal) => meal.id));
    return {
      meals,
      prep: seeded.prep.map(clonePrepReference),
      groceries: seeded.groceries.map(cloneGroceryItem),
      leftovers: seeded.leftovers
        .map(cloneLeftover)
        .filter((leftover) => mealIds.has(leftover.sourceMealId)),
      farmBoxReconciled: seeded.farmBoxReconciled,
      weekArchived: seeded.weekArchived,
      draftReady: seeded.draftReady,
      feedback: { ...seeded.feedback },
      weekLesson: seeded.weekLesson,
    };
  }

  let meals = decodeMeals(value.meals, seeded.meals);
  const prepResult = decodePrep(value.prep, seeded.prep, meals);
  meals = prepResult.meals;
  const mealIds = new Set(meals.map((meal) => meal.id));
  const legacyLeftoverAssignments = readLegacyLeftoverAssignments(value.meals, meals);

  return {
    meals,
    prep: prepResult.prep,
    groceries: decodeGroceries(value.groceries, seeded.groceries),
    leftovers: decodeLeftovers(
      value.leftovers,
      seeded.leftovers,
      mealIds,
      legacyLeftoverAssignments,
    ),
    farmBoxReconciled:
      typeof value.farmBoxReconciled === "boolean"
        ? value.farmBoxReconciled
        : seeded.farmBoxReconciled,
    weekArchived:
      typeof value.weekArchived === "boolean" ? value.weekArchived : seeded.weekArchived,
    draftReady: typeof value.draftReady === "boolean" ? value.draftReady : seeded.draftReady,
    feedback: decodeFeedback(value.feedback, seeded.feedback, mealIds),
    weekLesson: isBoundedString(value.weekLesson, 4_000)
      ? value.weekLesson
      : seeded.weekLesson,
  };
}
