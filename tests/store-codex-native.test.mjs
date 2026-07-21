import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createPlannerToolSuccess } from "../lib/planner-tool-contract.ts";
import {
  createSqliteCodexThreadStore,
  NATIVE_MUTATION_RECEIPT_LIMIT,
} from "../server/store/codex-thread-store.ts";
import { openPlannerStore } from "../server/store/sqlite-store.ts";

function identity(overrides = {}) {
  const threadId = overrides.threadId ?? "thread-1";
  const turnId = overrides.turnId ?? "turn-1";
  const callId = overrides.callId ?? "call-1";
  const tool = overrides.tool ?? "read";
  const argumentHash = overrides.argumentHash ?? "a".repeat(64);
  return {
    threadId,
    turnId,
    callId,
    callbackIdentityHash: overrides.callbackIdentityHash ?? "b".repeat(64),
    tool,
    argumentHash,
  };
}

function threadStartAdmission(overrides = {}) {
  return {
    requestId: overrides.requestId ?? "thread-start-1",
    ownerId: overrides.ownerId ?? "admission-owner-1",
    payloadHash: overrides.payloadHash ?? "c".repeat(64),
    expectedSelectionRevision: overrides.expectedSelectionRevision ?? 0,
    newestBeforeCreatedAtSeconds: "newestBeforeCreatedAtSeconds" in overrides
      ? overrides.newestBeforeCreatedAtSeconds
      : 20,
    newestBeforeRootThreadIds: overrides.newestBeforeRootThreadIds ?? ["thread-before-a"],
    createdAt: overrides.createdAt ?? 1_000,
  };
}

function turnAdmission(overrides = {}) {
  const operation = overrides.operation ?? "start";
  return {
    threadId: overrides.threadId ?? "thread-1",
    requestId: overrides.requestId ?? "turn-request-1",
    ownerId: overrides.ownerId ?? "admission-owner-1",
    payloadHash: overrides.payloadHash ?? "d".repeat(64),
    clientUserMessageId: overrides.clientUserMessageId ?? "client-message-1",
    operation,
    expectedTurnId: "expectedTurnId" in overrides
      ? overrides.expectedTurnId
      : operation === "steer" ? "turn-active" : null,
    createdAt: overrides.createdAt ?? 2_000,
  };
}

test("native Codex selection is durable and compare-and-set", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-codex-selection-"));
  const filename = join(directory, "planner.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  let planner = openPlannerStore({ filename });
  let store = createSqliteCodexThreadStore(planner);
  assert.deepEqual(store.readSelection(), {
    selectedThreadId: null,
    revision: 0,
    updatedAt: 0,
  });
  assert.deepEqual(store.compareAndSetSelection(0, "thread-a", 10), {
    selectedThreadId: "thread-a",
    revision: 1,
    updatedAt: 10,
  });
  assert.equal(store.compareAndSetSelection(0, "thread-b", 11), null);
  planner.close();

  planner = openPlannerStore({ filename });
  store = createSqliteCodexThreadStore(planner);
  assert.deepEqual(store.readSelection(), {
    selectedThreadId: "thread-a",
    revision: 1,
    updatedAt: 10,
  });
  assert.deepEqual(store.compareAndSetSelection(1, null, 12), {
    selectedThreadId: null,
    revision: 2,
    updatedAt: 12,
  });
  planner.close();
});

