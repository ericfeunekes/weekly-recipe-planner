import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

import {
  RESEARCH_INSTRUCTION_LENGTH,
  RESEARCH_SOURCE_IDENTITY_LENGTH,
  RESEARCH_SOURCE_URL_LENGTH,
  RESEARCH_STEP_INPUT_LIMIT,
  RESEARCH_STEP_LIMIT,
  RESEARCH_TOTAL_INPUT_LIMIT,
  type CanonicalRecipeSource,
  type SourcedRecipeReplacement,
} from "../../lib/sourced-recipe-contract.ts";

export const CANONICAL_RECIPE_FILE_BYTES_LIMIT = 64 * 1_024;

export class CanonicalRecipeReadError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CanonicalRecipeReadError";
  }
}

type CanonicalIngredient = {
  id: number;
  source: string;
  amount: string;
  unit: string;
  ingredient: string;
  qualifier: string;
};

type CanonicalInstruction = {
  id: number;
  ingredientIds: number[];
  instruction: string;
  timerSeconds?: number;
};

function fail(message: string, cause?: unknown): never {
  throw new CanonicalRecipeReadError(message, cause === undefined ? {} : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => expected.has(key));
}

function nonemptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= maxLength;
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  if (!nonemptyString(value, maxLength)) fail("Canonical recipe metadata contains an invalid optional text value.");
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => nonemptyString(entry, RESEARCH_SOURCE_IDENTITY_LENGTH))) {
    fail(`Canonical recipe ${field} must be an array of bounded non-empty strings.`);
  }
  return [...value];
}

function parseYamlBlock(source: string, label: string): unknown {
  const lines = source.split("\n");
  const flowDelimiters = source.match(/[\[\]{}]/gu)?.length ?? 0;
  if (flowDelimiters > 512 || lines.length > 1_024 || lines.some((line) => line.length > 2_000 || line.includes("\t") || /^ {3,}/u.test(line))) {
    fail(`Canonical recipe ${label} YAML exceeds the shallow current-schema structure.`);
  }
  const document = parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0) fail(`Canonical recipe ${label} YAML is invalid.`, document.errors[0]);
  return document.toJS({ maxAliasCount: 0 });
}

function parseIngredient(value: unknown, index: number): CanonicalIngredient {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "source", "amount", "unit", "ingredient", "qualifier"])) {
    fail("Canonical ingredients must use exactly id, source, amount, unit, ingredient, and qualifier.");
  }
  if (value.id !== index + 1 || !nonemptyString(value.source, 1_000) || !isSingleLine(value.source) ||
      !nonemptyString(value.ingredient, 1_000) || !isSingleLine(value.ingredient)) {
    fail("Canonical ingredient IDs must be sequential and every ingredient must retain a source line and identity.");
  }
  for (const field of ["amount", "unit", "qualifier"] as const) {
    if (value[field] !== null && (typeof value[field] !== "string" || String(value[field]).length > 300)) {
      fail(`Canonical ingredient ${field} must be a bounded string or blank.`);
    }
  }
  return {
    id: value.id as number,
    source: value.source,
    amount: value.amount === null ? "" : String(value.amount),
    unit: value.unit === null ? "" : String(value.unit),
    ingredient: value.ingredient,
    qualifier: value.qualifier === null ? "" : String(value.qualifier),
  };
}

function isSingleLine(value: string): boolean {
  return !/[\r\n\u2028\u2029]/u.test(value);
}

function parseInstruction(value: unknown, index: number, ingredientCount: number): CanonicalInstruction {
  if (!isRecord(value) || !hasExactKeys(
    value,
    Object.hasOwn(value, "timer-seconds")
      ? ["id", "ingredient-ids", "instruction", "timer-seconds"]
      : ["id", "ingredient-ids", "instruction"],
  )) fail("Canonical instructions contain unknown, legacy, or missing fields.");
  if (value.id !== index + 1 || !Array.isArray(value["ingredient-ids"]) ||
      value["ingredient-ids"].length > RESEARCH_STEP_INPUT_LIMIT ||
      !value["ingredient-ids"].every((id) => Number.isSafeInteger(id) && Number(id) >= 1 && Number(id) <= ingredientCount) ||
      new Set(value["ingredient-ids"]).size !== value["ingredient-ids"].length ||
      !nonemptyString(value.instruction, RESEARCH_INSTRUCTION_LENGTH)) {
    fail("Canonical instruction IDs, ingredient references, or instruction text are invalid.");
  }
  const timer = value["timer-seconds"];
  if (timer !== undefined && (!Number.isSafeInteger(timer) || Number(timer) < 1 || Number(timer) > 86_400)) {
    fail("Canonical instruction timer-seconds must be an integer from 1 to 86400.");
  }
  return {
    id: value.id as number,
    ingredientIds: [...value["ingredient-ids"]] as number[],
    instruction: value.instruction,
    ...(timer === undefined ? {} : { timerSeconds: timer as number }),
  };
}

