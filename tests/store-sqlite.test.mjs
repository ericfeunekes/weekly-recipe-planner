import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  acquirePlannerStoreWriteReservation,
  inspectVerifiedPlannerSnapshot,
  PlannerStoreError,
  SqlitePlannerStore,
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

function createV1Database(filename) {
  const database = new DatabaseSync(filename);
  try {
    database.exec(
      readFileSync(
        new URL("../server/store/migrations/001-initial.sql", import.meta.url),
        "utf8",
      ),
    );
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1)")
      .run();
    database
      .prepare(
        `INSERT INTO workspace
          (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at)
         VALUES ('household', 1, 3, 3, ?, 1, 3)`,
      )
      .run(JSON.stringify(state("Legacy lesson")));
    database
      .prepare(
        `INSERT INTO command_receipts
          (operation_kind, request_id, payload_hash, http_status, decision_json, created_at)
         VALUES ('planner_command', 'legacy-request', 'legacy-hash', 200, ?, 1)`,
      )
      .run(JSON.stringify({ kind: "planner_decision", decision: { status: "accepted", eventId: "event-legacy", plannerVersion: 1 } }));
    database
      .prepare(
        `INSERT INTO planner_events
          (event_id, request_id, actor, command_json, base_version, result_version,
           summary, target, changes_json, before_state_json, reverts_event_id,
           chat_turn_id, occurred_at)
         VALUES ('event-legacy', 'legacy-request', 'Household', ?, 0, 1,
           'Updated the week planning lesson', '2026-07-06', ?, ?, NULL, NULL, 1)`,
      )
      .run(
        JSON.stringify({ type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Legacy lesson" }),
        JSON.stringify(["Planning lesson revised"]),
        JSON.stringify(state("")),
      );
    database
      .prepare(
        `INSERT INTO planner_events
          (event_id, request_id, actor, command_json, base_version, result_version,
           summary, target, changes_json, before_state_json, reverts_event_id,
           chat_turn_id, occurred_at)
         VALUES ('event-codex', 'legacy-codex', 'Codex', ?, 1, 2,
           'Updated the week planning lesson', '2026-07-06', ?, ?, NULL, NULL, 2)`,
      )
      .run(
        JSON.stringify({ type: "captureWeekLesson", weekId: "2026-07-06", weekLesson: "Codex lesson" }),
        JSON.stringify(["Planning lesson revised"]),
        JSON.stringify(state("Legacy lesson")),
      );
    database
      .prepare(
        `INSERT INTO planner_events
          (event_id, request_id, actor, command_json, base_version, result_version,
           summary, target, changes_json, before_state_json, reverts_event_id,
           chat_turn_id, occurred_at)
         VALUES ('event-undo', 'legacy-undo', 'Household', ?, 2, 3,
           'Undid: Updated the week planning lesson', '2026-07-06', ?, ?,
           'event-codex', NULL, 3)`,
      )
      .run(
        JSON.stringify({ type: "undoLatest", targetEventId: "event-codex" }),
        JSON.stringify(["Restored the state before: Updated the week planning lesson"]),
        JSON.stringify(state("Codex lesson")),
      );
  } finally {
    database.close();
  }
}

function createV3Database(filename) {
  const database = new DatabaseSync(filename);
  try {
    for (const version of [1, 2, 3]) {
      database.exec(readFileSync(
        new URL(`../server/store/migrations/00${version}-${[
          "initial",
          "planner-operations-and-provenance",
          "embedded-tool-lifecycle",
        ][version - 1]}.sql`, import.meta.url),
        "utf8",
      ));
      database.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(version, version);
    }
    database.prepare(
      `INSERT INTO workspace
        (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at)
       VALUES ('household', 3, 0, 1, ?, 1, 1)`,
    ).run(JSON.stringify(state()));
    database.exec("BEGIN");
    database.prepare(
      `INSERT INTO transcript_entries
        (entry_id, role, text, context_json, turn_id, occurred_at)
       VALUES ('v3-user', 'user', 'Legacy v3 request', ?, 'v3-turn', 1)`,
    ).run(JSON.stringify({ view: "week", weekId: "2026-07-06" }));
    database.prepare(
      `INSERT INTO chat_turns
        (turn_id, request_id, turn_sequence, status, user_entry_id, context_json,
         input_planner_version, reply_entry_id, proposed_command_json, mutation_outcome,
         retry_of_turn_id, error_code, error_detail, created_at, started_at, completed_at,
         mode, completion_token_hash, app_server_thread_id, app_server_turn_id,
         foreground_authority_json, accepted_effect_count, last_effect_sequence,
         recovery_of_turn_id, terminal_outcome)
       VALUES ('v3-turn', 'v3-request', 1, 'running', 'v3-user', ?, 0, NULL,
         NULL, NULL, NULL, NULL, NULL, 1, 1, NULL, 'normal', ?, NULL,
         NULL, '[]', 0, 0, NULL, NULL)`,
    ).run(
      JSON.stringify({ view: "week", weekId: "2026-07-06" }),
      "a".repeat(64),
    );
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

function createV4LegacyResearchDatabase(filename) {
  createV3Database(filename);
  const database = new DatabaseSync(filename);
  try {
    database.exec(readFileSync(
      new URL("../server/store/migrations/004-sourced-recipe-intake.sql", import.meta.url),
      "utf8",
    ));
    database.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (4, 4)",
    ).run();
    database.prepare(
      `UPDATE chat_turns
       SET status = 'interrupted', completion_token_hash = NULL,
         terminal_outcome = 'interrupted_no_effect', completed_at = 4
       WHERE turn_id = 'v3-turn'`,
    ).run();
    const context = JSON.stringify({ view: "week", weekId: "2026-07-06" });
    const legacyReference = JSON.stringify({
      schemaVersion: 1,
      candidateId: "legacy-research-candidate",
      title: "Legacy sourced soup",
      source: {
        kind: "web",
        identity: "Legacy Kitchen",
        url: "https://example.com/recipes/legacy-soup",
        retrievedAt: 4,
      },
      stepCount: 1,
    });
    database.exec("BEGIN");
    database.prepare(
      `INSERT INTO transcript_entries
        (entry_id, role, text, context_json, turn_id, occurred_at)
       VALUES ('legacy-source-user', 'user', 'Find legacy soup.', ?,
         'legacy-source-turn', 4)`,
    ).run(context);
    database.prepare(
      `INSERT INTO chat_turns
        (turn_id, request_id, turn_sequence, status, user_entry_id, context_json,
         input_planner_version, reply_entry_id, proposed_command_json, mutation_outcome,
         retry_of_turn_id, error_code, error_detail, created_at, started_at, completed_at,
         mode, completion_token_hash, app_server_thread_id, app_server_turn_id,
         foreground_authority_json, accepted_effect_count, last_effect_sequence,
         recovery_of_turn_id, terminal_outcome, research_kind, research_candidate_json)
       VALUES ('legacy-source-turn', 'legacy-source-request', 2, 'running',
         'legacy-source-user', ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, 4, 4,
         NULL, 'normal', ?, NULL, NULL, '[]', 0, 0, NULL, NULL,
         'sourced_recipe', NULL)`,
    ).run(context, "d".repeat(64));
    database.prepare(
      "UPDATE chat_turns SET research_candidate_json = ? WHERE turn_id = 'legacy-source-turn'",
    ).run(legacyReference);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

test("opens and migrates a real file with required SQLite durability settings", (t) => {
  const filename = temporaryDatabase(t);
  const store = openPlannerStore({ filename, busyTimeoutMs: 2_345 });

  assert.deepEqual(store.readWorkspace(), { initialized: false, schemaVersion: 5 });
  assert.equal(store.migrationBackupPath, null);
  assert.equal(store.checkIntegrity(), "ok");
  assert.equal(store.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(store.database.prepare("PRAGMA busy_timeout").get().timeout, 2_345);
  assert.equal(store.database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(store.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(
    store.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
    5,
  );
  store.close();

  const reopened = openPlannerStore({ filename });
  assert.deepEqual(reopened.readWorkspace(), { initialized: false, schemaVersion: 5 });
  assert.equal(reopened.checkIntegrity(), "ok");
  reopened.close();
});

test("a held write reservation captures one deterministic closed WAL image and excludes writers", (t) => {
  const filename = temporaryDatabase(t);
  const store = openPlannerStore({ filename, busyTimeoutMs: 0 });
  store.database.exec("PRAGMA wal_autocheckpoint = 0");
  store.transaction((transaction) => store.insertWorkspace(transaction, state("fenced"), 1));
  assert.equal(existsSync(`${filename}-wal`), true, "the source must exercise committed WAL data");

  const reservation = acquirePlannerStoreWriteReservation({
    filename,
    busyTimeoutMs: 0,
  });
  t.after(() => reservation.close());
  assert.throws(
    () => store.transaction(() => assert.fail("a second writer must not enter")),
    (error) => error instanceof PlannerStoreError && error.code === "BUSY",
  );

  const first = reservation.createVerifiedSnapshot(
    join(dirname(filename), "rollback-one.sqlite"),
  );
  const second = reservation.createVerifiedSnapshot(
    join(dirname(filename), "rollback-two.sqlite"),
  );
  assert.equal(first.quickCheck, "ok");
  assert.equal(first.schemaVersion, 5);
  assert.equal(first.initialized, true);
  assert.equal(first.workspaceSchemaVersion, 5);
  assert.equal(first.plannerVersion, 0);
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.sha256, second.sha256, "the unchanged reserved image is deterministic");
  assert.equal(existsSync(`${first.filename}-wal`), false);
  assert.equal(existsSync(`${first.filename}-shm`), false);
  assert.deepEqual(inspectVerifiedPlannerSnapshot(first.filename), first);

  reservation.close();
  store.transaction((transaction) => {
    assert.equal(store.incrementSyncRevision(transaction, 2), 2);
  });
  const snapshot = new DatabaseSync(first.filename, { readOnly: true });
  try {
    assert.equal(
      snapshot.prepare("SELECT sync_revision FROM workspace WHERE id = 'household'").get()
        .sync_revision,
      1,
      "later source writes cannot alter the closed rollback image",
    );
  } finally {
    snapshot.close();
  }
  store.close();
});

test("snapshot inspection records an older schema without applying product migrations", (t) => {
  const filename = temporaryDatabase(t);
  createV1Database(filename);

  const inspection = inspectVerifiedPlannerSnapshot(filename);
  assert.equal(inspection.quickCheck, "ok");
  assert.equal(inspection.schemaVersion, 1);
  assert.equal(inspection.initialized, true);
  assert.equal(inspection.workspaceSchemaVersion, 1);
  assert.equal(inspection.plannerVersion, 3);

  const unchanged = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(
      unchanged.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
      1,
    );
    assert.equal(unchanged.prepare("SELECT schema_version FROM workspace").get().schema_version, 1);
  } finally {
    unchanged.close();
  }
});

test("backs up and upgrades a populated v1 file before modification", (t) => {
  const filename = temporaryDatabase(t);
  createV1Database(filename);

  const store = openPlannerStore({ filename });
  assert.ok(store.migrationBackupPath);
  assert.equal(existsSync(store.migrationBackupPath), true);
  assert.equal(store.readWorkspace().schemaVersion, 5);
  const events = store.readWorkspace().events;
  assert.deepEqual(events.find((event) => event.eventId === "event-legacy").provenance, {
    actorClass: "household",
    actorSource: "browser",
    admission: "same_origin_http_v1",
  });
  assert.deepEqual(events.find((event) => event.eventId === "event-codex").provenance, {
    actorClass: "codex",
    actorSource: "embedded_legacy",
    admission: "structured_output_v1",
  });
  assert.equal(
    events.find((event) => event.eventId === "event-undo").revertsEventId,
    "event-codex",
  );
  assert.equal(
    store.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
    5,
  );
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE request_id = 'legacy-request'").get().count,
    1,
  );

  const backup = new DatabaseSync(store.migrationBackupPath, { readOnly: true });
  try {
    assert.equal(backup.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(backup.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 1);
    assert.equal(backup.prepare("SELECT schema_version FROM workspace").get().schema_version, 1);
  } finally {
    backup.close();
  }

  store.transaction((transaction) => {
    store.insertReceipt(transaction, {
      operationKind: "embedded_codex_apply_planner_operations_v1",
      requestId: "embedded-reserved",
      payloadHash: "hash",
      httpStatus: 422,
      decision: { status: "domain_rejected", operationIndex: 0, message: "No change" },
      createdAt: 2,
    });
    store.insertReceipt(transaction, {
      operationKind: "global_codex_apply_planner_batch_v1",
      requestId: "global-reserved",
      payloadHash: "hash",
      httpStatus: 409,
      decision: { status: "version_conflict", expectedVersion: 0, actualVersion: 1 },
      createdAt: 2,
    });
  });
  assert.throws(() =>
    store.database
      .prepare(
        `UPDATE planner_events
         SET actor_source = 'global', admission = 'same_uid_uds_v1'
         WHERE event_id = 'event-legacy'`,
      )
      .run(),
  );
  store.close();
});

test("migrations 004 and 005 back up v3 and add digest-bound compact sourced intent", (t) => {
  const filename = temporaryDatabase(t);
  createV3Database(filename);
  const store = openPlannerStore({ filename });
  assert.ok(store.migrationBackupPath);
  assert.equal(store.readWorkspace().schemaVersion, 5);
  const turn = store.readAllChatTurns()[0];
  assert.equal(turn.researchKind, "none");
  assert.equal(turn.researchCandidate, null);
  const tables = store.database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map((row) => row.name);
  assert.equal(tables.some((name) => /candidate|recipe/i.test(name)), false);
  const columns = store.database.prepare("PRAGMA table_info(chat_turns)").all()
    .map((row) => row.name);
  assert.equal(columns.includes("research_kind"), true);
  assert.equal(columns.includes("research_candidate_json"), true);
  assert.equal(columns.some((name) => /full.*candidate|candidate.*full/i.test(name)), false);
  const backup = new DatabaseSync(store.migrationBackupPath, { readOnly: true });
  try {
    assert.equal(backup.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get().version, 3);
  } finally {
    backup.close();
  }
  store.close();
  const reopened = openPlannerStore({ filename });
  assert.equal(reopened.readWorkspace().schemaVersion, 5);
  assert.equal(reopened.readAllChatTurns()[0].researchKind, "none");
  assert.equal(reopened.readAllChatTurns()[0].researchCandidate, null);
  assert.equal(reopened.migrationBackupPath, null, "reopen must not rerun the v3 migration");
  reopened.checkIntegrity();
  reopened.close();
});

test("migration 005 preserves legacy references for audit but only digest-bound rows authorize", (t) => {
  const filename = temporaryDatabase(t);
  createV4LegacyResearchDatabase(filename);
  const store = openPlannerStore({ filename });
  assert.equal(store.readWorkspace().schemaVersion, 5);
  assert.ok(store.migrationBackupPath);
  const backup = new DatabaseSync(store.migrationBackupPath, { readOnly: true });
  try {
    assert.equal(backup.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get().version, 4);
  } finally {
    backup.close();
  }

  const legacy = store.readAllChatTurns().find((turn) =>
    turn.turnId === "legacy-source-turn"
  );
  assert.ok(legacy);
  assert.equal(legacy.status, "running");
  assert.equal(legacy.researchKind, "sourced_recipe");
  assert.equal(legacy.researchCandidate.candidateId, "legacy-research-candidate");
  assert.equal(Object.hasOwn(legacy.researchCandidate, "replacementDigest"), false);
  assert.equal(store.transaction((transaction) => store.bindEmbeddedTurn(
    transaction,
    legacy.turnId,
    "d".repeat(64),
    "legacy-thread",
    "legacy-turn",
  )), false, "a digestless reference cannot regain planner-session authority");
  assert.throws(
    () => store.transaction((transaction) => store.attachResearchCandidate(
      transaction,
      legacy.turnId,
      "d".repeat(64),
      legacy.researchCandidate,
    )),
    /not digest-bound/i,
  );
  store.transaction((transaction) => {
    assert.equal(store.interruptRunningTurns(transaction, 5), 1);
  });

  const context = { view: "week", weekId: "2026-07-06" };
  const token = "e".repeat(64);
  store.transaction((transaction) => {
    store.insertTranscriptEntry(transaction, {
      entryId: "v5-source-user",
      role: "user",
      text: "Find a new soup.",
      context,
      turnId: "v5-source-turn",
      occurredAt: 5,
    });
    store.insertRunningTurn(transaction, {
      turnId: "v5-source-turn", requestId: "v5-source-request", status: "running",
      userEntryId: "v5-source-user", context, inputPlannerVersion: 0,
      replyEntryId: null, proposedCommand: null, mutationOutcome: null,
      retryOfTurnId: null, mode: "normal", researchKind: "sourced_recipe",
      researchCandidate: null, completionTokenHash: token,
      appServerThreadId: null, appServerTurnId: null, foregroundAuthority: [],
      acceptedEffectCount: 0, lastEffectSequence: 0, recoveryOfTurnId: null,
      terminalOutcome: null, errorCode: null, errorDetail: null,
      createdAt: 5, startedAt: 5, completedAt: null,
    });
  });
  assert.throws(() => store.database.prepare(
    "UPDATE chat_turns SET research_candidate_json = ? WHERE turn_id = 'v5-source-turn'",
  ).run(JSON.stringify(legacy.researchCandidate)), /replacement digest/i);

  const boundReference = {
    ...legacy.researchCandidate,
    candidateId: "v5-research-candidate",
    digestVersion: 1,
    replacementDigest: "a".repeat(64),
  };
  store.transaction((transaction) => {
    assert.equal(store.attachResearchCandidate(
      transaction, "v5-source-turn", token, boundReference,
    ), true);
    assert.equal(store.bindEmbeddedTurn(
      transaction, "v5-source-turn", token, "v5-thread", "v5-turn",
    ), true);
  });
  store.checkIntegrity();
  store.close();

  const reopened = openPlannerStore({ filename });
  assert.equal(reopened.migrationBackupPath, null);
  const persistedLegacy = reopened.readAllChatTurns().find((turn) =>
    turn.turnId === "legacy-source-turn"
  );
  assert.equal(Object.hasOwn(persistedLegacy.researchCandidate, "replacementDigest"), false);
  const persistedBound = reopened.readAllChatTurns().find((turn) =>
    turn.turnId === "v5-source-turn"
  );
  assert.equal(persistedBound.researchCandidate.replacementDigest, "a".repeat(64));
  reopened.close();
});

test("compact candidate attachment fences binding, replay, lifecycle, and reopen", (t) => {
  const filename = temporaryDatabase(t);
  const store = openPlannerStore({ filename });
  const token = "b".repeat(64);
  const reference = {
    schemaVersion: 1,
    candidateId: "research-candidate-1",
    title: "Sourced soup",
    source: {
      kind: "web",
      identity: "Example Kitchen",
      url: "https://example.com/recipes/soup",
      retrievedAt: 1_750_000_000_000,
    },
    stepCount: 2,
    digestVersion: 1,
    replacementDigest: "a".repeat(64),
  };
  store.transaction((transaction) => {
    store.insertWorkspace(transaction, state(), 1);
    store.insertTranscriptEntry(transaction, {
      entryId: "forged-user",
      role: "user",
      text: "Forged candidate.",
      context: { view: "week", weekId: "2026-07-06" },
      turnId: null,
      occurredAt: 1,
    });
    assert.throws(() => store.insertRunningTurn(transaction, {
      turnId: "forged-turn",
      requestId: "forged-request",
      status: "running",
      userEntryId: "forged-user",
      context: { view: "week", weekId: "2026-07-06" },
      inputPlannerVersion: 0,
      replyEntryId: null,
      proposedCommand: null,
      mutationOutcome: null,
      retryOfTurnId: null,
      mode: "normal",
      researchKind: "sourced_recipe",
      researchCandidate: reference,
      completionTokenHash: token,
      appServerThreadId: null,
      appServerTurnId: null,
      foregroundAuthority: [],
      acceptedEffectCount: 0,
      lastEffectSequence: 0,
      recoveryOfTurnId: null,
      terminalOutcome: null,
      errorCode: null,
      errorDetail: null,
      createdAt: 1,
      startedAt: 1,
      completedAt: null,
    }), /attach.*after insert/i);
    store.insertTranscriptEntry(transaction, {
      entryId: "source-user",
      role: "user",
      text: "Find soup.",
      context: { view: "week", weekId: "2026-07-06" },
      turnId: "source-turn",
      occurredAt: 2,
    });
    store.insertRunningTurn(transaction, {
      turnId: "source-turn",
      requestId: "source-request",
      status: "running",
      userEntryId: "source-user",
      context: { view: "week", weekId: "2026-07-06" },
      inputPlannerVersion: 0,
      replyEntryId: null,
      proposedCommand: null,
      mutationOutcome: null,
      retryOfTurnId: null,
      mode: "normal",
      researchKind: "sourced_recipe",
      researchCandidate: null,
      completionTokenHash: token,
      appServerThreadId: null,
      appServerTurnId: null,
      foregroundAuthority: [],
      acceptedEffectCount: 0,
      lastEffectSequence: 0,
      recoveryOfTurnId: null,
      terminalOutcome: null,
      errorCode: null,
      errorDetail: null,
      createdAt: 2,
      startedAt: 2,
      completedAt: null,
    });
    assert.throws(() => transaction.prepare(
      `INSERT INTO chat_turns
        (turn_id, request_id, turn_sequence, status, user_entry_id, context_json,
         input_planner_version, reply_entry_id, proposed_command_json, mutation_outcome,
         retry_of_turn_id, error_code, error_detail, created_at, started_at, completed_at,
         mode, completion_token_hash, app_server_thread_id, app_server_turn_id,
         foreground_authority_json, accepted_effect_count, last_effect_sequence,
         recovery_of_turn_id, terminal_outcome, research_kind, research_candidate_json)
       VALUES ('direct-forged', 'direct-forged', 99, 'running', 'source-user', ?, 0,
         NULL, NULL, NULL, NULL, NULL, NULL, 2, 2, NULL, 'normal', ?, NULL, NULL,
         '[]', 0, 0, NULL, NULL, 'sourced_recipe', ?)`,
    ).run(
      JSON.stringify({ view: "week", weekId: "2026-07-06" }),
      token,
      JSON.stringify(reference),
    ), /must attach after turn insert/i);
    assert.equal(store.bindEmbeddedTurn(
      transaction, "source-turn", token, "planner-thread", "planner-turn",
    ), false, "binding before compact attachment must fail");
    assert.equal(store.attachResearchCandidate(
      transaction, "source-turn", token, reference,
    ), true);
    assert.equal(store.attachResearchCandidate(
      transaction, "source-turn", token, reference,
    ), false, "attachment is a one-time null-to-value CAS");
    assert.equal(store.incrementSyncRevision(transaction, 3), 2);
    assert.equal(store.bindEmbeddedTurn(
      transaction, "source-turn", token, "planner-thread", "planner-turn",
    ), true);
    assert.equal(store.bindEmbeddedTurn(
      transaction, "source-turn", token, "planner-thread", "planner-turn",
    ), true, "exact binding replay remains idempotent");
    assert.equal(store.attachResearchCandidate(
      transaction, "source-turn", token, reference,
    ), false, "a bound turn cannot attach or replace candidate data");
    assert.equal(store.bindEmbeddedTurn(
      transaction, "source-turn", token, "other-thread", "planner-turn",
    ), false);
    assert.throws(() => transaction.prepare(
      "UPDATE chat_turns SET research_kind = 'none' WHERE turn_id = 'source-turn'",
    ).run(), /immutable|lifecycle/i);
  });
  store.close();

  const reopened = openPlannerStore({ filename });
  const persisted = reopened.readAllChatTurns()[0];
  assert.equal(persisted.researchKind, "sourced_recipe");
  assert.deepEqual(persisted.researchCandidate, reference);
  reopened.database.exec("DROP TRIGGER chat_turn_research_candidate_once");
  reopened.database.prepare(
    "UPDATE chat_turns SET research_candidate_json = ? WHERE turn_id = 'source-turn'",
  ).run(JSON.stringify({
    schemaVersion: 1,
    candidateId: "research-candidate-1",
    title: "Sourced soup",
    source: { kind: "web", identity: "", url: "bad", retrievedAt: 1 },
    stepCount: 2,
    digestVersion: 1,
    replacementDigest: "a".repeat(64),
  }));
  assert.throws(
    () => reopened.transaction((transaction) => reopened.bindEmbeddedTurn(
      transaction,
      "source-turn",
      token,
      "planner-thread",
      "planner-turn",
    )),
    (error) => error instanceof PlannerStoreError && error.code === "STORE_CORRUPT",
    "an exact persisted binding replay cannot trust corrupt compact JSON",
  );
  reopened.close();
});

test("corrupt compact reference fails application readiness instead of becoming authority", (t) => {
  const filename = temporaryDatabase(t);
  const store = openPlannerStore({ filename });
  const token = "c".repeat(64);
  store.transaction((transaction) => {
    store.insertWorkspace(transaction, state(), 1);
    store.insertTranscriptEntry(transaction, {
      entryId: "corrupt-user", role: "user", text: "Find soup.",
      context: { view: "week", weekId: "2026-07-06" }, turnId: "corrupt-turn",
      occurredAt: 2,
    });
    store.insertRunningTurn(transaction, {
      turnId: "corrupt-turn", requestId: "corrupt-request", status: "running",
      userEntryId: "corrupt-user", context: { view: "week", weekId: "2026-07-06" },
      inputPlannerVersion: 0, replyEntryId: null, proposedCommand: null,
      mutationOutcome: null, retryOfTurnId: null, mode: "normal",
      researchKind: "sourced_recipe", researchCandidate: null,
      completionTokenHash: token, appServerThreadId: null, appServerTurnId: null,
      foregroundAuthority: [], acceptedEffectCount: 0, lastEffectSequence: 0,
      recoveryOfTurnId: null, terminalOutcome: null, errorCode: null,
      errorDetail: null, createdAt: 2, startedAt: 2, completedAt: null,
    });
  });
  store.close();
  const database = new DatabaseSync(filename);
  database.prepare(
    "UPDATE chat_turns SET research_candidate_json = ? WHERE turn_id = 'corrupt-turn'",
  ).run(JSON.stringify({
    schemaVersion: 1,
    candidateId: "research-candidate-1",
    title: "Soup",
    source: { kind: "web", identity: "", url: "bad", retrievedAt: 1 },
    stepCount: 1,
    digestVersion: 1,
    replacementDigest: "a".repeat(64),
  }));
  const unchecked = new SqlitePlannerStore(filename, database);
  assert.throws(
    () => unchecked.transaction((transaction) => unchecked.bindEmbeddedTurn(
      transaction,
      "corrupt-turn",
      token,
      "planner-thread",
      "planner-turn",
    )),
    (error) => error instanceof PlannerStoreError && error.code === "STORE_CORRUPT",
  );
  unchecked.close();
  assert.throws(
    () => openPlannerStore({ filename }),
    (error) => error instanceof PlannerStoreError && error.code === "STORE_CORRUPT",
  );
});

test("aborts a v1 upgrade when the verified beside-database backup cannot be created", (t) => {
  const filename = temporaryDatabase(t);
  const directory = dirname(filename);
  createV1Database(filename);
  chmodSync(directory, 0o500);
  try {
    assert.throws(
      () => openPlannerStore({ filename }),
      (error) =>
        error instanceof PlannerStoreError &&
        error.code === "MIGRATION_FAILED" &&
        /backup/i.test(error.message),
    );
  } finally {
    chmodSync(directory, 0o700);
  }

  const untouched = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(untouched.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 1);
    assert.equal(untouched.prepare("SELECT schema_version FROM workspace").get().schema_version, 1);
  } finally {
    untouched.close();
  }
});

test("rejects a database newer than the supported migration manifest without modifying it", (t) => {
  const filename = temporaryDatabase(t);
  createV1Database(filename);
  const newer = new DatabaseSync(filename);
  try {
    newer.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (6, 6)").run();
  } finally {
    newer.close();
  }

  assert.throws(
    () => openPlannerStore({ filename }),
    (error) =>
      error instanceof PlannerStoreError &&
      error.code === "MIGRATION_FAILED" &&
      /newer than supported/i.test(error.message),
  );
  const unchanged = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(unchanged.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 6);
  } finally {
    unchanged.close();
  }
});

test("rolls back a conflicting partial schema while preserving its verified pre-migration backup", (t) => {
  const filename = temporaryDatabase(t);
  const partial = new DatabaseSync(filename);
  try {
    partial.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
      CREATE TABLE workspace (marker TEXT NOT NULL) STRICT;
      INSERT INTO workspace (marker) VALUES ('preserve-me');
    `);
  } finally {
    partial.close();
  }

  let failure;
  try {
    openPlannerStore({ filename });
    assert.fail("partial schema migration should fail");
  } catch (error) {
    failure = error;
  }
  assert.equal(failure instanceof PlannerStoreError, true);
  assert.equal(failure.code, "MIGRATION_FAILED");
  assert.ok(failure.migrationBackupPath);
  assert.equal(existsSync(failure.migrationBackupPath), true);
  const unchanged = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(unchanged.prepare("SELECT marker FROM workspace").get().marker, "preserve-me");
    assert.equal(unchanged.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 0);
  } finally {
    unchanged.close();
  }
  assert.equal(
    readdirSync(dirname(filename)).some((entry) => entry.includes("pre-migration-v0")),
    true,
  );
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

  assert.deepEqual(store.readWorkspace(), { initialized: false, schemaVersion: 5 });
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM command_receipts").get().count,
    0,
  );
  store.close();
});

test("implements transactional chat persistence and fences terminal writes through embedded CAS", (t) => {
  const filename = temporaryDatabase(t);
  const store = openPlannerStore({ filename });
  const completionTokenHash = "b".repeat(64);

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
      mode: "normal",
      researchKind: "none",
      researchCandidate: null,
      completionTokenHash,
      appServerThreadId: null,
      appServerTurnId: null,
      foregroundAuthority: [],
      acceptedEffectCount: 0,
      lastEffectSequence: 0,
      recoveryOfTurnId: null,
      terminalOutcome: null,
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

    assert.equal(
      store.bindEmbeddedTurn(
        transaction,
        "turn-1",
        completionTokenHash,
        "app-thread-1",
        "app-turn-1",
      ),
      true,
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
      store.terminalizeEmbeddedTurn(transaction, {
        turnId: "turn-1",
        completionTokenHash,
        appServerThreadId: "app-thread-1",
        appServerTurnId: "app-turn-1",
      }, {
        status: "completed",
        replyEntryId: assistant.entryId,
        mutationOutcome: "no_command",
        errorCode: null,
        errorDetail: null,
        terminalOutcome: "completed_no_effect",
        completedAt: 3,
      }),
      true,
    );
    assert.equal(
      store.terminalizeEmbeddedTurn(transaction, {
        turnId: "turn-1",
        completionTokenHash,
        appServerThreadId: "app-thread-1",
        appServerTurnId: "app-turn-1",
      }, {
        status: "failed",
        replyEntryId: null,
        mutationOutcome: "timed_out",
        errorCode: "TIMEOUT",
        errorDetail: null,
        terminalOutcome: "failed_no_effect",
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
  const completionTokenHash = "a".repeat(64);
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
      mode: "normal",
      researchKind: "none",
      researchCandidate: null,
      completionTokenHash,
      appServerThreadId: null,
      appServerTurnId: null,
      foregroundAuthority: [],
      acceptedEffectCount: 0,
      lastEffectSequence: 0,
      recoveryOfTurnId: null,
      terminalOutcome: null,
      errorCode: null,
      errorDetail: null,
      createdAt: 2,
      startedAt: 2,
      completedAt: null,
    });
    assert.equal(
      store.bindEmbeddedTurn(
        transaction,
        "turn-1",
        completionTokenHash,
        "app-thread-1",
        "app-turn-1",
      ),
      true,
    );
    assert.equal(
      store.bindEmbeddedTurn(
        transaction,
        "turn-1",
        completionTokenHash,
        "app-thread-1",
        "app-turn-1",
      ),
      true,
      "the exact app-server binding is idempotent",
    );
    assert.equal(
      store.bindEmbeddedTurn(
        transaction,
        "turn-1",
        completionTokenHash,
        "different-thread",
        "app-turn-1",
      ),
      false,
      "a changed app-server identity cannot replace the frozen binding",
    );
    for (const [index, callId] of ["app-call-a", "app-call-b"].entries()) {
      const reservation = store.reservePlannerToolCall(transaction, {
        turnId: "turn-1",
        toolCallId: `tool-call-${index + 1}`,
        completionTokenHash,
        appServerThreadId: "app-thread-1",
        appServerTurnId: "app-turn-1",
        appServerCallId: callId,
        callbackIdentityHash: String(index + 1).repeat(64),
        tool: "read",
        argumentHash: String(index + 3).repeat(64),
        createdAt: 3 + index,
      });
      assert.equal(reservation.status, "reserved");
    }
    assert.equal(store.interruptRunningTurns(transaction, 5), 1);
    assert.equal(store.interruptRunningTurns(transaction, 6), 0);
    const turn = store.readTurn(transaction, "turn-1");
    assert.equal(turn.status, "interrupted");
    assert.equal(turn.errorCode, "SERVER_RESTART");
    assert.equal(turn.completionTokenHash, null);
    const calls = store.readPlannerToolCalls(transaction, "turn-1");
    assert.deepEqual(calls.map((call) => call.status), ["abandoned", "abandoned"]);
    assert.deepEqual(
      calls.map((call) => call.resultEnvelope.callId),
      ["app-call-a", "app-call-b"],
      "startup abandonment keeps one immutable envelope per app-server call",
    );
    assert.deepEqual(
      calls.map((call) => call.resultEnvelope.error.code),
      ["CALL_CANCELLED", "CALL_CANCELLED"],
    );
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
