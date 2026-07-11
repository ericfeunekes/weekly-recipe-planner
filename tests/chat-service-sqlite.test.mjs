import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import { createChatApplicationService } from "../server/chat/service.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function createServices(store, {
  failPoint = null,
  replyOnly = false,
} = {}) {
  let sequence = 0;
  let now = Date.parse("2026-07-10T18:00:00-03:00");
  let armed = failPoint !== null;
  const idFactory = { createId: (prefix) => `${prefix}-${++sequence}` };
  const clock = { now: () => now++ };
  const failureInjector = {
    hit(point) {
      if (armed && point === failPoint) {
        armed = false;
        throw new Error("injected terminal transaction failure");
      }
    },
  };
  const planner = createPlannerApplicationService({
    store,
    domain: householdDomain,
    seedFactory: () => createCanonicalSeed({
      now: clock.now(),
      createId: (prefix) => idFactory.createId(prefix),
    }),
    transformLegacyV2: () => {
      throw new Error("legacy import is outside this fixture");
    },
    clock,
    idFactory,
    failureInjector,
  });
  const chat = createChatApplicationService({
    transactionRunner: store,
    persistence: store,
    plannerMutationKernel: planner,
    plannerRead: store,
    clock,
    idFactory,
    failureInjector,
    codexAdapter: {
      async readStatus() {
        return { available: true, authenticated: true, detail: "fixture" };
      },
      async complete({ prompt }) {
        const workspace = planner.readWorkspace();
        const week = workspace.state.weeks[0];
        const step = week.data.meals[0].instructions[0];
        assert.match(prompt, new RegExp(step.id));
        if (replyOnly) {
          return { reply: "I can see the shared household plan.", command: null };
        }
        return {
          reply: "The shared step is complete.",
          command: {
            type: "setInstructionStepComplete",
            weekId: week.id,
            stepId: step.id,
            complete: true,
          },
        };
      },
    },
  });
  return { planner, chat };
}

function readTerminalArtifacts(store, submitRequestId, turnId) {
  return store.readTransaction((transaction) => ({
    events: store.readAllEvents(transaction),
    transcript: store.readAllTranscriptEntries(transaction),
    submitReceipt: store.findReceipt(transaction, "chat_submit", submitRequestId),
    plannerReceipt: store.findReceipt(
      transaction,
      "planner_chat_command",
      `chat-command:${turnId}`,
    ),
  }));
}

function assertTerminalMutationRolledBack(store, seeded, requestId) {
  const workspace = store.readInitializedWorkspace();
  const turn = workspace.chatTurns[0];
  const artifacts = readTerminalArtifacts(store, requestId, turn.turnId);
  assert.equal(workspace.plannerVersion, seeded.workspace.plannerVersion);
  assert.equal(workspace.syncRevision, seeded.workspace.syncRevision + 1);
  assert.equal(workspace.state.weeks[0].data.meals[0].instructions[0].complete, false);
  assert.equal(turn.status, "running");
  assert.equal(turn.replyEntryId, null);
  assert.equal(artifacts.events.length, 0);
  assert.deepEqual(artifacts.transcript.map((entry) => entry.role), ["user"]);
  assert.equal(artifacts.submitReceipt?.operationKind, "chat_submit");
  assert.equal(artifacts.plannerReceipt, null);
  return workspace;
}

