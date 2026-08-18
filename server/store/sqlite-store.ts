import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  HISTORY_PAGE_LIMIT_MAX,
  WORKSPACE_EVENT_TAIL_LIMIT,
  type InitializedWorkspace,
  type OperationKind,
  type OperationReceipt,
  type PlannerEvent,
  type PlannerEventPage,
  type PlannerEventCommand,
  type TranscriptPage,
  type WorkspaceResponse,
} from "../../lib/planner-api-contract.ts";
import {
  WORKSPACE_CHAT_TURN_TAIL_LIMIT,
  WORKSPACE_TRANSCRIPT_TAIL_LIMIT,
  isChatResearchLifecycle,
  type ChatResearchLifecycle,
  type ChatTurn,
  type PlannerChatContext,
  type TranscriptEntry,
} from "../../lib/planner-chat-contract.ts";
import {
  createPlannerToolFailure,
  freezeForegroundAuthority,
  isPlannerToolResultForTool,
  PLANNER_TOOL_RESULT_BYTES_LIMIT,
  type PlannerToolResult,
} from "../../lib/planner-tool-contract.ts";
import type { HouseholdPlannerState } from "../../lib/household-contract.ts";
import { validateHouseholdState } from "../../lib/household-domain.ts";
import {
  normalizeLegacyHouseholdPayload,
  normalizeLegacyHouseholdState,
  upgradeHouseholdPayloadToIngredientOccurrences,
  upgradeHouseholdStateToIngredientOccurrences,
} from "../../lib/household-persistence-upgrade.ts";
import {
  isDigestBoundResearchCandidateReference,
  type ResearchCandidateReference,
} from "../../lib/sourced-recipe-contract.ts";
import type {
  EmbeddedTurnIdentity,
  EmbeddedTurnTerminalUpdate,
  NewRunningChatTurn,
  NewTranscriptEntry,
  PlannerToolCall,
  PlannerToolCallCompletion,
  PlannerToolCallReservation,
  PlannerToolCallReservationDecision,
} from "../application/ports.ts";
import {
  assertPlannerSchemaContract,
  CURRENT_SCHEMA_VERSION,
  PLANNER_SCHEMA_MIGRATIONS,
  type PlannerSchemaObject,
} from "./schema-contract.ts";

const DEFAULT_DATABASE_NAME = "planner.sqlite";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export type SqliteTransaction = DatabaseSync;

export type OpenPlannerStoreOptions = {
  /** Use `:memory:` for tests. When omitted, a file is created in `dataDirectory`. */
  filename?: string;
  dataDirectory?: string;
  busyTimeoutMs?: number;
};

export type VerifiedPlannerSnapshotInspection = Readonly<{
  filename: string;
  byteLength: number;
  sha256: string;
  quickCheck: "ok";
  schemaVersion: number;
  migrationVersions: readonly number[];
  schemaObjects: readonly PlannerSchemaObject[];
  initialized: boolean;
  workspaceSchemaVersion: number | null;
  plannerVersion: number | null;
}>;

export type PlannerStoreWriteReservation = Readonly<{
  filename: string;
  createVerifiedSnapshot(
    destinationFilename: string,
  ): VerifiedPlannerSnapshotInspection;
  close(): void;
}>;

type ReservedMigrationConnection = Readonly<{
  database: DatabaseSync;
  assertActive(): void;
  commit(): void;
}>;

type ReservedStoreOperations = Readonly<{
  createMigrationSnapshot(destinationFilename: string): VerifiedPlannerSnapshotInspection;
  migrationConnection: ReservedMigrationConnection;
}>;

const RESERVED_STORE_OPERATIONS = new WeakMap<
  PlannerStoreWriteReservation,
  ReservedStoreOperations
>();

type LogicalCell = readonly [sqliteType: string, value: string];
type LogicalTableInventory = Readonly<{
  sql: string | null;
  columns: readonly string[];
  rows: readonly (readonly LogicalCell[])[];
}>;
type LogicalInventory = Readonly<{
  schema: readonly Readonly<{ type: string; name: string; sql: string | null }>[];
  tables: Readonly<Record<string, LogicalTableInventory>>;
}>;

type SchemaDefinition = LogicalInventory["schema"][number];
const canonicalPlannerSchemaDefinitions = new Map<number, readonly SchemaDefinition[]>();

export type PlannerStoreV8ToV9MigrationResult = Readonly<{
  database: Readonly<{
    filename: string;
    quickCheck: "ok";
    schemaVersion: 9;
    migrationVersions: readonly [1, 2, 3, 4, 5, 6, 7, 8, 9];
    workspaceSchemaVersion: 9;
    rowCounts: Readonly<Record<string, number>>;
  }>;
  backup: VerifiedPlannerSnapshotInspection;
  migration: Readonly<{ from: 8; to: 9; allowedChanges: readonly ["schema_migrations:9", "workspace:household.schema_version"] }>;
}>;

export type PlannerStoreV9ToV10MigrationResult = Readonly<{
  database: Readonly<{
    filename: string;
    quickCheck: "ok";
    schemaVersion: 10;
    migrationVersions: readonly [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    workspaceSchemaVersion: 10;
    rowCounts: Readonly<Record<string, number>>;
  }>;
  backup: VerifiedPlannerSnapshotInspection | null;
  migration: Readonly<
    | {
      from: 9;
      to: 10;
      allowedChanges: readonly [
        "schema_migrations:10",
        "workspace:household.schema_version,state_json,sync_revision,updated_at",
        "planner_events:before_state_json",
        "planner_tool_calls:result_envelope_json",
        "codex_native_tool_calls:result_envelope_json",
      ];
    }
    | { from: 10; to: 10; allowedChanges: readonly [] }
  >;
}>;

export class PlannerStoreError extends Error {
  readonly code: "STORE_CORRUPT" | "MIGRATION_FAILED" | "NOT_INITIALIZED" | "BUSY";
  readonly migrationBackupPath: string | null;

  constructor(
    code: PlannerStoreError["code"],
    message: string,
    options?: ErrorOptions & { migrationBackupPath?: string | null },
  ) {
    const { migrationBackupPath = null, ...errorOptions } = options ?? {};
    super(message, errorOptions);
    this.name = "PlannerStoreError";
    this.code = code;
    this.migrationBackupPath = migrationBackupPath;
  }
}

type WorkspaceRow = {
  schema_version: number;
  planner_version: number;
  sync_revision: number;
  state_json: string;
  created_at: number;
  updated_at: number;
};

type EventRow = {
  sequence: number;
  event_id: string;
  request_id: string;
  actor: "Household" | "Codex";
  actor_source: PlannerEvent["provenance"]["actorSource"];
  admission: PlannerEvent["provenance"]["admission"];
  command_json: string;
  base_version: number;
  result_version: number;
  summary: string;
  target: string;
  changes_json: string;
  before_state_json: string;
  reverts_event_id: string | null;
  chat_turn_id: string | null;
  occurred_at: number;
};

type TranscriptRow = {
  sequence: number;
  entry_id: string;
  role: TranscriptEntry["role"];
  text: string;
  context_json: string | null;
  turn_id: string | null;
  occurred_at: number;
};

type ChatTurnRow = {
  turn_id: string;
  request_id: string;
  turn_sequence: number;
  status: ChatTurn["status"];
  user_entry_id: string;
  context_json: string;
  input_planner_version: number;
  reply_entry_id: string | null;
  proposed_command_json: string | null;
  mutation_outcome: ChatTurn["mutationOutcome"];
  retry_of_turn_id: string | null;
  mode: ChatTurn["mode"];
  research_kind: ChatTurn["researchKind"];
  research_candidate_json: string | null;
  completion_token_hash: string | null;
  app_server_thread_id: string | null;
  app_server_turn_id: string | null;
  foreground_authority_json: string;
  accepted_effect_count: number;
  last_effect_sequence: number;
  recovery_of_turn_id: string | null;
  terminal_outcome: ChatTurn["terminalOutcome"];
  error_code: string | null;
  error_detail: string | null;
  created_at: number;
  started_at: number;
  completed_at: number | null;
};

type PlannerToolCallRow = {
  turn_id: string;
  tool_call_id: string;
  app_server_thread_id: string;
  app_server_turn_id: string;
  app_server_call_id: string;
  callback_identity_hash: string;
  sequence: number;
  completion_token_hash: string;
  tool: PlannerToolCall["tool"];
  argument_hash: string;
  status: PlannerToolCall["status"];
  result_code: string | null;
  operation_kind: PlannerToolCall["operationKind"];
  request_id: string | null;
  event_id: string | null;
  base_planner_version: number | null;
  result_planner_version: number | null;
  effect_sequence: number | null;
  result_envelope_json: string | null;
  created_at: number;
  completed_at: number | null;
};

type ReceiptRow = {
  operation_kind: OperationKind;
  request_id: string;
  payload_hash: string;
  http_status: number;
  decision_json: string;
  created_at: number;
};

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      `Stored ${label} is not valid JSON.`,
      { cause: error },
    );
  }
}

function normalizeStoredLegacyHouseholdState(database: DatabaseSync, transactionOwned = false): void {
  if (!transactionOwned) try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw new PlannerStoreError("MIGRATION_FAILED", "Legacy household state normalization could not start.", { cause: error });
  }

  try {
    const assertNormalizedState = (state: HouseholdPlannerState, label: string) => {
      const validation = validateHouseholdState(state);
      if (!validation.ok) throw new PlannerStoreError("MIGRATION_FAILED", `${label} is invalid after ingredient catalogue migration: ${validation.issues.map(({ path, message }) => `${path}: ${message}`).join("; ")}`);
    };
    const workspace = database
      .prepare("SELECT state_json FROM workspace WHERE id = 'household'")
      .get() as { state_json: string } | undefined;
    if (workspace) {
      const normalized = normalizeLegacyHouseholdState(
        parseJson<HouseholdPlannerState>(workspace.state_json, "workspace state"),
      );
      assertNormalizedState(normalized.state, "Workspace state");
      if (normalized.changed) {
        database
          .prepare(
            `UPDATE workspace
             SET state_json = ?, sync_revision = sync_revision + 1, updated_at = ?
             WHERE id = 'household'`,
          )
          .run(JSON.stringify(normalized.state), Date.now());
      }
    }

    const events = database
      .prepare("SELECT sequence, before_state_json FROM planner_events")
      .all() as Array<{ sequence: number; before_state_json: string }>;
    const updateEvent = database.prepare(
      "UPDATE planner_events SET before_state_json = ? WHERE sequence = ?",
    );
    for (const event of events) {
      const normalized = normalizeLegacyHouseholdState(
        parseJson<HouseholdPlannerState>(
          event.before_state_json,
          "planner event undo state",
        ),
      );
      assertNormalizedState(normalized.state, "Planner event undo state");
      if (normalized.changed) {
        updateEvent.run(JSON.stringify(normalized.state), event.sequence);
      }
    }

    const chatTurns = database
      .prepare(
        "SELECT turn_id, proposed_command_json FROM chat_turns WHERE proposed_command_json IS NOT NULL",
      )
      .all() as Array<{ turn_id: string; proposed_command_json: string }>;
    const updateChatTurn = database.prepare(
      "UPDATE chat_turns SET proposed_command_json = ? WHERE turn_id = ?",
    );
    for (const turn of chatTurns) {
      const normalized = normalizeLegacyHouseholdPayload(
        parseJson<unknown>(turn.proposed_command_json, "proposed planner command"),
      );
      if (normalized.changed) updateChatTurn.run(JSON.stringify(normalized.value), turn.turn_id);
    }

    const toolCalls = database
      .prepare(
        "SELECT turn_id, tool_call_id, result_envelope_json FROM planner_tool_calls WHERE result_envelope_json IS NOT NULL",
      )
      .all() as Array<{ turn_id: string; tool_call_id: string; result_envelope_json: string }>;
    const updateToolResult = database.prepare(
      "UPDATE planner_tool_calls SET result_envelope_json = ? WHERE turn_id = ? AND tool_call_id = ?",
    );
    for (const toolCall of toolCalls) {
      const normalized = normalizeLegacyHouseholdPayload(
        parseJson<unknown>(toolCall.result_envelope_json, "planner tool result"),
      );
      if (normalized.changed) {
        updateToolResult.run(
          JSON.stringify(normalized.value),
          toolCall.turn_id,
          toolCall.tool_call_id,
        );
      }
    }
    const nativeToolCalls = database.prepare(
      "SELECT thread_id, turn_id, call_id, result_envelope_json FROM codex_native_tool_calls WHERE result_envelope_json IS NOT NULL",
    ).all() as Array<{ thread_id: string; turn_id: string; call_id: string; result_envelope_json: string }>;
    const updateNativeToolResult = database.prepare(
      "UPDATE codex_native_tool_calls SET result_envelope_json = ? WHERE thread_id = ? AND turn_id = ? AND call_id = ?",
    );
    for (const toolCall of nativeToolCalls) {
      const normalized = normalizeLegacyHouseholdPayload(parseJson<unknown>(toolCall.result_envelope_json, "native planner tool result"));
      if (normalized.changed) updateNativeToolResult.run(JSON.stringify(normalized.value), toolCall.thread_id, toolCall.turn_id, toolCall.call_id);
    }
    if (!transactionOwned) database.exec("COMMIT");
  } catch (error) {
    if (!transactionOwned) try { database.exec("ROLLBACK"); } catch { /* Preserve the normalization failure. */ }
    if (error instanceof PlannerStoreError) throw error;
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      "Legacy household state normalization failed.",
      { cause: error },
    );
  }
}

