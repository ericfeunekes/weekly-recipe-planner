import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { householdDomain } from "../lib/household-domain.ts";
import {
  DIAGNOSTIC_EXPORT_FORMAT_VERSION,
  DIAGNOSTIC_EXPORT_KIND,
  DIAGNOSTIC_EXPORT_WARNING,
} from "../lib/planner-api-contract.ts";
import {
  EMBEDDED_CODEX_PROVENANCE,
  GLOBAL_CODEX_PROVENANCE,
} from "../lib/planner-operation-contract.ts";
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

const globalContext = {
  operationKind: "global_codex_apply_planner_batch_v1",
  provenance: GLOBAL_CODEX_PROVENANCE,
};

function operationsRequest(requestId, basePlannerVersion, commands) {
  return {
    requestId,
    basePlannerVersion,
    operations: commands.map((command) => ({ command })),
  };
}

function createAcceptedV1PlannerDatabase(filename, request) {
  const database = new DatabaseSync(filename);
  try {
    database.exec(
      readFileSync(
        new URL("../server/store/migrations/001-initial.sql", import.meta.url),
        "utf8",
      ),
    );
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1)").run();
    database
      .prepare(
        `INSERT INTO workspace
          (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at)
         VALUES ('household', 1, 1, 2, ?, 1, 2)`,
      )
      .run(JSON.stringify(seedState(request.command.weekLesson)));
    database
      .prepare(
        `INSERT INTO planner_events
          (event_id, request_id, actor, command_json, base_version, result_version,
           summary, target, changes_json, before_state_json, reverts_event_id,
           chat_turn_id, occurred_at)
         VALUES ('event-v1', ?, 'Household', ?, 0, 1,
           'Updated the week planning lesson', '2026-07-06', ?, ?, NULL, NULL, 2)`,
      )
      .run(
        request.requestId,
        JSON.stringify(request.command),
        JSON.stringify(["Planning lesson revised"]),
        JSON.stringify(seedState()),
      );
    database
      .prepare(
        `INSERT INTO command_receipts
          (operation_kind, request_id, payload_hash, http_status, decision_json, created_at)
         VALUES ('planner_command', ?, ?, 200, ?, 2)`,
      )
      .run(
        request.requestId,
        hashCanonicalPayload("planner_command", request),
        JSON.stringify({
          kind: "planner_decision",
          decision: { status: "accepted", eventId: "event-v1", plannerVersion: 1 },
        }),
      );
  } finally {
    database.close();
  }
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
  assert.equal(winner.workspace.events[0].command.type, "captureWeekLesson");
  assert.deepEqual(winner.workspace.events[0].provenance, {
    actorClass: "household",
    actorSource: "browser",
    admission: "same_origin_http_v1",
  });
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

test("accepted bootstrap and undo receipts replay after a real-file reopen", (t) => {
  const filename = temporaryDatabase(t);
  const bootstrapRequest = { requestId: "reopen-bootstrap", mode: "seed" };
  const undoRequest = {
    requestId: "reopen-undo",
    basePlannerVersion: 1,
    targetEventId: null,
  };

  const firstStore = openPlannerStore({ filename });
  const firstService = createPlannerApplicationService(dependencies(firstStore));
  const bootstrapped = firstService.bootstrap(bootstrapRequest);
  assert.equal(bootstrapped.imported, false);
  const changed = firstService.applyCommand(
    lessonCommand("reopen-undo-target", 0, "Reopen-safe lesson"),
  );
  assert.equal(changed.decision.status, "accepted");
  undoRequest.targetEventId = changed.decision.eventId;
  const undone = firstService.undoLatest(undoRequest);
  assert.equal(undone.decision.status, "accepted");
  assert.equal(undone.workspace.events.length, 2);
  firstStore.close();

  const reopenedStore = openPlannerStore({ filename });
  const reopenedService = createPlannerApplicationService(dependencies(reopenedStore));
  const replayedBootstrap = reopenedService.bootstrap(structuredClone(bootstrapRequest));
  assert.equal(replayedBootstrap.imported, false);
  assert.equal(replayedBootstrap.workspace.events.length, 2);
  const replayedUndo = reopenedService.undoLatest(structuredClone(undoRequest));
  assert.deepEqual(replayedUndo.decision, undone.decision);
  assert.equal(replayedUndo.workspace.events.length, 2);
  assert.equal(replayedUndo.workspace.state.weeks[0].data.weekLesson, "Initial lesson");
  for (const [operationKind, requestId] of [
    ["workspace_bootstrap", bootstrapRequest.requestId],
    ["planner_undo", undoRequest.requestId],
  ]) {
    assert.equal(
      reopenedStore.database.prepare(
        "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = ? AND request_id = ?",
      ).get(operationKind, requestId).count,
      1,
    );
  }
  reopenedStore.close();
});

