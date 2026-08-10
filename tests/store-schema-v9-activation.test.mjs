import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  migratePlannerStoreV8ToV9,
  inspectVerifiedPlannerSnapshot,
  PlannerStoreError,
} from "../server/store/sqlite-store.ts";
import { PLANNER_SCHEMA_MIGRATIONS } from "../server/store/schema-contract.ts";

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "weekly-recipe-v9-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createV8Store(filename) {
  const database = new DatabaseSync(filename);
  try {
    for (const migration of PLANNER_SCHEMA_MIGRATIONS.filter(({ version }) => version <= 8)) {
      database.exec(readFileSync(migration.path, "utf8"));
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        migration.version,
      );
    }
    database.prepare(
      `INSERT INTO workspace
        (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at)
       VALUES ('household', 8, 12, 3, ?, 1, 2)`,
    ).run(JSON.stringify({ householdTimeZone: "America/Halifax", weeks: [] }));
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA wal_autocheckpoint = 0");
    database.prepare(
      "INSERT INTO command_receipts (operation_kind, request_id, payload_hash, http_status, decision_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("planner_command", "duplicate-a", "hash-a", 200, JSON.stringify({ value: null }), 3);
    database.prepare(
      "INSERT INTO command_receipts (operation_kind, request_id, payload_hash, http_status, decision_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("planner_command", "duplicate-b", "hash-b", 200, JSON.stringify({ value: null }), 3);
    database.prepare(
      "INSERT INTO command_receipts (operation_kind, request_id, payload_hash, http_status, decision_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("planner_command", "nul\0request", "hash-nul", 200, JSON.stringify({ value: "\u0000" }), 3);
  } finally {
    database.close();
  }
}

function version(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return {
      ledger: database.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all(),
      workspace: database.prepare("SELECT schema_version, planner_version, sync_revision, state_json FROM workspace WHERE id = 'household'").get(),
      integrity: database.prepare("PRAGMA quick_check").get().quick_check,
    };
  } finally {
    database.close();
  }
}

test("migrates one coherent populated v8 store with a verified point-in-time v8 recovery copy", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "planner.sqlite");
  const backupFilename = join(directory, "planner.pre-v9.sqlite");
  createV8Store(filename);

  const retainedReader = new DatabaseSync(filename, { readOnly: true });
  retainedReader.exec("BEGIN");
  retainedReader.prepare("SELECT COUNT(*) AS count FROM command_receipts").get();
  const walWriter = new DatabaseSync(filename);
  try {
    walWriter.prepare(
      "INSERT INTO transcript_entries (entry_id, role, text, context_json, turn_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("sequence-proof", "system", "committed in WAL", null, null, 4);
  } finally {
    walWriter.close();
  }
  assert.equal(existsSync(`${filename}-wal`), true);
  assert.ok(statSync(`${filename}-wal`).size > 0);

  let result;
  try {
    result = migratePlannerStoreV8ToV9({ filename, backupFilename });
  } finally {
    retainedReader.exec("ROLLBACK");
    retainedReader.close();
  }
  assert.equal(result.database.schemaVersion, 9);
  assert.equal(result.database.workspaceSchemaVersion, 9);
  assert.equal(result.backup.schemaVersion, 8);
  assert.equal(result.backup.workspaceSchemaVersion, 8);
  assert.equal(result.backup.quickCheck, "ok");
  assert.ok(result.database.rowCounts.sqlite_sequence > 0);
  assert.equal(existsSync(`${backupFilename}-wal`), false);
  assert.equal(existsSync(`${backupFilename}-shm`), false);
  assert.deepEqual(result.migration.allowedChanges, [
    "schema_migrations:9",
    "workspace:household.schema_version",
  ]);
  assert.deepEqual(version(backupFilename).ledger.map(({ version: item }) => item), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(version(filename).ledger.map(({ version: item }) => item), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(version(backupFilename).workspace.schema_version, 8);
  assert.equal(version(filename).workspace.schema_version, 9);
  for (const candidate of [filename, backupFilename]) {
    const database = new DatabaseSync(candidate, { readOnly: true });
    try {
      assert.equal(
        database.prepare("SELECT hex(request_id) AS value FROM command_receipts WHERE payload_hash = 'hash-nul'").get().value,
        "6E756C0072657175657374",
      );
      const sequence = database.prepare(
        "SELECT name, seq FROM sqlite_sequence WHERE name = 'transcript_entries'",
      ).get();
      assert.equal(sequence.name, "transcript_entries");
      assert.equal(sequence.seq, 1);
      assert.equal(
        database.prepare("SELECT text FROM transcript_entries WHERE entry_id = 'sequence-proof'").get().text,
        "committed in WAL",
      );
    } finally {
      database.close();
    }
  }
  assert.deepEqual(inspectVerifiedPlannerSnapshot(backupFilename), result.backup);
});

test("rejects busy, backup-collision, and malformed command inputs without changing the source", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "planner.sqlite");
  createV8Store(filename);
  const before = version(filename);
  const writer = new DatabaseSync(filename);
  writer.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(
      () => migratePlannerStoreV8ToV9({ filename, backupFilename: join(directory, "busy-backup.sqlite") }),
      (error) => error instanceof PlannerStoreError && error.code === "BUSY",
    );
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  const collision = join(directory, "collision.sqlite");
  writeFileSync(collision, "do not overwrite");
  assert.throws(() => migratePlannerStoreV8ToV9({ filename, backupFilename: collision }));
  const sidecarCollision = join(directory, "sidecar.sqlite");
  writeFileSync(`${sidecarCollision}-wal`, "do not overwrite");
  assert.throws(() => migratePlannerStoreV8ToV9({ filename, backupFilename: sidecarCollision }));
  const malformed = spawnSync(
    "npm",
    ["run", "planner:migrate-v8-v9", "--", "--database", filename],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /Usage/u);
  assert.deepEqual(version(filename), before);
});