type IngredientOccurrenceUpgradeIssue = Readonly<{ path: string; message: string }>;

function occurrenceUpgradeFailure(issues: readonly IngredientOccurrenceUpgradeIssue[]): PlannerStoreError {
  const detail = issues.map(({ path, message }) => `${path}: ${message}`).join("; ");
  return new PlannerStoreError(
    "MIGRATION_FAILED",
    `Schema-9 ingredient occurrence migration is ambiguous: ${detail}`,
  );
}

function appendHouseholdStateValidationIssues(
  state: HouseholdPlannerState,
  path: string,
  issues: IngredientOccurrenceUpgradeIssue[],
): void {
  const validation = validateHouseholdState(state, { allowMissingIngredientCatalogue: true });
  if (validation.ok) return;
  for (const issue of validation.issues) {
    issues.push({
      path: `${path}${issue.path === "$" ? "" : issue.path.slice(1)}`,
      message: issue.message,
    });
  }
}

function persistedEventOperationCount(database: DatabaseSync, eventId: string | null): number {
  if (eventId === null) return 1;
  const row = database.prepare("SELECT command_json FROM planner_events WHERE event_id = ?").get(eventId) as { command_json: string } | undefined;
  if (!row) return 1;
  const command = parseJson<unknown>(row.command_json, `planner event ${eventId} command`);
  if (command === null || typeof command !== "object" || Array.isArray(command)) return 1;
  const operations = (command as Record<string, unknown>).operations;
  return (command as Record<string, unknown>).type === "plannerBatch" && Array.isArray(operations)
    ? operations.length
    : 1;
}

function assertNoSqliteSidecars(filename: string): void {
  if (existsSync(`${filename}-wal`) || existsSync(`${filename}-shm`)) {
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      "Schema-9 ingredient occurrence migration requires a checkpointed source without WAL or SHM sidecars.",
    );
  }
}

function withClosedPreflightDatabase<Result>(
  filename: string,
  work: (database: DatabaseSync) => Result,
): Result {
  const sidecars = [`${filename}-wal`, `${filename}-shm`].filter((artifact) => existsSync(artifact));
  if (sidecars.length === 0) {
    const immutableUrl = pathToFileURL(filename);
    immutableUrl.searchParams.set("mode", "ro");
    immutableUrl.searchParams.set("immutable", "1");
    const database = new DatabaseSync(immutableUrl, { readOnly: true });
    try {
      return work(database);
    } finally {
      database.close();
      assertNoSqliteSidecars(filename);
    }
  }

  const copyDirectory = mkdtempSync(join(dirname(filename), ".planner-preflight-"));
  const copyFilename = join(copyDirectory, basename(filename));
  try {
    copyFileSync(filename, copyFilename);
    for (const sidecar of sidecars) {
      copyFileSync(sidecar, join(copyDirectory, basename(sidecar)));
    }
    const database = new DatabaseSync(copyFilename, { readOnly: true });
    try {
      return work(database);
    } finally {
      database.close();
    }
  } finally {
    rmSync(copyDirectory, { recursive: true, force: true });
  }
}

/**
 * Read all persisted household-shaped JSON with SQLite's immutable URI mode.
 * This is deliberately separate from the writer: opening a normal read-only
 * connection to a WAL database can create sidecars, which would invalidate the
 * non-mutation guarantee on an ambiguous source.
 */
function preflightV9IngredientOccurrenceUpgrade(filename: string): void {
  assertNoSqliteSidecars(filename);
  const immutableUrl = pathToFileURL(filename);
  immutableUrl.searchParams.set("mode", "ro");
  immutableUrl.searchParams.set("immutable", "1");
  const database = new DatabaseSync(immutableUrl, { readOnly: true });
  try {
    assertCoherentV9Store(database);
    const issues: IngredientOccurrenceUpgradeIssue[] = [];
    const inspectState = (text: string, path: string) => {
      const upgraded = upgradeHouseholdStateToIngredientOccurrences(parseJson<unknown>(text, path));
      if (!upgraded.ok) {
        for (const issue of upgraded.issues) {
          issues.push({ path: `${path}${issue.path ? `.${issue.path}` : ""}`, message: issue.message });
        }
      } else {
        appendHouseholdStateValidationIssues(upgraded.state, path, issues);
      }
    };
    const inspectPayload = (text: string, path: string, operationCount = 1) => {
      const upgraded = upgradeHouseholdPayloadToIngredientOccurrences(parseJson<unknown>(text, path), operationCount);
      if (!upgraded.ok) {
        for (const issue of upgraded.issues) {
          issues.push({ path: `${path}${issue.path ? `.${issue.path}` : ""}`, message: issue.message });
        }
      }
    };
    const workspace = database.prepare("SELECT state_json FROM workspace WHERE id = 'household'").get() as { state_json: string };
    inspectState(workspace.state_json, "workspace.state_json");
    for (const event of database.prepare("SELECT sequence, before_state_json FROM planner_events").all() as Array<{ sequence: number; before_state_json: string }>) {
      inspectState(event.before_state_json, `planner_events[${event.sequence}].before_state_json`);
    }
    for (const row of database.prepare(
      "SELECT turn_id, tool_call_id, event_id, result_envelope_json FROM planner_tool_calls WHERE result_envelope_json IS NOT NULL",
    ).all() as Array<{ turn_id: string; tool_call_id: string; event_id: string | null; result_envelope_json: string }>) {
      inspectPayload(row.result_envelope_json, `planner_tool_calls[${row.turn_id},${row.tool_call_id}].result_envelope_json`, persistedEventOperationCount(database, row.event_id));
    }
    for (const row of database.prepare(
      "SELECT thread_id, turn_id, call_id, event_id, result_envelope_json FROM codex_native_tool_calls WHERE result_envelope_json IS NOT NULL",
    ).all() as Array<{ thread_id: string; turn_id: string; call_id: string; event_id: string | null; result_envelope_json: string }>) {
      inspectPayload(row.result_envelope_json, `codex_native_tool_calls[${row.thread_id},${row.turn_id},${row.call_id}].result_envelope_json`, persistedEventOperationCount(database, row.event_id));
    }
    if (issues.length > 0) throw occurrenceUpgradeFailure(issues);
  } finally {
    database.close();
  }
  assertNoSqliteSidecars(filename);
}

/** Fail legacy semantic normalization before generic SQL migrations can write. */
function preflightPreV9HouseholdNormalization(filename: string): void {
  withClosedPreflightDatabase(filename, (database) => {
    const inspectState = (text: string, label: string) => {
      try {
        const normalized = normalizeLegacyHouseholdState(parseJson<HouseholdPlannerState>(text, label));
        const upgraded = upgradeHouseholdStateToIngredientOccurrences(normalized.state);
        if (!upgraded.ok) {
          throw occurrenceUpgradeFailure(upgraded.issues.map((issue) => ({
            path: `${label}${issue.path ? `.${issue.path}` : ""}`,
            message: issue.message,
          })));
        }
        const validationIssues: IngredientOccurrenceUpgradeIssue[] = [];
        appendHouseholdStateValidationIssues(upgraded.state, label, validationIssues);
        if (validationIssues.length > 0) throw occurrenceUpgradeFailure(validationIssues);
      } catch (error) {
        if (error instanceof PlannerStoreError) throw error;
        const detail = error instanceof Error ? ` ${error.message}` : "";
        throw new PlannerStoreError("MIGRATION_FAILED", `Legacy household state normalization failed at ${label}.${detail}`, { cause: error });
      }
    };
    const inspectPayload = (text: string, label: string) => {
      try {
        const normalized = normalizeLegacyHouseholdPayload(parseJson<unknown>(text, label));
        const upgraded = upgradeHouseholdPayloadToIngredientOccurrences(normalized.value);
        if (!upgraded.ok) {
          throw occurrenceUpgradeFailure(upgraded.issues.map((issue) => ({
            path: `${label}${issue.path ? `.${issue.path}` : ""}`,
            message: issue.message,
          })));
        }
      } catch (error) {
        if (error instanceof PlannerStoreError) throw error;
        const detail = error instanceof Error ? ` ${error.message}` : "";
        throw new PlannerStoreError("MIGRATION_FAILED", `Legacy household payload normalization failed at ${label}.${detail}`, { cause: error });
      }
    };
    if (hasTableColumns(database, "workspace", ["id", "state_json"])) {
      const workspace = database.prepare("SELECT state_json FROM workspace WHERE id = 'household'").get() as { state_json: string } | undefined;
      if (workspace) inspectState(workspace.state_json, "workspace.state_json");
    }
    if (hasTableColumns(database, "planner_events", ["sequence", "before_state_json"])) {
      for (const row of database.prepare("SELECT sequence, before_state_json FROM planner_events").all() as Array<{ sequence: number; before_state_json: string }>) {
        inspectState(row.before_state_json, `planner_events[${row.sequence}].before_state_json`);
      }
    }
    if (hasTableColumns(database, "chat_turns", ["turn_id", "proposed_command_json"])) {
      for (const row of database.prepare("SELECT turn_id, proposed_command_json FROM chat_turns WHERE proposed_command_json IS NOT NULL").all() as Array<{ turn_id: string; proposed_command_json: string }>) {
        inspectPayload(row.proposed_command_json, `chat_turns[${row.turn_id}].proposed_command_json`);
      }
    }
    if (hasTableColumns(database, "planner_tool_calls", ["turn_id", "tool_call_id", "result_envelope_json"])) {
      for (const row of database.prepare("SELECT turn_id, tool_call_id, result_envelope_json FROM planner_tool_calls WHERE result_envelope_json IS NOT NULL").all() as Array<{ turn_id: string; tool_call_id: string; result_envelope_json: string }>) {
        inspectPayload(row.result_envelope_json, `planner_tool_calls[${row.turn_id},${row.tool_call_id}].result_envelope_json`);
      }
    }
    if (hasTableColumns(database, "codex_native_tool_calls", ["thread_id", "turn_id", "call_id", "result_envelope_json"])) {
      for (const row of database.prepare("SELECT thread_id, turn_id, call_id, result_envelope_json FROM codex_native_tool_calls WHERE result_envelope_json IS NOT NULL").all() as Array<{ thread_id: string; turn_id: string; call_id: string; result_envelope_json: string }>) {
        inspectPayload(row.result_envelope_json, `codex_native_tool_calls[${row.thread_id},${row.turn_id},${row.call_id}].result_envelope_json`);
      }
    }
  });
}

