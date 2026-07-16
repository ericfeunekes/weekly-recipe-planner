import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNativeCodexSession } from "../server/codex/native-session.ts";
import { createNativeCodexThreadService } from "../server/codex/thread-service.ts";
import {
  createSqliteCodexThreadStore,
  NATIVE_MUTATION_RECEIPT_LIMIT,
} from "../server/store/codex-thread-store.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

const fixturePath = new URL(
  "./support/fixtures/codex-runtime/fake-native-app-server.mjs",
  import.meta.url,
);

async function eventually(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Condition did not become true before its deadline.");
}

async function createFixture(t, fixtureEnvironment = {}, hostOptions = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "planner-native-service-")));
  const databaseFile = join(directory, "planner.sqlite");
  const nativeStateFile = join(directory, "native-app-server-state.json");
  const dispatched = [];
  let epoch = 0;
  let serviceGeneration = 0;
  const siblings = [];
  let sqlite = openPlannerStore({ filename: databaseFile });
  let service;
  let session;
  const createSession = () => createNativeCodexSession({
      fixedCwd: directory,
      execution: {
        async spawnAppServer() {
          return spawn(process.execPath, [fixturePath.pathname], {
            cwd: directory,
            env: {
              ...process.env,
              FAKE_NATIVE_STATE_FILE: nativeStateFile,
              ...fixtureEnvironment,
            },
            stdio: ["pipe", "pipe", "pipe"],
          });
        },
      },
      createEpoch: () => `epoch-${epoch += 1}`,
      requestTimeoutMs: hostOptions.requestTimeoutMs ?? 2_000,
      async dispatchPlannerTool(params) {
        dispatched.push(params);
        return {
          success: true,
          contentItems: [{
            type: "inputText",
            text: JSON.stringify({
              schemaVersion: 1,
              ok: true,
              callId: params.callId,
              plannerVersion: 0,
              syncRevision: 0,
              serverTime: Date.now(),
              data: { kind: "workspace", activeWeekId: null, weeks: [] },
            }),
          }],
        };
      },
    });
  const openRuntime = () => {
    session = createSession();
    const baseStore = createSqliteCodexThreadStore(sqlite);
    service = createNativeCodexThreadService({
      session,
      store: hostOptions.decorateStore?.(baseStore) ?? baseStore,
      now: () => 1_000,
      replayLimit: hostOptions.replayLimit,
      turnHistoryConvergenceWaitMs: hostOptions.turnHistoryConvergenceWaitMs,
      clientMessageCompletionWaitMs: hostOptions.clientMessageCompletionWaitMs,
      admissionOwnerId: `fixture-owner-${serviceGeneration += 1}`,
      recoverAdmissionsOnStartup: true,
    });
  };
  openRuntime();
  const openSibling = (ownerId = `sibling-owner-${serviceGeneration + 1}`) => {
    const siblingSqlite = openPlannerStore({ filename: databaseFile });
    const siblingSession = createSession();
    const siblingService = createNativeCodexThreadService({
      session: siblingSession,
      store: createSqliteCodexThreadStore(siblingSqlite),
      now: () => 1_000,
      replayLimit: hostOptions.replayLimit,
      turnHistoryConvergenceWaitMs: hostOptions.turnHistoryConvergenceWaitMs,
      clientMessageCompletionWaitMs: hostOptions.clientMessageCompletionWaitMs,
      admissionOwnerId: ownerId,
    });
    const sibling = {
      service: siblingService,
      session: siblingSession,
      sqlite: siblingSqlite,
    };
    siblings.push(sibling);
    return sibling;
  };
  const reopen = async () => {
    await service.close();
    sqlite.close();
    sqlite = openPlannerStore({ filename: databaseFile });
    openRuntime();
    return { service, session, sqlite, dispatched };
  };
  t.after(async () => {
    for (const sibling of siblings) {
      await sibling.service.close();
      sibling.sqlite.close();
    }
    await service.close();
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, session, sqlite, dispatched, directory, reopen, openSibling };
}

test("startup queues native interactions until persistent-thread eligibility is hydrated", async (t) => {
  const { service } = await createFixture(t, { FAKE_NATIVE_EARLY_INPUT: "1" });
  const pending = await service.listInteractions({});
  assert.equal(pending.interactions.length, 1);
  assert.equal(pending.interactions[0].kind, "user_input");
  assert.equal(pending.interactions[0].threadId, "native-thread-1");
});

test("startup replays request resolution after its deferred native question", async (t) => {
  const { service } = await createFixture(t, {
    FAKE_NATIVE_EARLY_INPUT: "1",
    FAKE_NATIVE_EARLY_INPUT_RESOLVED: "1",
  });
  const pending = await service.listInteractions({});
  assert.deepEqual(pending.interactions, []);
});

test("startup hydrates every root page before dispatching an early native interaction", async (t) => {
  const { service } = await createFixture(t, {
    FAKE_NATIVE_ROOT_COUNT: "305",
    FAKE_NATIVE_EARLY_INPUT: "1",
  });
  const pending = await service.listInteractions({});
  assert.equal(pending.interactions.length, 1);
  assert.equal(pending.interactions[0].threadId, "native-thread-306");
});

test("startup revalidates markerless planner history and rejects markerless foreign roots", async (t) => {
  const planner = await createFixture(t, {
    FAKE_NATIVE_ROOT_COUNT: "1",
    FAKE_NATIVE_REVALIDATION_NULL_READS: "1",
  });
  const plannerHistory = await planner.service.listThreads({});
  assert.deepEqual(plannerHistory.threads.map((thread) => thread.id), ["native-thread-1"]);
  assert.equal(planner.session.isEligibleRoot("native-thread-1"), true);
  const plannerStats = await planner.session.request("thread/list", { searchTerm: "__stats__" });
  assert.deepEqual(plannerStats.threadReadRequests.slice(0, 2), [
    { threadId: "native-thread-1", includeTurns: true },
    { threadId: "native-thread-1", includeTurns: true },
  ]);

  const foreign = await createFixture(t, { FAKE_NATIVE_FOREIGN_MATERIALIZED_ROOT: "1" });
  const foreignHistory = await foreign.service.listThreads({});
  assert.deepEqual(foreignHistory.threads, []);
  assert.deepEqual(foreignHistory.selection, { threadId: null, revision: 0 });
  assert.equal(foreign.session.isEligibleRoot("native-thread-1"), false);
  const foreignStats = await foreign.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(foreignStats.threadReadRequests.every((entry) =>
    entry.threadId === "native-thread-1" && entry.includeTurns === true
  ), true);
});

test("an unknown markerless root stays ineligible when thread/read cannot recover provenance", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNVERIFIABLE_MATERIALIZED_ROOT: "1",
  });
  const history = await fixture.service.listThreads({});
  assert.deepEqual(history.threads, []);
  assert.deepEqual(history.selection, { threadId: null, revision: 0 });
  assert.equal(fixture.session.isEligibleRoot("native-thread-1"), false);
});

for (const [label, environment] of [
  ["a repeated cursor", { FAKE_NATIVE_LIST_REPEAT_CURSOR: "1" }],
  ["an endless catalogue", { FAKE_NATIVE_LIST_ENDLESS_CURSOR: "1" }],
]) {
  test(`startup fails closed on ${label}`, async (t) => {
    const { service } = await createFixture(t, environment);
    await assert.rejects(
      service.listInteractions({}),
      (error) => error.code === "CODEX_INCOMPATIBLE",
    );
  });
}

test("locked thread requests use the experimental read-only permissions field exclusively", async (t) => {
  const { session } = await createFixture(t);
  const start = session.lockedThreadStartParams();
  const resume = session.lockedThreadResumeParams("native-thread-1");
  assert.equal(start.permissions, ":read-only");
  assert.equal(resume.permissions, ":read-only");
  assert.equal(start.threadSource, "weekly_recipe_planner");
  assert.equal(Object.hasOwn(start, "sandbox"), false);
  assert.equal(Object.hasOwn(resume, "sandbox"), false);
});

test("an allocated root accepts its first turn without a premature history read and replays exactly", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
  });
  const created = await fixture.service.newThread({
    requestId: "unmaterialized-direct-new",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "unmaterialized-direct-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "unmaterialized-direct-client",
    message: "Materialize this root exactly once",
  };

  const sent = await fixture.service.sendTurn(request);
  const replay = await fixture.service.sendTurn(request);
  assert.deepEqual(replay, sent);

  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"], 1);
  assert.equal(stats.requestCounts["thread/read"], 1);
  assert.ok(
    stats.requestSequence.indexOf("turn/start") < stats.requestSequence.indexOf("thread/read"),
    "history must be read only after the accepted turn enters its client-message lifecycle",
  );
  assert.deepEqual(stats.threadReadRequests, [{
    threadId: created.thread.id,
    includeTurns: true,
  }]);
  const rawRead = await fixture.session.request("thread/read", {
    threadId: created.thread.id,
    includeTurns: true,
  });
  assert.equal(rawRead.thread.threadSource, null);
  const rawList = await fixture.session.request("thread/list", {
    archived: false,
    cwd: fixture.directory,
    parentThreadId: null,
    sourceKinds: [],
    sortKey: "updated_at",
    sortDirection: "desc",
  });
  assert.equal(
    rawList.data.find((thread) => thread.id === created.thread.id)?.threadSource,
    null,
  );
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = ?",
  ).get(request.requestId).count, 1);
});

test("a non-null post-materialization thread source mismatch fails closed", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
    FAKE_NATIVE_LIVE_READ_THREAD_SOURCE: "foreign-native-thread",
  });
  const created = await fixture.service.newThread({
    requestId: "materialized-source-drift-new",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "materialized-source-drift-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "materialized-source-drift-client",
    message: "Reject a changed materialized root namespace",
  };

  await assert.rejects(
    fixture.service.sendTurn(request),
    (error) => error.code === "NOT_FOUND" && /not available to the planner/iu.test(error.message),
  );
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions WHERE request_id = ?",
  ).get(request.requestId).count, 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = ?",
  ).get(request.requestId).count, 0);
});

