import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  RESEARCH_AMOUNT_LENGTH,
  RESEARCH_CANDIDATE_BYTES_LIMIT,
  RESEARCH_CANDIDATE_ID_LENGTH,
  RESEARCH_INGREDIENT_LENGTH,
  RESEARCH_INSTRUCTION_LENGTH,
  RESEARCH_RECIPE_PROVIDER_OUTPUT_SCHEMA,
  RESEARCH_REPLACEMENT_DIGEST_VERSION,
  RESEARCH_SOURCE_IDENTITY_LENGTH,
  RESEARCH_SOURCE_URL_LENGTH,
  RESEARCH_STEP_INPUT_LIMIT,
  RESEARCH_STEP_LIMIT,
  RESEARCH_TIMER_DURATION_LIMIT,
  RESEARCH_TITLE_LENGTH,
  RESEARCH_TOTAL_INPUT_LIMIT,
  RESEARCH_YIELD_LENGTH,
  authorizeEmbeddedSourcedReplacements,
  canonicalSourcedRecipeReplacementJson,
  candidateMatchesReference,
  isDigestBoundResearchCandidateReference,
  isResearchCandidateReference,
  isResearchRecipeCandidate,
  isResearchRecipeDraft,
  isResearchRecipeProviderOutput,
  isSourcedRecipeReplacement,
  materializeResearchRecipeCandidate,
  normalizeResearchRecipeProviderOutput,
  projectResearchCandidateReference,
  sourceRecipeEquals,
  sourcedReplacementFromCandidate,
} from "../lib/sourced-recipe-contract.ts";
import { isChatResearchLifecycle } from "../lib/planner-chat-contract.ts";

const source = {
  kind: "web",
  identity: "Example Kitchen",
  url: "https://example.com/recipes/soup",
};

function provider(overrides = {}) {
  return {
    source,
    title: "Weeknight soup",
    yieldText: null,
    steps: [{
      inputs: [{ amount: "1 cup", ingredient: "red lentils" }],
      instruction: "Simmer until tender.",
      timerDurationSeconds: null,
    }],
    ...overrides,
  };
}

function replacementDigest(candidate) {
  return createHash("sha256").update(
    canonicalSourcedRecipeReplacementJson(sourcedReplacementFromCandidate(candidate)),
  ).digest("hex");
}

const ids = { createId: () => "research-candidate-1" };
const clock = { now: () => 1_750_000_000_000 };

test("provider projection requires nullable optionals and normalizes only null omission", () => {
  assert.deepEqual(RESEARCH_RECIPE_PROVIDER_OUTPUT_SCHEMA.required, [
    "source",
    "title",
    "yieldText",
    "steps",
  ]);
  const raw = provider();
  assert.equal(isResearchRecipeProviderOutput(raw), true);
  assert.deepEqual(normalizeResearchRecipeProviderOutput(raw), {
    source,
    title: "Weeknight soup",
    steps: [{
      inputs: [{ amount: "1 cup", ingredient: "red lentils" }],
      instruction: "Simmer until tender.",
    }],
  });
  assert.equal(isResearchRecipeProviderOutput({ ...raw, yieldText: undefined }), false);
  assert.equal(isResearchRecipeProviderOutput({ ...raw, artifact: "page body" }), false);
  assert.equal(isResearchRecipeProviderOutput({
    ...raw,
    steps: [{ ...raw.steps[0], timerDurationSeconds: undefined }],
  }), false);
});

test("chat research lifecycle is a closed discriminated matrix", () => {
  const legacyReference = {
    schemaVersion: 1,
    candidateId: "research-candidate-1",
    title: "Soup",
    source: {
      kind: "web",
      identity: "Example Kitchen",
      url: "https://example.com/recipes/soup",
      retrievedAt: 1,
    },
    stepCount: 1,
  };
  const reference = {
    ...legacyReference,
    digestVersion: RESEARCH_REPLACEMENT_DIGEST_VERSION,
    replacementDigest: "a".repeat(64),
  };
  for (const valid of [
    { mode: "normal", researchKind: "none", researchCandidate: null },
    { mode: "normal", researchKind: "sourced_recipe", researchCandidate: null },
    { mode: "normal", researchKind: "sourced_recipe", researchCandidate: reference },
    { mode: "normal", researchKind: "sourced_recipe", researchCandidate: legacyReference },
    { mode: "recovery", researchKind: "none", researchCandidate: null },
  ]) assert.equal(isChatResearchLifecycle(valid), true);
  for (const invalid of [
    { mode: "recovery", researchKind: "sourced_recipe", researchCandidate: null },
    { mode: "recovery", researchKind: "none", researchCandidate: reference },
    { mode: "normal", researchKind: "none", researchCandidate: reference },
  ]) assert.equal(isChatResearchLifecycle(invalid), false);
});

