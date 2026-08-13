import {
  INGREDIENT_ROLES,
  MEAL_STATUSES,
  type GroceryItem,
  type GroceryCoverage,
  type GrocerySection,
  type GrocerySource,
  type HouseholdPlannerState,
  type MealStatus,
} from "./household-contract.ts";
import { MAX_ID_LENGTH } from "./household-command-contract.ts";
import {
  isGroceryRequirementRole,
  matchOccurrenceByCore,
  parseLegacyIngredientLine,
} from "./ingredient-occurrence.ts";

export type HouseholdStateNormalization = {
  state: HouseholdPlannerState;
  changed: boolean;
};

export type HouseholdPayloadNormalization<T> = {
  value: T;
  changed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLegacyRecipeIngredients(meal: Record<string, unknown>): boolean {
  const issues: IngredientOccurrenceUpgradeIssue[] = [];
  const changed = upgradeMealOccurrences(meal, "$.meal", issues);
  if (issues.length > 0) {
    throw new TypeError(issues.map(({ path, message }) => `${path}: ${message}`).join("; "));
  }
  return changed;
}

function fallbackPrepDate(data: Record<string, unknown>): string | null {
  const dates = Array.isArray(data.meals)
    ? data.meals
      .filter(isRecord)
      .map((meal) => meal.date)
      .filter((date): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date))
      .sort()
    : [];
  return dates[0] ?? null;
}

/**
 * The old session model allowed labels, undated buckets, and more than one
 * session for a date. Current prep is a single queue per date. Retain every
 * usable step reference while collapsing those presentation-era distinctions.
 */
function normalizeLegacyPrepSessions(data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.prepSessions) && !Object.hasOwn(data, "prep")) return false;
  const fallbackDate = fallbackPrepDate(data);
  const candidates = Array.isArray(data.prepSessions)
    ? data.prepSessions.filter(isRecord)
    : [];
  const containsVersionedPrepEntry = candidates.some((session) =>
    Array.isArray(session.steps) && session.steps.some((entry) =>
      isRecord(entry) && Object.hasOwn(entry, "kind")
    )
  );
  // Schema-v9 combined entries are already canonical. Never pass a mixed queue
  // through the direct-reference legacy collapse: an older implementation of
  // this normalizer would otherwise erase the versioned entry shape.
  if (containsVersionedPrepEntry) return false;
  const legacyReferences = Array.isArray(data.prep) ? data.prep.filter(isRecord) : [];
  const queues: Array<{ id: string; prepDate: string; steps: Array<{ id: string; stepId: string }> }> = [];
  const queuesByDate = new Map<string, (typeof queues)[number]>();
  const usedQueueIds = new Set<string>();
  const usedEntryIds = new Set<string>();

  const queueForDate = (prepDate: string, preferredId: unknown) => {
    const existing = queuesByDate.get(prepDate);
    if (existing) return existing;
    const baseId = typeof preferredId === "string" && preferredId ? preferredId : `prep-session-${prepDate}`;
    let id = baseId;
    let suffix = 2;
    while (usedQueueIds.has(id)) id = `${baseId}-${suffix++}`;
    usedQueueIds.add(id);
    const queue = { id, prepDate, steps: [] };
    queuesByDate.set(prepDate, queue);
    queues.push(queue);
    return queue;
  };
  const append = (queue: (typeof queues)[number], entry: Record<string, unknown>) => {
    if (typeof entry.id !== "string" || !entry.id || typeof entry.stepId !== "string" || !entry.stepId) return;
    if (usedEntryIds.has(entry.id) || queue.steps.some((candidate) => candidate.stepId === entry.stepId)) return;
    usedEntryIds.add(entry.id);
    queue.steps.push({ id: entry.id, stepId: entry.stepId });
  };

  for (const session of candidates) {
    const prepDate = typeof session.prepDate === "string" ? session.prepDate : fallbackDate;
    if (!prepDate) continue;
    const queue = queueForDate(prepDate, session.id);
    if (Array.isArray(session.steps)) {
      for (const entry of session.steps) if (isRecord(entry)) append(queue, entry);
    }
  }
  for (const reference of [...legacyReferences].sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0))) {
    if (typeof reference.prepDate !== "string") continue;
    append(queueForDate(reference.prepDate, `legacy-prep-session-${reference.prepDate}`), reference);
  }

  const nextQueues = queues.filter((queue) => queue.steps.length > 0);
  const changed = JSON.stringify(data.prepSessions) !== JSON.stringify(nextQueues) || Object.hasOwn(data, "prep");
  if (changed) data.prepSessions = nextQueues;
  if (Object.hasOwn(data, "prep")) delete data.prep;
  return changed;
}

