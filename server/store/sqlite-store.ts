import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  type ChatTurn,
  type PlannerChatContext,
  type TranscriptEntry,
} from "../../lib/planner-chat-contract.ts";
import type { HouseholdPlannerState } from "../../lib/household-contract.ts";
import { normalizeLegacyLeftoverSourceStatuses } from "../../lib/household-persistence-upgrade.ts";
import type {
  ChatPersistencePort,
  ChatTurnTerminalUpdate,
  NewRunningChatTurn,
  NewTranscriptEntry,
  PlannerReadPort,
  TransactionRunner,
} from "../application/ports.ts";

const CURRENT_SCHEMA_VERSION = 1;
const DEFAULT_DATABASE_NAME = "planner.sqlite";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_MIGRATION_PATH = fileURLToPath(
  new URL("migrations/001-initial.sql", import.meta.url),
);

export type SqliteTransaction = DatabaseSync;

export type OpenPlannerStoreOptions = {
  /** Use `:memory:` for tests. When omitted, a file is created in `dataDirectory`. */
  filename?: string;
  dataDirectory?: string;
  busyTimeoutMs?: number;
  migrationPath?: string;
};

export class PlannerStoreError extends Error {
  readonly code: "STORE_CORRUPT" | "MIGRATION_FAILED" | "NOT_INITIALIZED" | "BUSY";

  constructor(
    code: PlannerStoreError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlannerStoreError";
    this.code = code;
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
  error_code: string | null;
  error_detail: string | null;
  created_at: number;
  started_at: number;
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
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    startedAt: row.started_at,
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

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function applyMigrations(database: DatabaseSync, migrationPath: string): void {
  const currentVersion = hasTable(database, "schema_migrations")
    ? Number(
        (
          database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as {
            version: number;
          }
        ).version,
      )
    : 0;
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new PlannerStoreError(
      "MIGRATION_FAILED",
      `Database schema ${currentVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}.`,
    );
  }
  if (currentVersion === CURRENT_SCHEMA_VERSION) return;

  const migration = readFileSync(migrationPath, "utf8");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(migration);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(CURRENT_SCHEMA_VERSION, Date.now());
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw new PlannerStoreError("MIGRATION_FAILED", "SQLite schema migration failed.", {
      cause: error,
    });
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

export class SqlitePlannerStore
  implements
    TransactionRunner<SqliteTransaction>,
    ChatPersistencePort<SqliteTransaction>,
    PlannerReadPort<SqliteTransaction>
{
  readonly filename: string;
  readonly database: DatabaseSync;
  #closed = false;

  constructor(filename: string, database: DatabaseSync) {
    this.filename = filename;
    this.database = database;
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
           created_at, started_at, completed_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, NULL)`,
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
      );
    return { ...turn, turnSequence: nextSequence };
  }

  updateTurnIfRunning(
    transaction: SqliteTransaction,
    turnId: string,
    update: ChatTurnTerminalUpdate,
  ): boolean {
    const result = transaction
      .prepare(
        `UPDATE chat_turns
         SET status = ?, reply_entry_id = ?, proposed_command_json = ?,
             mutation_outcome = ?, error_code = ?, error_detail = ?, completed_at = ?
         WHERE turn_id = ? AND status = 'running'`,
      )
      .run(
        update.status,
        update.replyEntryId,
        update.proposedCommand === null ? null : JSON.stringify(update.proposedCommand),
        update.mutationOutcome,
        update.errorCode,
        update.errorDetail,
        update.completedAt,
        turnId,
      );
    return result.changes === 1;
  }

  interruptRunningTurns(transaction: SqliteTransaction, completedAt: number): number {
    const result = transaction
      .prepare(
        `UPDATE chat_turns
         SET status = 'interrupted', mutation_outcome = NULL,
             error_code = 'SERVER_RESTART',
             error_detail = 'The application restarted before ChatGPT completed.',
             completed_at = ?
         WHERE status = 'running'`,
      )
      .run(completedAt);
    return asNumber(result.changes);
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
          (event_id, request_id, actor, command_json, base_version,
           result_version, summary, target, changes_json, before_state_json,
           reverts_event_id, chat_turn_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.requestId,
        event.actor,
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

  try {
    configureDatabase(
      database,
      busyTimeoutMs,
      isMemory,
    );
    quickCheck(database);
    applyMigrations(database, options.migrationPath ?? DEFAULT_MIGRATION_PATH);
    normalizeStoredLegacyLeftoverSources(database);
    quickCheck(database);
    return new SqlitePlannerStore(filename, database);
  } catch (error) {
    database.close();
    if (error instanceof PlannerStoreError) throw error;
    throw new PlannerStoreError(
      "STORE_CORRUPT",
      `SQLite database ${filename} could not be configured or checked.`,
      { cause: error },
    );
  }
}