test("v1 planner receipts replay unchanged after the v2 migration", (t) => {
  const filename = temporaryDatabase(t);
  const request = lessonCommand("legacy-replay", 0, "Legacy accepted lesson");
  createAcceptedV1PlannerDatabase(filename, request);

  const store = openPlannerStore({ filename });
  const service = createPlannerApplicationService(dependencies(store));
  const replay = service.applyCommand(request);
  assert.deepEqual(replay.decision, {
    status: "accepted",
    eventId: "event-v1",
    plannerVersion: 1,
  });
  assert.equal(replay.workspace.schemaVersion, 5);
  assert.equal(replay.workspace.plannerVersion, 1);
  assert.equal(replay.workspace.events.length, 1);
  assert.deepEqual(replay.workspace.events[0].provenance, {
    actorClass: "household",
    actorSource: "browser",
    admission: "same_origin_http_v1",
  });
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
  assert.deepEqual(serviceA.readWorkspace(), { initialized: false, schemaVersion: 5 });
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
  assert.equal(exported.kind, DIAGNOSTIC_EXPORT_KIND);
  assert.equal(exported.formatVersion, DIAGNOSTIC_EXPORT_FORMAT_VERSION);
  assert.equal(exported.restorable, false);
  assert.equal(exported.warning, DIAGNOSTIC_EXPORT_WARNING);
  assert.equal(exported.schemaVersion, 5);
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
  assert.deepEqual(service.readWorkspace(), { initialized: false, schemaVersion: 5 });
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

test("applies ordered operations as one event, receipt, version, and undo unit", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store));
  service.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const request = operationsRequest("batch-two", 0, [
    { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Batch lesson" },
    { type: "setInstructionStepComplete", weekId: "2026-07-06", stepId: "step-rice", complete: true },
  ]);

  const applied = service.applyOperations(request, globalContext);
  assert.equal(applied.decision.status, "accepted");
  assert.equal(applied.workspace.plannerVersion, 1);
  assert.equal(applied.workspace.events.length, 1);
  assert.equal(applied.workspace.events[0].command.type, "plannerBatch");
  assert.equal(applied.workspace.events[0].command.operations.length, 2);
  assert.equal(applied.workspace.events[0].summary, "Applied 2 planner operations");
  assert.equal(applied.workspace.events[0].target, "Multiple planner targets");
  assert.deepEqual(applied.workspace.events[0].changes, [
    "1. Planning lesson revised",
    "2. Complete: false to true",
  ]);
  assert.deepEqual(applied.workspace.events[0].provenance, GLOBAL_CODEX_PROVENANCE);
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'global_codex_apply_planner_batch_v1'").get().count,
    1,
  );

  const replay = service.applyOperations(request, globalContext);
  assert.deepEqual(replay.decision, applied.decision);
  assert.equal(replay.workspace.events.length, 1);
  assert.throws(
    () => service.applyOperations({ ...request, operations: [...request.operations].reverse() }, globalContext),
    (error) => error instanceof PlannerServiceError && error.code === "REQUEST_ID_REUSE",
  );

  const stale = service.applyOperations(
    operationsRequest("stale-global", 0, [
      { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Stale" },
    ]),
    globalContext,
  );
  assert.deepEqual(stale.decision, {
    status: "version_conflict",
    expectedVersion: 0,
    actualVersion: 1,
  });
  assert.equal(stale.workspace.events.length, 1);

  const undone = service.undoLatest({
    requestId: "undo-batch",
    basePlannerVersion: 1,
    targetEventId: applied.decision.eventId,
  });
  assert.equal(undone.decision.status, "accepted");
  assert.equal(undone.workspace.state.weeks[0].data.weekLesson, "Initial lesson");
  assert.equal(undone.workspace.state.weeks[0].data.meals[0].instructions[0].complete, false);
  store.close();
});