function applyV9IngredientOccurrenceUpgrade(database: DatabaseSync, write = true): void {
  const issues: IngredientOccurrenceUpgradeIssue[] = [];
  const upgradeState = (text: string, path: string) => {
    const upgraded = upgradeHouseholdStateToIngredientOccurrences(parseJson<unknown>(text, path));
    if (!upgraded.ok) {
      issues.push(...upgraded.issues.map((issue) => ({
        path: `${path}${issue.path ? `.${issue.path}` : ""}`,
        message: issue.message,
      })));
      return null;
    }
    appendHouseholdStateValidationIssues(upgraded.state, path, issues);
    return upgraded;
  };
  const upgradePayload = (text: string, path: string, operationCount = 1) => {
    const upgraded = upgradeHouseholdPayloadToIngredientOccurrences(parseJson<unknown>(text, path), operationCount);
    if (!upgraded.ok) {
      issues.push(...upgraded.issues.map((issue) => ({
        path: `${path}${issue.path ? `.${issue.path}` : ""}`,
        message: issue.message,
      })));
      return null;
    }
    return upgraded;
  };

  const workspace = database.prepare(
    "SELECT state_json FROM workspace WHERE id = 'household'",
  ).get() as { state_json: string } | undefined;
  if (!workspace) return;
  const upgradedWorkspace = upgradeState(workspace.state_json, "workspace.state_json");
  const eventRows = database.prepare("SELECT sequence, before_state_json FROM planner_events").all() as Array<{
    sequence: number;
    before_state_json: string;
  }>;
  const upgradedEvents = eventRows.map((event) => ({
    event,
    upgraded: upgradeState(event.before_state_json, `planner_events[${event.sequence}].before_state_json`),
  }));
  const toolRows = database.prepare(
    "SELECT turn_id, tool_call_id, event_id, result_envelope_json FROM planner_tool_calls WHERE result_envelope_json IS NOT NULL",
  ).all() as Array<{ turn_id: string; tool_call_id: string; event_id: string | null; result_envelope_json: string }>;
  const upgradedTools = toolRows.map((row) => ({
    row,
    upgraded: upgradePayload(row.result_envelope_json, `planner_tool_calls[${row.turn_id},${row.tool_call_id}].result_envelope_json`, persistedEventOperationCount(database, row.event_id)),
  }));
  const nativeRows = database.prepare(
    "SELECT thread_id, turn_id, call_id, event_id, result_envelope_json FROM codex_native_tool_calls WHERE result_envelope_json IS NOT NULL",
  ).all() as Array<{ thread_id: string; turn_id: string; call_id: string; event_id: string | null; result_envelope_json: string }>;
  const upgradedNativeTools = nativeRows.map((row) => ({
    row,
    upgraded: upgradePayload(row.result_envelope_json, `codex_native_tool_calls[${row.thread_id},${row.turn_id},${row.call_id}].result_envelope_json`, persistedEventOperationCount(database, row.event_id)),
  }));
  if (issues.length > 0) throw occurrenceUpgradeFailure(issues);
  if (!write) return;

  if (upgradedWorkspace?.changed) {
    database.prepare(
      `UPDATE workspace
       SET state_json = ?, sync_revision = sync_revision + 1, updated_at = ?
       WHERE id = 'household'`,
    ).run(JSON.stringify(upgradedWorkspace.state), Date.now());
  }
  const updateEvent = database.prepare("UPDATE planner_events SET before_state_json = ? WHERE sequence = ?");
  for (const { event, upgraded } of upgradedEvents) {
    if (upgraded?.changed) updateEvent.run(JSON.stringify(upgraded.state), event.sequence);
  }
  const updateTool = database.prepare(
    "UPDATE planner_tool_calls SET result_envelope_json = ? WHERE turn_id = ? AND tool_call_id = ?",
  );
  for (const { row, upgraded } of upgradedTools) {
    if (upgraded?.changed) updateTool.run(JSON.stringify(upgraded.value), row.turn_id, row.tool_call_id);
  }
  const updateNativeTool = database.prepare(
    "UPDATE codex_native_tool_calls SET result_envelope_json = ? WHERE thread_id = ? AND turn_id = ? AND call_id = ?",
  );
  for (const { row, upgraded } of upgradedNativeTools) {
    if (upgraded?.changed) updateNativeTool.run(JSON.stringify(upgraded.value), row.thread_id, row.turn_id, row.call_id);
  }
}

function asNumber(value: number | bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new PlannerStoreError("STORE_CORRUPT", "SQLite sequence exceeds the safe integer range.");
  }
  return number;
}

function workspaceState(row: WorkspaceRow): HouseholdPlannerState {
  return parseJson<HouseholdPlannerState>(row.state_json, "workspace state");
}

function mapEvent(row: EventRow): PlannerEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    requestId: row.request_id,
    actor: row.actor,
    provenance: {
      actorClass: row.actor === "Household" ? "household" : "codex",
      actorSource: row.actor_source,
      admission: row.admission,
    } as PlannerEvent["provenance"],
    command: parseJson<PlannerEventCommand>(row.command_json, "planner event command"),
    baseVersion: row.base_version,
    resultVersion: row.result_version,
    summary: row.summary,
    target: row.target,
    changes: parseJson<string[]>(row.changes_json, "planner event changes"),
    revertsEventId: row.reverts_event_id,
    chatTurnId: row.chat_turn_id,
    occurredAt: row.occurred_at,
  };
}

function mapTranscript(row: TranscriptRow): TranscriptEntry {
  return {
    sequence: row.sequence,
    entryId: row.entry_id,
    role: row.role,
    text: row.text,
    context:
      row.context_json === null
        ? null
        : parseJson<PlannerChatContext>(row.context_json, "transcript context"),
    turnId: row.turn_id,
    occurredAt: row.occurred_at,
  };
}

function mapChatTurn(row: ChatTurnRow): ChatTurn {
  const researchCandidateValue = row.research_candidate_json === null
    ? null
    : parseJson<unknown>(row.research_candidate_json, "research candidate reference");
  const researchLifecycleValue = {
    mode: row.mode,
    researchKind: row.research_kind,
    researchCandidate: researchCandidateValue,
  };
  if (!isChatResearchLifecycle(researchLifecycleValue)) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "Stored chat turn has an invalid research lifecycle or candidate reference.",
    );
  }
  const researchLifecycle = researchLifecycleValue as ChatResearchLifecycle;
  return {
    turnId: row.turn_id,
    requestId: row.request_id,
    turnSequence: row.turn_sequence,
    status: row.status,
    userEntryId: row.user_entry_id,
    context: parseJson<PlannerChatContext>(row.context_json, "chat context"),
    inputPlannerVersion: row.input_planner_version,
    replyEntryId: row.reply_entry_id,
    proposedCommand:
      row.proposed_command_json === null
        ? null
        : parseJson<ChatTurn["proposedCommand"]>(
            row.proposed_command_json,
            "proposed planner command",
          ),
    mutationOutcome: row.mutation_outcome,
    retryOfTurnId: row.retry_of_turn_id,
    ...researchLifecycle,
    completionTokenHash: row.completion_token_hash,
    appServerThreadId: row.app_server_thread_id,
    appServerTurnId: row.app_server_turn_id,
    foregroundAuthority: freezeForegroundAuthority(
      parseJson<unknown>(row.foreground_authority_json, "foreground authority"),
    ),
    acceptedEffectCount: row.accepted_effect_count,
    lastEffectSequence: row.last_effect_sequence,
    recoveryOfTurnId: row.recovery_of_turn_id,
    terminalOutcome: row.terminal_outcome,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapPlannerToolCall(row: PlannerToolCallRow): PlannerToolCall {
  if (
    row.result_envelope_json !== null &&
    Buffer.byteLength(row.result_envelope_json, "utf8") > PLANNER_TOOL_RESULT_BYTES_LIMIT
  ) {
    throw new PlannerStoreError("STORE_CORRUPT", "Stored planner tool result exceeds its bound.");
  }
  const parsedEnvelope = row.result_envelope_json === null
    ? null
    : parseJson<unknown>(row.result_envelope_json, "planner tool result");
  if (
    parsedEnvelope !== null &&
    (!isPlannerToolResultForTool(row.tool, parsedEnvelope) ||
      parsedEnvelope.callId !== row.app_server_call_id)
  ) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "Stored planner tool result does not match its closed call contract.",
    );
  }
  return {
    turnId: row.turn_id,
    toolCallId: row.tool_call_id,
    appServerThreadId: row.app_server_thread_id,
    appServerTurnId: row.app_server_turn_id,
    appServerCallId: row.app_server_call_id,
    callbackIdentityHash: row.callback_identity_hash,
    sequence: row.sequence,
    completionTokenHash: row.completion_token_hash,
    tool: row.tool,
    argumentHash: row.argument_hash,
    status: row.status,
    resultCode: row.result_code,
    operationKind: row.operation_kind,
    requestId: row.request_id,
    eventId: row.event_id,
    basePlannerVersion: row.base_planner_version,
    resultPlannerVersion: row.result_planner_version,
    effectSequence: row.effect_sequence,
    resultEnvelope: parsedEnvelope as PlannerToolResult | null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapReceipt(row: ReceiptRow): OperationReceipt {
  return {
    operationKind: row.operation_kind,
    requestId: row.request_id,
    payloadHash: row.payload_hash,
    httpStatus: row.http_status,
    decision: parseJson<unknown>(row.decision_json, "operation receipt decision"),
    createdAt: row.created_at,
  };
}

function resolveDatabaseFilename(options: OpenPlannerStoreOptions): string {
  if (options.filename) return options.filename;
  const directory = resolve(
    options.dataDirectory ?? process.env.PLANNER_DATA_DIR ?? ".planner-data",
  );
  return resolve(directory, DEFAULT_DATABASE_NAME);
}

function configureDatabase(database: DatabaseSync, busyTimeoutMs: number, isMemory: boolean) {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec("PRAGMA synchronous = FULL");
  if (!isMemory) database.exec("PRAGMA journal_mode = WAL");
}

function quickCheck(database: DatabaseSync): void {
  let rows: Array<{ quick_check: string }>;
  try {
    rows = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
  } catch (error) {
    throw new PlannerStoreError("STORE_CORRUPT", "SQLite quick_check could not run.", {
      cause: error,
    });
  }
  if (rows.length !== 1 || rows[0].quick_check !== "ok") {
    const detail = rows.map((row) => row.quick_check).join("; ") || "unknown failure";
    throw new PlannerStoreError("STORE_CORRUPT", `SQLite quick_check failed: ${detail}`);
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { errcode?: unknown; errstr?: unknown; message?: unknown };
  return (
    candidate.errcode === 5 ||
    candidate.errstr === "database is locked" ||
    (typeof candidate.message === "string" && /database is (?:busy|locked)/i.test(candidate.message))
  );
}

type StoreFileIdentity = {
  dev: number;
  ino: number;
  uid: number;
};

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "SQLite release snapshots require a Unix user identity.",
    );
  }
  return process.getuid();
}

function sameStoreFileIdentity(
  left: StoreFileIdentity,
  right: StoreFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function readCanonicalStoreFileIdentity(filename: string): StoreFileIdentity {
  const absoluteFilename = resolve(filename);
  const stats = lstatSync(absoluteFilename);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "The SQLite snapshot source must be a real regular file.",
    );
  }
  if (stats.uid !== currentUid()) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "The SQLite snapshot source must be owned by the current user.",
    );
  }
  if (realpathSync(absoluteFilename) !== absoluteFilename) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "The SQLite snapshot source must use its real canonical path.",
    );
  }
  return { dev: stats.dev, ino: stats.ino, uid: stats.uid };
}

function canonicalSnapshotDestination(destinationFilename: string): string {
  const parent = dirname(destinationFilename);
  const stats = lstatSync(parent);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "The SQLite snapshot destination parent must be a real directory.",
    );
  }
  if (stats.uid !== currentUid()) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "The SQLite snapshot destination parent must be current-user owned.",
    );
  }
  return resolve(realpathSync(parent), basename(destinationFilename));
}

function syncFileAndParent(filename: string): void {
  const file = openSync(filename, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  const parent = openSync(dirname(filename), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function hashClosedRegularFile(filename: string): {
  byteLength: number;
  sha256: string;
  identity: StoreFileIdentity;
} {
  const descriptor = openSync(filename, "r");
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.uid !== currentUid()) {
      throw new PlannerStoreError(
        "STORE_CORRUPT",
        "The closed SQLite snapshot has an unsafe file identity.",
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let byteLength = 0;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return {
      byteLength,
      sha256: hash.digest("hex"),
      identity: { dev: stats.dev, ino: stats.ino, uid: stats.uid },
    };
  } finally {
    closeSync(descriptor);
  }
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function hasTableColumns(database: DatabaseSync, table: string, columns: readonly string[]): boolean {
  if (!hasTable(database, table)) return false;
  const present = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name),
  );
  return columns.every((column) => present.has(column));
}

function readAppliedMigrationVersions(database: DatabaseSync): number[] {
  if (!hasTable(database, "schema_migrations")) return [];
  const versions = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => Number((row as { version: number }).version));
  for (const [index, version] of versions.entries()) {
    if (!Number.isSafeInteger(version) || version !== index + 1) {
      throw new PlannerStoreError(
        "MIGRATION_FAILED",
        `Database migration ledger is not contiguous at version ${index + 1}.`,
      );
    }
  }
  return versions;
}

function readCurrentMigrationVersion(database: DatabaseSync): number {
  if (hasTable(database, "schema_migrations")) {
    const maximum = Number(
      (database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as {
        version: number;
      }).version,
    );
    if (!Number.isSafeInteger(maximum) || maximum < 0) {
      throw new PlannerStoreError("MIGRATION_FAILED", "Database migration version is invalid.");
    }
    // Preserve the more actionable forward-incompatibility result even when a
    // newer implementation uses a ledger shape this binary cannot interpret.
    if (maximum > CURRENT_SCHEMA_VERSION) return maximum;
  }
  return readAppliedMigrationVersions(database).at(-1) ?? 0;
}

function readCurrentMigrationVersionReadOnly(filename: string): number {
  return withClosedPreflightDatabase(filename, (database) => {
    quickCheck(database);
    return readCurrentMigrationVersion(database);
  });
}

function readPlannerSchemaObjects(database: DatabaseSync): PlannerSchemaObject[] {
  return database
    .prepare(
      "SELECT type, name FROM sqlite_master " +
      "WHERE type IN ('index', 'table', 'trigger') AND name NOT LIKE 'sqlite_%' " +
      "ORDER BY type, name",
    )
    .all()
    .map((row) => {
      const { type, name } = row as { type: string; name: string };
      if (type !== "index" && type !== "table" && type !== "trigger") {
        throw new PlannerStoreError("STORE_CORRUPT", "The SQLite schema object type is invalid.");
      }
      return Object.freeze({ type, name });
    });
}

function assertSupportedMigrationVersion(currentVersion: number): void {
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      `Database schema ${currentVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}.`,
    );
  }
}

