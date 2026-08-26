import {
  projectWeeklyGroceryRequirements,
  type IngredientQuantityPart,
  type WeeklyRequirementChild,
  type WeeklyRequirementOccurrence,
} from "./ingredient-quantity.ts";
import type { GroceryCoverage, GrocerySection, IngredientCatalogue, WeekPlan } from "./household-contract.ts";
import type { SourceRecipe } from "./sourced-recipe-contract.ts";

export type GroceryFilter = "to_buy" | "all" | GroceryCoverage | "done";

export type GroceryProjectionChild = WeeklyRequirementChild & {
  section: GrocerySection;
  sourceRecipe: SourceRecipe | null;
};

export type GroceryPresentationGroup = {
  key: string;
  label: string;
  conceptId: string | null;
  quantities: readonly IngredientQuantityPart[];
  provenanceCount: number;
  children: readonly GroceryProjectionChild[];
};

export type GroceryPresentationSection = {
  section: GrocerySection;
  groups: readonly GroceryPresentationGroup[];
};

export type GroceryProjection = {
  filter: GroceryFilter;
  sections: readonly GroceryPresentationSection[];
};

const SECTIONS: readonly GrocerySection[] = ["Produce", "Meat & seafood", "Dairy", "Pantry"];

export function matchesGroceryFilter(entry: { coverage: GroceryCoverage; checked: boolean }, filter: GroceryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "done") return entry.checked;
  if (filter === "to_buy") return !entry.checked && entry.coverage === "shop";
  return entry.coverage === filter;
}

export function projectGroceryRequirements(week: WeekPlan, catalogue: IngredientCatalogue, filter: GroceryFilter): GroceryProjection {
  const concepts = new Map(catalogue.concepts.map((concept) => [concept.id, concept]));
  const mealById = new Map(week.data.meals.map((meal) => [meal.id, meal]));
  const occurrences: WeeklyRequirementOccurrence[] = [];
  const childContext = new Map<string, { section: GrocerySection; sourceRecipe: SourceRecipe | null }>();
  for (const grocery of week.data.groceries) {
    if (!matchesGroceryFilter(grocery, filter)) continue;
    const meal = mealById.get(grocery.mealId);
    const ingredient = meal?.ingredients.find((candidate) => candidate.id === grocery.ingredientId);
    if (!meal || !ingredient || ingredient.role !== "weekly_requirement") continue;
    const concept = ingredient.conceptId === null ? null : concepts.get(ingredient.conceptId) ?? null;
    occurrences.push({
      occurrenceId: ingredient.id,
      mealId: meal.id,
      mealTitle: meal.title,
      ingredient: ingredient.ingredient,
      qualifier: ingredient.qualifier,
      amount: ingredient.amount,
      unit: ingredient.unit,
      source: ingredient.source,
      role: ingredient.role,
      // A household concept can share a safe quantity total only when its
      // shopping-relevant form is the same. The quantity kernel remains the
      // sole converter; this presentation key merely prevents qualifiers from
      // being silently laundered into one purchase requirement.
      concept: concept ? { id: `${concept.id}\u0000${ingredient.qualifier ?? ""}`, label: concept.preferredLabel } : null,
      execution: { id: grocery.id, section: grocery.section, coverage: grocery.coverage, checked: grocery.checked },
    });
    childContext.set(grocery.id, { section: grocery.section, sourceRecipe: meal.sourceRecipe ?? null });
  }
  const grouped = projectWeeklyGroceryRequirements(occurrences);
  const sections = new Map<GrocerySection, GroceryPresentationGroup[]>();
  for (const section of SECTIONS) sections.set(section, []);
  const enrich = (child: WeeklyRequirementChild): GroceryProjectionChild => ({
    ...child,
    ...(childContext.get(child.executionId) ?? { section: "Pantry" as GrocerySection, sourceRecipe: null }),
  });
  for (const group of grouped) {
    const section = group.section as GrocerySection;
    if (!sections.has(section)) continue;
    const children = group.children.map(enrich);
    if (group.conceptId === null) {
      const list = sections.get(section)!;
      const existing = list.find((candidate) => candidate.conceptId === null);
      if (existing) {
        (existing.children as GroceryProjectionChild[]).push(...children);
        (existing as { provenanceCount: number }).provenanceCount += children.length;
      } else list.push({ key: `unclassified:${section}`, label: "Unclassified", conceptId: null, quantities: [], provenanceCount: children.length, children: [...children] });
      continue;
    }
    sections.get(section)!.push({ key: group.key, label: group.label, conceptId: group.conceptId.split("\u0000", 1)[0], quantities: group.quantities, provenanceCount: children.length, children });
  }
  return { filter, sections: SECTIONS.map((section) => ({ section, groups: sections.get(section)! })).filter((section) => section.groups.length) };
}
