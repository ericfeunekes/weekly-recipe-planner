import {
  DEFAULT_HOUSEHOLD_TIME_ZONE,
  MEAL_SLOTS,
  MEAL_STATUSES,
  parseWeekId,
  type GroceryItem,
  type HouseholdPlannerState,
  type IngredientAmountLine,
  type InstructionStep,
  type IsoDate,
  type Leftover,
  type Meal,
  type PrepReference,
  type WeekId,
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
} from "./household-command-contract.ts";
import {
  addIsoDateDays,
  householdDomain,
  isoDateInTimeZone,
  mondayForIsoDate,
  type HouseholdCommandContext,
} from "./household-domain.ts";
import {
  LEGACY_V2_WEEK_START_DATE,
  type LegacyV2Payload,
  type LegacyV2TranscriptEntryInput,
  type LegacyV2TransformResult,
} from "./planner-api-contract.ts";
import type { PlannerChatContext } from "./planner-chat-contract.ts";

export type HouseholdBootstrapContext = HouseholdCommandContext;

export class LegacyV2ImportError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>) {
    super("The browser-v2 workspace could not be imported.");
    this.name = "LegacyV2ImportError";
    this.fieldErrors = fieldErrors;
  }
}

export class CanonicalSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalSeedError";
  }
}

class LegacyDecoder {
  readonly errors: Record<string, string> = {};

  error(path: string, message: string): void {
    this.errors[path] ??= message;
  }

  record(value: unknown, path: string): Record<string, unknown> {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    this.error(path, "Must be an object.");
    return {};
  }

  exact(
    value: Record<string, unknown>,
    path: string,
    required: string[],
    optional: string[] = [],
  ): void {
    const allowed = new Set([...required, ...optional]);
    if (
      !required.every((key) => Object.hasOwn(value, key)) ||
      !Object.keys(value).every((key) => allowed.has(key))
    ) {
      this.error(path, "Contains missing or unsupported browser-v2 fields.");
    }
  }

  array(value: unknown, path: string, maximum?: number): unknown[] {
    if (!Array.isArray(value)) {
      this.error(path, "Must be an array.");
      return [];
    }
    if (maximum !== undefined && value.length > maximum) {
      this.error(path, `Must contain at most ${maximum} entries.`);
    }
    return value;
  }

  string(
    value: unknown,
    path: string,
    maximum: number,
    { nonempty = false }: { nonempty?: boolean } = {},
  ): string {
    if (
      typeof value !== "string" ||
      value.length > maximum ||
      (nonempty && value.trim().length === 0)
    ) {
      this.error(path, `Must be ${nonempty ? "nonempty and " : ""}at most ${maximum} characters.`);
      return "";
    }
    return value;
  }

  id(value: unknown, path: string): string {
    return this.string(value, path, MAX_ID_LENGTH, { nonempty: true });
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") {
      this.error(path, "Must be a Boolean.");
      return false;
    }
    return value;
  }

  integer(
    value: unknown,
    path: string,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
      this.error(path, `Must be a whole number from ${minimum} through ${maximum}.`);
      return minimum;
    }
    return Number(value);
  }

  finish(): void {
    if (Object.keys(this.errors).length > 0) throw new LegacyV2ImportError(this.errors);
  }
}

function validateContext(context: HouseholdBootstrapContext): void {
  if (!Number.isSafeInteger(context.now) || context.now < 0) {
    throw new CanonicalSeedError("Bootstrap requires a safe nonnegative server timestamp.");
  }
  if (typeof context.createId !== "function") {
    throw new CanonicalSeedError("Bootstrap requires a server ID factory.");
  }
}

function decodeLegacyInput(
  decoder: LegacyDecoder,
  value: unknown,
  path: string,
): IngredientAmountLine {
  const record = decoder.record(value, path);
  decoder.exact(record, path, ["amount", "ingredient"]);
  return {
    amount: decoder.string(record.amount, `${path}.amount`, 300),
    ingredient: decoder.string(record.ingredient, `${path}.ingredient`, 1_000),
  };
}

