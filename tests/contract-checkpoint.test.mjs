import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  PREP_DAYS_AFTER_WEEK_START,
  PREP_DAYS_BEFORE_WEEK_START,
  isIsoDate,
  isWeekId,
} from "../lib/household-contract.ts";
import { isHouseholdCommand } from "../lib/household-command-contract.ts";
import {
  API_ERROR_CODES,
  HISTORY_PAGE_LIMIT_DEFAULT,
  WORKSPACE_EVENT_TAIL_LIMIT,
  normalizePageRequest,
} from "../lib/planner-api-contract.ts";
import {
  WORKSPACE_CHAT_TURN_TAIL_LIMIT,
  WORKSPACE_TRANSCRIPT_TAIL_LIMIT,
  isPlannerChatContext,
} from "../lib/planner-chat-contract.ts";

test("contract checkpoint freezes bounded workspace and prep semantics", () => {
  assert.equal(PREP_DAYS_BEFORE_WEEK_START, 1);
  assert.equal(PREP_DAYS_AFTER_WEEK_START, 6);
  assert.equal(WORKSPACE_EVENT_TAIL_LIMIT, 50);
  assert.equal(WORKSPACE_TRANSCRIPT_TAIL_LIMIT, 50);
  assert.equal(WORKSPACE_CHAT_TURN_TAIL_LIMIT, 20);
  assert.equal(HISTORY_PAGE_LIMIT_DEFAULT, 50);
  assert.ok(API_ERROR_CODES.includes("VERSION_CONFLICT"));
  assert.ok(API_ERROR_CODES.includes("TURN_BUSY"));
  assert.ok(API_ERROR_CODES.includes("ALREADY_INITIALIZED"));
  assert.equal(isIsoDate("2026-07-10"), true);
  assert.equal(isIsoDate("Fri, Jul 10"), false);
  assert.equal(isWeekId("2026-07-06"), true);
  assert.equal(isWeekId("2026-07-07"), false);
  assert.equal(
    isPlannerChatContext({
      view: "prep",
      weekId: "2026-07-06",
      stepId: "step-1",
    }),
    false,
  );
  assert.equal(
    isPlannerChatContext({
      view: "prep",
      weekId: "2026-07-06",
      mealId: "meal-1",
      stepId: "step-1",
    }),
    true,
  );
  assert.equal(
    isPlannerChatContext({
      view: "tonight",
      weekId: "2026-07-06",
      leftoverId: "leftover-1",
    }),
    true,
  );
  assert.equal(
    isPlannerChatContext({
      view: "tonight",
      weekId: "2026-07-06",
      mealId: "meal-1",
      leftoverId: "leftover-1",
    }),
    false,
  );
  assert.equal(
    isPlannerChatContext({
      view: "tonight",
      weekId: "2026-07-06",
      stepId: "step-1",
      leftoverId: "leftover-1",
    }),
    false,
  );
  assert.equal(
    isHouseholdCommand({
      type: "setInstructionStepComplete",
      weekId: "2026-07-06",
      stepId: "step-1",
      complete: true,
    }),
    true,
  );
  assert.equal(
    isHouseholdCommand({
      type: "addGroceryItem",
      weekId: "2026-07-06",
      item: {
        section: "Produce",
        item: "Carrots",
        detail: "",
        source: "shop",
        mealIds: [],
      },
    }),
    false,
  );
  assert.deepEqual(normalizePageRequest({ beforeSequence: 40 }), {
    beforeSequence: 40,
    limit: 50,
  });
  assert.equal(normalizePageRequest({ beforeSequence: 0 }), null);
  assert.equal(normalizePageRequest({ limit: 101 }), null);
  assert.equal(
    isHouseholdCommand({
      type: "reschedulePrepReference",
      weekId: "2026-07-06",
      referenceId: "prep-1",
      prepDate: "Sun, Jul 5",
    }),
    false,
  );
  assert.equal(
    isHouseholdCommand({
      type: "addInstructionStep",
      weekId: "2026-07-06",
      mealId: "meal-1",
      position: 1,
      step: {
        inputs: [{ amount: "2 cups", ingredient: "water" }],
        instruction: "Bring the water to a boil.",
      },
    }),
    true,
  );
  assert.equal(
    isHouseholdCommand({
      type: "updateInstructionStep",
      weekId: "2026-07-06",
      stepId: "step-1",
      changes: {
        inputs: [],
        instruction: "Rest before serving.",
        timerDurationSeconds: null,
        note: "This belongs to the separate note command.",
      },
    }),
    false,
  );
  assert.equal(
    isHouseholdCommand({
      type: "pauseInstructionTimer",
      weekId: "2026-07-06",
      stepId: "step-1",
    }),
    true,
  );
  assert.equal(
    isHouseholdCommand({
      type: "setInstructionTimerRemaining",
      weekId: "2026-07-06",
      stepId: "step-1",
      remainingSeconds: 90,
    }),
    true,
  );
  assert.equal(
    isHouseholdCommand({
      type: "setInstructionTimerRemaining",
      weekId: "2026-07-06",
      stepId: "step-1",
      remainingSeconds: 0,
    }),
    false,
  );
  assert.equal(
    isHouseholdCommand({
      type: "reconcileGroceries",
      weekId: "2026-07-06",
      items: [],
    }),
    false,
  );
});