test("draft validation closes keys, source URL serialization, strings, and input bounds", () => {
  const draft = normalizeResearchRecipeProviderOutput(provider({ yieldText: "4 bowls" }));
  assert.equal(isResearchRecipeDraft(draft), true);
  assert.equal(isResearchRecipeDraft({ ...draft, yieldText: undefined }), false);
  assert.equal(isResearchRecipeDraft({
    ...draft,
    steps: [{ ...draft.steps[0], timerDurationSeconds: undefined }],
  }), false);
  for (const badUrl of [
    "https://example.com",
    "ftp://example.com/recipe",
    "https://user:secret@example.com/recipe",
    "https://example.com/recipe#",
    "https://example.com/recipe#method",
  ]) {
    assert.equal(isResearchRecipeDraft({
      ...draft,
      source: { ...draft.source, url: badUrl },
    }), false, badUrl);
  }
  assert.equal(isResearchRecipeDraft({
    ...draft,
    source: { ...draft.source, url: "https://example.com/recipe%23method" },
  }), true, "percent-encoded fragment data is not a URL fragment delimiter");
  assert.equal(isResearchRecipeDraft({
    ...draft,
    steps: [{ ...draft.steps[0], inputs: [{ amount: " 1 cup", ingredient: "rice" }] }],
  }), false);
  assert.equal(isResearchRecipeDraft({
    ...draft,
    steps: [{ ...draft.steps[0], inputs: [{ amount: "1\ncup", ingredient: "rice" }] }],
  }), false);
  for (const forbidden of ["html", "markdown", "pageBody", "excerpt", "metadata", "attachment"]) {
    assert.equal(isResearchRecipeDraft({ ...draft, [forbidden]: "untrusted" }), false);
  }
});

