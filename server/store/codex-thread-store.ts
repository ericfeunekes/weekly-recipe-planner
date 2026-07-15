import type { DatabaseSync } from "node:sqlite";

import {
  isPlannerToolResultForTool,
  PLANNER_TOOL_CALL_LIMIT,
  PLANNER_TOOL_RESULT_BYTES_LIMIT,
  type PlannerToolName,
  type PlannerToolResult,
} from "../../lib/planner-tool-contract.ts";
import type { SqlitePlannerStore } from "./sqlite-store.ts";

const IDENTIFIER_LIMIT = 200;
export const NATIVE_THREAD_START_ROOT_ID_LIMIT = 100;
/**
 * Exact durable idempotency horizon. The oldest settled receipt is removed once
 * this many are retained; request ids outside the horizon are intentionally
 * treated as unseen rather than guessed through a probabilistic structure.
 */
export const NATIVE_MUTATION_RECEIPT_LIMIT = 256;

export type CodexThreadSelection = Readonly<{
  selectedThreadId: string | null;
  revision: number;
  updatedAt: number;
}>;

export type NativeThreadStartAdmission = Readonly<{
  requestId: string;
  ownerId: string;
  payloadHash: string;
  expectedSelectionRevision: number;
  newestBeforeCreatedAtSeconds: number | null;
  newestBeforeRootThreadIds: readonly string[];
  createdAt: number;
}>;

export type NativeTurnAdmission = Readonly<{
  threadId: string;
  requestId: string;
  ownerId: string;
  payloadHash: string;
  clientUserMessageId: string;
  operation: "start" | "steer";
  expectedTurnId: string | null;
  createdAt: number;
}>;

export type NativeMutationScope = "new" | "send";

export type NativeMutationReceipt = Readonly<{
  scope: NativeMutationScope;
  requestId: string;
  payloadHash: string;
  threadId: string;
  clientUserMessageId: string | null;
  turnId: string | null;
  selectionRevision: number | null;
  completedAt: number;
}>;

export type NativeAdmissionBeginDecision<Admission> =
  | { status: "started"; admission: Admission }
  | { status: "replay"; admission: Admission }
  | { status: "mismatch"; admission: Admission }
  | { status: "busy"; admission: Admission }
  | { status: "completed"; receipt: NativeMutationReceipt }
  | { status: "receipt_mismatch"; receipt: NativeMutationReceipt };

export type NativeThreadStartAdmissionCompletion = Readonly<{
  requestId: string;
  ownerId: string;
  payloadHash: string;
  selectedThreadId: string;
  updatedAt: number;
}>;

export type NativeThreadStartAdmissionCompletionDecision =
  | { status: "completed"; selection: CodexThreadSelection }
  | { status: "missing" }
  | { status: "mismatch"; admission: NativeThreadStartAdmission }
  | { status: "owner_mismatch"; admission: NativeThreadStartAdmission }
  | { status: "selection_conflict"; admission: NativeThreadStartAdmission };

export type NativeTurnAdmissionCompletion = Readonly<{
  threadId: string;
  requestId: string;
  ownerId: string;
  payloadHash: string;
  turnId: string;
  completedAt: number;
}>;

export type NativeTurnAdmissionCompletionDecision =
  | { status: "completed"; receipt: NativeMutationReceipt }
  | { status: "missing" }
  | { status: "mismatch"; admission: NativeTurnAdmission }
  | { status: "owner_mismatch"; admission: NativeTurnAdmission }
  | { status: "turn_mismatch"; admission: NativeTurnAdmission };

export type NativePlannerToolCallIdentity = Readonly<{
  threadId: string;
  turnId: string;
  callId: string;
  callbackIdentityHash: string;
  tool: PlannerToolName;
  argumentHash: string;
}>;

export type NativePlannerToolCall = NativePlannerToolCallIdentity & Readonly<{
  sequence: number;
  status: "running" | "succeeded" | "rejected";
  resultCode: string | null;
  operationKind: "native_codex_apply_planner_operations_v1" | null;
  requestId: string | null;
  eventId: string | null;
  basePlannerVersion: number | null;
  resultPlannerVersion: number | null;
  resultEnvelope: PlannerToolResult | null;
  createdAt: number;
  completedAt: number | null;
}>;

export type NativePlannerToolReservationDecision =
  | { status: "reserved"; call: NativePlannerToolCall }
  | { status: "recover"; call: NativePlannerToolCall }
  | { status: "replay"; call: NativePlannerToolCall }
  | { status: "duplicate_mismatch" }
  | { status: "call_limit" };

export type NativePlannerToolCompletion = NativePlannerToolCallIdentity & Readonly<{
  status: "succeeded" | "rejected";
  resultCode: string;
  resultEnvelope: PlannerToolResult;
  completedAt: number;
  operationKind?: "native_codex_apply_planner_operations_v1";
  requestId?: string;
  eventId?: string;
  basePlannerVersion?: number;
  resultPlannerVersion?: number;
}>;

