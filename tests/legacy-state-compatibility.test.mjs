import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { householdDomain } from "../lib/household-domain.ts";
import { isPlannerReadProjection } from "../lib/global-codex-contract.ts";
import { normalizeLegacyHouseholdState } from "../lib/household-persistence-upgrade.ts";
import { BROWSER_PROVENANCE } from "../lib/planner-operation-contract.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

const WEEK_ID = "2026-07-06";
const LEGACY_SOURCE_STATUSES = [
  "planned",
  "cooking",
  "moved",
  "flex",
  "leftover",
  "moved",
  "leftover",
];

function legacyState(weekLesson) {
  const meals = LEGACY_SOURCE_STATUSES.map((status, index) => ({
    id: `meal-${index + 1}`,
    date: `2026-07-${String(index + 6).padStart(2, "0")}`,
    slot: "dinner",
    title: `Legacy dinner ${index + 1}`,
    subtitle: "Existing family data",
    venue: "Home",
    status,
    protein: "chicken",
    prepNote: "",
    leftoverNote: "Makes 2 extra portions",
    notes: "",
    ingredients: index === 0 ? ["1 cup lentils"] : [],
    instructions: index === 0 ? [{
      id: "legacy-step-1",
      inputs: [{ amount: "1 cup", ingredient: "lentils" }],
      instruction: "Simmer the lentils.",
      complete: false,
    }] : [],
  }));
  return {
    householdTimeZone: "America/Halifax",
    activeWeekId: WEEK_ID,
    weeks: [
      {
        id: WEEK_ID,
        weekStartDate: WEEK_ID,
        status: "active",
        data: {
          meals,
          prep: [{
            id: "legacy-prep-1",
            stepId: "legacy-step-1",
            prepDate: "2026-07-05",
            position: 0,
          }],
          groceries: [{
            id: "legacy-grocery-1",
            section: "Produce",
            item: "Legacy carrots",
            detail: "1 bunch",
            checked: false,
            farmBox: true,
          }],
          leftovers: meals.map((meal, index) => ({
            id: `leftover-${index + 1}`,
            sourceMealId: meal.id,
            label: meal.title,
            portions: 2,
            state: "available",
          })),
          farmBoxReconciled: false,
          feedback: {},
          weekLesson,
        },
      },
    ],
  };
}

function assertSourcesCooked(state) {
  const week = state.weeks[0];
  const sourceMealIds = new Set(week.data.leftovers.map((leftover) => leftover.sourceMealId));
  assert.equal(sourceMealIds.size, LEGACY_SOURCE_STATUSES.length);
  for (const meal of week.data.meals) {
    if (sourceMealIds.has(meal.id)) assert.equal(meal.status, "cooked", meal.id);
  }
}