function parseCanonicalRecipe(relativePath: string, bytes: Buffer): SourcedRecipeReplacement {
  const exactText = bytes.toString("utf8");
  if (Buffer.from(exactText, "utf8").compare(bytes) !== 0 || exactText.includes("\0")) {
    fail("Canonical recipe must be valid UTF-8 text without NUL bytes.");
  }
  const text = exactText.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n\n# ([^\n]+)\n\n## Ingredients\n\n```yaml\n([\s\S]*?)\n```\n\n## Instructions\n\n```yaml\n([\s\S]*?)\n```(?:\n\n## Notes\n\n([\s\S]*))?\n?$/u.exec(text);
  if (!match) fail("Canonical recipe must match the current frontmatter, Ingredients, Instructions, and optional Notes structure.");

  const metadata = parseYamlBlock(match[1], "frontmatter");
  const metadataKeys = [
    "type", "id", "status", "source", "source-ref", "source-locator", "source-path",
    "source-start-line", "source-end-line", "source-sha256", "source-retrieved-at",
    "fidelity-verdict", "fidelity-review", "adapted-from", "cuisine", "servings",
    "time-active-min", "time-total-min", "taste-tags", "dietary-tags",
  ] as const;
  if (!isRecord(metadata) || !hasExactKeys(metadata, metadataKeys)) {
    fail("Canonical recipe frontmatter is legacy or incomplete.");
  }
  const expectedIdentity = basename(relativePath, extname(relativePath));
  const servings = typeof metadata.servings === "number" && Number.isSafeInteger(metadata.servings) && metadata.servings > 0
    ? String(metadata.servings)
    : nonemptyString(metadata.servings, 80) ? metadata.servings : null;
  if (!nonemptyString(match[2], 200) || metadata.type !== "recipe" || metadata.status !== "active" ||
      !nonemptyString(metadata.id, RESEARCH_SOURCE_IDENTITY_LENGTH) || metadata.id !== expectedIdentity ||
      !["cookbook", "chatgpt", "web", "self", "family"].includes(String(metadata.source)) ||
      !nonemptyString(metadata["source-ref"], RESEARCH_SOURCE_URL_LENGTH) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(String(metadata["source-retrieved-at"])) ||
      !["exact", "mismatch"].includes(String(metadata["fidelity-verdict"])) ||
      !nonemptyString(metadata["fidelity-review"], RESEARCH_SOURCE_URL_LENGTH) ||
      servings === null ||
      !Number.isSafeInteger(metadata["time-active-min"]) || Number(metadata["time-active-min"]) < 0 ||
      !Number.isSafeInteger(metadata["time-total-min"]) || Number(metadata["time-total-min"]) < Number(metadata["time-active-min"])) {
    fail("Canonical recipe frontmatter is not an active, reviewed, cooking-ready current-schema recipe.");
  }
  const startLine = metadata["source-start-line"];
  const endLine = metadata["source-end-line"];
  if ((startLine === null) !== (endLine === null) ||
      (startLine !== null && (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || Number(startLine) < 1 || Number(endLine) < Number(startLine)))) {
    fail("Canonical recipe source line bounds must be absent together or form an inclusive ordered range.");
  }
  const sourceSha = metadata["source-sha256"];
  if (sourceSha !== null && (typeof sourceSha !== "string" || !/^[0-9a-f]{64}$/u.test(sourceSha))) {
    fail("Canonical recipe source-sha256 must be blank or a lowercase SHA-256 digest.");
  }
  if (metadata.source === "cookbook" && metadata["source-locator"] === null) {
    fail("Canonical cookbook recipes require an exact source-locator.");
  }

  const ingredientValues = parseYamlBlock(match[3], "ingredients");
  if (!Array.isArray(ingredientValues) || ingredientValues.length < 1 || ingredientValues.length > RESEARCH_TOTAL_INPUT_LIMIT) {
    fail("Canonical recipe must contain a bounded non-empty ingredient list.");
  }
  const ingredients = ingredientValues.map(parseIngredient);
  const instructionValues = parseYamlBlock(match[4], "instructions");
  if (!Array.isArray(instructionValues) || instructionValues.length < 1 || instructionValues.length > RESEARCH_STEP_LIMIT) {
    fail("Canonical recipe must contain a bounded non-empty instruction list.");
  }
  const instructions = instructionValues.map((value, index) => parseInstruction(value, index, ingredients.length));
  const notes = match[5] ?? "";
  if (notes.length > RESEARCH_INSTRUCTION_LENGTH * 4) fail("Canonical recipe Notes exceed the snapshot limit.");

  const source: CanonicalRecipeSource = {
    kind: "canonical",
    identity: metadata.id,
    revision: createHash("sha256").update(bytes).digest("hex"),
    path: relativePath,
    status: "active",
    provenance: {
      source: metadata.source as CanonicalRecipeSource["provenance"]["source"],
      sourceRef: metadata["source-ref"] as string,
      sourceLocator: optionalString(metadata["source-locator"], RESEARCH_SOURCE_URL_LENGTH),
      sourcePath: optionalString(metadata["source-path"], RESEARCH_SOURCE_URL_LENGTH),
      sourceStartLine: startLine as number | null,
      sourceEndLine: endLine as number | null,
      sourceSha256: sourceSha as string | null,
      sourceRetrievedAt: String(metadata["source-retrieved-at"]),
      fidelityVerdict: metadata["fidelity-verdict"] as "exact" | "mismatch",
      fidelityReview: metadata["fidelity-review"] as string,
      adaptedFrom: optionalString(metadata["adapted-from"], RESEARCH_SOURCE_URL_LENGTH),
    },
    servings,
    timeActiveMinutes: Number(metadata["time-active-min"]),
    timeTotalMinutes: Number(metadata["time-total-min"]),
    cuisine: optionalString(metadata.cuisine, RESEARCH_SOURCE_IDENTITY_LENGTH),
    tasteTags: stringArray(metadata["taste-tags"], "taste-tags"),
    dietaryTags: stringArray(metadata["dietary-tags"], "dietary-tags"),
    notes,
  };
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  return {
    title: match[2],
    yieldText: source.servings,
    source,
    occurrences: ingredients.map((ingredient) => ({
      kind: "create" as const,
      correlationId: `canonical-ingredient-${ingredient.id}`,
      source: ingredient.source,
      amount: ingredient.amount,
      unit: ingredient.unit || null,
      ingredient: ingredient.ingredient,
      qualifier: ingredient.qualifier || null,
      conceptId: null,
      canonicalIngredientId: ingredient.id,
    })),
    steps: instructions.map((instruction) => ({
      inputs: instruction.ingredientIds.map((ingredientId) => {
        const ingredient = ingredientById.get(ingredientId)!;
        return {
          occurrenceCorrelationId: `canonical-ingredient-${ingredientId}`,
          amount: ingredient.amount,
          ingredient: ingredient.ingredient,
        };
      }),
      instruction: instruction.instruction,
      ...(instruction.timerSeconds === undefined ? {} : { timerDurationSeconds: instruction.timerSeconds }),
    })),
  };
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export async function readCanonicalRecipe(
  configuredRoot: string,
  requestedPath: string,
): Promise<SourcedRecipeReplacement> {
  if (!isAbsolute(configuredRoot) || typeof requestedPath !== "string" || requestedPath.length < 1 ||
      requestedPath.length > RESEARCH_SOURCE_URL_LENGTH || isAbsolute(requestedPath) || requestedPath.includes("\0") ||
      requestedPath.includes("\\") || extname(requestedPath).toLowerCase() !== ".md") {
    fail("Canonical recipe path must be a bounded relative POSIX Markdown path.");
  }
  let root: string;
  try {
    root = await realpath(configuredRoot);
  } catch (error) {
    fail("Configured canonical recipe root is unavailable.", error);
  }
  const candidatePath = resolve(root, requestedPath);
  if (!isContained(root, candidatePath)) fail("Canonical recipe path escapes the configured root.");
  if (relative(root, candidatePath).split(sep).join("/") !== requestedPath) {
    fail("Canonical recipe path must already be normalized relative to the configured root.");
  }
  let pathStats;
  try {
    pathStats = await lstat(candidatePath, { bigint: true });
  } catch (error) {
    fail("Canonical recipe file does not exist.", error);
  }
  if (!pathStats.isFile()) fail("Canonical recipe path must name a regular file, not a link or directory.");
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidatePath);
  } catch (error) {
    fail("Canonical recipe file could not be resolved.", error);
  }
  if (!isContained(root, canonicalCandidate)) fail("Canonical recipe resolves outside the configured root.");

  let handle;
  try {
    handle = await open(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile() || openedStats.dev !== pathStats.dev || openedStats.ino !== pathStats.ino) {
      fail("Canonical recipe path must remain the inspected regular file while open.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= CANONICAL_RECIPE_FILE_BYTES_LIMIT) {
      const chunk = Buffer.alloc(Math.min(8_192, CANONICAL_RECIPE_FILE_BYTES_LIMIT + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > CANONICAL_RECIPE_FILE_BYTES_LIMIT) fail("Canonical recipe exceeds the bounded-read limit.");
    const completedStats = await handle.stat({ bigint: true });
    if (completedStats.dev !== openedStats.dev || completedStats.ino !== openedStats.ino ||
        completedStats.size !== openedStats.size || completedStats.mtimeNs !== openedStats.mtimeNs ||
        completedStats.ctimeNs !== openedStats.ctimeNs) {
      fail("Canonical recipe changed during its bounded read.");
    }
    return parseCanonicalRecipe(requestedPath, Buffer.concat(chunks, total));
  } catch (error) {
    if (error instanceof CanonicalRecipeReadError) throw error;
    fail("Canonical recipe could not be read safely.", error);
  } finally {
    await handle?.close();
  }
  throw new CanonicalRecipeReadError("Canonical recipe read ended without a result.");
}
