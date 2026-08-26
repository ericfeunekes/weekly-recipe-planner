import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { PLANNER_TOOL_NAMESPACE } from "../lib/planner-tool-contract.ts";
import { createPlannerApplicationService, hashCanonicalPayload } from "../server/application/planner-service.ts";
import { createNativePlannerEffectHost } from "../server/codex/planner-effect-host.ts";
import { createSqliteCodexThreadStore } from "../server/store/codex-thread-store.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function initializedWorkspace() {
  let id = 0;
  const state = createCanonicalSeed({
    now: Date.UTC(2026, 6, 15, 12),
    createId: (prefix) => `${prefix}-seed-${id += 1}`,
  });
  return {
    initialized: true,
    schemaVersion: 12,
    plannerVersion: 0,
    syncRevision: 1,
    state,
    events: [],
    transcriptEntries: [],
    chatTurns: [],
  };
}

function fakePlanner(initial = initializedWorkspace()) {
  let workspace = initial;
  const calls = { preview: 0, apply: 0 };
  const applyOperations = (_request, context) => {
    calls.apply += 1;
    assert.equal(context.operationKind, "native_codex_apply_planner_operations_v1");
    assert.deepEqual(context.provenance, {
      actorClass: "codex",
      actorSource: "embedded",
      admission: "app_server_dynamic_v1",
    });
    workspace = {
      ...workspace,
      plannerVersion: workspace.plannerVersion + 1,
      syncRevision: workspace.syncRevision + 1,
    };
    return {
      decision: {
        status: "accepted",
        eventId: "event-native",
        plannerVersion: workspace.plannerVersion,
        occurrenceResults: [],
      },
      workspace,
    };
  };
  return {
    calls,
    advanceWorkspace() {
      workspace = {
        ...workspace,
        plannerVersion: workspace.plannerVersion + 1,
        syncRevision: workspace.syncRevision + 1,
      };
    },
    readWorkspace: () => workspace,
    readEventPage: () => ({ order: "newest_first", items: [], nextBeforeSequence: null }),
    readTranscriptPage: () => ({ order: "newest_first", items: [], nextBeforeSequence: null }),
    applyCommand: () => { throw new Error("unused"); },
    previewOperations: (request) => {
      calls.preview += 1;
      return {
        decision: {
          status: "previewed",
          plannerVersion: workspace.plannerVersion,
          outcomes: request.operations.map((_, operationIndex) => ({
            operationIndex,
            summary: "Preview",
            target: "week",
            changes: ["One change"],
          })),
        },
      };
    },
    applyOperations,
    replayHistoricalOperations: () => { throw new Error("native planner tools do not admit retired commands"); },
    replayHistoricalPlannerOperations: () => { throw new Error("native planner tools do not admit retired commands"); },
    applyPlannerOperations: (_transaction, request, context) =>
      applyOperations(request, context),
    undoLatest: () => { throw new Error("unused"); },
    bootstrap: () => { throw new Error("unused"); },
    exportWorkspace: () => { throw new Error("unused"); },
  };
}

function realPlanner(sqlite, {
  failureInjector = { hit() {} },
  bootstrap = true,
  transformSeed = (seed) => seed,
} = {}) {
  let id = 0;
  let now = Date.UTC(2026, 6, 15, 12);
  const context = () => ({
    now,
    createId: (prefix) => `${prefix}-native-${id += 1}`,
  });
  const planner = createPlannerApplicationService({
    store: sqlite,
    domain: householdDomain,
    seedFactory: () => transformSeed(createCanonicalSeed(context())),
    transformLegacyV2: () => { throw new Error("unused"); },
    clock: { now: () => now += 1 },
    idFactory: { createId: (prefix) => `${prefix}-native-${id += 1}` },
    failureInjector,
  });
  if (bootstrap) planner.bootstrap({ requestId: "bootstrap-native", mode: "seed" });
  return planner;
}

function callback(tool, args, overrides = {}) {
  return {
    threadId: overrides.threadId ?? "thread-root",
    turnId: overrides.turnId ?? "turn-1",
    callId: overrides.callId ?? `call-${tool}`,
    namespace: PLANNER_TOOL_NAMESPACE,
    tool,
    arguments: args,
  };
}

function decode(response) {
  assert.equal(response.contentItems.length, 1);
  assert.equal(response.contentItems[0].type, "inputText");
  return JSON.parse(response.contentItems[0].text);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("native planner host reads and replays the exact result", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = fakePlanner();
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: (threadId, turnId) =>
      threadId === "thread-root" && turnId === "turn-1",
    now: () => 100,
  });
  const params = callback("read", { query: { kind: "workspace" } });
  const first = decode(await host.handle(params));
  const replay = decode(await host.handle(params));
  assert.deepEqual(replay, first);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.data.kind, "workspace");
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_tool_calls",
  ).get().count, 1);
  sqlite.close();
});