function normalizeLegacyWeekData(data: Record<string, unknown>): boolean {
  let changed = normalizeLegacyPrepSessions(data);
  if (Array.isArray(data.meals)) {
    for (const meal of data.meals) {
      if (isRecord(meal)) changed = normalizeLegacyRecipeIngredients(meal) || changed;
    }
  }
  changed = normalizeLegacyGroceryProjection(data) || changed;
  return changed;
}

function groceryKey(mealId: string, ingredientId: string): string {
  return `${mealId}\u0000${ingredientId}`;
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-CA");
}

function isGrocerySection(value: unknown): value is GrocerySection {
  return value === "Produce" || value === "Meat & seafood" || value === "Dairy" || value === "Pantry";
}

function isGrocerySource(value: unknown): value is GrocerySource {
  return value === "shop" || value === "farm_box" || value === "on_hand";
}

function inferredGrocerySection(ingredient: string): GrocerySection {
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

type IngredientOccurrence = {
  mealId: string;
  ingredientId: string;
  ingredient: string;
  amount: string;
  role: "weekly_requirement";
};

type LegacyGroceryClassification = Pick<GroceryItem, "section" | "coverage" | "checked"> & {
  id?: string;
};

function legacyGroceryClassification(
  record: Record<string, unknown>,
  occurrences: IngredientOccurrence[],
): { key: string; classification: LegacyGroceryClassification } | null {
  const coverage: GroceryCoverage = ["needs_source", "shop", "farm_box", "on_hand"].includes(String(record.coverage))
    ? record.coverage as GroceryCoverage
    : isGrocerySource(record.source)
      ? record.source
    : record.farmBox === true
      ? "farm_box"
      : record.farmBox === false
        ? "shop"
        : "needs_source";
  const classification: LegacyGroceryClassification = {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    section: isGrocerySection(record.section) ? record.section : "Pantry",
    coverage,
    checked: record.checked === true,
  };

  if (typeof record.mealId === "string" && typeof record.ingredientId === "string") {
    const occurrence = occurrences.find(
      (candidate) => candidate.mealId === record.mealId && candidate.ingredientId === record.ingredientId,
    );
    return occurrence ? { key: groceryKey(occurrence.mealId, occurrence.ingredientId), classification } : null;
  }

  const mealIds = Array.isArray(record.mealIds)
    ? record.mealIds.filter((mealId): mealId is string => typeof mealId === "string")
    : [];
  if (mealIds.length > 1) return null;
  const requestedMeals = mealIds.length === 1 ? new Set(mealIds) : null;
  const item = normalizedText(record.item);
  const detail = normalizedText(record.detail);
  if (!item || detail === null) return null;
  const candidates = occurrences.filter(
    (occurrence) =>
      (!requestedMeals || requestedMeals.has(occurrence.mealId)) &&
      normalizedText(occurrence.ingredient) === item &&
      normalizedText(occurrence.amount) === detail,
  );
  return candidates.length === 1
    ? { key: groceryKey(candidates[0].mealId, candidates[0].ingredientId), classification }
    : null;
}

/**
 * Collapse legacy free-form groceries into the current ingredient projection.
 * Only an exact, unambiguous match carries execution state forward. Detached,
 * ambiguous, or duplicate legacy rows are intentionally removed from the
 * active list; historic event command payloads remain untouched elsewhere.
 */
function normalizeLegacyGroceryProjection(data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.meals)) return false;
  const occurrences: IngredientOccurrence[] = [];
  for (const meal of data.meals) {
    if (!isRecord(meal) || typeof meal.id !== "string" || !Array.isArray(meal.ingredients)) continue;
    for (const ingredient of meal.ingredients) {
      if (!isRecord(ingredient) || typeof ingredient.id !== "string" || typeof ingredient.ingredient !== "string" || typeof ingredient.amount !== "string" || !isGroceryRequirementRole(ingredient.role)) continue;
      occurrences.push({
        mealId: meal.id,
        ingredientId: ingredient.id,
        ingredient: ingredient.ingredient,
        amount: ingredient.amount,
        role: ingredient.role,
      });
    }
  }

  const groceries = Array.isArray(data.groceries) ? data.groceries.filter(isRecord) : [];
  const classifications = new Map<string, LegacyGroceryClassification>();
  const ambiguousKeys = new Set<string>();
  for (const grocery of groceries) {
    const matched = legacyGroceryClassification(grocery, occurrences);
    if (!matched || ambiguousKeys.has(matched.key)) continue;
    if (classifications.has(matched.key)) {
      // Multiple legacy rows claiming the same canonical ingredient have no
      // authoritative execution state. Preserve neither row's classification.
      classifications.delete(matched.key);
      ambiguousKeys.add(matched.key);
      continue;
    }
    classifications.set(matched.key, matched.classification);
  }

  const usedIds = new Set<string>();
  const projected: GroceryItem[] = occurrences.map((occurrence, index) => {
    const classification = classifications.get(groceryKey(occurrence.mealId, occurrence.ingredientId));
    const preferredId = classification?.id;
    const id = preferredId && !usedIds.has(preferredId)
      ? preferredId
      : `grocery:${occurrence.mealId}:${occurrence.ingredientId}:${index}`;
    usedIds.add(id);
    return {
      id,
      mealId: occurrence.mealId,
      ingredientId: occurrence.ingredientId,
      section: classification?.section ?? inferredGrocerySection(occurrence.ingredient),
      coverage: classification?.coverage ?? "needs_source",
      checked: classification?.checked ?? false,
    };
  });
  if (JSON.stringify(data.groceries) === JSON.stringify(projected)) return false;
  data.groceries = projected;
  return true;
}

