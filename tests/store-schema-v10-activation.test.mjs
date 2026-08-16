import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  migratePlannerStoreV9ToV10,
  openPlannerStore,
  PlannerStoreError,
} from "../server/store/sqlite-store.ts";
import { PLANNER_SCHEMA_MIGRATIONS } from "../server/store/schema-contract.ts";
import { isPlannerToolResultForTool } from "../lib/planner-tool-contract.ts";
import { householdDomain } from "../lib/household-domain.ts";
import { createPlannerApplicationService } from "../server/application/planner-service.ts";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "weekly-recipe-v10-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function v9State() {
  const activeWeek = {
    id: "2026-08-10",
    weekStartDate: "2026-08-10",
    status: "active",
    data: {
        meals: [{
          id: "dinner",
          date: "2026-08-10",
          slot: "dinner",
          title: "Duplicate peppers",
          subtitle: "",
          venue: "home",
          status: "planned",
          protein: "none",
          prepNote: "",
          leftoverNote: "",
          notes: "",
          ingredients: [
            { id: "pepper-one", amount: "2", ingredient: "red peppers" },
            { id: "pepper-two", amount: "2", ingredient: "red peppers" },
            {
              id: "fennel-bulb",
              source: "1½ large fennel bulbs, sliced",
              amount: "1½",
              unit: "bulb",
              ingredient: "fennel",
              qualifier: "large, sliced",
              conceptId: "scallion",
              role: "weekly_requirement",
              canonicalIngredientId: 12,
            },
          ],
          instructions: [{
            id: "step-one",
            inputs: [
              { ingredientId: "pepper-two", amount: "2", ingredient: "red peppers" },
              { ingredientId: "fennel-bulb", amount: "1½", ingredient: "fennel bulb" },
            ],
            instruction: "Slice them.",
            complete: false,
          }, {
            id: "step-two",
            inputs: [{ ingredientId: "pepper-one", amount: "2", ingredient: "red peppers" }],
            instruction: "Prepare the other peppers.",
            complete: false,
          }],
        }, {
          id: "legacy-lines",
          date: "2026-08-11",
          slot: "dinner",
          title: "Legacy ingredient lines",
          subtitle: "",
          venue: "home",
          status: "planned",
          protein: "none",
          prepNote: "",
          leftoverNote: "",
          notes: "",
          ingredients: [
            "1 bunch cilantro",
            "1 bunch cilantro",
            "1/3 cup sliced almonds",
            {
              id: "legacy-lines-output",
              source: "2 cups prepared sauce",
              amount: "2",
              unit: "cup",
              ingredient: "prepared sauce",
              qualifier: null,
              conceptId: null,
              role: "output",
              canonicalIngredientId: null,
            },
          ],
          instructions: [{
            id: "legacy-lines-step",
            inputs: [{ amount: "1/3", ingredient: "sliced almonds" }],
            instruction: "Toast the sliced almonds.",
            complete: false,
          }],
        }],
        prepSessions: [],
        groceries: [{
          id: "grocery-pepper-two",
          mealId: "dinner",
          ingredientId: "pepper-two",
          section: "Produce",
          source: "shop",
          checked: true,
        }, {
          id: "grocery-pepper-one", mealId: "dinner", ingredientId: "pepper-one",
          section: "Produce", source: "farm_box", checked: false,
        }, {
          id: "grocery-fennel", mealId: "dinner", ingredientId: "fennel-bulb",
          section: "Produce", source: "on_hand", checked: false,
        }],
        leftovers: [],
        feedback: {},
        weekLesson: "",
    },
  };
  activeWeek.data.prepSessions = [{
    id: "prep-session", prepDate: "2026-08-10", steps: [{
      id: "combined-peppers", kind: "combined",
      sources: [
        { stepId: "step-one", ingredientIds: ["pepper-two", "fennel-bulb"] },
        { stepId: "step-two", ingredientIds: ["pepper-one"] },
      ],
      instruction: "Prepare peppers and fennel together.", complete: true, needsReview: false,
    }],
  }];
  const archivedWeek = structuredClone(activeWeek);
  archivedWeek.id = "2026-08-03";
  archivedWeek.weekStartDate = "2026-08-03";
  archivedWeek.status = "archived";
  archivedWeek.data.meals[0].id = "archived-dinner";
  archivedWeek.data.meals[0].date = "2026-08-03";
  archivedWeek.data.meals[1].date = "2026-08-04";
  archivedWeek.data.meals[0].instructions[0].id = "archived-step";
  archivedWeek.data.meals[0].instructions[1].id = "archived-step-two";
  archivedWeek.data.meals[0].instructions[0].inputs[0].ingredientId = "pepper-one";
  archivedWeek.data.groceries[0].id = "archived-grocery";
  archivedWeek.data.groceries[0].mealId = "archived-dinner";
  archivedWeek.data.groceries[0].ingredientId = "pepper-one";
  archivedWeek.data.groceries[1].mealId = "archived-dinner";
  archivedWeek.data.groceries[1].ingredientId = "pepper-two";
  archivedWeek.data.groceries[2].mealId = "archived-dinner";
  archivedWeek.data.prepSessions[0].prepDate = "2026-08-03";
  archivedWeek.data.prepSessions[0].steps[0].sources[0].stepId = "archived-step";
  archivedWeek.data.prepSessions[0].steps[0].sources[0].ingredientIds = ["pepper-one", "fennel-bulb"];
  archivedWeek.data.prepSessions[0].steps[0].sources[1].stepId = "archived-step-two";
  return {
    householdTimeZone: "America/Halifax",
    activeWeekId: "2026-08-10",
    weeks: [activeWeek, archivedWeek],
  };
}

