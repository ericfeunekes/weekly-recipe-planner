import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import {
  createEmbeddedChatApplicationService,
  createManagedEmbeddedChatApplicationService,
} from "../server/chat/embedded-service.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function dynamicCall(callId, tool, argumentsValue) {
  return {
    appServerThreadId: "app-thread-1",
    appServerTurnId: "app-turn-1",
    appServerCallId: callId,
    namespace: "planner",
    tool,
    arguments: argumentsValue,
  };
}

async function createFixture(t, behavior, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "planner-embedded-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "planner.sqlite");
  const store = openPlannerStore({ filename });
  t.after(() => store.close());
  let id = 0;
  let now = Date.parse("2026-07-11T08:00:00-03:00");
  let armedFailpoint = null;
  let failpointSkips = 0;
  const idFactory = { createId: (prefix) => `${prefix}-${++id}` };
  const clock = { now: () => now++ };
  const failureInjector = {
    hit(point) {
      if (point === armedFailpoint) {
        if (failpointSkips > 0) {
          failpointSkips -= 1;
          return;
        }
        armedFailpoint = null;
        throw new Error(`failpoint:${point}`);
      }
    },
  };
  const planner = createPlannerApplicationService({
    store,
    domain: householdDomain,
    seedFactory: () => {
      const seed = createCanonicalSeed({
        now: clock.now(),
        createId: (prefix) => idFactory.createId(prefix),
      });
      options.seedTransform?.(seed);
      return seed;
    },
    transformLegacyV2: () => {
      throw new Error("legacy import is outside this fixture");
    },
    clock,
    idFactory,
    failureInjector,
  });
  const seeded = planner.bootstrap({ requestId: "bootstrap", mode: "seed" });
  let currentBehavior = behavior;
  const dynamicSession = {
    async run(request) {
      const identity = {
        appServerThreadId: "app-thread-1",
        appServerTurnId: "app-turn-1",
      };
      try {
        assert.equal(await request.host.bindAppServerTurn(identity), true);
        return await currentBehavior(request);
      } catch (error) {
        await request.host.failTurn(identity, {
          code: "CALL_CANCELLED",
          detail: "The restricted test session failed before terminal completion.",
        });
        throw error;
      }
    },
  };
  const harnessOptions = {
    transactionRunner: store,
    persistence: store,
    plannerMutationKernel: planner,
    plannerRead: store,
    clock,
    idFactory,
    failureInjector,
  };
  const researchSession = options.researchDraft === undefined
    ? undefined
    : {
        async run() {
          return {
            draft: structuredClone(options.researchDraft),
            appServerThreadId: "research-thread-1",
            appServerTurnId: "research-turn-1",
            modelVisibleTools: ["update_plan", "web_search"],
            observedNotifications: [],
          };
        },
      };
  const harness = options.execution
    ? createManagedEmbeddedChatApplicationService({
        ...harnessOptions,
        executionProvider: options.execution,
        fixedCwd: process.cwd(),
      })
    : createEmbeddedChatApplicationService({
        ...harnessOptions,
        dynamicSession,
        ...(researchSession === undefined ? {} : { researchSession }),
      });
  const week = seeded.workspace.state.weeks.find(
    (candidate) => candidate.id === seeded.workspace.state.activeWeekId,
  );
  const meal = week.data.meals[0];
  return {
    filename,
    store,
    planner,
    harness,
    seeded,
    week,
    meal,
    setBehavior(next) {
      currentBehavior = next;
    },
    arm(point, skips = 0) {
      armedFailpoint = point;
      failpointSkips = skips;
    },
    submitRequest(requestId = "embedded-submit") {
      return {
        requestId,
        basePlannerVersion: planner.readWorkspace().plannerVersion,
        message: "Add ginger to groceries and check the exact new item.",
        context: {
          view: "week",
          weekId: week.id,
        },
        intent: { kind: "planner", archiveContextWeek: false },
      };
    },
  };
}

test("a rolled-back app-server binding terminalizes through the persisted unbound CAS", async (t) => {
  const fixture = await createFixture(t, async () => {
    throw new Error("behavior must not run after bind rollback");
  });
  fixture.arm("before_commit", 1);
  const response = await fixture.harness.submit(fixture.submitRequest("bind-rollback-submit"));
  assert.equal(response.decision.status, "accepted");
  assert.equal(response.decision.turn.status, "failed");
  assert.equal(response.decision.turn.terminalOutcome, "failed_no_effect");
  assert.equal(response.decision.turn.acceptedEffectCount, 0);
  assert.equal(response.decision.turn.appServerThreadId, null);
  assert.equal(response.decision.turn.appServerTurnId, null);
  assert.equal(
    fixture.store.readTransaction((transaction) => fixture.store.readRunningTurn(transaction)),
    null,
  );
});

