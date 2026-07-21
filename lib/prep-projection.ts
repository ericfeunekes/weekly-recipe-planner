import type {
  HouseholdPlannerState,
  InstructionStep,
  Meal,
  PrepSessionCombinedStep,
  RecipeIngredient,
  WeekPlan,
} from "./household-contract.ts";
import { isPrepSessionCombinedStep } from "./household-contract.ts";
import { sumIngredientQuantities, type IngredientQuantitySum } from "./ingredient-quantity.ts";

export type PrepProjectionIssue = {
  code: "missing-step" | "missing-ingredient" | "missing-input" | "duplicate-source-step";
  stepId: string;
  ingredientId?: string;
};

export type PrepIngredientOccurrence = {
  mealId: string;
  mealTitle: string;
  stepId: string;
  ingredientId: string;
  amount: string;
  ingredient: string;
};

export type PrepSourceProvenance = {
  stepId: string;
  mealId: string;
  mealTitle: string;
  instruction: string;
  ingredients: PrepIngredientOccurrence[];
};

export type PrepIngredientAggregate = {
  key: string;
  ingredient: string;
  occurrences: PrepIngredientOccurrence[];
  quantity: IngredientQuantitySum;
  display: string;
};

export type CombinedPrepProjection = {
  entryId: string | null;
  instruction: string | null;
  complete: boolean;
  needsReview: boolean;
  sources: PrepSourceProvenance[];
  aggregates: PrepIngredientAggregate[];
  invalidLineage: PrepProjectionIssue[];
};

type StepLocation = { meal: Meal; step: InstructionStep };
type Source = { stepId: string; ingredientIds: string[] };

function exactLiteralKey(ingredient: string): string {
  return ingredient.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-CA");
}

function allStepLocations(week: WeekPlan | undefined): Map<string, StepLocation> {
  const locations = new Map<string, StepLocation>();
  if (week) {
    for (const meal of week.data.meals) {
      for (const step of meal.instructions) locations.set(step.id, { meal, step });
    }
  }
  return locations;
}

function resolveIngredient(meal: Meal, step: InstructionStep, ingredientId: string): RecipeIngredient | null {
  if (!step.inputs.some((input) => input.ingredientId === ingredientId)) return null;
  return meal.ingredients.find((ingredient) => ingredient.id === ingredientId) ?? null;
}

function aggregateOccurrences(occurrences: PrepIngredientOccurrence[]): PrepIngredientAggregate[] {
  const groups = new Map<string, PrepIngredientOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = exactLiteralKey(occurrence.ingredient);
    const group = groups.get(key);
    if (group) group.push(occurrence);
    else groups.set(key, [occurrence]);
  }
  return [...groups.entries()].map(([key, grouped]) => {
    const quantity = sumIngredientQuantities(grouped.map((occurrence) => occurrence.amount));
    return {
      key: `literal:${key}`,
      ingredient: grouped[0].ingredient,
      occurrences: grouped,
      quantity,
      display: quantity.ok
        ? `${quantity.display} ${grouped[0].ingredient}`
        : grouped.map((occurrence) => [occurrence.amount, occurrence.ingredient].filter(Boolean).join(" ")).join("; "),
    };
  });
}

function projectSources(week: WeekPlan | undefined, sources: readonly Source[]): Pick<CombinedPrepProjection, "sources" | "aggregates" | "invalidLineage"> {
  const locations = allStepLocations(week);
  const invalidLineage: PrepProjectionIssue[] = [];
  const provenance: PrepSourceProvenance[] = [];
  const allOccurrences: PrepIngredientOccurrence[] = [];
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.stepId)) {
      invalidLineage.push({ code: "duplicate-source-step", stepId: source.stepId });
      continue;
    }
    sourceIds.add(source.stepId);
    const location = locations.get(source.stepId);
    if (!location) {
      invalidLineage.push({ code: "missing-step", stepId: source.stepId });
      continue;
    }
    const ingredients: PrepIngredientOccurrence[] = [];
    for (const ingredientId of source.ingredientIds) {
      const ingredient = resolveIngredient(location.meal, location.step, ingredientId);
      if (!ingredient) {
        invalidLineage.push({
          code: location.meal.ingredients.some((candidate) => candidate.id === ingredientId) ? "missing-input" : "missing-ingredient",
          stepId: source.stepId,
          ingredientId,
        });
        continue;
      }
      const occurrence = {
        mealId: location.meal.id,
        mealTitle: location.meal.title,
        stepId: source.stepId,
        ingredientId,
        amount: ingredient.amount,
        ingredient: ingredient.ingredient,
      };
      ingredients.push(occurrence);
      allOccurrences.push(occurrence);
    }
    provenance.push({
      stepId: source.stepId,
      mealId: location.meal.id,
      mealTitle: location.meal.title,
      instruction: location.step.instruction,
      ingredients,
    });
  }
  return { sources: provenance, aggregates: aggregateOccurrences(allOccurrences), invalidLineage };
}

export function projectCombinedPrepEntry(
  state: HouseholdPlannerState,
  entry: PrepSessionCombinedStep,
): CombinedPrepProjection {
  const week = state.weeks.find((candidate) => candidate.data.prepSessions.some((session) =>
    session.steps.some((candidateEntry) => candidateEntry === entry)
  )) ?? state.weeks.find((candidate) => candidate.id === state.activeWeekId);
  return {
    entryId: entry.id,
    instruction: entry.instruction,
    complete: entry.complete,
    needsReview: entry.needsReview,
    ...projectSources(week, entry.sources),
  };
}

/** A local read model for preview only; command validation remains authoritative. */
export function projectCombinedPrepDraft(
  state: HouseholdPlannerState,
  sourceStepIds: readonly string[],
): CombinedPrepProjection {
  const week = state.weeks.find((candidate) => candidate.id === state.activeWeekId);
  const locations = allStepLocations(week);
  const sources: Source[] = sourceStepIds.map((stepId) => ({
    stepId,
    ingredientIds: [...new Set(locations.get(stepId)?.step.inputs.map((input) => input.ingredientId) ?? [])],
  }));
  return {
    entryId: null,
    instruction: null,
    complete: false,
    needsReview: false,
    ...projectSources(week, sources),
  };
}

/** Canonical step IDs eligible for the derived, non-mutating Prepared in batch badge. */
export function preparedInBatchStepIds(state: HouseholdPlannerState): ReadonlySet<string> {
  const prepared = new Set<string>();
  for (const week of state.weeks) {
    for (const session of week.data.prepSessions) {
      for (const entry of session.steps) {
        if (isPrepSessionCombinedStep(entry) && entry.complete && !entry.needsReview) {
          for (const source of entry.sources) prepared.add(source.stepId);
        }
      }
    }
  }
  return prepared;
}