test("native mutation admissions survive a file-backed reopen with exact recovery state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-codex-admissions-"));
  const filename = join(directory, "planner.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const start = threadStartAdmission({
    newestBeforeCreatedAtSeconds: 44,
    newestBeforeRootThreadIds: ["thread-old-a", "thread-old-b"],
  });
  const firstTurn = turnAdmission();
  const secondTurn = turnAdmission({
    threadId: "thread-2",
    requestId: "turn-request-2",
    payloadHash: "e".repeat(64),
    clientUserMessageId: "client-message-2",
    operation: "steer",
    expectedTurnId: "turn-active-2",
    createdAt: 2_001,
  });

  let planner = openPlannerStore({ filename });
  let store = createSqliteCodexThreadStore(planner);
  assert.deepEqual(store.beginThreadStartAdmission(start), {
    status: "started",
    admission: start,
  });
  assert.equal(store.beginTurnAdmission(firstTurn).status, "started");
  assert.equal(store.beginTurnAdmission(secondTurn).status, "started");
  planner.close();

  planner = openPlannerStore({ filename });
  store = createSqliteCodexThreadStore(planner);
  assert.deepEqual(store.readThreadStartAdmission(), start);
  assert.deepEqual(store.readTurnAdmission(firstTurn.threadId), firstTurn);
  assert.deepEqual(store.listTurnAdmissions(), [firstTurn, secondTurn]);
  assert.equal(Object.isFrozen(store.readThreadStartAdmission()), true);
  assert.equal(
    Object.isFrozen(store.readThreadStartAdmission().newestBeforeRootThreadIds),
    true,
  );
  assert.equal(store.clearThreadStartAdmission(
    start.requestId,
    "foreign-live-owner",
    start.payloadHash,
  ), false);
  assert.deepEqual(store.adoptAdmissionsForExclusiveRecovery("recovered-owner"), {
    threadStarts: 1,
    turns: 2,
  });
  assert.equal(store.readThreadStartAdmission().ownerId, "recovered-owner");
  assert.deepEqual(
    store.listTurnAdmissions().map((admission) => admission.ownerId),
    ["recovered-owner", "recovered-owner"],
  );
  planner.close();
});

test("native mutation admission collisions distinguish replay, mismatch, and busy", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(planner);
  const start = threadStartAdmission();
  assert.equal(store.beginThreadStartAdmission(start).status, "started");
  assert.deepEqual(store.beginThreadStartAdmission({
    ...start,
    newestBeforeCreatedAtSeconds: 99,
    newestBeforeRootThreadIds: ["newer-snapshot-is-not-persisted"],
    createdAt: 9_999,
  }), {
    status: "replay",
    admission: start,
  });
  assert.equal(store.beginThreadStartAdmission({
    ...start,
    payloadHash: "e".repeat(64),
  }).status, "mismatch");
  assert.equal(store.beginThreadStartAdmission(threadStartAdmission({
    requestId: "thread-start-2",
    payloadHash: "f".repeat(64),
  })).status, "busy");
  assert.equal(store.clearThreadStartAdmission(
    start.requestId,
    start.ownerId,
    "f".repeat(64),
  ), false);
  assert.equal(store.clearThreadStartAdmission(
    start.requestId,
    start.ownerId,
    start.payloadHash,
  ), true);

  const turn = turnAdmission();
  assert.equal(store.beginTurnAdmission(turn).status, "started");
  assert.deepEqual(store.beginTurnAdmission({ ...turn, createdAt: 3_000 }), {
    status: "replay",
    admission: turn,
  });
  assert.equal(store.beginTurnAdmission({
    ...turn,
    payloadHash: "a".repeat(64),
  }).status, "mismatch");
  assert.equal(store.beginTurnAdmission(turnAdmission({
    requestId: "turn-request-2",
    payloadHash: "b".repeat(64),
  })).status, "busy");
  assert.equal(store.beginTurnAdmission(turnAdmission({
    threadId: "thread-2",
    payloadHash: "b".repeat(64),
  })).status, "mismatch");
  assert.equal(store.clearTurnAdmission(
    turn.threadId,
    turn.requestId,
    turn.ownerId,
    "a".repeat(64),
  ), false);
  assert.equal(
    store.clearTurnAdmission(
      turn.threadId,
      turn.requestId,
      turn.ownerId,
      turn.payloadHash,
    ),
    true,
  );
  assert.deepEqual(store.listTurnAdmissions(), []);
  planner.close();
});