function decodeLegacyStep(
  decoder: LegacyDecoder,
  value: unknown,
  path: string,
): InstructionStep {
  const record = decoder.record(value, path);
  decoder.exact(
    record,
    path,
    ["id", "inputs", "instruction", "complete"],
    ["timerDurationSeconds", "timerStartedAt", "note"],
  );
  const step: InstructionStep = {
    id: decoder.id(record.id, `${path}.id`),
    inputs: decoder
      .array(record.inputs, `${path}.inputs`, MAX_STEP_INPUTS)
      .map((input, index) => decodeLegacyInput(decoder, input, `${path}.inputs[${index}]`)),
    instruction: decoder.string(record.instruction, `${path}.instruction`, MAX_COMMAND_TEXT_LENGTH, {
      nonempty: true,
    }),
    complete: decoder.boolean(record.complete, `${path}.complete`),
  };
  if (record.timerDurationSeconds !== undefined) {
    step.timerDurationSeconds = decoder.integer(
      record.timerDurationSeconds,
      `${path}.timerDurationSeconds`,
      1,
      MAX_TIMER_DURATION_SECONDS,
    );
  }
  if (record.timerStartedAt !== undefined) {
    step.timerStartedAt = decoder.integer(record.timerStartedAt, `${path}.timerStartedAt`, 0);
  }
  if (record.note !== undefined) {
    step.note = decoder.string(record.note, `${path}.note`, MAX_COMMAND_TEXT_LENGTH);
  }
  return step;
}

function decodeLegacyMeal(
  decoder: LegacyDecoder,
  value: unknown,
  path: string,
  weekId: WeekId,
): Meal {
  const record = decoder.record(value, path);
  decoder.exact(record, path, [
    "id",
    "dayIndex",
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
  ]);
  const dayIndex = decoder.integer(record.dayIndex, `${path}.dayIndex`, 0, 6);
  if (!MEAL_STATUSES.includes(record.status as (typeof MEAL_STATUSES)[number])) {
    decoder.error(`${path}.status`, "Must be a browser-v2 meal status.");
  }
  if (!["chicken", "salmon", "none"].includes(record.protein as string)) {
    decoder.error(`${path}.protein`, "Must be a browser-v2 protein value.");
  }
  return {
    id: decoder.id(record.id, `${path}.id`),
    date: addIsoDateDays(weekId, dayIndex),
    slot: "dinner",
    title: decoder.string(record.title, `${path}.title`, 300, { nonempty: true }),
    subtitle: decoder.string(record.subtitle, `${path}.subtitle`, 1_000),
    venue: decoder.string(record.venue, `${path}.venue`, 300, { nonempty: true }),
    status: MEAL_STATUSES.includes(record.status as (typeof MEAL_STATUSES)[number])
      ? (record.status as Meal["status"])
      : "planned",
    protein: ["chicken", "salmon", "none"].includes(record.protein as string)
      ? (record.protein as Meal["protein"])
      : "none",
    prepNote: decoder.string(record.prepNote, `${path}.prepNote`, MAX_COMMAND_TEXT_LENGTH),
    leftoverNote: decoder.string(record.leftoverNote, `${path}.leftoverNote`, MAX_COMMAND_TEXT_LENGTH),
    notes: decoder.string(record.notes, `${path}.notes`, MAX_COMMAND_TEXT_LENGTH),
    ingredients: decoder
      .array(record.ingredients, `${path}.ingredients`, MAX_INGREDIENT_LINES)
      .map((ingredient, index) =>
        decoder.string(ingredient, `${path}.ingredients[${index}]`, 1_000),
      ),
    instructions: decoder
      .array(record.instructions, `${path}.instructions`, MAX_STEPS_PER_MEAL)
      .map((step, index) => decodeLegacyStep(decoder, step, `${path}.instructions[${index}]`)),
  };
}