type SelectionRow = {
  selected_thread_id: string | null;
  revision: number;
  updated_at: number;
};

type ThreadStartAdmissionRow = {
  request_id: string;
  owner_id: string;
  payload_hash: string;
  expected_selection_revision: number;
  newest_before_created_at_seconds: number | null;
  newest_before_root_thread_ids_json: string;
  created_at: number;
};

type TurnAdmissionRow = {
  thread_id: string;
  request_id: string;
  owner_id: string;
  payload_hash: string;
  client_user_message_id: string;
  operation: NativeTurnAdmission["operation"];
  expected_turn_id: string | null;
  created_at: number;
};

type NativeMutationReceiptRow = {
  scope: NativeMutationScope;
  request_id: string;
  payload_hash: string;
  thread_id: string;
  client_user_message_id: string | null;
  turn_id: string | null;
  selection_revision: number | null;
  completed_at: number;
};

type NativePlannerToolCallRow = {
  thread_id: string;
  turn_id: string;
  call_id: string;
  callback_identity_hash: string;
  sequence: number;
  tool: PlannerToolName;
  argument_hash: string;
  status: NativePlannerToolCall["status"];
  result_code: string | null;
  operation_kind: NativePlannerToolCall["operationKind"];
  request_id: string | null;
  event_id: string | null;
  base_planner_version: number | null;
  result_planner_version: number | null;
  result_envelope_json: string | null;
  created_at: number;
  completed_at: number | null;
};

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= IDENTIFIER_LIMIT && value.trim().length > 0 &&
    !value.includes("\0");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertAdmissionKey(requestId: unknown, payloadHash: unknown) {
  if (!isIdentifier(requestId) || !isSha256(payloadHash)) {
    throw new TypeError("Native Codex admission identity is malformed.");
  }
}

function assertOwnerId(ownerId: unknown) {
  if (!isIdentifier(ownerId)) {
    throw new TypeError("Native Codex admission owner id is malformed.");
  }
}

function assertThreadStartAdmission(admission: NativeThreadStartAdmission) {
  assertAdmissionKey(admission.requestId, admission.payloadHash);
  assertOwnerId(admission.ownerId);
  if (
    !isNonNegativeSafeInteger(admission.expectedSelectionRevision) ||
    !isNonNegativeSafeInteger(admission.createdAt) ||
    !Array.isArray(admission.newestBeforeRootThreadIds) ||
    admission.newestBeforeRootThreadIds.length > NATIVE_THREAD_START_ROOT_ID_LIMIT
  ) {
    throw new TypeError("Native Codex thread-start admission is malformed.");
  }
  const rootIds = new Set<string>();
  for (const threadId of admission.newestBeforeRootThreadIds) {
    if (!isIdentifier(threadId) || rootIds.has(threadId)) {
      throw new TypeError("Native Codex thread-start root snapshot is malformed.");
    }
    rootIds.add(threadId);
  }
  const hasNewestTimestamp = admission.newestBeforeCreatedAtSeconds !== null;
  if (
    (hasNewestTimestamp &&
      !isNonNegativeSafeInteger(admission.newestBeforeCreatedAtSeconds)) ||
    hasNewestTimestamp !== (admission.newestBeforeRootThreadIds.length > 0)
  ) {
    throw new TypeError("Native Codex thread-start root snapshot is inconsistent.");
  }
}

function assertTurnAdmission(admission: NativeTurnAdmission) {
  assertAdmissionKey(admission.requestId, admission.payloadHash);
  assertOwnerId(admission.ownerId);
  if (
    !isIdentifier(admission.threadId) ||
    !isIdentifier(admission.clientUserMessageId) ||
    !isNonNegativeSafeInteger(admission.createdAt) ||
    (admission.operation !== "start" && admission.operation !== "steer") ||
    (admission.operation === "start" && admission.expectedTurnId !== null) ||
    (admission.operation === "steer" && !isIdentifier(admission.expectedTurnId))
  ) {
    throw new TypeError("Native Codex turn admission is malformed.");
  }
}

function parseRootThreadIds(row: ThreadStartAdmissionRow): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(row.newest_before_root_thread_ids_json);
  } catch (error) {
    throw new TypeError("Native Codex thread-start root snapshot is not valid JSON.", {
      cause: error,
    });
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Native Codex thread-start root snapshot is malformed.");
  }
  return Object.freeze([...value] as string[]);
}

