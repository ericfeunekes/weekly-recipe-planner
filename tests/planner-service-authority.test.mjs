import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PlannerServiceError,
  createPlannerApplicationService,
  hashCanonicalPayload,
} from "../server/application/planner-service.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "weekly-recipe-service-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "planner.sqlite");
}

function seedState(lesson = "Initial lesson") {
  return {
    householdTimeZone: "America/Halifax",
    activeWeekId: "2026-07-06",
    weeks: [
      {
        id: "2026-07-06",
        weekStartDate: "2026-07-06",
        status: "active",
        data: {
          meals: [
            {
              id: "meal-1",
              date: "2026-07-07",
              slot: "dinner",
              title: "Rice bowls",
              subtitle: "Vegetables and sauce",
              venue: "Home",
              status: "planned",
              protein: "none",
              prepNote: "Cook rice Sunday",
              leftoverNote: "Two lunches",
              notes: "",
              ingredients: ["1 cup rice"],
              instructions: [
                {
                  id: "step-rice",
                  inputs: [
                    { amount: "1 cup", ingredient: "rice" },
                    { amount: "2 cups", ingredient: "water" },
                  ],
                  instruction: "Cook the rice.",
                  complete: false,
                  timerDurationSeconds: 1_200,
                },
              ],
            },
          ],
          prep: [
            {
              id: "prep-rice",
              stepId: "step-rice",
              prepDate: "2026-07-05",
              position: 0,
            },
          ],
          groceries: [],
          leftovers: [],
          farmBoxReconciled: false,
          feedback: {},
          weekLesson: lesson,
        },
      },
    ],
  };
}

function fakeDomain() {
  return {
    validateState(value) {
      const valid =
        value &&
        value.householdTimeZone === "America/Halifax" &&
        Array.isArray(value.weeks) &&
        value.weeks.length === 1 &&
        value.weeks[0].id === "2026-07-06";
      return valid
        ? { ok: true }
        : { ok: false, issues: [{ path: "state", message: "invalid fixture" }] };
    },
    execute(value, command) {
      const next = structuredClone(value);
      const week = next.weeks[0];
      if (command.type === "captureWeekLesson") {
        if (week.data.weekLesson === command.weekLesson) {
          return { ok: false, state: value, message: "Planning lesson is unchanged." };
        }
        week.data.weekLesson = command.weekLesson;
        return {
          ok: true,
          state: next,
          summary: "Updated the week planning lesson",
          target: command.weekId,
          changes: ["Planning lesson revised"],
          createdIds: {},
        };
      }
      if (command.type === "setInstructionStepComplete") {
        const step = week.data.meals[0].instructions[0];
        if (step.complete === command.complete) {
          return { ok: false, state: value, message: "Step completion is unchanged." };
        }
        step.complete = command.complete;
        return {
          ok: true,
          state: next,
          summary: command.complete ? "Completed rice" : "Reopened rice",
          target: step.id,
          changes: [`Complete: ${!command.complete} to ${command.complete}`],
          createdIds: {},
        };
      }
      return { ok: false, state: value, message: `Unsupported fake command ${command.type}` };
    },
  };
}

let globalId = 0;

function dependencies(store, overrides = {}) {
  let now = 1_800_000_000_000;
  return {
    store,
    domain: fakeDomain(),
    seedFactory: () => seedState(),
    transformLegacyV2: () => ({
      state: seedState("Imported lesson"),
      transcriptEntries: [
        {
          role: "user",
          text: "Keep Tuesday simple.",
          context: { view: "week", weekId: "2026-07-06" },
        },
      ],
      discardedEventCount: 2,
    }),
    clock: { now: () => now++ },
    idFactory: { createId: (prefix) => `${prefix}-${++globalId}` },
    ...overrides,
  };
}

function lessonCommand(requestId, basePlannerVersion, weekLesson) {
  return {
    requestId,
    basePlannerVersion,
    command: {
      type: "captureWeekLesson",
      weekId: "2026-07-06",
      weekLesson,
    },
  };
}

test("canonical payload hashing ignores object key order and includes operation kind", () => {
  const first = hashCanonicalPayload("planner_command", {
    requestId: "one",
    command: { type: "captureWeekLesson", weekLesson: "Plan", weekId: "2026-07-06" },
  });
  const reordered = hashCanonicalPayload("planner_command", {
    command: { weekId: "2026-07-06", weekLesson: "Plan", type: "captureWeekLesson" },
    requestId: "one",
  });
  assert.equal(first, reordered);
  assert.notEqual(first, hashCanonicalPayload("planner_undo", { requestId: "one" }));
});

