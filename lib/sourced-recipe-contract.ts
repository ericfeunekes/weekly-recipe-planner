export const RESEARCH_RECIPE_SCHEMA_VERSION = 1 as const;
export const RESEARCH_CANDIDATE_BYTES_LIMIT = 32 * 1_024;
export const RESEARCH_SOURCE_IDENTITY_LENGTH = 200;
export const RESEARCH_SOURCE_URL_LENGTH = 2_048;
export const RESEARCH_TITLE_LENGTH = 200;
export const RESEARCH_YIELD_LENGTH = 80;
export const RESEARCH_STEP_LIMIT = 32;
export const RESEARCH_STEP_INPUT_LIMIT = 12;
export const RESEARCH_TOTAL_INPUT_LIMIT = 128;
export const RESEARCH_AMOUNT_LENGTH = 80;
export const RESEARCH_INGREDIENT_LENGTH = 160;
export const RESEARCH_INSTRUCTION_LENGTH = 1_000;
export const RESEARCH_TIMER_DURATION_LIMIT = 86_400;
export const RESEARCH_CANDIDATE_ID_LENGTH = 200;
export const RESEARCH_REPLACEMENT_DIGEST_VERSION = 1 as const;
export const RESEARCH_REPLACEMENT_DIGEST_LENGTH = 64;

export type SourcedRecipeInput = {
  amount: string;
  ingredient: string;
};

export type SourcedRecipeStep = {
  inputs: SourcedRecipeInput[];
  instruction: string;
  timerDurationSeconds?: number;
};

export type WebRecipeSourceDraft = {
  kind: "web";
  identity: string;
  url: string;
};

export type SourceRecipe = WebRecipeSourceDraft & {
  retrievedAt: number;
};

export type ResearchRecipeDraft = {
  source: WebRecipeSourceDraft;
  title: string;
  yieldText?: string;
  steps: SourcedRecipeStep[];
};

export type ResearchRecipeProviderOutput = {
  source: WebRecipeSourceDraft;
  title: string;
  yieldText: string | null;
  steps: Array<{
    inputs: SourcedRecipeInput[];
    instruction: string;
    timerDurationSeconds: number | null;
  }>;
};

export type ResearchRecipeCandidate = {
  schemaVersion: typeof RESEARCH_RECIPE_SCHEMA_VERSION;
  candidateId: string;
  source: SourceRecipe;
  title: string;
  yieldText?: string;
  steps: SourcedRecipeStep[];
};

type ResearchCandidateReferenceBase = {
  schemaVersion: typeof RESEARCH_RECIPE_SCHEMA_VERSION;
  candidateId: string;
  title: string;
  source: SourceRecipe;
  stepCount: number;
};

export type LegacyResearchCandidateReference = ResearchCandidateReferenceBase;

export type DigestBoundResearchCandidateReference = ResearchCandidateReferenceBase & {
  digestVersion: typeof RESEARCH_REPLACEMENT_DIGEST_VERSION;
  replacementDigest: string;
};

export type ResearchCandidateReference =
  | LegacyResearchCandidateReference
  | DigestBoundResearchCandidateReference;

export type SourcedRecipeReplacement = {
  title: string;
  yieldText?: string;
  source: SourceRecipe;
  occurrences: import("./ingredient-occurrence.ts").OccurrenceCreateInput[];
  steps: Array<{
    inputs: Array<{ occurrenceCorrelationId: string; amount: string; ingredient: string }>;
    instruction: string;
    timerDurationSeconds?: number;
    note?: string;
  }>;
};

export type LegacySourcedRecipeReplacement = {
  title: string;
  yieldText?: string;
  source: SourceRecipe;
  steps: SourcedRecipeStep[];
};

export interface ResearchCandidateIdFactory {
  createId(prefix: "research-candidate"): string;
}

export interface ResearchCandidateClock {
  now(): number;
}

const boundedString = (maxLength: number, minLength = 0) => ({
  type: "string",
  minLength,
  maxLength,
});

const webSourceDraftSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "identity", "url"],
  properties: {
    kind: { type: "string", const: "web" },
    identity: boundedString(RESEARCH_SOURCE_IDENTITY_LENGTH, 1),
    url: boundedString(RESEARCH_SOURCE_URL_LENGTH, 1),
  },
} as const;

const sourceRecipeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "identity", "url", "retrievedAt"],
  properties: {
    ...webSourceDraftSchema.properties,
    retrievedAt: { type: "integer", minimum: 0 },
  },
} as const;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "ingredient"],
  properties: {
    amount: boundedString(RESEARCH_AMOUNT_LENGTH, 1),
    ingredient: boundedString(RESEARCH_INGREDIENT_LENGTH, 1),
  },
} as const;

const canonicalStepSchema = {
  type: "object",
  additionalProperties: false,
  required: ["inputs", "instruction"],
  properties: {
    inputs: {
      type: "array",
      maxItems: RESEARCH_STEP_INPUT_LIMIT,
      items: inputSchema,
    },
    instruction: boundedString(RESEARCH_INSTRUCTION_LENGTH, 1),
    timerDurationSeconds: {
      type: "integer",
      minimum: 1,
      maximum: RESEARCH_TIMER_DURATION_LIMIT,
    },
  },
} as const;

const providerStepSchema = {
  ...canonicalStepSchema,
  required: ["inputs", "instruction", "timerDurationSeconds"],
  properties: {
    ...canonicalStepSchema.properties,
    timerDurationSeconds: {
      anyOf: [
        canonicalStepSchema.properties.timerDurationSeconds,
        { type: "null" },
      ],
    },
  },
} as const;

export const RESEARCH_RECIPE_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["source", "title", "yieldText", "steps"],
  properties: {
    source: webSourceDraftSchema,
    title: boundedString(RESEARCH_TITLE_LENGTH, 1),
    yieldText: {
      anyOf: [boundedString(RESEARCH_YIELD_LENGTH, 1), { type: "null" }],
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: RESEARCH_STEP_LIMIT,
      items: providerStepSchema,
    },
  },
});

export const RESEARCH_RECIPE_DRAFT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["source", "title", "steps"],
  properties: {
    source: webSourceDraftSchema,
    title: boundedString(RESEARCH_TITLE_LENGTH, 1),
    yieldText: boundedString(RESEARCH_YIELD_LENGTH, 1),
    steps: {
      type: "array",
      minItems: 1,
      maxItems: RESEARCH_STEP_LIMIT,
      items: canonicalStepSchema,
    },
  },
});

export const SOURCED_RECIPE_REPLACEMENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["title", "source", "occurrences", "steps"],
  properties: {
    title: boundedString(RESEARCH_TITLE_LENGTH, 1),
    yieldText: boundedString(RESEARCH_YIELD_LENGTH, 1),
    source: sourceRecipeSchema,
    occurrences: {
      type: "array", maxItems: RESEARCH_TOTAL_INPUT_LIMIT,
      items: {
        type: "object", additionalProperties: false,
        required: ["kind", "correlationId", "source", "amount", "unit", "ingredient", "qualifier", "conceptId", "canonicalIngredientId"],
        properties: {
          kind: { const: "create" }, correlationId: boundedString(200, 1), source: { anyOf: [boundedString(RESEARCH_SOURCE_IDENTITY_LENGTH), { type: "null" }] }, amount: boundedString(RESEARCH_AMOUNT_LENGTH), unit: { anyOf: [boundedString(RESEARCH_AMOUNT_LENGTH), { type: "null" }] }, ingredient: boundedString(RESEARCH_INGREDIENT_LENGTH), qualifier: { anyOf: [boundedString(RESEARCH_INGREDIENT_LENGTH), { type: "null" }] }, conceptId: { anyOf: [boundedString(200), { type: "null" }] }, canonicalIngredientId: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        },
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: RESEARCH_STEP_LIMIT,
      items: { type: "object", additionalProperties: false, required: ["inputs", "instruction"], properties: { inputs: { type: "array", maxItems: RESEARCH_STEP_INPUT_LIMIT, items: { type: "object", additionalProperties: false, required: ["occurrenceCorrelationId", "amount", "ingredient"], properties: { occurrenceCorrelationId: boundedString(200, 1), amount: boundedString(RESEARCH_AMOUNT_LENGTH), ingredient: boundedString(RESEARCH_INGREDIENT_LENGTH) } } }, instruction: boundedString(RESEARCH_INSTRUCTION_LENGTH, 1), timerDurationSeconds: canonicalStepSchema.properties.timerDurationSeconds, note: boundedString(RESEARCH_INSTRUCTION_LENGTH) } },
    },
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedTrimmedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength &&
    value === value.trim();
}

function isSingleLine(value: string): boolean {
  return !/[\r\n\u2028\u2029]/u.test(value);
}

function isCanonicalWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > RESEARCH_SOURCE_URL_LENGTH) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !value.includes("#") &&
      parsed.username === "" && parsed.password === "" && parsed.hash === "" &&
      parsed.toString() === value;
  } catch {
    return false;
  }
}

