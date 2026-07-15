import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCanonicalSeed } from "../lib/household-bootstrap.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { isChatTurnIntent } from "../lib/planner-chat-contract.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";
import { createEmbeddedChatApplicationService } from "../server/chat/embedded-service.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function createFixture(t, { ready = true } = {}) {
  const directoryPromise = mkdtemp(join(tmpdir(), "planner-chat-intent-"));
  let store;
  let filename;
  let planner;
  let chat;
  let week;
  let id = 0;
  let now = Date.parse("2026-07-11T10:00:00-03:00");
  let runtimeReady = ready;
  let runCount = 0;
  let behavior = async (request, identity) => {
    assert.equal(await request.host.completeTurn(identity, "Done."), true);
  };
  const idFactory = { createId: (prefix) => `${prefix}-${++id}` };
  const clock = { now: () => now++ };
  const failureInjector = { hit() {} };

  async function initialize() {
    const directory = await directoryPromise;
    t.after(() => rm(directory, { recursive: true, force: true }));
    filename = join(directory, "planner.sqlite");
    store = openPlannerStore({ filename });
    t.after(() => {
      try { store.close(); } catch { /* already closed by restart */ }
    });
    compose();
    const seeded = planner.bootstrap({ requestId: "bootstrap", mode: "seed" });
    week = seeded.workspace.state.weeks.find(
      (candidate) => candidate.id === seeded.workspace.state.activeWeekId,
    );
  }

  function compose() {
    planner = createPlannerApplicationService({
      store,
      domain: householdDomain,
      seedFactory: () => createCanonicalSeed({
        now: clock.now(),
        createId: (prefix) => idFactory.createId(prefix),
      }),
      transformLegacyV2: () => { throw new Error("legacy import outside fixture"); },
      clock,
      idFactory,
      failureInjector,
    });
    chat = createEmbeddedChatApplicationService({
      transactionRunner: store,
      persistence: store,
      plannerMutationKernel: planner,
      plannerRead: store,
      clock,
      idFactory,
      failureInjector,
      isCodexReady: () => runtimeReady,
      dynamicSession: {
        async run(request) {
          runCount += 1;
          const identity = {
            appServerThreadId: `thread-${runCount}`,
            appServerTurnId: `turn-${runCount}`,
          };
          assert.equal(await request.host.bindAppServerTurn(identity), true);
          try {
            await behavior(request, identity);
          } catch (error) {
            await request.host.failTurn(identity, {
              code: "TURN_FAILED",
              detail: "Synthetic intent-contract failure.",
            });
            throw error;
          }
        },
      },
      researchSession: {
        async run() {
          throw new Error("Research is not exercised by this contract fixture.");
        },
      },
    });
  }

  function request(requestId, intent = { kind: "planner", archiveContextWeek: false }) {
    return {
      requestId,
      basePlannerVersion: planner.readWorkspace().plannerVersion,
      message: "Update this week.",
      context: { view: "week", weekId: week.id },
      intent,
    };
  }

  return {
    initialize,
    request,
    get chat() { return chat; },
    get planner() { return planner; },
    get store() { return store; },
    get week() { return week; },
    get runCount() { return runCount; },
    setReady(value) { runtimeReady = value; },
    setBehavior(next) { behavior = next; },
    restart() {
      store.close();
      store = openPlannerStore({ filename });
      compose();
    },
  };
}

test("chat intent accepts only the two exact public shapes", () => {
  assert.equal(isChatTurnIntent({ kind: "planner", archiveContextWeek: false }), true);
  assert.equal(isChatTurnIntent({ kind: "planner", archiveContextWeek: true }), true);
  assert.equal(isChatTurnIntent({ kind: "sourced_recipe" }), true);
  for (const rejected of [
    null,
    {},
    { kind: "planner" },
    { kind: "planner", archiveContextWeek: 1 },
    { kind: "planner", archiveContextWeek: false, target: "week-x" },
    { kind: "sourced_recipe", archiveContextWeek: false },
    { kind: "unknown" },
  ]) {
    assert.equal(isChatTurnIntent(rejected), false, JSON.stringify(rejected));
  }
});