function inspectPlannerSnapshot(
  filename: string,
  options: { allowUnrecognizedWorkspace?: boolean } = {},
): VerifiedPlannerSnapshotInspection {
  const canonicalFilename = realpathSync(resolve(filename));
  const identityBefore = readCanonicalStoreFileIdentity(canonicalFilename);
  const database = new DatabaseSync(canonicalFilename, { readOnly: true });
  let schemaVersion = 0;
  let migrationVersions: readonly number[] = [];
  let schemaObjects: readonly PlannerSchemaObject[] = [];
  let initialized = false;
  let workspaceSchemaVersion: number | null = null;
  let plannerVersion: number | null = null;
  try {
    quickCheck(database);
    migrationVersions = readAppliedMigrationVersions(database);
    schemaVersion = migrationVersions.at(-1) ?? 0;
    schemaObjects = readPlannerSchemaObjects(database);
    if (hasTable(database, "workspace")) {
      let row: { schema_version: number; planner_version: number } | undefined;
      try {
        row = database.prepare(
          "SELECT schema_version, planner_version FROM workspace WHERE id = 'household'",
        ).get() as { schema_version: number; planner_version: number } | undefined;
      } catch (error) {
        if (options.allowUnrecognizedWorkspace === true) {
          row = undefined;
        } else {
          throw new PlannerStoreError(
            "STORE_CORRUPT",
            "The SQLite snapshot workspace metadata could not be inspected.",
            { cause: error },
          );
        }
      }
      if (row !== undefined) {
        if (
          !Number.isSafeInteger(row.schema_version) || row.schema_version < 0 ||
          !Number.isSafeInteger(row.planner_version) || row.planner_version < 0
        ) {
          if (options.allowUnrecognizedWorkspace === true) {
            row = undefined;
          } else {
            throw new PlannerStoreError(
              "STORE_CORRUPT",
              "The SQLite snapshot workspace metadata is invalid.",
            );
          }
        }
        if (row !== undefined) {
          initialized = true;
          workspaceSchemaVersion = row.schema_version;
          plannerVersion = row.planner_version;
        }
      }
    }
  } finally {
    database.close();
  }

  const hashed = hashClosedRegularFile(canonicalFilename);
  const identityAfter = readCanonicalStoreFileIdentity(canonicalFilename);
  if (
    !sameStoreFileIdentity(identityBefore, hashed.identity) ||
    !sameStoreFileIdentity(identityBefore, identityAfter)
  ) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "The closed SQLite snapshot identity changed during inspection.",
    );
  }
  return Object.freeze({
    filename: canonicalFilename,
    byteLength: hashed.byteLength,
    sha256: hashed.sha256,
    quickCheck: "ok" as const,
    schemaVersion,
    migrationVersions,
    schemaObjects,
    initialized,
    workspaceSchemaVersion,
    plannerVersion,
  });
}

export function inspectVerifiedPlannerSnapshot(
  filename: string,
): VerifiedPlannerSnapshotInspection {
  return inspectPlannerSnapshot(filename);
}

export function inspectVerifiedPlannerSchema10Snapshot(
  filename: string,
): VerifiedPlannerSnapshotInspection {
  const before = inspectPlannerSnapshot(filename);
  const database = new DatabaseSync(before.filename, { readOnly: true });
  try {
    assertCoherentV10Store(database);
  } finally {
    database.close();
  }
  const after = inspectPlannerSnapshot(filename);
  if (before.sha256 !== after.sha256) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "The schema-10 SQLite snapshot changed during exact verification.",
    );
  }
  return after;
}

function removeSnapshotArtifacts(filename: string): void {
  for (const artifact of [filename, `${filename}-wal`, `${filename}-shm`]) {
    rmSync(artifact, { force: true });
  }
}

function checkpointAndVerifySnapshot(filename: string): void {
  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA synchronous = FULL");
    database.prepare("PRAGMA journal_mode = WAL").get();
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: number }
      | undefined;
    if (checkpoint?.busy !== undefined && checkpoint.busy !== 0) {
      throw new PlannerStoreError(
        "STORE_CORRUPT",
        "The SQLite snapshot WAL could not be checkpointed completely.",
      );
    }
    database.prepare("PRAGMA journal_mode = DELETE").get();
    quickCheck(database);
  } finally {
    database.close();
  }
  for (const sidecar of [`${filename}-wal`, `${filename}-shm`]) {
    if (existsSync(sidecar)) {
      if (statSync(sidecar).size !== 0) {
        throw new PlannerStoreError(
          "STORE_CORRUPT",
          "The closed SQLite snapshot retained a non-empty sidecar.",
        );
      }
      rmSync(sidecar);
    }
  }
  syncFileAndParent(filename);
}

export function acquirePlannerStoreWriteReservation({
  filename,
  busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
}: {
  filename: string;
  busyTimeoutMs?: number;
}): PlannerStoreWriteReservation {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError("busyTimeoutMs must be a non-negative safe integer.");
  }
  const canonicalFilename = realpathSync(resolve(filename));
  const sourceIdentity = readCanonicalStoreFileIdentity(canonicalFilename);
  const database = new DatabaseSync(canonicalFilename);
  let active = false;
  let transactionOpen = false;
  try {
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.exec("PRAGMA synchronous = FULL");
    database.exec("BEGIN IMMEDIATE");
    active = true;
    transactionOpen = true;
    const identityAfterBegin = readCanonicalStoreFileIdentity(canonicalFilename);
    if (!sameStoreFileIdentity(sourceIdentity, identityAfterBegin)) {
      throw new PlannerStoreError(
        "STORE_CORRUPT",
        "The SQLite source identity changed while acquiring its write reservation.",
      );
    }
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the acquisition failure.
      }
    }
    database.close();
    if (isSqliteBusy(error)) {
      throw new PlannerStoreError(
        "BUSY",
        "The household store already has an active writer.",
        { cause: error },
      );
    }
    throw error;
  }

  const assertActive = () => {
    if (!active) {
      throw new PlannerStoreError(
        "BUSY",
        "The SQLite write reservation is no longer held.",
      );
    }
    const currentIdentity = readCanonicalStoreFileIdentity(canonicalFilename);
    if (!sameStoreFileIdentity(sourceIdentity, currentIdentity)) {
      throw new PlannerStoreError(
        "STORE_CORRUPT",
        "The reserved SQLite source identity is no longer stable.",
      );
    }
  };

  const createSnapshot = (
    destinationFilename: string,
    allowUnrecognizedWorkspace: boolean,
  ): VerifiedPlannerSnapshotInspection => {
    assertActive();
    const destination = canonicalSnapshotDestination(resolve(destinationFilename));
    if (destination === canonicalFilename) {
      throw new TypeError("The SQLite snapshot destination must differ from its source.");
    }
    if (
      existsSync(destination) ||
      existsSync(`${destination}-wal`) ||
      existsSync(`${destination}-shm`)
    ) {
      throw new PlannerStoreError(
        "STORE_CORRUPT",
        "The SQLite snapshot destination must not already exist.",
      );
    }

    try {
      // VACUUM cannot run on the connection holding BEGIN IMMEDIATE. A
      // distinct read-only engine connection captures the one committed
      // source image while the reservation excludes every new writer.
      const reader = new DatabaseSync(canonicalFilename, { readOnly: true });
      try {
        reader.prepare("VACUUM INTO ?").run(destination);
      } finally {
        reader.close();
      }
      assertActive();
      readCanonicalStoreFileIdentity(destination);
      checkpointAndVerifySnapshot(destination);
      return inspectPlannerSnapshot(destination, { allowUnrecognizedWorkspace });
    } catch (error) {
      try {
        removeSnapshotArtifacts(destination);
      } catch {
        // Preserve the engine or verification error as the primary failure.
      }
      if (error instanceof PlannerStoreError) throw error;
      throw new PlannerStoreError(
        "STORE_CORRUPT",
        "The reserved SQLite snapshot could not be created and verified.",
        { cause: error },
      );
    }
  };

  const reservation: PlannerStoreWriteReservation = Object.freeze({
    filename: canonicalFilename,
    createVerifiedSnapshot(
      destinationFilename: string,
    ): VerifiedPlannerSnapshotInspection {
      return createSnapshot(destinationFilename, false);
    },
    close(): void {
      if (!active) return;
      active = false;
      let closeError: unknown;
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch (error) {
          closeError = error;
        }
        transactionOpen = false;
      }
      try {
        database.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError !== undefined) throw closeError;
    },
  });
  RESERVED_STORE_OPERATIONS.set(
    reservation,
    Object.freeze({
      createMigrationSnapshot(destinationFilename): VerifiedPlannerSnapshotInspection {
        return createSnapshot(destinationFilename, true);
      },
      migrationConnection: Object.freeze({
        database,
        assertActive,
        commit(): void {
          assertActive();
          if (!transactionOpen) {
            throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite migration transaction is no longer open.");
          }
          database.exec("COMMIT");
          transactionOpen = false;
        },
      }),
    }),
  );
  return reservation;
}

function nextBackupPath(filename: string, currentVersion: number): string {
  const base = `${filename}.pre-migration-v${currentVersion}-${Date.now()}`;
  let candidate = `${base}.sqlite`;
  let suffix = 0;
  while (existsSync(candidate)) candidate = `${base}-${++suffix}.sqlite`;
  return candidate;
}

function createVerifiedMigrationBackup(
  filename: string,
  currentVersion: number,
): string {
  const backupPath = nextBackupPath(filename, currentVersion);
  let reservation: PlannerStoreWriteReservation | null = null;
  try {
    reservation = acquirePlannerStoreWriteReservation({ filename });
    const operations = RESERVED_STORE_OPERATIONS.get(reservation);
    if (operations === undefined) {
      throw new PlannerStoreError(
        "MIGRATION_FAILED",
        "The SQLite migration snapshot primitive is unavailable.",
      );
    }
    return operations.createMigrationSnapshot(backupPath).filename;
  } catch (error) {
    try {
      rmSync(backupPath, { force: true });
    } catch {
      // Preserve the backup failure as the actionable startup error.
    }
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      "SQLite migration backup could not be created and verified.",
      { cause: error },
    );
  } finally {
    reservation?.close();
  }
}

function executeMigrationEntry(database: DatabaseSync, migration: (typeof PLANNER_SCHEMA_MIGRATIONS)[number]): void {
  const sql = readFileSync(migration.path, "utf8");
  database.exec(sql);
  database
    .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(migration.version, Date.now());
}

function applyMigrations(database: DatabaseSync, startingVersion: number): void {
  let currentVersion = startingVersion;
  for (const migration of PLANNER_SCHEMA_MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    if (migration.version !== currentVersion + 1) {
      throw new PlannerStoreError(
        "MIGRATION_FAILED",
        `Database migration path is not contiguous after version ${currentVersion}.`,
      );
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      executeMigrationEntry(database, migration);
      if (migration.version === 11) normalizeStoredLegacyHouseholdState(database, true);
      database.exec("COMMIT");
      currentVersion = migration.version;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original migration failure.
      }
      throw new PlannerStoreError(
        "MIGRATION_FAILED",
        `SQLite schema migration ${migration.version} failed.`,
        { cause: error },
      );
    }
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function readNonInternalSchemaDefinitions(database: DatabaseSync): readonly SchemaDefinition[] {
  return Object.freeze(database.prepare(
    "SELECT type, name, sql FROM sqlite_schema " +
      "WHERE type IN ('index', 'table', 'trigger', 'view') AND name NOT LIKE 'sqlite_%' " +
      "ORDER BY type, name",
  ).all().map((row) => {
    const entry = row as { type: string; name: string; sql: string | null };
    return Object.freeze({ type: entry.type, name: entry.name, sql: entry.sql });
  }));
}

function readInventoryTableNames(database: DatabaseSync): string[] {
  return database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND " +
      "(name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence' OR name LIKE 'sqlite_stat%') ORDER BY name",
  ).all().map((row) => (row as { name: string }).name).sort();
}

