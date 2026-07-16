export const AUTHORITY_OPERATION_JOURNAL_KEY =
  "weekly-recipe-planner:authority-operations:v1";
export const AUTHORITY_OPERATION_JOURNAL_EVENT =
  "weekly-recipe-planner:authority-operations-change";

export const AUTHORITY_OPERATION_KINDS = [
  "planner",
  "bootstrap",
  "undo",
] as const;

export type AuthorityOperationKind = (typeof AUTHORITY_OPERATION_KINDS)[number];
export type AuthorityOperationState =
  | "prepared"
  | "ambiguous"
  | "resolved_conflict";

export type AuthorityOperationResolution = {
  code: string;
  message: string;
};

export type PendingAuthorityOperation = {
  schemaVersion: 1;
  kind: AuthorityOperationKind;
  path: string;
  requestId: string;
  serializedBody: string;
  state: AuthorityOperationState;
  createdAt: number;
  label: string;
  submittedDraft: unknown;
  editableDraft: unknown;
  resolution: AuthorityOperationResolution | null;
};

export type PrepareAuthorityOperationInput = {
  kind: AuthorityOperationKind;
  path: string;
  body: unknown;
  label: string;
  submittedDraft?: unknown;
  createdAt?: number;
};

type JournalEnvelope = {
  schemaVersion: 1;
  operations: PendingAuthorityOperation[];
};

type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const MAX_OPERATIONS = 16;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_LABEL_LENGTH = 240;
const OPERATION_PATHS: Record<AuthorityOperationKind, string> = {
  planner: "/api/commands",
  bootstrap: "/api/bootstrap",
  undo: "/api/undo",
};

export class AuthorityOperationJournalError extends Error {
  readonly code:
    | "STORAGE_UNAVAILABLE"
    | "STORAGE_CORRUPT"
    | "JOURNAL_CAPACITY"
    | "INVALID_OPERATION"
    | "REQUEST_ID_REUSE";

  constructor(
    code: AuthorityOperationJournalError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthorityOperationJournalError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isResolution(value: unknown): value is AuthorityOperationResolution {
  return isRecord(value) && hasExactKeys(value, ["code", "message"]) &&
    typeof value.code === "string" && value.code.length > 0 && value.code.length <= 120 &&
    typeof value.message === "string" && value.message.length > 0 && value.message.length <= 1_000;
}

function isOperation(value: unknown): value is PendingAuthorityOperation {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "kind",
    "path",
    "requestId",
    "serializedBody",
    "state",
    "createdAt",
    "label",
    "submittedDraft",
    "editableDraft",
    "resolution",
  ])) return false;
  if (
    value.schemaVersion !== 1 ||
    !AUTHORITY_OPERATION_KINDS.includes(value.kind as AuthorityOperationKind) ||
    !["prepared", "ambiguous", "resolved_conflict"].includes(String(value.state)) ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    value.requestId.length > 200 ||
    typeof value.serializedBody !== "string" ||
    value.serializedBody.length === 0 ||
    !Number.isSafeInteger(value.createdAt) ||
    Number(value.createdAt) < 0 ||
    typeof value.label !== "string" ||
    value.label.length === 0 ||
    value.label.length > MAX_LABEL_LENGTH ||
    (value.resolution !== null && !isResolution(value.resolution))
  ) return false;
  const kind = value.kind as AuthorityOperationKind;
  if (value.path !== OPERATION_PATHS[kind]) return false;
  try {
    const body: unknown = JSON.parse(value.serializedBody);
    return isRecord(body) && body.requestId === value.requestId;
  } catch {
    return false;
  }
}

function emptyJournal(): JournalEnvelope {
  return { schemaVersion: 1, operations: [] };
}

function storageOrDefault(storage?: JournalStorage | null): JournalStorage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  try {
    // Recovery is intentionally scoped to one top-level browsing session.
    return window.sessionStorage;
  } catch (error) {
    throw new AuthorityOperationJournalError(
      "STORAGE_UNAVAILABLE",
      "This browser cannot access the pending-operation recovery store.",
      { cause: error },
    );
  }
}

function readJournal(storage?: JournalStorage | null): JournalEnvelope {
  const target = storageOrDefault(storage);
  if (target === null) return emptyJournal();
  let raw: string | null;
  try {
    raw = target.getItem(AUTHORITY_OPERATION_JOURNAL_KEY);
  } catch (error) {
    throw new AuthorityOperationJournalError(
      "STORAGE_UNAVAILABLE",
      "The pending-operation recovery store could not be read.",
      { cause: error },
    );
  }
  if (raw === null) return emptyJournal();
  if (raw.length > MAX_JOURNAL_BYTES) {
    throw new AuthorityOperationJournalError(
      "STORAGE_CORRUPT",
      "The pending-operation recovery store exceeds its supported size.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      !hasExactKeys(parsed, ["schemaVersion", "operations"]) ||
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.operations) ||
      parsed.operations.length > MAX_OPERATIONS ||
      !parsed.operations.every(isOperation)
    ) {
      throw new Error("closed journal schema mismatch");
    }
    const keys = new Set(parsed.operations.map((operation) => operationKey(operation)));
    if (keys.size !== parsed.operations.length) {
      throw new Error("duplicate pending operation");
    }
    return parsed as JournalEnvelope;
  } catch (error) {
    throw new AuthorityOperationJournalError(
      "STORAGE_CORRUPT",
      "The pending-operation recovery store is damaged. Review the shared plan before clearing local recovery data.",
      { cause: error },
    );
  }
}

function emitChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTHORITY_OPERATION_JOURNAL_EVENT));
  }
}

function writeJournal(journal: JournalEnvelope, storage?: JournalStorage | null): void {
  const target = storageOrDefault(storage);
  if (target === null) return;
  const serialized = JSON.stringify(journal);
  if (serialized.length > MAX_JOURNAL_BYTES) {
    throw new AuthorityOperationJournalError(
      "JOURNAL_CAPACITY",
      "Pending shared changes filled this browser's recovery store. Resolve them before starting another change.",
    );
  }
  try {
    if (journal.operations.length === 0) {
      target.removeItem(AUTHORITY_OPERATION_JOURNAL_KEY);
    } else {
      target.setItem(AUTHORITY_OPERATION_JOURNAL_KEY, serialized);
    }
  } catch (error) {
    throw new AuthorityOperationJournalError(
      "STORAGE_UNAVAILABLE",
      "The pending-operation recovery store could not be updated. No new shared request was sent.",
      { cause: error },
    );
  }
  emitChange();
}

export function operationKey(
  operation: Pick<PendingAuthorityOperation, "kind" | "requestId">,
): string {
  return `${operation.kind}:${operation.requestId}`;
}

export function readAuthorityOperations(
  storage?: JournalStorage | null,
): PendingAuthorityOperation[] {
  return readJournal(storage).operations.map((operation) => ({ ...operation }));
}

export function clearAuthorityOperationJournalAfterReadback(
  authoritativeSchemaVersion: number,
  storage?: JournalStorage | null,
): void {
  if (!Number.isSafeInteger(authoritativeSchemaVersion) || authoritativeSchemaVersion < 0) {
    throw new AuthorityOperationJournalError(
      "INVALID_OPERATION",
      "Local recovery data can be cleared only after an authoritative workspace readback.",
    );
  }
  const target = storageOrDefault(storage);
  if (target === null) return;
  try {
    target.removeItem(AUTHORITY_OPERATION_JOURNAL_KEY);
  } catch (error) {
    throw new AuthorityOperationJournalError(
      "STORAGE_UNAVAILABLE",
      "The pending-operation recovery store could not be cleared.",
      { cause: error },
    );
  }
  emitChange();
}

export function prepareAuthorityOperation(
  input: PrepareAuthorityOperationInput,
  storage?: JournalStorage | null,
): PendingAuthorityOperation {
  if (
    !AUTHORITY_OPERATION_KINDS.includes(input.kind) ||
    input.path !== OPERATION_PATHS[input.kind] ||
    typeof input.label !== "string" ||
    input.label.trim().length === 0 ||
    input.label.length > MAX_LABEL_LENGTH ||
    !isRecord(input.body) ||
    typeof input.body.requestId !== "string" ||
    input.body.requestId.length === 0
  ) {
    throw new AuthorityOperationJournalError(
      "INVALID_OPERATION",
      "The shared request could not be prepared for exact recovery.",
    );
  }
  const journal = readJournal(storage);
  const serializedBody = JSON.stringify(input.body);
  const key = `${input.kind}:${input.body.requestId}`;
  const existing = journal.operations.find((operation) => operationKey(operation) === key);
  if (existing) {
    if (existing.path !== input.path || existing.serializedBody !== serializedBody) {
      throw new AuthorityOperationJournalError(
        "REQUEST_ID_REUSE",
        "A pending shared request ID was reused with different content.",
      );
    }
    return { ...existing };
  }
  if (journal.operations.length >= MAX_OPERATIONS) {
    throw new AuthorityOperationJournalError(
      "JOURNAL_CAPACITY",
      "Resolve pending shared changes before starting another change.",
    );
  }
  const operation: PendingAuthorityOperation = {
    schemaVersion: 1,
    kind: input.kind,
    path: input.path,
    requestId: input.body.requestId,
    serializedBody,
    state: "prepared",
    createdAt: input.createdAt ?? Date.now(),
    label: input.label.trim(),
    submittedDraft: input.submittedDraft ?? input.body,
    editableDraft: input.submittedDraft ?? input.body,
    resolution: null,
  };
  writeJournal({ schemaVersion: 1, operations: [...journal.operations, operation] }, storage);
  return { ...operation };
}