test("planner intent materializes only the context-week archive grant and hashes intent", async (t) => {
  const fixture = createFixture(t);
  await fixture.initialize();
  const request = fixture.request(
    "archive-intent",
    { kind: "planner", archiveContextWeek: true },
  );
  const accepted = await fixture.chat.submit(request);
  assert.equal(accepted.decision.status, "accepted");
  assert.deepEqual(accepted.decision.turn.foregroundAuthority, [{
    commandType: "archiveWeek",
    target: fixture.week.id,
  }]);
  assert.equal(Object.isFrozen(accepted.decision.turn.foregroundAuthority), true);

  const replay = await fixture.chat.submit(structuredClone(request));
  assert.equal(replay.decision.status, "accepted");
  assert.equal(replay.decision.turn.turnId, accepted.decision.turn.turnId);
  assert.equal(fixture.runCount, 1);

  fixture.restart();
  const reopenedReplay = await fixture.chat.submit(structuredClone(request));
  assert.equal(reopenedReplay.decision.status, "accepted");
  assert.equal(reopenedReplay.decision.turn.turnId, accepted.decision.turn.turnId);
  assert.equal(reopenedReplay.workspace.chatTurns.length, 1);
  assert.equal(fixture.runCount, 1);
  assert.equal(
    fixture.store.database.prepare(
      "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'chat_submit' AND request_id = ?",
    ).get(request.requestId).count,
    1,
  );

  const changedIntent = await fixture.chat.submit({
    ...request,
    intent: { kind: "planner", archiveContextWeek: false },
  });
  assert.equal(changedIntent.decision.status, "request_id_reuse");
  assert.equal(fixture.runCount, 1);

  const rawGrant = await fixture.chat.submit({
    ...fixture.request("raw-grant"),
    foregroundAuthority: [{ commandType: "archiveWeek", target: "attacker-week" }],
  });
  assert.equal(rawGrant.decision.status, "domain_rejected");
  assert.equal(fixture.store.readAllChatTurns().length, 1);
});

test("unavailability is receipt-backed with no turn or transcript across restart", async (t) => {
  const fixture = createFixture(t, { ready: false });
  await fixture.initialize();
  const request = fixture.request("unavailable-intent");
  const first = await fixture.chat.submit(request);
  assert.deepEqual(first.decision, {
    status: "codex_unavailable",
    message: "Embedded Codex is unavailable.",
  });
  assert.equal(first.workspace.chatTurns.length, 0);
  assert.equal(first.workspace.transcriptEntries.length, 0);
  assert.equal(fixture.runCount, 0);

  fixture.restart();
  fixture.setReady(true);
  const replay = await fixture.chat.submit(structuredClone(request));
  assert.deepEqual(replay.decision, first.decision);
  assert.equal(replay.workspace.chatTurns.length, 0);
  assert.equal(replay.workspace.transcriptEntries.length, 0);
  assert.equal(fixture.runCount, 0);

  const mismatch = await fixture.chat.submit({
    ...request,
    intent: { kind: "planner", archiveContextWeek: true },
  });
  assert.equal(mismatch.decision.status, "request_id_reuse");
});

test("normal retry inherits the persisted intent-derived grant", async (t) => {
  const fixture = createFixture(t);
  await fixture.initialize();
  fixture.setBehavior(async () => {
    throw new Error("fail before effect");
  });
  const failed = await fixture.chat.submit(fixture.request(
    "retry-intent",
    { kind: "planner", archiveContextWeek: true },
  ));
  assert.equal(failed.decision.turn.status, "failed");
  assert.deepEqual(failed.decision.turn.foregroundAuthority, [{
    commandType: "archiveWeek",
    target: fixture.week.id,
  }]);

  fixture.setBehavior(async (request, identity) => {
    assert.equal(await request.host.completeTurn(identity, "Recovered."), true);
  });
  const retryRequest = {
    requestId: "retry-intent-again",
    basePlannerVersion: fixture.planner.readWorkspace().plannerVersion,
    turnId: failed.decision.turn.turnId,
  };
  const retried = await fixture.chat.retry(retryRequest);
  assert.equal(retried.decision.turn.mode, "normal");
  assert.deepEqual(retried.decision.turn.foregroundAuthority, [{
    commandType: "archiveWeek",
    target: fixture.week.id,
  }]);
  const runCountAfterRetry = fixture.runCount;

  fixture.restart();
  const reopenedRetry = await fixture.chat.retry(structuredClone(retryRequest));
  assert.equal(reopenedRetry.decision.status, "accepted");
  assert.equal(reopenedRetry.decision.turn.turnId, retried.decision.turn.turnId);
  assert.equal(reopenedRetry.workspace.chatTurns.length, 2);
  assert.equal(fixture.runCount, runCountAfterRetry);
  assert.equal(
    fixture.store.database.prepare(
      "SELECT COUNT(*) AS count FROM command_receipts WHERE operation_kind = 'chat_retry' AND request_id = ?",
    ).get(retryRequest.requestId).count,
    1,
  );
});
