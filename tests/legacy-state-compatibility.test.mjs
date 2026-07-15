import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { householdDomain } from "../lib/household-domain.ts";
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
    ingredients: [],
    instructions: [],
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
          prep: [],
          groceries: [],
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
          type: "captureWeekLesson",
          weekId: WEEK_ID,
          weekLesson: "After legacy event",
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
  assert.equal(firstRead.state.weeks[0].data.leftovers.length, LEGACY_SOURCE_STATUSES.length);
  assertSourcesCooked(firstRead.state);
  upgraded.readTransaction((transaction) => {
    const latest = upgraded.readLatestPlannerEvent(transaction);
    assert.ok(latest);
    assertSourcesCooked(latest.beforeState);
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
