import { copyFile, lstat, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  inspectVerifiedPlannerSnapshot,
  inspectVerifiedPlannerSchema10Snapshot,
  openPlannerStore,
} from "../../server/store/sqlite-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../server/store/schema-contract.ts";
import { assertProductionDataCompatible } from "./production-data-compatibility.mjs";

const SUPPORTED_PREDECESSOR_SCHEMA = 10;

function sameArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSchema10Predecessor(snapshot) {
  if (
    snapshot.quickCheck !== "ok" ||
    snapshot.schemaVersion !== SUPPORTED_PREDECESSOR_SCHEMA ||
    snapshot.workspaceSchemaVersion !== SUPPORTED_PREDECESSOR_SCHEMA ||
    !sameArray(snapshot.migrationVersions, Array.from({ length: 10 }, (_, index) => index + 1))
  ) {
    throw new Error("Production data is neither current nor the exact supported schema-10 predecessor.");
  }
  return snapshot;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function appSupportsSchema12(appRoot) {
  return pathExists(join(appRoot, "server", "store", "migrations", "012-canonical-recipe-import-tool.sql"));
}

async function restoreDatabase(databasePath, handle) {
  const current = inspectVerifiedPlannerSnapshot(databasePath);
  if (current.schemaVersion === 10) return;
  if (!handle?.backupPath) {
    throw new Error("Automatic schema downgrade requires the active promotion's exact backup handle.");
  }
  const backup = { path: handle.backupPath, snapshot: inspectVerifiedPlannerSchema10Snapshot(handle.backupPath) };
  assertSchema10Predecessor(backup.snapshot);
  if (backup.snapshot.plannerVersion !== current.plannerVersion) {
    throw new Error("Schema-10 backup planner version does not match the migrated database.");
  }

  const restorePath = `${databasePath}.restore-${process.pid}-${Date.now()}`;
  await copyFile(backup.path, restorePath);
  const staged = inspectVerifiedPlannerSnapshot(restorePath);
  if (staged.sha256 !== backup.snapshot.sha256) {
    await rm(restorePath, { force: true });
    throw new Error("Staged schema-10 restoration does not match its verified backup.");
  }
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  try {
    await rename(restorePath, databasePath);
    const restored = inspectVerifiedPlannerSnapshot(databasePath);
    if (restored.sha256 !== backup.snapshot.sha256) {
      throw new Error("Restored production database does not match its verified backup.");
    }
  } catch (error) {
    throw error;
  } finally {
    await rm(restorePath, { force: true });
  }
}

export function createProductionDataTransition({ databasePath }) {
  let planned = null;
  let activeHandle = null;

  return Object.freeze({
    preflight() {
      const snapshot = inspectVerifiedPlannerSnapshot(databasePath);
      if (snapshot.schemaVersion === CURRENT_SCHEMA_VERSION) {
        assertProductionDataCompatible(databasePath);
        planned = { kind: "current", snapshot };
      } else {
        planned = {
          kind: "migrate",
          snapshot: assertSchema10Predecessor(inspectVerifiedPlannerSchema10Snapshot(databasePath)),
        };
      }
      return planned;
    },

    async afterQuiescence() {
      if (!planned) throw new Error("Production data transition was not preflighted.");
      const current = inspectVerifiedPlannerSnapshot(databasePath);
      if (
        current.schemaVersion !== planned.snapshot.schemaVersion ||
        current.workspaceSchemaVersion !== planned.snapshot.workspaceSchemaVersion ||
        current.plannerVersion !== planned.snapshot.plannerVersion
      ) {
        throw new Error("Production data changed after transition preflight.");
      }
      if (planned.kind === "current") return null;
      let store;
      let backupPath = null;
      try {
        store = openPlannerStore({ filename: databasePath });
        backupPath = store.migrationBackupPath;
        if (!backupPath) throw new Error("Schema-changing production open did not retain a migration backup.");
        const workspace = store.readWorkspace();
        const plannerVersion = workspace.initialized ? workspace.plannerVersion : null;
        store.close();
        store = null;
        const migrated = assertProductionDataCompatible(databasePath);
        const backup = assertSchema10Predecessor(inspectVerifiedPlannerSnapshot(backupPath));
        if (
          backup.plannerVersion !== planned.snapshot.plannerVersion ||
          migrated.plannerVersion !== plannerVersion
        ) {
          throw new Error("Production migration backup or planner-version readback is inconsistent.");
        }
        activeHandle = Object.freeze({
          backupPath,
          before: backup,
          after: migrated,
        });
        return activeHandle;
      } catch (error) {
        backupPath = backupPath ?? store?.migrationBackupPath ?? error?.migrationBackupPath ?? null;
        store?.close();
        if (backupPath) await restoreDatabase(databasePath, { backupPath });
        throw error;
      }
    },

    async beforeBootstrap(paths) {
      const database = inspectVerifiedPlannerSnapshot(databasePath);
      const supportsCurrent = await appSupportsSchema12(paths.app);
      if (supportsCurrent && database.schemaVersion === CURRENT_SCHEMA_VERSION) return;
      if (!supportsCurrent && database.schemaVersion === SUPPORTED_PREDECESSOR_SCHEMA) return;
      if (!supportsCurrent && database.schemaVersion === CURRENT_SCHEMA_VERSION) {
        if (!activeHandle) {
          throw new Error("Recovery cannot automatically downgrade schema 12 without the active promotion handle.");
        }
        await restoreDatabase(databasePath, activeHandle);
        return;
      }
      throw new Error(`Selected app and database schema are incompatible: app12=${supportsCurrent}, database=${database.schemaVersion}.`);
    },

    afterReadiness() {
      const snapshot = inspectVerifiedPlannerSnapshot(databasePath);
      if (snapshot.schemaVersion !== CURRENT_SCHEMA_VERSION && snapshot.schemaVersion !== SUPPORTED_PREDECESSOR_SCHEMA) {
        throw new Error("Ready production app has an unsupported database schema.");
      }
    },

    restore(_paths, handle) {
      if (planned?.kind !== "migrate" && !handle && !activeHandle) return undefined;
      return restoreDatabase(databasePath, handle ?? activeHandle);
    },
  });
}