test("maximum catalogue continues across native turns without exceeding the per-turn call limit", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const initial = initializedWorkspace();
  initial.state = {
    householdTimeZone: "America/Halifax",
    activeWeekId: null,
    weeks: [],
    ingredientCatalogue: {
      revision: 7,
      concepts: Array.from({ length: 1_000 }, (_, index) => ({ id: `concept-${index}`, preferredLabel: `Concept ${index}`, vocabulary: [], defaultSection: "Pantry" })),
    },
  };
  const host = createNativePlannerEffectHost({ planner: fakePlanner(initial), store: createSqliteCodexThreadStore(sqlite), isEligibleCall: () => true, now: () => 101 });
  const concepts = [];
  let offset = 0;
  let callIndex = 0;
  while (offset !== null) {
    const turnIndex = Math.floor(callIndex / 32);
    const result = decode(await host.handle(callback("read", { query: { kind: "catalogue", offset } }, {
      turnId: `turn-catalogue-${turnIndex}`,
      callId: `call-catalogue-${callIndex}`,
    })));
    assert.equal(result.ok, true);
    concepts.push(...result.data.ingredientCatalogue.concepts);
    offset = result.data.ingredientCatalogue.nextOffset;
    callIndex += 1;
  }
  assert.equal(callIndex, 250);
  assert.equal(new Set(concepts.map(({ id }) => id)).size, 1_000);
  assert.deepEqual(concepts.map(({ id }) => id), initial.state.ingredientCatalogue.concepts.map(({ id }) => id));
  sqlite.close();
});

test("native planner host imports one pinned canonical recipe through the versioned planner authority", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite, {
    transformSeed(seed) {
      for (const week of seed.weeks) week.data.prepSessions = [];
      return seed;
    },
  });
  const recipeRoot = join(process.cwd(), "tests/support/fixtures/canonical-recipes");
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    recipeRoot,
    now: () => 150,
  });
  const before = planner.readWorkspace();
  const weekId = before.state.activeWeekId;
  const week = before.state.weeks.find((candidate) => candidate.id === weekId);
  const prepStepIds = new Set(week.data.prepSessions.flatMap((session) =>
    session.steps.flatMap((entry) => "stepId" in entry ? [entry.stepId] : entry.sources.map((source) => source.stepId))));
  const meal = week.data.meals.find((candidate) =>
    (candidate.status === "planned" || candidate.status === "moved") &&
    candidate.instructions.every((step) => !step.complete && step.note === undefined &&
      step.timerStartedAt === undefined && !prepStepIds.has(step.id)));
  assert.ok(meal, "seed must expose one eligible unstarted meal");
  const originalDate = meal.date;
  const originalSubtitle = meal.subtitle;
  const originalNotes = meal.notes;
  const params = callback("importRecipe", {
    basePlannerVersion: before.plannerVersion,
    weekId,
    mealId: meal.id,
    recipePath: "lemon-pepper-salmon.md",
  });
  const first = decode(await host.handle(params));
  const replay = decode(await host.handle(params));

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.data.status, "accepted");
  assert.deepEqual(replay, first);
  const imported = first.data.readback.meal;
  assert.equal(imported.title, "Lemon Pepper Salmon");
  assert.equal(imported.date, originalDate);
  assert.equal(imported.subtitle, originalSubtitle);
  assert.equal(imported.notes, originalNotes);
  assert.equal(imported.sourceRecipe.kind, "canonical");
  assert.equal(imported.sourceRecipe.identity, "lemon-pepper-salmon");
  assert.match(imported.sourceRecipe.revision, /^[0-9a-f]{64}$/u);
  assert.equal(imported.sourceRecipe.timeActiveMinutes, null);
  assert.equal(imported.sourceRecipe.timeTotalMinutes, 30);
  assert.equal(imported.sourceRecipe.notes, "- Serve with rice and roasted vegetables.\n- Butter can replace the olive oil.\n");
  assert.deepEqual(imported.ingredients.map(({ source, amount, unit, ingredient, qualifier, canonicalIngredientId }) =>
    ({ source, amount, unit, ingredient, qualifier, canonicalIngredientId })), [
    { source: "4 (4-6 ounce) salmon fillets", amount: "4", unit: "fillet", ingredient: "salmon", qualifier: "4-6 ounce", canonicalIngredientId: 1 },
    { source: "1 tablespoon minced garlic", amount: "1", unit: "tablespoon", ingredient: "garlic", qualifier: "minced", canonicalIngredientId: 2 },
    { source: "Salt to taste", amount: "", unit: null, ingredient: "salt", qualifier: "to taste", canonicalIngredientId: 3 },
  ]);
  assert.deepEqual(imported.instructions.map((step) => ({
    ingredientIds: step.inputs.map((input) => input.occurrenceId),
    instruction: step.instruction,
    timer: step.timerDurationSeconds ?? null,
  })), [
    { ingredientIds: [], instruction: "Preheat the oven to 400°F.", timer: null },
    { ingredientIds: [imported.ingredients[0].id, imported.ingredients[1].id, imported.ingredients[2].id], instruction: "Rub the garlic over the salmon.", timer: null },
    { ingredientIds: [imported.ingredients[0].id], instruction: "Bake until the salmon flakes easily.", timer: 900 },
  ]);
  assert.equal(planner.readWorkspace().plannerVersion, before.plannerVersion + 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  const edited = planner.applyCommand({
    requestId: "edit-imported-snapshot",
    basePlannerVersion: before.plannerVersion + 1,
    command: {
      type: "editMealRecipe",
      weekId,
      mealId: meal.id,
      changes: {
        title: "Lemon Pepper Salmon with herbs",
        subtitle: imported.subtitle,
        venue: imported.venue,
        prepNote: imported.prepNote,
        leftoverNote: imported.leftoverNote,
        notes: imported.notes,
        yieldText: imported.yieldText ?? null,
      },
      occurrences: imported.ingredients.map((ingredient) => ({
        kind: "retain", occurrenceId: ingredient.id, source: ingredient.source,
        amount: ingredient.amount, unit: ingredient.unit, ingredient: ingredient.ingredient,
        qualifier: ingredient.qualifier, conceptId: ingredient.conceptId,
      })),
      removedOccurrenceIds: [],
    },
  });
  assert.equal(edited.decision.status, "accepted");
  const editedMeal = edited.workspace.state.weeks.find((candidate) => candidate.id === weekId)
    .data.meals.find((candidate) => candidate.id === meal.id);
  assert.equal(editedMeal.title, "Lemon Pepper Salmon with herbs");
  assert.deepEqual(editedMeal.sourceRecipe, imported.sourceRecipe);
  sqlite.close();
});

