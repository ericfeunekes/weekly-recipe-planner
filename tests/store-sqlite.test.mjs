import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PlannerStoreError,
  openPlannerStore,
} from "../server/store/sqlite-store.ts";

function temporaryDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "weekly-recipe-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "planner.sqlite");
}

function state(lesson = "") {
  return {
    householdTimeZone: "America/Halifax",
    activeWeekId: "2026-07-06",
    weeks: [
      {
        id: "2026-07-06",
        weekStartDate: "2026-07-06",
        status: "active",
        data: {
          meals: [],
          prep: [],
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

test("opens and migrates a real file with required SQLite durability settings", (t) => {
  const filename = temporaryDatabase(t);
  const store = openPlannerStore({ filename, busyTimeoutMs: 2_345 });

  assert.deepEqual(store.readWorkspace(), { initialized: false, schemaVersion: 1 });
  assert.equal(store.checkIntegrity(), "ok");
  assert.equal(store.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(store.database.prepare("PRAGMA busy_timeout").get().timeout, 2_345);
  assert.equal(store.database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(store.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(
    store.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
    1,
  );
  store.close();

  const reopened = openPlannerStore({ filename });
  assert.deepEqual(reopened.readWorkspace(), { initialized: false, schemaVersion: 1 });
  assert.equal(reopened.checkIntegrity(), "ok");
  reopened.close();
});

test("transaction rollback removes partial workspace, event, and receipt writes", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  assert.throws(
    () =>
      store.transaction((transaction) => {
        store.insertWorkspace(transaction, state(), 10);
        store.insertReceipt(transaction, {
          operationKind: "workspace_bootstrap",
          requestId: "bootstrap-1",
          payloadHash: "hash",
          httpStatus: 200,
          decision: { status: "accepted" },
          createdAt: 10,
        });
        throw new Error("injected failure");
      }),
    /injected failure/,
  );

  assert.deepEqual(store.readWorkspace(), { initialized: false, schemaVersion: 1 });
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count,
    0,
  );
  store.close();
});

test("implements the transactional chat persistence port and fences late completion", (t) => {
  const filename = temporaryDatabase(t);
  const store = openPlannerStore({ filename });

  store.transaction((transaction) => {
    store.insertWorkspace(transaction, state(), 1);
    const user = store.insertTranscriptEntry(transaction, {
      entryId: "entry-user",
      role: "user",
      text: "Move dinner.",
      context: { view: "week", weekId: "2026-07-06" },
      turnId: "turn-1",
      occurredAt: 2,
    });
    assert.equal(user.sequence, 1);
    const turn = store.insertRunningTurn(transaction, {
      turnId: "turn-1",
      requestId: "chat-1",
      status: "running",
      userEntryId: user.entryId,
      context: { view: "week", weekId: "2026-07-06" },
      inputPlannerVersion: 0,
      replyEntryId: null,
      proposedCommand: null,
      mutationOutcome: null,
      retryOfTurnId: null,
      errorCode: null,
      errorDetail: null,
      createdAt: 2,
      startedAt: 2,
      completedAt: null,
    });
    assert.equal(turn.turnSequence, 1);
    assert.equal(store.readRunningTurn(transaction).turnId, "turn-1");
    assert.equal(store.readTurn(transaction, "turn-1").status, "running");
    assert.equal(store.readTranscriptEntry(transaction, "entry-user").text, "Move dinner.");

    store.insertReceipt(transaction, {
      operationKind: "chat_submit",
      requestId: "chat-1",
      payloadHash: "chat-hash",
      httpStatus: 202,
      decision: { status: "accepted", turnId: "turn-1" },
      createdAt: 2,
    });
    assert.equal(
      store.findReceipt(transaction, "chat_submit", "chat-1").payloadHash,
      "chat-hash",
    );

    const assistant = store.insertTranscriptEntry(transaction, {
      entryId: "entry-assistant",
      role: "assistant",
      text: "Dinner moved.",
      context: { view: "week", weekId: "2026-07-06" },
      turnId: "turn-1",
      occurredAt: 3,
    });
    assert.equal(
      store.updateTurnIfRunning(transaction, "turn-1", {
        status: "completed",
        replyEntryId: assistant.entryId,
        proposedCommand: null,
        mutationOutcome: "no_command",
        errorCode: null,
        errorDetail: null,
        completedAt: 3,
      }),
      true,
    );
    assert.equal(
      store.updateTurnIfRunning(transaction, "turn-1", {
        status: "failed",
        replyEntryId: null,
        proposedCommand: null,
        mutationOutcome: "timed_out",
        errorCode: "TIMEOUT",
        errorDetail: null,
        completedAt: 4,
      }),
      false,
    );
    assert.equal(store.incrementSyncRevision(transaction, 3), 2);
    assert.deepEqual(
      store.readTranscriptTail(transaction, 2).map((entry) => entry.entryId),
      ["entry-user", "entry-assistant"],
    );
  });
  store.close();

  const reopened = openPlannerStore({ filename });
  const workspace = reopened.readInitializedWorkspace();
  assert.equal(workspace.syncRevision, 2);
  assert.deepEqual(
    workspace.transcriptEntries.map((entry) => entry.entryId),
    ["entry-user", "entry-assistant"],
  );
  assert.equal(workspace.chatTurns[0].status, "completed");
  reopened.close();
});

test("interrupts every running turn once during startup recovery", () => {
  const store = openPlannerStore({ filename: ":memory:" });
  store.transaction((transaction) => {
    store.insertWorkspace(transaction, state(), 1);
    store.insertTranscriptEntry(transaction, {
      entryId: "entry-user",
      role: "user",
      text: "Wait for ChatGPT.",
      context: { view: "week", weekId: "2026-07-06" },
      turnId: "turn-1",
      occurredAt: 2,
    });
    store.insertRunningTurn(transaction, {
      turnId: "turn-1",
      requestId: "request-1",
      status: "running",
      userEntryId: "entry-user",
      context: { view: "week", weekId: "2026-07-06" },
      inputPlannerVersion: 0,
      replyEntryId: null,
      proposedCommand: null,
      mutationOutcome: null,
      retryOfTurnId: null,
      errorCode: null,
      errorDetail: null,
      createdAt: 2,
      startedAt: 2,
      completedAt: null,
    });
    assert.equal(store.interruptRunningTurns(transaction, 5), 1);
    assert.equal(store.interruptRunningTurns(transaction, 6), 0);
    const turn = store.readTurn(transaction, "turn-1");
    assert.equal(turn.status, "interrupted");
    assert.equal(turn.errorCode, "SERVER_RESTART");
  });
  store.close();
});

test("fails closed when a database file is corrupt", (t) => {
  const filename = temporaryDatabase(t);
  writeFileSync(filename, "not a sqlite database");
  assert.throws(
    () => openPlannerStore({ filename }),
    (error) =>
      error instanceof PlannerStoreError &&
      error.code === "STORE_CORRUPT" &&
      /SQLite|database/i.test(error.message),
  );
});