function mapThreadStartAdmission(row: ThreadStartAdmissionRow): NativeThreadStartAdmission {
  const admission: NativeThreadStartAdmission = {
    requestId: row.request_id,
    ownerId: row.owner_id,
    payloadHash: row.payload_hash,
    expectedSelectionRevision: row.expected_selection_revision,
    newestBeforeCreatedAtSeconds: row.newest_before_created_at_seconds,
    newestBeforeRootThreadIds: parseRootThreadIds(row),
    createdAt: row.created_at,
  };
  assertThreadStartAdmission(admission);
  return Object.freeze(admission);
}

function mapTurnAdmission(row: TurnAdmissionRow): NativeTurnAdmission {
  const admission: NativeTurnAdmission = {
    threadId: row.thread_id,
    requestId: row.request_id,
    ownerId: row.owner_id,
    payloadHash: row.payload_hash,
    clientUserMessageId: row.client_user_message_id,
    operation: row.operation,
    expectedTurnId: row.expected_turn_id,
    createdAt: row.created_at,
  };
  assertTurnAdmission(admission);
  return Object.freeze(admission);
}

function assertMutationReceipt(receipt: NativeMutationReceipt) {
  assertAdmissionKey(receipt.requestId, receipt.payloadHash);
  if (
    (receipt.scope !== "new" && receipt.scope !== "send") ||
    !isIdentifier(receipt.threadId) ||
    !isNonNegativeSafeInteger(receipt.completedAt) ||
    (receipt.scope === "new" &&
      (receipt.clientUserMessageId !== null || receipt.turnId !== null ||
        !isNonNegativeSafeInteger(receipt.selectionRevision))) ||
    (receipt.scope === "send" &&
      (!isIdentifier(receipt.clientUserMessageId) || !isIdentifier(receipt.turnId) ||
        receipt.selectionRevision !== null))
  ) {
    throw new TypeError("Native Codex mutation receipt is malformed.");
  }
}

function mapMutationReceipt(row: NativeMutationReceiptRow): NativeMutationReceipt {
  const receipt: NativeMutationReceipt = {
    scope: row.scope,
    requestId: row.request_id,
    payloadHash: row.payload_hash,
    threadId: row.thread_id,
    clientUserMessageId: row.client_user_message_id,
    turnId: row.turn_id,
    selectionRevision: row.selection_revision,
    completedAt: row.completed_at,
  };
  assertMutationReceipt(receipt);
  return Object.freeze(receipt);
}

function readMutationReceiptFrom(
  database: DatabaseSync,
  scope: NativeMutationScope,
  requestId: string,
) {
  const row = database.prepare(
    `SELECT scope, request_id, payload_hash, thread_id,
            client_user_message_id, turn_id,
            selection_revision, completed_at
     FROM codex_native_mutation_receipts
     WHERE scope = ? AND request_id = ?`,
  ).get(scope, requestId) as NativeMutationReceiptRow | undefined;
  return row ? mapMutationReceipt(row) : null;
}

function sameThreadStartIdentity(
  existing: NativeThreadStartAdmission,
  incoming: NativeThreadStartAdmission,
) {
  return existing.requestId === incoming.requestId &&
    existing.payloadHash === incoming.payloadHash &&
    existing.expectedSelectionRevision === incoming.expectedSelectionRevision;
}

function sameTurnIdentity(
  existing: NativeTurnAdmission,
  incoming: NativeTurnAdmission,
) {
  return existing.threadId === incoming.threadId &&
    existing.requestId === incoming.requestId &&
    existing.payloadHash === incoming.payloadHash &&
    existing.clientUserMessageId === incoming.clientUserMessageId &&
    existing.operation === incoming.operation &&
    existing.expectedTurnId === incoming.expectedTurnId;
}

function assertIdentity(identity: NativePlannerToolCallIdentity) {
  if (
    !isIdentifier(identity.threadId) ||
    !isIdentifier(identity.turnId) ||
    !isIdentifier(identity.callId) ||
    !isSha256(identity.callbackIdentityHash) ||
    !isSha256(identity.argumentHash)
  ) {
    throw new TypeError("Native planner tool identity is malformed.");
  }
}

function parseResult(
  row: NativePlannerToolCallRow,
): PlannerToolResult | null {
  if (row.result_envelope_json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.result_envelope_json);
  } catch (error) {
    throw new TypeError("Native planner tool result is not valid JSON.", { cause: error });
  }
  if (
    !isPlannerToolResultForTool(row.tool, value) ||
    value.callId !== row.call_id
  ) {
    throw new TypeError("Native planner tool result violates its tool contract.");
  }
  return value;
}