test("native canonical import rejects invalid paths and stale versions without a planner event", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite, {
    transformSeed(seed) {
      for (const week of seed.weeks) week.data.prepSessions = [];
      return seed;
    },
  });
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    recipeRoot: join(process.cwd(), "tests/support/fixtures/canonical-recipes"),
    now: () => 175,
  });
  const before = planner.readWorkspace();
  const week = before.state.weeks.find((candidate) => candidate.id === before.state.activeWeekId);
  const meal = week.data.meals.find((candidate) =>
    (candidate.status === "planned" || candidate.status === "moved") &&
    candidate.instructions.every((step) => !step.complete && step.note === undefined &&
      step.timerStartedAt === undefined && step.timerPaused !== true));
  const invalid = decode(await host.handle(callback("importRecipe", {
    basePlannerVersion: before.plannerVersion,
    weekId: week.id,
    mealId: meal.id,
    recipePath: "missing.md",
  }, { callId: "call-import-invalid" })));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_ARGUMENTS");
  const stale = decode(await host.handle(callback("importRecipe", {
    basePlannerVersion: before.plannerVersion + 1,
    weekId: week.id,
    mealId: meal.id,
    recipePath: "lemon-pepper-salmon.md",
  }, { callId: "call-import-stale" })));
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "VERSION_CONFLICT");
  assert.equal(planner.readWorkspace().plannerVersion, before.plannerVersion);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 0);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_tool_calls WHERE status = 'rejected'",
  ).get().count, 2);
  sqlite.close();
});

test("concurrent recovery hosts return one durable canonical read failure", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite);
  const store = createSqliteCodexThreadStore(sqlite);
  const options = {
    planner,
    store,
    isEligibleCall: () => true,
    recipeRoot: join(process.cwd(), "tests/support/fixtures/canonical-recipes"),
  };
  const firstHost = createNativePlannerEffectHost({ ...options, now: () => 100 });
  const secondHost = createNativePlannerEffectHost({ ...options, now: () => 200 });
  const params = callback("importRecipe", {
    basePlannerVersion: 0,
    weekId: "2026-07-06",
    mealId: "meal-1",
    recipePath: "missing.md",
  }, { callId: "call-import-concurrent-failure" });
  const [first, second] = await Promise.all([
    firstHost.handle(params).then(decode),
    secondHost.handle(params).then(decode),
  ]);
  assert.deepEqual(second, first);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "INVALID_ARGUMENTS");
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_tool_calls",
  ).get().count, 1);
  sqlite.close();
});