test("an acknowledged first turn waits for completed client identity and delayed history without duplication", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
    FAKE_NATIVE_DELAY_FIRST_TURN_MATERIALIZATION_MS: "75",
  });
  const created = await fixture.service.newThread({
    requestId: "delayed-materialization-new",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "delayed-materialization-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "delayed-materialization-client",
    message: "Materialize this acknowledged message exactly once",
  };

  const sent = await fixture.service.sendTurn(request);
  const replay = await fixture.service.sendTurn(request);
  assert.deepEqual(replay, sent);

  const acceptanceStats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(acceptanceStats.requestCounts["turn/start"], 1);
  assert.ok(acceptanceStats.requestCounts["thread/read"] >= 2);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = ?",
  ).get(request.requestId).count, 1);

  const read = await fixture.service.readThread({ threadId: created.thread.id });
  const matching = read.thread.turns.flatMap((turn) => turn.items).filter((item) =>
    item.kind === "message" && item.clientUserMessageId === request.clientUserMessageId
  );
  assert.equal(matching.length, 1);
});

test("a delayed correct client completion keeps the admitted first send pending without reading history", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
    FAKE_NATIVE_BLOCK_USER_MESSAGE_COMPLETION: "1",
  });
  const created = await fixture.service.newThread({
    requestId: "delayed-client-completion-new",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "delayed-client-completion-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "delayed-client-completion-id",
    message: "Wait for my exact completed client identity",
  };
  let settled = false;
  const sending = fixture.service.sendTurn(request).finally(() => {
    settled = true;
  });
  const startedMarker = join(fixture.directory, ".fake-native-user-completion-started");
  const releaseMarker = join(fixture.directory, ".fake-native-user-completion-release");
  await eventually(
    () => access(startedMarker).then(() => true, () => false),
    (started) => started,
  );

  const pendingStats = await eventually(
    () => fixture.session.request("thread/list", { searchTerm: "__stats__" }),
    (stats) => stats.requestCounts["turn/start"] === 1,
  );
  assert.equal(settled, false);
  assert.equal(pendingStats.requestCounts["turn/start"], 1);
  assert.equal(pendingStats.requestCounts["thread/read"] ?? 0, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'send'",
  ).get().count, 0);
  const selectedWhilePending = fixture.sqlite.database.prepare(
    "SELECT selected_thread_id, revision FROM codex_thread_selection WHERE id = 'planner'",
  ).get();
  assert.equal(selectedWhilePending.selected_thread_id, created.thread.id);
  assert.equal(selectedWhilePending.revision, created.selection.revision);

  await writeFile(releaseMarker, "release\n", { mode: 0o600 });
  const sent = await sending;
  const replay = await fixture.service.sendTurn(request);
  assert.deepEqual(replay, sent);
  const completedStats = await fixture.session.request("thread/list", {
    searchTerm: "__stats__",
  });
  assert.equal(completedStats.requestCounts["turn/start"], 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = ?",
  ).get(request.requestId).count, 1);
  const selectedAfterCompletion = fixture.sqlite.database.prepare(
    "SELECT selected_thread_id, revision FROM codex_thread_selection WHERE id = 'planner'",
  ).get();
  assert.deepEqual(selectedAfterCompletion, selectedWhilePending);
});

test("a completed client identity on the wrong turn fails closed without a receipt or duplicate send", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
    FAKE_NATIVE_USER_MESSAGE_COMPLETION_TURN_ID: "wrong-completion-turn",
  });
  const created = await fixture.service.newThread({
    requestId: "wrong-client-completion-new",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "wrong-client-completion-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "wrong-client-completion-id",
    message: "Reject a completion on the wrong turn",
  };

  await assert.rejects(
    fixture.service.sendTurn(request),
    (error) => error.code === "CODEX_INCOMPATIBLE" &&
      error.cause?.code === "PROTOCOL_ERROR" &&
      /unexpected turn/iu.test(error.cause.message),
  );
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = ?",
  ).get(request.requestId).count, 0);
  const selected = fixture.sqlite.database.prepare(
    "SELECT selected_thread_id, revision FROM codex_thread_selection WHERE id = 'planner'",
  ).get();
  assert.equal(selected.selected_thread_id, created.thread.id);
  assert.equal(selected.revision, created.selection.revision);

  const recovered = await fixture.service.sendTurn(request);
  assert.equal(recovered.turnId, "native-turn-1");
  const replay = await fixture.service.sendTurn(request);
  assert.deepEqual(replay, recovered);
  const read = await fixture.service.readThread({ threadId: created.thread.id });
  const matching = read.thread.turns.flatMap((turn) => turn.items).filter((item) =>
    item.kind === "message" && item.clientUserMessageId === request.clientUserMessageId
  );
  assert.equal(matching.length, 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = ?",
  ).get(request.requestId).count, 1);
  const selectedAfterRecovery = fixture.sqlite.database.prepare(
    "SELECT selected_thread_id, revision FROM codex_thread_selection WHERE id = 'planner'",
  ).get();
  assert.deepEqual(selectedAfterRecovery, selected);
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"], 1);
});

test("restart recovers durable first-send history when its client completion notification was missing", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
    FAKE_NATIVE_OMIT_USER_MESSAGE_COMPLETION: "1",
  }, { clientMessageCompletionWaitMs: 25 });
  const created = await fixture.service.newThread({
    requestId: "missing-completion-recovery-new",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "missing-completion-recovery-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "missing-completion-recovery-id",
    message: "Recover my one durable message after restart",
  };

  await assert.rejects(
    fixture.service.sendTurn(request),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      /client-message lifecycle/iu.test(error.message),
  );
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = ?",
  ).get(request.requestId).count, 0);

  const reopened = await fixture.reopen();
  const read = await reopened.service.readThread({ threadId: created.thread.id });
  assert.equal(read.thread.id, created.thread.id);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = ?",
  ).get(request.requestId).count, 1);
  const recovered = await reopened.service.sendTurn(request);
  const replay = await reopened.service.sendTurn(request);
  assert.deepEqual(replay, recovered);
  const reopenedStats = await reopened.session.request("thread/list", {
    searchTerm: "__stats__",
  });
  assert.equal(reopenedStats.requestCounts["turn/start"] ?? 0, 0);
  const selected = reopened.sqlite.database.prepare(
    "SELECT selected_thread_id, revision FROM codex_thread_selection WHERE id = 'planner'",
  ).get();
  assert.equal(selected.selected_thread_id, created.thread.id);
  assert.equal(selected.revision, created.selection.revision);
  await assert.rejects(
    reopened.service.sendTurn({ ...request, message: "Changed after recovery" }),
    (error) => error.code === "REQUEST_ID_REUSE",
  );
});

test("a missing client-message completion and absent history stay fenced without a second turn", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
    FAKE_NATIVE_OMIT_USER_MESSAGE_COMPLETION: "1",
    FAKE_NATIVE_OMIT_TURN_START_HISTORY: "1",
  }, {
    clientMessageCompletionWaitMs: 25,
    turnHistoryConvergenceWaitMs: 25,
  });
  const created = await fixture.service.newThread({
    requestId: "missing-completion-new",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "missing-completion-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "missing-completion-client",
    message: "Keep this admitted message fenced",
  };

  await assert.rejects(
    fixture.service.sendTurn(request),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      /client-message lifecycle/iu.test(error.message),
  );
  await assert.rejects(
    fixture.service.sendTurn(request),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      /authoritative history/iu.test(error.message),
  );

  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"], 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'send'",
  ).get().count, 0);
});

test("list cannot clear a blank root that concurrently materializes", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
    FAKE_NATIVE_BLOCK_THREAD_READ: "1",
  });
  const created = await fixture.service.newThread({
    requestId: "unmaterialized-race-new",
    expectedSelectionRevision: 0,
  });
  const listing = fixture.service.listThreads({});
  const startedMarker = join(fixture.directory, ".fake-native-thread-read-started");
  const releaseMarker = join(fixture.directory, ".fake-native-thread-read-release");
  await eventually(
    () => access(startedMarker).then(() => true, () => false),
    (started) => started,
  );

  const sending = fixture.service.sendTurn({
    requestId: "unmaterialized-race-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "unmaterialized-race-client",
    message: "Materialize while history is probing the blank root",
  });
  await eventually(
    () => fixture.session.request("thread/list", { searchTerm: "__stats__" }),
    (stats) => stats.requestCounts["turn/start"] === 1,
  );
  await writeFile(releaseMarker, "release\n", { mode: 0o600 });

  const [listed, sent] = await Promise.all([listing, sending]);
  assert.equal(sent.threadId, created.thread.id);
  assert.deepEqual(listed.selection, created.selection);
  assert.deepEqual(listed.threads.map((thread) => thread.id), [created.thread.id]);
  const selected = fixture.sqlite.database.prepare(
    "SELECT selected_thread_id, revision FROM codex_thread_selection WHERE id = 'planner'",
  ).get();
  assert.equal(selected.selected_thread_id, created.thread.id);
  assert.equal(selected.revision, created.selection.revision);
});

test("restart rejects a process-local blank root and a later list clears its selection", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
  });
  const created = await fixture.service.newThread({
    requestId: "unmaterialized-restart-new",
    expectedSelectionRevision: 0,
  });
  const reopened = await fixture.reopen();
  const request = {
    requestId: "unmaterialized-restart-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "unmaterialized-restart-client",
    message: "Recover and materialize this root once",
  };

  await assert.rejects(
    reopened.service.sendTurn(request),
    (error) => error.code === "NOT_FOUND",
  );
  const stats = await reopened.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"] ?? 0, 0);
  assert.deepEqual(stats.threadReadRequests, [{
    threadId: created.thread.id,
    includeTurns: false,
  }]);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);

  const listed = await reopened.service.listThreads({});
  assert.deepEqual(listed.selection, { threadId: null, revision: 2 });
  assert.deepEqual(listed.threads, []);
});