function updateOperation(
  key: string,
  update: (operation: PendingAuthorityOperation) => PendingAuthorityOperation | null,
  storage?: JournalStorage | null,
): PendingAuthorityOperation | null {
  const journal = readJournal(storage);
  const index = journal.operations.findIndex((operation) => operationKey(operation) === key);
  if (index === -1) return null;
  const updated = update(journal.operations[index]);
  const operations = updated
    ? [
        ...journal.operations.slice(0, index),
        updated,
        ...journal.operations.slice(index + 1),
      ]
    : [
        ...journal.operations.slice(0, index),
        ...journal.operations.slice(index + 1),
      ];
  writeJournal({ schemaVersion: 1, operations }, storage);
  return updated ? { ...updated } : null;
}

export function markAuthorityOperationAmbiguous(
  operation: Pick<PendingAuthorityOperation, "kind" | "requestId">,
  storage?: JournalStorage | null,
): PendingAuthorityOperation | null {
  return updateOperation(operationKey(operation), (current) => ({
    ...current,
    state: "ambiguous",
    resolution: null,
  }), storage);
}

export function resolveAuthorityOperation(
  operation: Pick<PendingAuthorityOperation, "kind" | "requestId">,
  resolution: AuthorityOperationResolution,
  storage?: JournalStorage | null,
): PendingAuthorityOperation | null {
  if (!isResolution(resolution)) {
    throw new AuthorityOperationJournalError(
      "INVALID_OPERATION",
      "The shared request returned an invalid recovery result.",
    );
  }
  return updateOperation(operationKey(operation), (current) => ({
    ...current,
    state: "resolved_conflict",
    resolution,
  }), storage);
}

export function updateAuthorityOperationDraft(
  operation: Pick<PendingAuthorityOperation, "kind" | "requestId">,
  editableDraft: unknown,
  storage?: JournalStorage | null,
): PendingAuthorityOperation | null {
  return updateOperation(operationKey(operation), (current) => ({
    ...current,
    editableDraft,
  }), storage);
}

export function replaceResolvedAuthorityOperation(
  current: Pick<PendingAuthorityOperation, "kind" | "requestId">,
  input: PrepareAuthorityOperationInput,
  storage?: JournalStorage | null,
): PendingAuthorityOperation {
  if (
    !AUTHORITY_OPERATION_KINDS.includes(input.kind) ||
    input.path !== OPERATION_PATHS[input.kind] ||
    !isRecord(input.body) ||
    typeof input.body.requestId !== "string" ||
    input.body.requestId.length === 0 ||
    input.body.requestId === current.requestId ||
    typeof input.label !== "string" ||
    input.label.trim().length === 0 ||
    input.label.length > MAX_LABEL_LENGTH
  ) {
    throw new AuthorityOperationJournalError(
      "INVALID_OPERATION",
      "The resolved shared request could not be replaced safely.",
    );
  }
  const replacementRequestId = input.body.requestId;
  const journal = readJournal(storage);
  const index = journal.operations.findIndex(
    (operation) => operationKey(operation) === operationKey(current),
  );
  const existing = index === -1 ? undefined : journal.operations[index];
  if (!existing || existing.state !== "resolved_conflict") {
    throw new AuthorityOperationJournalError(
      "INVALID_OPERATION",
      "Only a definitively resolved shared request can be retried with a new request ID.",
    );
  }
  const duplicate = journal.operations.find(
    (operation, operationIndex) =>
      operationIndex !== index &&
      operation.kind === input.kind &&
      operation.requestId === replacementRequestId,
  );
  if (duplicate) {
    throw new AuthorityOperationJournalError(
      "REQUEST_ID_REUSE",
      "The replacement shared request ID is already pending.",
    );
  }
  const replacement: PendingAuthorityOperation = {
    schemaVersion: 1,
    kind: input.kind,
    path: input.path,
    requestId: replacementRequestId,
    serializedBody: JSON.stringify(input.body),
    state: "prepared",
    createdAt: input.createdAt ?? Date.now(),
    label: input.label.trim(),
    submittedDraft: input.submittedDraft ?? existing.editableDraft,
    editableDraft: input.submittedDraft ?? existing.editableDraft,
    resolution: null,
  };
  const operations = [...journal.operations];
  operations[index] = replacement;
  writeJournal({ schemaVersion: 1, operations }, storage);
  return { ...replacement };
}

export function settleAuthorityOperation(
  operation: Pick<PendingAuthorityOperation, "kind" | "requestId">,
  storage?: JournalStorage | null,
): void {
  updateOperation(operationKey(operation), () => null, storage);
}

export function discardAuthorityOperation(
  operation: Pick<PendingAuthorityOperation, "kind" | "requestId">,
  storage?: JournalStorage | null,
): void {
  const current = readJournal(storage).operations.find(
    (candidate) => operationKey(candidate) === operationKey(operation),
  );
  if (!current || current.state !== "resolved_conflict") {
    throw new AuthorityOperationJournalError(
      "INVALID_OPERATION",
      "An ambiguous shared request cannot be discarded before exact replay resolves it.",
    );
  }
  settleAuthorityOperation(current, storage);
}