export function normalizeLegacyLeftoverSourceStatuses(
  state: HouseholdPlannerState,
): HouseholdStateNormalization {
  const next = structuredClone(state);
  let changed = false;

  if (!Array.isArray(next.weeks)) return { state, changed: false };
  for (const week of next.weeks) {
    if (!week?.data || !Array.isArray(week.data.meals) || !Array.isArray(week.data.leftovers)) {
      continue;
    }
    const sourceMealIds = new Set(
      week.data.leftovers
        .map((leftover) => leftover?.sourceMealId)
        .filter((sourceMealId): sourceMealId is string => typeof sourceMealId === "string"),
    );
    for (const meal of week.data.meals) {
      if (
        sourceMealIds.has(meal.id) &&
        MEAL_STATUSES.includes(meal.status as MealStatus) &&
        meal.status !== "cooked"
      ) {
        meal.status = "cooked";
        changed = true;
      }
    }
  }

  return changed ? { state: next, changed: true } : { state, changed: false };
}

/**
 * Converts legacy free-form groceries into ingredient-keyed execution state.
 *
 * This is intentionally idempotent: it is used while opening persisted workspaces
 * and undo snapshots, so it must never alter already-canonical grocery state.
 */
export function normalizeLegacyGrocerySources(
  state: HouseholdPlannerState,
): HouseholdStateNormalization {
  const next = structuredClone(state);
  let changed = false;

  if (!Array.isArray(next.weeks)) return { state, changed: false };
  for (const week of next.weeks) {
    if (!week?.data || typeof week.data !== "object") continue;
    const data = week.data as Record<string, unknown>;
    changed = normalizeLegacyWeekData(data) || changed;
    if (Object.hasOwn(data, "farmBoxReconciled")) {
      delete data.farmBoxReconciled;
      changed = true;
    }
  }

  return changed ? { state: next, changed: true } : { state, changed: false };
}

export function normalizeLegacyHouseholdState(
  state: HouseholdPlannerState,
): HouseholdStateNormalization {
  const groceries = normalizeLegacyGrocerySources(state);
  const leftovers = normalizeLegacyLeftoverSourceStatuses(groceries.state);
  return leftovers.changed || groceries.changed
    ? { state: leftovers.state, changed: true }
    : { state, changed: false };
}