test("a restarted list reconciles its process-local blank root to empty", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
  });
  const created = await fixture.service.newThread({
    requestId: "unmaterialized-list-new",
    expectedSelectionRevision: 0,
  });
  const reopened = await fixture.reopen();

  const listed = await reopened.service.listThreads({});
  assert.deepEqual(listed.selection, {
    threadId: null,
    revision: created.selection.revision + 1,
  });
  assert.deepEqual(listed.threads, []);
  const stats = await reopened.session.request("thread/list", { searchTerm: "__stats__" });
  assert.deepEqual(stats.threadReadRequests, [{
    threadId: created.thread.id,
    includeTurns: false,
  }]);
  assert.equal(reopened.session.isUnmaterializedRoot(created.thread.id), false);
});

test("an absent foreign selected root is cleared without widening first-turn authority", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_FOREIGN_UNMATERIALIZED_ROOT: "1",
  });
  await fixture.service.listThreads({});
  fixture.sqlite.database.prepare(
    `UPDATE codex_thread_selection
     SET selected_thread_id = ?, revision = 1, updated_at = 1000
     WHERE id = 'planner'`,
  ).run("native-thread-1");
  const listed = await fixture.service.listThreads({});
  assert.deepEqual(listed.selection, { threadId: null, revision: 2 });
  assert.deepEqual(listed.threads, []);

  await assert.rejects(
    fixture.service.sendTurn({
      requestId: "foreign-unmaterialized-send",
      threadId: "native-thread-1",
      expectedSelectionRevision: 1,
      clientUserMessageId: "foreign-unmaterialized-client",
      message: "Do not widen authority to this root",
    }),
    (error) => error.code === "SELECTION_CONFLICT",
  );
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"] ?? 0, 0);
  assert.deepEqual(stats.threadReadRequests, [{
    threadId: "native-thread-1",
    includeTurns: false,
  }]);
  assert.equal(fixture.session.isEligibleRoot("native-thread-1"), false);
});

test("a provider-lost blank root is reconciled to empty after app-server restart", async (t) => {
  const staleThreadId = "native-thread-lost-blank";
  const fixture = await createFixture(t, {
    FAKE_NATIVE_NOT_LOADED_THREAD_ID: staleThreadId,
  });
  fixture.sqlite.database.prepare(
    `UPDATE codex_thread_selection
     SET selected_thread_id = ?, revision = 1, updated_at = 1000
     WHERE id = 'planner'`,
  ).run(staleThreadId);

  const listed = await fixture.service.listThreads({});
  assert.deepEqual(listed.selection, { threadId: null, revision: 2 });
  assert.deepEqual(listed.threads, []);
  assert.equal(listed.activityRevision, 1);

  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.deepEqual(stats.threadReadRequests, [{
    threadId: staleThreadId,
    includeTurns: false,
  }]);

  const relisted = await fixture.service.listThreads({});
  assert.deepEqual(relisted.selection, { threadId: null, revision: 2 });
  assert.deepEqual(relisted.threads, []);
  const afterStats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.deepEqual(afterStats.threadReadRequests, stats.threadReadRequests);
});

test("a mismatched thread-not-loaded identity fails closed without clearing selection", async (t) => {
  const selectedThreadId = "native-thread-selected-blank";
  const fixture = await createFixture(t, {
    FAKE_NATIVE_NOT_LOADED_THREAD_ID: selectedThreadId,
    FAKE_NATIVE_NOT_LOADED_RESPONSE_THREAD_ID: "native-thread-other-blank",
  });
  fixture.sqlite.database.prepare(
    `UPDATE codex_thread_selection
     SET selected_thread_id = ?, revision = 1, updated_at = 1000
     WHERE id = 'planner'`,
  ).run(selectedThreadId);

  await assert.rejects(
    fixture.service.listThreads({}),
    (error) => error.code === "CODEX_INCOMPATIBLE",
  );
  const selected = fixture.sqlite.database.prepare(
    "SELECT selected_thread_id, revision FROM codex_thread_selection WHERE id = 'planner'",
  ).get();
  assert.equal(selected.selected_thread_id, selectedThreadId);
  assert.equal(selected.revision, 1);
});

test("selection and archive remain safe for an allocated unmaterialized root", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
  });
  const created = await fixture.service.newThread({
    requestId: "unmaterialized-navigation-new",
    expectedSelectionRevision: 0,
  });
  const cleared = await fixture.service.selectThread({
    requestId: "unmaterialized-navigation-clear",
    threadId: null,
    expectedSelectionRevision: created.selection.revision,
  });
  const selected = await fixture.service.selectThread({
    requestId: "unmaterialized-navigation-select",
    threadId: created.thread.id,
    expectedSelectionRevision: cleared.selection.revision,
  });
  const sent = await fixture.service.sendTurn({
    requestId: "unmaterialized-navigation-send",
    threadId: created.thread.id,
    expectedSelectionRevision: selected.selection.revision,
    clientUserMessageId: "unmaterialized-navigation-client",
    message: "Send after navigation",
  });
  assert.equal(sent.turnId, "native-turn-1");
  const navigationStats = await fixture.session.request(
    "thread/list",
    { searchTerm: "__stats__" },
  );
  assert.deepEqual(
    navigationStats.threadReadRequests.map((entry) => entry.includeTurns),
    [false, true],
  );

  const second = await fixture.service.newThread({
    requestId: "unmaterialized-archive-new",
    expectedSelectionRevision: selected.selection.revision,
  });
  const archived = await fixture.service.archiveThread({
    requestId: "unmaterialized-archive",
    threadId: second.thread.id,
    expectedSelectionRevision: second.selection.revision,
  });
  assert.deepEqual(archived.selection, {
    threadId: null,
    revision: second.selection.revision + 1,
  });
  await assert.rejects(
    fixture.service.sendTurn({
      requestId: "unmaterialized-archived-send",
      threadId: second.thread.id,
      expectedSelectionRevision: second.selection.revision,
      clientUserMessageId: "unmaterialized-archived-client",
      message: "Do not start this archived root",
    }),
    (error) => error.code === "SELECTION_CONFLICT",
  );
  const archiveStats = await fixture.session.request(
    "thread/list",
    { searchTerm: "__stats__" },
  );
  assert.equal(archiveStats.requestCounts["turn/start"], 1);
  assert.equal(archiveStats.requestCounts["thread/archive"], 1);
});

test("an unrecognized pre-turn read rejection never authorizes turn/start", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT: "1",
    // Deliberately model a hypothetical provider that persists the blank root
    // but changes its pre-turn read error. The real 0.142.5 lifecycle is
    // covered separately by the process-local restart tests above.
    FAKE_NATIVE_PERSIST_UNMATERIALIZED_ROOT: "1",
    FAKE_NATIVE_UNMATERIALIZED_READ_ERROR_CODE: "-32600",
    FAKE_NATIVE_UNMATERIALIZED_READ_MESSAGE: "thread is not ready for an unspecified reason",
  });
  const created = await fixture.service.newThread({
    requestId: "unmaterialized-drift-new",
    expectedSelectionRevision: 0,
  });
  const reopened = await fixture.reopen();
  await assert.rejects(
    reopened.service.sendTurn({
      requestId: "unmaterialized-drift-send",
      threadId: created.thread.id,
      expectedSelectionRevision: created.selection.revision,
      clientUserMessageId: "unmaterialized-drift-client",
      message: "Do not infer materialization",
    }),
    (error) => error.code === "CODEX_INCOMPATIBLE",
  );
  const stats = await reopened.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"] ?? 0, 0);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
});

test("native service creates, lists, reads, starts, steers, interrupts, and archives", async (t) => {
  const { service, session } = await createFixture(t);
  const created = await service.newThread({
    requestId: "new-1",
    expectedSelectionRevision: 0,
  });
  assert.equal(created.thread.id, "native-thread-1");
  assert.deepEqual(created.selection, { threadId: "native-thread-1", revision: 1 });

  const listed = await service.listThreads({});
  assert.deepEqual(listed.threads.map((thread) => thread.id), ["native-thread-1"]);
  assert.deepEqual(listed.selection, created.selection);
  const read = await service.readThread({ threadId: "native-thread-1" });
  assert.equal(read.thread.id, "native-thread-1");
  assert.deepEqual(read.thread.turns, []);

  const started = await service.sendTurn({
    requestId: "send-1",
    threadId: "native-thread-1",
    expectedSelectionRevision: 1,
    clientUserMessageId: "client-1",
    message: "Plan dinner",
  });
  assert.equal(started.turnId, "native-turn-1");
  const replay = await service.sendTurn({
    requestId: "send-1",
    threadId: "native-thread-1",
    expectedSelectionRevision: 1,
    clientUserMessageId: "client-1",
    message: "Plan dinner",
  });
  assert.deepEqual(replay, started);
  await assert.rejects(
    service.sendTurn({
      requestId: "send-1",
      threadId: "native-thread-1",
      expectedSelectionRevision: 1,
      clientUserMessageId: "client-1",
      message: "Changed payload",
    }),
    (error) => error.code === "REQUEST_ID_REUSE",
  );

  const steered = await service.sendTurn({
    requestId: "send-2",
    threadId: "native-thread-1",
    expectedSelectionRevision: 1,
    clientUserMessageId: "client-2",
    message: "Also add soup",
  });
  assert.equal(steered.turnId, started.turnId);
  const interrupted = await service.interruptTurn({
    requestId: "interrupt-1",
    threadId: "native-thread-1",
    expectedSelectionRevision: 1,
    turnId: started.turnId,
  });
  assert.equal(interrupted.turnId, started.turnId);

  const archived = await service.archiveThread({
    requestId: "archive-1",
    threadId: "native-thread-1",
    expectedSelectionRevision: 1,
  });
  assert.deepEqual(archived.selection, { threadId: null, revision: 2 });
  assert.equal(archived.thread, null);
  const archiveHistory = await service.listThreads({ archived: true });
  assert.deepEqual(archiveHistory.threads.map((thread) => thread.id), ["native-thread-1"]);
  const archivedRead = await service.readThread({ threadId: "native-thread-1" });
  assert.equal(archivedRead.thread.threadKind, "conversation");
  assert.equal(session.isEligibleRoot("native-thread-1"), false);
  assert.equal(session.isEligibleRootTurn("native-thread-1", started.turnId), false);
  await assert.rejects(
    service.selectThread({
      requestId: "select-archived",
      threadId: "native-thread-1",
      expectedSelectionRevision: 2,
    }),
    (error) => error.code === "NOT_FOUND",
  );
});

