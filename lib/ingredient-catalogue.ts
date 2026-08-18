import type { GrocerySection, IngredientCatalogue, IngredientConcept } from "./household-contract.ts";
import { normalizeIngredientCore } from "./ingredient-occurrence.ts";

export const MAX_INGREDIENT_CANDIDATE_INPUTS = 16;
export const MAX_INGREDIENT_CONCEPTS = 1_000;
export const MAX_INGREDIENT_VOCABULARY = 32;
export const MAX_INGREDIENT_CONCEPT_TEXT = 200;
export const MAX_INGREDIENT_CONCEPT_ID = 200;
export const INGREDIENT_CONCEPT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";

const CORE: ReadonlyArray<readonly [string, string, GrocerySection, readonly string[]]> = [
  ["green-onion", "Green onion", "Produce", ["green onions", "scallion", "scallions"]],
  ["red-onion", "Red onion", "Produce", ["red onions"]],
  ["yellow-onion", "Yellow onion", "Produce", ["yellow onions", "cooking onion", "cooking onions"]],
  ["garlic", "Garlic", "Produce", ["garlic clove", "garlic cloves"]],
  ["red-pepper", "Red pepper", "Produce", ["red peppers", "red bell pepper", "red bell peppers"]],
  ["lemon", "Lemon", "Produce", ["lemons"]],
  ["lime", "Lime", "Produce", ["limes"]],
  ["carrot", "Carrot", "Produce", ["carrots"]],
  ["potato", "Potato", "Produce", ["potatoes"]],
  ["tomato", "Tomato", "Produce", ["tomatoes"]],
  ["spinach", "Spinach", "Produce", ["baby spinach"]],
  ["chicken-thigh", "Chicken thigh", "Meat & seafood", ["chicken thighs", "boneless chicken thighs"]],
  ["chicken-breast", "Chicken breast", "Meat & seafood", ["chicken breasts"]],
  ["salmon", "Salmon", "Meat & seafood", ["salmon fillet", "salmon fillets"]],
  ["egg", "Egg", "Dairy", ["eggs"]],
  ["milk", "Milk", "Dairy", []],
  ["butter", "Butter", "Dairy", []],
  ["plain-yogurt", "Plain yogurt", "Dairy", ["plain yoghurt", "yogurt", "yoghurt"]],
  ["cheddar", "Cheddar", "Dairy", ["cheddar cheese"]],
  ["rice", "Rice", "Pantry", ["white rice"]],
  ["basmati-rice", "Basmati rice", "Pantry", []],
  ["chickpea", "Chickpea", "Pantry", ["chickpeas", "garbanzo bean", "garbanzo beans"]],
  ["black-bean", "Black bean", "Pantry", ["black beans"]],
  ["lentil", "Lentil", "Pantry", ["lentils"]],
  ["olive-oil", "Olive oil", "Pantry", []],
  ["salt", "Salt", "Pantry", ["kosher salt", "sea salt"]],
  ["black-pepper", "Black pepper", "Pantry", ["ground black pepper"]],
  ["flour", "Flour", "Pantry", ["all-purpose flour", "all purpose flour"]],
  ["sugar", "Sugar", "Pantry", ["granulated sugar"]],
];

export function createCoreIngredientCatalogue(): IngredientCatalogue {
  return {
    revision: 1,
    concepts: CORE.map(([id, preferredLabel, defaultSection, vocabulary]) => ({
      id,
      preferredLabel,
      defaultSection,
      vocabulary: [...vocabulary],
    })),
  };
}

export type IngredientCandidateInput = {
  correlationId: string;
  amount: string;
  ingredient: string;
  occurrenceId?: string;
  mealId?: string;
  source?: string | null;
  unit?: string | null;
  qualifier?: string | null;
  conceptId?: string | null;
  canonicalIngredientId?: number | null;
};

export type IngredientCandidate = {
  conceptId: string;
  preferredLabel: string;
  kind: "exact" | "similar";
  reasons: string[];
};

export type IngredientCandidateResult = Pick<IngredientCandidateInput, "correlationId" | "occurrenceId"> & {
  candidates: IngredientCandidate[];
};