test("real SQLite terminal failure rolls back chat mutation and recovers on restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-chat-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "planner.sqlite");
  const firstStore = openPlannerStore({ filename });
  const first = createServices(firstStore);
  const seeded = first.planner.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const week = seeded.workspace.state.weeks[0];
  const meal = week.data.meals[0];
  const step = meal.instructions[0];

  const failing = createServices(firstStore, { failPoint: "after_planner_mutation" });
  await assert.rejects(
    failing.chat.submit({
      requestId: "chat-submit",
      basePlannerVersion: seeded.workspace.plannerVersion,
      message: "Complete this prep step.",
      context: { view: "prep", weekId: week.id, mealId: meal.id, stepId: step.id },
    }),
    /injected terminal transaction failure/,
  );

  assertTerminalMutationRolledBack(firstStore, seeded, "chat-submit");
  firstStore.close();

  const restartedStore = openPlannerStore({ filename });
  t.after(() => restartedStore.close());
  const restarted = createServices(restartedStore);
  assert.equal(restarted.chat.interruptRunningTurns(), 1);
  const recovered = restartedStore.readInitializedWorkspace();
  assert.equal(recovered.chatTurns[0].status, "interrupted");
  assert.equal(recovered.plannerVersion, seeded.workspace.plannerVersion);
  assert.equal(recovered.syncRevision, seeded.workspace.syncRevision + 2);
  assert.equal(recovered.state.weeks[0].data.meals[0].instructions[0].complete, false);
  assert.equal(recovered.transcriptEntries.filter((entry) => entry.role === "assistant").length, 0);
  const recoveredArtifacts = readTerminalArtifacts(
    restartedStore,
    "chat-submit",
    recovered.chatTurns[0].turnId,
  );
  assert.equal(recoveredArtifacts.events.length, 0);
  assert.deepEqual(recoveredArtifacts.transcript.map((entry) => entry.role), ["user"]);
  assert.equal(recoveredArtifacts.submitReceipt?.operationKind, "chat_submit");
  assert.equal(recoveredArtifacts.plannerReceipt, null);
});

test("real SQLite rolls back assistant and terminal writes when their transaction fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-chat-terminal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "planner.sqlite");
  const store = openPlannerStore({ filename });
  const initial = createServices(store);
  const seeded = initial.planner.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const week = seeded.workspace.state.weeks[0];
  const meal = week.data.meals[0];
  const step = meal.instructions[0];
  const failing = createServices(store, { failPoint: "after_chat_terminal_write" });

  await assert.rejects(
    failing.chat.submit({
      requestId: "chat-terminal-failure",
      basePlannerVersion: seeded.workspace.plannerVersion,
      message: "Complete this prep step.",
      context: { view: "prep", weekId: week.id, mealId: meal.id, stepId: step.id },
    }),
    /injected terminal transaction failure/,
  );

  assertTerminalMutationRolledBack(store, seeded, "chat-terminal-failure");
  store.close();

  const reopenedStore = openPlannerStore({ filename });
  t.after(() => reopenedStore.close());
  assertTerminalMutationRolledBack(
    reopenedStore,
    seeded,
    "chat-terminal-failure",
  );
});

test("SQLite idempotent chat replay resolves turns older than the workspace tail", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-chat-tail-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "planner.sqlite");
  const store = openPlannerStore({ filename });
  const services = createServices(store, { replyOnly: true });
  const seeded = services.planner.bootstrap({ requestId: "bootstrap", mode: "seed" });
  const week = seeded.workspace.state.weeks[0];
  const meal = week.data.meals[0];
  const step = meal.instructions[0];
  const firstRequest = {
    requestId: "chat-old-request",
    basePlannerVersion: seeded.workspace.plannerVersion,
    message: "What is the first prep step?",
    context: { view: "prep", weekId: week.id, mealId: meal.id, stepId: step.id },
  };
  const first = await services.chat.submit(firstRequest);
  assert.equal(first.decision.status, "accepted");
  const firstTurnId = first.decision.turn.turnId;

  for (let index = 0; index < 21; index += 1) {
    const response = await services.chat.submit({
      ...firstRequest,
      requestId: `chat-newer-${index}`,
      message: `Later household question ${index}`,
    });
    assert.equal(response.decision.status, "accepted");
  }

  const tailed = store.readInitializedWorkspace();
  assert.equal(tailed.chatTurns.length, 20);
  assert.equal(tailed.chatTurns.some((turn) => turn.turnId === firstTurnId), false);

  store.close();
  const reopenedStore = openPlannerStore({ filename });
  t.after(() => reopenedStore.close());
  const restartedServices = createServices(reopenedStore, { replyOnly: true });

  const replay = await restartedServices.chat.submit(firstRequest);
  assert.equal(replay.decision.status, "accepted");
  assert.equal(replay.decision.turn.turnId, firstTurnId);
  assert.equal(replay.workspace.chatTurns.some((turn) => turn.turnId === firstTurnId), false);
});
