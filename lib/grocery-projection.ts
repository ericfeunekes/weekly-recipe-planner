import {
  projectWeeklyGroceryRequirements,
  type IngredientQuantityPart,
  type WeeklyRequirementChild,
  type WeeklyRequirementOccurrence,
} from "./ingredient-quantity.ts";
import type { GroceryCoverage, GrocerySection, IngredientCatalogue, WeekPlan } from "./household-contract.ts";

export type GroceryFilter = "to_buy" | "all" | GroceryCoverage | "done";

export type GroceryProjectionChild = WeeklyRequirementChild & {
  section: GrocerySection;
  sourceRecipe: { kind: string; identity: string; revision: string | null } | null;
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

export type PagedGroceryProjection = GroceryProjection & {
  offset: number;
  nextOffset: number | null;
};

export const GROCERY_READ_PAGE_SIZE = 8;

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
  const childContext = new Map<string, { section: GrocerySection; sourceRecipe: GroceryProjectionChild["sourceRecipe"] }>();
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
      concept: concept ? { id: concept.id, label: concept.preferredLabel } : null,
      execution: { id: grocery.id, section: grocery.section, coverage: grocery.coverage, checked: grocery.checked },
    });
    childContext.set(grocery.id, { section: grocery.section, sourceRecipe: meal.sourceRecipe ? { kind: meal.sourceRecipe.kind, identity: meal.sourceRecipe.identity, revision: meal.sourceRecipe.kind === "canonical" ? meal.sourceRecipe.revision : null } : null });
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
    const qualifiers = new Set(children.map((child) => child.qualifier ?? ""));
    const quantities = qualifiers.size > 1
      ? [...new Map(children.map((child) => [child.qualifier ?? "", child])).keys()].flatMap((qualifier) => {
          const subset = children.filter((child) => (child.qualifier ?? "") === qualifier);
          const subtotal = projectWeeklyGroceryRequirements(subset.map((child) => ({
            occurrenceId: child.occurrenceId,
            mealId: child.mealId,
            mealTitle: child.mealTitle,
            ingredient: child.ingredient,
            qualifier: child.qualifier,
            amount: child.amount.amount,
            unit: child.amount.unit,
            source: child.amount.source ?? null,
            role: "weekly_requirement" as const,
            concept: { id: group.conceptId!, label: group.label },
            execution: { id: child.executionId, section, coverage: child.coverage, checked: child.checked },
          })))[0]?.quantities ?? [];
          return subtotal.map((part) => part.kind === "quantity" && qualifier
            ? { ...part, display: `${part.display} ${qualifier}` }
            : part);
        })
      : group.quantities.map((part) => part.kind === "quantity" && qualifiers.values().next().value
        ? { ...part, display: `${part.display} ${qualifiers.values().next().value}` }
        : part);
    sections.get(section)!.push({ key: group.key, label: group.label, conceptId: group.conceptId, quantities, provenanceCount: children.length, children });
  }
  return { filter, sections: SECTIONS.map((section) => ({ section, groups: sections.get(section)! })).filter((section) => section.groups.length) };
}

export function pageGroceryProjection(
  projection: GroceryProjection,
  offset: number,
  limit = GROCERY_READ_PAGE_SIZE,
): PagedGroceryProjection {
  const children = projection.sections.flatMap((section) => section.groups.flatMap((group) => group.children));
  const selected = new Set(children.slice(offset, offset + limit).map((child) => child.executionId));
  const sections = projection.sections.map((section) => ({
    section: section.section,
    groups: section.groups.flatMap((group) => {
      const pageChildren = group.children.filter((child) => selected.has(child.executionId));
      if (!pageChildren.length) return [];
      const completeGroup = pageChildren.length === group.children.length;
      const quantities = completeGroup ? group.quantities : pageChildren.map((child) => ({
        kind: "literal" as const,
        literal: child.amount.source ?? [child.amount.amount, child.amount.unit].filter(Boolean).join(" "),
        reason: "incompatible" as const,
      }));
      return [{ ...group, children: pageChildren, provenanceCount: group.provenanceCount, quantities }];
    }),
  })).filter((section) => section.groups.length);
  const nextOffset = offset + limit < children.length ? offset + limit : null;
  return { filter: projection.filter, offset, nextOffset, sections };
}