function readCalls(store, turnId) {
  return store.readTransaction((transaction) => store.readPlannerToolCalls(transaction, turnId));
}

test("migration 003 backs up v2 and deterministically extends legacy chat lifecycle", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-embedded-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "planner.sqlite");
  const database = new DatabaseSync(filename);
  const migration1 = await readFile(
    new URL("../server/store/migrations/001-initial.sql", import.meta.url),
    "utf8",
  );
  const migration2 = await readFile(
    new URL("../server/store/migrations/002-planner-operations-and-provenance.sql", import.meta.url),
    "utf8",
  );
  database.exec(migration1);
  database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1)").run();
  let seedId = 0;
  const state = createCanonicalSeed({
    now: 1,
    createId: (prefix) => `${prefix}-legacy-${++seedId}`,
  });
  database.exec("BEGIN");
  database.prepare(
    `INSERT INTO workspace
      (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at)
     VALUES ('household', 1, 1, 1, ?, 1, 1)`,
  ).run(JSON.stringify(state));
  database.prepare(
    `INSERT INTO transcript_entries
      (entry_id, role, text, context_json, turn_id, occurred_at)
     VALUES ('legacy-user', 'user', 'Legacy request', ?, 'legacy-turn', 1)`,
  ).run(JSON.stringify({ view: "week", weekId: state.activeWeekId }));
  database.prepare(
    `INSERT INTO transcript_entries
      (entry_id, role, text, context_json, turn_id, occurred_at)
     VALUES ('legacy-reply', 'assistant', 'Legacy reply', ?, 'legacy-turn', 2)`,
  ).run(JSON.stringify({ view: "week", weekId: state.activeWeekId }));
  database.prepare(
    `INSERT INTO chat_turns
      (turn_id, request_id, turn_sequence, status, user_entry_id, context_json,
       input_planner_version, reply_entry_id, proposed_command_json, mutation_outcome,
       retry_of_turn_id, error_code, error_detail, created_at, started_at, completed_at)
     VALUES ('legacy-turn', 'legacy-request', 1, 'completed', 'legacy-user', ?,
             0, 'legacy-reply', ?, 'applied', NULL, NULL, NULL, 1, 1, 2)`,
  ).run(
    JSON.stringify({ view: "week", weekId: state.activeWeekId }),
    JSON.stringify({ type: "activateWeek", weekId: state.activeWeekId }),
  );
  database.exec("COMMIT");
  database.exec(migration2);
  database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (2, 2)").run();
  database.close();

  const store = openPlannerStore({ filename });
  t.after(() => store.close());
  assert.ok(store.migrationBackupPath);
  assert.equal((await stat(store.migrationBackupPath)).isFile(), true);
  const workspace = store.readInitializedWorkspace();
  assert.equal(workspace.schemaVersion, 5);
  const turn = workspace.chatTurns[0];
  assert.equal(turn.mode, "normal");
  assert.equal(turn.acceptedEffectCount, 1);
  assert.equal(turn.lastEffectSequence, 1);
  assert.equal(turn.terminalOutcome, "completed_with_effects");
  assert.equal(turn.completionTokenHash, null);
  assert.equal(turn.appServerThreadId, null);
  assert.deepEqual(turn.foregroundAuthority, []);
  assert.deepEqual(readCalls(store, turn.turnId), []);
  assert.equal(store.checkIntegrity(), "ok");
});

test("app-server spawn rejection cannot strand the committed household turn", async (t) => {
  const execution = {
    identity: {
      launcherPath: "test-only",
      canonicalPath: process.execPath,
      device: "0",
      inode: "0",
      size: "0",
      mtimeNanoseconds: "0",
      ctimeNanoseconds: "0",
      sha256: "0".repeat(64),
      version: "test-only",
    },
    async spawnAppServer() {
      throw new Error("spawn rejected after chat begin committed");
    },
  };
  const fixture = await createFixture(t, null, { execution });

  const response = await fixture.harness.submit(fixture.submitRequest("spawn-rejected-submit"));
  assert.equal(response.decision.status, "accepted");
  const turn = response.decision.turn;
  assert.equal(turn.status, "failed");
  assert.equal(turn.terminalOutcome, "failed_no_effect");
  assert.equal(turn.mutationOutcome, "model_failed");
  assert.equal(turn.errorCode, "PROTOCOL_ERROR");
  assert.equal(turn.errorDetail, "Codex app-server could not be started.");
  assert.equal(turn.appServerThreadId, null);
  assert.equal(turn.appServerTurnId, null);
  assert.equal(turn.completionTokenHash, null);
  assert.equal(readCalls(fixture.store, turn.turnId).length, 0);
  assert.equal(
    fixture.store.readInitializedWorkspace().chatTurns.some((candidate) =>
      candidate.turnId === turn.turnId && candidate.status === "running"
    ),
    false,
  );
});