/**
 * Upgrades every household-shaped value carried inside a persisted JSON
 * envelope. State snapshots and tool readbacks may embed grocery content at
 * several depths. Historical command records intentionally remain unchanged:
 * they are immutable audit evidence, not current command input.
 */
export function normalizeLegacyHouseholdPayload<T>(value: T): HouseholdPayloadNormalization<T> {
  const next = structuredClone(value);
  let changed = false;

  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;

    if (
      Array.isArray(candidate.meals) &&
      Array.isArray(candidate.groceries) &&
      Array.isArray(candidate.leftovers) &&
      isRecord(candidate.feedback)
    ) {
      changed = normalizeLegacyWeekData(candidate) || changed;
    }

    Object.values(candidate).forEach(visit);
  };

  visit(next);
  return changed ? { value: next, changed: true } : { value, changed: false };
}

export type IngredientOccurrenceUpgradeIssue = { path: string; message: string };
export type HouseholdStateUpgrade =
  | { ok: true; state: HouseholdPlannerState; changed: boolean }
  | { ok: false; issues: IngredientOccurrenceUpgradeIssue[] };
export type HouseholdPayloadUpgrade<T> =
  | { ok: true; value: T; changed: boolean }
  | { ok: false; issues: IngredientOccurrenceUpgradeIssue[] };

const LEGACY_GROCERY_COVERAGE = new Set(["shop", "farm_box", "on_hand"]);

function occurrenceDefaults(record: Record<string, unknown>): Record<string, unknown> {
  return {
    id: record.id,
    source: null,
    amount: record.amount,
    unit: null,
    ingredient: record.ingredient,
    qualifier: null,
    conceptId: null,
    role: "weekly_requirement",
    canonicalIngredientId: null,
  };
}

const SCHEMA_TEN_OCCURRENCE_KEYS = [
  "id",
  "source",
  "amount",
  "unit",
  "ingredient",
  "qualifier",
  "conceptId",
  "role",
  "canonicalIngredientId",
] as const;

function isBoundedText(value: unknown, maxLength: number, nonempty = false): value is string {
  return typeof value === "string" && value.length <= maxLength && (!nonempty || value.trim().length > 0);
}

function isNullableBoundedText(value: unknown): value is string | null {
  return value === null || isBoundedText(value, 1_000);
}

function isSchemaTenOccurrence(record: Record<string, unknown>): boolean {
  return (
    Object.keys(record).length === SCHEMA_TEN_OCCURRENCE_KEYS.length &&
    SCHEMA_TEN_OCCURRENCE_KEYS.every((key) => Object.hasOwn(record, key)) &&
    isBoundedText(record.id, MAX_ID_LENGTH, true) &&
    isNullableBoundedText(record.source) &&
    isBoundedText(record.amount, 300) &&
    isNullableBoundedText(record.unit) &&
    isBoundedText(record.ingredient, 1_000, true) &&
    isNullableBoundedText(record.qualifier) &&
    isNullableBoundedText(record.conceptId) &&
    INGREDIENT_ROLES.includes(record.role as (typeof INGREDIENT_ROLES)[number]) &&
    (record.canonicalIngredientId === null ||
      (Number.isSafeInteger(record.canonicalIngredientId) && Number(record.canonicalIngredientId) > 0))
  );
}

