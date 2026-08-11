import type { IngredientRole, RecipeIngredient } from "./household-contract.ts";

export type IngredientOccurrenceEdit =
  | { kind: "retain"; occurrenceId: string; source: string | null; amount: string; unit: string | null; ingredient: string; qualifier: string | null; conceptId: string | null }
  | { kind: "create"; correlationId: string; source: string | null; amount: string; unit: string | null; ingredient: string; qualifier: string | null; conceptId: string | null; canonicalIngredientId: number | null };

export type IngredientUse = { occurrenceId: string; amount: string; ingredient: string };
export type InstructionInputEdit =
  | { kind: "retain"; occurrenceId: string; amount: string; ingredient: string }
  | { kind: "create"; correlationId: string; amount: string; ingredient: string };
export type OccurrenceCreateInput = Extract<IngredientOccurrenceEdit, { kind: "create" }>;
export type OccurrenceResolution = { correlationId: string; occurrenceId: string };
export type OccurrenceMatch =
  | { kind: "unique"; occurrenceId: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; occurrenceIds: string[] };
export const MAX_OCCURRENCE_AMOUNT_LENGTH = 300;
export const MAX_OCCURRENCE_LITERAL_LENGTH = 1_000;

/** Only recipe requirements project into grocery execution state. */
export function isGroceryRequirementRole(role: unknown): role is "weekly_requirement" {
  return role === "weekly_requirement";
}

