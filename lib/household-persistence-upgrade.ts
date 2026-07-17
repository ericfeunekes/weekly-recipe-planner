import {
  MEAL_STATUSES,
  type GroceryItem,
  type GrocerySection,
  type GrocerySource,
  type HouseholdPlannerState,
  type MealStatus,
} from "./household-contract.ts";

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

function ingredientKey(ingredient: string): string {
  return ingredient.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-CA");
}

function ingredientLineParts(line: string): { amount: string; ingredient: string } {
  const trimmed = line.trim();
  const match = /^((?:\d+\s+)?(?:\d+(?:[./]\d+)?|[¼½¾⅓⅔]))(?:\s+(cups?|tbsp|tsp|ml|l|g|kg|lb|lbs|oz|cans?|cloves?|bunch(?:es)?|pinches?|packages?|pkgs?|sprigs?|heads?|slices?))?\s+(.+)$/i.exec(trimmed);
  if (!match) return { amount: "", ingredient: trimmed };
  return { amount: [match[1], match[2]].filter(Boolean).join(" "), ingredient: match[3].trim() };
}

function normalizeLegacyRecipeIngredients(meal: Record<string, unknown>): boolean {
  if (typeof meal.id !== "string" || !Array.isArray(meal.instructions)) return false;
  let changed = false;
  const ingredients = Array.isArray(meal.ingredients) ? meal.ingredients : [];
  const canonical = ingredients.every((ingredient) =>
    isRecord(ingredient) &&
    typeof ingredient.id === "string" &&
    typeof ingredient.amount === "string" &&
    typeof ingredient.ingredient === "string",
  );
  const records: Array<{ id: string; amount: string; ingredient: string }> = [];
  const mergedIngredientIds = new Map<string, string>();
  if (canonical) {
    for (const ingredient of ingredients as Array<Record<string, string>>) {
      const parsed = ingredientLineParts([ingredient.amount, ingredient.ingredient].filter(Boolean).join(" "));
      const existing = records.find((candidate) => ingredientKey(candidate.ingredient) === ingredientKey(parsed.ingredient));
      if (existing) {
        mergedIngredientIds.set(ingredient.id, existing.id);
        changed = true;
        continue;
      }
      records.push({ id: ingredient.id, ...parsed });
      if (parsed.amount !== ingredient.amount || parsed.ingredient !== ingredient.ingredient) changed = true;
    }
    if (changed) meal.ingredients = records;
  }
  if (!canonical) {
    let nextIndex = 0;
    for (const line of ingredients) {
      if (typeof line !== "string") continue;
      const parsed = ingredientLineParts(line);
      if (!parsed.ingredient || records.some((ingredient) => ingredientKey(ingredient.ingredient) === ingredientKey(parsed.ingredient))) continue;
      records.push({ id: `${meal.id}:ingredient:${nextIndex}`, ...parsed });
      nextIndex += 1;
    }
    meal.ingredients = records;
    changed = true;
  }
  let nextIndex = records.length;
  const resolveIngredient = (amount: string, ingredient: string) => {
    let record = records.find((candidate) => ingredientKey(candidate.ingredient) === ingredientKey(ingredient));
    if (!record) {
      record = { id: `${meal.id}:ingredient:${nextIndex}`, amount, ingredient };
      nextIndex += 1;
      records.push(record);
      meal.ingredients = records;
      changed = true;
    }
    return record.id;
  };
  for (const step of meal.instructions) {
    if (!isRecord(step) || !Array.isArray(step.inputs)) continue;
    for (const input of step.inputs) {
      if (!isRecord(input) || typeof input.amount !== "string" || typeof input.ingredient !== "string") continue;
      const linkedIngredientId = typeof input.ingredientId === "string"
        ? mergedIngredientIds.get(input.ingredientId) ?? input.ingredientId
        : undefined;
      const canonicalIngredientId = linkedIngredientId && records.some((record) => record.id === linkedIngredientId)
        ? linkedIngredientId
        : resolveIngredient(input.amount, input.ingredient);
      if (input.ingredientId !== canonicalIngredientId) {
        input.ingredientId = canonicalIngredientId;
        changed = true;
      }
    }
  }
  return changed;
}

function normalizeLegacyPrepSessions(data: Record<string, unknown>): boolean {
  if (Array.isArray(data.prepSessions)) {
    if (!Object.hasOwn(data, "prep")) return false;
    delete data.prep;
    return true;
  }
  const references = Array.isArray(data.prep) ? data.prep.filter(isRecord) : [];
  const sessions: Array<{ id: string; label: string; prepDate: string; steps: Array<{ id: string; stepId: string }> }> = [];
  for (const reference of [...references].sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0))) {
    if (typeof reference.id !== "string" || typeof reference.stepId !== "string" || typeof reference.prepDate !== "string") continue;
    let session = sessions.find((candidate) => candidate.prepDate === reference.prepDate);
    if (!session) {
      session = { id: `legacy-prep-session-${reference.prepDate}`, label: `Prep ${reference.prepDate}`, prepDate: reference.prepDate, steps: [] };
      sessions.push(session);
    }
    session.steps.push({ id: reference.id, stepId: reference.stepId });
  }
  data.prepSessions = sessions;
  delete data.prep;
  return true;
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
};

type LegacyGroceryClassification = Pick<GroceryItem, "section" | "source" | "checked"> & {
  id?: string;
};

function legacyGroceryClassification(
  record: Record<string, unknown>,
  occurrences: IngredientOccurrence[],
): { key: string; classification: LegacyGroceryClassification } | null {
  const source = isGrocerySource(record.source)
    ? record.source
    : record.farmBox === true
      ? "farm_box"
      : record.farmBox === false
        ? "shop"
        : "shop";
  const classification: LegacyGroceryClassification = {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    section: isGrocerySection(record.section) ? record.section : "Pantry",
    source,
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
      if (!isRecord(ingredient) || typeof ingredient.id !== "string" || typeof ingredient.ingredient !== "string" || typeof ingredient.amount !== "string") continue;
      occurrences.push({
        mealId: meal.id,
        ingredientId: ingredient.id,
        ingredient: ingredient.ingredient,
        amount: ingredient.amount,
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
      source: classification?.source ?? "shop",
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