test("every sourced-recipe field and collection accepts its maximum and rejects max plus one", () => {
  const maxUrl = `https://example.com/${"u".repeat(
    RESEARCH_SOURCE_URL_LENGTH - "https://example.com/".length,
  )}`;
  const cases = [
    {
      label: "source identity",
      accepted: provider({ source: { ...source, identity: "i".repeat(RESEARCH_SOURCE_IDENTITY_LENGTH) } }),
      rejected: provider({ source: { ...source, identity: "i".repeat(RESEARCH_SOURCE_IDENTITY_LENGTH + 1) } }),
    },
    {
      label: "source URL",
      accepted: provider({ source: { ...source, url: maxUrl } }),
      rejected: provider({ source: { ...source, url: `${maxUrl}u` } }),
    },
    {
      label: "title",
      accepted: provider({ title: "t".repeat(RESEARCH_TITLE_LENGTH) }),
      rejected: provider({ title: "t".repeat(RESEARCH_TITLE_LENGTH + 1) }),
    },
    {
      label: "yield",
      accepted: provider({ yieldText: "y".repeat(RESEARCH_YIELD_LENGTH) }),
      rejected: provider({ yieldText: "y".repeat(RESEARCH_YIELD_LENGTH + 1) }),
    },
    {
      label: "amount",
      accepted: provider({ steps: [{ inputs: [{ amount: "a".repeat(RESEARCH_AMOUNT_LENGTH), ingredient: "rice" }], instruction: "Mix.", timerDurationSeconds: null }] }),
      rejected: provider({ steps: [{ inputs: [{ amount: "a".repeat(RESEARCH_AMOUNT_LENGTH + 1), ingredient: "rice" }], instruction: "Mix.", timerDurationSeconds: null }] }),
    },
    {
      label: "ingredient",
      accepted: provider({ steps: [{ inputs: [{ amount: "1", ingredient: "i".repeat(RESEARCH_INGREDIENT_LENGTH) }], instruction: "Mix.", timerDurationSeconds: null }] }),
      rejected: provider({ steps: [{ inputs: [{ amount: "1", ingredient: "i".repeat(RESEARCH_INGREDIENT_LENGTH + 1) }], instruction: "Mix.", timerDurationSeconds: null }] }),
    },
    {
      label: "instruction",
      accepted: provider({ steps: [{ inputs: [], instruction: "s".repeat(RESEARCH_INSTRUCTION_LENGTH), timerDurationSeconds: null }] }),
      rejected: provider({ steps: [{ inputs: [], instruction: "s".repeat(RESEARCH_INSTRUCTION_LENGTH + 1), timerDurationSeconds: null }] }),
    },
    {
      label: "timer",
      accepted: provider({ steps: [{ inputs: [], instruction: "Wait.", timerDurationSeconds: RESEARCH_TIMER_DURATION_LIMIT }] }),
      rejected: provider({ steps: [{ inputs: [], instruction: "Wait.", timerDurationSeconds: RESEARCH_TIMER_DURATION_LIMIT + 1 }] }),
    },
    {
      label: "inputs per step",
      accepted: provider({ steps: [{ inputs: Array.from({ length: RESEARCH_STEP_INPUT_LIMIT }, () => ({ amount: "1", ingredient: "x" })), instruction: "Mix.", timerDurationSeconds: null }] }),
      rejected: provider({ steps: [{ inputs: Array.from({ length: RESEARCH_STEP_INPUT_LIMIT + 1 }, () => ({ amount: "1", ingredient: "x" })), instruction: "Mix.", timerDurationSeconds: null }] }),
    },
    {
      label: "steps",
      accepted: provider({ steps: Array.from({ length: RESEARCH_STEP_LIMIT }, () => ({ inputs: [], instruction: "Mix.", timerDurationSeconds: null })) }),
      rejected: provider({ steps: Array.from({ length: RESEARCH_STEP_LIMIT + 1 }, () => ({ inputs: [], instruction: "Mix.", timerDurationSeconds: null })) }),
    },
  ];
  for (const { label, accepted, rejected } of cases) {
    assert.equal(isResearchRecipeProviderOutput(accepted), true, `${label} maximum`);
    assert.equal(isResearchRecipeProviderOutput(rejected), false, `${label} maximum plus one`);
  }

  for (const count of [0, 1, RESEARCH_STEP_LIMIT, RESEARCH_STEP_LIMIT + 1]) {
    assert.equal(
      isResearchRecipeProviderOutput(provider({
        steps: Array.from({ length: count }, () => ({
          inputs: [], instruction: "Mix.", timerDurationSeconds: null,
        })),
      })),
      count >= 1 && count <= RESEARCH_STEP_LIMIT,
      `${count} steps`,
    );
  }
  for (const count of [0, 1, RESEARCH_STEP_INPUT_LIMIT, RESEARCH_STEP_INPUT_LIMIT + 1]) {
    assert.equal(
      isResearchRecipeProviderOutput(provider({
        steps: [{
          inputs: Array.from({ length: count }, () => ({ amount: "1", ingredient: "x" })),
          instruction: "Mix.",
          timerDurationSeconds: null,
        }],
      })),
      count <= RESEARCH_STEP_INPUT_LIMIT,
      `${count} inputs in one step`,
    );
  }
});