const LEGACY_PREP_DATES = new Map<string, IsoDate>([
  ["Sun, Jul 5", "2026-07-05" as IsoDate],
  ["Mon, Jul 6", "2026-07-06" as IsoDate],
  ["Tue, Jul 7", "2026-07-07" as IsoDate],
  ["Wed, Jul 8", "2026-07-08" as IsoDate],
  ["Thu, Jul 9", "2026-07-09" as IsoDate],
  ["Fri, Jul 10", "2026-07-10" as IsoDate],
  ["Sat, Jul 11", "2026-07-11" as IsoDate],
  ["Sun, Jul 12", "2026-07-12" as IsoDate],
]);

function decodeLegacyPrep(
  decoder: LegacyDecoder,
  value: unknown,
  path: string,
): PrepReference & { legacyPosition: number; inputIndex: number } {
  const record = decoder.record(value, path);
  decoder.exact(record, path, ["id", "stepId", "due", "position"]);
  const due = decoder.string(record.due, `${path}.due`, 300, { nonempty: true });
  const prepDate = LEGACY_PREP_DATES.get(due);
  if (!prepDate) decoder.error(`${path}.due`, "Must be one of the known July 5-12 browser-v2 prep dates.");
  const inputIndex = Number(path.match(/\[(\d+)\]$/)?.[1] ?? 0);
  return {
    id: decoder.id(record.id, `${path}.id`),
    stepId: decoder.id(record.stepId, `${path}.stepId`),
    prepDate: prepDate ?? ("2026-07-05" as IsoDate),
    position: 0,
    legacyPosition: decoder.integer(record.position, `${path}.position`, 0),
    inputIndex,
  };
}

function normalizeLegacyPrep(
  prep: Array<PrepReference & { legacyPosition: number; inputIndex: number }>,
): PrepReference[] {
  const positions = new Map<IsoDate, number>();
  return [...prep]
    .sort(
      (left, right) =>
        left.prepDate.localeCompare(right.prepDate) ||
        left.legacyPosition - right.legacyPosition ||
        left.inputIndex - right.inputIndex,
    )
    .map((reference) => {
      const position = positions.get(reference.prepDate) ?? 0;
      positions.set(reference.prepDate, position + 1);
      return {
        id: reference.id,
        stepId: reference.stepId,
        prepDate: reference.prepDate,
        position,
      };
    });
}

function decodeLegacyGrocery(
  decoder: LegacyDecoder,
  value: unknown,
  path: string,
): GroceryItem {
  const record = decoder.record(value, path);
  decoder.exact(record, path, ["id", "section", "item", "detail", "checked", "farmBox"]);
  const sections: GroceryItem["section"][] = ["Produce", "Meat & seafood", "Dairy", "Pantry"];
  if (!sections.includes(record.section as GroceryItem["section"])) {
    decoder.error(`${path}.section`, "Must be a browser-v2 grocery section.");
  }
  return {
    id: decoder.id(record.id, `${path}.id`),
    section: sections.includes(record.section as GroceryItem["section"])
      ? (record.section as GroceryItem["section"])
      : "Pantry",
    item: decoder.string(record.item, `${path}.item`, 1_000, { nonempty: true }),
    detail: decoder.string(record.detail, `${path}.detail`, MAX_COMMAND_TEXT_LENGTH),
    checked: decoder.boolean(record.checked, `${path}.checked`),
    farmBox: decoder.boolean(record.farmBox, `${path}.farmBox`),
  };
}