function isWebSourceDraft(value: unknown): value is WebRecipeSourceDraft {
  return isRecord(value) && hasExactKeys(value, ["kind", "identity", "url"]) &&
    value.kind === "web" &&
    isBoundedTrimmedText(value.identity, RESEARCH_SOURCE_IDENTITY_LENGTH) &&
    isCanonicalWebUrl(value.url);
}

export function isSourceRecipe(value: unknown): value is SourceRecipe {
  return isRecord(value) &&
    hasExactKeys(value, ["kind", "identity", "url", "retrievedAt"]) &&
    value.kind === "web" &&
    isBoundedTrimmedText(value.identity, RESEARCH_SOURCE_IDENTITY_LENGTH) &&
    isCanonicalWebUrl(value.url) &&
    Number.isSafeInteger(value.retrievedAt) && Number(value.retrievedAt) >= 0;
}

function isSourcedRecipeInput(value: unknown): value is SourcedRecipeInput {
  return isRecord(value) && hasExactKeys(value, ["amount", "ingredient"]) &&
    isBoundedTrimmedText(value.amount, RESEARCH_AMOUNT_LENGTH) &&
    isSingleLine(value.amount) &&
    isBoundedTrimmedText(value.ingredient, RESEARCH_INGREDIENT_LENGTH) &&
    isSingleLine(value.ingredient);
}

function isSourcedRecipeStep(value: unknown): value is SourcedRecipeStep {
  return isRecord(value) &&
    hasExactKeys(value, ["inputs", "instruction"], ["timerDurationSeconds"]) &&
    Array.isArray(value.inputs) && value.inputs.length <= RESEARCH_STEP_INPUT_LIMIT &&
    value.inputs.every(isSourcedRecipeInput) &&
    isBoundedTrimmedText(value.instruction, RESEARCH_INSTRUCTION_LENGTH) &&
    (!Object.hasOwn(value, "timerDurationSeconds") ||
      (Number.isSafeInteger(value.timerDurationSeconds) &&
        Number(value.timerDurationSeconds) >= 1 &&
        Number(value.timerDurationSeconds) <= RESEARCH_TIMER_DURATION_LIMIT));
}

function hasValidRecipeBody(value: Record<string, unknown>): boolean {
  if (
    !isBoundedTrimmedText(value.title, RESEARCH_TITLE_LENGTH) ||
    (Object.hasOwn(value, "yieldText") &&
      !isBoundedTrimmedText(value.yieldText, RESEARCH_YIELD_LENGTH)) ||
    !Array.isArray(value.steps) || value.steps.length < 1 ||
    value.steps.length > RESEARCH_STEP_LIMIT || !value.steps.every(isSourcedRecipeStep)
  ) return false;
  return value.steps.reduce((count, step) => count + step.inputs.length, 0) <=
    RESEARCH_TOTAL_INPUT_LIMIT;
}

export function isResearchRecipeDraft(value: unknown): value is ResearchRecipeDraft {
  return isRecord(value) &&
    hasExactKeys(value, ["source", "title", "steps"], ["yieldText"]) &&
    isWebSourceDraft(value.source) && hasValidRecipeBody(value);
}