test("a mid-list rejection stores one indexed decision and no planner effect", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store));
  service.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const request = operationsRequest("batch-rejected", 0, [
    { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Temporary lesson" },
    { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Temporary lesson" },
  ]);

  const rejected = service.applyOperations(request, globalContext);
  assert.deepEqual(rejected.decision, {
    status: "domain_rejected",
    operationIndex: 1,
    message: "Planning lesson is unchanged.",
  });
  assert.equal(rejected.workspace.plannerVersion, 0);
  assert.equal(rejected.workspace.events.length, 0);
  assert.equal(rejected.workspace.state.weeks[0].data.weekLesson, "Initial lesson");
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'global_codex_apply_planner_batch_v1'").get().count,
    1,
  );
  assert.deepEqual(service.applyOperations(request, globalContext).decision, rejected.decision);
  store.close();
});

test("invalid operation envelopes reserve no receipt or planner effect", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store));
  service.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const commands = Array.from({ length: 17 }, (_, index) => ({
    type: "captureWeekLesson",
    weekId: "2026-07-06",
    weekLesson: `Invalid bound ${index}`,
  }));

  for (const request of [
    operationsRequest("empty-operations", 0, []),
    operationsRequest("too-many-operations", 0, commands),
    {
      requestId: "malformed-operation",
      basePlannerVersion: 0,
      operations: [{ command: { type: "captureWeekLesson", weekId: "2026-07-06" } }],
    },
  ]) {
    assert.throws(
      () => service.applyOperations(request, globalContext),
      (error) => error instanceof PlannerServiceError && error.code === "INVALID_REQUEST",
    );
  }

  assert.equal(service.readWorkspace().plannerVersion, 0);
  assert.equal(service.readWorkspace().events.length, 0);
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count,
    1,
  );
  store.close();
});

test("an accepted batch replays from its immutable receipt after a real-file reopen", (t) => {
  const filename = temporaryDatabase(t);
  const request = operationsRequest("reopen-batch", 0, [
    { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Persisted batch" },
    {
      type: "setInstructionStepComplete",
      weekId: "2026-07-06",
      stepId: "step-rice",
      complete: true,
    },
  ]);

  const firstStore = openPlannerStore({ filename });
  const firstService = createPlannerApplicationService(dependencies(firstStore));
  firstService.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const applied = firstService.applyOperations(request, globalContext);
  assert.equal(applied.decision.status, "accepted");
  firstStore.close();

  const reopenedStore = openPlannerStore({ filename });
  const reopenedService = createPlannerApplicationService(dependencies(reopenedStore));
  const replay = reopenedService.applyOperations(request, globalContext);
  assert.deepEqual(replay.decision, applied.decision);
  assert.equal(replay.workspace.plannerVersion, 1);
  assert.equal(replay.workspace.events.length, 1);
  assert.equal(replay.workspace.events[0].command.type, "plannerBatch");
  assert.equal(
    reopenedStore.database
      .prepare(
        "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'global_codex_apply_planner_batch_v1' AND request_id = 'reopen-batch'",
      )
      .get().count,
    1,
  );
  reopenedStore.close();
});

test("every batch write failpoint rolls back the whole ordered unit", () => {
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
            if (armed && candidate === point) throw new Error(`batch-fail:${point}`);
          },
        },
      }),
    );
    service.bootstrap({ requestId: "bootstrap", mode: "seed" });
    const request = operationsRequest(`batch-${point}`, 0, [
      { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Batch retry" },
      { type: "setInstructionStepComplete", weekId: "2026-07-06", stepId: "step-rice", complete: true },
    ]);
    armed = true;
    assert.throws(
      () => service.applyOperations(request, globalContext),
      new RegExp(`batch-fail:${point}`),
    );
    const unchanged = service.readWorkspace();
    assert.equal(unchanged.plannerVersion, 0, point);
    assert.equal(unchanged.events.length, 0, point);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE request_id = ?").get(request.requestId).count,
      0,
      point,
    );
    armed = false;
    assert.equal(service.applyOperations(request, globalContext).decision.status, "accepted", point);
    store.close();
  }
});