export type IngredientCandidatePreview = {
  inputDigest: string;
  catalogueRevision: number;
  results: IngredientCandidateResult[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maximum: number, nonempty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (!nonempty || value.trim().length > 0);
}

export function isIngredientCandidatePreview(value: unknown): value is IngredientCandidatePreview {
  if (!isRecord(value) || !exactKeys(value, ["inputDigest", "catalogueRevision", "results"]) ||
      typeof value.inputDigest !== "string" || !/^[a-f0-9]{16}$/u.test(value.inputDigest) ||
      !Number.isSafeInteger(value.catalogueRevision) || Number(value.catalogueRevision) < 1 ||
      !Array.isArray(value.results) || value.results.length < 1 || value.results.length > MAX_INGREDIENT_CANDIDATE_INPUTS) return false;
  const correlations = new Set<string>();
  for (const result of value.results) {
    if (!isRecord(result) || !exactKeys(result, ["correlationId", "candidates"], ["occurrenceId"]) ||
        !isBoundedString(result.correlationId, 200, true) || correlations.has(result.correlationId) ||
        (result.occurrenceId !== undefined && !isBoundedString(result.occurrenceId, 200, true)) ||
        !Array.isArray(result.candidates) || result.candidates.length > 5) return false;
    correlations.add(result.correlationId);
    for (const candidate of result.candidates) if (!isRecord(candidate) || !exactKeys(candidate, ["conceptId", "preferredLabel", "kind", "reasons"]) ||
      !isBoundedString(candidate.conceptId, MAX_INGREDIENT_CONCEPT_ID, true) || !(new RegExp(INGREDIENT_CONCEPT_ID_PATTERN, "u")).test(candidate.conceptId) ||
      !isBoundedString(candidate.preferredLabel, MAX_INGREDIENT_CONCEPT_TEXT, true) || /[\u0000-\u001f\u007f]/u.test(candidate.preferredLabel) ||
      (candidate.kind !== "exact" && candidate.kind !== "similar") || !Array.isArray(candidate.reasons) || candidate.reasons.length < 1 || candidate.reasons.length > 2 ||
      !candidate.reasons.every((reason) => isBoundedString(reason, 200, true))) return false;
  }
  return true;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function ingredientCandidateDigest(inputs: readonly IngredientCandidateInput[]): string {
  const digestInputs = inputs.map((input) => input.occurrenceId
    ? { correlationId: input.correlationId, occurrenceId: input.occurrenceId, amount: input.amount, ingredient: input.ingredient }
    : input);
  const bytes = new TextEncoder().encode(canonicalJson(digestInputs));
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const byte of bytes) {
    left = Math.imul(left ^ byte, 0x01000193) >>> 0;
    right = Math.imul(right ^ byte, 0x85ebca6b) >>> 0;
  }
  return left.toString(16).padStart(8, "0") + right.toString(16).padStart(8, "0");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

const MATERIAL_FORM_WORDS = new Set(["red", "green", "yellow", "black", "white", "raw", "cooked", "fresh", "dried", "ground", "whole"]);

function materiallyDifferent(left: string, right: string): boolean {
  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  for (const word of MATERIAL_FORM_WORDS) {
    if (leftWords.has(word) !== rightWords.has(word)) return true;
  }
  return false;
}

export function findIngredientCandidates(
  catalogue: IngredientCatalogue,
  inputs: readonly IngredientCandidateInput[],
): IngredientCandidateResult[] {
  if (inputs.length < 1 || inputs.length > MAX_INGREDIENT_CANDIDATE_INPUTS) {
    throw new TypeError(`Ingredient candidate queries require 1 to ${MAX_INGREDIENT_CANDIDATE_INPUTS} inputs.`);
  }
  return inputs.map((input) => {
    const literal = normalizeIngredientCore(input.ingredient);
    const candidates: IngredientCandidate[] = [];
    for (const concept of catalogue.concepts) {
      const labels = [concept.preferredLabel, ...concept.vocabulary].map(normalizeIngredientCore);
      const exactVocabulary = labels.find((label) => label === literal);
      if (exactVocabulary) {
        candidates.push({ conceptId: concept.id, preferredLabel: concept.preferredLabel, kind: "exact", reasons: [exactVocabulary === normalizeIngredientCore(concept.preferredLabel) ? "preferred label" : "accepted vocabulary"] });
        continue;
      }
      const closest = labels.reduce((best, label) => Math.min(best, editDistance(literal, label)), Number.MAX_SAFE_INTEGER);
      const tokenOverlap = labels.some((label) => label.split(" ").some((word) => word.length > 3 && literal.split(" ").includes(word)));
      if (!materiallyDifferent(literal, normalizeIngredientCore(concept.preferredLabel)) && (closest <= 2 || tokenOverlap)) {
        candidates.push({ conceptId: concept.id, preferredLabel: concept.preferredLabel, kind: "similar", reasons: [...(closest <= 2 ? [`edit distance ${closest}`] : []), ...(tokenOverlap ? ["shared ingredient wording"] : [])] });
      }
    }
    candidates.sort((a, b) => (a.kind === b.kind ? a.preferredLabel.localeCompare(b.preferredLabel) : a.kind === "exact" ? -1 : 1));
    return {
      correlationId: input.correlationId,
      ...(input.occurrenceId ? { occurrenceId: input.occurrenceId } : {}),
      candidates: candidates.slice(0, 5),
    };
  });
}

export function conceptVocabulary(concept: IngredientConcept): string[] {
  return [concept.preferredLabel, ...concept.vocabulary].map(normalizeIngredientCore);
}