test("a durable read failure winner rolls back a competing successful import", async (t) => {
  const missingRoot = await mkdtemp(join(tmpdir(), "planner-native-missing-recipe-"));
  t.after(() => rm(missingRoot, { recursive: true, force: true }));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const sqlite = openPlannerStore({ filename: ":memory:" });
    const planner = realPlanner(sqlite, {
      transformSeed(seed) {
        for (const week of seed.weeks) week.data.prepSessions = [];
        return seed;
      },
    });
    const store = createSqliteCodexThreadStore(sqlite);
    const validHost = createNativePlannerEffectHost({
      planner,
      store,
      isEligibleCall: () => true,
      recipeRoot: join(process.cwd(), "tests/support/fixtures/canonical-recipes"),
      now: () => 300,
    });
    const missingHost = createNativePlannerEffectHost({
      planner,
      store,
      isEligibleCall: () => true,
      recipeRoot: missingRoot,
      now: () => 301,
    });
    const before = planner.readWorkspace();
    const week = before.state.weeks.find((candidate) => candidate.id === before.state.activeWeekId);
    const meal = week.data.meals.find((candidate) =>
      (candidate.status === "planned" || candidate.status === "moved") &&
      candidate.instructions.every((step) => !step.complete && step.note === undefined &&
        step.timerStartedAt === undefined && step.timerPaused !== true));
    const params = callback("importRecipe", {
      basePlannerVersion: before.plannerVersion,
      weekId: week.id,
      mealId: meal.id,
      recipePath: "lemon-pepper-salmon.md",
    }, { callId: `call-import-mixed-race-${attempt}` });
    const [validResult, missingResult] = await Promise.all([
      validHost.handle(params).then(decode),
      missingHost.handle(params).then(decode),
    ]);
    assert.deepEqual(missingResult, validResult);
    const eventCount = sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count;
    assert.equal(eventCount, validResult.ok ? 1 : 0);
    assert.equal(planner.readWorkspace().plannerVersion, before.plannerVersion + eventCount);
    sqlite.close();
  }
});

test("native canonical import rejects an ineligible cooking meal without a planner event", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite, {
    transformSeed(seed) {
      const week = seed.weeks.find((candidate) => candidate.id === seed.activeWeekId);
      week.data.prepSessions = [];
      week.data.meals[0].status = "cooking";
      return seed;
    },
  });
  const before = planner.readWorkspace();
  const week = before.state.weeks.find((candidate) => candidate.id === before.state.activeWeekId);
  const meal = week.data.meals[0];
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    recipeRoot: join(process.cwd(), "tests/support/fixtures/canonical-recipes"),
    now: () => 180,
  });
  const result = decode(await host.handle(callback("importRecipe", {
    basePlannerVersion: before.plannerVersion,
    weekId: week.id,
    mealId: meal.id,
    recipePath: "lemon-pepper-salmon.md",
  }, { callId: "call-import-ineligible" })));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DOMAIN_REJECTED");
  assert.equal(planner.readWorkspace().plannerVersion, before.plannerVersion);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 0);
  sqlite.close();
});