export function isResearchRecipeProviderOutput(
  value: unknown,
): value is ResearchRecipeProviderOutput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["source", "title", "yieldText", "steps"]) ||
    !isWebSourceDraft(value.source) ||
    !isBoundedTrimmedText(value.title, RESEARCH_TITLE_LENGTH) ||
    (value.yieldText !== null &&
      !isBoundedTrimmedText(value.yieldText, RESEARCH_YIELD_LENGTH)) ||
    !Array.isArray(value.steps) || value.steps.length < 1 ||
    value.steps.length > RESEARCH_STEP_LIMIT
  ) return false;
  let totalInputs = 0;
  for (const step of value.steps) {
    if (
      !isRecord(step) ||
      !hasExactKeys(step, ["inputs", "instruction", "timerDurationSeconds"]) ||
      !Array.isArray(step.inputs) || step.inputs.length > RESEARCH_STEP_INPUT_LIMIT ||
      !step.inputs.every(isSourcedRecipeInput) ||
      !isBoundedTrimmedText(step.instruction, RESEARCH_INSTRUCTION_LENGTH) ||
      (step.timerDurationSeconds !== null &&
        (!Number.isSafeInteger(step.timerDurationSeconds) ||
          Number(step.timerDurationSeconds) < 1 ||
          Number(step.timerDurationSeconds) > RESEARCH_TIMER_DURATION_LIMIT))
    ) return false;
    totalInputs += step.inputs.length;
  }
  return totalInputs <= RESEARCH_TOTAL_INPUT_LIMIT;
}

export function normalizeResearchRecipeProviderOutput(
  value: unknown,
): ResearchRecipeDraft {
  if (!isResearchRecipeProviderOutput(value)) {
    throw new TypeError("Research output did not match the closed provider recipe contract.");
  }
  const normalized: ResearchRecipeDraft = {
    source: { ...value.source },
    title: value.title,
    ...(value.yieldText === null ? {} : { yieldText: value.yieldText }),
    steps: value.steps.map((step) => ({
      inputs: step.inputs.map((input) => ({ ...input })),
      instruction: step.instruction,
      ...(step.timerDurationSeconds === null
        ? {}
        : { timerDurationSeconds: step.timerDurationSeconds }),
    })),
  };
  if (!isResearchRecipeDraft(normalized)) {
    throw new TypeError("Normalized research output did not match the canonical recipe draft.");
  }
  return normalized;
}

function freezeCandidate(candidate: ResearchRecipeCandidate): ResearchRecipeCandidate {
  Object.freeze(candidate.source);
  for (const step of candidate.steps) {
    for (const input of step.inputs) Object.freeze(input);
    Object.freeze(step.inputs);
    Object.freeze(step);
  }
  Object.freeze(candidate.steps);
  return Object.freeze(candidate);
}

export function isResearchRecipeCandidate(
  value: unknown,
): value is ResearchRecipeCandidate {
  return isRecord(value) &&
    hasExactKeys(
      value,
      ["schemaVersion", "candidateId", "source", "title", "steps"],
      ["yieldText"],
    ) &&
    value.schemaVersion === RESEARCH_RECIPE_SCHEMA_VERSION &&
    isBoundedTrimmedText(value.candidateId, RESEARCH_CANDIDATE_ID_LENGTH) &&
    isSourceRecipe(value.source) && hasValidRecipeBody(value) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= RESEARCH_CANDIDATE_BYTES_LIMIT;
}

export function materializeResearchRecipeCandidate(
  draftValue: unknown,
  idFactory: ResearchCandidateIdFactory,
  clock: ResearchCandidateClock,
): ResearchRecipeCandidate {
  if (!isResearchRecipeDraft(draftValue)) {
    throw new TypeError("Research recipe draft is invalid.");
  }
  const candidate: ResearchRecipeCandidate = {
    schemaVersion: RESEARCH_RECIPE_SCHEMA_VERSION,
    candidateId: idFactory.createId("research-candidate"),
    source: {
      ...draftValue.source,
      retrievedAt: clock.now(),
    },
    title: draftValue.title,
    ...(draftValue.yieldText === undefined ? {} : { yieldText: draftValue.yieldText }),
    steps: draftValue.steps.map((step) => ({
      inputs: step.inputs.map((input) => ({ ...input })),
      instruction: step.instruction,
      ...(step.timerDurationSeconds === undefined
        ? {}
        : { timerDurationSeconds: step.timerDurationSeconds }),
    })),
  };
  if (!isResearchRecipeCandidate(candidate)) {
    throw new TypeError("Materialized research recipe candidate is invalid or oversized.");
  }
  return freezeCandidate(candidate);
}