function upgradeMealOccurrences(
  meal: Record<string, unknown>,
  path: string,
  issues: IngredientOccurrenceUpgradeIssue[],
): boolean {
  if (typeof meal.id !== "string" || !Array.isArray(meal.ingredients) || !Array.isArray(meal.instructions)) {
    issues.push({ path, message: "Expected a meal with an ID, ingredient rows, and instruction steps." });
    return false;
  }
  let changed = false;
  const occurrences: Array<Record<string, unknown>> = [];
  const ids = new Set<string>();
  for (const [index, candidate] of meal.ingredients.entries()) {
    const ingredientPath = `${path}.ingredients[${index}]`;
    let occurrence: Record<string, unknown>;
    if (typeof candidate === "string") {
      const parsed = parseLegacyIngredientLine(candidate);
      occurrence = {
        id: `${meal.id}:ingredient:${index}`,
        ...parsed,
        conceptId: null,
        role: "weekly_requirement",
        canonicalIngredientId: null,
      };
      changed = true;
    } else if (
      isRecord(candidate) &&
      typeof candidate.id === "string" &&
      typeof candidate.amount === "string" &&
      typeof candidate.ingredient === "string"
    ) {
      if (isSchemaTenOccurrence(candidate)) {
        occurrence = candidate;
      } else {
        const legacyKeys = new Set(["id", "amount", "ingredient"]);
        if (Object.keys(candidate).some((key) => !legacyKeys.has(key))) {
          issues.push({
            path: ingredientPath,
            message: "Structured ingredient row has a partial or unsupported occurrence shape.",
          });
          continue;
        }
        occurrence = occurrenceDefaults(candidate);
        changed = true;
      }
    } else {
      issues.push({ path: ingredientPath, message: "Ingredient row is neither a legacy string nor a structured occurrence." });
      continue;
    }
    const id = String(occurrence.id);
    if (!id || ids.has(id)) {
      issues.push({ path: `${ingredientPath}.id`, message: "Occurrence ID is empty or duplicated within the meal." });
      continue;
    }
    ids.add(id);
    occurrences.push(occurrence);
  }

  let nextIndex = occurrences.length;
  for (const [stepIndex, stepCandidate] of meal.instructions.entries()) {
    if (!isRecord(stepCandidate) || !Array.isArray(stepCandidate.inputs)) continue;
    for (const [inputIndex, inputCandidate] of stepCandidate.inputs.entries()) {
      if (!isRecord(inputCandidate)) continue;
      const inputPath = `${path}.instructions[${stepIndex}].inputs[${inputIndex}]`;
      const explicit = typeof inputCandidate.occurrenceId === "string"
        ? inputCandidate.occurrenceId
        : typeof inputCandidate.ingredientId === "string"
          ? inputCandidate.ingredientId
          : null;
      if (explicit !== null) {
        if (!ids.has(explicit)) {
          issues.push({ path: inputPath, message: `Instruction input references missing occurrence ${explicit}.` });
          continue;
        }
        if (inputCandidate.occurrenceId !== explicit || Object.hasOwn(inputCandidate, "ingredientId")) {
          inputCandidate.occurrenceId = explicit;
          delete inputCandidate.ingredientId;
          changed = true;
        }
        continue;
      }
      if (typeof inputCandidate.amount !== "string" || typeof inputCandidate.ingredient !== "string") {
        issues.push({ path: inputPath, message: "Legacy instruction input has no usable literal or occurrence reference." });
        continue;
      }
      const match = matchOccurrenceByCore(
        inputCandidate.ingredient,
        occurrences.map((occurrence) => ({ id: String(occurrence.id), ingredient: String(occurrence.ingredient) })),
      );
      if (match.kind === "ambiguous") {
        issues.push({
          path: inputPath,
          message: `Legacy instruction input ambiguously matches ${match.occurrenceIds.length} occurrences: ${match.occurrenceIds.join(", ")}.`,
        });
        continue;
      }
      if (match.kind === "missing") {
        let id = `${meal.id}:ingredient:${nextIndex}`;
        while (ids.has(id)) id = `${meal.id}:ingredient:${++nextIndex}`;
        nextIndex += 1;
        const occurrence = {
          id,
          source: null,
          amount: inputCandidate.amount,
          unit: null,
          ingredient: inputCandidate.ingredient,
          qualifier: null,
          conceptId: null,
          role: "weekly_requirement",
          canonicalIngredientId: null,
        };
        ids.add(id);
        occurrences.push(occurrence);
      }
      inputCandidate.occurrenceId = match.kind === "unique"
        ? match.occurrenceId
        : String(occurrences[occurrences.length - 1].id);
      changed = true;
    }
  }
  if (issues.length === 0 && (changed || meal.ingredients !== occurrences)) meal.ingredients = occurrences;
  return changed;
}