function artifactInventory(filename) {
  const directory = join(filename, "..");
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    return { name, size: statSync(path).size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  });
}

function logicalInventory(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const schema = database.prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all().map(({ type, name, sql }) => ({ type, name, sql }));
    const tables = {};
    for (const { name } of schema.filter(({ type }) => type === "table")) {
      const columns = database.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all()
        .map(({ name: column }) => column);
      tables[name] = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
        .map((row) => columns.map((column) => {
          const value = row[column];
          return Buffer.isBuffer(value) ? { blob: value.toString("hex") } : value;
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return { schema, tables };
  } finally {
    database.close();
  }
}

function householdEnvelope(state, callId) {
  return JSON.stringify({
    schemaVersion: 1, ok: true, callId, plannerVersion: 4, syncRevision: 7, serverTime: 9,
    data: { kind: "week", week: state.weeks[0] },
  });
}

function previewEnvelope(callId) {
  return JSON.stringify({
    schemaVersion: 1, ok: true, callId, plannerVersion: 4, syncRevision: 7, serverTime: 9,
    data: {
      status: "previewed",
      outcomes: [{ operationIndex: 0, summary: "Preview a recipe edit", target: "dinner", changes: [] }],
    },
  });
}

function applyEnvelope(state, callId) {
  return JSON.stringify({
    schemaVersion: 1, ok: true, callId, plannerVersion: 4, syncRevision: 7, serverTime: 9,
    data: {
      status: "accepted",
      eventId: "legacy-apply-event",
      readback: { kind: "week", week: state.weeks[0] },
    },
  });
}

function migratedService(store) {
  let id = 0;
  let now = 1_800_000_000_000;
  return createPlannerApplicationService({
    store,
    domain: householdDomain,
    seedFactory: v9State,
    transformLegacyV2: () => { throw new Error("The existing workspace must not bootstrap."); },
    clock: { now: () => now++ },
    idFactory: { createId: (prefix) => `migration-${prefix}-${++id}` },
  });
}

function createV9Store(filename, state = v9State()) {
  const database = new DatabaseSync(filename);
  try {
    for (const migration of PLANNER_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 9)) {
      database.exec(readFileSync(migration.path, "utf8"));
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, migration.version);
    }
    database.prepare(
      `INSERT INTO workspace
        (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at)
       VALUES ('household', 9, 4, 7, ?, 1, 2)`,
    ).run(JSON.stringify(state));
    database.exec("BEGIN");
    database.prepare(
      `INSERT INTO transcript_entries (entry_id, role, text, context_json, turn_id, occurred_at)
       VALUES ('v10-user', 'user', 'Persist this state.', ?, 'v10-turn', 3)`,
    ).run(JSON.stringify({ view: "week", weekId: "2026-08-10" }));
    database.prepare(
      `INSERT INTO chat_turns
        (turn_id, request_id, turn_sequence, status, user_entry_id, context_json,
         input_planner_version, reply_entry_id, proposed_command_json, mutation_outcome,
         retry_of_turn_id, error_code, error_detail, created_at, started_at, completed_at,
         mode, completion_token_hash, app_server_thread_id, app_server_turn_id,
         foreground_authority_json, accepted_effect_count, last_effect_sequence,
         recovery_of_turn_id, terminal_outcome, research_kind, research_candidate_json)
       VALUES ('v10-turn', 'v10-request', 1, 'running', 'v10-user', ?, 4, NULL, ?, NULL,
         NULL, NULL, NULL, 3, 3, NULL, 'normal', ?, 'embedded-thread', 'embedded-turn',
         '[]', 0, 0, NULL, NULL, 'none', NULL)`,
    ).run(
      JSON.stringify({ view: "week", weekId: "2026-08-10" }),
      JSON.stringify({ type: "updateMealSnapshot", weekId: "2026-08-10", mealId: "dinner" }),
      "a".repeat(64),
    );
    database.prepare(
      `INSERT INTO planner_events
        (event_id, request_id, actor, actor_source, admission, command_json, base_version,
         result_version, summary, target, changes_json, before_state_json, reverts_event_id,
         chat_turn_id, occurred_at)
       VALUES ('v10-event', 'event-request', 'Household', 'browser', 'same_origin_http_v1', ?, 3,
         4, 'Historical event', '2026-08-10', ?, ?, NULL, NULL, 4)`,
    ).run(
      JSON.stringify({ type: "updateMealSnapshot", weekId: "2026-08-10", mealId: "dinner" }),
      JSON.stringify(["historical metadata stays literal"]),
      JSON.stringify(state),
    );
    database.prepare(
      `INSERT INTO planner_tool_calls
        (turn_id, tool_call_id, app_server_thread_id, app_server_turn_id, app_server_call_id,
         callback_identity_hash, sequence, completion_token_hash, tool, argument_hash, status,
         result_code, operation_kind, request_id, event_id, base_planner_version,
         result_planner_version, effect_sequence, result_envelope_json, created_at, completed_at)
       VALUES ('v10-turn', 'embedded-read', 'embedded-thread', 'embedded-turn', 'embedded-call',
         ?, 1, ?, 'read', ?, 'succeeded', 'ok', NULL, NULL, NULL, NULL, NULL, NULL, ?, 5, 6)`,
    ).run("b".repeat(64), "c".repeat(64), "d".repeat(64), householdEnvelope(state, "embedded-call"));
    database.prepare(
      `INSERT INTO planner_tool_calls
        (turn_id, tool_call_id, app_server_thread_id, app_server_turn_id, app_server_call_id,
         callback_identity_hash, sequence, completion_token_hash, tool, argument_hash, status,
         result_code, operation_kind, request_id, event_id, base_planner_version,
         result_planner_version, effect_sequence, result_envelope_json, created_at, completed_at)
       VALUES ('v10-turn', 'embedded-preview', 'embedded-thread', 'embedded-turn', 'embedded-preview-call',
         ?, 2, ?, 'preview', ?, 'succeeded', 'ok', NULL, NULL, NULL, NULL, NULL, NULL, ?, 5, 6)`,
    ).run("p".repeat(64), "q".repeat(64), "r".repeat(64), previewEnvelope("embedded-preview-call"));
    database.prepare(
      `INSERT INTO codex_native_tool_calls
        (thread_id, turn_id, call_id, callback_identity_hash, sequence, tool, argument_hash,
         status, result_code, operation_kind, request_id, event_id, base_planner_version,
         result_planner_version, result_envelope_json, created_at, completed_at)
       VALUES ('native-thread', 'native-turn', 'native-call', ?, 1, 'read', ?, 'succeeded', 'ok',
         NULL, NULL, NULL, NULL, NULL, ?, 5, 6)`,
    ).run("e".repeat(64), "f".repeat(64), householdEnvelope(state, "native-call"));
    database.prepare(
      `INSERT INTO codex_native_tool_calls
        (thread_id, turn_id, call_id, callback_identity_hash, sequence, tool, argument_hash,
         status, result_code, operation_kind, request_id, event_id, base_planner_version,
         result_planner_version, result_envelope_json, created_at, completed_at)
       VALUES ('native-thread', 'native-turn', 'native-apply-call', ?, 2, 'apply', ?, 'succeeded', 'ok',
         NULL, NULL, NULL, NULL, NULL, ?, 5, 6)`,
    ).run("s".repeat(64), "t".repeat(64), applyEnvelope(state, "native-apply-call"));
    database.prepare(
      `INSERT INTO command_receipts
        (operation_kind, request_id, payload_hash, http_status, decision_json, created_at)
       VALUES ('planner_command', 'non-household', ?, 200, ?, 5)`,
    ).run("1".repeat(64), JSON.stringify({ unrelated: { bytes: "stay exactly here" } }));
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

test("schema-10 migration uses immutable preflight, preserves duplicate occurrence IDs, and creates a verified v9 backup", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "planner.sqlite");
  const backupFilename = join(directory, "planner.pre-v10.sqlite");
  createV9Store(filename);
  const source = new DatabaseSync(filename, { readOnly: true });
  const expected = {
    command: source.prepare("SELECT command_json FROM planner_events WHERE event_id = 'v10-event'").get().command_json,
    changes: source.prepare("SELECT changes_json FROM planner_events WHERE event_id = 'v10-event'").get().changes_json,
    receipt: source.prepare("SELECT decision_json FROM command_receipts WHERE request_id = 'non-household'").get().decision_json,
    proposed: source.prepare("SELECT proposed_command_json FROM chat_turns WHERE turn_id = 'v10-turn'").get().proposed_command_json,
  };
  source.close();

  const result = migratePlannerStoreV9ToV10({ filename, backupFilename });

  assert.equal(result.database.schemaVersion, 10);
  assert.equal(result.database.workspaceSchemaVersion, 10);
  assert.equal(result.backup.schemaVersion, 9);
  assert.deepEqual(result.migration.allowedChanges, [
    "schema_migrations:10",
    "workspace:household.schema_version,state_json,sync_revision,updated_at",
    "planner_events:before_state_json",
    "planner_tool_calls:result_envelope_json",
    "codex_native_tool_calls:result_envelope_json",
  ]);
  assert.equal(existsSync(`${backupFilename}-wal`), false);
  assert.equal(existsSync(`${backupFilename}-shm`), false);

  const beforeSecondMigration = logicalInventory(filename);
  const artifactsBeforeSecondMigration = artifactInventory(filename);
  const secondBackup = join(directory, "second.sqlite");
  const secondMigration = migratePlannerStoreV9ToV10({ filename, backupFilename: secondBackup });
  assert.equal(secondMigration.backup, null);
  assert.deepEqual(secondMigration.migration, { from: 10, to: 10, allowedChanges: [] });
  assert.equal(secondMigration.database.schemaVersion, 10);
  assert.deepEqual(logicalInventory(filename), beforeSecondMigration);
  assert.deepEqual(artifactInventory(filename), artifactsBeforeSecondMigration);
  assert.equal(existsSync(secondBackup), false);

  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const workspace = database.prepare(
      "SELECT schema_version, sync_revision, state_json FROM workspace WHERE id = 'household'",
    ).get();
    const migrated = JSON.parse(workspace.state_json);
    const [first, second, third] = migrated.weeks[0].data.meals[0].ingredients;
    assert.deepEqual([first.id, second.id, third.id], ["pepper-one", "pepper-two", "fennel-bulb"]);
    assert.deepEqual(first, {
      id: "pepper-one", source: null, amount: "2", unit: null, ingredient: "red peppers",
      qualifier: null, conceptId: null, role: "weekly_requirement", canonicalIngredientId: null,
    });
    assert.deepEqual(third, {
      id: "fennel-bulb",
      source: "1½ large fennel bulbs, sliced",
      amount: "1½",
      unit: "bulb",
      ingredient: "fennel",
      qualifier: "large, sliced",
      conceptId: "scallion",
      role: "weekly_requirement",
      canonicalIngredientId: 12,
    }, "canonical source fields survive without replacing the opaque planner ID");
    const legacyOccurrences = migrated.weeks[0].data.meals[1].ingredients;
    assert.deepEqual(legacyOccurrences.map(({ id }) => id), [
      "legacy-lines:ingredient:0", "legacy-lines:ingredient:1", "legacy-lines:ingredient:2", "legacy-lines-output",
    ]);
    assert.notEqual(legacyOccurrences[0].id, legacyOccurrences[1].id, "duplicate legacy strings remain distinct occurrences");
    assert.deepEqual(legacyOccurrences.map(({ source, amount, unit, ingredient }) => ({ source, amount, unit, ingredient })), [
      { source: "1 bunch cilantro", amount: "1", unit: null, ingredient: "bunch cilantro" },
      { source: "1 bunch cilantro", amount: "1", unit: null, ingredient: "bunch cilantro" },
      { source: "1/3 cup sliced almonds", amount: "1/3", unit: "cup", ingredient: "sliced almonds" },
      { source: "2 cups prepared sauce", amount: "2", unit: "cup", ingredient: "prepared sauce" },
    ]);
    assert.equal(legacyOccurrences[3].role, "output");
    assert.deepEqual(
      migrated.weeks[0].data.groceries.filter(({ mealId }) => mealId === "legacy-lines").map(({ ingredientId, coverage }) => ({ ingredientId, coverage })),
      [
        { ingredientId: "legacy-lines:ingredient:0", coverage: "needs_source" },
        { ingredientId: "legacy-lines:ingredient:1", coverage: "needs_source" },
        { ingredientId: "legacy-lines:ingredient:2", coverage: "needs_source" },
      ],
    );
    assert.equal(
      migrated.weeks[0].data.meals[1].instructions[0].inputs[0].occurrenceId,
      "legacy-lines:ingredient:2",
      "an unambiguous legacy instruction link resolves to the matching occurrence",
    );
    assert.equal(migrated.weeks[0].data.meals[0].instructions[0].inputs[0].occurrenceId, "pepper-two");
    assert.equal(Object.hasOwn(migrated.weeks[0].data.meals[0].instructions[0].inputs[0], "ingredientId"), false);
    const pepperTwoGrocery = migrated.weeks[0].data.groceries.find(({ ingredientId }) => ingredientId === "pepper-two");
    assert.equal(pepperTwoGrocery.coverage, "shop");
    assert.equal(Object.hasOwn(pepperTwoGrocery, "source"), false);
    assert.deepEqual(migrated.weeks[0].data.prepSessions[0].steps[0].sources, [
      { stepId: "step-one", ingredientIds: ["pepper-two", "fennel-bulb"] },
      { stepId: "step-two", ingredientIds: ["pepper-one"] },
    ]);
    const archived = migrated.weeks.find((week) => week.status === "archived");
    assert.ok(archived);
    assert.deepEqual(archived.data.meals[0].ingredients.map(({ id }) => id), [
      "pepper-one", "pepper-two", "fennel-bulb",
    ]);
    assert.equal(archived.data.meals[0].instructions[0].inputs[0].occurrenceId, "pepper-one");
    assert.equal(workspace.schema_version, 10);
    assert.equal(workspace.sync_revision, 8);
    const event = database.prepare(
      "SELECT command_json, changes_json, before_state_json, actor, actor_source, admission, base_version, result_version FROM planner_events WHERE event_id = 'v10-event'",
    ).get();
    assert.equal(event.command_json, expected.command);
    assert.equal(event.changes_json, expected.changes);
    assert.deepEqual(JSON.parse(event.before_state_json).weeks[0].data.meals[0].ingredients.map(({ id }) => id), [
      "pepper-one", "pepper-two", "fennel-bulb",
    ]);
    assert.deepEqual([event.actor, event.actor_source, event.admission, event.base_version, event.result_version], [
      "Household", "browser", "same_origin_http_v1", 3, 4,
    ]);
    assert.equal(database.prepare("SELECT proposed_command_json FROM chat_turns WHERE turn_id = 'v10-turn'").get().proposed_command_json, expected.proposed);
    assert.equal(database.prepare("SELECT decision_json FROM command_receipts WHERE request_id = 'non-household'").get().decision_json, expected.receipt);
    for (const table of ["planner_tool_calls", "codex_native_tool_calls"]) {
      const rows = database.prepare(`SELECT tool, result_envelope_json FROM ${table} ORDER BY sequence`).all();
      for (const row of rows) {
        const envelope = JSON.parse(row.result_envelope_json);
        assert.equal(isPlannerToolResultForTool(row.tool, envelope), true, `${table} ${row.tool} envelope must validate after upgrade`);
        if (row.tool === "read") {
          assert.equal(envelope.data.ingredientCatalogue.offset, 0);
          assert.ok(envelope.data.ingredientCatalogue.concepts.length <= 4);
          assert.deepEqual(envelope.data.week.data.meals[0].ingredients.map(({ id }) => id), [
            "pepper-one", "pepper-two", "fennel-bulb",
          ]);
          assert.equal(envelope.data.week.data.meals[0].instructions[0].inputs[0].occurrenceId, "pepper-two");
        }
        if (row.tool === "preview") {
          assert.deepEqual(envelope.data.outcomes[0].occurrences, []);
        }
        if (row.tool === "apply") {
          assert.deepEqual(envelope.data.occurrenceResults, [{ operationIndex: 0, occurrences: [] }]);
          assert.equal(envelope.data.readback.week.data.meals[0].ingredients[0].id, "pepper-one");
        }
      }
    }
  } finally {
    database.close();
  }

  const migratedStore = openPlannerStore({ filename });
  const migrated = migratedService(migratedStore);
  const workspaceBeforeEdit = migrated.readWorkspace();
  assert.equal(workspaceBeforeEdit.schemaVersion, 11);
  const migratedFennelConceptId = workspaceBeforeEdit.state.weeks[0].data.meals[0].ingredients[2].conceptId;
  assert.notEqual(migratedFennelConceptId, "scallion", "a legacy reference colliding with core vocabulary receives a bounded collision-safe identity");
  assert.ok(workspaceBeforeEdit.state.ingredientCatalogue.concepts.some(({ id }) => id === migratedFennelConceptId), "schema 11 retains a safe concept for every legacy resolution");
  const mealBeforeEdit = workspaceBeforeEdit.state.weeks[0].data.meals[0];
  assert.deepEqual(
    mealBeforeEdit.ingredients[2],
    {
      id: "fennel-bulb", source: "1½ large fennel bulbs, sliced", amount: "1½", unit: "bulb",
      ingredient: "fennel", qualifier: "large, sliced", conceptId: migratedFennelConceptId,
      role: "weekly_requirement", canonicalIngredientId: 12,
    },
    "catalogue migration must not rewrite occurrence identity or literal recipe fields",
  );
  const editRequest = {
    requestId: "migrated-occurrence-edit",
    basePlannerVersion: workspaceBeforeEdit.plannerVersion,
    command: {
      type: "editMealRecipe",
      weekId: "2026-08-10",
      mealId: "dinner",
      changes: {
        title: "Duplicate peppers, checked after migration",
        subtitle: mealBeforeEdit.subtitle,
        venue: mealBeforeEdit.venue,
        prepNote: mealBeforeEdit.prepNote,
        leftoverNote: mealBeforeEdit.leftoverNote,
        notes: mealBeforeEdit.notes,
        yieldText: mealBeforeEdit.yieldText ?? null,
      },
      occurrences: mealBeforeEdit.ingredients.map((occurrence, index) => ({
        kind: "retain",
        occurrenceId: occurrence.id,
        source: occurrence.source,
        amount: index === 0 ? "3" : occurrence.amount,
        unit: occurrence.unit,
        ingredient: occurrence.ingredient,
        qualifier: occurrence.qualifier,
        conceptId: occurrence.conceptId,
      })),
      removedOccurrenceIds: [],
    },
  };
  const edited = migrated.applyCommand(editRequest);
  assert.equal(edited.decision.status, "accepted");
  assert.equal(edited.workspace.state.weeks[0].data.meals[0].title, editRequest.command.changes.title);
  assert.equal(edited.workspace.state.weeks[0].data.meals[0].ingredients[0].amount, "3");
  const replayed = migrated.applyCommand(editRequest);
  assert.deepEqual(replayed.decision, edited.decision, "the exact occurrence edit must replay from its durable receipt");
  assert.equal(replayed.workspace.events.length, 2, "receipt replay must not add another event");
  const undone = migrated.undoLatest({
    requestId: "undo-migrated-occurrence-edit",
    basePlannerVersion: edited.workspace.plannerVersion,
    targetEventId: edited.decision.eventId,
  });
  assert.equal(undone.decision.status, "accepted");
  assert.equal(undone.workspace.state.weeks[0].data.meals[0].title, mealBeforeEdit.title);
  assert.equal(undone.workspace.state.weeks[0].data.meals[0].ingredients[0].amount, "2");
  assert.deepEqual(
    undone.workspace.state.weeks[0].data.meals[0].ingredients.map((occurrence) => occurrence.id),
    ["pepper-one", "pepper-two", "fennel-bulb"],
    "undo must restore migrated occurrence identities and their order",
  );
  migratedStore.close();

  const beforeCurrentOpen = logicalInventory(filename);
  const firstReopen = openPlannerStore({ filename });
  assert.equal(firstReopen.readWorkspace().schemaVersion, 11);
  assert.equal(firstReopen.readWorkspace().syncRevision, 11);
  firstReopen.close();
  assert.deepEqual(logicalInventory(filename), beforeCurrentOpen, "a current schema open must not rewrite any logical row");
  const secondReopen = openPlannerStore({ filename });
  assert.equal(secondReopen.readWorkspace().schemaVersion, 11);
  secondReopen.close();
  assert.deepEqual(logicalInventory(filename), beforeCurrentOpen, "a second current-schema open must remain logically idempotent");
  const integrity = new DatabaseSync(filename, { readOnly: true });
  assert.equal(integrity.prepare("PRAGMA quick_check").get().quick_check, "ok");
  integrity.close();
});