test("trusted operation kinds reject mismatched caller provenance before reserving a receipt", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store));
  service.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const request = operationsRequest("spoofed-global", 0, [
    { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Spoofed" },
  ]);
  assert.throws(
    () => service.applyOperations(request, {
      operationKind: "global_codex_apply_planner_batch_v1",
      provenance: {
        actorClass: "household",
        actorSource: "browser",
        admission: "same_origin_http_v1",
      },
    }),
    (error) => error instanceof PlannerServiceError && error.code === "INVALID_REQUEST",
  );
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE request_id = 'spoofed-global'").get().count,
    0,
  );
  assert.throws(
    () => service.applyOperations({ ...request, requestId: "unknown-kind" }, {
      operationKind: "future_unknown_kind",
      provenance: GLOBAL_CODEX_PROVENANCE,
    }),
    (error) => error instanceof PlannerServiceError && error.code === "INVALID_REQUEST",
  );
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE request_id = 'unknown-kind'").get().count,
    0,
  );
  assert.throws(
    () => service.applyOperations({ ...request, requestId: "embedded-without-turn" }, {
      operationKind: "embedded_codex_apply_planner_operations_v1",
      provenance: EMBEDDED_CODEX_PROVENANCE,
    }),
    (error) => error instanceof PlannerServiceError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => service.applyOperations({ ...request, requestId: "global-with-turn" }, {
      ...globalContext,
      chatTurnId: "turn-not-allowed",
    }),
    (error) => error instanceof PlannerServiceError && error.code === "INVALID_REQUEST",
  );
  store.close();
});

test("sixteen sequential operations still produce exactly one durable planner unit", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store));
  service.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const commands = [];
  for (let index = 0; index < 8; index += 1) {
    commands.push({ type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: `Lesson ${index}` });
    commands.push({ type: "setInstructionStepComplete", weekId: "2026-07-06", stepId: "step-rice", complete: index % 2 === 0 });
  }
  const applied = service.applyOperations(operationsRequest("batch-sixteen", 0, commands), globalContext);
  assert.equal(applied.decision.status, "accepted");
  assert.equal(applied.workspace.events.length, 1);
  assert.equal(applied.workspace.events[0].command.operations.length, 16);
  assert.equal(applied.workspace.events[0].changes.length, 16);
  assert.match(applied.workspace.events[0].changes[0], /^1\. /);
  assert.match(applied.workspace.events[0].changes[15], /^16\. /);
  store.close();
});