test("aggregate input, candidate identity, timestamp, nested keys, and exact UTF-8 byte limits are closed", () => {
  const aggregate = (total) => provider({
    steps: Array.from({ length: Math.ceil(total / RESEARCH_STEP_INPUT_LIMIT) }, (_, index) => ({
      inputs: Array.from({
        length: Math.min(RESEARCH_STEP_INPUT_LIMIT, total - index * RESEARCH_STEP_INPUT_LIMIT),
      }, () => ({ amount: "1", ingredient: "x" })),
      instruction: "Mix.",
      timerDurationSeconds: null,
    })),
  });
  assert.equal(isResearchRecipeProviderOutput(aggregate(RESEARCH_TOTAL_INPUT_LIMIT)), true);
  assert.equal(isResearchRecipeProviderOutput(aggregate(RESEARCH_TOTAL_INPUT_LIMIT + 1)), false);

  const draft = normalizeResearchRecipeProviderOutput(provider());
  const materialized = (candidateId, retrievedAt) => materializeResearchRecipeCandidate(
    draft,
    { createId: () => candidateId },
    { now: () => retrievedAt },
  );
  assert.equal(
    materialized("c".repeat(RESEARCH_CANDIDATE_ID_LENGTH), Number.MAX_SAFE_INTEGER).candidateId.length,
    RESEARCH_CANDIDATE_ID_LENGTH,
  );
  assert.throws(() => materialized("c".repeat(RESEARCH_CANDIDATE_ID_LENGTH + 1), 1), /invalid/i);
  assert.throws(() => materialized("", 1), /invalid/i);
  assert.throws(() => materialized("candidate", Number.MAX_SAFE_INTEGER + 1), /invalid/i);
  assert.throws(() => materialized("candidate", -1), /invalid/i);

  for (const lowerBound of [
    provider({ source: { ...source, identity: "" } }),
    provider({ title: "" }),
    provider({ yieldText: "" }),
    provider({ steps: [{ inputs: [{ amount: "", ingredient: "x" }], instruction: "Mix.", timerDurationSeconds: null }] }),
    provider({ steps: [{ inputs: [{ amount: "1", ingredient: "" }], instruction: "Mix.", timerDurationSeconds: null }] }),
    provider({ steps: [{ inputs: [], instruction: "", timerDurationSeconds: null }] }),
    provider({ steps: [{ inputs: [], instruction: "Wait.", timerDurationSeconds: 0 }] }),
    provider({ steps: [{ inputs: [], instruction: "Wait.", timerDurationSeconds: 1.5 }] }),
  ]) assert.equal(isResearchRecipeProviderOutput(lowerBound), false);

  for (const nested of [
    provider({ source: { ...source, rawPage: "no" } }),
    provider({ steps: [{ inputs: [], instruction: "Mix.", timerDurationSeconds: null, excerpt: "no" }] }),
    provider({ steps: [{ inputs: [{ amount: "1", ingredient: "x", unit: "cup" }], instruction: "Mix.", timerDurationSeconds: null }] }),
  ]) assert.equal(isResearchRecipeProviderOutput(nested), false);

  const candidate = materialized("candidate", 1);
  const reference = projectResearchCandidateReference(candidate, replacementDigest(candidate));
  assert.equal(isResearchRecipeCandidate({ ...candidate, pageBody: "no" }), false);
  assert.equal(isResearchCandidateReference({ ...reference, excerpt: "no" }), false);

  const exactCandidate = {
    schemaVersion: 1,
    candidateId: "candidate",
    source: { ...source, retrievedAt: 1 },
    title: "Recipe",
    steps: Array.from({ length: RESEARCH_STEP_LIMIT }, () => ({
      inputs: [],
      instruction: "x",
    })),
  };
  let remaining = RESEARCH_CANDIDATE_BYTES_LIMIT -
    Buffer.byteLength(JSON.stringify(exactCandidate), "utf8");
  for (const step of exactCandidate.steps) {
    const extra = Math.min(remaining, RESEARCH_INSTRUCTION_LENGTH - step.instruction.length);
    step.instruction += "x".repeat(extra);
    remaining -= extra;
  }
  assert.equal(remaining, 0, "fixture can reach the byte limit within field limits");
  assert.equal(Buffer.byteLength(JSON.stringify(exactCandidate), "utf8"), RESEARCH_CANDIDATE_BYTES_LIMIT);
  assert.equal(isResearchRecipeCandidate(exactCandidate), true);
  const expandable = exactCandidate.steps.find((step) => step.instruction.length < RESEARCH_INSTRUCTION_LENGTH);
  assert.ok(expandable);
  expandable.instruction += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(exactCandidate), "utf8"), RESEARCH_CANDIDATE_BYTES_LIMIT + 1);
  assert.equal(isResearchRecipeCandidate(exactCandidate), false);
});