test("native planner host applies an occurrence edit through the shared service once and replays", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    now: () => 200,
  });
  const before = planner.readWorkspace();
  const weekId = before.state.activeWeekId;
  const meal = before.state.weeks.find((week) => week.id === weekId).data.meals[0];
  const correlationId = "native-created-occurrence";
  const params = callback("apply", {
    basePlannerVersion: 0,
    operations: [{ command: {
      type: "editMealRecipe",
      weekId,
      mealId: meal.id,
      changes: {
        title: meal.title,
        subtitle: meal.subtitle,
        venue: meal.venue,
        prepNote: meal.prepNote,
        leftoverNote: meal.leftoverNote,
        notes: meal.notes,
        yieldText: meal.yieldText ?? null,
      },
      occurrences: [
        ...meal.ingredients.map((ingredient) => ({
          kind: "retain",
          occurrenceId: ingredient.id,
          source: ingredient.source,
          amount: ingredient.amount,
          unit: ingredient.unit,
          ingredient: ingredient.ingredient,
          qualifier: ingredient.qualifier,
          conceptId: ingredient.conceptId,
        })),
        {
          kind: "create",
          correlationId,
          source: "1 lime",
          amount: "1",
          unit: null,
          ingredient: "lime",
          qualifier: null,
          conceptId: null,
          canonicalIngredientId: null,
        },
      ],
      removedOccurrenceIds: [],
    } }],
    readback: { kind: "week", weekId },
  });
  const first = decode(await host.handle(params));
  const replay = decode(await host.handle(params));
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "accepted");
  const createdOccurrenceId = first.data.occurrenceResults[0].occurrences
    .find((resolution) => resolution.correlationId === correlationId)?.occurrenceId;
  assert.ok(createdOccurrenceId);
  assert.equal(first.data.readback.week.data.meals[0].ingredients.at(-1).id, createdOccurrenceId);
  assert.equal(first.data.readback.week.data.meals[0].ingredients.at(-1).ingredient, "lime");
  assert.deepEqual(replay, first);
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  assert.equal(sqlite.readAllChatTurns().length, 0);
  assert.equal(planner.readTranscriptPage({ limit: 20 }).items.length, 0);
  const row = sqlite.database.prepare(
    "SELECT operation_kind, request_id, event_id FROM codex_native_tool_calls",
  ).get();
  assert.equal(row.operation_kind, "native_codex_apply_planner_operations_v1");
  assert.match(row.request_id, /^native-codex:[a-f0-9]{64}$/u);
  assert.match(row.event_id, /^event-native-/u);
  sqlite.close();
});

test("native planner host recovers a retired inner command only from its exact historical receipt", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    now: () => 225,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const meal = planner.readWorkspace().state.weeks.find((week) => week.id === weekId).data.meals[0];
  const args = {
    basePlannerVersion: 0,
    operations: [{ command: {
      type: "updateMealSnapshot",
      weekId,
      mealId: meal.id,
      changes: {
        title: meal.title, subtitle: meal.subtitle, venue: meal.venue,
        prepNote: meal.prepNote, leftoverNote: meal.leftoverNote, notes: meal.notes,
        ingredients: meal.ingredients.map(({ amount, ingredient }) => `${amount} ${ingredient}`),
        yieldText: meal.yieldText ?? null,
      },
    } }],
    readback: { kind: "week", weekId },
  };
  const params = callback("apply", args, { callId: "historical-native-call" });
  const argumentHash = sha256(canonicalJson(args));
  const callbackIdentityHash = sha256([
    params.threadId, params.turnId, params.callId, params.namespace, params.tool, argumentHash,
  ].join("\0"));
  const requestId = `native-codex:${callbackIdentityHash}`;
  const initial = planner.readWorkspace();
  sqlite.transaction((transaction) => {
    assert.ok(sqlite.updateWorkspace(transaction, initial.state, 0, 1));
    sqlite.insertPlannerEvent(transaction, {
      eventId: "historical-native-event",
      requestId,
      actor: "Codex",
      provenance: { actorClass: "codex", actorSource: "embedded", admission: "app_server_dynamic_v1" },
      command: args.operations[0].command,
      baseVersion: 0,
      resultVersion: 1,
      summary: "Historical native recipe edit",
      target: meal.id,
      changes: [],
      revertsEventId: null,
      chatTurnId: null,
      occurredAt: 1,
    }, initial.state);
    sqlite.insertReceipt(transaction, {
      operationKind: "native_codex_apply_planner_operations_v1",
      requestId,
      payloadHash: hashCanonicalPayload("native_codex_apply_planner_operations_v1", {
        basePlannerVersion: args.basePlannerVersion,
        operations: args.operations,
      }),
      httpStatus: 200,
      decision: {
        kind: "planner_decision",
        decision: { status: "accepted", eventId: "historical-native-event", plannerVersion: 1 },
      },
      createdAt: 1,
    });
  });
  const before = planner.readWorkspace();
  const recovered = decode(await host.handle(params));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.status, "replayed");
  assert.equal(recovered.data.eventId, "historical-native-event");
  assert.deepEqual(recovered.data.occurrenceResults, [{ operationIndex: 0, occurrences: [] }]);
  assert.deepEqual(planner.readWorkspace(), before);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);

  const changed = structuredClone(params);
  changed.arguments.operations[0].command.changes.title = "Changed historical request";
  assert.equal(decode(await host.handle(changed)).ok, false);
  const missing = callback("apply", args, { callId: "missing-historical-native-call" });
  assert.equal(decode(await host.handle(missing)).ok, false);
  assert.deepEqual(planner.readWorkspace(), before);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  sqlite.close();
});

