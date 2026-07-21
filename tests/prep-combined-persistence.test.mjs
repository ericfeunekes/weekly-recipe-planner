import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import {
  PlannerServiceError,
  createPlannerApplicationService,
} from "../server/application/planner-service.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "weekly-recipe-combined-prep-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "planner.sqlite");
}

function activeWeek(workspace) {
  const week = workspace.state.weeks.find(
    (candidate) => candidate.id === workspace.state.activeWeekId,
  );
  assert.ok(week);
  return week;
}

function combinedEntry(week) {
  const entries = week.data.prepSessions.flatMap((session) => session.steps);
  const combined = entries.find((entry) => entry.kind === "combined");
  assert.ok(combined);
  return combined;
}

test("combined Prep survives file-backed completion, replay, expansion, undo, and reopen", (t) => {
  const filename = temporaryDatabase(t);
  let seedId = 0;
  let now = 1_800_000_000_000;
  const durableIdCounts = new Map();
  const dependencies = (store) => ({
    store,
    domain: householdDomain,
    seedFactory: () => createCanonicalSeed({
      now,
      createId: (prefix) => `seed-${prefix}-${++seedId}`,
    }),
    transformLegacyV2: () => {
      throw new Error("Legacy import is outside this fixture.");
    },
    clock: { now: () => now++ },
    idFactory: {
      createId(prefix) {
        const count = (durableIdCounts.get(prefix) ?? 0) + 1;
        durableIdCounts.set(prefix, count);
        return `durable-${prefix}-${count}`;
      },
    },
  });

  const firstStore = openPlannerStore({ filename });
  const firstService = createPlannerApplicationService(dependencies(firstStore));
  const bootstrapped = firstService.bootstrap({
    requestId: "combined-prep-bootstrap",
    mode: "seed",
  });
  const initialWeek = activeWeek(bootstrapped.workspace);
  const sourceStepIds = initialWeek.data.prepSessions
    .flatMap((session) => session.steps)
    .filter((entry) => "stepId" in entry)
    .map((entry) => entry.stepId);
  assert.equal(sourceStepIds.length, 2);
  const targetSession = initialWeek.data.prepSessions.find((session) =>
    session.steps.some((entry) => "stepId" in entry && entry.stepId === sourceStepIds[0])
  );
  assert.ok(targetSession);

  const combineRequest = {
    requestId: "combined-prep-create",
    basePlannerVersion: 0,
    command: {
      type: "combinePrepStepsOnDate",
      weekId: initialWeek.id,
      prepDate: targetSession.prepDate,
      sourceStepIds,
      instruction: "Prepare the shared batch.",
      targetPosition: targetSession.steps.length,
    },
  };
  const created = firstService.applyCommand(combineRequest);
  assert.equal(created.decision.status, "accepted");
  const createdEntry = combinedEntry(activeWeek(created.workspace));
  assert.deepEqual(createdEntry.sources.map((source) => source.stepId), sourceStepIds);

  const completeRequest = {
    requestId: "combined-prep-complete",
    basePlannerVersion: 1,
    command: {
      type: "setCombinedPrepStepComplete",
      weekId: initialWeek.id,
      entryId: createdEntry.id,
      complete: true,
    },
  };
  const completed = firstService.applyCommand(completeRequest);
  assert.equal(completed.decision.status, "accepted");
  const completedWeek = activeWeek(completed.workspace);
  assert.equal(combinedEntry(completedWeek).complete, true);
  const completedPrepSessions = structuredClone(completedWeek.data.prepSessions);
  assert.equal(firstStore.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  firstStore.close();

  const reopenedStore = openPlannerStore({ filename });
  const reopenedService = createPlannerApplicationService(dependencies(reopenedStore));
  const reopened = reopenedService.readWorkspace();
  assert.equal(reopened.plannerVersion, 2);
  assert.deepEqual(activeWeek(reopened).data.prepSessions, completedPrepSessions);

  const replayedCreate = reopenedService.applyCommand(structuredClone(combineRequest));
  assert.deepEqual(replayedCreate.decision, created.decision);
  assert.equal(replayedCreate.workspace.events.length, 2);
  const replayedComplete = reopenedService.applyCommand(structuredClone(completeRequest));
  assert.deepEqual(replayedComplete.decision, completed.decision);
  assert.equal(replayedComplete.workspace.events.length, 2);
  assert.throws(
    () => reopenedService.applyCommand({
      ...structuredClone(combineRequest),
      command: {
        ...combineRequest.command,
        instruction: "A changed payload must not reuse the request ID.",
      },
    }),
    (error) => error instanceof PlannerServiceError && error.code === "REQUEST_ID_REUSE",
  );

  const expanded = reopenedService.applyCommand({
    requestId: "combined-prep-expand",
    basePlannerVersion: 2,
    command: {
      type: "expandCombinedPrepStep",
      weekId: initialWeek.id,
      entryId: createdEntry.id,
      discardFulfillment: true,
    },
  });
  assert.equal(expanded.decision.status, "accepted");
  const expandedSession = activeWeek(expanded.workspace).data.prepSessions.find(
    (session) => session.prepDate === targetSession.prepDate,
  );
  assert.ok(expandedSession);
  assert.deepEqual(
    expandedSession.steps.map((entry) => "stepId" in entry ? entry.stepId : entry.id),
    sourceStepIds,
  );

  const undone = reopenedService.undoLatest({
    requestId: "combined-prep-expand-undo",
    basePlannerVersion: 3,
    targetEventId: expanded.decision.eventId,
  });
  assert.equal(undone.decision.status, "accepted");
  assert.deepEqual(activeWeek(undone.workspace).data.prepSessions, completedPrepSessions);
  const restored = combinedEntry(activeWeek(undone.workspace));
  assert.equal(restored.complete, true);
  assert.deepEqual(restored.sources.map((source) => source.stepId), sourceStepIds);
  assert.equal(reopenedStore.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  reopenedStore.close();

  const finalStore = openPlannerStore({ filename });
  const finalService = createPlannerApplicationService(dependencies(finalStore));
  assert.deepEqual(
    activeWeek(finalService.readWorkspace()).data.prepSessions,
    completedPrepSessions,
  );
  assert.equal(finalStore.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  finalStore.close();
});