test("archived roots remain ineligible after the native session and store reopen", async (t) => {
  const fixture = await createFixture(t);
  const created = await fixture.service.newThread({
    requestId: "archive-reopen-new",
    expectedSelectionRevision: 0,
  });
  const archived = await fixture.service.archiveThread({
    requestId: "archive-reopen",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
  });
  assert.deepEqual(archived.selection, { threadId: null, revision: 2 });

  const reopened = await fixture.reopen();
  const history = await reopened.service.readThread({ threadId: created.thread.id });
  assert.equal(history.thread.threadKind, "conversation");
  assert.equal(reopened.session.isEligibleRoot(created.thread.id), false);
  assert.equal(reopened.session.isEligibleRootTurn(created.thread.id, "native-turn-1"), false);
  await assert.rejects(
    reopened.service.selectThread({
      requestId: "archive-reopen-select",
      threadId: created.thread.id,
      expectedSelectionRevision: archived.selection.revision,
    }),
    (error) => error.code === "NOT_FOUND",
  );
  const stats = await reopened.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["thread/resume"] ?? 0, 0);
});

test("a reopened thread-start receipt returns the current shared selection, not a stale pointer", async (t) => {
  const fixture = await createFixture(t);
  const firstRequest = { requestId: "receipt-selection-first", expectedSelectionRevision: 0 };
  const first = await fixture.service.newThread(firstRequest);
  const second = await fixture.service.newThread({
    requestId: "receipt-selection-second",
    expectedSelectionRevision: first.selection.revision,
  });
  const reopened = await fixture.reopen();
  const replay = await reopened.service.newThread(firstRequest);
  assert.equal(replay.thread.id, first.thread.id);
  assert.deepEqual(replay.selection, second.selection);
  const stats = await reopened.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["thread/start"] ?? 0, 0);
});

test("an unreceipted request cannot alias an existing client message identity", async (t) => {
  const fixture = await createFixture(t);
  const created = await fixture.service.newThread({
    requestId: "client-alias-thread",
    expectedSelectionRevision: 0,
  });
  const original = {
    requestId: "client-alias-original",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "client-alias-id",
    message: "Do not alias this message",
  };
  await fixture.service.sendTurn(original);
  const reopened = await fixture.reopen();
  await assert.rejects(
    reopened.service.sendTurn({ ...original, requestId: "client-alias-new-request" }),
    (error) => error.code === "REQUEST_ID_REUSE" && /client message id/iu.test(error.message),
  );
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = 'client-alias-new-request'",
  ).get().count, 0);
  const stats = await reopened.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"] ?? 0, 0);
  assert.equal(stats.requestCounts["turn/steer"] ?? 0, 0);
});

test("request ids beyond the exact receipt horizon are honestly treated as unseen", async (t) => {
  const fixture = await createFixture(t);
  const store = createSqliteCodexThreadStore(fixture.sqlite);
  for (let index = 0; index <= NATIVE_MUTATION_RECEIPT_LIMIT; index += 1) {
    const requestId = `service-horizon-${index}`;
    const payloadHash = index.toString(16).padStart(64, "0");
    assert.equal(store.beginThreadStartAdmission({
      requestId,
      ownerId: "fixture-owner-1",
      payloadHash,
      expectedSelectionRevision: index,
      newestBeforeCreatedAtSeconds: null,
      newestBeforeRootThreadIds: [],
      createdAt: index,
    }).status, "started");
    assert.equal(store.completeThreadStartAdmission({
      requestId,
      ownerId: "fixture-owner-1",
      payloadHash,
      selectedThreadId: `service-horizon-thread-${index}`,
      updatedAt: index,
    }).status, "completed");
  }
  assert.equal(store.readMutationReceipt("new", "service-horizon-0"), null);
  const accepted = await fixture.service.newThread({
    requestId: "service-horizon-0",
    expectedSelectionRevision: NATIVE_MUTATION_RECEIPT_LIMIT + 1,
  });
  assert.equal(accepted.thread.id, "native-thread-1");
  assert.deepEqual(accepted.selection, {
    threadId: "native-thread-1",
    revision: NATIVE_MUTATION_RECEIPT_LIMIT + 2,
  });
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["thread/start"], 1);
});

test("selection is compare-and-set and history initializes only the virgin pointer", async (t) => {
  const { service, session } = await createFixture(t);
  const started = await session.request("thread/start", session.lockedThreadStartParams());
  assert.equal(started.thread.id, "native-thread-1");
  const listed = await service.listThreads({});
  assert.deepEqual(listed.selection, { threadId: "native-thread-1", revision: 1 });

  await assert.rejects(
    service.newThread({ requestId: "stale-new", expectedSelectionRevision: 0 }),
    (error) => error.code === "SELECTION_CONFLICT",
  );
  const cleared = await service.selectThread({
    requestId: "clear-1",
    threadId: null,
    expectedSelectionRevision: 1,
  });
  assert.deepEqual(cleared.selection, { threadId: null, revision: 2 });
  const relisted = await service.listThreads({});
  assert.deepEqual(relisted.selection, { threadId: null, revision: 2 });
});

test("virgin selection paginates past an ineligible first page to the newest eligible root", async (t) => {
  const { service } = await createFixture(t, {
    FAKE_NATIVE_DEFAULT_EPHEMERAL_FIRST_PAGE: "1",
  });
  const listed = await service.listThreads({ limit: 100 });
  assert.deepEqual(listed.threads, []);
  assert.equal(typeof listed.nextCursor, "string");
  assert.deepEqual(listed.selection, { threadId: "native-thread-1", revision: 1 });
});

test("catalogues larger than the startup cache stay available and hydrate roots and workers lazily", async (t) => {
  const { service } = await createFixture(t, {
    FAKE_NATIVE_ROOT_COUNT: "305",
    FAKE_NATIVE_LARGE_CHILD: "1",
  });
  const listed = await service.listThreads({ limit: 100 });
  assert.equal(listed.threads.length, 100);
  assert.equal(typeof listed.nextCursor, "string");
  assert.equal(listed.selection.revision, 1);

  const uncachedRoot = await service.readThread({ threadId: "native-thread-150" });
  assert.equal(uncachedRoot.thread.threadKind, "conversation");
  const selected = await service.selectThread({
    requestId: "select-uncached-root",
    threadId: "native-thread-150",
    expectedSelectionRevision: listed.selection.revision,
  });
  assert.equal(selected.selection.threadId, "native-thread-150");

  const uncachedWorker = await service.readThread({ threadId: "native-thread-306" });
  assert.equal(uncachedWorker.thread.threadKind, "worker");
  assert.equal(uncachedWorker.thread.parentThreadId, "native-thread-305");
});