test("accepted native apply falls back to canonical workspace readback and settles", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite);
  const store = createSqliteCodexThreadStore(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store,
    isEligibleCall: () => true,
    now: () => 250,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const params = callback("apply", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Fallback." } }],
    readback: { kind: "week", weekId: "missing-week" },
  }, { callId: "call-fallback" });
  const first = decode(await host.handle(params));
  const replay = decode(await host.handle(params));
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "accepted");
  assert.equal(first.data.readback.kind, "workspace");
  assert.deepEqual(replay, first);
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  assert.equal(store.readPlannerToolCalls("thread-root", "turn-1")[0].status, "succeeded");
  sqlite.close();
});

test("native host canonicalization rejects changed arguments before a second effect", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = realPlanner(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    now: () => 260,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const base = {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "First." } }],
    readback: { kind: "workspace" },
  };
  assert.equal(decode(await host.handle(callback("apply", base, {
    callId: "call-changed",
  }))).ok, true);
  const changed = decode(await host.handle(callback("apply", {
    ...base,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Changed." } }],
  }, { callId: "call-changed" })));
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, "DUPLICATE_MISMATCH");
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  sqlite.close();
});

test("preview version conflict reports the current authoritative envelope", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = fakePlanner();
  planner.previewOperations = () => {
    planner.calls.preview += 1;
    planner.advanceWorkspace();
    return {
      decision: { status: "version_conflict", expectedVersion: 0, actualVersion: 1 },
    };
  };
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    now: () => 270,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const conflict = decode(await host.handle(callback("preview", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Race." } }],
  }, { callId: "call-preview-race" })));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "VERSION_CONFLICT");
  assert.equal(conflict.plannerVersion, 1);
  assert.equal(conflict.syncRevision, 2);
  sqlite.close();
});

test("native planner host recovers a reserved apply with the same deterministic request identity", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(sqlite);
  const planner = realPlanner(sqlite);
  const host = createNativePlannerEffectHost({
    planner,
    store,
    isEligibleCall: () => true,
    now: () => 300,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const params = callback("apply", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "captureWeekLesson", weekId, weekLesson: "Recover safely." } }],
    readback: { kind: "workspace" },
  }, { callId: "call-recovery" });

  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const { createHash } = await import("node:crypto");
  const argumentHash = createHash("sha256").update(canonical(params.arguments)).digest("hex");
  const callbackIdentityHash = createHash("sha256").update([
    params.threadId,
    params.turnId,
    params.callId,
    params.namespace,
    params.tool,
    argumentHash,
  ].join("\0")).digest("hex");
  assert.equal(store.reservePlannerToolCall({
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId,
    callbackIdentityHash,
    tool: params.tool,
    argumentHash,
  }, 250).status, "reserved");

  const recovered = decode(await host.handle(params));
  assert.equal(recovered.ok, true);
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  assert.equal(store.readPlannerToolCalls(params.threadId, params.turnId)[0].status, "succeeded");
  sqlite.close();
});

test("native apply and its callback fence roll back together and recover after a file-backed reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-native-effect-crash-"));
  const filename = join(directory, "planner.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  let armed = false;
  let failed = false;
  let sqlite = openPlannerStore({ filename });
  let planner = realPlanner(sqlite, {
    failureInjector: {
      hit(point) {
        if (armed && !failed && point === "after_planner_mutation") {
          failed = true;
          throw new Error("crash-after-planner-mutation");
        }
      },
    },
  });
  let store = createSqliteCodexThreadStore(sqlite);
  let host = createNativePlannerEffectHost({
    planner,
    store,
    isEligibleCall: () => true,
    now: () => 350,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const params = callback("apply", {
    basePlannerVersion: 0,
    operations: [{
      command: {
        type: "captureWeekLesson",
        weekId,
        weekLesson: "Recover the atomic callback.",
      },
    }],
    readback: { kind: "week", weekId },
  }, { callId: "call-file-backed-crash" });

  armed = true;
  await assert.rejects(host.handle(params), /crash-after-planner-mutation/u);
  assert.equal(failed, true);
  assert.equal(planner.readWorkspace().plannerVersion, 0);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM planner_events",
  ).get().count, 0);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM command_receipts WHERE operation_kind = 'native_codex_apply_planner_operations_v1'",
  ).get().count, 0);
  assert.equal(store.readPlannerToolCalls(params.threadId, params.turnId)[0].status, "running");
  sqlite.close();

  sqlite = openPlannerStore({ filename });
  planner = realPlanner(sqlite, { bootstrap: false });
  store = createSqliteCodexThreadStore(sqlite);
  host = createNativePlannerEffectHost({
    planner,
    store,
    isEligibleCall: () => true,
    now: () => 351,
  });
  const recovered = decode(await host.handle(params));
  const replay = decode(await host.handle(params));
  assert.equal(recovered.ok, true);
  assert.deepEqual(replay, recovered);
  assert.equal(planner.readWorkspace().plannerVersion, 1);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM planner_events",
  ).get().count, 1);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM command_receipts WHERE operation_kind = 'native_codex_apply_planner_operations_v1'",
  ).get().count, 1);
  assert.equal(store.readPlannerToolCalls(params.threadId, params.turnId)[0].status, "succeeded");
  sqlite.close();
});

