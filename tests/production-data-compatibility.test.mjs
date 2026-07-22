import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertProductionDataCompatible,
  ProductionDataCompatibilityError,
} from "../scripts/support/production-data-compatibility.mjs";
import {
  CURRENT_SCHEMA_VERSION,
  PLANNER_SCHEMA_MIGRATIONS,
  PLANNER_SCHEMA_OBJECTS,
  validatePlannerSchemaCatalogue,
} from "../server/store/schema-contract.ts";

async function createDatabase(t, version, workspaceVersion = version) {
  const root = await mkdtemp(join(tmpdir(), "planner-production-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, "planner.sqlite");
  const database = new DatabaseSync(filename);
  try {
    for (const migration of PLANNER_SCHEMA_MIGRATIONS) {
      if (migration.version > version) break;
      database.exec(await readFile(migration.path, "utf8"));
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, migration.version);
    }
    database.prepare(
      "INSERT INTO workspace (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at) VALUES ('household', ?, 0, 0, '{}', 1, 1)",
    ).run(workspaceVersion);
  } finally {
    database.close();
  }
  return filename;
}

async function bytesAndStat(filename) {
  const metadata = await stat(filename);
  return {
    bytes: await readFile(filename),
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

test("schema compatibility accepts the v9 candidate without mutating SQLite", async (t) => {
  const filename = await createDatabase(t, CURRENT_SCHEMA_VERSION);
  const before = await bytesAndStat(filename);

  const inspection = assertProductionDataCompatible(filename);

  const after = await bytesAndStat(filename);
  assert.equal(inspection.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(inspection.migrationVersions, PLANNER_SCHEMA_MIGRATIONS.map(({ version }) => version));
  assert.deepEqual(inspection.schemaObjects, PLANNER_SCHEMA_OBJECTS);
  assert.equal(inspection.workspaceSchemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(after, before);
});

test("schema compatibility rejects a gapped v9 ledger without further writes", async (t) => {
  const filename = await createDatabase(t, CURRENT_SCHEMA_VERSION);
  const database = new DatabaseSync(filename);
  database.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
  database.close();
  const before = await bytesAndStat(filename);

  assert.throws(
    () => assertProductionDataCompatible(filename),
    (error) => error instanceof ProductionDataCompatibilityError &&
      /could not be verified/u.test(error.message),
  );
  assert.deepEqual(await bytesAndStat(filename), before);
});

test("schema compatibility rejects missing required objects without further writes", async (t) => {
  for (const [type, name] of [
    ["TABLE", "codex_native_mutation_receipts"],
    ["INDEX", "codex_turn_admissions_created"],
    ["TRIGGER", "codex_turn_admission_reject_settled_insert"],
  ]) {
    const filename = await createDatabase(t, CURRENT_SCHEMA_VERSION);
    const database = new DatabaseSync(filename);
    database.exec(`DROP ${type} ${name}`);
    database.close();
    const before = await bytesAndStat(filename);

    assert.throws(
      () => assertProductionDataCompatible(filename),
      (error) => error instanceof ProductionDataCompatibilityError &&
        /schema objects do not exactly match/u.test(error.message),
    );
    assert.deepEqual(await bytesAndStat(filename), before);
  }
});

test("schema compatibility rejects v8 and initialized-workspace mismatches without writes", async (t) => {
  for (const [version, workspaceVersion] of [[8, 8], [CURRENT_SCHEMA_VERSION, 8]]) {
    const filename = await createDatabase(t, version, workspaceVersion);
    const before = await bytesAndStat(filename);
    assert.throws(
      () => assertProductionDataCompatible(filename),
      (error) => error instanceof ProductionDataCompatibilityError &&
        /schema-changing releases require separate authorization/u.test(error.message),
    );
    assert.deepEqual(await bytesAndStat(filename), before);
  }
});

test("schema catalogue refuses missing, duplicate, and gapped migration entries", () => {
  const current = PLANNER_SCHEMA_MIGRATIONS;
  assert.throws(() => validatePlannerSchemaCatalogue(current.slice(1), CURRENT_SCHEMA_VERSION));
  assert.throws(() => validatePlannerSchemaCatalogue([
    current[0], current[0], ...current.slice(2),
  ], CURRENT_SCHEMA_VERSION));
  assert.throws(() => validatePlannerSchemaCatalogue([
    ...current.slice(0, 7), current[8], current[7],
  ], CURRENT_SCHEMA_VERSION));
  assert.throws(() => validatePlannerSchemaCatalogue([
    ...current.slice(0, 8), { version: 9, path: join(tmpdir(), "missing.sql") },
  ], CURRENT_SCHEMA_VERSION));
});
