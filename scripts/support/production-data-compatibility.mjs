import { inspectVerifiedPlannerSnapshot } from "../../server/store/sqlite-store.ts";
import {
  CURRENT_SCHEMA_VERSION,
  assertPlannerSchemaContract,
  PLANNER_SCHEMA_MIGRATIONS,
  PLANNER_SCHEMA_OBJECTS,
} from "../../server/store/schema-contract.ts";

export class ProductionDataCompatibilityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ProductionDataCompatibilityError";
  }
}

/**
 * Read only the selected planner database before a release disturbs its service.
 * Schema-changing candidates deliberately require separate authorization.
 */
export function assertProductionDataCompatible(databasePath) {
  assertPlannerSchemaContract();
  let snapshot;
  try {
    snapshot = inspectVerifiedPlannerSnapshot(databasePath);
  } catch (error) {
    throw new ProductionDataCompatibilityError(
      "Production planner database could not be verified against the candidate schema contract.",
      { cause: error },
    );
  }
  const expectedMigrationVersions = PLANNER_SCHEMA_MIGRATIONS.map(({ version }) => version);
  if (JSON.stringify(snapshot.migrationVersions) !== JSON.stringify(expectedMigrationVersions)) {
    throw new ProductionDataCompatibilityError(
      "Production planner migration ledger does not exactly match the candidate schema contract; schema-changing releases require separate authorization.",
    );
  }
  if (JSON.stringify(snapshot.schemaObjects) !== JSON.stringify(PLANNER_SCHEMA_OBJECTS)) {
    throw new ProductionDataCompatibilityError(
      "Production planner schema objects do not exactly match the candidate schema contract; schema-changing releases require separate authorization.",
    );
  }
  const versions = [
    ["migration ledger", snapshot.schemaVersion],
    ...(snapshot.initialized ? [["initialized workspace", snapshot.workspaceSchemaVersion]] : []),
  ];
  for (const [source, version] of versions) {
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new ProductionDataCompatibilityError(
        `Production planner ${source} schema version ${version} is incompatible with candidate schema version ${CURRENT_SCHEMA_VERSION}; schema-changing releases require separate authorization.`,
      );
    }
  }
  return Object.freeze(snapshot);
}