test("aggregate inputs and post-materialization UTF-8 bytes are independently bounded", () => {
  const aggregate = provider({
    steps: Array.from({ length: 11 }, (_, stepIndex) => ({
      inputs: Array.from({ length: stepIndex === 10 ? 9 : 12 }, () => ({
        amount: "1 tsp",
        ingredient: "spice",
      })),
      instruction: "Mix.",
      timerDurationSeconds: null,
    })),
  });
  assert.equal(aggregate.steps.reduce((sum, step) => sum + step.inputs.length, 0), 129);
  assert.equal(isResearchRecipeProviderOutput(aggregate), false);

  const within = provider({
    steps: Array.from({ length: 16 }, () => ({
      inputs: [],
      instruction: "é".repeat(900),
      timerDurationSeconds: null,
    })),
  });
  const accepted = materializeResearchRecipeCandidate(
    normalizeResearchRecipeProviderOutput(within),
    ids,
    clock,
  );
  assert.equal(Buffer.byteLength(JSON.stringify(accepted), "utf8") <= RESEARCH_CANDIDATE_BYTES_LIMIT, true);
  assert.equal(Object.isFrozen(accepted), true);

  const oversized = provider({
    steps: Array.from({ length: 18 }, () => ({
      inputs: [],
      instruction: "é".repeat(900),
      timerDurationSeconds: null,
    })),
  });
  assert.throws(
    () => materializeResearchRecipeCandidate(
      normalizeResearchRecipeProviderOutput(oversized),
      ids,
      clock,
    ),
    /oversized/i,
  );
});

test("host materialization, digest-bound compact reference, and replacement omit candidate identity", () => {
  const candidate = materializeResearchRecipeCandidate(
    normalizeResearchRecipeProviderOutput(provider({
      yieldText: "4 bowls",
      steps: [{
        inputs: [
          { amount: "1 cup", ingredient: "lentils" },
          { amount: "1 cup", ingredient: "lentils" },
        ],
        instruction: "Simmer.",
        timerDurationSeconds: 900,
      }],
    })),
    ids,
    clock,
  );
  assert.equal(isResearchRecipeCandidate(candidate), true);
  const digest = replacementDigest(candidate);
  const reference = projectResearchCandidateReference(candidate, digest);
  assert.equal(isDigestBoundResearchCandidateReference(reference), true);
  assert.equal(candidateMatchesReference(candidate, reference, digest), true);
  assert.equal(sourceRecipeEquals(candidate.source, reference.source), true);
  assert.equal(candidateMatchesReference(candidate, { ...reference, stepCount: 2 }, digest), false);
  assert.equal(candidateMatchesReference(candidate, { ...reference, replacementDigest: undefined }, digest), false);
  assert.equal(candidateMatchesReference(candidate, {
    schemaVersion: reference.schemaVersion,
    candidateId: reference.candidateId,
    title: reference.title,
    source: reference.source,
    stepCount: reference.stepCount,
  }, digest), false, "legacy digestless references remain readable but cannot authorize");
  const replacement = sourcedReplacementFromCandidate(candidate);
  assert.equal(isSourcedRecipeReplacement(replacement), true);
  assert.equal(isSourcedRecipeReplacement({ ...replacement, yieldText: undefined }), false);
  assert.equal(isSourcedRecipeReplacement({
    ...replacement,
    steps: [{ ...replacement.steps[0], timerDurationSeconds: undefined }],
  }), false);
  assert.equal("candidateId" in replacement, false);
  assert.equal(JSON.stringify(replacement).includes("research-candidate-1"), false);
  assert.equal(isSourcedRecipeReplacement({ ...replacement, candidateId: candidate.candidateId }), false);
  const operation = { command: {
    type: "replaceMealRecipeFromSource",
    weekId: "2026-07-06",
    mealId: "meal-1",
    recipe: replacement,
  } };
  assert.deepEqual(authorizeEmbeddedSourcedReplacements(
    [operation], candidate, reference, digest,
  ), { ok: true });
  assert.equal(authorizeEmbeddedSourcedReplacements(
    [operation], null, reference, digest,
  ).ok, false, "lost turn-local candidate cannot be reconstructed from compact reference");
  assert.equal(authorizeEmbeddedSourcedReplacements(
    [{ command: { ...operation.command, recipe: {
      ...replacement,
      source: { ...replacement.source, retrievedAt: replacement.source.retrievedAt + 1 },
    } } }],
    candidate,
    reference,
    digest,
  ).ok, false, "source tuple mismatch fails closed");
  assert.equal(authorizeEmbeddedSourcedReplacements(
    [{ command: { ...operation.command, recipe: {
      ...replacement,
      steps: [{ ...replacement.steps[0], instruction: "Changed after research." }],
    } } }],
    candidate,
    reference,
    digest,
  ).ok, false, "changed recipe body fails closed");
});