test("admission begin atomically observes a winner receipt after a contender's stale read", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(planner);
  const threadStart = threadStartAdmission({
    requestId: "receipt-race-new",
    newestBeforeCreatedAtSeconds: null,
    newestBeforeRootThreadIds: [],
  });
  assert.equal(store.readMutationReceipt("new", threadStart.requestId), null);
  assert.equal(store.beginThreadStartAdmission(threadStart).status, "started");
  assert.equal(store.completeThreadStartAdmission({
    requestId: threadStart.requestId,
    ownerId: threadStart.ownerId,
    payloadHash: threadStart.payloadHash,
    selectedThreadId: "receipt-race-thread",
    updatedAt: 3_500,
  }).status, "completed");
  const newReceipt = store.readMutationReceipt("new", threadStart.requestId);
  assert.deepEqual(store.beginThreadStartAdmission({
    ...threadStart,
    ownerId: "stale-contender-owner",
  }), { status: "completed", receipt: newReceipt });
  assert.deepEqual(store.beginThreadStartAdmission({
    ...threadStart,
    ownerId: "stale-contender-owner",
    payloadHash: "e".repeat(64),
  }), { status: "receipt_mismatch", receipt: newReceipt });

  const turn = turnAdmission({
    threadId: "receipt-race-thread",
    requestId: "receipt-race-send",
  });
  assert.equal(store.readMutationReceipt("send", turn.requestId), null);
  assert.equal(store.beginTurnAdmission(turn).status, "started");
  assert.equal(store.completeTurnAdmission({
    threadId: turn.threadId,
    requestId: turn.requestId,
    ownerId: turn.ownerId,
    payloadHash: turn.payloadHash,
    turnId: "receipt-race-turn",
    completedAt: 3_501,
  }).status, "completed");
  const sendReceipt = store.readMutationReceipt("send", turn.requestId);
  assert.deepEqual(store.beginTurnAdmission({
    ...turn,
    ownerId: "stale-contender-owner",
  }), { status: "completed", receipt: sendReceipt });
  assert.deepEqual(store.beginTurnAdmission({
    ...turn,
    ownerId: "stale-contender-owner",
    payloadHash: "f".repeat(64),
  }), { status: "receipt_mismatch", receipt: sendReceipt });
  assert.equal(planner.database.prepare(
    `SELECT
       (SELECT count(*) FROM codex_thread_start_admission) +
       (SELECT count(*) FROM codex_turn_admissions) AS count`,
  ).get().count, 0);
  assert.throws(
    () => planner.database.prepare(
      `INSERT INTO codex_thread_start_admission
        (id, request_id, owner_id, payload_hash, expected_selection_revision,
         newest_before_created_at_seconds, newest_before_root_thread_ids_json, created_at)
       VALUES ('planner', ?, 'raw-contender', ?, 1, NULL, '[]', 1)`,
    ).run(threadStart.requestId, threadStart.payloadHash),
    /settled Codex thread-start request cannot be readmitted/u,
  );
  assert.throws(
    () => planner.database.prepare(
      `INSERT INTO codex_turn_admissions
        (thread_id, request_id, owner_id, payload_hash, client_user_message_id,
         operation, expected_turn_id, created_at)
       VALUES ('raw-thread', ?, 'raw-contender', ?, 'raw-client', 'start', NULL, 1)`,
    ).run(turn.requestId, turn.payloadHash),
    /settled Codex turn request cannot be readmitted/u,
  );
  planner.close();
});