test("selection commit fences a concurrent stale interrupt before app-server", async (t) => {
  const { service, session } = await createFixture(t, {
    FAKE_NATIVE_DELAY_RESUME_MS: "100",
  });
  const first = await service.newThread({ requestId: "race-new-1", expectedSelectionRevision: 0 });
  const active = await service.sendTurn({
    requestId: "race-send-1",
    threadId: first.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "race-client-1",
    message: "Keep this turn active",
  });
  const second = await service.newThread({ requestId: "race-new-2", expectedSelectionRevision: 1 });
  const selectedFirst = await service.selectThread({
    requestId: "race-select-first",
    threadId: first.thread.id,
    expectedSelectionRevision: second.selection.revision,
  });

  const selectingSecond = service.selectThread({
    requestId: "race-select-second",
    threadId: second.thread.id,
    expectedSelectionRevision: selectedFirst.selection.revision,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const staleInterrupt = service.interruptTurn({
    requestId: "race-stale-interrupt",
    threadId: first.thread.id,
    expectedSelectionRevision: selectedFirst.selection.revision,
    turnId: active.turnId,
  });
  await selectingSecond;
  await assert.rejects(staleInterrupt, (error) => error.code === "SELECTION_CONFLICT");
  const stats = await session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/interrupt"] ?? 0, 0);
});

test("selection commit fences a concurrent stale interaction answer", async (t) => {
  const { service } = await createFixture(t, { FAKE_NATIVE_DELAY_RESUME_MS: "100" });
  const first = await service.newThread({ requestId: "answer-race-new-1", expectedSelectionRevision: 0 });
  await service.sendTurn({
    requestId: "answer-race-ask",
    threadId: first.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "answer-race-client",
    message: "Please ask me",
  });
  const pending = await eventually(
    () => service.listInteractions({ threadId: first.thread.id }),
    (value) => value.interactions.some((interaction) => interaction.kind === "user_input"),
  );
  const question = pending.interactions.find((interaction) => interaction.kind === "user_input");
  const second = await service.newThread({ requestId: "answer-race-new-2", expectedSelectionRevision: 1 });
  const selectedFirst = await service.selectThread({
    requestId: "answer-race-select-first",
    threadId: first.thread.id,
    expectedSelectionRevision: second.selection.revision,
  });

  const selectingSecond = service.selectThread({
    requestId: "answer-race-select-second",
    threadId: second.thread.id,
    expectedSelectionRevision: selectedFirst.selection.revision,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const staleAnswer = service.respondInteraction({
    requestId: "answer-race-stale",
    threadId: first.thread.id,
    expectedSelectionRevision: selectedFirst.selection.revision,
    interactionId: question.id,
    response: { kind: "answers", answers: [{ questionId: "choice", answers: ["Soup"] }] },
  });
  await selectingSecond;
  await assert.rejects(staleAnswer, (error) => error.code === "SELECTION_CONFLICT");
  const stillPending = await service.listInteractions({ threadId: first.thread.id });
  assert.equal(stillPending.interactions.some((entry) => entry.id === question.id), true);
});

test("interrupt serializes before send so the later message starts instead of steering a stale turn", async (t) => {
  const { service, session } = await createFixture(t, {
    FAKE_NATIVE_DELAY_INTERRUPT_MS: "100",
  });
  const created = await service.newThread({ requestId: "send-race-new", expectedSelectionRevision: 0 });
  const active = await service.sendTurn({
    requestId: "send-race-first",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "send-race-client-1",
    message: "Start the first turn",
  });
  const interrupting = service.interruptTurn({
    requestId: "send-race-interrupt",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    turnId: active.turnId,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const sending = service.sendTurn({
    requestId: "send-race-second",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "send-race-client-2",
    message: "Start after the interruption",
  });
  await interrupting;
  const next = await sending;
  assert.notEqual(next.turnId, active.turnId);
  const stats = await session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/steer"] ?? 0, 0);
  assert.equal(stats.requestCounts["turn/start"], 2);
});

test("replay capacity protects pending work and ambiguous tombstones without starting unseen effects", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_DELAY_INTERRUPT_MS: "750",
    FAKE_NATIVE_DELAY_RESUME_MS: "300",
  }, { requestTimeoutMs: 500, replayLimit: 2 });
  const created = await fixture.service.newThread({
    requestId: "capacity-thread",
    expectedSelectionRevision: 0,
  });
  const active = await fixture.service.sendTurn({
    requestId: "capacity-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "capacity-client",
    message: "Keep this turn active",
  });
  const interruptRequest = {
    requestId: "capacity-ambiguous-interrupt",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    turnId: active.turnId,
  };
  await assert.rejects(
    fixture.service.interruptTurn(interruptRequest),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      error.cause?.code === "REQUEST_TIMEOUT",
  );

  const selectRequest = {
    requestId: "capacity-pending-select",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
  };
  const selecting = fixture.service.selectThread(selectRequest);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const selectingReplay = fixture.service.selectThread(selectRequest);
  await assert.rejects(
    fixture.service.archiveThread({
      requestId: "capacity-unseen-archive",
      threadId: created.thread.id,
      expectedSelectionRevision: created.selection.revision,
    }),
    (error) => error.code === "CODEX_UNAVAILABLE" && /replay fence is at capacity/iu.test(
      error.message,
    ),
  );
  await assert.rejects(
    fixture.service.interruptTurn(interruptRequest),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      error.cause?.code === "REQUEST_TIMEOUT",
  );
  const [selected, selectedReplay] = await Promise.all([selecting, selectingReplay]);
  assert.deepEqual(selectedReplay, selected);
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["thread/resume"], 1);
  assert.equal(stats.requestCounts["turn/interrupt"] ?? 0, 0);
  assert.equal(stats.requestCounts["thread/archive"] ?? 0, 0);
});

test("native questions and forbidden approvals share the sanitized interaction API", async (t) => {
  const { service, session } = await createFixture(t);
  const created = await service.newThread({ requestId: "new-interactions", expectedSelectionRevision: 0 });
  const turn = await service.sendTurn({
    requestId: "ask-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "ask-client",
    message: "Please ask me",
  });
  const pending = await eventually(
    () => service.listInteractions({ threadId: created.thread.id }),
    (value) => value.interactions.some((interaction) => interaction.kind === "user_input"),
  );
  const question = pending.interactions.find((interaction) => interaction.kind === "user_input");
  assert.equal(question.questions[0].question, "Which dinner should I plan?");
  assert.equal(question.questions[0].allowOther, false);
  assert.equal(question.questions[0].responseMode, "listed_option");
  await assert.rejects(
    service.respondInteraction({
      requestId: "answer-wrong-thread",
      threadId: "native-thread-other",
      expectedSelectionRevision: 1,
      interactionId: question.id,
      response: { kind: "answers", answers: [{ questionId: "choice", answers: ["Soup"] }] },
    }),
    (error) => error.code === "SELECTION_CONFLICT",
  );
  const answered = await service.respondInteraction({
    requestId: "answer-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    interactionId: question.id,
    response: { kind: "answers", answers: [{ questionId: "choice", answers: ["Tacos"] }] },
  });
  assert.equal(answered.status, "resolved");
  await assert.rejects(
    service.respondInteraction({
      requestId: "answer-late",
      threadId: created.thread.id,
      expectedSelectionRevision: 1,
      interactionId: question.id,
      response: { kind: "answers", answers: [{ questionId: "choice", answers: ["Soup"] }] },
    }),
    (error) => error.code === "INTERACTION_STALE",
  );

  const secondQuestionTurn = await service.sendTurn({
    requestId: "ask-before-interrupt",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "ask-before-interrupt-client",
    message: "Please ask me again",
  });
  const pendingBeforeInterrupt = await eventually(
    () => service.listInteractions({ threadId: created.thread.id }),
    (value) => value.interactions.some((interaction) => interaction.kind === "user_input"),
  );
  const clearedQuestion = pendingBeforeInterrupt.interactions.find(
    (interaction) => interaction.kind === "user_input",
  );
  await service.interruptTurn({
    requestId: "interrupt-pending-question",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    turnId: secondQuestionTurn.turnId,
  });
  const afterInterrupt = await service.listInteractions({ threadId: created.thread.id });
  assert.equal(afterInterrupt.interactions.some((entry) => entry.id === clearedQuestion.id), false);
  await assert.rejects(
    service.respondInteraction({
      requestId: "answer-after-native-resolution",
      threadId: created.thread.id,
      expectedSelectionRevision: 1,
      interactionId: clearedQuestion.id,
      response: { kind: "answers", answers: [{ questionId: "choice", answers: ["Soup"] }] },
    }),
    (error) => error.code === "INTERACTION_STALE",
  );

  await service.sendTurn({
    requestId: "approval-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "approval-client",
    message: "Try a command approval",
  });
  const rejected = await eventually(
    () => service.listInteractions({ threadId: created.thread.id }),
    (value) => value.interactions.some((interaction) => interaction.kind === "approval"),
  );
  const approval = rejected.interactions.find((interaction) => interaction.kind === "approval");
  assert.equal(approval.category, "command");
  assert.equal(approval.resolution, "rejected_by_policy");
  assert.equal(typeof approval.turnId, "string");
  assert.equal(typeof approval.itemId, "string");
  assert.equal("decision" in approval, false);

  await service.sendTurn({
    requestId: "approval-file-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "approval-file-client",
    message: "Try a file change approval",
  });
  const rejectedFile = await eventually(
    () => service.listInteractions({ threadId: created.thread.id }),
    (value) => value.interactions.some((interaction) =>
      interaction.kind === "approval" && interaction.category === "file_change" &&
      interaction.itemId?.startsWith("file-change-")
    ),
  );
  const fileChange = rejectedFile.interactions.find((interaction) =>
    interaction.kind === "approval" && interaction.category === "file_change" &&
    interaction.itemId?.startsWith("file-change-")
  );
  assert.equal(fileChange.resolution, "rejected_by_policy");

  await service.sendTurn({
    requestId: "approval-permission-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "approval-permission-client",
    message: "Try a permissions approval",
  });
  const rejectedPermission = await eventually(
    () => service.listInteractions({ threadId: created.thread.id }),
    (value) => value.interactions.some((interaction) =>
      interaction.kind === "approval" && interaction.category === "permission"
    ),
  );
  const permission = rejectedPermission.interactions.find((interaction) =>
    interaction.kind === "approval" && interaction.category === "permission"
  );
  assert.equal(permission.resolution, "rejected_by_policy");
  const serializedPolicyNotices = JSON.stringify([fileChange, permission]);
  for (const canary of [
    "V2-FILE-REQUEST-ID-CANARY",
    "V2-FILE-REASON-CANARY",
    "V2-FILE-PATH-CANARY",
    "PERMISSION-REQUEST-ID-CANARY",
    "PERMISSION-REASON-CANARY",
    "PERMISSION-READ-PATH-CANARY",
    "PERMISSION-WRITE-PATH-CANARY",
  ]) {
    assert.equal(serializedPolicyNotices.includes(canary), false);
  }
  assert.equal("permissions" in permission, false);
  assert.equal("reason" in permission, false);
  assert.equal("grantRoot" in fileChange, false);

  const policyStats = await eventually(
    () => session.request("thread/list", { searchTerm: "__stats__" }),
    (value) => value.serverResponses.some((response) => response.kind === "v2_file_change") &&
      value.serverResponses.some((response) => response.kind === "permissions"),
  );
  const fileResponse = policyStats.serverResponses.find((response) =>
    response.kind === "v2_file_change"
  );
  const permissionResponse = policyStats.serverResponses.find((response) =>
    response.kind === "permissions"
  );
  assert.deepEqual(fileResponse.result, { decision: "decline" });
  assert.equal(fileResponse.error, null);
  assert.equal(permissionResponse.result, null);
  assert.deepEqual(permissionResponse.error, {
    code: -32001,
    message: "The planner does not permit item/permissions/requestApproval.",
  });

  await service.sendTurn({
    requestId: "approval-mcp-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "approval-mcp-client",
    message: "Try an MCP elicitation",
  });
  const rejectedMcp = await eventually(
    () => service.listInteractions({ threadId: created.thread.id }),
    (value) => value.interactions.some((interaction) =>
      interaction.kind === "approval" && interaction.category === "mcp"
    ),
  );
  const mcp = rejectedMcp.interactions.find((interaction) =>
    interaction.kind === "approval" && interaction.category === "mcp"
  );
  assert.match(mcp.id, /^blocked_[0-9a-f-]+$/u);
  assert.equal(mcp.turnId, null);
  assert.equal(mcp.itemId, null);
  assert.equal(mcp.summary, "Codex asked to use an external connector. The planner blocked it.");
  assert.equal("decision" in mcp, false);
  assert.equal("message" in mcp, false);
  assert.equal("requestedSchema" in mcp, false);
  const stats = await eventually(
    () => session.request("thread/list", { searchTerm: "__stats__" }),
    (value) => value.serverResponses.some((response) => response.kind === "mcp_elicitation"),
  );
  const mcpResponse = stats.serverResponses.find((response) =>
    response.kind === "mcp_elicitation"
  );
  assert.deepEqual(mcpResponse.result, { action: "decline", content: null, _meta: null });
  assert.equal(mcpResponse.error, null);

  await service.sendTurn({
    requestId: "approval-legacy-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "approval-legacy-client",
    message: "Try legacy approvals",
  });
  const rejectedLegacy = await eventually(
    () => service.listInteractions({ threadId: created.thread.id }),
    (value) => value.interactions.filter((interaction) =>
      interaction.kind === "approval" &&
      (interaction.itemId?.startsWith("legacy-patch-") ||
        interaction.itemId?.startsWith("legacy-command-"))
    ).length === 2,
  );
  const legacyApprovals = rejectedLegacy.interactions.filter((interaction) =>
    interaction.kind === "approval" &&
    (interaction.itemId?.startsWith("legacy-patch-") ||
      interaction.itemId?.startsWith("legacy-command-"))
  );
  assert.deepEqual(
    legacyApprovals.map((interaction) => interaction.category).sort(),
    ["command", "file_change"],
  );
  assert.equal(legacyApprovals.every((interaction) =>
    interaction.threadId === created.thread.id && interaction.turnId === null
  ), true);
  const serializedLegacy = JSON.stringify(legacyApprovals);
  for (const canary of [
    "LEGACY-PATH-CANARY",
    "LEGACY-PATCH-DIFF-CANARY",
    "LEGACY-PATCH-REASON-CANARY",
    "LEGACY-COMMAND-CANARY",
    "LEGACY-CWD-CANARY",
    "LEGACY-COMMAND-REASON-CANARY",
    "LEGACY-PARSED-CMD-CANARY",
    "LEGACY-PARSED-NAME-CANARY",
    "LEGACY-PARSED-PATH-CANARY",
  ]) {
    assert.equal(serializedLegacy.includes(canary), false);
  }
  const legacyStats = await eventually(
    () => session.request("thread/list", { searchTerm: "__stats__" }),
    (value) => value.serverResponses.filter((response) =>
      response.kind === "legacy_apply_patch" || response.kind === "legacy_exec_command"
    ).length === 2,
  );
  const applyResponse = legacyStats.serverResponses.find((response) =>
    response.kind === "legacy_apply_patch"
  );
  const commandResponse = legacyStats.serverResponses.find((response) =>
    response.kind === "legacy_exec_command"
  );
  assert.deepEqual(applyResponse.result, { decision: "denied" });
  assert.equal(applyResponse.error, null);
  assert.deepEqual(commandResponse.result, { decision: "denied" });
  assert.equal(commandResponse.error, null);
  assert.equal(JSON.stringify([applyResponse, commandResponse]).includes("CANARY"), false);
  assert.equal(turn.threadId, created.thread.id);
});

for (const [label, environment] of [
  ["a request-resolution thread mismatch", { FAKE_NATIVE_MISMATCHED_RESOLUTION_THREAD: "1" }],
  ["a malformed request-resolution payload", { FAKE_NATIVE_MALFORMED_RESOLUTION: "1" }],
]) {
  test(`native interaction lifecycle fails closed on ${label}`, async (t) => {
    const { service } = await createFixture(t, environment);
    const created = await service.newThread({
      requestId: `new-before-${label}`,
      expectedSelectionRevision: 0,
    });
    const turn = await service.sendTurn({
      requestId: `ask-before-${label}`,
      threadId: created.thread.id,
      expectedSelectionRevision: created.selection.revision,
      clientUserMessageId: `client-before-${label}`,
      message: "Please ask me",
    });
    await eventually(
      () => service.listInteractions({ threadId: created.thread.id }),
      (value) => value.interactions.some((interaction) => interaction.kind === "user_input"),
    );
    await assert.rejects(
      service.interruptTurn({
        requestId: `interrupt-before-${label}`,
        threadId: created.thread.id,
        expectedSelectionRevision: created.selection.revision,
        turnId: turn.turnId,
      }),
      (error) => error.code === "CODEX_INCOMPATIBLE",
    );
  });
}

test("native request errors map missing threads and protocol drift without becoming outages", async (t) => {
  const { service } = await createFixture(t);
  await assert.rejects(
    service.readThread({ threadId: "missing-native-thread" }),
    (error) => error.code === "NOT_FOUND" && error.httpStatus === 404 &&
      !error.message.includes("missing-native-thread"),
  );
});

for (const drift of ["method", "schema"]) {
  test(`native ${drift} drift maps to CODEX_INCOMPATIBLE`, async (t) => {
    const { service } = await createFixture(t, { FAKE_NATIVE_LIST_DRIFT: drift });
    await assert.rejects(
      service.listThreads({}),
      (error) => error.code === "CODEX_INCOMPATIBLE" && error.httpStatus === 503,
    );
  });
}

for (const [label, nextCursor] of [
  ["an empty", ""],
  ["a whitespace-only", "   "],
  ["a NUL-containing", "cursor\0tail"],
  ["an oversized", "x".repeat(2_049)],
]) {
  test(`native list rejects ${label} next cursor`, async (t) => {
    const { service, session } = await createFixture(t);
    await service.newThread({
      requestId: "new-before-invalid-cursor",
      expectedSelectionRevision: 0,
    });
    const request = session.request.bind(session);
    session.request = async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "thread/list" && params?.searchTerm !== "__stats__") {
        return { ...result, nextCursor };
      }
      return result;
    };

    await assert.rejects(
      service.listThreads({}),
      (error) => error.code === "CODEX_INCOMPATIBLE" && error.httpStatus === 503,
    );
  });
}