test("canonical candidate binding rejects every executable recipe-body mutation", () => {
  const candidate = materializeResearchRecipeCandidate(
    normalizeResearchRecipeProviderOutput(provider({
      title: "Bound soup",
      yieldText: "4 bowls",
      steps: [
        {
          inputs: [
            { amount: "1 cup", ingredient: "red lentils" },
            { amount: "2 cups", ingredient: "water" },
          ],
          instruction: "Simmer the lentils.",
          timerDurationSeconds: 900,
        },
        {
          inputs: [{ amount: "1 tsp", ingredient: "salt" }],
          instruction: "Season and serve.",
          timerDurationSeconds: null,
        },
      ],
    })),
    ids,
    clock,
  );
  const replacement = sourcedReplacementFromCandidate(candidate);
  const digest = replacementDigest(candidate);
  const reference = projectResearchCandidateReference(candidate, digest);
  const canonical = JSON.parse(canonicalSourcedRecipeReplacementJson(replacement));
  assert.deepEqual(canonical.yieldText, { present: true, value: "4 bowls" });
  assert.deepEqual(canonical.steps.map((step) => step.timerDurationSeconds), [
    { present: true, value: 900 },
    { present: false, value: null },
  ]);
  assert.equal(reference.replacementDigest, digest);

  const mutations = new Map([
    ["title", (recipe) => { recipe.title = "Altered soup"; }],
    ["yield value", (recipe) => { recipe.yieldText = "6 bowls"; }],
    ["yield presence", (recipe) => { delete recipe.yieldText; }],
    ["source identity", (recipe) => { recipe.source.identity = "Other Kitchen"; }],
    ["source URL", (recipe) => { recipe.source.url = "https://example.com/recipes/other"; }],
    ["source retrieval time", (recipe) => { recipe.source.retrievedAt += 1; }],
    ["step count", (recipe) => { recipe.steps.pop(); }],
    ["step order", (recipe) => { recipe.steps.reverse(); }],
    ["input count", (recipe) => { recipe.steps[0].inputs.pop(); }],
    ["input order", (recipe) => { recipe.steps[0].inputs.reverse(); }],
    ["input amount", (recipe) => { recipe.steps[0].inputs[0].amount = "3 cups"; }],
    ["input ingredient", (recipe) => { recipe.steps[0].inputs[0].ingredient = "green lentils"; }],
    ["instruction", (recipe) => { recipe.steps[0].instruction = "Boil rapidly."; }],
    ["timer value", (recipe) => { recipe.steps[0].timerDurationSeconds = 901; }],
    ["timer presence", (recipe) => { delete recipe.steps[0].timerDurationSeconds; }],
  ]);
  for (const [name, mutate] of mutations) {
    const changed = structuredClone(replacement);
    mutate(changed);
    const authorization = authorizeEmbeddedSourcedReplacements(
      [{ command: {
        type: "replaceMealRecipeFromSource",
        weekId: "2026-07-06",
        mealId: "meal-1",
        recipe: changed,
      } }],
      candidate,
      reference,
      digest,
    );
    assert.equal(authorization.ok, false, name);
    assert.equal(authorization.operationIndex, 0, name);
  }

  const changedCandidate = structuredClone(candidate);
  changedCandidate.steps[0].instruction = "Candidate body was replaced.";
  assert.equal(
    candidateMatchesReference(
      changedCandidate,
      reference,
      replacementDigest(changedCandidate),
    ),
    false,
    "a same-ID candidate body cannot satisfy the persisted digest",
  );
});