test("dependent embedded applies co-commit ledger, receipts, effects, and canonical readback", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host, mode, prompt }) => {
    assert.equal(mode, "normal");
    assert.match(prompt, /several dependent planner\.read, planner\.preview, and planner\.apply calls/);
    assert.match(prompt, /final output is reply-only/);
    assert.doesNotMatch(prompt, /at most one typed planner command/);
    const first = await host.dispatchPlannerTool(dynamicCall("call-add", "apply", {
      basePlannerVersion: fixture.seeded.workspace.plannerVersion,
      operations: [{
        command: {
          type: "addGroceryItem",
          weekId: fixture.week.id,
          item: {
            section: "Produce",
            item: "Fresh ginger",
            detail: "1 knob",
            farmBox: false,
          },
        },
      }],
      readback: { kind: "week", weekId: fixture.week.id },
    }));
    assert.equal(first.ok, true);
    const ginger = first.data.readback.week.data.groceries.find(
      (item) => item.item === "Fresh ginger",
    );
    assert.ok(ginger?.id, "first authoritative readback materializes the generated id");

    const second = await host.dispatchPlannerTool(dynamicCall("call-check", "apply", {
      basePlannerVersion: first.plannerVersion,
      operations: [{
        command: {
          type: "setGroceryItemChecked",
          weekId: fixture.week.id,
          itemId: ginger.id,
          checked: true,
        },
      }],
      readback: { kind: "week", weekId: fixture.week.id },
    }));
    assert.equal(second.ok, true);
    assert.equal(
      second.data.readback.week.data.groceries.find((item) => item.id === ginger.id).checked,
      true,
    );
    assert.equal(await host.completeTurn({
      appServerThreadId: "app-thread-1",
      appServerTurnId: "app-turn-1",
    }, "I added the ginger and checked it."), true);
    return { reply: "I added the ginger and checked it." };
  });

  const response = await fixture.harness.submit(fixture.submitRequest());
  assert.equal(response.decision.status, "accepted");
  const turn = response.decision.turn;
  assert.equal(turn.status, "completed");
  assert.equal(turn.acceptedEffectCount, 2);
  assert.equal(turn.lastEffectSequence, 2);
  assert.equal(turn.terminalOutcome, "completed_with_effects");
  assert.equal(turn.appServerThreadId, "app-thread-1");
  assert.equal(turn.appServerTurnId, "app-turn-1");
  assert.equal(turn.completionTokenHash, null, "terminal CAS revokes the token");

  const calls = readCalls(fixture.store, turn.turnId);
  assert.deepEqual(calls.map((call) => [call.tool, call.status, call.effectSequence]), [
    ["apply", "succeeded", 1],
    ["apply", "succeeded", 2],
  ]);
  assert.deepEqual(calls.map((call) => call.requestId), [
    `embedded-tool:${turn.turnId}:call-add`,
    `embedded-tool:${turn.turnId}:call-check`,
  ]);
  assert.deepEqual(
    fixture.store.readAllEvents().slice(-2).map((event) => event.provenance),
    [
      {
        actorClass: "codex",
        actorSource: "embedded",
        admission: "app_server_dynamic_v1",
      },
      {
        actorClass: "codex",
        actorSource: "embedded",
        admission: "app_server_dynamic_v1",
      },
    ],
  );
  const independent = openPlannerStore({ filename: fixture.filename });
  try {
    const durableWeek = independent.readInitializedWorkspace().state.weeks.find(
      (candidate) => candidate.id === fixture.week.id,
    );
    assert.equal(
      durableWeek.data.groceries.find((item) => item.item === "Fresh ginger").checked,
      true,
      "a separate SQLite client observes both committed dependent effects",
    );
    assert.deepEqual(
      readCalls(independent, turn.turnId).map((call) => call.effectSequence),
      [1, 2],
    );
  } finally {
    independent.close();
  }
});