function mapCall(row: NativePlannerToolCallRow): NativePlannerToolCall {
  const resultEnvelope = parseResult(row);
  if (
    (row.status === "running" && (resultEnvelope !== null || row.completed_at !== null)) ||
    (row.status !== "running" && (resultEnvelope === null || row.completed_at === null))
  ) {
    throw new TypeError("Native planner tool lifecycle row is inconsistent.");
  }
  return Object.freeze({
    threadId: row.thread_id,
    turnId: row.turn_id,
    callId: row.call_id,
    callbackIdentityHash: row.callback_identity_hash,
    sequence: row.sequence,
    tool: row.tool,
    argumentHash: row.argument_hash,
    status: row.status,
    resultCode: row.result_code,
    operationKind: row.operation_kind,
    requestId: row.request_id,
    eventId: row.event_id,
    basePlannerVersion: row.base_planner_version,
    resultPlannerVersion: row.result_planner_version,
    resultEnvelope,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

function sameIdentity(
  call: NativePlannerToolCall,
  identity: NativePlannerToolCallIdentity,
) {
  return call.threadId === identity.threadId &&
    call.turnId === identity.turnId &&
    call.callId === identity.callId &&
    call.callbackIdentityHash === identity.callbackIdentityHash &&
    call.tool === identity.tool &&
    call.argumentHash === identity.argumentHash;
}

export class SqliteCodexThreadStore {
  readonly #store: Pick<SqlitePlannerStore, "transaction" | "readTransaction">;

  constructor(store: Pick<SqlitePlannerStore, "transaction" | "readTransaction">) {
    this.#store = store;
  }

  transaction<Result>(work: (database: DatabaseSync) => Result): Result {
    return this.#store.transaction(work);
  }

  readSelection(): CodexThreadSelection {
    return this.#store.readTransaction((database) => {
      const row = database.prepare(
        `SELECT selected_thread_id, revision, updated_at
         FROM codex_thread_selection WHERE id = 'planner'`,
      ).get() as SelectionRow | undefined;
      if (!row) throw new Error("Codex thread selection singleton is missing.");
      return Object.freeze({
        selectedThreadId: row.selected_thread_id,
        revision: row.revision,
        updatedAt: row.updated_at,
      });
    });
  }

  compareAndSetSelection(
    expectedRevision: number,
    selectedThreadId: string | null,
    updatedAt: number,
  ): CodexThreadSelection | null {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("Expected selection revision must be non-negative.");
    }
    if (selectedThreadId !== null && !isIdentifier(selectedThreadId)) {
      throw new TypeError("Selected Codex thread id is malformed.");
    }
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      throw new TypeError("Selection update time must be non-negative.");
    }
    return this.#store.transaction((database) => {
      const row = database.prepare(
        `UPDATE codex_thread_selection
         SET selected_thread_id = ?, revision = revision + 1, updated_at = ?
         WHERE id = 'planner' AND revision = ?
         RETURNING selected_thread_id, revision, updated_at`,
      ).get(selectedThreadId, updatedAt, expectedRevision) as SelectionRow | undefined;
      return row
        ? Object.freeze({
            selectedThreadId: row.selected_thread_id,
            revision: row.revision,
            updatedAt: row.updated_at,
          })
        : null;
    });
  }

  readMutationReceipt(
    scope: NativeMutationScope,
    requestId: string,
  ): NativeMutationReceipt | null {
    if ((scope !== "new" && scope !== "send") || !isIdentifier(requestId)) {
      throw new TypeError("Native Codex mutation receipt identity is malformed.");
    }
    return this.#store.readTransaction((database) =>
      readMutationReceiptFrom(database, scope, requestId)
    );
  }

  /**
   * Transfers unresolved admissions to a freshly started runtime. The caller
   * must already hold the planner's exclusive runtime-owner boundary; this is
   * crash recovery, never a live-owner takeover mechanism.
   */
  adoptAdmissionsForExclusiveRecovery(ownerId: string) {
    assertOwnerId(ownerId);
    return this.#store.transaction((database) => {
      const threadStarts = database.prepare(
        "UPDATE codex_thread_start_admission SET owner_id = ? WHERE owner_id <> ?",
      ).run(ownerId, ownerId).changes;
      const turns = database.prepare(
        "UPDATE codex_turn_admissions SET owner_id = ? WHERE owner_id <> ?",
      ).run(ownerId, ownerId).changes;
      return Object.freeze({ threadStarts, turns });
    });
  }

  readThreadStartAdmission(): NativeThreadStartAdmission | null {
    return this.#store.readTransaction((database) => {
      const row = database.prepare(
        `SELECT request_id, owner_id, payload_hash, expected_selection_revision,
                newest_before_created_at_seconds,
                newest_before_root_thread_ids_json, created_at
         FROM codex_thread_start_admission WHERE id = 'planner'`,
      ).get() as ThreadStartAdmissionRow | undefined;
      return row ? mapThreadStartAdmission(row) : null;
    });
  }

  beginThreadStartAdmission(
    admission: NativeThreadStartAdmission,
  ): NativeAdmissionBeginDecision<NativeThreadStartAdmission> {
    assertThreadStartAdmission(admission);
    const rootIdsJson = JSON.stringify(admission.newestBeforeRootThreadIds);
    return this.#store.transaction((database) => {
      const receipt = readMutationReceiptFrom(database, "new", admission.requestId);
      if (receipt !== null) {
        return receipt.payloadHash === admission.payloadHash
          ? { status: "completed", receipt }
          : { status: "receipt_mismatch", receipt };
      }
      const existingRow = database.prepare(
        `SELECT request_id, owner_id, payload_hash, expected_selection_revision,
                newest_before_created_at_seconds,
                newest_before_root_thread_ids_json, created_at
         FROM codex_thread_start_admission WHERE id = 'planner'`,
      ).get() as ThreadStartAdmissionRow | undefined;
      if (existingRow) {
        const existing = mapThreadStartAdmission(existingRow);
        if (sameThreadStartIdentity(existing, admission)) {
          return { status: "replay", admission: existing };
        }
        return existing.requestId === admission.requestId
          ? { status: "mismatch", admission: existing }
          : { status: "busy", admission: existing };
      }
      database.prepare(
        `INSERT INTO codex_thread_start_admission
          (id, request_id, owner_id, payload_hash, expected_selection_revision,
           newest_before_created_at_seconds,
           newest_before_root_thread_ids_json, created_at)
         VALUES ('planner', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        admission.requestId,
        admission.ownerId,
        admission.payloadHash,
        admission.expectedSelectionRevision,
        admission.newestBeforeCreatedAtSeconds,
        rootIdsJson,
        admission.createdAt,
      );
      const inserted = database.prepare(
        `SELECT request_id, owner_id, payload_hash, expected_selection_revision,
                newest_before_created_at_seconds,
                newest_before_root_thread_ids_json, created_at
         FROM codex_thread_start_admission WHERE id = 'planner'`,
      ).get() as ThreadStartAdmissionRow;
      return { status: "started", admission: mapThreadStartAdmission(inserted) };
    });
  }

  clearThreadStartAdmission(requestId: string, ownerId: string, payloadHash: string): boolean {
    assertAdmissionKey(requestId, payloadHash);
    assertOwnerId(ownerId);
    return this.#store.transaction((database) =>
      database.prepare(
        `DELETE FROM codex_thread_start_admission
         WHERE id = 'planner' AND request_id = ? AND owner_id = ? AND payload_hash = ?`,
      ).run(requestId, ownerId, payloadHash).changes === 1
    );
  }

  completeThreadStartAdmission(
    completion: NativeThreadStartAdmissionCompletion,
  ): NativeThreadStartAdmissionCompletionDecision {
    assertAdmissionKey(completion.requestId, completion.payloadHash);
    assertOwnerId(completion.ownerId);
    if (!isIdentifier(completion.selectedThreadId) ||
        !isNonNegativeSafeInteger(completion.updatedAt)) {
      throw new TypeError("Native Codex thread-start completion is malformed.");
    }
    return this.#store.transaction((database) => {
      const row = database.prepare(
        `SELECT request_id, owner_id, payload_hash, expected_selection_revision,
                newest_before_created_at_seconds,
                newest_before_root_thread_ids_json, created_at
         FROM codex_thread_start_admission WHERE id = 'planner'`,
      ).get() as ThreadStartAdmissionRow | undefined;
      if (!row) return { status: "missing" };
      const admission = mapThreadStartAdmission(row);
      if (admission.requestId !== completion.requestId ||
          admission.payloadHash !== completion.payloadHash) {
        return { status: "mismatch", admission };
      }
      if (admission.ownerId !== completion.ownerId) {
        return { status: "owner_mismatch", admission };
      }
      const selectionRow = database.prepare(
        `UPDATE codex_thread_selection
         SET selected_thread_id = ?, revision = revision + 1, updated_at = ?
         WHERE id = 'planner' AND revision = ?
         RETURNING selected_thread_id, revision, updated_at`,
      ).get(
        completion.selectedThreadId,
        completion.updatedAt,
        admission.expectedSelectionRevision,
      ) as SelectionRow | undefined;
      if (!selectionRow) return { status: "selection_conflict", admission };
      database.prepare(
        `INSERT INTO codex_native_mutation_receipts
          (scope, request_id, payload_hash, thread_id, client_user_message_id, turn_id,
           selection_revision, completed_at)
         VALUES ('new', ?, ?, ?, NULL, NULL, ?, ?)`,
      ).run(
        completion.requestId,
        completion.payloadHash,
        completion.selectedThreadId,
        selectionRow.revision,
        completion.updatedAt,
      );
      this.#pruneMutationReceipts(database);
      const cleared = database.prepare(
        `DELETE FROM codex_thread_start_admission
         WHERE id = 'planner' AND request_id = ? AND owner_id = ? AND payload_hash = ?`,
      ).run(completion.requestId, completion.ownerId, completion.payloadHash);
      if (cleared.changes !== 1) {
        throw new Error("Completed Codex thread-start admission could not be cleared.");
      }
      return {
        status: "completed",
        selection: Object.freeze({
          selectedThreadId: selectionRow.selected_thread_id,
          revision: selectionRow.revision,
          updatedAt: selectionRow.updated_at,
        }),
      };
    });
  }

  readTurnAdmission(threadId: string): NativeTurnAdmission | null {
    if (!isIdentifier(threadId)) {
      throw new TypeError("Native Codex turn admission thread id is malformed.");
    }
    return this.#store.readTransaction((database) => {
      const row = database.prepare(
        `SELECT thread_id, request_id, owner_id, payload_hash, client_user_message_id,
                operation, expected_turn_id, created_at
         FROM codex_turn_admissions WHERE thread_id = ?`,
      ).get(threadId) as TurnAdmissionRow | undefined;
      return row ? mapTurnAdmission(row) : null;
    });
  }

  readTurnAdmissionByRequestId(requestId: string): NativeTurnAdmission | null {
    if (!isIdentifier(requestId)) {
      throw new TypeError("Native Codex turn admission request id is malformed.");
    }
    return this.#store.readTransaction((database) => {
      const row = database.prepare(
        `SELECT thread_id, request_id, owner_id, payload_hash, client_user_message_id,
                operation, expected_turn_id, created_at
         FROM codex_turn_admissions WHERE request_id = ?`,
      ).get(requestId) as TurnAdmissionRow | undefined;
      return row ? mapTurnAdmission(row) : null;
    });
  }

  listTurnAdmissions(): NativeTurnAdmission[] {
    return this.#store.readTransaction((database) => {
      const rows = database.prepare(
        `SELECT thread_id, request_id, owner_id, payload_hash, client_user_message_id,
                operation, expected_turn_id, created_at
         FROM codex_turn_admissions ORDER BY created_at ASC, thread_id ASC`,
      ).all() as TurnAdmissionRow[];
      return rows.map(mapTurnAdmission);
    });
  }

  beginTurnAdmission(
    admission: NativeTurnAdmission,
  ): NativeAdmissionBeginDecision<NativeTurnAdmission> {
    assertTurnAdmission(admission);
    return this.#store.transaction((database) => {
      const receipt = readMutationReceiptFrom(database, "send", admission.requestId);
      if (receipt !== null) {
        return receipt.payloadHash === admission.payloadHash
          ? { status: "completed", receipt }
          : { status: "receipt_mismatch", receipt };
      }
      const requestRow = database.prepare(
        `SELECT thread_id, request_id, owner_id, payload_hash, client_user_message_id,
                operation, expected_turn_id, created_at
         FROM codex_turn_admissions WHERE request_id = ?`,
      ).get(admission.requestId) as TurnAdmissionRow | undefined;
      if (requestRow) {
        const existing = mapTurnAdmission(requestRow);
        return sameTurnIdentity(existing, admission)
          ? { status: "replay", admission: existing }
          : { status: "mismatch", admission: existing };
      }
      const threadRow = database.prepare(
        `SELECT thread_id, request_id, owner_id, payload_hash, client_user_message_id,
                operation, expected_turn_id, created_at
         FROM codex_turn_admissions WHERE thread_id = ?`,
      ).get(admission.threadId) as TurnAdmissionRow | undefined;
      if (threadRow) {
        return { status: "busy", admission: mapTurnAdmission(threadRow) };
      }
      database.prepare(
        `INSERT INTO codex_turn_admissions
          (thread_id, request_id, owner_id, payload_hash, client_user_message_id,
           operation, expected_turn_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        admission.threadId,
        admission.requestId,
        admission.ownerId,
        admission.payloadHash,
        admission.clientUserMessageId,
        admission.operation,
        admission.expectedTurnId,
        admission.createdAt,
      );
      const inserted = database.prepare(
        `SELECT thread_id, request_id, owner_id, payload_hash, client_user_message_id,
                operation, expected_turn_id, created_at
         FROM codex_turn_admissions WHERE thread_id = ?`,
      ).get(admission.threadId) as TurnAdmissionRow;
      return { status: "started", admission: mapTurnAdmission(inserted) };
    });
  }

  clearTurnAdmission(
    threadId: string,
    requestId: string,
    ownerId: string,
    payloadHash: string,
  ): boolean {
    if (!isIdentifier(threadId)) {
      throw new TypeError("Native Codex turn admission thread id is malformed.");
    }
    assertAdmissionKey(requestId, payloadHash);
    assertOwnerId(ownerId);
    return this.#store.transaction((database) =>
      database.prepare(
        `DELETE FROM codex_turn_admissions
         WHERE thread_id = ? AND request_id = ? AND owner_id = ? AND payload_hash = ?`,
      ).run(threadId, requestId, ownerId, payloadHash).changes === 1
    );
  }

  completeTurnAdmission(
    completion: NativeTurnAdmissionCompletion,
  ): NativeTurnAdmissionCompletionDecision {
    if (!isIdentifier(completion.threadId) || !isIdentifier(completion.turnId) ||
        !isNonNegativeSafeInteger(completion.completedAt)) {
      throw new TypeError("Native Codex turn admission completion is malformed.");
    }
    assertAdmissionKey(completion.requestId, completion.payloadHash);
    assertOwnerId(completion.ownerId);
    return this.#store.transaction((database) => {
      const row = database.prepare(
        `SELECT thread_id, request_id, owner_id, payload_hash, client_user_message_id,
                operation, expected_turn_id, created_at
         FROM codex_turn_admissions WHERE thread_id = ?`,
      ).get(completion.threadId) as TurnAdmissionRow | undefined;
      if (!row) return { status: "missing" };
      const admission = mapTurnAdmission(row);
      if (admission.requestId !== completion.requestId ||
          admission.payloadHash !== completion.payloadHash) {
        return { status: "mismatch", admission };
      }
      if (admission.ownerId !== completion.ownerId) {
        return { status: "owner_mismatch", admission };
      }
      if (admission.operation === "steer" &&
          admission.expectedTurnId !== completion.turnId) {
        return { status: "turn_mismatch", admission };
      }
      database.prepare(
        `INSERT INTO codex_native_mutation_receipts
          (scope, request_id, payload_hash, thread_id, client_user_message_id, turn_id,
           selection_revision, completed_at)
         VALUES ('send', ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        completion.requestId,
        completion.payloadHash,
        completion.threadId,
        admission.clientUserMessageId,
        completion.turnId,
        completion.completedAt,
      );
      this.#pruneMutationReceipts(database);
      const cleared = database.prepare(
        `DELETE FROM codex_turn_admissions
         WHERE thread_id = ? AND request_id = ? AND owner_id = ? AND payload_hash = ?`,
      ).run(
        completion.threadId,
        completion.requestId,
        completion.ownerId,
        completion.payloadHash,
      );
      if (cleared.changes !== 1) {
        throw new Error("Completed Codex turn admission could not be cleared.");
      }
      const receipt = database.prepare(
        `SELECT scope, request_id, payload_hash, thread_id,
                client_user_message_id, turn_id,
                selection_revision, completed_at
         FROM codex_native_mutation_receipts
         WHERE scope = 'send' AND request_id = ?`,
      ).get(completion.requestId) as NativeMutationReceiptRow;
      return { status: "completed", receipt: mapMutationReceipt(receipt) };
    });
  }

  #pruneMutationReceipts(database: DatabaseSync) {
    const count = Number((database.prepare(
      "SELECT count(*) AS count FROM codex_native_mutation_receipts",
    ).get() as { count: number }).count);
    if (count <= NATIVE_MUTATION_RECEIPT_LIMIT) return;
    const pruneCount = count - NATIVE_MUTATION_RECEIPT_LIMIT;
    const candidates = database.prepare(
      `SELECT r.scope, r.request_id, r.payload_hash, r.thread_id,
              r.client_user_message_id, r.turn_id,
              r.selection_revision, r.completed_at
       FROM codex_native_mutation_receipts AS r
       WHERE NOT (
         r.scope = 'new' AND EXISTS (
           SELECT 1 FROM codex_thread_start_admission AS a
           WHERE a.request_id = r.request_id AND a.payload_hash = r.payload_hash
         )
       )
       AND NOT (
         r.scope = 'send' AND EXISTS (
           SELECT 1 FROM codex_turn_admissions AS a
           WHERE a.request_id = r.request_id AND a.payload_hash = r.payload_hash
         )
       )
       ORDER BY r.receipt_sequence ASC
       LIMIT ?`,
    ).all(pruneCount) as NativeMutationReceiptRow[];
    if (candidates.length !== pruneCount) {
      throw new Error("Native Codex mutation receipts cannot be pruned safely.");
    }
    for (const candidate of candidates) {
      const receipt = mapMutationReceipt(candidate);
      const deleted = database.prepare(
        `DELETE FROM codex_native_mutation_receipts
         WHERE scope = ? AND request_id = ? AND payload_hash = ?`,
      ).run(receipt.scope, receipt.requestId, receipt.payloadHash);
      if (deleted.changes !== 1) {
        throw new Error("Native Codex mutation receipt changed during pruning.");
      }
    }
  }

  reservePlannerToolCall(
    identity: NativePlannerToolCallIdentity,
    createdAt: number,
  ): NativePlannerToolReservationDecision {
    assertIdentity(identity);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new TypeError("Native planner tool creation time must be non-negative.");
    }
    return this.#store.transaction((database) => {
      const existingRow = database.prepare(
        `SELECT * FROM codex_native_tool_calls
         WHERE thread_id = ? AND turn_id = ? AND call_id = ?`,
      ).get(identity.threadId, identity.turnId, identity.callId) as
        | NativePlannerToolCallRow
        | undefined;
      if (existingRow) {
        const call = mapCall(existingRow);
        if (!sameIdentity(call, identity)) return { status: "duplicate_mismatch" };
        return call.status === "running"
          ? { status: "recover", call }
          : { status: "replay", call };
      }

      const count = Number((database.prepare(
        `SELECT count(*) AS count FROM codex_native_tool_calls
         WHERE thread_id = ? AND turn_id = ?`,
      ).get(identity.threadId, identity.turnId) as { count: number }).count);
      if (count >= PLANNER_TOOL_CALL_LIMIT) return { status: "call_limit" };
      const sequence = count + 1;
      database.prepare(
        `INSERT INTO codex_native_tool_calls
          (thread_id, turn_id, call_id, callback_identity_hash, sequence,
           tool, argument_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      ).run(
        identity.threadId,
        identity.turnId,
        identity.callId,
        identity.callbackIdentityHash,
        sequence,
        identity.tool,
        identity.argumentHash,
        createdAt,
      );
      const inserted = database.prepare(
        `SELECT * FROM codex_native_tool_calls
         WHERE thread_id = ? AND turn_id = ? AND call_id = ?`,
      ).get(identity.threadId, identity.turnId, identity.callId) as NativePlannerToolCallRow;
      return { status: "reserved", call: mapCall(inserted) };
    });
  }

  completePlannerToolCall(
    completion: NativePlannerToolCompletion,
    transaction?: DatabaseSync,
  ): boolean {
    assertIdentity(completion);
    if (
      !isPlannerToolResultForTool(completion.tool, completion.resultEnvelope) ||
      completion.resultEnvelope.callId !== completion.callId
    ) {
      throw new TypeError("Native planner completion result violates its tool contract.");
    }
    const serialized = JSON.stringify(completion.resultEnvelope);
    if (Buffer.byteLength(serialized, "utf8") > PLANNER_TOOL_RESULT_BYTES_LIMIT) {
      throw new TypeError("Native planner completion result exceeds its byte limit.");
    }
    if (!Number.isSafeInteger(completion.completedAt) || completion.completedAt < 0) {
      throw new TypeError("Native planner completion time must be non-negative.");
    }
    const complete = (database: DatabaseSync) => {
      const result = database.prepare(
        `UPDATE codex_native_tool_calls
         SET status = ?, result_code = ?, operation_kind = ?, request_id = ?,
             event_id = ?, base_planner_version = ?, result_planner_version = ?,
             result_envelope_json = ?, completed_at = ?
         WHERE thread_id = ? AND turn_id = ? AND call_id = ? AND status = 'running'
           AND callback_identity_hash = ? AND tool = ? AND argument_hash = ?`,
      ).run(
        completion.status,
        completion.resultCode,
        completion.operationKind ?? null,
        completion.requestId ?? null,
        completion.eventId ?? null,
        completion.basePlannerVersion ?? null,
        completion.resultPlannerVersion ?? null,
        serialized,
        completion.completedAt,
        completion.threadId,
        completion.turnId,
        completion.callId,
        completion.callbackIdentityHash,
        completion.tool,
        completion.argumentHash,
      );
      return result.changes === 1;
    };
    return transaction ? complete(transaction) : this.#store.transaction(complete);
  }

  readPlannerToolCalls(
    threadId: string,
    turnId?: string,
    transaction?: DatabaseSync,
  ): NativePlannerToolCall[] {
    if (!isIdentifier(threadId) || (turnId !== undefined && !isIdentifier(turnId))) {
      throw new TypeError("Native planner tool query identity is malformed.");
    }
    const read = (database: DatabaseSync) => {
      const rows = (turnId === undefined
        ? database.prepare(
            `SELECT * FROM codex_native_tool_calls
             WHERE thread_id = ? ORDER BY created_at ASC, sequence ASC`,
          ).all(threadId)
        : database.prepare(
            `SELECT * FROM codex_native_tool_calls
             WHERE thread_id = ? AND turn_id = ? ORDER BY sequence ASC`,
          ).all(threadId, turnId)) as NativePlannerToolCallRow[];
      return rows.map(mapCall);
    };
    return transaction ? read(transaction) : this.#store.readTransaction(read);
  }
}

export function createSqliteCodexThreadStore(
  store: Pick<SqlitePlannerStore, "transaction" | "readTransaction">,
) {
  return new SqliteCodexThreadStore(store);
}