test("preview uses throwaway IDs and redacts every generated-ID occurrence without writing", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  let durableIds = 0;
  const service = createPlannerApplicationService(
    dependencies(store, {
      domain: householdDomain,
      idFactory: { createId: (prefix) => `${prefix}-durable-${++durableIds}` },
    }),
  );
  service.bootstrap({ requestId: "bootstrap", mode: "seed" });
  durableIds = 0;
  const before = service.readWorkspace();
  const request = {
    basePlannerVersion: 0,
    operations: [
      {
        command: {
          type: "addInstructionStep",
          weekId: "2026-07-06",
          mealId: "meal-1",
          position: 1,
          step: { inputs: [], instruction: "Serve the rice." },
        },
      },
      {
        command: {
          type: "addGroceryItem",
          weekId: "2026-07-06",
          item: { section: "Produce", item: "Scallions", detail: "1 bunch", farmBox: false },
        },
      },
      {
        command: {
          type: "updateMealStatus",
          weekId: "2026-07-06",
          mealId: "meal-1",
          status: "cooked",
        },
      },
      {
        command: {
          type: "reconcileGroceries",
          weekId: "2026-07-06",
          items: [{
            section: "Produce",
            item: "Scallions",
            detail: "1 bunch",
            farmBox: false,
            checked: false,
          }],
        },
      },
      {
        command: {
          type: "createWeekPlan",
          weekStartDate: "2026-07-13",
          plan: {
            meals: [{
              date: "2026-07-13",
              slot: "dinner",
              title: "Soup",
              subtitle: "",
              venue: "Home",
              protein: "none",
              prepNote: "",
              leftoverNote: "",
              notes: "",
              ingredients: [],
              instructions: [{ inputs: [], instruction: "Simmer." }],
            }],
            groceries: [{
              section: "Produce",
              item: "Onions",
              detail: "2",
              farmBox: false,
            }],
          },
        },
      },
    ],
  };
  const preview = service.previewOperations(request);

  assert.equal(preview.decision.status, "previewed");
  assert.equal(preview.decision.outcomes[0].target, "[generated after apply]");
  assert.equal(preview.decision.outcomes[1].target, "[generated after apply]");
  assert.equal(preview.decision.outcomes.length, 5);
  assert.doesNotMatch(JSON.stringify(preview), /preview-(?:step|grocery|leftover|meal)-/);
  assert.equal(durableIds, 0);
  assert.deepEqual(service.readWorkspace(), before);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count, 1);
  const callerOwnedPreview = store.transaction((transaction) =>
    service.previewPlannerOperations(transaction, request),
  );
  assert.deepEqual(callerOwnedPreview, preview);
  store.close();
});

test("preview conflict and indexed rejection are pure terminal decisions", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  let durableIds = 0;
  const service = createPlannerApplicationService(
    dependencies(store, {
      idFactory: { createId: (prefix) => `${prefix}-durable-${++durableIds}` },
    }),
  );
  service.bootstrap({ requestId: "bootstrap", mode: "seed" });
  durableIds = 0;
  const before = service.readWorkspace();

  assert.deepEqual(
    service.previewOperations({
      basePlannerVersion: 1,
      operations: [{
        command: {
          type: "captureWeekLesson",
          weekId: "2026-07-06",
          weekLesson: "Stale",
        },
      }],
    }).decision,
    { status: "version_conflict", expectedVersion: 1, actualVersion: 0 },
  );
  const rejected = service.previewOperations({
    basePlannerVersion: 0,
    operations: [
      {
        command: {
          type: "captureWeekLesson",
          weekId: "2026-07-06",
          weekLesson: "Temporary preview",
        },
      },
      {
        command: {
          type: "captureWeekLesson",
          weekId: "2026-07-06",
          weekLesson: "Temporary preview",
        },
      },
    ],
  });
  assert.deepEqual(rejected.decision, {
    status: "domain_rejected",
    operationIndex: 1,
    message: "Planning lesson is unchanged.",
  });
  assert.equal(durableIds, 0);
  assert.deepEqual(service.readWorkspace(), before);
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count,
    1,
  );
  store.close();
});

function replacementCommand({
  weekId = "2026-07-06",
  mealId = "meal-1",
} = {}) {
  return {
    type: "replaceMealRecipeFromSource",
    weekId,
    mealId,
    recipe: {
      title: "Sourced rice",
      source: {
        kind: "web",
        identity: "Example Kitchen",
        url: "https://example.com/recipes/rice",
        retrievedAt: 1_750_000_000_000,
      },
      steps: [{
        inputs: [{ amount: "1 cup", ingredient: "rice" }],
        instruction: "Cook the rice gently.",
      }],
    },
  };
}