test("terminal exact duplicate replays immutable output while changed arguments revoke after effect", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host }) => {
    const call = dynamicCall("call-once", "apply", {
      basePlannerVersion: fixture.seeded.workspace.plannerVersion,
      operations: [{
        command: {
          type: "captureWeekLesson",
          weekId: fixture.week.id,
          weekLesson: "Prep the rice early.",
        },
      }],
      readback: { kind: "workspace" },
    });
    const first = await host.dispatchPlannerTool(call);
    const replay = await host.dispatchPlannerTool(structuredClone(call));
    assert.deepEqual(replay, first);
    const mismatch = await host.dispatchPlannerTool(dynamicCall("call-once", "apply", {
      ...call.arguments,
      operations: [{
        command: {
          type: "captureWeekLesson",
          weekId: fixture.week.id,
          weekLesson: "Changed payload must not execute.",
        },
      }],
    }));
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, "DUPLICATE_MISMATCH");
    return { reply: "not committed" };
  });

  const response = await fixture.harness.submit(fixture.submitRequest("duplicate-submit"));
  const turn = response.decision.turn;
  assert.equal(turn.status, "failed");
  assert.equal(turn.acceptedEffectCount, 1);
  assert.equal(turn.terminalOutcome, "failed_after_effect");
  assert.equal(fixture.store.readAllEvents().length, 1);
  assert.equal(
    fixture.planner.readWorkspace().state.weeks.find((week) => week.id === fixture.week.id)
      .data.weekLesson,
    "Prep the rice early.",
  );
  const calls = readCalls(fixture.store, turn.turnId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "succeeded");
});

test("sourced apply replay is immutable and a changed candidate body cannot create another effect", async (t) => {
  let fixture;
  let observedFirst;
  const researchDraft = {
    source: {
      kind: "web",
      identity: "Example Kitchen",
      url: "https://example.com/recipes/bound-soup",
    },
    title: "Bound soup",
    yieldText: "4 bowls",
    steps: [{
      inputs: [{ amount: "1 cup", ingredient: "lentils" }],
      instruction: "Simmer until tender.",
      timerDurationSeconds: 900,
    }],
  };
  fixture = await createFixture(t, async ({ host, researchCandidateJson }) => {
    const candidate = JSON.parse(researchCandidateJson);
    const command = {
      type: "replaceMealRecipeFromSource",
      weekId: fixture.week.id,
      mealId: fixture.meal.id,
      recipe: {
        title: candidate.title,
        yieldText: candidate.yieldText,
        source: candidate.source,
        steps: candidate.steps,
      },
    };
    const call = dynamicCall("sourced-call-once", "apply", {
      basePlannerVersion: fixture.seeded.workspace.plannerVersion,
      operations: [{ command }],
      readback: { kind: "meal", weekId: fixture.week.id, mealId: fixture.meal.id },
    });
    const first = await host.dispatchPlannerTool(call);
    observedFirst = first;
    assert.equal(first.ok, true);
    const replay = await host.dispatchPlannerTool(structuredClone(call));
    assert.deepEqual(replay, first);

    const changedCommand = structuredClone(command);
    changedCommand.recipe.steps[0].instruction = "Changed after candidate approval.";
    const rejected = await host.dispatchPlannerTool(dynamicCall(
      "sourced-changed-body",
      "apply",
      {
        basePlannerVersion: first.plannerVersion,
        operations: [{ command: changedCommand }],
        readback: { kind: "meal", weekId: fixture.week.id, mealId: fixture.meal.id },
      },
    ));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "NOT_AUTHORIZED");
    assert.equal(rejected.error.operationIndex, 0);

    const mismatch = await host.dispatchPlannerTool(dynamicCall(
      "sourced-call-once",
      "apply",
      {
        ...call.arguments,
        operations: [{ command: changedCommand }],
      },
    ));
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error.code, "DUPLICATE_MISMATCH");
  }, {
    researchDraft,
    seedTransform(seed) {
      const week = seed.weeks.find((candidate) => candidate.id === seed.activeWeekId);
      week.data.prep = [];
    },
  });

  const request = fixture.submitRequest("sourced-replay-submit");
  request.message = "Research and replace this dinner with the sourced soup.";
  request.intent = { kind: "sourced_recipe" };
  const response = await fixture.harness.submit(request);
  assert.equal(observedFirst?.ok, true, JSON.stringify(observedFirst));
  const turn = response.decision.turn;
  assert.equal(turn.status, "failed");
  assert.equal(turn.acceptedEffectCount, 1);
  assert.equal(turn.terminalOutcome, "failed_after_effect");
  assert.equal(fixture.store.readAllEvents().length, 1);
  const meal = fixture.planner.readWorkspace().state.weeks
    .find((week) => week.id === fixture.week.id).data.meals
    .find((candidate) => candidate.id === fixture.meal.id);
  assert.equal(meal.instructions[0].instruction, "Simmer until tender.");
  assert.notEqual(meal.instructions[0].instruction, "Changed after candidate approval.");
  assert.deepEqual(readCalls(fixture.store, turn.turnId).map((call) => [
    call.toolCallId,
    call.status,
    call.effectSequence,
  ]), [
    ["sourced-call-once", "succeeded", 1],
    ["sourced-changed-body", "rejected", null],
  ]);
});