test("thread-start completion atomically publishes selection and clears only its admission", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(planner);
  const stale = threadStartAdmission();
  store.beginThreadStartAdmission(stale);
  assert.equal(store.completeThreadStartAdmission({
    requestId: stale.requestId,
    ownerId: stale.ownerId,
    payloadHash: "e".repeat(64),
    selectedThreadId: "thread-created",
    updatedAt: 3_000,
  }).status, "mismatch");
  assert.deepEqual(store.readSelection(), {
    selectedThreadId: null,
    revision: 0,
    updatedAt: 0,
  });
  assert.deepEqual(store.compareAndSetSelection(0, "thread-external", 3_001), {
    selectedThreadId: "thread-external",
    revision: 1,
    updatedAt: 3_001,
  });
  assert.equal(store.completeThreadStartAdmission({
    requestId: stale.requestId,
    ownerId: stale.ownerId,
    payloadHash: stale.payloadHash,
    selectedThreadId: "thread-created",
    updatedAt: 3_002,
  }).status, "selection_conflict");
  assert.deepEqual(store.readThreadStartAdmission(), stale);
  assert.equal(store.clearThreadStartAdmission(
    stale.requestId,
    stale.ownerId,
    stale.payloadHash,
  ), true);

  const recoverable = threadStartAdmission({
    requestId: "thread-start-recoverable",
    payloadHash: "e".repeat(64),
    expectedSelectionRevision: 1,
    createdAt: 3_003,
  });
  store.beginThreadStartAdmission(recoverable);
  planner.database.exec(`
    CREATE TRIGGER reject_thread_start_admission_delete
    BEFORE DELETE ON codex_thread_start_admission
    BEGIN
      SELECT RAISE(ABORT, 'injected admission delete failure');
    END;
  `);
  assert.throws(
    () => store.completeThreadStartAdmission({
      requestId: recoverable.requestId,
      ownerId: recoverable.ownerId,
      payloadHash: recoverable.payloadHash,
      selectedThreadId: "thread-recovered",
      updatedAt: 3_004,
    }),
    /injected admission delete failure/u,
  );
  assert.deepEqual(store.readSelection(), {
    selectedThreadId: "thread-external",
    revision: 1,
    updatedAt: 3_001,
  });
  assert.deepEqual(store.readThreadStartAdmission(), recoverable);
  assert.equal(store.readMutationReceipt("new", recoverable.requestId), null);
  planner.database.exec("DROP TRIGGER reject_thread_start_admission_delete");

  assert.deepEqual(store.completeThreadStartAdmission({
    requestId: recoverable.requestId,
    ownerId: recoverable.ownerId,
    payloadHash: recoverable.payloadHash,
    selectedThreadId: "thread-recovered",
    updatedAt: 3_004,
  }), {
    status: "completed",
    selection: {
      selectedThreadId: "thread-recovered",
      revision: 2,
      updatedAt: 3_004,
    },
  });
  assert.equal(store.readThreadStartAdmission(), null);
  assert.deepEqual(store.readMutationReceipt("new", recoverable.requestId), {
    scope: "new",
    requestId: recoverable.requestId,
    payloadHash: recoverable.payloadHash,
    threadId: "thread-recovered",
    clientUserMessageId: null,
    turnId: null,
    selectionRevision: 2,
    completedAt: 3_004,
  });
  assert.equal(store.completeThreadStartAdmission({
    requestId: recoverable.requestId,
    ownerId: recoverable.ownerId,
    payloadHash: recoverable.payloadHash,
    selectedThreadId: "thread-recovered",
    updatedAt: 3_004,
  }).status, "missing");
  planner.close();
});

test("turn completion validates steer identity and atomically records its client message receipt", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(planner);
  const admission = turnAdmission({
    operation: "steer",
    expectedTurnId: "turn-authoritative",
  });
  assert.equal(store.beginTurnAdmission(admission).status, "started");
  assert.deepEqual(store.completeTurnAdmission({
    threadId: admission.threadId,
    requestId: admission.requestId,
    ownerId: admission.ownerId,
    payloadHash: admission.payloadHash,
    turnId: "turn-wrong",
    completedAt: 4_000,
  }), { status: "turn_mismatch", admission });
  assert.equal(store.readMutationReceipt("send", admission.requestId), null);

  planner.database.exec(`
    CREATE TRIGGER reject_turn_admission_delete
    BEFORE DELETE ON codex_turn_admissions
    BEGIN
      SELECT RAISE(ABORT, 'injected turn admission delete failure');
    END;
  `);
  assert.throws(
    () => store.completeTurnAdmission({
      threadId: admission.threadId,
      requestId: admission.requestId,
      ownerId: admission.ownerId,
      payloadHash: admission.payloadHash,
      turnId: admission.expectedTurnId,
      completedAt: 4_001,
    }),
    /injected turn admission delete failure/u,
  );
  assert.deepEqual(store.readTurnAdmission(admission.threadId), admission);
  assert.equal(store.readMutationReceipt("send", admission.requestId), null);
  planner.database.exec("DROP TRIGGER reject_turn_admission_delete");

  assert.deepEqual(store.completeTurnAdmission({
    threadId: admission.threadId,
    requestId: admission.requestId,
    ownerId: admission.ownerId,
    payloadHash: admission.payloadHash,
    turnId: admission.expectedTurnId,
    completedAt: 4_001,
  }), {
    status: "completed",
    receipt: {
      scope: "send",
      requestId: admission.requestId,
      payloadHash: admission.payloadHash,
      threadId: admission.threadId,
      clientUserMessageId: admission.clientUserMessageId,
      turnId: admission.expectedTurnId,
      selectionRevision: null,
      completedAt: 4_001,
    },
  });
  assert.equal(store.readTurnAdmission(admission.threadId), null);
  planner.close();
});