function decodeLegacyLeftover(
  decoder: LegacyDecoder,
  value: unknown,
  path: string,
  weekId: WeekId,
): Leftover {
  const record = decoder.record(value, path);
  decoder.exact(
    record,
    path,
    ["id", "sourceMealId", "label", "portions", "state"],
    ["assignedDayIndex", "quality"],
  );
  const states: Leftover["state"][] = ["available", "assigned", "consumed"];
  if (!states.includes(record.state as Leftover["state"])) {
    decoder.error(`${path}.state`, "Must be a browser-v2 leftover state.");
  }
  const state = states.includes(record.state as Leftover["state"])
    ? (record.state as Leftover["state"])
    : "available";
  const leftover: Leftover = {
    id: decoder.id(record.id, `${path}.id`),
    sourceMealId: decoder.id(record.sourceMealId, `${path}.sourceMealId`),
    label: decoder.string(record.label, `${path}.label`, 1_000, { nonempty: true }),
    portions: decoder.integer(record.portions, `${path}.portions`, 1),
    state,
  };
  if (record.quality !== undefined) {
    if (!["good", "mixed", "poor"].includes(record.quality as string)) {
      decoder.error(`${path}.quality`, "Must be good, mixed, or poor.");
    } else {
      leftover.quality = record.quality as NonNullable<Leftover["quality"]>;
    }
  }
  if (state === "assigned") {
    if (record.assignedDayIndex === undefined) {
      decoder.error(`${path}.assignedDayIndex`, "Assigned browser-v2 leftovers require a target day.");
    }
    const dayIndex = decoder.integer(record.assignedDayIndex, `${path}.assignedDayIndex`, 0, 6);
    leftover.assignedDate = addIsoDateDays(weekId, dayIndex);
    leftover.assignedSlot = MEAL_SLOTS[0];
  } else if (record.assignedDayIndex !== undefined) {
    decoder.error(`${path}.assignedDayIndex`, "Only assigned browser-v2 leftovers may have a target day.");
  }
  return leftover;
}

function legacyContext(
  rawContext: string | null,
  weekId: WeekId,
  meals: Meal[],
): PlannerChatContext | null {
  if (!rawContext) return null;
  const meal = meals.find((candidate) => candidate.id === rawContext);
  if (meal) return { view: "week", weekId, mealId: meal.id };
  for (const candidate of meals) {
    const step = candidate.instructions.find((instruction) => instruction.id === rawContext);
    if (step) return { view: "week", weekId, mealId: candidate.id, stepId: step.id };
  }
  const normalized = rawContext.toLowerCase();
  if (normalized.startsWith("groceries")) return { view: "groceries", weekId };
  if (normalized.startsWith("prep")) return { view: "prep", weekId };
  if (normalized.startsWith("closeout")) return { view: "closeout", weekId };
  if (normalized.startsWith("week") || normalized.includes("week overview")) {
    return { view: "week", weekId };
  }
  const contextualMeal = meals.find((candidate) => normalized.includes(candidate.title.toLowerCase()));
  if (normalized.startsWith("tonight")) {
    return contextualMeal
      ? { view: "tonight", weekId, mealId: contextualMeal.id }
      : { view: "tonight", weekId };
  }
  return null;
}

function decodeLegacyTranscript(
  decoder: LegacyDecoder,
  value: unknown,
  path: string,
  weekId: WeekId,
  meals: Meal[],
): LegacyV2TranscriptEntryInput[] {
  const ids = new Set<string>();
  return decoder.array(value, path).map((message, index) => {
    const messagePath = `${path}[${index}]`;
    const record = decoder.record(message, messagePath);
    decoder.exact(record, messagePath, ["id", "role", "text"], ["context", "changes"]);
    const id = decoder.id(record.id, `${messagePath}.id`);
    if (ids.has(id)) decoder.error(`${messagePath}.id`, "Must be unique in the browser-v2 transcript.");
    ids.add(id);
    if (record.role !== "user" && record.role !== "assistant") {
      decoder.error(`${messagePath}.role`, "Must be user or assistant.");
    }
    const rawContext =
      record.context === undefined
        ? null
        : decoder.string(record.context, `${messagePath}.context`, 1_000);
    if (record.changes !== undefined) {
      decoder
        .array(record.changes, `${messagePath}.changes`)
        .forEach((change, changeIndex) => {
          decoder.string(
            change,
            `${messagePath}.changes[${changeIndex}]`,
            MAX_COMMAND_TEXT_LENGTH,
          );
        });
    }
    return {
      role: record.role === "user" ? "user" : "assistant",
      text: decoder.string(record.text, `${messagePath}.text`, 12_000, { nonempty: true }),
      context: legacyContext(rawContext, weekId, meals),
    };
  });
}