test("commits one event, resolves two stale writers, and replays immutable decisions", (t) => {
  const filename = temporaryDatabase(t);
  const storeA = openPlannerStore({ filename });
  const serviceA = createPlannerApplicationService(dependencies(storeA));
  const bootstrapped = serviceA.bootstrap({ requestId: "bootstrap", mode: "seed" });
  assert.equal(bootstrapped.workspace.plannerVersion, 0);
  assert.equal(bootstrapped.workspace.syncRevision, 1);

  const storeB = openPlannerStore({ filename });
  const serviceB = createPlannerApplicationService(dependencies(storeB));
  const winnerRequest = lessonCommand("winner", 0, "Cook rice Sunday");
  const loserRequest = lessonCommand("loser", 0, "Cook rice Monday");
  const winner = serviceA.applyCommand(winnerRequest);
  const loser = serviceB.applyCommand(loserRequest);

  assert.equal(winner.decision.status, "accepted");
  assert.equal(winner.workspace.plannerVersion, 1);
  assert.equal(winner.workspace.syncRevision, 2);
  assert.equal(winner.workspace.events.length, 1);
  assert.equal(loser.decision.status, "version_conflict");
  assert.equal(loser.workspace.plannerVersion, 1);
  assert.equal(loser.workspace.events.length, 1);

  const secondWinner = serviceB.applyCommand(lessonCommand("winner-2", 1, "Soak rice Sunday"));
  assert.equal(secondWinner.decision.status, "accepted");
  assert.equal(secondWinner.workspace.plannerVersion, 2);

  const replayedConflict = serviceA.applyCommand(loserRequest);
  assert.deepEqual(replayedConflict.decision, loser.decision);
  assert.equal(replayedConflict.workspace.plannerVersion, 2);
  assert.equal(replayedConflict.workspace.state.weeks[0].data.weekLesson, "Soak rice Sunday");

  assert.throws(
    () => serviceA.applyCommand(lessonCommand("winner", 0, "Changed payload")),
    (error) => error instanceof PlannerServiceError && error.code === "REQUEST_ID_REUSE",
  );
  assert.equal(serviceA.readWorkspace().events.length, 2);
  storeB.close();
  storeA.close();

  const reopened = openPlannerStore({ filename });
  const restartedService = createPlannerApplicationService(dependencies(reopened));
  const replayedWinner = restartedService.applyCommand(winnerRequest);
  assert.deepEqual(replayedWinner.decision, winner.decision);
  assert.equal(replayedWinner.workspace.plannerVersion, 2);
  assert.equal(replayedWinner.workspace.events.length, 2);
  reopened.close();
});

test("latest-only undo restores one prior state and cannot erase later work", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store));
  service.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const changed = service.applyCommand(lessonCommand("lesson", 0, "New lesson"));
  assert.equal(changed.decision.status, "accepted");

  const undone = service.undoLatest({
    requestId: "undo",
    basePlannerVersion: 1,
    targetEventId: changed.decision.eventId,
  });
  assert.equal(undone.decision.status, "accepted");
  assert.equal(undone.workspace.plannerVersion, 2);
  assert.equal(undone.workspace.state.weeks[0].data.weekLesson, "Initial lesson");
  assert.equal(undone.workspace.events[0].revertsEventId, changed.decision.eventId);

  const replay = service.undoLatest({
    requestId: "undo",
    basePlannerVersion: 1,
    targetEventId: changed.decision.eventId,
  });
  assert.deepEqual(replay.decision, undone.decision);
  assert.equal(replay.workspace.events.length, 2);

  const undoAgain = service.undoLatest({
    requestId: "undo-again",
    basePlannerVersion: 2,
    targetEventId: changed.decision.eventId,
  });
  assert.equal(undoAgain.decision.status, "domain_rejected");
  assert.equal(undoAgain.workspace.plannerVersion, 2);
  assert.equal(undoAgain.workspace.events.length, 2);
  store.close();
});

test("every injected command failure rolls the transaction back and permits exact retry", () => {
  for (const point of [
    "after_workspace_update",
    "after_event_insert",
    "after_receipt_insert",
    "after_planner_mutation",
    "before_commit",
  ]) {
    const store = openPlannerStore({ filename: ":memory:" });
    let armed = false;
    const service = createPlannerApplicationService(
      dependencies(store, {
        failureInjector: {
          hit(candidate) {
            if (armed && candidate === point) throw new Error(`fail:${point}`);
          },
        },
      }),
    );
    service.bootstrap({ requestId: "bootstrap", mode: "seed" });
    armed = true;
    const request = lessonCommand(`request-${point}`, 0, "Changed");
    assert.throws(() => service.applyCommand(request), new RegExp(`fail:${point}`));
    assert.equal(service.readWorkspace().plannerVersion, 0, point);
    assert.equal(service.readWorkspace().events.length, 0, point);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'planner_command'").get().count,
      0,
      point,
    );
    armed = false;
    assert.equal(service.applyCommand(request).decision.status, "accepted", point);
    store.close();
  }
});