test("native mutation receipts retain an exact finite horizon and prune no active completion", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(planner);
  for (let index = 0; index <= NATIVE_MUTATION_RECEIPT_LIMIT; index += 1) {
    const admission = threadStartAdmission({
      requestId: `bounded-receipt-${index}`,
      payloadHash: index.toString(16).padStart(64, "0"),
      expectedSelectionRevision: index,
      newestBeforeCreatedAtSeconds: null,
      newestBeforeRootThreadIds: [],
      createdAt: 5_000 + index,
    });
    assert.equal(store.beginThreadStartAdmission(admission).status, "started");
    assert.equal(store.completeThreadStartAdmission({
      requestId: admission.requestId,
      ownerId: admission.ownerId,
      payloadHash: admission.payloadHash,
      selectedThreadId: `bounded-thread-${index}`,
      updatedAt: index === NATIVE_MUTATION_RECEIPT_LIMIT ? 0 : 6_000 + index,
    }).status, "completed");
  }
  assert.equal(planner.database.prepare(
    "SELECT count(*) AS count FROM codex_native_mutation_receipts",
  ).get().count, NATIVE_MUTATION_RECEIPT_LIMIT);
  assert.equal(store.readMutationReceipt("new", "bounded-receipt-0"), null);
  assert.equal(
    store.readMutationReceipt("new", `bounded-receipt-${NATIVE_MUTATION_RECEIPT_LIMIT}`)
      .threadId,
    `bounded-thread-${NATIVE_MUTATION_RECEIPT_LIMIT}`,
  );
  const afterRegressedClock = threadStartAdmission({
    requestId: `bounded-receipt-${NATIVE_MUTATION_RECEIPT_LIMIT + 1}`,
    payloadHash: "e".repeat(64),
    expectedSelectionRevision: NATIVE_MUTATION_RECEIPT_LIMIT + 1,
    newestBeforeCreatedAtSeconds: null,
    newestBeforeRootThreadIds: [],
  });
  assert.equal(store.beginThreadStartAdmission(afterRegressedClock).status, "started");
  assert.equal(store.completeThreadStartAdmission({
    requestId: afterRegressedClock.requestId,
    ownerId: afterRegressedClock.ownerId,
    payloadHash: afterRegressedClock.payloadHash,
    selectedThreadId: "bounded-thread-after-regressed-clock",
    updatedAt: 7_000,
  }).status, "completed");
  assert.equal(store.readMutationReceipt("new", "bounded-receipt-1"), null);
  assert.equal(
    store.readMutationReceipt("new", `bounded-receipt-${NATIVE_MUTATION_RECEIPT_LIMIT}`)
      .threadId,
    `bounded-thread-${NATIVE_MUTATION_RECEIPT_LIMIT}`,
  );
  const sequenceWindow = planner.database.prepare(
    `SELECT count(*) AS count, min(receipt_sequence) AS minimum,
            max(receipt_sequence) AS maximum
     FROM codex_native_mutation_receipts`,
  ).get();
  assert.equal(sequenceWindow.count, NATIVE_MUTATION_RECEIPT_LIMIT);
  assert.equal(sequenceWindow.minimum, 3);
  assert.equal(sequenceWindow.maximum, NATIVE_MUTATION_RECEIPT_LIMIT + 2);
  assert.equal(store.readThreadStartAdmission(), null);

  const outsideHorizon = threadStartAdmission({
    requestId: "bounded-receipt-0",
    payloadHash: "f".repeat(64),
    expectedSelectionRevision: NATIVE_MUTATION_RECEIPT_LIMIT + 2,
    newestBeforeCreatedAtSeconds: null,
    newestBeforeRootThreadIds: [],
  });
  assert.equal(store.beginThreadStartAdmission(outsideHorizon).status, "started");
  assert.equal(store.clearThreadStartAdmission(
    outsideHorizon.requestId,
    outsideHorizon.ownerId,
    outsideHorizon.payloadHash,
  ), true);
  planner.close();
});