test("failure before joint commit rolls back effect and abandons only the durable reservation", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host }) => {
    await host.dispatchPlannerTool(dynamicCall("call-rollback", "apply", {
      basePlannerVersion: fixture.seeded.workspace.plannerVersion,
      operations: [{
        command: {
          type: "captureWeekLesson",
          weekId: fixture.week.id,
          weekLesson: "Must roll back.",
        },
      }],
      readback: { kind: "workspace" },
    }));
  });
  fixture.arm("before_tool_effect_commit");

  const response = await fixture.harness.submit(fixture.submitRequest("rollback-submit"));
  const turn = response.decision.turn;
  assert.equal(turn.status, "failed");
  assert.equal(turn.acceptedEffectCount, 0);
  assert.equal(turn.terminalOutcome, "failed_no_effect");
  assert.equal(fixture.planner.readWorkspace().plannerVersion, fixture.seeded.workspace.plannerVersion);
  assert.equal(fixture.store.readAllEvents().length, 0);
  const calls = readCalls(fixture.store, turn.turnId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "cancelled");
  assert.equal(calls[0].resultEnvelope.error.code, "CALL_CANCELLED");
  const receipt = fixture.store.readTransaction((transaction) =>
    fixture.store.findReceipt(
      transaction,
      "embedded_codex_apply_planner_operations_v1",
      `embedded-tool:${turn.turnId}:call-rollback`,
    )
  );
  assert.equal(receipt, null);
});

test("response loss after joint commit preserves effect and forces no-tools recovery retry", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host }) => {
    await host.dispatchPlannerTool(dynamicCall("call-durable", "apply", {
      basePlannerVersion: fixture.seeded.workspace.plannerVersion,
      operations: [{
        command: {
          type: "captureWeekLesson",
          weekId: fixture.week.id,
          weekLesson: "Durable before response.",
        },
      }],
      readback: { kind: "workspace" },
    }));
  });
  fixture.arm("after_tool_effect_commit");

  const request = fixture.submitRequest("response-loss-submit");
  request.intent = { kind: "planner", archiveContextWeek: true };
  const failed = await fixture.harness.submit(request);
  const prior = failed.decision.turn;
  assert.equal(prior.status, "failed");
  assert.equal(prior.acceptedEffectCount, 1);
  assert.equal(prior.terminalOutcome, "failed_after_effect");
  assert.deepEqual(prior.foregroundAuthority, [{
    commandType: "archiveWeek",
    target: fixture.week.id,
  }]);
  assert.equal(fixture.store.readAllEvents().length, 1);
  assert.equal(readCalls(fixture.store, prior.turnId)[0].status, "succeeded");

  fixture.setBehavior(async ({ host, mode, prompt }) => {
    assert.equal(mode, "recovery");
    assert.match(prompt, /Durable before response/);
    assert.match(prompt, /"mode":"recovery"/);
    assert.equal(await host.completeTurn({
      appServerThreadId: "app-thread-1",
      appServerTurnId: "app-turn-1",
    }, "The week lesson was saved before the reply was lost."), true);
    return { reply: "The week lesson was saved before the reply was lost." };
  });
  const recovered = await fixture.harness.retry({
    requestId: "response-loss-retry",
    basePlannerVersion: fixture.planner.readWorkspace().plannerVersion,
    turnId: prior.turnId,
  });
  assert.equal(recovered.decision.turn.mode, "recovery");
  assert.equal(recovered.decision.turn.recoveryOfTurnId, prior.turnId);
  assert.deepEqual(recovered.decision.turn.foregroundAuthority, []);
  assert.equal(recovered.decision.turn.terminalOutcome, "recovery_completed");
  assert.equal(fixture.store.readAllEvents().length, 1, "recovery cannot repeat mutation");
});