test("durable canonical import replay survives source removal and a new host process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-native-import-replay-"));
  const filename = join(directory, "planner.sqlite");
  const recipeRoot = join(directory, "recipes");
  const recipeFilename = join(recipeRoot, "lemon-pepper-salmon.md");
  await mkdir(recipeRoot);
  await copyFile(
    join(process.cwd(), "tests/support/fixtures/canonical-recipes/lemon-pepper-salmon.md"),
    recipeFilename,
  );
  t.after(() => rm(directory, { recursive: true, force: true }));

  let sqlite = openPlannerStore({ filename });
  let planner = realPlanner(sqlite, {
    transformSeed(seed) {
      for (const week of seed.weeks) week.data.prepSessions = [];
      return seed;
    },
  });
  let host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    recipeRoot,
    now: () => 360,
  });
  const before = planner.readWorkspace();
  const week = before.state.weeks.find((candidate) => candidate.id === before.state.activeWeekId);
  const meal = week.data.meals.find((candidate) =>
    (candidate.status === "planned" || candidate.status === "moved") &&
    candidate.instructions.every((step) => !step.complete && step.note === undefined &&
      step.timerStartedAt === undefined && step.timerPaused !== true));
  const params = callback("importRecipe", {
    basePlannerVersion: before.plannerVersion,
    weekId: week.id,
    mealId: meal.id,
    recipePath: "lemon-pepper-salmon.md",
  }, { callId: "call-file-backed-import-replay" });
  const accepted = decode(await host.handle(params));
  assert.ok(accepted.ok, JSON.stringify(accepted));
  sqlite.close();
  await unlink(recipeFilename);

  sqlite = openPlannerStore({ filename });
  planner = realPlanner(sqlite, { bootstrap: false });
  host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: () => true,
    recipeRoot,
    now: () => 361,
  });
  const replay = decode(await host.handle(params));
  assert.deepEqual(replay, accepted);
  assert.equal(planner.readWorkspace().plannerVersion, before.plannerVersion + 1);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  sqlite.close();
});

test("native approved-week import commits the complete shell once and replays without rereading", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-approved-week-"));
  const filename = join(directory, "planner.sqlite");
  const recipeRoot = join(directory, "recipes");
  const recipeFilename = join(recipeRoot, "lemon-pepper-salmon.md");
  await mkdir(recipeRoot);
  await copyFile(join(process.cwd(), "tests/support/fixtures/canonical-recipes/lemon-pepper-salmon.md"), recipeFilename);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const revision = createHash("sha256").update(await (await import("node:fs/promises")).readFile(recipeFilename)).digest("hex");
  let sqlite = openPlannerStore({ filename });
  let planner = realPlanner(sqlite, { transformSeed(seed) { for (const week of seed.weeks) week.data.prepSessions = []; return seed; } });
  let host = createNativePlannerEffectHost({ planner, store: createSqliteCodexThreadStore(sqlite), isEligibleCall: () => true, recipeRoot, now: () => 500 });
  const before = planner.readWorkspace();
  const week = before.state.weeks.find((candidate) => candidate.id === before.state.activeWeekId);
  const target = week.data.meals.find((meal) => meal.status === "planned" && meal.instructions.every((step) => !step.complete));
  const params = callback("importApprovedWeek", {
    basePlannerVersion: before.plannerVersion,
    weekId: week.id,
    targets: [{ mealId: target.id, recipePath: "lemon-pepper-salmon.md", recipeRevision: revision }],
    manualMealIds: week.data.meals.filter((meal) => meal.id !== target.id).map((meal) => meal.id),
  }, { callId: "approved-week-call" });
  const accepted = decode(await host.handle(params));
  assert.ok(accepted.ok, JSON.stringify(accepted));
  assert.deepEqual(accepted.data.importedMealIds, [target.id]);
  assert.equal(planner.readWorkspace().plannerVersion, before.plannerVersion + 1);
  sqlite.close();
  await unlink(recipeFilename);
  sqlite = openPlannerStore({ filename });
  planner = realPlanner(sqlite, { bootstrap: false });
  host = createNativePlannerEffectHost({ planner, store: createSqliteCodexThreadStore(sqlite), isEligibleCall: () => true, recipeRoot, now: () => 501 });
  assert.deepEqual(decode(await host.handle(params)), accepted);
  assert.equal(sqlite.database.prepare("SELECT count(*) AS count FROM planner_events").get().count, 1);
  sqlite.close();
});