test("native mutation admissions reject malformed and unbounded recovery identities", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(planner);
  assert.throws(
    () => store.beginThreadStartAdmission(threadStartAdmission({
      payloadHash: "A".repeat(64),
    })),
    /admission identity is malformed/u,
  );
  assert.throws(
    () => store.beginThreadStartAdmission(threadStartAdmission({
      newestBeforeRootThreadIds: Array.from({ length: 101 }, (_, index) => `thread-${index}`),
    })),
    /thread-start admission is malformed/u,
  );
  assert.throws(
    () => store.beginThreadStartAdmission(threadStartAdmission({
      newestBeforeRootThreadIds: ["thread-duplicate", "thread-duplicate"],
    })),
    /root snapshot is malformed/u,
  );
  assert.throws(
    () => store.beginThreadStartAdmission(threadStartAdmission({
      newestBeforeCreatedAtSeconds: null,
      newestBeforeRootThreadIds: ["thread-without-timestamp"],
    })),
    /root snapshot is inconsistent/u,
  );
  assert.throws(
    () => store.beginTurnAdmission(turnAdmission({
      operation: "start",
      expectedTurnId: "turn-unexpected",
    })),
    /turn admission is malformed/u,
  );
  assert.throws(
    () => store.beginTurnAdmission(turnAdmission({
      operation: "steer",
      expectedTurnId: null,
    })),
    /turn admission is malformed/u,
  );
  assert.throws(
    () => store.beginTurnAdmission(turnAdmission({ threadId: "x".repeat(201) })),
    /turn admission is malformed/u,
  );
  assert.throws(
    () => planner.database.prepare(
      `INSERT INTO codex_thread_start_admission
        (id, request_id, owner_id, payload_hash, expected_selection_revision,
         newest_before_created_at_seconds, newest_before_root_thread_ids_json, created_at)
       VALUES ('planner', 'raw-invalid', 'raw-owner', ?, 0, 1, '[42]', 1)`,
    ).run("a".repeat(64)),
    /invalid Codex thread-start root snapshot/u,
  );
  planner.close();
});

test("native planner call fences recover, replay, and reject changed identity", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(planner);
  const call = identity();

  const reserved = store.reservePlannerToolCall(call, 1);
  assert.equal(reserved.status, "reserved");
  assert.equal(reserved.call.sequence, 1);
  assert.equal(store.reservePlannerToolCall(call, 2).status, "recover");
  assert.equal(store.reservePlannerToolCall({
    ...call,
    argumentHash: "c".repeat(64),
    callbackIdentityHash: "d".repeat(64),
  }, 2).status, "duplicate_mismatch");

  const result = createPlannerToolSuccess(
    call.callId,
    { plannerVersion: 0, syncRevision: 0 },
    3,
    { kind: "workspace", activeWeekId: null, weeks: [] },
  );
  assert.equal(store.completePlannerToolCall({
    ...call,
    status: "succeeded",
    resultCode: "OK",
    resultEnvelope: result,
    completedAt: 3,
  }), true);
  const replay = store.reservePlannerToolCall(call, 4);
  assert.equal(replay.status, "replay");
  assert.deepEqual(replay.call.resultEnvelope, result);
  assert.equal(store.completePlannerToolCall({
    ...call,
    status: "succeeded",
    resultCode: "OK",
    resultEnvelope: result,
    completedAt: 4,
  }), false);
  planner.close();
});

