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

test("combined Prep edit, move, remove, clear, undo, and wording survive file reopen", (t) => {
  const filename = temporaryDatabase(t);
  let seedId = 0;
  let now = 1_810_000_000_000;
  const durableIdCounts = new Map();
  const dependencies = (store) => ({
    store,
    domain: householdDomain,
    seedFactory: () => createCanonicalSeed({
      now,
      createId: (prefix) => `lifecycle-seed-${prefix}-${++seedId}`,
    }),
    transformLegacyV2: () => {
      throw new Error("Legacy import is outside this fixture.");
    },
    clock: { now: () => now++ },
    idFactory: {
      createId(prefix) {
        const count = (durableIdCounts.get(prefix) ?? 0) + 1;
        durableIdCounts.set(prefix, count);
        return `lifecycle-${prefix}-${count}`;
      },
    },
  });

  const firstStore = openPlannerStore({ filename });
  const firstService = createPlannerApplicationService(dependencies(firstStore));
  const bootstrapped = firstService.bootstrap({
    requestId: "combined-prep-lifecycle-bootstrap",
    mode: "seed",
  });
  const week = activeWeek(bootstrapped.workspace);
  const sourceStepIds = week.data.prepSessions
    .flatMap((session) => session.steps)
    .filter((entry) => "stepId" in entry)
    .map((entry) => entry.stepId);
  const sourceSession = week.data.prepSessions.find((session) =>
    session.steps.some((entry) => "stepId" in entry && entry.stepId === sourceStepIds[0])
  );
  const destinationSession = week.data.prepSessions.find((session) => session.prepDate !== sourceSession?.prepDate);
  assert.ok(sourceSession);
  assert.ok(destinationSession);

  const created = firstService.applyCommand({
    requestId: "combined-prep-lifecycle-create",
    basePlannerVersion: 0,
    command: {
      type: "combinePrepStepsOnDate",
      weekId: week.id,
      prepDate: sourceSession.prepDate,
      sourceStepIds,
      instruction: "Prepare the first shared batch.",
      targetPosition: sourceSession.steps.length,
    },
  });
  const entryId = combinedEntry(activeWeek(created.workspace)).id;
  const edited = firstService.applyCommand({
    requestId: "combined-prep-lifecycle-edit",
    basePlannerVersion: 1,
    command: {
      type: "updateCombinedPrepStep",
      weekId: week.id,
      entryId,
      instruction: "Prepare the durable shared batch.",
    },
  });
  assert.equal(combinedEntry(activeWeek(edited.workspace)).instruction, "Prepare the durable shared batch.");
  const moved = firstService.applyCommand({
    requestId: "combined-prep-lifecycle-move",
    basePlannerVersion: 2,
    command: {
      type: "movePrepStepsToDate",
      weekId: week.id,
      sourcePrepDate: sourceSession.prepDate,
      prepDate: destinationSession.prepDate,
      entryIds: [entryId],
      targetPosition: 0,
    },
  });
  assert.equal(moved.decision.status, "accepted", JSON.stringify(moved.decision));
  firstStore.close();

  const reopenedStore = openPlannerStore({ filename });
  const reopenedService = createPlannerApplicationService(dependencies(reopenedStore));
  const reopened = reopenedService.readWorkspace();
  assert.equal(reopened.plannerVersion, 3);
  assert.equal(combinedEntry(activeWeek(reopened)).instruction, "Prepare the durable shared batch.");
  assert.ok(activeWeek(reopened).data.prepSessions.find((session) =>
    session.prepDate === destinationSession.prepDate && session.steps.some((entry) => entry.id === entryId)
  ));

  const removed = reopenedService.applyCommand({
    requestId: "combined-prep-lifecycle-remove",
    basePlannerVersion: 3,
    command: {
      type: "removePrepStepsFromDate",
      weekId: week.id,
      prepDate: destinationSession.prepDate,
      entryIds: [entryId],
    },
  });
  assert.equal(removed.decision.status, "accepted");
  assert.equal(activeWeek(removed.workspace).data.prepSessions.flatMap((session) => session.steps).some((entry) => entry.id === entryId), false);
  const restoredRemoval = reopenedService.undoLatest({
    requestId: "combined-prep-lifecycle-remove-undo",
    basePlannerVersion: 4,
    targetEventId: removed.decision.eventId,
  });
  assert.equal(combinedEntry(activeWeek(restoredRemoval.workspace)).instruction, "Prepare the durable shared batch.");

  const completed = reopenedService.applyCommand({
    requestId: "combined-prep-lifecycle-complete",
    basePlannerVersion: 5,
    command: {
      type: "setCombinedPrepStepComplete",
      weekId: week.id,
      entryId,
      complete: true,
    },
  });
  assert.equal(combinedEntry(activeWeek(completed.workspace)).complete, true);
  const cleared = reopenedService.applyCommand({
    requestId: "combined-prep-lifecycle-clear",
    basePlannerVersion: 6,
    command: {
      type: "clearPrepDate",
      weekId: week.id,
      prepDate: destinationSession.prepDate,
      discardFulfillment: true,
    },
  });
  assert.equal(cleared.decision.status, "accepted");
  const restoredClear = reopenedService.undoLatest({
    requestId: "combined-prep-lifecycle-clear-undo",
    basePlannerVersion: 7,
    targetEventId: cleared.decision.eventId,
  });
  const restoredEntry = combinedEntry(activeWeek(restoredClear.workspace));
  assert.equal(restoredEntry.complete, true);
  assert.equal(restoredEntry.instruction, "Prepare the durable shared batch.");
  assert.equal(reopenedStore.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  reopenedStore.close();

  const finalStore = openPlannerStore({ filename });
  const finalService = createPlannerApplicationService(dependencies(finalStore));
  const finalEntry = combinedEntry(activeWeek(finalService.readWorkspace()));
  assert.equal(finalEntry.complete, true);
  assert.equal(finalEntry.instruction, "Prepare the durable shared batch.");
  assert.equal(finalStore.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  finalStore.close();
});