test("approved-week transport accepts the maximum valid Unicode request envelope", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = fakePlanner();
  const host = createNativePlannerEffectHost({ planner, store: createSqliteCodexThreadStore(sqlite), isEligibleCall: () => true, now: () => 700 });
  const unicode = "\u0800";
  const targets = Array.from({ length: 256 }, (_, index) => ({
    mealId: `${unicode.repeat(199)}${String.fromCodePoint(0x0800 + index)}`,
    recipePath: unicode.repeat(2048),
    recipeRevision: "a".repeat(64),
  }));
  const params = callback("importApprovedWeek", {
    basePlannerVersion: 0, weekId: unicode.repeat(200), targets, manualMealIds: [],
  }, { callId: "unicode-approved-week" });
  const bytes = Buffer.byteLength(JSON.stringify(params.arguments), "utf8");
  assert.ok(bytes <= 1_758_000, `expected ${bytes} bytes to fit the approved-week cap`);
  const result = decode(await host.handle(params));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /importApprovedWeek arguments/u);
  sqlite.close();
});

test("native planner host rejects unavailable sourced replacement, explicit archive authority, and ineligible callers", async () => {
  const sqlite = openPlannerStore({ filename: ":memory:" });
  const planner = fakePlanner();
  const host = createNativePlannerEffectHost({
    planner,
    store: createSqliteCodexThreadStore(sqlite),
    isEligibleCall: (threadId, turnId) =>
      threadId === "thread-root" && turnId === "turn-1",
    now: () => 400,
  });
  const weekId = planner.readWorkspace().state.activeWeekId;
  const sourced = {
    type: "replaceMealRecipeFromSource",
    weekId,
    mealId: planner.readWorkspace().state.weeks[0].data.meals[0].id,
    recipe: {
      title: "Sourced rice",
      source: {
        kind: "web",
        identity: "Example Kitchen",
        url: "https://example.com/recipes/rice",
        retrievedAt: 1_750_000_000_000,
      },
      steps: [{ inputs: [{ amount: "1 cup", ingredient: "rice" }], instruction: "Cook the rice." }],
    },
  };
  for (const [tool, argumentsValue] of [
    ["preview", { basePlannerVersion: 0, operations: [{ command: sourced }] }],
    ["apply", { basePlannerVersion: 0, operations: [{ command: sourced }], readback: { kind: "workspace" } }],
  ]) {
    const deniedSourced = decode(await host.handle(callback(tool, argumentsValue, {
      callId: `call-sourced-${tool}`,
    })));
    assert.equal(deniedSourced.ok, false);
    assert.equal(deniedSourced.error.code, "INVALID_ARGUMENTS");
    assert.match(
      deniedSourced.error.message,
      tool === "apply" ? /retired commands|receipt/i : /ordered operation.*contract/i,
    );
    assert.equal(deniedSourced.error.retry, "revise_new_call");
  }
  assert.equal(planner.calls.preview, 0);
  assert.equal(planner.calls.apply, 0);
  const denied = decode(await host.handle(callback("preview", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "archiveWeek", weekId } }],
  })));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "NOT_AUTHORIZED");
  assert.equal(denied.error.retry, "new_foreground_turn");
  assert.equal(planner.calls.preview, 0);
  const applyDenied = decode(await host.handle(callback("apply", {
    basePlannerVersion: 0,
    operations: [{ command: { type: "archiveWeek", weekId } }],
    readback: { kind: "workspace" },
  }, { callId: "call-archive-apply" })));
  assert.equal(applyDenied.ok, false);
  assert.equal(applyDenied.error.code, "NOT_AUTHORIZED");
  assert.equal(applyDenied.error.retry, "new_foreground_turn");
  assert.equal(planner.calls.apply, 0);
  await assert.rejects(
    host.handle(callback("read", { query: { kind: "workspace" } }, {
      threadId: "thread-foreign",
      callId: "call-foreign",
    })),
    /ineligible native turn/u,
  );
  await assert.rejects(
    host.handle(callback("read", { query: { kind: "workspace" } }, {
      turnId: "turn-stale",
      callId: "call-stale-turn",
    })),
    /ineligible native turn/u,
  );
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_tool_calls WHERE call_id = 'call-stale-turn'",
  ).get().count, 0);
  sqlite.close();
});
