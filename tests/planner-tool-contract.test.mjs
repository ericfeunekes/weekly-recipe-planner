import assert from "node:assert/strict";
import test from "node:test";

import Ajv from "ajv";

import { HOUSEHOLD_COMMAND_REGISTRY } from "../lib/household-command-contract.ts";
import {
  PLANNER_DYNAMIC_TOOL_NAMESPACE,
  PLANNER_TOOL_AUTHORITY_MANIFEST,
  PLANNER_TOOL_NAMES,
  authorizePlannerOperations,
  createPlannerToolFailure,
  freezeForegroundAuthority,
  isPlannerApplyArguments,
  isPlannerReadArguments,
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

test("dynamic planner manifest is exactly one three-function registry-derived namespace", () => {
  assert.equal(PLANNER_DYNAMIC_TOOL_NAMESPACE.type, "namespace");
  assert.equal(PLANNER_DYNAMIC_TOOL_NAMESPACE.name, "planner");
  assert.deepEqual(
    PLANNER_DYNAMIC_TOOL_NAMESPACE.tools.map((tool) => tool.name),
    PLANNER_TOOL_NAMES,
  );
  assert.match(PLANNER_DYNAMIC_TOOL_NAMESPACE.description, /replaceMealRecipeFromSource/);
  assert.match(PLANNER_DYNAMIC_TOOL_NAMESPACE.description, /setMealRecipe is not a command/);
  assert.match(PLANNER_DYNAMIC_TOOL_NAMESPACE.description, /prep references/);
  assert.deepEqual(PLANNER_TOOL_AUTHORITY_MANIFEST.tools, PLANNER_TOOL_NAMES);

  const ajv = new Ajv({ allErrors: true, schemaId: "auto" });
  for (const tool of PLANNER_DYNAMIC_TOOL_NAMESPACE.tools) {
    assert.doesNotThrow(() => ajv.compile(tool.inputSchema), `${tool.name} schema compiles`);
  }

  const canonicalFieldGuide = Object.entries(HOUSEHOLD_COMMAND_REGISTRY)
    .map(([type, entry]) =>
      `${type}[${entry.schema.required.filter((field) => field !== "type").join(",")}]`)
    .join("; ");
  for (const toolName of ["preview", "apply"]) {
    const toolSchema = PLANNER_DYNAMIC_TOOL_NAMESPACE.tools.find((tool) => tool.name === toolName);
    const commandAlternatives = toolSchema.inputSchema.properties.operations.items.properties
      .command.anyOf;
    assert.deepEqual(
      commandAlternatives.map((schema) => schema.properties.type.const).sort(),
      Object.keys(HOUSEHOLD_COMMAND_REGISTRY).sort(),
      `${toolName} exposes every registry command discriminator`,
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
    /Readback fields by kind: workspace\[kind\]; week\[kind,weekId\]; meal\[kind,weekId,mealId\]; history\[kind,limit; optional afterSequence\]\.$/u,
  );
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
  });
  const history = projectPlannerRead(source, { kind: "history", limit: 20 });
  const serialized = JSON.stringify(history);
  assert.doesNotMatch(serialized, /secret-idempotency-key|chat-private|private transcript|token-hash/);
  assert.match(serialized, /event-1/);
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
      }],
    },
  };
  const apply = {
    ...base,
    data: {
      status: "accepted",
      eventId: "event-accepted",
      readback: projectPlannerRead(source, { kind: "meal", weekId: "2026-07-06", mealId: "meal-1" }),
    },
  };

  assert.equal(isPlannerToolResultForTool("read", read), true);
  assert.equal(isPlannerToolResultForTool("preview", preview), true);
  assert.equal(isPlannerToolResultForTool("apply", apply), true);
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
