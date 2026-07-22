import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PlannerSchemaMigration = Readonly<{
  version: number;
  path: string;
}>;

export type PlannerSchemaObject = Readonly<{
  type: "index" | "table" | "trigger";
  name: string;
}>;

export const CURRENT_SCHEMA_VERSION = 9;

export const PLANNER_SCHEMA_MIGRATIONS: readonly PlannerSchemaMigration[] = Object.freeze([
  { version: 1, path: fileURLToPath(new URL("migrations/001-initial.sql", import.meta.url)) },
  {
    version: 2,
    path: fileURLToPath(
      new URL("migrations/002-planner-operations-and-provenance.sql", import.meta.url),
    ),
  },
  {
    version: 3,
    path: fileURLToPath(
      new URL("migrations/003-embedded-tool-lifecycle.sql", import.meta.url),
    ),
  },
  {
    version: 4,
    path: fileURLToPath(
      new URL("migrations/004-sourced-recipe-intake.sql", import.meta.url),
    ),
  },
  {
    version: 5,
    path: fileURLToPath(
      new URL("migrations/005-research-candidate-digest.sql", import.meta.url),
    ),
  },
  {
    version: 6,
    path: fileURLToPath(
      new URL("migrations/006-native-codex-threads.sql", import.meta.url),
    ),
  },
  {
    version: 7,
    path: fileURLToPath(
      new URL("migrations/007-native-codex-admissions.sql", import.meta.url),
    ),
  },
  {
    version: 8,
    path: fileURLToPath(
      new URL("migrations/008-native-codex-mutation-receipts.sql", import.meta.url),
    ),
  },
  {
    version: 9,
    path: fileURLToPath(new URL("migrations/009-prep-combined-steps.sql", import.meta.url)),
  },
]);

// This is the selected schema-v9 shape after every migration has run. Release
// compatibility checks the exact live shape so a damaged ledger or missing
// enforcement object cannot masquerade as a current database.
export const PLANNER_SCHEMA_OBJECTS: readonly PlannerSchemaObject[] = Object.freeze([
  { type: "index", name: "codex_native_tool_calls_thread_turn_sequence" },
  { type: "index", name: "codex_turn_admissions_created" },
  { type: "index", name: "one_revert_per_event" },
  { type: "index", name: "one_running_chat_turn" },
  { type: "index", name: "planner_tool_calls_turn_sequence" },
  { type: "table", name: "chat_turns" },
  { type: "table", name: "codex_native_mutation_receipts" },
  { type: "table", name: "codex_native_tool_calls" },
  { type: "table", name: "codex_thread_selection" },
  { type: "table", name: "codex_thread_start_admission" },
  { type: "table", name: "codex_turn_admissions" },
  { type: "table", name: "command_receipts" },
  { type: "table", name: "planner_events" },
  { type: "table", name: "planner_tool_calls" },
  { type: "table", name: "schema_migrations" },
  { type: "table", name: "transcript_entries" },
  { type: "table", name: "workspace" },
  { type: "trigger", name: "chat_turn_app_server_binding_immutable" },
  { type: "trigger", name: "chat_turn_foreground_authority_immutable" },
  { type: "trigger", name: "chat_turn_mode_linkage_insert" },
  { type: "trigger", name: "chat_turn_mode_linkage_update" },
  { type: "trigger", name: "chat_turn_research_candidate_digest_bound" },
  { type: "trigger", name: "chat_turn_research_candidate_insert_null" },
  { type: "trigger", name: "chat_turn_research_candidate_once" },
  { type: "trigger", name: "chat_turn_research_kind_immutable" },
  { type: "trigger", name: "chat_turn_research_lifecycle_insert" },
  { type: "trigger", name: "chat_turn_research_lifecycle_update" },
  { type: "trigger", name: "codex_thread_start_admission_reject_settled_insert" },
  { type: "trigger", name: "codex_thread_start_admission_reject_settled_update" },
  { type: "trigger", name: "codex_thread_start_admission_root_ids_insert" },
  { type: "trigger", name: "codex_thread_start_admission_root_ids_update" },
  { type: "trigger", name: "codex_turn_admission_reject_settled_insert" },
  { type: "trigger", name: "codex_turn_admission_reject_settled_update" },
]);

export function validatePlannerSchemaCatalogue(
  migrations: readonly PlannerSchemaMigration[] = PLANNER_SCHEMA_MIGRATIONS,
  currentVersion: number = CURRENT_SCHEMA_VERSION,
): void {
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new TypeError("The planner schema version must be a positive safe integer.");
  }
  if (migrations.length !== currentVersion) {
    throw new TypeError("The planner schema catalogue must contain every version through the declared current version.");
  }
  let previousVersion = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version !== previousVersion + 1) {
      throw new TypeError(`The planner schema catalogue is not contiguous at version ${previousVersion + 1}.`);
    }
    if (
      typeof migration.path !== "string" ||
      !migration.path.endsWith(".sql") ||
      !existsSync(migration.path)
    ) {
      throw new TypeError(`The planner schema migration ${migration.version} does not resolve to a SQL file.`);
    }
    previousVersion = migration.version;
  }
}

export function assertPlannerSchemaContract(): void {
  validatePlannerSchemaCatalogue();
  const identities = PLANNER_SCHEMA_OBJECTS.map(({ type, name }) => `${type}:${name}`);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError("The planner schema object contract contains duplicate identities.");
  }
  if (identities.some((identity, index) => index > 0 && identities[index - 1] > identity)) {
    throw new TypeError("The planner schema object contract must be ordered by type and name.");
  }
}
