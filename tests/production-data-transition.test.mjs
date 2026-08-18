import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createProductionDataTransition } from "../scripts/support/production-data-transition.mjs";
import { inspectVerifiedPlannerSnapshot } from "../server/store/sqlite-store.ts";

const SCHEMA10_PREDECESSOR = "6038740d492db7b4aa278c0bc1c66ca39d3ee790";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr || result.stdout}`);
}

function createSchema10Store(root, filename) {
  const predecessor = join(root, "schema10-app");
  const archive = join(root, "schema10.tar");
  mkdirSync(predecessor);
  run("git", ["archive", "--format=tar", `--output=${archive}`, SCHEMA10_PREDECESSOR], { cwd: process.cwd() });
  run("tar", ["-xf", archive, "-C", predecessor]);
  symlinkSync(join(process.cwd(), "node_modules"), join(predecessor, "node_modules"), "dir");
  run(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    `Promise.all([
      import('./server/store/sqlite-store.ts'),
      import('./server/application/planner-service.ts'),
      import('./lib/household-bootstrap.ts'),
      import('./lib/household-domain.ts'),
    ]).then(([{openPlannerStore}, {createPlannerApplicationService}, {createCanonicalSeed, transformLegacyV2}, {householdDomain}]) => {
      let nextId = 0;
      const createId = (prefix) => prefix + '-fixture-' + (++nextId);
      const store = openPlannerStore({filename: process.argv[1]});
      const service = createPlannerApplicationService({
        store,
        domain: householdDomain,
        seedFactory: () => createCanonicalSeed({
          now: 1_800_000_000_000,
          createId,
        }),
        transformLegacyV2,
        clock: {now: () => 1_800_000_000_000},
        idFactory: {createId},
      });
      service.bootstrap({requestId: 'schema-10-fixture', mode: 'seed'});
      store.close();
    })`,
    filename,
  ], { cwd: predecessor });
}

test("production data transition migrates schema 10, retains its backup, and restores it for the old app", async (t) => {
  const scratch = join(process.cwd(), ".scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "planner-production-data-transition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "planner.sqlite");
  const currentApp = join(root, "current-app");
  const oldApp = join(root, "old-app");
  mkdirSync(join(currentApp, "server", "store", "migrations"), { recursive: true });
  mkdirSync(oldApp);
  writeFileSync(join(currentApp, "server", "store", "migrations", "012-canonical-recipe-import-tool.sql"), "-- marker");
  createSchema10Store(root, databasePath);

  const before = inspectVerifiedPlannerSnapshot(databasePath);
  assert.equal(before.schemaVersion, 10);
  const transition = createProductionDataTransition({ databasePath });
  assert.equal(transition.preflight().kind, "migrate");
  const handle = await transition.afterQuiescence();
  assert.equal(inspectVerifiedPlannerSnapshot(databasePath).schemaVersion, 12);
  const retainedBackup = inspectVerifiedPlannerSnapshot(handle.backupPath);
  assert.equal(retainedBackup.schemaVersion, 10);
  await transition.beforeBootstrap({ app: currentApp });
  transition.afterReadiness();

  const interruptedRecovery = createProductionDataTransition({ databasePath });
  await assert.rejects(
    interruptedRecovery.beforeBootstrap({ app: oldApp }),
    /cannot automatically downgrade schema 12/u,
  );

  const laterCurrentRelease = createProductionDataTransition({ databasePath });
  assert.equal(laterCurrentRelease.preflight().kind, "current");
  await laterCurrentRelease.restore({ app: currentApp }, null);
  assert.equal(inspectVerifiedPlannerSnapshot(databasePath).schemaVersion, 12);

  await transition.restore({ app: oldApp }, handle);
  const restored = inspectVerifiedPlannerSnapshot(databasePath);
  assert.equal(restored.schemaVersion, 10);
  assert.equal(restored.plannerVersion, before.plannerVersion);
  assert.equal(restored.sha256, retainedBackup.sha256);
  await transition.beforeBootstrap({ app: oldApp });
});

test("production transition rejects a malformed schema-10 predecessor before changing it", (t) => {
  const scratch = join(process.cwd(), ".scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "planner-production-data-malformed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "planner.sqlite");
  createSchema10Store(root, databasePath);
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE unexpected_release_state (id INTEGER PRIMARY KEY) STRICT");
  database.close();
  const before = inspectVerifiedPlannerSnapshot(databasePath);

  assert.throws(
    () => createProductionDataTransition({ databasePath }).preflight(),
    /schema definitions do not match/u,
  );
  assert.equal(inspectVerifiedPlannerSnapshot(databasePath).sha256, before.sha256);
});

test("production transition rejects foreign-key-corrupt schema-10 data before changing it", (t) => {
  const scratch = join(process.cwd(), ".scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "planner-production-data-foreign-key-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "planner.sqlite");
  createSchema10Store(root, databasePath);
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = OFF");
  database.prepare(
    `INSERT INTO transcript_entries
      (entry_id, role, text, context_json, turn_id, occurred_at)
     VALUES ('fk-corrupt', 'user', 'invalid fixture', NULL, 'missing-turn', 1)`,
  ).run();
  database.close();
  const before = inspectVerifiedPlannerSnapshot(databasePath);

  assert.throws(
    () => createProductionDataTransition({ databasePath }).preflight(),
    /foreign-key violations/u,
  );
  assert.equal(inspectVerifiedPlannerSnapshot(databasePath).sha256, before.sha256);
});