for (const drift of [
  "cwd",
  "approvalPolicy",
  "approvalsReviewer",
  "permissionProfileId",
  "permissionProfileExtends",
  "sandboxType",
  "networkAccess",
  "threadSource",
]) {
  test(`native thread/start rejects ${drift} authority drift`, async (t) => {
    const { service } = await createFixture(t, {
      FAKE_NATIVE_START_POLICY_DRIFT: drift,
    });
    await assert.rejects(
      service.newThread({
        requestId: `new-policy-drift-${drift}`,
        expectedSelectionRevision: 0,
      }),
      (error) => error.code === "CODEX_INCOMPATIBLE" && error.httpStatus === 503,
    );
  });
}

test("native thread/resume authority drift fails closed before selection", async (t) => {
  const { service } = await createFixture(t, {
    FAKE_NATIVE_RESUME_POLICY_DRIFT: "networkAccess",
  });
  const created = await service.newThread({
    requestId: "new-before-resume-policy-drift",
    expectedSelectionRevision: 0,
  });
  const deselected = await service.selectThread({
    requestId: "deselect-before-resume-policy-drift",
    threadId: null,
    expectedSelectionRevision: created.selection.revision,
  });

  await assert.rejects(
    service.selectThread({
      requestId: "resume-policy-drift",
      threadId: created.thread.id,
      expectedSelectionRevision: deselected.selection.revision,
    }),
    (error) => error.code === "CODEX_INCOMPATIBLE" && error.httpStatus === 503,
  );
  const after = await service.listThreads({});
  assert.deepEqual(after.selection, deselected.selection);
});

test("native stale steer maps to TURN_CONFLICT", async (t) => {
  const { service } = await createFixture(t, { FAKE_NATIVE_STEER_CONFLICT: "1" });
  const created = await service.newThread({ requestId: "new-steer-error", expectedSelectionRevision: 0 });
  await service.sendTurn({
    requestId: "start-before-steer-error",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "start-before-steer-client",
    message: "Start a turn",
  });
  await assert.rejects(
    service.sendTurn({
      requestId: "stale-steer-error",
      threadId: created.thread.id,
      expectedSelectionRevision: 1,
      clientUserMessageId: "stale-steer-client",
      message: "Steer the stale turn",
    }),
    (error) => error.code === "TURN_CONFLICT" && error.httpStatus === 409,
  );
});

test("native stale interrupt maps to TURN_CONFLICT", async (t) => {
  const { service } = await createFixture(t, { FAKE_NATIVE_INTERRUPT_CONFLICT: "1" });
  const created = await service.newThread({
    requestId: "new-interrupt-error",
    expectedSelectionRevision: 0,
  });
  const turn = await service.sendTurn({
    requestId: "start-before-interrupt-error",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "start-before-interrupt-client",
    message: "Start a turn",
  });
  await assert.rejects(
    service.interruptTurn({
      requestId: "stale-interrupt-error",
      threadId: created.thread.id,
      expectedSelectionRevision: 1,
      turnId: turn.turnId,
    }),
    (error) => error.code === "TURN_CONFLICT" && error.httpStatus === 409,
  );
});

test("native process failure maps to CODEX_UNAVAILABLE", async (t) => {
  const { service } = await createFixture(t);
  await assert.rejects(
    service.readThread({ threadId: "crash" }),
    (error) => error.code === "CODEX_UNAVAILABLE" && error.httpStatus === 503,
  );
});

