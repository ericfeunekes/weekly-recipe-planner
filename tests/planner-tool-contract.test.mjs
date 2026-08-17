import assert from "node:assert/strict";
import test from "node:test";

import Ajv from "ajv";

import { HOUSEHOLD_COMMAND_REGISTRY } from "../lib/household-command-contract.ts";
import {
  PLANNER_DYNAMIC_TOOL_NAMESPACE,
  PLANNER_TOOL_AUTHORITY_MANIFEST,
  PLANNER_TOOL_NAMES,
  authorizePlannerOperations,
  createPlannerToolSuccess,
  createPlannerToolFailure,
  freezeForegroundAuthority,
  isPlannerApplyArguments,
  isPlannerReadArguments,
  isPlannerReadProjection,
  isPlannerPreviewData,
  isPlannerToolResult,
  isPlannerToolResultForTool,
  projectPlannerRead,
  serializePlannerToolResult,
} from "../lib/planner-tool-contract.ts";

const archive = {
  command: { type: "archiveWeek", weekId: "2026-07-06" },
};

function workspace() {
  return {
    initialized: true,
    schemaVersion: 5,
    plannerVersion: 7,
    syncRevision: 11,
    state: {
      householdTimeZone: "America/Halifax",
      activeWeekId: "2026-07-06",
      ingredientCatalogue: {
        revision: 9,
        concepts: [{ id: "test-rice", preferredLabel: "Test rice", vocabulary: ["fixture rice"], defaultSection: "Pantry" }],
      },
      weeks: [{
        id: "2026-07-06",
        weekStartDate: "2026-07-06",
        status: "active",
        data: {
          meals: [{
            id: "meal-1",
            date: "2026-07-07",
            slot: "dinner",
            title: "Rice bowls",
            subtitle: "",
            venue: "Home",
            status: "planned",
            protein: "none",
            prepNote: "",
            leftoverNote: "",
            notes: "",
            ingredients: [],
            instructions: [],
          }],
          prepSessions: [],
          groceries: [],
          leftovers: [],
          feedback: {},
          weekLesson: "",
        },
      }],
    },
    events: [{
      sequence: 1,
      eventId: "event-1",
      requestId: "secret-idempotency-key",
      actor: "Household",
      provenance: {
        actorClass: "household",
        actorSource: "browser",
        admission: "same_origin_http_v1",
      },
      command: { type: "activateWeek", weekId: "2026-07-06" },
      baseVersion: 6,
      resultVersion: 7,
      summary: "Activated week",
      target: "2026-07-06",
      changes: ["Activated the week."],
      revertsEventId: null,
      chatTurnId: "chat-private",
      occurredAt: 123,
    }],
    transcriptEntries: [{ role: "user", text: "private transcript" }],
    chatTurns: [{ completionTokenHash: "private-runtime-token-hash" }],
  };
}