export function isResearchCandidateReference(
  value: unknown,
): value is ResearchCandidateReference {
  if (!isRecord(value)) return false;
  const hasLegacyShape = hasExactKeys(
    value,
    ["schemaVersion", "candidateId", "title", "source", "stepCount"],
  );
  const hasDigestBoundShape = hasExactKeys(
    value,
    [
      "schemaVersion",
      "candidateId",
      "title",
      "source",
      "stepCount",
      "digestVersion",
      "replacementDigest",
    ],
  );
  return (hasLegacyShape || hasDigestBoundShape) &&
    value.schemaVersion === RESEARCH_RECIPE_SCHEMA_VERSION &&
    isBoundedTrimmedText(value.candidateId, RESEARCH_CANDIDATE_ID_LENGTH) &&
    isBoundedTrimmedText(value.title, RESEARCH_TITLE_LENGTH) &&
    isSourceRecipe(value.source) &&
    Number.isSafeInteger(value.stepCount) && Number(value.stepCount) >= 1 &&
    Number(value.stepCount) <= RESEARCH_STEP_LIMIT &&
    (hasLegacyShape || (
      value.digestVersion === RESEARCH_REPLACEMENT_DIGEST_VERSION &&
      isResearchReplacementDigest(value.replacementDigest)
    ));
}

export function isDigestBoundResearchCandidateReference(
  value: unknown,
): value is DigestBoundResearchCandidateReference {
  return isResearchCandidateReference(value) &&
    Object.hasOwn(value, "digestVersion") &&
    Object.hasOwn(value, "replacementDigest");
}

export function isResearchReplacementDigest(value: unknown): value is string {
  return typeof value === "string" &&
    value.length === RESEARCH_REPLACEMENT_DIGEST_LENGTH &&
    /^[0-9a-f]+$/.test(value);
}

export function projectResearchCandidateReference(
  candidate: ResearchRecipeCandidate,
  replacementDigest: string,
): DigestBoundResearchCandidateReference {
  if (!isResearchRecipeCandidate(candidate)) {
    throw new TypeError("Cannot project an invalid research candidate.");
  }
  if (!isResearchReplacementDigest(replacementDigest)) {
    throw new TypeError("Cannot bind a research candidate to an invalid replacement digest.");
  }
  const reference = {
    schemaVersion: RESEARCH_RECIPE_SCHEMA_VERSION,
    candidateId: candidate.candidateId,
    title: candidate.title,
    source: { ...candidate.source },
    stepCount: candidate.steps.length,
    digestVersion: RESEARCH_REPLACEMENT_DIGEST_VERSION,
    replacementDigest,
  } satisfies DigestBoundResearchCandidateReference;
  Object.freeze(reference.source);
  return Object.freeze(reference);
}