test("native planner call fences enforce the per-turn call limit", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const store = createSqliteCodexThreadStore(planner);
  for (let index = 0; index < 32; index += 1) {
    const suffix = String(index).padStart(2, "0");
    assert.equal(store.reservePlannerToolCall(identity({
      callId: `call-${suffix}`,
      callbackIdentityHash: index.toString(16).padStart(64, "0"),
      argumentHash: (index + 40).toString(16).padStart(64, "0"),
    }), index + 1).status, "reserved");
  }
  assert.equal(store.reservePlannerToolCall(identity({
    callId: "call-overflow",
    callbackIdentityHash: "e".repeat(64),
    argumentHash: "f".repeat(64),
  }), 100).status, "call_limit");
  planner.close();
});

test("native Codex migration stores no messages, reasoning, search, workers, or approvals", () => {
  const planner = openPlannerStore({ filename: ":memory:" });
  const columns = planner.database.prepare(
    "SELECT name FROM pragma_table_info('codex_native_tool_calls') ORDER BY cid",
  ).all().map((row) => row.name);
  assert.deepEqual(columns, [
    "thread_id",
    "turn_id",
    "call_id",
    "callback_identity_hash",
    "sequence",
    "tool",
    "argument_hash",
    "status",
    "result_code",
    "operation_kind",
    "request_id",
    "event_id",
    "base_planner_version",
    "result_planner_version",
    "result_envelope_json",
    "created_at",
    "completed_at",
  ]);
  assert.equal(columns.some((name) => /message|reason|search|worker|approval/u.test(name)), false);
  const receiptColumns = planner.database.prepare(
    "SELECT name FROM pragma_table_info('codex_native_mutation_receipts') ORDER BY cid",
  ).all().map((row) => row.name);
  assert.deepEqual(receiptColumns, [
    "receipt_sequence",
    "scope",
    "request_id",
    "payload_hash",
    "thread_id",
    "client_user_message_id",
    "turn_id",
    "selection_revision",
    "completed_at",
  ]);
  assert.equal(
    receiptColumns.some((name) => /body|content|text|reason|search|worker|approval/u.test(name)),
    false,
  );
  planner.close();
});

test("migration 006 preserves populated v5 planner receipts exactly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "planner-codex-v5-upgrade-"));
  const filename = join(directory, "planner.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(filename);
  for (let version = 1; version <= 5; version += 1) {
    const migration = readFileSync(new URL(
      `../server/store/migrations/${String(version).padStart(3, "0")}-${[
        "initial",
        "planner-operations-and-provenance",
        "embedded-tool-lifecycle",
        "sourced-recipe-intake",
        "research-candidate-digest",
      ][version - 1]}.sql`,
      import.meta.url,
    ), "utf8");
    legacy.exec(migration);
    legacy.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(version, version);
  }
  const receipt = {
    operationKind: "planner_command",
    requestId: "existing-v5-receipt",
    payloadHash: "a".repeat(64),
    httpStatus: 200,
    decision: { status: "accepted", eventId: "event-existing", plannerVersion: 1 },
    createdAt: 50,
  };
  legacy.prepare(
    `INSERT INTO command_receipts
      (operation_kind, request_id, payload_hash, http_status, decision_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.operationKind,
    receipt.requestId,
    receipt.payloadHash,
    receipt.httpStatus,
    JSON.stringify(receipt.decision),
    receipt.createdAt,
  );
  legacy.close();

  const upgraded = openPlannerStore({ filename });
  const preserved = upgraded.readTransaction((database) =>
    upgraded.findReceipt(database, receipt.operationKind, receipt.requestId)
  );
  assert.deepEqual(preserved, receipt);
  assert.equal(upgraded.database.prepare(
    "SELECT max(version) AS version FROM schema_migrations",
  ).get().version, 9);
  assert.throws(
    () => upgraded.insertReceipt(upgraded.database, {
      ...receipt,
      payloadHash: "b".repeat(64),
    }),
    /UNIQUE constraint failed/u,
  );
  upgraded.close();
});
