import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { normalizeLegacyLeftoverSourceStatuses } from "../../lib/household-persistence-upgrade.ts";
import {
  isDigestBoundResearchCandidateReference,
  type ResearchCandidateReference,
} from "../../lib/sourced-recipe-contract.ts";
import type {
  ChatPersistencePort,
  EmbeddedTurnIdentity,
  EmbeddedTurnTerminalUpdate,
  NewRunningChatTurn,
  NewTranscriptEntry,
  PlannerToolCall,
  PlannerToolCallCompletion,
  PlannerToolCallReservation,
  PlannerToolCallReservationDecision,
  PlannerReadPort,
  TransactionRunner,
} from "../application/ports.ts";

const CURRENT_SCHEMA_VERSION = 5;
const DEFAULT_DATABASE_NAME = "planner.sqlite";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MIGRATIONS = [
  {
    version: 1,
    path: fileURLToPath(new URL("migrations/001-initial.sql", import.meta.url)),
  },
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
] as const;

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

const MIGRATION_SNAPSHOT_CREATORS = new WeakMap<
  PlannerStoreWriteReservation,
  (destinationFilename: string) => VerifiedPlannerSnapshotInspection
>();

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

function normalizeStoredLegacyLeftoverSources(database: DatabaseSync): void {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      "Legacy household state normalization could not start.",
      { cause: error },
    );
  }

  try {
    const workspace = database
      .prepare("SELECT state_json FROM workspace WHERE id = 'household'")
      .get() as { state_json: string } | undefined;
    if (workspace) {
      const normalized = normalizeLegacyLeftoverSourceStatuses(
        parseJson<HouseholdPlannerState>(workspace.state_json, "workspace state"),
      );
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
      const normalized = normalizeLegacyLeftoverSourceStatuses(
        parseJson<HouseholdPlannerState>(
          event.before_state_json,
          "planner event undo state",
        ),
      );
      if (normalized.changed) {
        updateEvent.run(JSON.stringify(normalized.state), event.sequence);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the normalization failure.
    }
    if (error instanceof PlannerStoreError) throw error;
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      "Legacy household state normalization failed.",
      { cause: error },
    );
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

function readCurrentMigrationVersion(database: DatabaseSync): number {
  const currentVersion = hasTable(database, "schema_migrations")
    ? Number(
        (
          database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as {
            version: number;
          }
        ).version,
      )
    : 0;
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    throw new PlannerStoreError("MIGRATION_FAILED", "Database migration version is invalid.");
  }
  return currentVersion;
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
  let initialized = false;
  let workspaceSchemaVersion: number | null = null;
  let plannerVersion: number | null = null;
  try {
    quickCheck(database);
    schemaVersion = readCurrentMigrationVersion(database);
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
  try {
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    database.exec("PRAGMA synchronous = FULL");
    database.exec("BEGIN IMMEDIATE");
    active = true;
    const identityAfterBegin = readCanonicalStoreFileIdentity(canonicalFilename);
    if (!sameStoreFileIdentity(sourceIdentity, identityAfterBegin)) {
      throw new PlannerStoreError(
        "STORE_CORRUPT",
        "The SQLite source identity changed while acquiring its write reservation.",
      );
    }
  } catch (error) {
    if (active) {
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
      try {
        database.exec("ROLLBACK");
      } catch (error) {
        closeError = error;
      }
      try {
        database.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError !== undefined) throw closeError;
    },
  });
  MIGRATION_SNAPSHOT_CREATORS.set(
    reservation,
    (destinationFilename) => createSnapshot(destinationFilename, true),
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
    const createMigrationSnapshot = MIGRATION_SNAPSHOT_CREATORS.get(reservation);
    if (createMigrationSnapshot === undefined) {
      throw new PlannerStoreError(
        "MIGRATION_FAILED",
        "The SQLite migration snapshot primitive is unavailable.",
      );
    }
    return createMigrationSnapshot(backupPath).filename;
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

function applyMigrations(database: DatabaseSync, startingVersion: number): void {
  let currentVersion = startingVersion;
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    if (migration.version !== currentVersion + 1) {
      throw new PlannerStoreError(
        "MIGRATION_FAILED",
        `Database migration path is not contiguous after version ${currentVersion}.`,
      );
    }
    const sql = readFileSync(migration.path, "utf8");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
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

export class SqlitePlannerStore
  implements
    TransactionRunner<SqliteTransaction>,
    ChatPersistencePort<SqliteTransaction>,
    PlannerReadPort<SqliteTransaction>
{
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

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(filename);
  } catch (error) {
    throw new PlannerStoreError("STORE_CORRUPT", `Could not open SQLite database ${filename}.`, {
      cause: error,
    });
  }

  let migrationBackupPath: string | null = null;
  try {
    quickCheck(database);
    const currentVersion = readCurrentMigrationVersion(database);
    assertSupportedMigrationVersion(currentVersion);
    migrationBackupPath =
      existingFileNeedsBackup && currentVersion < CURRENT_SCHEMA_VERSION
        ? createVerifiedMigrationBackup(filename, currentVersion)
        : null;
    configureDatabase(database, busyTimeoutMs, isMemory);
    applyMigrations(database, currentVersion);
    normalizeStoredLegacyLeftoverSources(database);
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