test("native timeout remains distinguishable while mapping publicly to CODEX_UNAVAILABLE", async (t) => {
  const { service } = await createFixture(t, {}, { requestTimeoutMs: 500 });
  await assert.rejects(
    service.readThread({ threadId: "never" }),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      error.cause?.code === "REQUEST_TIMEOUT",
  );
});

test("a foreign live service cannot reconcile or duplicate an owned thread creation", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_DELAY_BEFORE_THREAD_START_MS: "300",
  });
  const request = { requestId: "owned-overlap-new", expectedSelectionRevision: 0 };
  const ownerAttempt = fixture.service.newThread(request);
  await eventually(
    () => fixture.sqlite.database.prepare(
      "SELECT owner_id FROM codex_thread_start_admission WHERE id = 'planner'",
    ).get(),
    (row) => row?.owner_id === "fixture-owner-1",
  );

  const sibling = fixture.openSibling("foreign-live-owner");
  await assert.rejects(
    sibling.service.newThread(request),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      /another live planner runtime/iu.test(error.message),
  );
  const created = await ownerAttempt;
  assert.equal(created.thread.id, "native-thread-1");
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["thread/start"], 1);
  const siblingStats = await sibling.session.request(
    "thread/list",
    { searchTerm: "__stats__" },
  );
  assert.equal(siblingStats.requestCounts["thread/start"] ?? 0, 0);
  const history = await fixture.service.listThreads({});
  assert.deepEqual(history.threads.map((thread) => thread.id), ["native-thread-1"]);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_thread_start_admission",
  ).get().count, 0);
});

test("a foreign live service cannot clear or duplicate an owned turn admission", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_DELAY_BEFORE_TURN_START_MS: "300",
  });
  const created = await fixture.service.newThread({
    requestId: "owned-overlap-thread",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "owned-overlap-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "owned-overlap-client",
    message: "Write this message only once",
  };
  const ownerAttempt = fixture.service.sendTurn(request);
  await eventually(
    () => fixture.sqlite.database.prepare(
      "SELECT owner_id FROM codex_turn_admissions WHERE request_id = ?",
    ).get(request.requestId),
    (row) => row?.owner_id === "fixture-owner-1",
  );

  const sibling = fixture.openSibling("foreign-live-owner");
  await assert.rejects(
    sibling.service.sendTurn(request),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      /another live planner runtime/iu.test(error.message),
  );
  const sent = await ownerAttempt;
  assert.equal(sent.turnId, "native-turn-1");
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"], 1);
  const siblingStats = await sibling.session.request(
    "thread/list",
    { searchTerm: "__stats__" },
  );
  assert.equal(siblingStats.requestCounts["turn/start"] ?? 0, 0);
  const read = await fixture.service.readThread({ threadId: created.thread.id });
  assert.equal(read.thread.turns.flatMap((turn) => turn.items).filter((item) =>
    item.kind === "message" && item.clientUserMessageId === request.clientUserMessageId
  ).length, 1);
});

test("thread begin observes a winner receipt committed after its stale read and sends no second RPC", async (t) => {
  let winnerThreadId = null;
  let injected = false;
  const fixture = await createFixture(t, {}, {
    decorateStore(baseStore) {
      let hideReceiptOnce = true;
      return new Proxy(baseStore, {
        get(target, property) {
          if (property === "readMutationReceipt") {
            return (scope, requestId) => {
              if (scope === "new" && requestId === "receipt-window-new" && hideReceiptOnce) {
                hideReceiptOnce = false;
                return null;
              }
              return target.readMutationReceipt(scope, requestId);
            };
          }
          if (property === "beginThreadStartAdmission") {
            return (admission) => {
              if (admission.requestId === "receipt-window-new" && !injected) {
                injected = true;
                const winner = { ...admission, ownerId: "receipt-window-winner" };
                assert.equal(target.beginThreadStartAdmission(winner).status, "started");
                assert.equal(target.completeThreadStartAdmission({
                  requestId: winner.requestId,
                  ownerId: winner.ownerId,
                  payloadHash: winner.payloadHash,
                  selectedThreadId: winnerThreadId,
                  updatedAt: 1_000,
                }).status, "completed");
              }
              return target.beginThreadStartAdmission(admission);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  const winner = await fixture.session.request(
    "thread/start",
    fixture.session.lockedThreadStartParams(),
  );
  winnerThreadId = winner.thread.id;
  const reconciled = await fixture.service.newThread({
    requestId: "receipt-window-new",
    expectedSelectionRevision: 0,
  });
  assert.equal(reconciled.thread.id, winnerThreadId);
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["thread/start"], 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_thread_start_admission",
  ).get().count, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = 'receipt-window-new'",
  ).get().count, 1);
});

test("turn begin observes a winner receipt committed after its stale read and sends no second RPC", async (t) => {
  let winnerTurnId = null;
  let injected = false;
  const fixture = await createFixture(t, {}, {
    decorateStore(baseStore) {
      let hideReceiptOnce = true;
      return new Proxy(baseStore, {
        get(target, property) {
          if (property === "readMutationReceipt") {
            return (scope, requestId) => {
              if (scope === "send" && requestId === "receipt-window-send" && hideReceiptOnce) {
                hideReceiptOnce = false;
                return null;
              }
              return target.readMutationReceipt(scope, requestId);
            };
          }
          if (property === "beginTurnAdmission") {
            return (admission) => {
              if (admission.requestId === "receipt-window-send" && !injected) {
                injected = true;
                const winner = { ...admission, ownerId: "receipt-window-winner" };
                assert.equal(target.beginTurnAdmission(winner).status, "started");
                assert.equal(target.completeTurnAdmission({
                  threadId: winner.threadId,
                  requestId: winner.requestId,
                  ownerId: winner.ownerId,
                  payloadHash: winner.payloadHash,
                  turnId: winnerTurnId,
                  completedAt: 1_000,
                }).status, "completed");
              }
              return target.beginTurnAdmission(admission);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  const created = await fixture.service.newThread({
    requestId: "receipt-window-thread",
    expectedSelectionRevision: 0,
  });
  const active = await fixture.service.sendTurn({
    requestId: "receipt-window-active",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "receipt-window-active-client",
    message: "Start an active turn",
  });
  winnerTurnId = active.turnId;
  const reconciled = await fixture.service.sendTurn({
    requestId: "receipt-window-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "receipt-window-client",
    message: "A winner already settled this operation",
  });
  assert.equal(reconciled.turnId, winnerTurnId);
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"], 1);
  assert.equal(stats.requestCounts["turn/steer"] ?? 0, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = 'receipt-window-send'",
  ).get().count, 1);
});

test("a completed client message remains unreceipted while its durable history projection is absent", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_OMIT_TURN_START_HISTORY: "1",
  }, { turnHistoryConvergenceWaitMs: 25 });
  const created = await fixture.service.newThread({
    requestId: "history-proof-thread",
    expectedSelectionRevision: 0,
  });
  const request = {
    requestId: "history-proof-send",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "history-proof-client",
    message: "Accept before the history projection converges",
  };
  await assert.rejects(
    fixture.service.sendTurn(request),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      /authoritative history/iu.test(error.message),
  );
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'send'",
  ).get().count, 0);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  await assert.rejects(
    fixture.service.sendTurn(request),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      /authoritative history/iu.test(error.message),
  );
  const stats = await fixture.session.request("thread/list", { searchTerm: "__stats__" });
  assert.equal(stats.requestCounts["turn/start"], 1);
  assert.ok(stats.requestCounts["thread/read"] >= 2);
});

test("duplicate authoritative client-message mappings fail reconciliation closed", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_DUPLICATE_CLIENT_MESSAGE: "1",
    FAKE_NATIVE_DELAY_TURN_START_MS: "750",
  }, { requestTimeoutMs: 500 });
  const created = await fixture.service.newThread({
    requestId: "duplicate-history-thread",
    expectedSelectionRevision: 0,
  });
  await assert.rejects(
    fixture.service.sendTurn({
      requestId: "duplicate-history-send",
      threadId: created.thread.id,
      expectedSelectionRevision: created.selection.revision,
      clientUserMessageId: "duplicate-history-client",
      message: "Duplicate this fixture identity",
    }),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      error.cause?.code === "REQUEST_TIMEOUT",
  );
  const reopened = await fixture.reopen();
  await assert.rejects(
    reopened.service.readThread({ threadId: created.thread.id }),
    (error) => error.code === "CODEX_INCOMPATIBLE" &&
      /uniquely match/iu.test(error.message),
  );
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'send'",
  ).get().count, 0);
});

test("steer result identity must equal the admitted active turn before receipt completion", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_STEER_RESULT_MISMATCH: "1",
  });
  const created = await fixture.service.newThread({
    requestId: "steer-result-thread",
    expectedSelectionRevision: 0,
  });
  const active = await fixture.service.sendTurn({
    requestId: "steer-result-start",
    threadId: created.thread.id,
    expectedSelectionRevision: created.selection.revision,
    clientUserMessageId: "steer-result-start-client",
    message: "Start the active turn",
  });
  await assert.rejects(
    fixture.service.sendTurn({
      requestId: "steer-result-send",
      threadId: created.thread.id,
      expectedSelectionRevision: created.selection.revision,
      clientUserMessageId: "steer-result-client",
      message: "Append with mismatched result",
    }),
    (error) => error.code === "CODEX_INCOMPATIBLE" &&
      /different active turn/iu.test(error.message),
  );
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE request_id = 'steer-result-send'",
  ).get().count, 0);
  await fixture.service.readThread({ threadId: created.thread.id });
  const receipt = fixture.sqlite.database.prepare(
    "SELECT turn_id FROM codex_native_mutation_receipts WHERE request_id = 'steer-result-send'",
  ).get();
  assert.equal(receipt.turn_id, active.turnId);
});