export function normalizeIngredientCore(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

/** The sole text normalization used for matching a *new* instruction input. */
export const normalizedCoreIngredientLiteral = normalizeIngredientCore;

export function ingredientOccurrenceDisplayText(value: {
  source?: string | null;
  amount: string;
  unit?: string | null;
  ingredient: string;
  qualifier?: string | null;
}): string {
  if (typeof value.source === "string" && value.source.trim()) return value.source;
  return [value.amount, value.unit, value.ingredient, value.qualifier]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

/**
 * Parses a true legacy ingredient string once. It intentionally does not
 * deduplicate, normalize, or infer a planner occurrence identity.
 */
export function parseLegacyIngredientLine(source: string): {
  source: string;
  amount: string;
  unit: string | null;
  ingredient: string;
  qualifier: string | null;
} {
  const trimmed = source.trim();
  // Recognize only a small, explicit open-unit set. Unknown tokens remain in
  // the ingredient rather than being guessed into a structured quantity.
  const match = /^(?:(\d+(?:[./]\d+)?|[¼½¾])\s+)?(?:(cups?|tbsp|tablespoons?|tsp|teaspoons?|g|kg|oz|lb|lbs|ml|l)\s+)?(.+)$/iu.exec(trimmed);
  const amount = match?.[1] ?? "";
  const unit = match?.[2]?.toLocaleLowerCase() ?? null;
  const ingredient = match?.[3] ?? trimmed;
  return { source, amount, unit, ingredient, qualifier: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));
}
function boundedText(value: unknown, maximum: number, nonempty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (!nonempty || value.trim().length > 0);
}
function nullableLiteral(value: unknown): value is string | null {
  return value === null || boundedText(value, MAX_OCCURRENCE_LITERAL_LENGTH);
}
function id(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 200; }
function positiveIntegerOrNull(value: unknown): value is number | null { return value === null || (Number.isSafeInteger(value) && Number(value) > 0); }

export function isIngredientOccurrenceEdit(value: unknown): value is IngredientOccurrenceEdit {
  if (!isRecord(value) || (value.kind !== "retain" && value.kind !== "create")) return false;
  const common = ["kind", value.kind === "retain" ? "occurrenceId" : "correlationId", "source", "amount", "unit", "ingredient", "qualifier", "conceptId"] as const;
  const fieldsAreValid = nullableLiteral(value.source) &&
    boundedText(value.amount, MAX_OCCURRENCE_AMOUNT_LENGTH) &&
    nullableLiteral(value.unit) &&
    boundedText(value.ingredient, MAX_OCCURRENCE_LITERAL_LENGTH, true) &&
    nullableLiteral(value.qualifier) &&
    nullableLiteral(value.conceptId);
  if (value.kind === "retain") return hasKeys(value, common) && id(value.occurrenceId) && fieldsAreValid;
  return hasKeys(value, [...common, "canonicalIngredientId"]) && id(value.correlationId) && fieldsAreValid && positiveIntegerOrNull(value.canonicalIngredientId);
}

export function isInstructionInputEdit(value: unknown): value is InstructionInputEdit {
  if (!isRecord(value) || (value.kind !== "retain" && value.kind !== "create")) return false;
  if (!boundedText(value.amount, MAX_OCCURRENCE_AMOUNT_LENGTH) ||
      !boundedText(value.ingredient, MAX_OCCURRENCE_LITERAL_LENGTH)) return false;
  return value.kind === "retain"
    ? hasKeys(value, ["kind", "occurrenceId", "amount", "ingredient"]) && id(value.occurrenceId)
    : hasKeys(value, ["kind", "correlationId", "amount", "ingredient"]) && id(value.correlationId);
}

export function instructionInputCorrelationsAreUnique(inputs: readonly InstructionInputEdit[]): boolean {
  const correlations = inputs
    .filter((input): input is Extract<InstructionInputEdit, { kind: "create" }> => input.kind === "create")
    .map((input) => input.correlationId);
  return new Set(correlations).size === correlations.length;
}

export function occurrenceEditIdentitiesAreUnique(edits: readonly IngredientOccurrenceEdit[]): boolean {
  const retained = edits
    .filter((edit): edit is Extract<IngredientOccurrenceEdit, { kind: "retain" }> => edit.kind === "retain")
    .map((edit) => edit.occurrenceId);
  const correlations = edits
    .filter((edit): edit is OccurrenceCreateInput => edit.kind === "create")
    .map((edit) => edit.correlationId);
  return new Set(retained).size === retained.length &&
    new Set(correlations).size === correlations.length;
}

export function validateOccurrencePartition(previousIds: readonly string[], edits: readonly IngredientOccurrenceEdit[], removedOccurrenceIds: readonly string[]): string | null {
  const previous = new Set(previousIds);
  if (previous.size !== previousIds.length) return "Existing occurrence IDs must be unique.";
  const retained = edits.filter((edit): edit is Extract<IngredientOccurrenceEdit, { kind: "retain" }> => edit.kind === "retain").map((edit) => edit.occurrenceId);
  const correlations = edits.filter((edit): edit is OccurrenceCreateInput => edit.kind === "create").map((edit) => edit.correlationId);
  if (new Set(retained).size !== retained.length) return "A retained occurrence ID appears more than once.";
  if (new Set(removedOccurrenceIds).size !== removedOccurrenceIds.length) return "A removed occurrence ID appears more than once.";
  if (new Set(correlations).size !== correlations.length) return "A create correlation appears more than once.";
  if (retained.some((entry) => !previous.has(entry)) || removedOccurrenceIds.some((entry) => !previous.has(entry))) return "An occurrence transition refers to an unknown occurrence ID.";
  if (retained.some((entry) => removedOccurrenceIds.includes(entry))) return "An occurrence cannot be retained and removed.";
  if (retained.length + removedOccurrenceIds.length !== previousIds.length) return "Every existing occurrence must be retained or removed exactly once.";
  return null;
}

export function materializeOccurrence(create: OccurrenceCreateInput, occurrenceId: string): RecipeIngredient {
  return { id: occurrenceId, source: create.source, amount: create.amount, unit: create.unit, ingredient: create.ingredient, qualifier: create.qualifier, conceptId: create.conceptId, role: "weekly_requirement" satisfies IngredientRole, canonicalIngredientId: create.canonicalIngredientId };
}

export function resolveNewInstructionInput(input: Extract<InstructionInputEdit, { kind: "create" }>, occurrences: readonly RecipeIngredient[]): string | null {
  const match = matchOccurrenceByCore(input.ingredient, occurrences);
  return match.kind === "unique" ? match.occurrenceId : null;
}

/** Sole zero/one/many decision for legacy and newly-created instruction inputs. */
export function matchOccurrenceByCore(
  ingredient: string,
  occurrences: ReadonlyArray<{ id: string; ingredient: string }>,
): OccurrenceMatch {
  const literal = normalizeIngredientCore(ingredient);
  const occurrenceIds = occurrences
    .filter((occurrence) => normalizeIngredientCore(occurrence.ingredient) === literal)
    .map((occurrence) => occurrence.id);
  if (occurrenceIds.length === 0) return { kind: "missing" };
  if (occurrenceIds.length === 1) return { kind: "unique", occurrenceId: occurrenceIds[0] };
  return { kind: "ambiguous", occurrenceIds };
}