export function isSourcedRecipeReplacement(
  value: unknown,
): value is SourcedRecipeReplacement {
  if (!(isRecord(value) &&
    hasExactKeys(value, ["title", "source", "occurrences", "steps"], ["yieldText"]) &&
    isBoundedTrimmedText(value.title, RESEARCH_TITLE_LENGTH) &&
    (!Object.hasOwn(value, "yieldText") || isBoundedTrimmedText(value.yieldText, RESEARCH_YIELD_LENGTH)) &&
    isSourceRecipe(value.source) && Array.isArray(value.occurrences) &&
    value.occurrences.every((occurrence) => isIngredientOccurrenceEdit(occurrence) && occurrence.kind === "create" &&
      hasExactKeys(occurrence, ["kind", "correlationId", "source", "amount", "unit", "ingredient", "qualifier", "conceptId", "canonicalIngredientId"]) &&
      isBoundedTrimmedText(occurrence.correlationId, 200) &&
      (occurrence.source === null || isBoundedTrimmedText(occurrence.source, RESEARCH_SOURCE_IDENTITY_LENGTH)) &&
      occurrence.amount.length <= RESEARCH_AMOUNT_LENGTH &&
      (occurrence.unit === null || occurrence.unit.length <= RESEARCH_AMOUNT_LENGTH) &&
      isBoundedTrimmedText(occurrence.ingredient, RESEARCH_INGREDIENT_LENGTH) &&
      (occurrence.qualifier === null || occurrence.qualifier.length <= RESEARCH_INGREDIENT_LENGTH) &&
      (occurrence.conceptId === null || occurrence.conceptId.length <= 200) &&
      (occurrence.canonicalIngredientId === null || (Number.isSafeInteger(occurrence.canonicalIngredientId) && Number(occurrence.canonicalIngredientId) > 0))) &&
    Array.isArray(value.steps) && value.steps.length >= 1 && value.steps.length <= RESEARCH_STEP_LIMIT &&
    value.steps.every((step) => isRecord(step) && hasExactKeys(step, ["inputs", "instruction"], ["timerDurationSeconds", "note"]) &&
      Array.isArray(step.inputs) && step.inputs.length <= RESEARCH_STEP_INPUT_LIMIT &&
      step.inputs.every((input) => isRecord(input) &&
        hasExactKeys(input, ["occurrenceCorrelationId", "amount", "ingredient"]) &&
        isBoundedTrimmedText(input.occurrenceCorrelationId, 200) &&
        isBoundedTrimmedText(input.amount, RESEARCH_AMOUNT_LENGTH) &&
        isSingleLine(input.amount) &&
        isBoundedTrimmedText(input.ingredient, RESEARCH_INGREDIENT_LENGTH) &&
        isSingleLine(input.ingredient)) &&
      isBoundedTrimmedText(step.instruction, RESEARCH_INSTRUCTION_LENGTH) &&
      (!Object.hasOwn(step, "timerDurationSeconds") ||
        (Number.isSafeInteger(step.timerDurationSeconds) &&
          Number(step.timerDurationSeconds) >= 1 &&
          Number(step.timerDurationSeconds) <= RESEARCH_TIMER_DURATION_LIMIT)) &&
      (!Object.hasOwn(step, "note") ||
        isBoundedTrimmedText(step.note, RESEARCH_INSTRUCTION_LENGTH))) &&
    value.steps.reduce((count, step) => count + step.inputs.length, 0) <= RESEARCH_TOTAL_INPUT_LIMIT)) return false;
  const candidate = value as SourcedRecipeReplacement;
  const correlations = candidate.occurrences.map((occurrence) => occurrence.correlationId);
  const correlationSet = new Set(correlations);
  return correlationSet.size === correlations.length &&
    candidate.steps.every((step) => {
      const inputCorrelations = step.inputs.map((input) => input.occurrenceCorrelationId);
      return inputCorrelations.every((correlation) => correlationSet.has(correlation));
    });
}

export function isLegacySourcedRecipeReplacement(
  value: unknown,
): value is LegacySourcedRecipeReplacement {
  return isRecord(value) &&
    hasExactKeys(value, ["title", "source", "steps"], ["yieldText"]) &&
    isBoundedTrimmedText(value.title, RESEARCH_TITLE_LENGTH) &&
    (value.yieldText === undefined || isBoundedTrimmedText(value.yieldText, RESEARCH_YIELD_LENGTH)) &&
    isSourceRecipe(value.source) &&
    Array.isArray(value.steps) && value.steps.length >= 1 && value.steps.length <= RESEARCH_STEP_LIMIT &&
    value.steps.every(isSourcedRecipeStep);
}

export function sourceRecipeEquals(left: SourceRecipe, right: SourceRecipe): boolean {
  return left.kind === right.kind && left.identity === right.identity &&
    left.url === right.url && left.retrievedAt === right.retrievedAt;
}