function readLogicalInventory(database: DatabaseSync): LogicalInventory {
  const schema = readNonInternalSchemaDefinitions(database);
  const tableNames = readInventoryTableNames(database);
  const tables: Record<string, LogicalTableInventory> = {};
  for (const name of tableNames.sort()) {
    const quoted = quoteIdentifier(name);
    const columns = database.prepare(`PRAGMA table_xinfo(${quoted})`).all()
      .filter((row) => Number((row as { hidden: number }).hidden) === 0)
      .map((row) => String((row as { name: string }).name));
    const encodedColumns = columns.map((column) =>
      `typeof(${quoteIdentifier(column)}) AS ${quoteIdentifier(`type_${column}`)}, ` +
      `CASE typeof(${quoteIdentifier(column)}) ` +
      `WHEN 'text' THEN hex(CAST(${quoteIdentifier(column)} AS BLOB)) ` +
      `WHEN 'blob' THEN hex(${quoteIdentifier(column)}) ` +
      `ELSE quote(${quoteIdentifier(column)}) END AS ${quoteIdentifier(`value_${column}`)}`,
    ).join(", ");
    const rows = (database.prepare(`SELECT ${encodedColumns} FROM ${quoted}`).all() as Array<Record<string, string>>)
      .map((row) => Object.freeze(columns.map((column) => Object.freeze([
        String(row[`type_${column}`]),
        String(row[`value_${column}`]),
      ] as const))))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const schemaEntry = schema.find((entry) => entry.type === "table" && entry.name === name);
    tables[name] = Object.freeze({
      sql: schemaEntry?.sql ?? null,
      columns: Object.freeze(columns),
      rows: Object.freeze(rows),
    });
  }
  return Object.freeze({ schema: Object.freeze(schema), tables: Object.freeze(tables) });
}

function sameLogicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readRowCounts(database: DatabaseSync): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(readInventoryTableNames(database).map((name) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as {
      count: number;
    };
    return [name, Number(row.count)];
  })));
}

function assertExpectedSchemaObjects(database: DatabaseSync, throughVersion = CURRENT_SCHEMA_VERSION): void {
  let expected = canonicalPlannerSchemaDefinitions.get(throughVersion);
  if (expected === undefined) {
    const canonical = new DatabaseSync(":memory:");
    try {
      for (const migration of PLANNER_SCHEMA_MIGRATIONS) {
        if (migration.version > throughVersion) break;
        executeMigrationEntry(canonical, migration);
      }
      expected = readNonInternalSchemaDefinitions(canonical);
      canonicalPlannerSchemaDefinitions.set(throughVersion, expected);
    } finally {
      canonical.close();
    }
  }
  if (!sameLogicalValue(readNonInternalSchemaDefinitions(database), expected)) {
    throw new PlannerStoreError("STORE_CORRUPT", "The SQLite schema definitions do not match the repository migration catalogue.");
  }
}

function assertForeignKeyIntegrity(database: DatabaseSync): void {
  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      "The SQLite store contains foreign-key violations.",
    );
  }
}

function assertCoherentV8Store(database: DatabaseSync): void {
  quickCheck(database);
  assertForeignKeyIntegrity(database);
  const versions = readAppliedMigrationVersions(database);
  if (!sameLogicalValue(versions, [1, 2, 3, 4, 5, 6, 7, 8])) {
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite store must have the contiguous v1 through v8 migration ledger.");
  }
  assertExpectedSchemaObjects(database, 8);
  const workspaceCount = Number((database.prepare("SELECT COUNT(*) AS count FROM workspace").get() as { count: number }).count);
  const household = database.prepare(
    "SELECT schema_version FROM workspace WHERE id = 'household'",
  ).get() as { schema_version: number } | undefined;
  if (workspaceCount !== 1 || household?.schema_version !== 8) {
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      "The SQLite store must contain exactly one household workspace at schema version 8.",
    );
  }
}

function assertCoherentV9Store(database: DatabaseSync): void {
  quickCheck(database);
  assertForeignKeyIntegrity(database);
  const versions = readAppliedMigrationVersions(database);
  if (!sameLogicalValue(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9])) {
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite store did not reach the contiguous v1 through v9 migration ledger.");
  }
  assertExpectedSchemaObjects(database, 9);
  const workspaceCount = Number((database.prepare("SELECT COUNT(*) AS count FROM workspace").get() as { count: number }).count);
  const household = database.prepare(
    "SELECT schema_version FROM workspace WHERE id = 'household'",
  ).get() as { schema_version: number } | undefined;
  if (workspaceCount !== 1 || household?.schema_version !== 9) {
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite household workspace did not reach schema version 9.");
  }
}

function assertCoherentV10Store(database: DatabaseSync): void {
  quickCheck(database);
  assertForeignKeyIntegrity(database);
  const versions = readAppliedMigrationVersions(database);
  if (!sameLogicalValue(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) {
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite store did not reach the contiguous v1 through v10 migration ledger.");
  }
  assertExpectedSchemaObjects(database, 10);
  const workspaceCount = Number((database.prepare("SELECT COUNT(*) AS count FROM workspace").get() as { count: number }).count);
  const household = database.prepare(
    "SELECT schema_version FROM workspace WHERE id = 'household'",
  ).get() as { schema_version: number } | undefined;
  if (workspaceCount !== 1 || household?.schema_version !== 10) {
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      "The SQLite household workspace did not reach schema version 10.",
    );
  }
}

function assertExactV8ToV9Delta(before: LogicalInventory, after: LogicalInventory): void {
  if (!sameLogicalValue(before.schema, after.schema)) {
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite schema changed outside the v8-to-v9 data transition.");
  }
  const beforeNames = Object.keys(before.tables).sort();
  const afterNames = Object.keys(after.tables).sort();
  if (!sameLogicalValue(beforeNames, afterNames)) {
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite durable table set changed outside the v8-to-v9 transition.");
  }
  for (const name of beforeNames) {
    const initial = before.tables[name];
    const migrated = after.tables[name];
    if (!sameLogicalValue(initial.sql, migrated.sql) || !sameLogicalValue(initial.columns, migrated.columns)) {
      throw new PlannerStoreError("MIGRATION_FAILED", `The SQLite table definition changed unexpectedly: ${name}.`);
    }
    if (name === "schema_migrations") {
      const versionColumn = initial.columns.indexOf("version");
      const appliedAtColumn = initial.columns.indexOf("applied_at");
      if (versionColumn < 0 || appliedAtColumn < 0) {
        throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite migration ledger shape is invalid.");
      }
      const added = migrated.rows.filter((row) => row[versionColumn][1] === "9");
      const retained = migrated.rows.filter((row) => row[versionColumn][1] !== "9");
      if (added.length !== 1 || added[0][versionColumn][0] !== "integer" || added[0][appliedAtColumn][0] !== "integer" || !sameLogicalValue(initial.rows, retained)) {
        throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite migration ledger changed outside its one version-9 entry.");
      }
      continue;
    }
    if (name === "workspace") {
      const idColumn = initial.columns.indexOf("id");
      const schemaColumn = initial.columns.indexOf("schema_version");
      if (idColumn < 0 || schemaColumn < 0 || initial.rows.length !== 1 || migrated.rows.length !== 1) {
        throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite workspace shape is invalid for v8-to-v9 validation.");
      }
      const previous = initial.rows[0];
      const current = migrated.rows[0];
      const expected = previous.map((cell, index) => index === schemaColumn ? ["integer", "9"] as const : cell);
      if (previous[idColumn][0] !== "text" || previous[idColumn][1] !== "686F757365686F6C64" || previous[schemaColumn][0] !== "integer" || previous[schemaColumn][1] !== "8" || !sameLogicalValue(current, expected)) {
        throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite household workspace changed outside schema_version 8 to 9.");
      }
      continue;
    }
    if (!sameLogicalValue(initial.rows, migrated.rows)) {
      throw new PlannerStoreError("MIGRATION_FAILED", `The SQLite table changed unexpectedly: ${name}.`);
    }
  }
}

function assertExactV9ToV10Delta(before: LogicalInventory, after: LogicalInventory): void {
  if (!sameLogicalValue(before.schema, after.schema)) {
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite schema changed outside the v9-to-v10 data transition.");
  }
  const beforeNames = Object.keys(before.tables).sort();
  const afterNames = Object.keys(after.tables).sort();
  if (!sameLogicalValue(beforeNames, afterNames)) {
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite durable table set changed outside the v9-to-v10 transition.");
  }
  const changedColumns = new Map<string, ReadonlySet<string>>([
    ["workspace", new Set(["schema_version", "state_json", "sync_revision", "updated_at"])],
    ["planner_events", new Set(["before_state_json"])],
    ["planner_tool_calls", new Set(["result_envelope_json"])],
    ["codex_native_tool_calls", new Set(["result_envelope_json"])],
  ]);
  for (const name of beforeNames) {
    const initial = before.tables[name];
    const migrated = after.tables[name];
    if (!sameLogicalValue(initial.sql, migrated.sql) || !sameLogicalValue(initial.columns, migrated.columns)) {
      throw new PlannerStoreError("MIGRATION_FAILED", `The SQLite table definition changed unexpectedly: ${name}.`);
    }
    if (name === "schema_migrations") {
      const versionColumn = initial.columns.indexOf("version");
      const appliedAtColumn = initial.columns.indexOf("applied_at");
      const added = migrated.rows.filter((row) => row[versionColumn]?.[1] === "10");
      const retained = migrated.rows.filter((row) => row[versionColumn]?.[1] !== "10");
      if (versionColumn < 0 || appliedAtColumn < 0 || added.length !== 1 ||
        added[0][versionColumn][0] !== "integer" || added[0][appliedAtColumn][0] !== "integer" ||
        !sameLogicalValue(initial.rows, retained)) {
        throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite migration ledger changed outside its one version-10 entry.");
      }
      continue;
    }
    const permitted = changedColumns.get(name);
    if (permitted === undefined) {
      if (!sameLogicalValue(initial.rows, migrated.rows)) {
        throw new PlannerStoreError("MIGRATION_FAILED", `The SQLite table changed unexpectedly: ${name}.`);
      }
      continue;
    }
    const indexes = initial.columns.map((column, index) => ({ column, index }));
    const changedIndexes = indexes.filter(({ column }) => permitted.has(column)).map(({ index }) => index);
    const keyIndexes = indexes.filter(({ column }) => !permitted.has(column)).map(({ index }) => index);
    const stableKey = (row: readonly LogicalCell[]) => JSON.stringify(keyIndexes.map((index) => row[index]));
    const initialRows = new Map(initial.rows.map((row) => [stableKey(row), row]));
    const migratedRows = new Map(migrated.rows.map((row) => [stableKey(row), row]));
    if (initialRows.size !== initial.rows.length || migratedRows.size !== migrated.rows.length ||
      !sameLogicalValue([...initialRows.keys()].sort(), [...migratedRows.keys()].sort())) {
      throw new PlannerStoreError("MIGRATION_FAILED", `The SQLite row identity changed unexpectedly: ${name}.`);
    }
    for (const [key, previous] of initialRows) {
      const current = migratedRows.get(key);
      if (!current || keyIndexes.some((index) => !sameLogicalValue(previous[index], current[index]))) {
        throw new PlannerStoreError("MIGRATION_FAILED", `The SQLite table changed outside its permitted columns: ${name}.`);
      }
      // This explicit loop prevents a future migration from changing a column
      // merely because it happens to share the same row identity.
      for (const index of changedIndexes) {
        if (!current[index]) throw new PlannerStoreError("MIGRATION_FAILED", `The SQLite changed column is missing: ${name}.`);
      }
    }
  }
}

function readCommittedV9Summary(
  filename: string,
): PlannerStoreV8ToV9MigrationResult["database"] {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    assertCoherentV9Store(database);
    return Object.freeze({
      filename,
      quickCheck: "ok" as const,
      schemaVersion: 9 as const,
      migrationVersions: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9] as const),
      workspaceSchemaVersion: 9 as const,
      rowCounts: readRowCounts(database),
    });
  } finally {
    database.close();
  }
}

function readCommittedV10Summary(
  filename: string,
): PlannerStoreV9ToV10MigrationResult["database"] {
  return withClosedPreflightDatabase(filename, (database) => {
    assertCoherentV10Store(database);
    const workspace = database.prepare(
      "SELECT state_json FROM workspace WHERE id = 'household'",
    ).get() as { state_json: string };
    const validationIssues: IngredientOccurrenceUpgradeIssue[] = [];
    appendHouseholdStateValidationIssues(
      parseJson<HouseholdPlannerState>(workspace.state_json, "workspace.state_json"),
      "workspace.state_json",
      validationIssues,
    );
    if (validationIssues.length > 0) throw occurrenceUpgradeFailure(validationIssues);
    return Object.freeze({
      filename,
      quickCheck: "ok" as const,
      schemaVersion: 10 as const,
      migrationVersions: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const),
      workspaceSchemaVersion: 10 as const,
      rowCounts: readRowCounts(database),
    });
  });
}