test("canonical pre-batch guard blocks cleanup laundering with the earliest replacement index", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store, {
    domain: householdDomain,
    seedFactory: () => seedState(),
  }));
  service.bootstrap({ requestId: "bootstrap-source-guard", mode: "seed" });
  const operations = [
    {
      command: {
        type: "removePrepReference",
        weekId: "2026-07-06",
        referenceId: "prep-rice",
      },
    },
    { command: replacementCommand() },
  ];
  const before = service.readWorkspace();
  const preview = service.previewOperations({ basePlannerVersion: 0, operations });
  assert.equal(preview.decision.status, "domain_rejected");
  assert.equal(preview.decision.operationIndex, 1);
  assert.match(preview.decision.message, /prep references/i);
  assert.deepEqual(service.readWorkspace(), before);

  const applied = service.applyOperations({
    requestId: "source-cleanup-launder",
    basePlannerVersion: 0,
    operations,
  }, globalContext);
  assert.equal(applied.decision.status, "domain_rejected");
  assert.equal(applied.decision.operationIndex, 1);
  assert.equal(applied.workspace.plannerVersion, 0);
  assert.equal(applied.workspace.events.length, 0);
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count,
    2,
  );
  store.close();
});

test("canonical pre-batch guard blocks target, status, move, and every protected-state laundering path", async (t) => {
  const cleanState = () => {
    const state = structuredClone(seedState());
    const week = state.weeks[0];
    const step = week.data.meals[0].instructions[0];
    week.data.prep = [];
    step.complete = false;
    delete step.note;
    delete step.timerStartedAt;
    return state;
  };
  const createdMeal = {
    date: "2026-07-13",
    slot: "dinner",
    title: "Future rice",
    subtitle: "",
    venue: "Home",
    protein: "none",
    prepNote: "",
    leftoverNote: "",
    notes: "",
    ingredients: [],
    instructions: [{ inputs: [], instruction: "Cook." }],
  };
  const cases = [
    {
      name: "target creation, including missing-to-planned week status",
      state: cleanState(),
      operations: [
        { command: {
          type: "createWeekPlan",
          weekStartDate: "2026-07-13",
          plan: { meals: [createdMeal], groceries: [] },
        } },
        { command: replacementCommand({ weekId: "2026-07-13", mealId: "future-meal" }) },
        { command: replacementCommand({ weekId: "2026-07-20", mealId: "later-meal" }) },
      ],
      message: /week not found/i,
    },
    {
      name: "archived week status",
      state: (() => {
        const state = cleanState();
        state.weeks[0].status = "archived";
        state.activeWeekId = null;
        return state;
      })(),
      operations: [
        { command: { type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Would be rejected later" } },
        { command: replacementCommand() },
      ],
      message: /planned or active weeks/i,
    },
    {
      name: "meal status changed from cooking to planned",
      state: (() => {
        const state = cleanState();
        state.weeks[0].data.meals[0].status = "cooking";
        return state;
      })(),
      operations: [
        { command: { type: "updateMealStatus", weekId: "2026-07-06", mealId: "meal-1", status: "planned" } },
        { command: replacementCommand() },
      ],
      message: /planned or moved meals/i,
    },
    {
      name: "meal moved from cooking into an eligible moved state",
      state: (() => {
        const state = cleanState();
        state.weeks[0].data.meals[0].status = "cooking";
        return state;
      })(),
      operations: [
        { command: { type: "moveMeal", weekId: "2026-07-06", mealId: "meal-1", targetDate: "2026-07-08", slot: "dinner" } },
        { command: replacementCommand() },
      ],
      message: /planned or moved meals/i,
    },
    {
      name: "completed-step cleanup",
      state: (() => {
        const state = cleanState();
        state.weeks[0].data.meals[0].instructions[0].complete = true;
        return state;
      })(),
      operations: [
        { command: { type: "setInstructionStepComplete", weekId: "2026-07-06", stepId: "step-rice", complete: false } },
        { command: replacementCommand() },
      ],
      message: /completed instruction steps/i,
    },
    {
      name: "instruction-note cleanup",
      state: (() => {
        const state = cleanState();
        state.weeks[0].data.meals[0].instructions[0].note = "Keep this note";
        return state;
      })(),
      operations: [
        { command: { type: "updateInstructionStepNote", weekId: "2026-07-06", stepId: "step-rice", note: "" } },
        { command: replacementCommand() },
      ],
      message: /instruction notes/i,
    },
    {
      name: "running-timer cleanup",
      state: (() => {
        const state = cleanState();
        state.weeks[0].data.meals[0].instructions[0].timerStartedAt = 1_750_000_000_000;
        return state;
      })(),
      operations: [
        { command: { type: "resetInstructionTimer", weekId: "2026-07-06", stepId: "step-rice" } },
        { command: replacementCommand() },
      ],
      message: /running instruction timers/i,
    },
    {
      name: "prep-reference cleanup",
      state: (() => {
        const state = cleanState();
        state.weeks[0].data.prep = [{
          id: "prep-rice",
          stepId: "step-rice",
          prepDate: "2026-07-05",
          position: 0,
        }];
        return state;
      })(),
      operations: [
        { command: { type: "removePrepReference", weekId: "2026-07-06", referenceId: "prep-rice" } },
        { command: replacementCommand() },
      ],
      message: /prep references/i,
    },
  ];

  for (const [caseIndex, fixture] of cases.entries()) {
    await t.test(fixture.name, () => {
      const store = openPlannerStore({ filename: ":memory:" });
      let generated = 0;
      const service = createPlannerApplicationService(dependencies(store, {
        domain: householdDomain,
        seedFactory: () => structuredClone(fixture.state),
        idFactory: {
          createId: (prefix) => prefix === "meal" ? "future-meal" : `${prefix}-matrix-${++generated}`,
        },
      }));
      service.bootstrap({ requestId: `bootstrap-source-matrix-${caseIndex}`, mode: "seed" });
      const before = service.readWorkspace();
      const preview = service.previewOperations({
        basePlannerVersion: 0,
        operations: fixture.operations,
      });
      assert.equal(preview.decision.status, "domain_rejected");
      assert.equal(preview.decision.operationIndex, 1);
      assert.match(preview.decision.message, fixture.message);
      assert.deepEqual(service.readWorkspace(), before);
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count,
        1,
      );

      const applied = service.applyOperations({
        requestId: `source-matrix-${caseIndex}`,
        basePlannerVersion: 0,
        operations: fixture.operations,
      }, globalContext);
      assert.equal(applied.decision.status, "domain_rejected");
      assert.equal(applied.decision.operationIndex, 1);
      assert.match(applied.decision.message, fixture.message);
      assert.deepEqual(applied.workspace, before);
      assert.deepEqual(service.readWorkspace(), before);
      assert.equal(applied.workspace.plannerVersion, 0);
      assert.equal(applied.workspace.events.length, 0);
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS count FROM planner_events").get().count,
        0,
      );
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count,
        2,
        "bootstrap plus exactly one rejected apply receipt",
      );
      store.close();
    });
  }
});

test("a separately committed cleanup and refreshed replacement use the same shared authority", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  const service = createPlannerApplicationService(dependencies(store, {
    domain: householdDomain,
    seedFactory: () => seedState(),
  }));
  service.bootstrap({ requestId: "bootstrap-source-accept", mode: "seed" });
  const cleaned = service.applyOperations({
    requestId: "source-cleanup",
    basePlannerVersion: 0,
    operations: [{ command: {
      type: "removePrepReference",
      weekId: "2026-07-06",
      referenceId: "prep-rice",
    } }],
  }, globalContext);
  assert.equal(cleaned.decision.status, "accepted");
  const accepted = service.applyOperations({
    requestId: "source-replace",
    basePlannerVersion: 1,
    operations: [{ command: replacementCommand() }],
  }, globalContext);
  assert.equal(accepted.decision.status, "accepted");
  assert.equal(accepted.workspace.plannerVersion, 2);
  assert.equal(accepted.workspace.state.weeks[0].data.meals[0].title, "Sourced rice");
  assert.equal(accepted.workspace.state.weeks[0].data.meals[0].sourceRecipe.url,
    "https://example.com/recipes/rice");
  store.close();
});