test("timed-out thread creation reconciles from durable native history without duplication", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_DELAY_THREAD_START_MS: "750",
  }, { requestTimeoutMs: 500 });
  const request = { requestId: "uncertain-new", expectedSelectionRevision: 0 };
  const firstAttempts = await Promise.allSettled([
    fixture.service.newThread(request),
    fixture.service.newThread(request),
  ]);
  assert.equal(firstAttempts.every((attempt) =>
    attempt.status === "rejected" && attempt.reason.code === "CODEX_UNAVAILABLE" &&
    attempt.reason.cause?.code === "REQUEST_TIMEOUT"
  ), true);
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_thread_start_admission",
  ).get().count, 1);

  const reopened = await fixture.reopen();
  await assert.rejects(
    reopened.service.newThread({ ...request, expectedSelectionRevision: 1 }),
    (error) => error.code === "REQUEST_ID_REUSE",
  );
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_thread_start_admission",
  ).get().count, 1);
  const listed = await reopened.service.listThreads({});
  assert.deepEqual(listed.threads.map((thread) => thread.id), ["native-thread-1"]);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_thread_start_admission",
  ).get().count, 0);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'new'",
  ).get().count, 1);
  const [reconciled, concurrentReplay] = await Promise.all([
    reopened.service.newThread(request),
    reopened.service.newThread(request),
  ]);
  assert.deepEqual(concurrentReplay, reconciled);
  assert.equal(reconciled.thread.id, "native-thread-1");
  assert.deepEqual(reconciled.selection, { threadId: "native-thread-1", revision: 1 });
  await assert.rejects(
    reopened.service.newThread({ ...request, expectedSelectionRevision: 1 }),
    (error) => error.code === "REQUEST_ID_REUSE",
  );
});

test("timed-out turn start reconciles its durable client message after app-server restart", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_DELAY_TURN_START_MS: "750",
  }, { requestTimeoutMs: 500 });
  const created = await fixture.service.newThread({ requestId: "uncertain-turn-new", expectedSelectionRevision: 0 });
  const message = {
    requestId: "uncertain-turn-send",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "uncertain-turn-client",
    message: "Persist this message once",
  };
  await assert.rejects(
    fixture.service.sendTurn(message),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      error.cause?.code === "REQUEST_TIMEOUT",
  );
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);

  const reopened = await fixture.reopen();
  await assert.rejects(
    reopened.service.sendTurn({ ...message, message: "Changed before reconciliation" }),
    (error) => error.code === "REQUEST_ID_REUSE",
  );
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  const read = await reopened.service.readThread({ threadId: created.thread.id });
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts WHERE scope = 'send'",
  ).get().count, 1);
  const [recovered, concurrentReplay] = await Promise.all([
    reopened.service.sendTurn(message),
    reopened.service.sendTurn(message),
  ]);
  assert.deepEqual(concurrentReplay, recovered);
  assert.equal(recovered.turnId, "native-turn-1");
  const matching = read.thread.turns.flatMap((turn) => turn.items).filter((item) =>
    item.kind === "message" && item.clientUserMessageId === message.clientUserMessageId
  );
  assert.equal(matching.length, 1);
  await assert.rejects(
    reopened.service.sendTurn({ ...message, message: "Changed after durable recovery" }),
    (error) => error.code === "REQUEST_ID_REUSE",
  );
});

test("timed-out steer reconciles the existing turn item instead of steering twice", async (t) => {
  const fixture = await createFixture(t, {
    FAKE_NATIVE_DELAY_TURN_STEER_MS: "750",
  }, { requestTimeoutMs: 500 });
  const created = await fixture.service.newThread({ requestId: "uncertain-steer-new", expectedSelectionRevision: 0 });
  const first = await fixture.service.sendTurn({
    requestId: "uncertain-steer-first",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "uncertain-steer-client-1",
    message: "Start the active turn",
  });
  const message = {
    requestId: "uncertain-steer-send",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "uncertain-steer-client-2",
    message: "Append this exactly once",
  };
  await assert.rejects(
    fixture.service.sendTurn(message),
    (error) => error.code === "CODEX_UNAVAILABLE" &&
      error.cause?.code === "REQUEST_TIMEOUT",
  );
  assert.equal(fixture.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 1);
  const reopened = await fixture.reopen();
  await assert.rejects(
    reopened.service.sendTurn({ ...message, message: "Changed steer before recovery" }),
    (error) => error.code === "REQUEST_ID_REUSE",
  );
  const read = await reopened.service.readThread({ threadId: created.thread.id });
  const [recovered, concurrentReplay] = await Promise.all([
    reopened.service.sendTurn(message),
    reopened.service.sendTurn(message),
  ]);
  assert.deepEqual(concurrentReplay, recovered);
  assert.equal(recovered.turnId, first.turnId);
  const matching = read.thread.turns.flatMap((turn) => turn.items).filter((item) =>
    item.kind === "message" && item.clientUserMessageId === message.clientUserMessageId
  );
  assert.equal(matching.length, 1);
  assert.equal(reopened.sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_turn_admissions",
  ).get().count, 0);
  await assert.rejects(
    reopened.service.sendTurn({ ...message, message: "Changed steer after recovery" }),
    (error) => error.code === "REQUEST_ID_REUSE",
  );
});

test("an unavailable thread admission stays pending without blocking a healthy selected thread", async (t) => {
  const { service, sqlite } = await createFixture(t, {
    FAKE_NATIVE_UNAVAILABLE_THREAD_ID: "native-thread-1",
  }, { requestTimeoutMs: 500 });
  const unavailable = await service.newThread({
    requestId: "scoped-admission-new-a",
    expectedSelectionRevision: 0,
  });
  const healthy = await service.newThread({
    requestId: "scoped-admission-new-b",
    expectedSelectionRevision: unavailable.selection.revision,
  });
  const store = createSqliteCodexThreadStore(sqlite);
  assert.equal(store.beginTurnAdmission({
    threadId: unavailable.thread.id,
    requestId: "scoped-admission-pending-a",
    ownerId: "fixture-owner-1",
    payloadHash: "a".repeat(64),
    clientUserMessageId: "scoped-admission-client-a",
    operation: "start",
    expectedTurnId: null,
    createdAt: 1_000,
  }).status, "started");

  const selected = await service.selectThread({
    requestId: "scoped-admission-select-b",
    threadId: healthy.thread.id,
    expectedSelectionRevision: healthy.selection.revision,
  });
  assert.equal(selected.selection.threadId, healthy.thread.id);
  const sent = await service.sendTurn({
    requestId: "scoped-admission-send-b",
    threadId: healthy.thread.id,
    expectedSelectionRevision: selected.selection.revision,
    clientUserMessageId: "scoped-admission-client-b",
    message: "Keep the healthy conversation usable",
  });
  assert.equal(sent.threadId, healthy.thread.id);
  assert.equal(store.readTurnAdmission(unavailable.thread.id)?.requestId,
    "scoped-admission-pending-a");

  await assert.rejects(
    service.selectThread({
      requestId: "scoped-admission-select-a",
      threadId: unavailable.thread.id,
      expectedSelectionRevision: selected.selection.revision,
    }),
    (error) => error.code === "CODEX_UNAVAILABLE",
  );
  assert.equal(store.readTurnAdmission(unavailable.thread.id)?.requestId,
    "scoped-admission-pending-a");
});

test("top-level threads may call planner tools while worker callbacks fail closed", async (t) => {
  const { service, session, dispatched } = await createFixture(t);
  const created = await service.newThread({ requestId: "new-worker", expectedSelectionRevision: 0 });
  await service.sendTurn({
    requestId: "worker-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "worker-client",
    message: "worker planner read",
  });
  await eventually(() => session.isEligibleThread("native-thread-2"), Boolean);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(dispatched.length, 0);
  assert.equal(session.isEligibleThread("native-thread-2"), true);
  assert.equal(session.isEligibleRoot("native-thread-2"), false);
  const worker = await service.readThread({ threadId: "native-thread-2" });
  assert.equal(worker.thread.threadKind, "worker");
  assert.equal(worker.thread.parentThreadId, created.thread.id);
  await service.sendTurn({
    requestId: "root-tool-1",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "root-tool-client",
    message: "root planner read",
  });
  await eventually(() => dispatched, (calls) => calls.length === 1);
  assert.equal(dispatched[0].threadId, created.thread.id);
});

test("planner callbacks from a stale root turn fail before dispatch or durable reservation", async (t) => {
  const { service, session, dispatched, sqlite } = await createFixture(t);
  const created = await service.newThread({
    requestId: "new-stale-turn",
    expectedSelectionRevision: 0,
  });
  await service.sendTurn({
    requestId: "stale-turn-callback",
    threadId: created.thread.id,
    expectedSelectionRevision: 1,
    clientUserMessageId: "stale-turn-client",
    message: "stale planner read",
  });
  await eventually(
    () => session.request("thread/list", { searchTerm: "__stats__" }),
    (value) => value.serverResponses.some((response) => response.kind === "planner_tool"),
  );
  assert.equal(dispatched.length, 0);
  assert.equal(sqlite.database.prepare(
    "SELECT count(*) AS count FROM codex_native_tool_calls",
  ).get().count, 0);
});

test("event long-poll exposes revision changes, resync, and cancellation", async (t) => {
  const { service, session } = await createFixture(t);
  await service.listThreads({});
  const coordinates = session.coordinates();
  const waiting = service.waitForEvents({
    connectionEpoch: coordinates.connectionEpoch,
    afterRevision: coordinates.activityRevision,
    waitMs: 1_000,
  });
  session.mark("thread", "native-thread-1");
  const changed = await waiting;
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.reasons, ["thread"]);
  const resync = await service.waitForEvents({
    connectionEpoch: "old-epoch",
    afterRevision: 0,
    waitMs: 0,
  });
  assert.equal(resync.resyncRequired, true);

  const abort = new AbortController();
  const cancelled = service.waitForEvents({
    connectionEpoch: changed.connectionEpoch,
    afterRevision: changed.revision,
    waitMs: 1_000,
  }, { signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled, (error) => error.name === "AbortError");
});