export function migratePlannerStoreV8ToV9({
  filename,
  backupFilename,
}: {
  filename: string;
  backupFilename: string;
}): PlannerStoreV8ToV9MigrationResult {
  assertPlannerSchemaContract();
  if (!isAbsolute(filename) || !isAbsolute(backupFilename)) {
    throw new TypeError("The SQLite database and backup paths must be absolute.");
  }
  const canonicalFilename = realpathSync(filename);
  const canonicalBackup = canonicalSnapshotDestination(backupFilename);
  if (canonicalFilename === canonicalBackup) {
    throw new TypeError("The SQLite backup path must differ from its database path.");
  }
  let reservation: PlannerStoreWriteReservation | null = null;
  let backup: VerifiedPlannerSnapshotInspection | null = null;
  let committed = false;
  try {
    reservation = acquirePlannerStoreWriteReservation({ filename: canonicalFilename });
    const operations = RESERVED_STORE_OPERATIONS.get(reservation);
    if (operations === undefined) {
      throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite v8-to-v9 reservation primitives are unavailable.");
    }
    const connection = operations.migrationConnection;
    assertCoherentV8Store(connection.database);
    const before = readLogicalInventory(connection.database);
    backup = operations.createMigrationSnapshot(canonicalBackup);
    const backupDatabase = new DatabaseSync(backup.filename, { readOnly: true });
    try {
      assertCoherentV8Store(backupDatabase);
      if (!sameLogicalValue(before, readLogicalInventory(backupDatabase))) {
        throw new PlannerStoreError("MIGRATION_FAILED", "The verified SQLite backup does not equal the locked v8 source.");
      }
    } finally {
      backupDatabase.close();
    }
    const migration = PLANNER_SCHEMA_MIGRATIONS.find((entry) => entry.version === 9);
    if (migration === undefined) throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite v9 catalogue entry is unavailable.");
    executeMigrationEntry(connection.database, migration);
    assertCoherentV9Store(connection.database);
    const after = readLogicalInventory(connection.database);
    assertExactV8ToV9Delta(before, after);
    const verifiedBackup = backup;
    connection.commit();
    committed = true;
    reservation.close();
    reservation = null;
    const databaseSummary = readCommittedV9Summary(canonicalFilename);
    return Object.freeze({
      database: databaseSummary,
      backup: verifiedBackup,
      migration: Object.freeze({
        from: 8,
        to: 9,
        allowedChanges: Object.freeze(["schema_migrations:9", "workspace:household.schema_version"] as const),
      }),
    });
  } catch (error) {
    if (committed) {
      throw new PlannerStoreError(
        "MIGRATION_FAILED",
        `The SQLite v8-to-v9 migration committed at ${canonicalFilename}, but final closed-file readback failed. ` +
          `Inspect it before retrying; verified v8 backup: ${backup?.filename ?? canonicalBackup}.`,
        { cause: error, migrationBackupPath: backup?.filename ?? null },
      );
    }
    if (error instanceof PlannerStoreError) throw error;
    if (isSqliteBusy(error)) {
      throw new PlannerStoreError("BUSY", "The household store already has an active writer.", { cause: error });
    }
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite v8-to-v9 migration did not complete.", { cause: error });
  } finally {
    reservation?.close();
  }
}

export function migratePlannerStoreV9ToV10({
  filename,
  backupFilename,
}: {
  filename: string;
  backupFilename: string;
}): PlannerStoreV9ToV10MigrationResult {
  assertPlannerSchemaContract();
  if (Number(CURRENT_SCHEMA_VERSION) < 10) {
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      "The one-time SQLite v9-to-v10 command requires the schema-10 catalogue entry.",
    );
  }
  if (!isAbsolute(filename) || !isAbsolute(backupFilename)) {
    throw new TypeError("The SQLite database and backup paths must be absolute.");
  }
  const canonicalFilename = realpathSync(filename);
  const canonicalBackup = canonicalSnapshotDestination(backupFilename);
  if (canonicalFilename === canonicalBackup) {
    throw new TypeError("The SQLite backup path must differ from its database path.");
  }

  if (readCurrentMigrationVersionReadOnly(canonicalFilename) === 10) {
    return Object.freeze({
      database: readCommittedV10Summary(canonicalFilename),
      backup: null,
      migration: Object.freeze({ from: 10 as const, to: 10 as const, allowedChanges: Object.freeze([] as const) }),
    });
  }

  // This must precede the writer reservation: an ambiguous source is left
  // entirely closed and untouched, including its artifact inventory.
  preflightV9IngredientOccurrenceUpgrade(canonicalFilename);

  let reservation: PlannerStoreWriteReservation | null = null;
  let backup: VerifiedPlannerSnapshotInspection | null = null;
  let committed = false;
  try {
    reservation = acquirePlannerStoreWriteReservation({ filename: canonicalFilename });
    const operations = RESERVED_STORE_OPERATIONS.get(reservation);
    if (operations === undefined) {
      throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite v9-to-v10 reservation primitives are unavailable.");
    }
    const connection = operations.migrationConnection;
    assertCoherentV9Store(connection.database);
    const before = readLogicalInventory(connection.database);
    // Close the preflight/reservation race before creating any backup artifact.
    applyV9IngredientOccurrenceUpgrade(connection.database, false);
    backup = operations.createMigrationSnapshot(canonicalBackup);
    const backupDatabase = new DatabaseSync(backup.filename, { readOnly: true });
    try {
      assertCoherentV9Store(backupDatabase);
      if (!sameLogicalValue(before, readLogicalInventory(backupDatabase))) {
        throw new PlannerStoreError("MIGRATION_FAILED", "The verified SQLite backup does not equal the locked v9 source.");
      }
    } finally {
      backupDatabase.close();
    }
    // Re-run the same fail-closed authority under the writer lock so the
    // committed state cannot differ from the immutable preflight candidate.
    applyV9IngredientOccurrenceUpgrade(connection.database);
    const migration = PLANNER_SCHEMA_MIGRATIONS.find((entry) => entry.version === 10);
    if (migration === undefined) throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite v10 catalogue entry is unavailable.");
    executeMigrationEntry(connection.database, migration);
    assertCoherentV10Store(connection.database);
    const after = readLogicalInventory(connection.database);
    assertExactV9ToV10Delta(before, after);
    const verifiedBackup = backup;
    connection.commit();
    committed = true;
    reservation.close();
    reservation = null;
    return Object.freeze({
      database: readCommittedV10Summary(canonicalFilename),
      backup: verifiedBackup,
      migration: Object.freeze({
        from: 9,
        to: 10,
        allowedChanges: Object.freeze([
          "schema_migrations:10",
          "workspace:household.schema_version,state_json,sync_revision,updated_at",
          "planner_events:before_state_json",
          "planner_tool_calls:result_envelope_json",
          "codex_native_tool_calls:result_envelope_json",
        ] as const),
      }),
    });
  } catch (error) {
    if (committed) {
      throw new PlannerStoreError(
        "MIGRATION_FAILED",
        `The SQLite v9-to-v10 migration committed at ${canonicalFilename}, but final closed-file readback failed. ` +
          `Inspect it before retrying; verified v9 backup: ${backup?.filename ?? canonicalBackup}.`,
        { cause: error, migrationBackupPath: backup?.filename ?? null },
      );
    }
    if (error instanceof PlannerStoreError) throw error;
    if (isSqliteBusy(error)) {
      throw new PlannerStoreError("BUSY", "The household store already has an active writer.", { cause: error });
    }
    throw new PlannerStoreError("MIGRATION_FAILED", "The SQLite v9-to-v10 migration did not complete.", { cause: error });
  } finally {
    reservation?.close();
  }
}

function selectWorkspace(database: DatabaseSync): WorkspaceRow | null {
  return (
    (database.prepare("SELECT * FROM workspace WHERE id = 'household'").get() as
      | WorkspaceRow
      | undefined) ?? null
  );
}

function selectEvents(
  database: DatabaseSync,
  { beforeSequence, limit }: { beforeSequence?: number | null; limit: number },
): EventRow[] {
  const statement = beforeSequence
    ? database.prepare(
        "SELECT * FROM planner_events WHERE sequence < ? ORDER BY sequence DESC LIMIT ?",
      )
    : database.prepare("SELECT * FROM planner_events ORDER BY sequence DESC LIMIT ?");
  return (beforeSequence
    ? statement.all(beforeSequence, limit)
    : statement.all(limit)) as EventRow[];
}

function selectTranscript(
  database: DatabaseSync,
  { beforeSequence, limit, ascending = false }: {
    beforeSequence?: number | null;
    limit: number;
    ascending?: boolean;
  },
): TranscriptRow[] {
  const statement = beforeSequence
    ? database.prepare(
        "SELECT * FROM transcript_entries WHERE sequence < ? ORDER BY sequence DESC LIMIT ?",
      )
    : database.prepare("SELECT * FROM transcript_entries ORDER BY sequence DESC LIMIT ?");
  const rows = (beforeSequence
    ? statement.all(beforeSequence, limit)
    : statement.all(limit)) as TranscriptRow[];
  return ascending ? rows.reverse() : rows;
}

function selectChatTurns(database: DatabaseSync, limit: number): ChatTurnRow[] {
  return database
    .prepare("SELECT * FROM chat_turns ORDER BY turn_sequence DESC LIMIT ?")
    .all(limit) as ChatTurnRow[];
}

function validateStoredPlannerToolCalls(database: DatabaseSync): void {
  if (!hasTable(database, "planner_tool_calls")) return;
  const rows = database.prepare("SELECT * FROM planner_tool_calls").all() as PlannerToolCallRow[];
  for (const row of rows) mapPlannerToolCall(row);
}

function validateStoredChatTurns(database: DatabaseSync): void {
  if (!hasTable(database, "chat_turns")) return;
  const rows = database.prepare("SELECT * FROM chat_turns").all() as ChatTurnRow[];
  for (const row of rows) mapChatTurn(row);
}

export class SqlitePlannerStore {
  readonly filename: string;
  readonly database: DatabaseSync;
  readonly migrationBackupPath: string | null;
  #closed = false;

  constructor(
    filename: string,
    database: DatabaseSync,
    migrationBackupPath: string | null = null,
  ) {
    this.filename = filename;
    this.database = database;
    this.migrationBackupPath = migrationBackupPath;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.database.close();
  }

  checkIntegrity(): "ok" {
    quickCheck(this.database);
    return "ok";
  }