test("repeated recovery failure stays no-tools and retains the effect-bearing lineage root", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host }) => {
    await host.dispatchPlannerTool(dynamicCall("lineage-effect", "apply", {
      basePlannerVersion: fixture.seeded.workspace.plannerVersion,
      operations: [{
        command: {
          type: "captureWeekLesson",
          weekId: fixture.week.id,
          weekLesson: "Keep the lineage effect once.",
        },
      }],
      readback: { kind: "workspace" },
    }));
    throw new Error("reply lost after lineage effect");
  });

  const initial = await fixture.harness.submit(fixture.submitRequest("lineage-submit"));
  const source = initial.decision.turn;
  assert.equal(source.terminalOutcome, "failed_after_effect");

  fixture.setBehavior(async ({ host, mode, prompt }) => {
    assert.equal(mode, "recovery");
    assert.match(prompt, /Keep the lineage effect once/);
    await host.failTurn(null, {
      code: "TURN_FAILED",
      detail: "Recovery reply failed.",
    });
  });
  const failedRecovery = await fixture.harness.retry({
    requestId: "lineage-recovery-1",
    basePlannerVersion: fixture.planner.readWorkspace().plannerVersion,
    turnId: source.turnId,
  });
  assert.equal(failedRecovery.decision.turn.mode, "recovery");
  assert.equal(failedRecovery.decision.turn.terminalOutcome, "recovery_failed");
  assert.equal(failedRecovery.decision.turn.recoveryOfTurnId, source.turnId);

  fixture.setBehavior(async ({ host, mode, prompt }) => {
    assert.equal(mode, "recovery", "a failed recovery can never regain planner tools");
    assert.match(prompt, /Keep the lineage effect once/);
    assert.equal(await host.completeTurn({
      appServerThreadId: "app-thread-1",
      appServerTurnId: "app-turn-1",
    }, "The earlier planner effect remains applied."), true);
  });
  const completedRecovery = await fixture.harness.retry({
    requestId: "lineage-recovery-2",
    basePlannerVersion: fixture.planner.readWorkspace().plannerVersion,
    turnId: failedRecovery.decision.turn.turnId,
  });
  assert.equal(completedRecovery.decision.turn.mode, "recovery");
  assert.equal(completedRecovery.decision.turn.recoveryOfTurnId, source.turnId);
  assert.equal(completedRecovery.decision.turn.terminalOutcome, "recovery_completed");
  assert.equal(fixture.store.readAllEvents().length, 1);
});

test("authorization and mid-batch domain failures preserve operationIndex with zero effect", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host }) => {
    const authorization = await host.dispatchPlannerTool(dynamicCall(
      "call-authorization-index",
      "preview",
      {
        basePlannerVersion: fixture.seeded.workspace.plannerVersion,
        operations: [
          {
            command: {
              type: "captureWeekLesson",
              weekId: fixture.week.id,
              weekLesson: "This must remain a preview.",
            },
          },
          { command: { type: "archiveWeek", weekId: fixture.week.id } },
        ],
      },
    ));
    assert.equal(authorization.ok, false);
    assert.equal(authorization.error.code, "NOT_AUTHORIZED");
    assert.equal(authorization.error.operationIndex, 1);

    const rejected = await host.dispatchPlannerTool(dynamicCall(
      "call-domain-index",
      "apply",
      {
        basePlannerVersion: fixture.seeded.workspace.plannerVersion,
        operations: [
          {
            command: {
              type: "captureWeekLesson",
              weekId: fixture.week.id,
              weekLesson: "The batch must roll back.",
            },
          },
          {
            command: {
              type: "setGroceryItemChecked",
              weekId: fixture.week.id,
              itemId: "missing-grocery",
              checked: true,
            },
          },
        ],
        readback: { kind: "workspace" },
      },
    ));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "DOMAIN_REJECTED");
    assert.equal(rejected.error.operationIndex, 1);
    assert.equal(await host.completeTurn({
      appServerThreadId: "app-thread-1",
      appServerTurnId: "app-turn-1",
    }, "I could not apply that batch."), true);
    return { reply: "I could not apply that batch." };
  });

  const response = await fixture.harness.submit(fixture.submitRequest("indexed-rejection-submit"));
  assert.equal(response.decision.turn.terminalOutcome, "completed_no_effect");
  assert.equal(response.decision.turn.acceptedEffectCount, 0);
  assert.equal(fixture.planner.readWorkspace().plannerVersion, fixture.seeded.workspace.plannerVersion);
  assert.equal(fixture.store.readAllEvents().length, 0);
  assert.deepEqual(
    readCalls(fixture.store, response.decision.turn.turnId).map((call) => [
      call.status,
      call.resultEnvelope.error.operationIndex,
    ]),
    [["rejected", 1], ["rejected", 1]],
  );
});