test("rejects a gapped ledger, workspace mismatch, and non-canonical schema without a backup", (t) => {
  const directory = temporaryDirectory(t);
  for (const [name, mutate] of [
    ["gapped", (database) => database.exec("DELETE FROM schema_migrations WHERE version = 8")],
    ["workspace", (database) => database.exec("UPDATE workspace SET schema_version = 7")],
    ["ddl", (database) => database.exec("CREATE INDEX unexpected_workspace_revision ON workspace(sync_revision)")],
  ]) {
    const filename = join(directory, `${name}.sqlite`);
    const backupFilename = join(directory, `${name}.backup.sqlite`);
    createV8Store(filename);
    const database = new DatabaseSync(filename);
    try {
      mutate(database);
    } finally {
      database.close();
    }
    const before = version(filename);
    assert.throws(() => migratePlannerStoreV8ToV9({ filename, backupFilename }));
    assert.deepEqual(version(filename), before);
    assert.equal(existsSync(backupFilename), false);
  }
});

test("rejects foreign-key corruption without creating a backup", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "foreign-key-corrupt.sqlite");
  const backupFilename = join(directory, "foreign-key-corrupt.backup.sqlite");
  createV8Store(filename);
  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(
      "INSERT INTO transcript_entries (entry_id, role, text, context_json, turn_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("orphaned-entry", "system", "orphaned", null, "missing-turn", 5);
  } finally {
    database.close();
  }

  const before = version(filename);
  assert.throws(
    () => migratePlannerStoreV8ToV9({ filename, backupFilename }),
    (error) => error instanceof PlannerStoreError && error.code === "STORE_CORRUPT",
  );
  assert.deepEqual(version(filename), before);
  assert.equal(existsSync(backupFilename), false);
});

test("the shipped command rolls back an unexpected migration delta and retains the original v8 backup", (t) => {
  const directory = temporaryDirectory(t);
  const isolatedSource = join(directory, "isolated-source");
  for (const path of ["lib", "server", "scripts"]) {
    cpSync(new URL(`../${path}`, import.meta.url), join(isolatedSource, path), { recursive: true });
  }
  cpSync(new URL("../package.json", import.meta.url), join(isolatedSource, "package.json"));
  const migrationPath = join(isolatedSource, "server/store/migrations/009-prep-combined-steps.sql");
  writeFileSync(
    migrationPath,
    `${readFileSync(migrationPath, "utf8")}\nUPDATE command_receipts SET payload_hash = 'unexpected';\n`,
  );

  const filename = join(directory, "planner.sqlite");
  const backupFilename = join(directory, "planner.pre-v9.sqlite");
  createV8Store(filename);
  const command = spawnSync(
    "npm",
    ["--silent", "run", "planner:migrate-v8-v9", "--", "--database", filename, "--backup", backupFilename],
    { cwd: isolatedSource, encoding: "utf8" },
  );

  assert.notEqual(command.status, 0);
  assert.match(command.stderr, /table changed unexpectedly: command_receipts/u);
  assert.deepEqual(version(filename).ledger.map(({ version: item }) => item), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(version(backupFilename).ledger.map(({ version: item }) => item), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const candidate of [filename, backupFilename]) {
    const database = new DatabaseSync(candidate, { readOnly: true });
    try {
      assert.equal(
        database.prepare("SELECT payload_hash FROM command_receipts WHERE request_id = 'duplicate-a'").get().payload_hash,
        "hash-a",
      );
    } finally {
      database.close();
    }
  }
});

test("the shipped npm command has the same bounded result for a second explicit v8 file", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "rehearsal.sqlite");
  const backupFilename = join(directory, "rehearsal.pre-v9.sqlite");
  createV8Store(filename);

  const stdout = execFileSync(
    "npm",
    ["--silent", "run", "planner:migrate-v8-v9", "--", "--database", filename, "--backup", backupFilename],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  const result = JSON.parse(stdout.trim());
  assert.equal(result.database.schemaVersion, 9);
  assert.equal(result.backup.schemaVersion, 8);
  assert.equal(version(filename).integrity, "ok");
  assert.equal(version(backupFilename).integrity, "ok");
});

test("rejects a non-v8 source without changing it or creating its backup", (t) => {
  const directory = temporaryDirectory(t);
  const filename = join(directory, "already-v9.sqlite");
  const backupFilename = join(directory, "already-v9.pre-v9.sqlite");
  createV8Store(filename);
  migratePlannerStoreV8ToV9({ filename, backupFilename: join(directory, "first-backup.sqlite") });
  const before = version(filename);

  assert.throws(
    () => migratePlannerStoreV8ToV9({ filename, backupFilename }),
    (error) => error instanceof PlannerStoreError && error.code === "MIGRATION_FAILED",
  );
  assert.deepEqual(version(filename), before);
  assert.equal(existsSync(backupFilename), false);
});