export function canonicalSourcedRecipeReplacementJson(
  replacement: SourcedRecipeReplacement,
): string {
  if (!isSourcedRecipeReplacement(replacement)) {
    throw new TypeError("Cannot canonicalize an invalid sourced recipe replacement.");
  }
  return JSON.stringify({
    schemaVersion: RESEARCH_REPLACEMENT_DIGEST_VERSION,
    title: replacement.title,
    yieldText: {
      present: Object.hasOwn(replacement, "yieldText"),
      value: replacement.yieldText ?? null,
    },
    source: {
      kind: replacement.source.kind,
      identity: replacement.source.identity,
      url: replacement.source.url,
      retrievedAt: replacement.source.retrievedAt,
    },
    occurrences: replacement.occurrences.map((occurrence) => ({
      correlationId: occurrence.correlationId,
      source: occurrence.source,
      amount: occurrence.amount,
      unit: occurrence.unit,
      ingredient: occurrence.ingredient,
      qualifier: occurrence.qualifier,
      conceptId: occurrence.conceptId,
      canonicalIngredientId: occurrence.canonicalIngredientId,
    })),
    steps: replacement.steps.map((step) => ({
      inputs: step.inputs.map((input) => ({
        occurrenceCorrelationId: input.occurrenceCorrelationId,
        amount: input.amount,
        ingredient: input.ingredient,
      })),
      instruction: step.instruction,
      timerDurationSeconds: {
        present: Object.hasOwn(step, "timerDurationSeconds"),
        value: step.timerDurationSeconds ?? null,
      },
    })),
  });
}

export function candidateMatchesReference(
  candidate: ResearchRecipeCandidate,
  reference: ResearchCandidateReference,
  replacementDigest: string,
): boolean {
  return isResearchRecipeCandidate(candidate) &&
    isDigestBoundResearchCandidateReference(reference) &&
    isResearchReplacementDigest(replacementDigest) &&
    reference.replacementDigest === replacementDigest &&
    candidate.schemaVersion === reference.schemaVersion &&
    candidate.candidateId === reference.candidateId &&
    candidate.title === reference.title &&
    candidate.steps.length === reference.stepCount &&
    sourceRecipeEquals(candidate.source, reference.source);
}

export function sourcedReplacementFromCandidate(
  candidate: ResearchRecipeCandidate,
): SourcedRecipeReplacement {
  if (!isResearchRecipeCandidate(candidate)) {
    throw new TypeError("Cannot project an invalid research candidate.");
  }
  const occurrenceRows = candidate.steps.flatMap((step, stepIndex) =>
    step.inputs.map((input, inputIndex) => ({
      correlationId: `candidate.${stepIndex}.${inputIndex}`,
      input,
    })),
  );
  return {
    title: candidate.title,
    ...(candidate.yieldText === undefined ? {} : { yieldText: candidate.yieldText }),
    source: { ...candidate.source },
    occurrences: occurrenceRows.map(({ correlationId, input }) => ({
      kind: "create" as const,
      correlationId,
      source: null,
      amount: input.amount,
      unit: null,
      ingredient: input.ingredient,
      qualifier: null,
      conceptId: null,
      canonicalIngredientId: null,
    })),
    steps: candidate.steps.map((step, stepIndex) => ({
      inputs: step.inputs.map((input, inputIndex) => ({
        occurrenceCorrelationId: `candidate.${stepIndex}.${inputIndex}`,
        ...input,
      })),
      instruction: step.instruction,
      ...(step.timerDurationSeconds === undefined
        ? {}
        : { timerDurationSeconds: step.timerDurationSeconds }),
    })),
  };
}

export function authorizeEmbeddedSourcedReplacements(
  operations: readonly { command: unknown }[],
  candidate: ResearchRecipeCandidate | null,
  reference: ResearchCandidateReference | null,
  candidateReplacementDigest: string | null,
): { ok: true } | { ok: false; operationIndex: number; message: string } {
  for (const [operationIndex, operation] of operations.entries()) {
    const command = operation.command;
    if (!isRecord(command) || command.type !== "replaceMealRecipeFromSource") continue;
    if (
      candidate === null || reference === null ||
      !isResearchRecipeCandidate(candidate) ||
      !isDigestBoundResearchCandidateReference(reference) ||
      candidateReplacementDigest === null ||
      !candidateMatchesReference(candidate, reference, candidateReplacementDigest) ||
      !isSourcedRecipeReplacement(command.recipe) ||
      canonicalSourcedRecipeReplacementJson(command.recipe) !==
        canonicalSourcedRecipeReplacementJson(sourcedReplacementFromCandidate(candidate))
    ) {
      return {
        ok: false,
        operationIndex,
        message: "Sourced recipe replacement lost its exact research-candidate binding.",
      };
    }
  }
  return { ok: true };
}
import { isIngredientOccurrenceEdit } from "./ingredient-occurrence.ts";