test("startup upgrades a schema-8 accepted apply envelope before current-contract validation", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "planner.sqlite");
  createV9Store(filename);
  const legacy = new DatabaseSync(filename);
  try {
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 9").run();
    legacy.prepare("UPDATE workspace SET schema_version = 8 WHERE id = 'household'").run();
  } finally {
    legacy.close();
  }

  const store = openPlannerStore({ filename });
  try {
    const row = store.database.prepare(
      "SELECT result_envelope_json FROM codex_native_tool_calls WHERE call_id = 'native-apply-call'",
    ).get();
    const envelope = JSON.parse(row.result_envelope_json);
    assert.deepEqual(envelope.data.occurrenceResults, [{ operationIndex: 0, occurrences: [] }]);
    assert.equal(isPlannerToolResultForTool("apply", envelope), true);
    assert.equal(store.readWorkspace().schemaVersion, 11);
  } finally {
    store.close();
  }
});

test("the packaged v9-to-v10 command reports its verified database and backup", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "planner.sqlite");
  const backupFilename = join(directory, "planner.pre-v10.sqlite");
  createV9Store(filename);

  const stdout = execFileSync(
    "npm",
    ["--silent", "run", "planner:migrate-v9-v10", "--", "--database", filename, "--backup", backupFilename],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  const result = JSON.parse(stdout.trim());
  assert.equal(result.database.schemaVersion, 10);
  assert.equal(result.database.quickCheck, "ok");
  assert.equal(result.backup.schemaVersion, 9);
  assert.equal(result.backup.quickCheck, "ok");
  assert.equal(existsSync(backupFilename), true);

  const invalid = spawnSync(
    "npm",
    ["--silent", "run", "planner:migrate-v9-v10", "--", "--database", filename],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Usage:/u);
});