  transaction<Result>(work: (transaction: SqliteTransaction) => Result): Result {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isSqliteBusy(error)) {
        throw new PlannerStoreError(
          "BUSY",
          "The household store is busy; retry after authoritative readback.",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      const result = work(this.database);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the application error that caused rollback.
      }
      throw error;
    }
  }

  readTransaction<Result>(work: (transaction: SqliteTransaction) => Result): Result {
    this.database.exec("BEGIN");
    try {
      const result = work(this.database);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the read/parse error.
      }
      throw error;
    }
  }

  readWorkspace(transaction?: SqliteTransaction): WorkspaceResponse {
    if (transaction) return this.#readWorkspace(transaction);
    return this.readTransaction((database) => this.#readWorkspace(database));
  }

  readInitializedWorkspace(transaction?: SqliteTransaction): InitializedWorkspace {
    const workspace = this.readWorkspace(transaction);
    if (!workspace.initialized) {
      throw new PlannerStoreError("NOT_INITIALIZED", "Household workspace is not initialized.");
    }
    return workspace;
  }

  #readWorkspace(database: DatabaseSync): WorkspaceResponse {
    const row = selectWorkspace(database);
    if (!row) return { initialized: false, schemaVersion: CURRENT_SCHEMA_VERSION };
    return {
      initialized: true,
      schemaVersion: row.schema_version,
      plannerVersion: row.planner_version,
      syncRevision: row.sync_revision,
      state: workspaceState(row),
      events: selectEvents(database, {
        limit: WORKSPACE_EVENT_TAIL_LIMIT,
      }).map(mapEvent),
      transcriptEntries: selectTranscript(database, {
        limit: WORKSPACE_TRANSCRIPT_TAIL_LIMIT,
        ascending: true,
      }).map(mapTranscript),
      chatTurns: selectChatTurns(database, WORKSPACE_CHAT_TURN_TAIL_LIMIT).map(mapChatTurn),
    };
  }

  readEventPage(
    request: { beforeSequence: number | null; limit: number },
    transaction?: SqliteTransaction,
  ): PlannerEventPage {
    const read = (database: DatabaseSync) => {
      const rows = selectEvents(database, {
        beforeSequence: request.beforeSequence,
        limit: Math.min(request.limit, HISTORY_PAGE_LIMIT_MAX) + 1,
      });
      const hasMore = rows.length > request.limit;
      const pageRows = rows.slice(0, request.limit);
      return {
        order: "newest_first" as const,
        items: pageRows.map(mapEvent),
        nextBeforeSequence:
          hasMore && pageRows.length > 0
            ? pageRows[pageRows.length - 1].sequence
            : null,
      };
    };
    return transaction ? read(transaction) : this.readTransaction(read);
  }

  readTranscriptPage(
    request: { beforeSequence: number | null; limit: number },
    transaction?: SqliteTransaction,
  ): TranscriptPage {
    const read = (database: DatabaseSync) => {
      const rows = selectTranscript(database, {
        beforeSequence: request.beforeSequence,
        limit: Math.min(request.limit, HISTORY_PAGE_LIMIT_MAX) + 1,
      });
      const hasMore = rows.length > request.limit;
      const pageRows = rows.slice(0, request.limit);
      return {
        order: "newest_first" as const,
        items: pageRows.map(mapTranscript),
        nextBeforeSequence:
          hasMore && pageRows.length > 0
            ? pageRows[pageRows.length - 1].sequence
            : null,
      };
    };
    return transaction ? read(transaction) : this.readTransaction(read);
  }

  readAllEvents(transaction?: SqliteTransaction): PlannerEvent[] {
    const read = (database: DatabaseSync) =>
      (database.prepare("SELECT * FROM planner_events ORDER BY sequence ASC").all() as EventRow[]).map(
        mapEvent,
      );
    return transaction ? read(transaction) : this.readTransaction(read);
  }

  readAllTranscriptEntries(transaction?: SqliteTransaction): TranscriptEntry[] {
    const read = (database: DatabaseSync) =>
      (
        database.prepare("SELECT * FROM transcript_entries ORDER BY sequence ASC").all() as TranscriptRow[]
      ).map(mapTranscript);
    return transaction ? read(transaction) : this.readTransaction(read);
  }

  readAllChatTurns(transaction?: SqliteTransaction): ChatTurn[] {
    const read = (database: DatabaseSync) =>
      (database.prepare("SELECT * FROM chat_turns ORDER BY turn_sequence ASC").all() as ChatTurnRow[]).map(
        mapChatTurn,
      );
    return transaction ? read(transaction) : this.readTransaction(read);
  }

  findReceipt(
    transaction: SqliteTransaction,
    operationKind: OperationKind,
    requestId: string,
  ): OperationReceipt | null {
    const row = transaction
      .prepare(
        "SELECT * FROM command_receipts WHERE operation_kind = ? AND request_id = ?",
      )
      .get(operationKind, requestId) as ReceiptRow | undefined;
    return row ? mapReceipt(row) : null;
  }

  insertReceipt(transaction: SqliteTransaction, receipt: OperationReceipt): void {
    transaction
      .prepare(
        `INSERT INTO command_receipts
          (operation_kind, request_id, payload_hash, http_status, decision_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.operationKind,
        receipt.requestId,
        receipt.payloadHash,
        receipt.httpStatus,
        JSON.stringify(receipt.decision),
        receipt.createdAt,
      );
  }

  readRunningTurn(transaction: SqliteTransaction): ChatTurn | null {
    const row = transaction
      .prepare("SELECT * FROM chat_turns WHERE status = 'running' LIMIT 1")
      .get() as ChatTurnRow | undefined;
    return row ? mapChatTurn(row) : null;
  }

  readTurn(transaction: SqliteTransaction, turnId: string): ChatTurn | null {
    const row = transaction.prepare("SELECT * FROM chat_turns WHERE turn_id = ?").get(turnId) as
      | ChatTurnRow
      | undefined;
    return row ? mapChatTurn(row) : null;
  }

  readTranscriptEntry(
    transaction: SqliteTransaction,
    entryId: string,
  ): TranscriptEntry | null {
    const row = transaction
      .prepare("SELECT * FROM transcript_entries WHERE entry_id = ?")
      .get(entryId) as TranscriptRow | undefined;
    return row ? mapTranscript(row) : null;
  }

  readTranscriptTail(transaction: SqliteTransaction, limit: number): TranscriptEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError("Transcript tail limit must be a non-negative safe integer.");
    }
    if (limit === 0) return [];
    return selectTranscript(transaction, { limit, ascending: true }).map(mapTranscript);
  }

  insertTranscriptEntry(
    transaction: SqliteTransaction,
    entry: NewTranscriptEntry,
  ): TranscriptEntry {
    const result = transaction
      .prepare(
        `INSERT INTO transcript_entries
          (entry_id, role, text, context_json, turn_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.entryId,
        entry.role,
        entry.text,
        entry.context === null ? null : JSON.stringify(entry.context),
        entry.turnId,
        entry.occurredAt,
      );
    return { ...entry, sequence: asNumber(result.lastInsertRowid) };
  }

  insertRunningTurn(transaction: SqliteTransaction, turn: NewRunningChatTurn): ChatTurn {
    if (turn.researchCandidate !== null) {
      throw new TypeError("A running chat turn must attach its research candidate after insert.");
    }
    if (!isChatResearchLifecycle(turn)) {
      throw new TypeError("A running chat turn has an invalid research lifecycle.");
    }
    const nextSequence = Number(
      (
        transaction
          .prepare("SELECT COALESCE(MAX(turn_sequence), 0) + 1 AS sequence FROM chat_turns")
          .get() as { sequence: number }
      ).sequence,
    );
    transaction
      .prepare(
        `INSERT INTO chat_turns
          (turn_id, request_id, turn_sequence, status, user_entry_id, context_json,
           input_planner_version, reply_entry_id, proposed_command_json,
           mutation_outcome, retry_of_turn_id, error_code, error_detail,
           created_at, started_at, completed_at, mode, completion_token_hash,
           app_server_thread_id, app_server_turn_id, foreground_authority_json,
           accepted_effect_count, last_effect_sequence, recovery_of_turn_id,
           terminal_outcome, research_kind, research_candidate_json)
         VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, NULL,
                 ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        turn.turnId,
        turn.requestId,
        nextSequence,
        turn.userEntryId,
        JSON.stringify(turn.context),
        turn.inputPlannerVersion,
        turn.retryOfTurnId,
        turn.createdAt,
        turn.startedAt,
        turn.mode,
        turn.completionTokenHash,
        JSON.stringify(turn.foregroundAuthority),
        turn.acceptedEffectCount,
        turn.lastEffectSequence,
        turn.recoveryOfTurnId,
        turn.researchKind ?? "none",
        null,
      );
    return { ...turn, turnSequence: nextSequence };
  }

  interruptRunningTurns(transaction: SqliteTransaction, completedAt: number): number {
    const workspace = transaction
      .prepare(
        "SELECT planner_version, sync_revision FROM workspace WHERE id = 'household'",
      )
      .get() as { planner_version: number; sync_revision: number } | undefined;
    const runningCalls = (
      transaction.prepare("SELECT * FROM planner_tool_calls WHERE status = 'running'").all() as
        PlannerToolCallRow[]
    ).map(mapPlannerToolCall);
    for (const call of runningCalls) {
      const envelope = createPlannerToolFailure(
        call.appServerCallId,
        {
          plannerVersion: workspace?.planner_version ?? 0,
          syncRevision: workspace?.sync_revision ?? 0,
        },
        completedAt,
        {
          code: "CALL_CANCELLED",
          message: "The application restarted before this planner call completed.",
          retry: "new_foreground_turn",
        },
      );
      if (!this.completePlannerToolCall(transaction, {
        turnId: call.turnId,
        toolCallId: call.toolCallId,
        appServerThreadId: call.appServerThreadId,
        appServerTurnId: call.appServerTurnId,
        appServerCallId: call.appServerCallId,
        callbackIdentityHash: call.callbackIdentityHash,
        completionTokenHash: call.completionTokenHash,
        tool: call.tool,
        argumentHash: call.argumentHash,
        status: "abandoned",
        resultCode: "CALL_CANCELLED",
        resultEnvelope: envelope,
        completedAt,
      })) {
        throw new PlannerStoreError(
          "STORE_CORRUPT",
          "Running planner tool call changed during startup interruption.",
        );
      }
    }
    const result = transaction
      .prepare(
        `UPDATE chat_turns
         SET status = 'interrupted', mutation_outcome = NULL,
             error_code = 'SERVER_RESTART',
             error_detail = 'The application restarted before ChatGPT completed.',
             terminal_outcome = CASE
               WHEN accepted_effect_count > 0 THEN 'interrupted_after_effect'
               ELSE 'interrupted_no_effect'
             END,
             completion_token_hash = NULL,
             completed_at = ?
         WHERE status = 'running'`,
      )
      .run(completedAt);
    return asNumber(result.changes);
  }

  bindEmbeddedTurn(
    transaction: SqliteTransaction,
    turnId: string,
    completionTokenHash: string,
    appServerThreadId: string,
    appServerTurnId: string,
  ): boolean {
    const currentRow = transaction
      .prepare("SELECT * FROM chat_turns WHERE turn_id = ?")
      .get(turnId) as ChatTurnRow | undefined;
    if (!currentRow) return false;
    const current = mapChatTurn(currentRow);
    const lifecycleEligible = current.status === "running" &&
      current.completionTokenHash === completionTokenHash &&
      (
        (current.mode === "normal" &&
          ((current.researchKind === "none" && current.researchCandidate === null) ||
            (current.researchKind === "sourced_recipe" &&
              isDigestBoundResearchCandidateReference(current.researchCandidate)))) ||
        (current.mode === "recovery" && current.researchKind === "none" &&
          current.researchCandidate === null)
      );
    if (!lifecycleEligible) return false;
    if (current.appServerThreadId !== null || current.appServerTurnId !== null) {
      return current.appServerThreadId === appServerThreadId &&
        current.appServerTurnId === appServerTurnId;
    }
    const result = transaction
      .prepare(
        `UPDATE chat_turns
         SET app_server_thread_id = ?, app_server_turn_id = ?
         WHERE turn_id = ? AND status = 'running'
           AND completion_token_hash = ?
           AND app_server_thread_id IS NULL AND app_server_turn_id IS NULL
           AND (
             (mode = 'normal' AND (
               (research_kind = 'none' AND research_candidate_json IS NULL)
               OR
               (research_kind = 'sourced_recipe'
                 AND json_extract(research_candidate_json, '$.digestVersion') = 1
                 AND json_type(research_candidate_json, '$.replacementDigest') = 'text')
             ))
             OR
             (mode = 'recovery' AND research_kind = 'none' AND research_candidate_json IS NULL)
           )`,
      )
      .run(appServerThreadId, appServerTurnId, turnId, completionTokenHash);
    return result.changes === 1;
  }

  attachResearchCandidate(
    transaction: SqliteTransaction,
    turnId: string,
    completionTokenHash: string,
    reference: ResearchCandidateReference,
  ): boolean {
    if (!isDigestBoundResearchCandidateReference(reference)) {
      throw new TypeError("Research candidate reference is not digest-bound.");
    }
    const result = transaction
      .prepare(
        `UPDATE chat_turns
         SET research_candidate_json = ?
         WHERE turn_id = ? AND status = 'running'
           AND completion_token_hash = ? AND mode = 'normal'
           AND research_kind = 'sourced_recipe'
           AND research_candidate_json IS NULL
           AND app_server_thread_id IS NULL AND app_server_turn_id IS NULL`,
      )
      .run(JSON.stringify(reference), turnId, completionTokenHash);
    return result.changes === 1;
  }

  reservePlannerToolCall(
    transaction: SqliteTransaction,
    reservation: PlannerToolCallReservation,
  ): PlannerToolCallReservationDecision {
    const turn = transaction
      .prepare("SELECT * FROM chat_turns WHERE turn_id = ?")
      .get(reservation.turnId) as ChatTurnRow | undefined;
    if (!turn || turn.status !== "running") return { status: "turn_not_running" };
    if (turn.completion_token_hash !== reservation.completionTokenHash) {
      return { status: "late_call" };
    }
    if (turn.app_server_thread_id === null || turn.app_server_turn_id === null) {
      return { status: "turn_unbound" };
    }
    if (
      turn.app_server_thread_id !== reservation.appServerThreadId ||
      turn.app_server_turn_id !== reservation.appServerTurnId
    ) {
      return { status: "duplicate_mismatch" };
    }

    const existingRow = transaction
      .prepare(
        "SELECT * FROM planner_tool_calls WHERE turn_id = ? AND tool_call_id = ?",
      )
      .get(reservation.turnId, reservation.toolCallId) as PlannerToolCallRow | undefined;
    if (existingRow) {
      const existing = mapPlannerToolCall(existingRow);
      const exact =
        existing.completionTokenHash === reservation.completionTokenHash &&
        existing.appServerThreadId === reservation.appServerThreadId &&
        existing.appServerTurnId === reservation.appServerTurnId &&
        existing.appServerCallId === reservation.appServerCallId &&
        existing.callbackIdentityHash === reservation.callbackIdentityHash &&
        existing.tool === reservation.tool &&
        existing.argumentHash === reservation.argumentHash;
      if (!exact) return { status: "duplicate_mismatch" };
      return existing.status === "running"
        ? { status: "orphaned", call: existing }
        : { status: "replay", call: existing };
    }

    const count = Number(
      (
        transaction
          .prepare("SELECT count(*) AS count FROM planner_tool_calls WHERE turn_id = ?")
          .get(reservation.turnId) as { count: number }
      ).count,
    );
    if (count >= 32) return { status: "call_limit" };
    const sequence = count + 1;
    transaction
      .prepare(
        `INSERT INTO planner_tool_calls
          (turn_id, tool_call_id, app_server_thread_id, app_server_turn_id,
           app_server_call_id, callback_identity_hash, sequence, completion_token_hash,
           tool, argument_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        reservation.turnId,
        reservation.toolCallId,
        reservation.appServerThreadId,
        reservation.appServerTurnId,
        reservation.appServerCallId,
        reservation.callbackIdentityHash,
        sequence,
        reservation.completionTokenHash,
        reservation.tool,
        reservation.argumentHash,
        reservation.createdAt,
      );
    const inserted = transaction
      .prepare(
        "SELECT * FROM planner_tool_calls WHERE turn_id = ? AND tool_call_id = ?",
      )
      .get(reservation.turnId, reservation.toolCallId) as PlannerToolCallRow;
    return { status: "reserved", call: mapPlannerToolCall(inserted) };
  }

  completePlannerToolCall(
    transaction: SqliteTransaction,
    completion: PlannerToolCallCompletion,
  ): boolean {
    if (
      !isPlannerToolResultForTool(completion.tool, completion.resultEnvelope) ||
      completion.resultEnvelope.callId !== completion.appServerCallId
    ) {
      throw new TypeError("Planner tool result does not match its tool-specific call contract.");
    }
    const result = transaction
      .prepare(
        `UPDATE planner_tool_calls
         SET status = ?, result_code = ?, operation_kind = ?, request_id = ?, event_id = ?,
             base_planner_version = ?, result_planner_version = ?, effect_sequence = ?,
             result_envelope_json = ?, completed_at = ?
         WHERE turn_id = ? AND tool_call_id = ? AND status = 'running'
           AND completion_token_hash = ? AND app_server_thread_id = ?
           AND app_server_turn_id = ? AND app_server_call_id = ?
           AND callback_identity_hash = ? AND tool = ? AND argument_hash = ?`,
      )
      .run(
        completion.status,
        completion.resultCode,
        completion.operationKind ?? null,
        completion.requestId ?? null,
        completion.eventId ?? null,
        completion.basePlannerVersion ?? null,
        completion.resultPlannerVersion ?? null,
        completion.effectSequence ?? null,
        JSON.stringify(completion.resultEnvelope),
        completion.completedAt,
        completion.turnId,
        completion.toolCallId,
        completion.completionTokenHash,
        completion.appServerThreadId,
        completion.appServerTurnId,
        completion.appServerCallId,
        completion.callbackIdentityHash,
        completion.tool,
        completion.argumentHash,
      );
    return result.changes === 1;
  }

  incrementEmbeddedTurnEffect(
    transaction: SqliteTransaction,
    identity: EmbeddedTurnIdentity,
  ): number | null {
    const row = transaction
      .prepare(
        `UPDATE chat_turns
         SET accepted_effect_count = accepted_effect_count + 1,
             last_effect_sequence = last_effect_sequence + 1
         WHERE turn_id = ? AND status = 'running' AND completion_token_hash = ?
           AND app_server_thread_id = ? AND app_server_turn_id = ?
         RETURNING last_effect_sequence`,
      )
      .get(
        identity.turnId,
        identity.completionTokenHash,
        identity.appServerThreadId,
        identity.appServerTurnId,
      ) as { last_effect_sequence: number } | undefined;
    return row?.last_effect_sequence ?? null;
  }

  terminalizeEmbeddedTurn(
    transaction: SqliteTransaction,
    identity: EmbeddedTurnIdentity,
    update: EmbeddedTurnTerminalUpdate,
  ): boolean {
    const result = transaction
      .prepare(
        `UPDATE chat_turns
         SET status = ?, reply_entry_id = ?, proposed_command_json = NULL,
             mutation_outcome = ?, error_code = ?, error_detail = ?,
             terminal_outcome = ?, completion_token_hash = NULL, completed_at = ?
         WHERE turn_id = ? AND status = 'running' AND completion_token_hash = ?
           AND app_server_thread_id = ? AND app_server_turn_id = ?`,
      )
      .run(
        update.status,
        update.replyEntryId,
        update.mutationOutcome,
        update.errorCode,
        update.errorDetail,
        update.terminalOutcome,
        update.completedAt,
        identity.turnId,
        identity.completionTokenHash,
        identity.appServerThreadId,
        identity.appServerTurnId,
      );
    return result.changes === 1;
  }

  terminalizeUnboundEmbeddedTurn(
    transaction: SqliteTransaction,
    turnId: string,
    completionTokenHash: string,
    update: EmbeddedTurnTerminalUpdate,
  ): boolean {
    const result = transaction
      .prepare(
        `UPDATE chat_turns
         SET status = ?, reply_entry_id = ?, proposed_command_json = NULL,
             mutation_outcome = ?, error_code = ?, error_detail = ?,
             terminal_outcome = ?, completion_token_hash = NULL, completed_at = ?
         WHERE turn_id = ? AND status = 'running' AND completion_token_hash = ?
           AND app_server_thread_id IS NULL AND app_server_turn_id IS NULL`,
      )
      .run(
        update.status,
        update.replyEntryId,
        update.mutationOutcome,
        update.errorCode,
        update.errorDetail,
        update.terminalOutcome,
        update.completedAt,
        turnId,
        completionTokenHash,
      );
    return result.changes === 1;
  }

  readPlannerToolCalls(
    transaction: SqliteTransaction,
    turnId: string,
  ): PlannerToolCall[] {
    return (
      transaction
        .prepare("SELECT * FROM planner_tool_calls WHERE turn_id = ? ORDER BY sequence ASC")
        .all(turnId) as PlannerToolCallRow[]
    ).map(mapPlannerToolCall);
  }

  incrementSyncRevision(transaction: SqliteTransaction, updatedAt: number): number {
    const row = transaction
      .prepare(
        `UPDATE workspace
         SET sync_revision = sync_revision + 1, updated_at = ?
         WHERE id = 'household'
         RETURNING sync_revision`,
      )
      .get(updatedAt) as { sync_revision: number } | undefined;
    if (!row) {
      throw new PlannerStoreError("NOT_INITIALIZED", "Household workspace is not initialized.");
    }
    return row.sync_revision;
  }

  insertWorkspace(
    transaction: SqliteTransaction,
    state: HouseholdPlannerState,
    now: number,
  ): void {
    transaction
      .prepare(
        `INSERT INTO workspace
          (id, schema_version, planner_version, sync_revision, state_json, created_at, updated_at)
         VALUES ('household', ?, 0, 1, ?, ?, ?)`,
      )
      .run(CURRENT_SCHEMA_VERSION, JSON.stringify(state), now, now);
  }

  updateWorkspace(
    transaction: SqliteTransaction,
    state: HouseholdPlannerState,
    basePlannerVersion: number,
    now: number,
  ): { plannerVersion: number; syncRevision: number } | null {
    const row = transaction
      .prepare(
        `UPDATE workspace
         SET state_json = ?, planner_version = planner_version + 1,
             sync_revision = sync_revision + 1, updated_at = ?
         WHERE id = 'household' AND planner_version = ?
         RETURNING planner_version, sync_revision`,
      )
      .get(JSON.stringify(state), now, basePlannerVersion) as
      | { planner_version: number; sync_revision: number }
      | undefined;
    return row
      ? { plannerVersion: row.planner_version, syncRevision: row.sync_revision }
      : null;
  }

  insertPlannerEvent(
    transaction: SqliteTransaction,
    event: Omit<PlannerEvent, "sequence">,
    beforeState: HouseholdPlannerState,
  ): PlannerEvent {
    const result = transaction
      .prepare(
        `INSERT INTO planner_events
          (event_id, request_id, actor, actor_source, admission, command_json, base_version,
           result_version, summary, target, changes_json, before_state_json,
           reverts_event_id, chat_turn_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.requestId,
        event.actor,
        event.provenance.actorSource,
        event.provenance.admission,
        JSON.stringify(event.command),
        event.baseVersion,
        event.resultVersion,
        event.summary,
        event.target,
        JSON.stringify(event.changes),
        JSON.stringify(beforeState),
        event.revertsEventId,
        event.chatTurnId,
        event.occurredAt,
      );
    return { ...event, sequence: asNumber(result.lastInsertRowid) };
  }

  readLatestPlannerEvent(
    transaction: SqliteTransaction,
  ): { event: PlannerEvent; beforeState: HouseholdPlannerState } | null {
    const row = transaction
      .prepare("SELECT * FROM planner_events ORDER BY sequence DESC LIMIT 1")
      .get() as EventRow | undefined;
    return row
      ? {
          event: mapEvent(row),
          beforeState: parseJson<HouseholdPlannerState>(
            row.before_state_json,
            "planner event undo state",
          ),
        }
      : null;
  }

  hasRevertForEvent(transaction: SqliteTransaction, eventId: string): boolean {
    return Boolean(
      transaction
        .prepare("SELECT 1 FROM planner_events WHERE reverts_event_id = ? LIMIT 1")
        .get(eventId),
    );
  }
}

export function openPlannerStore(options: OpenPlannerStoreOptions = {}): SqlitePlannerStore {
  assertPlannerSchemaContract();
  const filename = resolveDatabaseFilename(options);
  const isMemory = filename === ":memory:";
  const existingFileNeedsBackup = !isMemory &&
    existsSync(filename) &&
    statSync(filename).isFile() &&
    statSync(filename).size > 0;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError("busyTimeoutMs must be a non-negative safe integer.");
  }
  if (!isMemory) mkdirSync(dirname(filename), { recursive: true });

  let migrationBackupPath: string | null = null;
  if (existingFileNeedsBackup) {
    const existingVersion = readCurrentMigrationVersionReadOnly(filename);
    if (existingVersion === 9) {
      const migration = migratePlannerStoreV9ToV10({
        filename: realpathSync(filename),
        backupFilename: nextBackupPath(filename, 9),
      });
      migrationBackupPath = migration.backup?.filename ?? null;
    } else if (existingVersion < 9) {
      preflightPreV9HouseholdNormalization(realpathSync(filename));
    }
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(filename);
  } catch (error) {
    throw new PlannerStoreError("STORE_CORRUPT", `Could not open SQLite database ${filename}.`, {
      cause: error,
    });
  }

  try {
    quickCheck(database);
    const currentVersion = readCurrentMigrationVersion(database);
    assertSupportedMigrationVersion(currentVersion);
    migrationBackupPath ??= existingFileNeedsBackup && currentVersion < CURRENT_SCHEMA_VERSION
        ? createVerifiedMigrationBackup(filename, currentVersion)
        : null;
    configureDatabase(database, busyTimeoutMs, isMemory);
    applyMigrations(database, currentVersion);
    // The pre-v10 normalizer is a legacy compatibility bridge. The schema-10
    // occurrence migration owns its own mechanical transform and must never be
    // followed by text-based reconciliation on a current workspace.
    if (currentVersion < 10) {
      normalizeStoredLegacyHouseholdState(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        applyV9IngredientOccurrenceUpgrade(database);
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the occurrence upgrade failure.
        }
        throw error;
      }
    }
    quickCheck(database);
    validateStoredPlannerToolCalls(database);
    validateStoredChatTurns(database);
    return new SqlitePlannerStore(filename, database, migrationBackupPath);
  } catch (error) {
    database.close();
    if (error instanceof PlannerStoreError) {
      if (migrationBackupPath !== null && error.migrationBackupPath === null) {
        throw new PlannerStoreError(error.code, error.message, {
          cause: error,
          migrationBackupPath,
        });
      }
      throw error;
    }
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      `SQLite database ${filename} could not be configured or checked.`,
      { cause: error, migrationBackupPath },
    );
  }
}