test("planner intent grants only the exact context-week archive operation", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host }) => {
    const applied = await host.dispatchPlannerTool(dynamicCall(
      "archive-context-week",
      "apply",
      {
        basePlannerVersion: fixture.seeded.workspace.plannerVersion,
        operations: [{
          command: { type: "archiveWeek", weekId: fixture.week.id },
        }],
        readback: { kind: "week", weekId: fixture.week.id },
      },
    ));
    assert.equal(applied.ok, true);
    assert.equal(applied.data.readback.week.status, "archived");
    assert.equal(await host.completeTurn({
      appServerThreadId: "app-thread-1",
      appServerTurnId: "app-turn-1",
    }, "I archived the context week."), true);
  });

  const request = fixture.submitRequest("archive-context-week-submit");
  request.intent = { kind: "planner", archiveContextWeek: true };
  const response = await fixture.harness.submit(request);
  assert.equal(response.decision.turn.terminalOutcome, "completed_with_effects");
  assert.deepEqual(response.decision.turn.foregroundAuthority, [{
    commandType: "archiveWeek",
    target: fixture.week.id,
  }]);
  assert.equal(fixture.planner.readWorkspace().state.weeks[0].status, "archived");
});

test("a persisted running call is orphaned and fenced instead of being re-executed", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host }) => {
    const call = dynamicCall("call-orphan", "read", {
      query: { kind: "workspace" },
    });
    await assert.rejects(
      host.dispatchPlannerTool(call),
      /failpoint:after_tool_reservation/,
    );
    const orphan = await host.dispatchPlannerTool(structuredClone(call));
    assert.equal(orphan.ok, false);
    assert.equal(orphan.error.code, "CALL_CANCELLED");
    return { reply: "The orphaned call was fenced." };
  });
  fixture.arm("after_tool_reservation");

  const response = await fixture.harness.submit(fixture.submitRequest("orphan-submit"));
  const turn = response.decision.turn;
  assert.equal(turn.status, "failed");
  assert.equal(turn.terminalOutcome, "failed_no_effect");
  assert.equal(turn.acceptedEffectCount, 0);
  const calls = readCalls(fixture.store, turn.turnId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "abandoned");
  assert.equal(calls[0].resultEnvelope.callId, "call-orphan");
  assert.equal(calls[0].resultEnvelope.error.code, "CALL_CANCELLED");
});

test("stored planner tool replay validates the closed envelope and exact call id", async (t) => {
  let fixture;
  fixture = await createFixture(t, async ({ host }) => {
    const call = dynamicCall("corrupt-replay-call", "read", {
      query: { kind: "workspace" },
    });
    const first = await host.dispatchPlannerTool(call);
    assert.equal(first.ok, true);
    fixture.store.database.prepare(
      `UPDATE planner_tool_calls
       SET result_envelope_json = json_set(result_envelope_json, '$.callId', 'wrong-call')
       WHERE app_server_call_id = 'corrupt-replay-call'`,
    ).run();
    await assert.rejects(
      host.dispatchPlannerTool(structuredClone(call)),
      (error) => error?.code === "STORE_CORRUPT" && /closed call contract/.test(error.message),
    );
  });

  await assert.rejects(
    fixture.harness.submit(fixture.submitRequest("corrupt-tool-replay")),
    /without a durable terminal transition/,
  );
  const turn = fixture.store.readInitializedWorkspace().chatTurns.at(-1);
  assert.equal(turn.status, "running");
  assert.equal(fixture.store.readAllEvents().length, 0);
  assert.throws(
    () => readCalls(fixture.store, turn.turnId),
    (error) => error?.code === "STORE_CORRUPT",
  );
  fixture.store.close();
  assert.throws(
    () => openPlannerStore({ filename: fixture.filename }),
    (error) => error?.code === "STORE_CORRUPT",
    "startup readiness scans every persisted planner tool envelope",
  );
});