test("legacy v2 fixture matches the exact browser-owned storage envelope", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("support/fixtures/browser-v2-workspace.json", import.meta.url),
      "utf8",
    ),
  );

  assert.deepEqual(Object.keys(fixture).sort(), [
    "chatMessages",
    "data",
    "events",
  ]);
  assert.equal(fixture.version, undefined);
  assert.equal(fixture.data.prep[0].due, "Sun, Jul 5");
  assert.equal(fixture.data.meals[0].dayIndex, 0);
  assert.equal(fixture.chatMessages[0].role, "assistant");
});

test("initial SQLite migration declares the authority constraints", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const migration = readFileSync(
      new URL("../server/store/migrations/001-initial.sql", import.meta.url),
      "utf8",
    );
    database.exec(migration);

    const objects = new Set(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
        )
        .all()
        .map((row) => row.name),
    );

    for (const name of [
      "workspace",
      "command_receipts",
      "planner_events",
      "chat_turns",
      "transcript_entries",
      "schema_migrations",
      "one_running_chat_turn",
      "one_revert_per_event",
    ]) {
      assert.ok(objects.has(name), `missing schema object ${name}`);
    }

    assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);

    database.exec("BEGIN");
    database
      .prepare(
        `INSERT INTO transcript_entries
          (entry_id, role, text, context_json, turn_id, occurred_at)
         VALUES (?, 'user', ?, '{}', NULL, ?)`,
      )
      .run("entry-1", "Retry this turn", 1);
    database
      .prepare(
        `INSERT INTO chat_turns
          (turn_id, request_id, turn_sequence, status, user_entry_id,
          context_json, input_planner_version, created_at, started_at,
          completed_at)
         VALUES (?, ?, ?, 'interrupted', 'entry-1', '{}', 0, ?, ?, ?)`,
      )
      .run("turn-1", "request-1", 1, 1, 1, 2);
    database
      .prepare(
        `INSERT INTO chat_turns
          (turn_id, request_id, turn_sequence, status, user_entry_id,
           context_json, input_planner_version, retry_of_turn_id,
           created_at, started_at)
         VALUES (?, ?, ?, 'running', 'entry-1', '{}', 0, 'turn-1', ?, ?)`,
      )
      .run("turn-2", "request-2", 2, 2, 2);
    database.exec("COMMIT");

    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM chat_turns WHERE user_entry_id = ?")
        .get("entry-1").count,
      2,
    );

    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO chat_turns
            (turn_id, request_id, turn_sequence, status, user_entry_id,
             context_json, input_planner_version, created_at, started_at,
             completed_at)
           VALUES ('turn-invalid', 'request-invalid', 3, 'failed', 'entry-1',
             '{}', 0, 3, 3, 4)`,
        )
        .run(),
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO command_receipts
            (operation_kind, request_id, payload_hash, http_status,
             decision_json, created_at)
           VALUES ('unknown', 'request-invalid', 'hash', 200, '{}', 1)`,
        )
        .run(),
    );
  } finally {
    database.close();
  }
});