export function transformLegacyV2(
  payload: LegacyV2Payload,
  context: HouseholdBootstrapContext,
): LegacyV2TransformResult {
  validateContext(context);
  const decoder = new LegacyDecoder();
  const envelope = decoder.record(payload, "payload");
  decoder.exact(envelope, "payload", ["data", "events", "chatMessages"]);
  const data = decoder.record(envelope.data, "payload.data");
  decoder.exact(data, "payload.data", [
    "meals",
    "prep",
    "groceries",
    "leftovers",
    "farmBoxReconciled",
    "weekArchived",
    "draftReady",
    "feedback",
    "weekLesson",
  ]);
  const weekId = parseWeekId(LEGACY_V2_WEEK_START_DATE);
  const meals = decoder
    .array(data.meals, "payload.data.meals", MAX_MEALS_PER_WEEK)
    .map((meal, index) => decodeLegacyMeal(decoder, meal, `payload.data.meals[${index}]`, weekId));
  const prep = normalizeLegacyPrep(
    decoder
      .array(data.prep, "payload.data.prep", MAX_PREP_ENTRIES)
      .map((reference, index) =>
        decodeLegacyPrep(decoder, reference, `payload.data.prep[${index}]`),
      ),
  );
  const groceries = decoder
    .array(data.groceries, "payload.data.groceries", MAX_GROCERY_ITEMS)
    .map((item, index) => decodeLegacyGrocery(decoder, item, `payload.data.groceries[${index}]`));
  const leftovers = decoder
    .array(data.leftovers, "payload.data.leftovers")
    .map((leftover, index) =>
      decodeLegacyLeftover(decoder, leftover, `payload.data.leftovers[${index}]`, weekId),
    );
  const feedbackRecord = decoder.record(data.feedback, "payload.data.feedback");
  const feedback: HouseholdPlannerState["weeks"][number]["data"]["feedback"] = {};
  for (const [mealId, value] of Object.entries(feedbackRecord)) {
    if (!["repeat", "modify", "drop"].includes(value as string)) {
      decoder.error(`payload.data.feedback.${mealId}`, "Must be repeat, modify, or drop.");
      continue;
    }
    feedback[mealId] = value as (typeof feedback)[string];
  }
  const archived = decoder.boolean(data.weekArchived, "payload.data.weekArchived");
  decoder.boolean(data.draftReady, "payload.data.draftReady");
  const farmBoxReconciled = decoder.boolean(
    data.farmBoxReconciled,
    "payload.data.farmBoxReconciled",
  );
  const weekLesson = decoder.string(
    data.weekLesson,
    "payload.data.weekLesson",
    MAX_COMMAND_TEXT_LENGTH,
  );
  const events = decoder.array(envelope.events, "payload.events");
  const transcriptEntries = decodeLegacyTranscript(
    decoder,
    envelope.chatMessages,
    "payload.chatMessages",
    weekId,
    meals,
  );
  decoder.finish();

  const state: HouseholdPlannerState = {
    householdTimeZone: DEFAULT_HOUSEHOLD_TIME_ZONE,
    activeWeekId: archived ? null : weekId,
    weeks: [
      {
        id: weekId,
        weekStartDate: weekId,
        status: archived ? "archived" : "active",
        data: {
          meals,
          prep,
          groceries,
          leftovers,
          farmBoxReconciled,
          feedback,
          weekLesson,
        },
      },
    ],
  };
  const validation = householdDomain.validateState(state);
  if (!validation.ok) {
    throw new LegacyV2ImportError(
      Object.fromEntries(
        validation.issues.map((issue) => [
          `payload.canonical${issue.path === "$" ? "" : issue.path.slice(1)}`,
          issue.message,
        ]),
      ),
    );
  }
  return { state, transcriptEntries, discardedEventCount: events.length };
}

function requireExecutionState(
  label: string,
  execution: ReturnType<typeof householdDomain.execute>,
): HouseholdPlannerState {
  if (!execution.ok) {
    throw new CanonicalSeedError(`${label}: ${execution.message}`);
  }
  return execution.state;
}