test("bootstrap is atomic, imports transcript once, and arbitrates a second client", (t) => {
  const filename = temporaryDatabase(t);
  const storeA = openPlannerStore({ filename });
  let fail = true;
  const serviceA = createPlannerApplicationService(
    dependencies(storeA, {
      failureInjector: {
        hit(point) {
          if (fail && point === "after_receipt_insert") throw new Error("bootstrap failure");
        },
      },
    }),
  );
  const importRequest = {
    requestId: "import",
    mode: "import-v2",
    payload: { data: {}, events: [], chatMessages: [] },
  };
  assert.throws(() => serviceA.bootstrap(importRequest), /bootstrap failure/);
  assert.deepEqual(serviceA.readWorkspace(), { initialized: false, schemaVersion: 1 });
  fail = false;
  const imported = serviceA.bootstrap(importRequest);
  assert.equal(imported.imported, true);
  assert.equal(imported.workspace.transcriptEntries.length, 1);
  assert.equal(imported.workspace.state.weeks[0].data.weekLesson, "Imported lesson");

  const storeB = openPlannerStore({ filename });
  const serviceB = createPlannerApplicationService(dependencies(storeB));
  const losingRequest = { requestId: "seed-loser", mode: "seed" };
  assert.throws(
    () => serviceB.bootstrap(losingRequest),
    (error) =>
      error instanceof PlannerServiceError &&
      error.code === "ALREADY_INITIALIZED" &&
      error.workspace.state.weeks[0].data.weekLesson === "Imported lesson",
  );
  assert.throws(
    () => serviceB.bootstrap(losingRequest),
    (error) => error instanceof PlannerServiceError && error.code === "ALREADY_INITIALIZED",
  );
  assert.throws(
    () => serviceB.bootstrap({ requestId: "seed-loser", mode: "import-v2", payload: importRequest.payload }),
    (error) => error instanceof PlannerServiceError && error.code === "REQUEST_ID_REUSE",
  );

  const exported = serviceA.exportWorkspace();
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.transcriptEntries.length, 1);
  assert.equal(exported.events.length, 0);
  storeB.close();
  storeA.close();
});

test("invalid legacy bootstrap fails visibly without initializing the workspace", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(
    dependencies(store, {
      transformLegacyV2() {
        throw Object.assign(new Error("Legacy prep date is invalid."), {
          fieldErrors: { "data.prep[0].due": "Expected an ISO date." },
        });
      },
    }),
  );
  assert.throws(
    () =>
      service.bootstrap({
        requestId: "bad-import",
        mode: "import-v2",
        payload: { data: {}, events: [], chatMessages: [] },
      }),
    (error) =>
      error instanceof PlannerServiceError &&
      error.code === "INVALID_REQUEST" &&
      error.fieldErrors["data.prep[0].due"] === "Expected an ISO date.",
  );
  assert.deepEqual(service.readWorkspace(), { initialized: false, schemaVersion: 1 });
  assert.throws(
    () => service.readEventPage({}),
    (error) => error instanceof PlannerServiceError && error.code === "NOT_INITIALIZED",
  );
  store.close();
});

test("history and transcript pages use exclusive newest-first cursors", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store));
  service.bootstrap({ requestId: "bootstrap", mode: "import-v2", payload: { data: {}, events: [], chatMessages: [] } });
  service.applyCommand(lessonCommand("one", 0, "One"));
  service.applyCommand(lessonCommand("two", 1, "Two"));
  service.applyCommand(lessonCommand("three", 2, "Three"));

  const first = service.readEventPage({ limit: 2 });
  assert.deepEqual(first.items.map((event) => event.requestId), ["three", "two"]);
  assert.equal(first.nextBeforeSequence, first.items[1].sequence);
  const second = service.readEventPage({ beforeSequence: first.nextBeforeSequence, limit: 2 });
  assert.deepEqual(second.items.map((event) => event.requestId), ["one"]);
  assert.equal(second.nextBeforeSequence, null);

  const transcript = service.readTranscriptPage({ limit: 1 });
  assert.equal(transcript.items.length, 1);
  assert.equal(transcript.items[0].text, "Keep Tuesday simple.");
  assert.equal(transcript.nextBeforeSequence, null);
  store.close();
});