test("ambiguity found only in an undo snapshot reports the exact persisted input path without mutation", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "planner.sqlite");
  const backupFilename = join(directory, "planner.pre-v10.sqlite");
  createV9Store(filename);
  const database = new DatabaseSync(filename);
  try {
    const ambiguousEventState = v9State();
    delete ambiguousEventState.weeks[0].data.meals[0].instructions[0].inputs[0].ingredientId;
    database.prepare("UPDATE planner_events SET before_state_json = ? WHERE event_id = 'v10-event'")
      .run(JSON.stringify(ambiguousEventState));
  } finally {
    database.close();
  }
  const before = artifactInventory(filename);

  assert.throws(
    () => migratePlannerStoreV9ToV10({ filename, backupFilename }),
    (error) => {
      assert.equal(error instanceof PlannerStoreError, true);
      assert.equal(error.code, "MIGRATION_FAILED");
      assert.match(error.message, /planner_events\[1\]\.before_state_json.*instructions\[0\]\.inputs\[0\].*pepper-one, pepper-two/iu);
      return true;
    },
  );
  assert.deepEqual(artifactInventory(filename), before);
  assert.equal(existsSync(backupFilename), false);
});

test("an ambiguous schema-9 source fails before a backup or sidecar can be created", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "ambiguous.sqlite");
  const backupFilename = join(directory, "ambiguous.pre-v10.sqlite");
  const ambiguous = v9State();
  ambiguous.weeks[0].data.meals[0].ingredients = ["2 red peppers", "2 red peppers"];
  ambiguous.weeks[0].data.meals[0].instructions[0].inputs = [{ amount: "2", ingredient: "red peppers" }];
  createV9Store(filename, ambiguous);
  const before = readFileSync(filename);
  const inventoryBefore = artifactInventory(filename);

  assert.throws(
    () => migratePlannerStoreV9ToV10({ filename, backupFilename }),
    (error) => error instanceof PlannerStoreError && error.code === "MIGRATION_FAILED" && /ambiguous/i.test(error.message),
  );
  assert.deepEqual(readFileSync(filename), before);
  assert.deepEqual(artifactInventory(filename), inventoryBefore);
  assert.equal(existsSync(backupFilename), false);
  assert.equal(existsSync(`${filename}-wal`), false);
  assert.equal(existsSync(`${filename}-shm`), false);
});

test("an invalid purported schema-10 occurrence fails closed before any migration artifact is created", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "invalid-current-occurrence.sqlite");
  const backupFilename = join(directory, "invalid-current-occurrence.pre-v10.sqlite");
  const invalid = v9State();
  invalid.weeks[0].data.meals[0].ingredients[2].unsupportedIdentityHint = "fennel";
  createV9Store(filename, invalid);
  const before = readFileSync(filename);
  const inventoryBefore = artifactInventory(filename);

  assert.throws(
    () => migratePlannerStoreV9ToV10({ filename, backupFilename }),
    (error) => {
      assert.equal(error instanceof PlannerStoreError, true);
      assert.equal(error.code, "MIGRATION_FAILED");
      assert.match(error.message, /workspace\.state_json.*ingredients\[2\].*partial or unsupported occurrence shape/iu);
      return true;
    },
  );
  assert.deepEqual(readFileSync(filename), before);
  assert.deepEqual(artifactInventory(filename), inventoryBefore);
  assert.equal(existsSync(backupFilename), false);
  assert.equal(existsSync(`${filename}-wal`), false);
  assert.equal(existsSync(`${filename}-shm`), false);
});