test("legacy leftover sources normalize atomically and idempotently before startup validation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "weekly-recipe-legacy-state-"));
  const filename = join(directory, "planner.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const beforeState = legacyState("Before legacy event");
  const currentState = legacyState("After legacy event");
  const legacyStore = openPlannerStore({ filename });
  legacyStore.transaction((transaction) => {
    legacyStore.insertWorkspace(transaction, currentState, 10);
    legacyStore.insertPlannerEvent(
      transaction,
      {
        eventId: "event-legacy",
        requestId: "request-legacy",
        actor: "Household",
        provenance: BROWSER_PROVENANCE,
        command: {
          type: "reconcileGroceries",
          weekId: WEEK_ID,
          items: [{
            id: "legacy-grocery-1",
            section: "Produce",
            item: "Legacy carrots",
            detail: "1 bunch",
            checked: false,
            farmBox: true,
          }],
        },
        baseVersion: 0,
        resultVersion: 1,
        summary: "Updated the week planning lesson",
        target: `${WEEK_ID}:lesson`,
        changes: ["Planning lesson revised"],
        revertsEventId: null,
        chatTurnId: null,
        occurredAt: 11,
      },
      beforeState,
    );
    legacyStore.insertReceipt(transaction, {
      operationKind: "planner_command",
      requestId: "request-legacy",
      payloadHash: "legacy-hash",
      httpStatus: 200,
      decision: { kind: "planner_decision", decision: { status: "accepted" } },
      createdAt: 11,
    });
    transaction
      .prepare(
        `UPDATE workspace
         SET planner_version = 1, sync_revision = 2, state_json = ?, updated_at = 11
         WHERE id = 'household'`,
      )
      .run(JSON.stringify(currentState));
  });
  legacyStore.close();

  const upgraded = openPlannerStore({ filename });
  const firstRead = upgraded.readInitializedWorkspace();
  assert.equal(firstRead.plannerVersion, 1);
  assert.equal(firstRead.syncRevision, 3);
  assert.equal(firstRead.events.length, 1);
  assert.equal(firstRead.events[0].command.type, "reconcileGroceries");
  assert.equal(isPlannerReadProjection({
    initialized: true,
    schemaVersion: firstRead.schemaVersion,
    plannerVersion: firstRead.plannerVersion,
    syncRevision: firstRead.syncRevision,
    state: firstRead.state,
    events: firstRead.events.map((event) => {
      const sanitized = { ...event };
      delete sanitized.chatTurnId;
      return sanitized;
    }),
  }), true);
  const historicalBatch = structuredClone(firstRead.events[0]);
  delete historicalBatch.chatTurnId;
  historicalBatch.command = {
    type: "plannerBatch",
    operations: [{ command: structuredClone(firstRead.events[0].command) }],
  };
  assert.equal(isPlannerReadProjection({
    initialized: true,
    schemaVersion: firstRead.schemaVersion,
    plannerVersion: firstRead.plannerVersion,
    syncRevision: firstRead.syncRevision,
    state: firstRead.state,
    events: [historicalBatch],
  }), true);
  assert.equal(firstRead.state.weeks[0].data.leftovers.length, LEGACY_SOURCE_STATUSES.length);
  const migratedMeal = firstRead.state.weeks[0].data.meals[0];
  assert.deepEqual(
    migratedMeal.ingredients.map(({ amount, ingredient }) => ({ amount, ingredient })),
    [{ amount: "1 cup", ingredient: "lentils" }],
  );
  assert.equal(migratedMeal.instructions[0].inputs[0].ingredientId, migratedMeal.ingredients[0].id);
  assert.deepEqual(firstRead.state.weeks[0].data.prepSessions, [{
    id: "legacy-prep-session-2026-07-05",
    label: "Prep 2026-07-05",
    prepDate: "2026-07-05",
    steps: [{ id: "legacy-prep-1", stepId: "legacy-step-1" }],
  }]);
  assert.equal(firstRead.state.weeks[0].data.groceries.length, 1, "unmatched legacy carrots leave the active list");
  assert.deepEqual(firstRead.state.weeks[0].data.groceries[0], {
    id: firstRead.state.weeks[0].data.groceries[0].id,
    mealId: migratedMeal.id,
    ingredientId: migratedMeal.ingredients[0].id,
    section: "Pantry",
    checked: false,
    source: "shop",
  }, "lentils gains its derived grocery execution row");
  assert.equal("farmBoxReconciled" in firstRead.state.weeks[0].data, false);
  assertSourcesCooked(firstRead.state);
  upgraded.readTransaction((transaction) => {
    const latest = upgraded.readLatestPlannerEvent(transaction);
    assert.ok(latest);
    assertSourcesCooked(latest.beforeState);
    assert.equal(latest.beforeState.weeks[0].data.groceries[0].source, "shop");
    assert.equal(latest.event.command.type, "reconcileGroceries");
    assert.equal(latest.event.command.items[0].item, "Legacy carrots", "historical command JSON remains immutable");
    assert.equal(
      upgraded.findReceipt(transaction, "planner_command", "request-legacy")?.payloadHash,
      "legacy-hash",
    );
  });
  upgraded.close();

  const reopened = openPlannerStore({ filename });
  assert.equal(reopened.readInitializedWorkspace().syncRevision, 3);
  let id = 0;
  const service = createPlannerApplicationService({
    store: reopened,
    domain: householdDomain,
    seedFactory: () => legacyState("Unused seed"),
    transformLegacyV2: () => {
      throw new Error("Unused legacy browser transform");
    },
    clock: { now: () => 20 },
    idFactory: { createId: (prefix) => `${prefix}-${++id}` },
  });
  const next = service.applyCommand({
    requestId: "request-after-upgrade",
    basePlannerVersion: 1,
    command: {
      type: "captureWeekLesson",
      weekId: WEEK_ID,
      weekLesson: "The next family change succeeds",
    },
  });
  assert.equal(next.decision.status, "accepted");
  assert.equal(next.workspace.plannerVersion, 2);
  assertSourcesCooked(next.workspace.state);
  reopened.close();
});

test("canonical-looking legacy ingredient records are merged before their step links are reused", () => {
  const state = legacyState("Merge ingredient records");
  const meal = state.weeks[0].data.meals[0];
  meal.ingredients = [
    { id: "ingredient-peppers-legacy", amount: "2 red", ingredient: "peppers" },
    { id: "ingredient-red-peppers", amount: "2", ingredient: "red peppers" },
  ];
  meal.instructions = [{
    id: "legacy-pepper-step",
    inputs: [{ amount: "2", ingredient: "red peppers", ingredientId: "ingredient-red-peppers" }],
    instruction: "Roast the peppers.",
    complete: false,
  }];
  state.weeks[0].data.prep = [];

  const normalized = normalizeLegacyHouseholdState(state);
  assert.equal(normalized.changed, true);
  const normalizedMeal = normalized.state.weeks[0].data.meals[0];
  assert.deepEqual(normalizedMeal.ingredients, [
    { id: "ingredient-peppers-legacy", amount: "2", ingredient: "red peppers" },
  ]);
  assert.equal(normalizedMeal.instructions[0].inputs[0].ingredientId, "ingredient-peppers-legacy");
});
