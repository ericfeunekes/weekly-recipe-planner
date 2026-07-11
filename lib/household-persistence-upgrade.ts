import {
  MEAL_STATUSES,
  type HouseholdPlannerState,
  type MealStatus,
} from "./household-contract.ts";

export type HouseholdStateNormalization = {
  state: HouseholdPlannerState;
  changed: boolean;
};

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