export function createCanonicalSeed(
  context: HouseholdBootstrapContext,
): HouseholdPlannerState {
  validateContext(context);
  const today = isoDateInTimeZone(context.now, DEFAULT_HOUSEHOLD_TIME_ZONE);
  const weekId = mondayForIsoDate(today);
  let state: HouseholdPlannerState = {
    householdTimeZone: DEFAULT_HOUSEHOLD_TIME_ZONE,
    activeWeekId: null,
    weeks: [],
  };
  const created = householdDomain.execute(
    state,
    {
      type: "createWeekPlan",
      weekStartDate: weekId,
      plan: {
        meals: [
          {
            date: weekId,
            slot: "dinner",
            title: "Harissa chicken traybake",
            subtitle: "Peppers, chickpeas, lemon yogurt",
            venue: "Home",
            protein: "chicken",
            prepNote: "Marinate on Sunday",
            leftoverNote: "Makes 2 extra portions",
            notes: "Keep one tray mild.",
            ingredients: [
              "900 g boneless chicken thighs",
              "2 red peppers",
              "1 can chickpeas",
            ],
            instructions: [
              {
                inputs: [
                  { amount: "900 g", ingredient: "boneless chicken thighs" },
                  { amount: "3 tbsp", ingredient: "harissa paste" },
                ],
                instruction: "Coat the chicken with harissa and refrigerate.",
              },
              {
                inputs: [
                  { amount: "2", ingredient: "red peppers" },
                  { amount: "1 can", ingredient: "chickpeas" },
                ],
                instruction: "Roast the chicken, peppers, and chickpeas until cooked through.",
                timerDurationSeconds: 1_680,
              },
            ],
          },
          {
            date: addIsoDateDays(weekId, 3),
            slot: "dinner",
            title: "Miso salmon rice bowls",
            subtitle: "Snap peas, sesame, cucumber",
            venue: "Home",
            protein: "salmon",
            prepNote: "Thaw salmon and cook rice",
            leftoverNote: "Reserve 2 salmon portions",
            notes: "Keep the cucumber crisp.",
            ingredients: ["680 g salmon", "2 cups jasmine rice", "300 g snap peas"],
            instructions: [
              {
                inputs: [{ amount: "2 cups", ingredient: "jasmine rice" }],
                instruction: "Rinse the rice and cook until tender.",
                timerDurationSeconds: 1_080,
              },
              {
                inputs: [
                  { amount: "680 g", ingredient: "salmon" },
                  { amount: "3 tbsp", ingredient: "white miso" },
                ],
                instruction: "Glaze the salmon and roast until just cooked.",
                timerDurationSeconds: 600,
              },
            ],
          },
        ],
        groceries: [
          {
            section: "Meat & seafood",
            item: "Boneless chicken thighs",
            detail: "900 g",
            farmBox: false,
          },
          {
            section: "Meat & seafood",
            item: "Salmon fillet",
            detail: "680 g",
            farmBox: false,
          },
          {
            section: "Produce",
            item: "Red peppers",
            detail: "2",
            farmBox: true,
          },
          {
            section: "Pantry",
            item: "White miso",
            detail: "1 small tub",
            farmBox: false,
          },
        ],
        weekLesson: "Keep one dinner flexible and prep only the steps that save real time.",
      },
    },
    context,
  );
  state = requireExecutionState("Could not create the canonical seed week", created);
  if (!created.ok) throw new CanonicalSeedError("Could not materialize canonical seed IDs.");
  const firstStepId = created.createdIds["step.0.0"];
  const riceStepId = created.createdIds["step.1.0"];
  if (!firstStepId || !riceStepId) {
    throw new CanonicalSeedError("Canonical seed step IDs were not materialized.");
  }
  state = requireExecutionState(
    "Could not create the canonical seed prep plan",
    householdDomain.execute(
      state,
      {
        type: "setPrepPlan",
        weekId,
        entries: [
          { stepId: firstStepId, prepDate: addIsoDateDays(weekId, -1) },
          { stepId: riceStepId, prepDate: addIsoDateDays(weekId, 2) },
        ],
      },
      context,
    ),
  );
  state = requireExecutionState(
    "Could not activate the canonical seed week",
    householdDomain.execute(state, { type: "activateWeek", weekId }, context),
  );
  return state;
}