test("dynamic planner manifest is exactly one four-function registry-derived namespace", () => {
  assert.equal(PLANNER_DYNAMIC_TOOL_NAMESPACE.type, "namespace");
  assert.equal(PLANNER_DYNAMIC_TOOL_NAMESPACE.name, "planner");
  assert.deepEqual(
    PLANNER_DYNAMIC_TOOL_NAMESPACE.tools.map((tool) => tool.name),
    PLANNER_TOOL_NAMES,
  );
  assert.doesNotMatch(PLANNER_DYNAMIC_TOOL_NAMESPACE.description, /replaceMealRecipeFromSource/);
  assert.match(PLANNER_DYNAMIC_TOOL_NAMESPACE.description, /prep references/);
  assert.deepEqual(PLANNER_TOOL_AUTHORITY_MANIFEST.tools, PLANNER_TOOL_NAMES);

  const ajv = new Ajv({ allErrors: true, schemaId: "auto" });
  for (const tool of PLANNER_DYNAMIC_TOOL_NAMESPACE.tools) {
    assert.doesNotThrow(() => ajv.compile(tool.inputSchema), `${tool.name} schema compiles`);
  }

  const admittedEntries = Object.entries(HOUSEHOLD_COMMAND_REGISTRY)
    .filter(([, entry]) => entry.exposure !== "host_admission_required");
  const canonicalFieldGuide = admittedEntries
    .map(([type, entry]) =>
      `${type}[${entry.schema.required.filter((field) => field !== "type").join(",")}]`)
    .join("; ");
  for (const toolName of ["preview", "apply"]) {
    const toolSchema = PLANNER_DYNAMIC_TOOL_NAMESPACE.tools.find((tool) => tool.name === toolName);
    const commandTypes = toolSchema.inputSchema.properties.operations.items.properties
      .command.properties.type.enum;
    assert.deepEqual(
      [...commandTypes].sort(),
      admittedEntries.map(([type]) => type).sort(),
      `${toolName} exposes every currently admitted command discriminator`,
    );
    assert.match(
      toolSchema.description,
      new RegExp(
        `Required fields by type: ${canonicalFieldGuide.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  }

  const applyTool = PLANNER_DYNAMIC_TOOL_NAMESPACE.tools.find((tool) => tool.name === "apply");
  assert.match(
    applyTool.description,
    /Readback fields by kind: catalogue\[kind,offset\]; workspace\[kind\]; week\[kind,weekId\]; meal\[kind,weekId,mealId\]; history\[kind,limit; optional afterSequence\]\.$/u,
  );
  const importTool = PLANNER_DYNAMIC_TOOL_NAMESPACE.tools.find((tool) => tool.name === "importRecipe");
  assert.deepEqual(importTool.inputSchema.required, ["basePlannerVersion", "weekId", "mealId", "recipePath"]);
});

test("sourced replacement remains typed but is withheld pending host admission", () => {
  const sourced = {
    command: {
      type: "replaceMealRecipeFromSource",
      weekId: "2026-07-06",
      mealId: "meal-1",
      recipe: {
        title: "Sourced rice",
        source: {
          kind: "web",
          identity: "Example Kitchen",
          url: "https://example.com/recipes/rice",
          retrievedAt: 1_750_000_000_000,
        },
        occurrences: [{
          kind: "create",
          correlationId: "rice-1",
          source: "1 cup rice",
          amount: "1",
          unit: "cup",
          ingredient: "rice",
          qualifier: null,
          conceptId: null,
          canonicalIngredientId: null,
        }],
        steps: [{
          inputs: [{ occurrenceCorrelationId: "rice-1", amount: "1 cup", ingredient: "rice" }],
          instruction: "Cook the rice.",
        }],
      },
    },
  };
  assert.equal(isPlannerApplyArguments({
    basePlannerVersion: 7,
    operations: [sourced],
    readback: { kind: "workspace" },
  }), true, "the direct typed informational-source contract remains valid");
  assert.deepEqual(authorizePlannerOperations([sourced], []), {
    ok: false,
    operationIndex: 0,
    message: "The replaceMealRecipeFromSource operation is unavailable until the host admits exact observed-candidate binding.",
    retry: "none",
  });
});

test("closed read/apply validators reject hidden identity and extra properties", () => {
  assert.equal(isPlannerReadArguments({ query: { kind: "workspace" } }), true);
  assert.equal(isPlannerReadArguments({
    query: { kind: "workspace" },
    actor: "Codex",
  }), false);
  assert.equal(isPlannerApplyArguments({
    basePlannerVersion: 7,
    operations: [{
      command: {
        type: "setInstructionStepComplete",
        weekId: "2026-07-06",
        stepId: "step-1",
        complete: true,
      },
    }],
    readback: { kind: "meal", weekId: "2026-07-06", mealId: "meal-1" },
  }), true);
  assert.equal(isPlannerApplyArguments({
    requestId: "model-controlled",
    basePlannerVersion: 7,
    operations: [archive],
    readback: { kind: "workspace" },
  }), false);
});

test("explicit-foreground commands require one exact frozen host grant", () => {
  assert.deepEqual(authorizePlannerOperations([archive], []), {
    ok: false,
    operationIndex: 0,
    message: "The archiveWeek operation requires an exact foreground grant.",
    retry: "new_foreground_turn",
  });
  const authority = freezeForegroundAuthority([
    { commandType: "archiveWeek", target: "2026-07-06" },
    { commandType: "archiveWeek", target: "2026-07-06" },
  ]);
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(authority.length, 1);
  assert.deepEqual(authorizePlannerOperations([archive], authority), { ok: true });
  assert.equal(
    authorizePlannerOperations(
      [archive],
      freezeForegroundAuthority([{ commandType: "archiveWeek", target: "2026-07-13" }]),
    ).ok,
    false,
  );
});

test("read projections exclude transcript, chat, receipts, before-state, and request identity", () => {
  const source = workspace();
  const projectedWorkspace = projectPlannerRead(source, { kind: "workspace" });
  assert.deepEqual(projectedWorkspace, {
    kind: "workspace",
    activeWeekId: "2026-07-06",
    weeks: [{ id: "2026-07-06", weekStartDate: "2026-07-06", status: "active" }],
    ingredientCatalogue: {
      revision: source.state.ingredientCatalogue.revision,
      offset: 0,
      totalConcepts: source.state.ingredientCatalogue.concepts.length,
      nextOffset: null,
      concepts: source.state.ingredientCatalogue.concepts.slice(0, 4),
    },
  });
  const history = projectPlannerRead(source, { kind: "history", limit: 20 });
  const serialized = JSON.stringify(history);
  assert.doesNotMatch(serialized, /secret-idempotency-key|chat-private|private transcript|token-hash/);
  assert.match(serialized, /event-1/);
  assert.equal(isPlannerReadProjection({ kind: "workspace", activeWeekId: null, weeks: [], ingredientCatalogue: "forged" }), false);
});

test("the maximum valid catalogue fits the embedded read result bound", () => {
  const source = workspace();
  source.state.ingredientCatalogue = {
    revision: 1,
    concepts: Array.from({ length: 1_000 }, (_, conceptIndex) => ({
      id: `concept-${conceptIndex}-`.padEnd(200, "i"),
      preferredLabel: `preferred-${conceptIndex}-`.padEnd(200, "\\"),
      vocabulary: Array.from({ length: 32 }, (_, vocabularyIndex) => `v-${conceptIndex}-${vocabularyIndex}-`.padEnd(200, "\\")),
      defaultSection: "Pantry",
    })),
  };
  const projection = projectPlannerRead(source, { kind: "workspace" });
  assert.equal(isPlannerReadProjection(projection), true);
  const result = createPlannerToolSuccess("max-catalogue", source, 1, projection);
  assert.doesNotThrow(() => serializePlannerToolResult(result));
});

test("candidate preview wire data is closed rather than object-shaped", () => {
  assert.equal(isPlannerPreviewData({ status: "previewed", outcomes: [{ operationIndex: 0, summary: "x", target: "x", changes: [], occurrences: [], ingredientCandidatePreview: {} }] }), false);
});

test("result serialization enforces the 128 KiB wire bound", () => {
  assert.doesNotThrow(() => serializePlannerToolResult({
    schemaVersion: 1,
    ok: true,
    callId: "call-1",
    plannerVersion: 1,
    syncRevision: 1,
    serverTime: 1,
    data: { reply: "ok" },
  }));
  assert.throws(() => serializePlannerToolResult({
    schemaVersion: 1,
    ok: true,
    callId: "call-2",
    plannerVersion: 1,
    syncRevision: 1,
    serverTime: 1,
    data: { value: "x".repeat(131_072) },
  }), /bounded result limit/);
});

test("stored result validation is exact and rejects valid JSON with contract drift", () => {
  const valid = {
    schemaVersion: 1,
    ok: false,
    callId: "call-closed",
    plannerVersion: 1,
    syncRevision: 2,
    serverTime: 3,
    error: {
      code: "CALL_CANCELLED",
      message: "The callback was cancelled.",
      retry: "new_foreground_turn",
    },
  };
  assert.equal(isPlannerToolResult(valid), true);
  assert.equal(isPlannerToolResult({ ...valid, hiddenIdentity: "must-not-replay" }), false);
  assert.equal(isPlannerToolResult({
    ...valid,
    error: { ...valid.error, code: "UNKNOWN_CODE" },
  }), false);
  assert.equal(isPlannerToolResult({
    ...valid,
    error: { ...valid.error, operationIndex: -1 },
  }), false);
});

test("stored successful results are validated against the originating tool contract", () => {
  const source = workspace();
  const base = {
    schemaVersion: 1,
    ok: true,
    callId: "call-typed",
    plannerVersion: source.plannerVersion,
    syncRevision: source.syncRevision,
    serverTime: 3,
  };
  const read = {
    ...base,
    data: projectPlannerRead(source, { kind: "workspace" }),
  };
  const preview = {
    ...base,
    data: {
      status: "previewed",
      outcomes: [{
        operationIndex: 0,
        summary: "Updated the meal.",
        target: "meal-1",
        changes: ["Changed one field."],
        occurrences: [],
      }],
    },
  };
  const apply = {
    ...base,
    data: {
      status: "accepted",
      eventId: "event-accepted",
      occurrenceResults: [],
      readback: projectPlannerRead(source, { kind: "meal", weekId: "2026-07-06", mealId: "meal-1" }),
    },
  };

  assert.equal(isPlannerToolResultForTool("read", read), true);
  assert.equal(isPlannerToolResultForTool("preview", preview), true);
  assert.equal(isPlannerToolResultForTool("apply", apply), true);
  assert.equal(isPlannerToolResultForTool("importRecipe", apply), true);
  assert.equal(isPlannerToolResultForTool("apply", {
    ...apply,
    data: { ...apply.data, readback: projectPlannerRead(source, { kind: "workspace" }) },
  }), true);
  assert.equal(isPlannerToolResultForTool("importRecipe", {
    ...apply,
    data: { ...apply.data, readback: projectPlannerRead(source, { kind: "workspace" }) },
  }), false);
  assert.equal(isPlannerToolResultForTool("read", preview), false);
  assert.equal(isPlannerToolResultForTool("preview", apply), false);
  assert.equal(isPlannerToolResultForTool("apply", read), false);
  for (const tool of PLANNER_TOOL_NAMES) {
    assert.equal(
      isPlannerToolResultForTool(tool, { ...base, data: null }),
      false,
      `${tool} rejects a null success payload`,
    );
  }
});

test("typed tool failures preserve only a bounded operation index", () => {
  const failure = createPlannerToolFailure("call-indexed", workspace(), 123, {
    code: "DOMAIN_REJECTED",
    message: "The second operation was rejected.",
    retry: "revise_new_call",
    operationIndex: 1,
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.operationIndex, 1);
  assert.throws(() => createPlannerToolFailure("call-negative", workspace(), 123, {
    code: "DOMAIN_REJECTED",
    message: "invalid",
    retry: "revise_new_call",
    operationIndex: -1,
  }), /operationIndex/);
  assert.throws(() => createPlannerToolFailure("call-too-large", workspace(), 123, {
    code: "DOMAIN_REJECTED",
    message: "invalid",
    retry: "revise_new_call",
    operationIndex: 16,
  }), /operationIndex/);
});