function upgradeWeekOccurrences(
  week: Record<string, unknown>,
  path: string,
  issues: IngredientOccurrenceUpgradeIssue[],
): boolean {
  const data = isRecord(week.data) ? week.data : week;
  if (!Array.isArray(data.meals)) return false;
  let changed = false;
  for (const [mealIndex, meal] of data.meals.entries()) {
    if (!isRecord(meal)) {
      issues.push({ path: `${path}.meals[${mealIndex}]`, message: "Meal must be an object." });
      continue;
    }
    changed = upgradeMealOccurrences(meal, `${path}.meals[${mealIndex}]`, issues) || changed;
  }
  // Occurrence IDs must exist before grocery execution rows can be projected.
  // This is what lets a true legacy string row become one distinct grocery row
  // without using normalized text as its identity.
  changed = normalizeLegacyGroceryProjection(data) || changed;
  if (Array.isArray(data.groceries)) {
    for (const [index, grocery] of data.groceries.entries()) {
      if (!isRecord(grocery)) continue;
      const groceryPath = `${path}.groceries[${index}]`;
      if (typeof grocery.coverage === "string") {
        if (!["needs_source", "shop", "farm_box", "on_hand"].includes(grocery.coverage)) {
          issues.push({ path: `${groceryPath}.coverage`, message: "Grocery coverage is unsupported." });
        }
        if (Object.hasOwn(grocery, "source")) {
          issues.push({ path: groceryPath, message: "Grocery row contains both source and coverage." });
        }
        continue;
      }
      grocery.coverage = typeof grocery.source === "string" && LEGACY_GROCERY_COVERAGE.has(grocery.source)
        ? grocery.source
        : "needs_source";
      delete grocery.source;
      changed = true;
    }
  }
  return changed;
}

function upgradeOccurrenceStateValue(
  value: unknown,
  path: string,
  issues: IngredientOccurrenceUpgradeIssue[],
): boolean {
  if (!isRecord(value) || !Array.isArray(value.weeks)) {
    issues.push({ path, message: "Expected a household state with weeks." });
    return false;
  }
  let changed = false;
  for (const [weekIndex, week] of value.weeks.entries()) {
    if (!isRecord(week)) {
      issues.push({ path: `${path}.weeks[${weekIndex}]`, message: "Week must be an object." });
      continue;
    }
    changed = upgradeWeekOccurrences(week, `${path}.weeks[${weekIndex}].data`, issues) || changed;
  }
  return changed;
}

/** Mechanical schema-9 to schema-10 state upgrade. Never mutates the input. */
export function upgradeHouseholdStateToIngredientOccurrences(state: unknown): HouseholdStateUpgrade {
  const next = structuredClone(state);
  const issues: IngredientOccurrenceUpgradeIssue[] = [];
  const changed = upgradeOccurrenceStateValue(next, "$", issues);
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, state: next as HouseholdPlannerState, changed };
}

/** Upgrades only the closed household slots in a persisted planner tool result. */
export function upgradeHouseholdPayloadToIngredientOccurrences<T>(
  value: T,
  legacyOperationCount = 1,
): HouseholdPayloadUpgrade<T> {
  const next = structuredClone(value);
  const issues: IngredientOccurrenceUpgradeIssue[] = [];
  let changed = false;
  const upgradeReadback = (candidate: unknown, path: string): void => {
    if (!isRecord(candidate)) return;
    if (candidate.kind === "week" && isRecord(candidate.week)) {
      changed = upgradeWeekOccurrences(candidate.week, `${path}.week`, issues) || changed;
    } else if (candidate.kind === "meal" && isRecord(candidate.meal)) {
      changed = upgradeMealOccurrences(candidate.meal, `${path}.meal`, issues) || changed;
    }
  };
  if (
    isRecord(next) && next.schemaVersion === 1 && next.ok === true &&
    typeof next.callId === "string" && isRecord(next.data)
  ) {
    const data = next.data;
    if (
      (data.status === "accepted" || data.status === "replayed") &&
      typeof data.eventId === "string" && isRecord(data.readback) &&
      !Object.hasOwn(data, "occurrenceResults")
    ) {
      data.occurrenceResults = Array.from(
        { length: legacyOperationCount },
        (_, operationIndex) => ({ operationIndex, occurrences: [] }),
      );
      changed = true;
    }
    if (data.status === "previewed" && Array.isArray(data.outcomes)) {
      for (const outcome of data.outcomes) {
        if (isRecord(outcome) && !Object.hasOwn(outcome, "occurrences")) {
          outcome.occurrences = [];
          changed = true;
        }
      }
    }
    if (isRecord(data.readback)) upgradeReadback(data.readback, "$.data.readback");
    else upgradeReadback(data, "$.data");
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: next, changed };
}