test("null success data is corrupt for read, preview, and apply replay and startup", async (t) => {
  for (const tool of ["read", "preview", "apply"]) {
    await t.test(tool, async (toolTest) => {
      let fixture;
      fixture = await createFixture(toolTest, async ({ host }) => {
        const operation = {
          command: {
            type: "captureWeekLesson",
            weekId: fixture.week.id,
            weekLesson: `Validate ${tool} result data.`,
          },
        };
        const argumentsValue = tool === "read"
          ? { query: { kind: "workspace" } }
          : tool === "preview"
            ? {
                basePlannerVersion: fixture.planner.readWorkspace().plannerVersion,
                operations: [operation],
              }
            : {
                basePlannerVersion: fixture.planner.readWorkspace().plannerVersion,
                operations: [operation],
                readback: { kind: "workspace" },
              };
        const call = dynamicCall(`null-${tool}-data`, tool, argumentsValue);
        const first = await host.dispatchPlannerTool(call);
        assert.equal(first.ok, true);
        fixture.store.database.prepare(
          `UPDATE planner_tool_calls
           SET result_envelope_json = ?
           WHERE app_server_call_id = ?`,
        ).run(
          JSON.stringify({ ...first, data: null }),
          call.appServerCallId,
        );
        await assert.rejects(
          host.dispatchPlannerTool(structuredClone(call)),
          (error) => error?.code === "STORE_CORRUPT" &&
            /closed call contract/.test(error.message),
        );
      });

      await assert.rejects(
        fixture.harness.submit(fixture.submitRequest(`null-${tool}-submit`)),
        /without a durable terminal transition/,
      );
      const turn = fixture.store.readInitializedWorkspace().chatTurns.at(-1);
      assert.equal(turn.status, "running");
      assert.throws(
        () => readCalls(fixture.store, turn.turnId),
        (error) => error?.code === "STORE_CORRUPT",
      );
      fixture.store.close();
      assert.throws(
        () => openPlannerStore({ filename: fixture.filename }),
        (error) => error?.code === "STORE_CORRUPT",
        `${tool} startup scan must reject ok:true,data:null`,
      );
    });
  }
});

test("a no-effect retry is a fresh normal turn with planner tools", async (t) => {
  const fixture = await createFixture(t, async () => {
    throw new Error("model stopped before any planner call");
  });
  const failed = await fixture.harness.submit(fixture.submitRequest("zero-effect-submit"));
  const prior = failed.decision.turn;
  assert.equal(prior.terminalOutcome, "failed_no_effect");
  assert.equal(prior.acceptedEffectCount, 0);

  fixture.setBehavior(async ({ host, mode }) => {
    assert.equal(mode, "normal");
    const read = await host.dispatchPlannerTool(dynamicCall("retry-read", "read", {
      query: { kind: "workspace" },
    }));
    assert.equal(read.ok, true);
    assert.equal(await host.completeTurn({
      appServerThreadId: "app-thread-1",
      appServerTurnId: "app-turn-1",
    }, "I retried safely from current planner state."), true);
    return { reply: "I retried safely from current planner state." };
  });
  const retried = await fixture.harness.retry({
    requestId: "zero-effect-retry",
    basePlannerVersion: fixture.planner.readWorkspace().plannerVersion,
    turnId: prior.turnId,
  });
  const retryTurn = retried.decision.turn;
  assert.equal(retryTurn.mode, "normal");
  assert.equal(retryTurn.retryOfTurnId, prior.turnId);
  assert.equal(retryTurn.recoveryOfTurnId, null);
  assert.equal(retryTurn.terminalOutcome, "completed_no_effect");
  assert.equal(readCalls(fixture.store, retryTurn.turnId)[0].tool, "read");
});

test("embedded receipt replay rejects corrupt decision JSON", async (t) => {
  const fixture = await createFixture(t, async () => {
    throw new Error("stale guard must not start Codex");
  });
  const request = {
    ...fixture.submitRequest("corrupt-decision-receipt"),
    basePlannerVersion: fixture.seeded.workspace.plannerVersion + 1,
  };
  const first = await fixture.harness.submit(request);
  assert.equal(first.decision.status, "context_stale");
  fixture.store.database.prepare(
    `UPDATE command_receipts
     SET decision_json = ?
     WHERE operation_kind = 'chat_submit' AND request_id = ?`,
  ).run(
    JSON.stringify({ kind: "decision", decision: { arbitrary: true } }),
    request.requestId,
  );
  await assert.rejects(
    fixture.harness.submit(request),
    /invalid decision/,
  );
});
