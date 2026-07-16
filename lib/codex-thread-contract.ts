/**
 * Public HTTP contract for the planner's thin Codex thread wrapper.
 *
 * The contract deliberately contains only display-safe projections. Native
 * app-server frames, tool arguments/results, filesystem paths, and raw
 * reasoning content are not part of this boundary. Mutation `requestId`
 * values are host HTTP admission/replay identifiers only; the backend must
 * never forward them as app-server thread, turn, item, or request identity.
 */

export const CODEX_THREAD_ID_MAX_LENGTH = 200;
export const CODEX_REQUEST_ID_MAX_LENGTH = 200;
export const CODEX_CLIENT_MESSAGE_ID_MAX_LENGTH = 200;
export const CODEX_MESSAGE_MAX_LENGTH = 4_000;
export const CODEX_SEARCH_TERM_MAX_LENGTH = 200;
export const CODEX_CURSOR_MAX_LENGTH = 2_048;
export const CODEX_THREAD_LIST_LIMIT_DEFAULT = 50;
export const CODEX_THREAD_LIST_LIMIT_MAX = 100;
export const CODEX_EVENT_WAIT_MS_DEFAULT = 25_000;
export const CODEX_EVENT_WAIT_MS_MAX = 30_000;
export const CODEX_INTERACTION_ANSWER_MAX_LENGTH = 2_000;
export const CODEX_TITLE_MAX_LENGTH = 200;
export const CODEX_PREVIEW_MAX_LENGTH = 500;
export const CODEX_DISPLAY_TEXT_MAX_LENGTH = 32_000;
export const CODEX_ACTIVITY_DETAIL_MAX_LENGTH = 1_000;
export const CODEX_API_ERROR_MESSAGE_MAX_LENGTH = 4_000;
export const CODEX_REASONING_SUMMARIES_MAX = 20;
export const CODEX_MESSAGE_ATTACHMENTS_MAX = 20;
export const CODEX_WORKERS_PER_ITEM_MAX = 20;
export const CODEX_THREAD_TURNS_MAX = 200;
export const CODEX_TURN_ITEMS_MAX = 1_000;
export const CODEX_THREAD_WORKER_SUMMARIES_MAX =
  CODEX_THREAD_TURNS_MAX * CODEX_TURN_ITEMS_MAX * CODEX_WORKERS_PER_ITEM_MAX;
export const CODEX_INTERACTIONS_MAX = 128;
export const CODEX_INTERACTION_QUESTIONS_MAX = 3;
export const CODEX_INTERACTION_OPTIONS_MIN = 2;
export const CODEX_INTERACTION_OPTIONS_MAX = 3;
export const CODEX_INTERACTION_HEADER_MAX_BYTES = 128;
export const CODEX_INTERACTION_QUESTION_MAX_BYTES = 4_096;
export const CODEX_INTERACTION_OPTION_LABEL_MAX_BYTES = 256;
export const CODEX_INTERACTION_OPTION_DESCRIPTION_MAX_BYTES = 1_024;

export const CODEX_THREAD_API_ROUTES = {
  threadsList: { method: "GET", path: "/api/codex/threads" },
  threadRead: { method: "GET", path: "/api/codex/thread" },
  threadNew: { method: "POST", path: "/api/codex/threads/new" },
  threadSelect: { method: "POST", path: "/api/codex/threads/select" },
  threadArchive: { method: "POST", path: "/api/codex/threads/archive" },
  turnSend: { method: "POST", path: "/api/codex/turns/send" },
  turnInterrupt: { method: "POST", path: "/api/codex/turns/interrupt" },
  interactionsList: { method: "GET", path: "/api/codex/interactions" },
  interactionRespond: { method: "POST", path: "/api/codex/interactions/respond" },
  events: { method: "GET", path: "/api/codex/events" },
} as const;

export type CodexThreadListRequest = {
  archived?: boolean;
  cursor?: string;
  limit?: number;
  search?: string;
};

export type CodexThreadReadRequest = {
  threadId: string;
};

export type CodexNewThreadRequest = {
  requestId: string;
  expectedSelectionRevision: number;
};

export type CodexSelectThreadRequest = {
  requestId: string;
  threadId: string | null;
  expectedSelectionRevision: number;
};

export type CodexArchiveThreadRequest = {
  requestId: string;
  threadId: string;
  expectedSelectionRevision: number;
};

export type CodexSendTurnRequest = {
  /** HTTP admission/replay identity only; never forwarded as app-server identity. */
  requestId: string;
  threadId: string;
  expectedSelectionRevision: number;
  clientUserMessageId: string;
  message: string;
};

export type CodexInterruptTurnRequest = {
  requestId: string;
  threadId: string;
  expectedSelectionRevision: number;
  turnId: string;
};

export type CodexInteractionListRequest = {
  threadId?: string;
};

export type CodexQuestionAnswer = {
  questionId: string;
  answers: string[];
};

export type CodexInteractionResponse = {
  kind: "answers";
  answers: CodexQuestionAnswer[];
};

export type CodexRespondInteractionRequest = {
  requestId: string;
  threadId: string;
  expectedSelectionRevision: number;
  interactionId: string;
  response: CodexInteractionResponse;
};

export type CodexEventsRequest = {
  /** Null only for the first poll; a mismatch forces a full snapshot resync. */
  connectionEpoch: string | null;
  afterRevision: number;
  waitMs?: number;
  threadId?: string;
};

export type CodexThreadStatus = {
  state: "not_loaded" | "idle" | "active" | "error" | "unknown";
  waitingFor: "approval" | "user_input" | null;
};

export type CodexThreadSelection = {
  threadId: string | null;
  revision: number;
};

export type CodexThreadSummary = {
  id: string;
  title: string;
  preview: string;
  status: CodexThreadStatus;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  recencyAtMs: number | null;
};

export type CodexMessageAttachment = {
  kind: "image" | "skill" | "mention";
  label: string;
};

export type CodexMessageItem = {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  phase: "commentary" | "final" | null;
  text: string;
  clientUserMessageId: string | null;
  attachments: CodexMessageAttachment[];
};

/** Completed reasoning summaries only; raw reasoning content is never exposed. */
export type CodexReasoningItem = {
  kind: "reasoning";
  id: string;
  label: "Thinking";
  summaries: string[];
};

export type CodexActivityStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export type CodexActivityItem = {
  kind: "activity";
  id: string;
  category: "plan" | "tool" | "web" | "system" | "restricted" | "other";
  label: string;
  detail: string | null;
  status: CodexActivityStatus;
};

export type CodexWorkerOperation = "start" | "message" | "resume" | "wait" | "close" | "activity";

export type CodexWorkerState = {
  threadId: string;
  status: CodexActivityStatus;
};

export type CodexWorkerActivityItem = {
  kind: "worker";
  id: string;
  label: string;
  operation: CodexWorkerOperation;
  workerThreadIds: string[];
  workerStates: CodexWorkerState[];
  status: CodexActivityStatus;
};

export type CodexThreadItemView =
  | CodexMessageItem
  | CodexReasoningItem
  | CodexActivityItem
  | CodexWorkerActivityItem;

export type CodexTurnView = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "in_progress" | "unknown";
  itemsView: "full" | "summary" | "not_loaded" | "unknown";
  startedAtMs: number | null;
  completedAtMs: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  items: CodexThreadItemView[];
};

export type CodexWorkerSummary = {
  threadId: string;
  label: string;
  status: CodexActivityStatus;
};

export type CodexThreadView = CodexThreadSummary & {
  threadKind: "conversation" | "worker";
  parentThreadId: string | null;
  turns: CodexTurnView[];
  workers: CodexWorkerSummary[];
  historyTruncated: boolean;
};

export type CodexInteractionOption = {
  label: string;
  description: string;
};

export type CodexInteractionQuestion = {
  id: string;
  header: string;
  question: string;
  options: CodexInteractionOption[];
  /** The planner never exposes Codex's free-form Other response channel. */
  allowOther: false;
  /** A response must select exactly one label already present in options. */
  responseMode: "listed_option";
};

type CodexPendingInteractionBase = {
  id: string;
  threadId: string;
  title: string;
  createdAtMs: number;
};

export type CodexPendingUserInputInteraction = CodexPendingInteractionBase & {
  kind: "user_input";
  turnId: string;
  itemId: string;
  questions: CodexInteractionQuestion[];
  autoResolveAtMs: number | null;
};

/**
 * Read-only evidence that app-server requested a forbidden capability and the
 * host rejected it. This type deliberately has no response/decision surface.
 */
export type CodexRejectedApprovalInteraction = CodexPendingInteractionBase & {
  kind: "approval";
  /** MCP elicitations can be correlated to a thread without an active turn. */
  turnId: string | null;
  /** MCP elicitations have their own request id and no native item identity. */
  itemId: string | null;
  category: "command" | "file_change" | "permission" | "mcp" | "other";
  summary: string;
  resolution: "rejected_by_policy";
};

export type CodexInteraction =
  | CodexPendingUserInputInteraction
  | CodexRejectedApprovalInteraction;

export type CodexThreadListResponse = {
  threads: CodexThreadSummary[];
  nextCursor: string | null;
  selection: CodexThreadSelection;
  connectionEpoch: string;
  activityRevision: number;
};

export type CodexThreadReadResponse = {
  thread: CodexThreadView;
  selection: CodexThreadSelection;
  interactions: CodexInteraction[];
  connectionEpoch: string;
  activityRevision: number;
};

export type CodexInteractionListResponse = {
  interactions: CodexInteraction[];
  connectionEpoch: string;
  activityRevision: number;
};

export type CodexThreadMutationResponse = {
  thread: CodexThreadSummary | null;
  selection: CodexThreadSelection;
  connectionEpoch: string;
  activityRevision: number;
};

export type CodexTurnMutationResponse = {
  threadId: string;
  turnId: string;
  connectionEpoch: string;
  activityRevision: number;
};

export type CodexInteractionMutationResponse = {
  interactionId: string;
  status: "resolved" | "already_resolved";
  connectionEpoch: string;
  activityRevision: number;
};

export type CodexEventReason = "thread" | "selection" | "interaction" | "runtime";

/** A change signal only. Consumers fetch authoritative thread state separately. */
export type CodexEventsResponse = {
  changed: boolean;
  connectionEpoch: string;
  revision: number;
  resyncRequired: boolean;
  reasons: CodexEventReason[];
};

export const CODEX_API_ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_FOUND",
  "REQUEST_ID_REUSE",
  "SELECTION_CONFLICT",
  "TURN_CONFLICT",
  "INTERACTION_STALE",
  "CODEX_UNAVAILABLE",
  "CODEX_INCOMPATIBLE",
  "INTERNAL_ERROR",
] as const;

export type CodexApiErrorCode = (typeof CODEX_API_ERROR_CODES)[number];

export type CodexApiFailure = {
  error: {
    code: CodexApiErrorCode;
    message: string;
  };
};

const UTF8_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" &&
    value.length <= maxLength &&
    !value.includes("\0") &&
    (allowEmpty || value.trim().length > 0);
}

function isBoundedUtf8String(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return isBoundedString(value, maxBytes, allowEmpty) &&
    UTF8_ENCODER.encode(value).byteLength <= maxBytes;
}

function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, CODEX_THREAD_ID_MAX_LENGTH);
}

function isRequestId(value: unknown): value is string {
  return isBoundedString(value, CODEX_REQUEST_ID_MAX_LENGTH);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableNonnegativeInteger(value: unknown): value is number | null {
  return value === null || isRevision(value);
}

function isBoundedArray<T>(
  value: unknown,
  minimum: number,
  maximum: number,
  validator: (entry: unknown) => entry is T,
): value is T[] {
  return Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every(validator);
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hasValidThreadSummaryFields(value: Record<string, unknown>): boolean {
  return isIdentifier(value.id) &&
    isBoundedString(value.title, CODEX_TITLE_MAX_LENGTH) &&
    isBoundedString(value.preview, CODEX_PREVIEW_MAX_LENGTH, true) &&
    isCodexThreadStatus(value.status) &&
    isNullableNonnegativeInteger(value.createdAtMs) &&
    isNullableNonnegativeInteger(value.updatedAtMs) &&
    isNullableNonnegativeInteger(value.recencyAtMs);
}

export function isCodexThreadStatus(value: unknown): value is CodexThreadStatus {
  return isRecord(value) &&
    hasExactKeys(value, ["state", "waitingFor"]) &&
    (value.state === "not_loaded" ||
      value.state === "idle" ||
      value.state === "active" ||
      value.state === "error" ||
      value.state === "unknown") &&
    (value.waitingFor === null ||
      value.waitingFor === "approval" ||
      value.waitingFor === "user_input");
}

export function isCodexThreadSelection(value: unknown): value is CodexThreadSelection {
  return isRecord(value) &&
    hasExactKeys(value, ["threadId", "revision"]) &&
    (value.threadId === null || isIdentifier(value.threadId)) &&
    isRevision(value.revision);
}

export function isCodexThreadSummary(value: unknown): value is CodexThreadSummary {
  return isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "title",
      "preview",
      "status",
      "createdAtMs",
      "updatedAtMs",
      "recencyAtMs",
    ]) &&
    hasValidThreadSummaryFields(value);
}

export function isCodexMessageAttachment(value: unknown): value is CodexMessageAttachment {
  return isRecord(value) &&
    hasExactKeys(value, ["kind", "label"]) &&
    (value.kind === "image" || value.kind === "skill" || value.kind === "mention") &&
    isBoundedString(value.label, CODEX_TITLE_MAX_LENGTH);
}

export function isCodexMessageItem(value: unknown): value is CodexMessageItem {
  return isRecord(value) &&
    hasExactKeys(value, [
      "kind",
      "id",
      "role",
      "phase",
      "text",
      "clientUserMessageId",
      "attachments",
    ]) &&
    value.kind === "message" &&
    isIdentifier(value.id) &&
    (value.role === "user" || value.role === "assistant") &&
    (value.phase === null || value.phase === "commentary" || value.phase === "final") &&
    isBoundedString(value.text, CODEX_DISPLAY_TEXT_MAX_LENGTH, true) &&
    (value.clientUserMessageId === null || isIdentifier(value.clientUserMessageId)) &&
    isBoundedArray(
      value.attachments,
      0,
      CODEX_MESSAGE_ATTACHMENTS_MAX,
      isCodexMessageAttachment,
    );
}

export function isCodexReasoningItem(value: unknown): value is CodexReasoningItem {
  return isRecord(value) &&
    hasExactKeys(value, ["kind", "id", "label", "summaries"]) &&
    value.kind === "reasoning" &&
    isIdentifier(value.id) &&
    value.label === "Thinking" &&
    isBoundedArray(
      value.summaries,
      0,
      CODEX_REASONING_SUMMARIES_MAX,
      (summary): summary is string =>
        isBoundedString(summary, CODEX_ACTIVITY_DETAIL_MAX_LENGTH),
    );
}

export function isCodexActivityStatus(value: unknown): value is CodexActivityStatus {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "unknown";
}

export function isCodexActivityItem(value: unknown): value is CodexActivityItem {
  return isRecord(value) &&
    hasExactKeys(value, ["kind", "id", "category", "label", "detail", "status"]) &&
    value.kind === "activity" &&
    isIdentifier(value.id) &&
    (value.category === "plan" ||
      value.category === "tool" ||
      value.category === "web" ||
      value.category === "system" ||
      value.category === "restricted" ||
      value.category === "other") &&
    isBoundedString(value.label, CODEX_TITLE_MAX_LENGTH) &&
    (value.detail === null || isBoundedString(value.detail, CODEX_DISPLAY_TEXT_MAX_LENGTH)) &&
    isCodexActivityStatus(value.status);
}

export function isCodexWorkerOperation(value: unknown): value is CodexWorkerOperation {
  return value === "start" ||
    value === "message" ||
    value === "resume" ||
    value === "wait" ||
    value === "close" ||
    value === "activity";
}

export function isCodexWorkerState(value: unknown): value is CodexWorkerState {
  return isRecord(value) &&
    hasExactKeys(value, ["threadId", "status"]) &&
    isIdentifier(value.threadId) &&
    isCodexActivityStatus(value.status);
}

export function isCodexWorkerActivityItem(value: unknown): value is CodexWorkerActivityItem {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind",
    "id",
    "label",
    "operation",
    "workerThreadIds",
    "workerStates",
    "status",
  ])) {
    return false;
  }
  const workerThreadIds = value.workerThreadIds;
  const workerStates = value.workerStates;
  if (value.kind !== "worker" ||
      !isIdentifier(value.id) ||
      !isBoundedString(value.label, CODEX_TITLE_MAX_LENGTH) ||
      !isCodexWorkerOperation(value.operation) ||
      !isBoundedArray(
        workerThreadIds,
        0,
        CODEX_WORKERS_PER_ITEM_MAX,
        isIdentifier,
      ) ||
      !hasUniqueStrings(workerThreadIds) ||
      !isBoundedArray(
        workerStates,
        0,
        CODEX_WORKERS_PER_ITEM_MAX,
        isCodexWorkerState,
      ) ||
      !isCodexActivityStatus(value.status)) {
    return false;
  }
  return workerStates.length === workerThreadIds.length &&
    workerStates.every((state, index) => state.threadId === workerThreadIds[index]);
}

export function isCodexThreadItemView(value: unknown): value is CodexThreadItemView {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "message":
      return isCodexMessageItem(value);
    case "reasoning":
      return isCodexReasoningItem(value);
    case "activity":
      return isCodexActivityItem(value);
    case "worker":
      return isCodexWorkerActivityItem(value);
    default:
      return false;
  }
}

export function isCodexTurnView(value: unknown): value is CodexTurnView {
  return isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "status",
      "itemsView",
      "startedAtMs",
      "completedAtMs",
      "durationMs",
      "errorMessage",
      "items",
    ]) &&
    isIdentifier(value.id) &&
    (value.status === "completed" ||
      value.status === "interrupted" ||
      value.status === "failed" ||
      value.status === "in_progress" ||
      value.status === "unknown") &&
    (value.itemsView === "full" ||
      value.itemsView === "summary" ||
      value.itemsView === "not_loaded" ||
      value.itemsView === "unknown") &&
    isNullableNonnegativeInteger(value.startedAtMs) &&
    isNullableNonnegativeInteger(value.completedAtMs) &&
    isNullableNonnegativeInteger(value.durationMs) &&
    (value.errorMessage === null ||
      isBoundedString(value.errorMessage, CODEX_ACTIVITY_DETAIL_MAX_LENGTH)) &&
    isBoundedArray(value.items, 0, CODEX_TURN_ITEMS_MAX, isCodexThreadItemView);
}

export function isCodexWorkerSummary(value: unknown): value is CodexWorkerSummary {
  return isRecord(value) &&
    hasExactKeys(value, ["threadId", "label", "status"]) &&
    isIdentifier(value.threadId) &&
    isBoundedString(value.label, CODEX_TITLE_MAX_LENGTH) &&
    isCodexActivityStatus(value.status);
}

export function isCodexThreadView(value: unknown): value is CodexThreadView {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "title",
    "preview",
    "status",
    "createdAtMs",
    "updatedAtMs",
    "recencyAtMs",
    "threadKind",
    "parentThreadId",
    "turns",
    "workers",
    "historyTruncated",
  ])) {
    return false;
  }
  if (!hasValidThreadSummaryFields(value) ||
      (value.threadKind !== "conversation" && value.threadKind !== "worker") ||
      (value.parentThreadId !== null && !isIdentifier(value.parentThreadId)) ||
      !isBoundedArray(value.turns, 0, CODEX_THREAD_TURNS_MAX, isCodexTurnView) ||
      !isBoundedArray(
        value.workers,
        0,
        CODEX_THREAD_WORKER_SUMMARIES_MAX,
        isCodexWorkerSummary,
      ) ||
      typeof value.historyTruncated !== "boolean") {
    return false;
  }
  const workerIds = value.workers.map((worker) => worker.threadId);
  return hasUniqueStrings(workerIds) &&
    (value.threadKind === "worker" ? value.parentThreadId !== null : value.parentThreadId === null);
}

export function isCodexInteractionOption(value: unknown): value is CodexInteractionOption {
  return isRecord(value) &&
    hasExactKeys(value, ["label", "description"]) &&
    isBoundedUtf8String(value.label, CODEX_INTERACTION_OPTION_LABEL_MAX_BYTES) &&
    isBoundedUtf8String(
      value.description,
      CODEX_INTERACTION_OPTION_DESCRIPTION_MAX_BYTES,
    );
}

export function isCodexInteractionQuestion(value: unknown): value is CodexInteractionQuestion {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "header",
    "question",
    "options",
    "allowOther",
    "responseMode",
  ])) {
    return false;
  }
  if (!isIdentifier(value.id) ||
      !isBoundedUtf8String(value.header, CODEX_INTERACTION_HEADER_MAX_BYTES) ||
      !isBoundedUtf8String(value.question, CODEX_INTERACTION_QUESTION_MAX_BYTES) ||
      !isBoundedArray(
        value.options,
        CODEX_INTERACTION_OPTIONS_MIN,
        CODEX_INTERACTION_OPTIONS_MAX,
        isCodexInteractionOption,
      ) ||
      value.allowOther !== false ||
      value.responseMode !== "listed_option") {
    return false;
  }
  return hasUniqueStrings(value.options.map((option) => option.label));
}

function hasValidInteractionBaseFields(value: Record<string, unknown>): boolean {
  return isIdentifier(value.id) &&
    isIdentifier(value.threadId) &&
    isBoundedString(value.title, CODEX_TITLE_MAX_LENGTH) &&
    isRevision(value.createdAtMs);
}

export function isCodexPendingUserInputInteraction(
  value: unknown,
): value is CodexPendingUserInputInteraction {
  if (!isRecord(value) || !hasExactKeys(value, [
    "id",
    "kind",
    "threadId",
    "title",
    "createdAtMs",
    "turnId",
    "itemId",
    "questions",
    "autoResolveAtMs",
  ])) {
    return false;
  }
  if (value.kind !== "user_input" ||
      !hasValidInteractionBaseFields(value) ||
      !isIdentifier(value.turnId) ||
      !isIdentifier(value.itemId) ||
      !isBoundedArray(
        value.questions,
        1,
        CODEX_INTERACTION_QUESTIONS_MAX,
        isCodexInteractionQuestion,
      ) ||
      !isNullableNonnegativeInteger(value.autoResolveAtMs)) {
    return false;
  }
  return hasUniqueStrings(value.questions.map((question) => question.id));
}

export function isCodexRejectedApprovalInteraction(
  value: unknown,
): value is CodexRejectedApprovalInteraction {
  return isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "kind",
      "threadId",
      "title",
      "createdAtMs",
      "turnId",
      "itemId",
      "category",
      "summary",
      "resolution",
    ]) &&
    value.kind === "approval" &&
    hasValidInteractionBaseFields(value) &&
    (value.turnId === null || isIdentifier(value.turnId)) &&
    (value.itemId === null || isIdentifier(value.itemId)) &&
    (value.category === "command" ||
      value.category === "file_change" ||
      value.category === "permission" ||
      value.category === "mcp" ||
      value.category === "other") &&
    isBoundedString(value.summary, CODEX_ACTIVITY_DETAIL_MAX_LENGTH) &&
    value.resolution === "rejected_by_policy";
}

export function isCodexInteraction(value: unknown): value is CodexInteraction {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "user_input":
      return isCodexPendingUserInputInteraction(value);
    case "approval":
      return isCodexRejectedApprovalInteraction(value);
    default:
      return false;
  }
}

function isInteractionArray(value: unknown): value is CodexInteraction[] {
  return isBoundedArray(value, 0, CODEX_INTERACTIONS_MAX, isCodexInteraction);
}

function hasValidRuntimeCursorFields(value: Record<string, unknown>): boolean {
  return isIdentifier(value.connectionEpoch) && isRevision(value.activityRevision);
}

export function isCodexThreadListResponse(value: unknown): value is CodexThreadListResponse {
  return isRecord(value) &&
    hasExactKeys(value, [
      "threads",
      "nextCursor",
      "selection",
      "connectionEpoch",
      "activityRevision",
    ]) &&
    isBoundedArray(value.threads, 0, CODEX_THREAD_LIST_LIMIT_MAX, isCodexThreadSummary) &&
    (value.nextCursor === null || isBoundedString(value.nextCursor, CODEX_CURSOR_MAX_LENGTH)) &&
    isCodexThreadSelection(value.selection) &&
    hasValidRuntimeCursorFields(value);
}

export function isCodexThreadReadResponse(value: unknown): value is CodexThreadReadResponse {
  return isRecord(value) &&
    hasExactKeys(value, [
      "thread",
      "selection",
      "interactions",
      "connectionEpoch",
      "activityRevision",
    ]) &&
    isCodexThreadView(value.thread) &&
    isCodexThreadSelection(value.selection) &&
    isInteractionArray(value.interactions) &&
    hasValidRuntimeCursorFields(value);
}

export function isCodexInteractionListResponse(
  value: unknown,
): value is CodexInteractionListResponse {
  return isRecord(value) &&
    hasExactKeys(value, ["interactions", "connectionEpoch", "activityRevision"]) &&
    isInteractionArray(value.interactions) &&
    hasValidRuntimeCursorFields(value);
}

export function isCodexThreadMutationResponse(
  value: unknown,
): value is CodexThreadMutationResponse {
  return isRecord(value) &&
    hasExactKeys(value, ["thread", "selection", "connectionEpoch", "activityRevision"]) &&
    (value.thread === null || isCodexThreadSummary(value.thread)) &&
    isCodexThreadSelection(value.selection) &&
    hasValidRuntimeCursorFields(value);
}

export function isCodexTurnMutationResponse(value: unknown): value is CodexTurnMutationResponse {
  return isRecord(value) &&
    hasExactKeys(value, ["threadId", "turnId", "connectionEpoch", "activityRevision"]) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.turnId) &&
    hasValidRuntimeCursorFields(value);
}

export function isCodexInteractionMutationResponse(
  value: unknown,
): value is CodexInteractionMutationResponse {
  return isRecord(value) &&
    hasExactKeys(value, ["interactionId", "status", "connectionEpoch", "activityRevision"]) &&
    isIdentifier(value.interactionId) &&
    (value.status === "resolved" || value.status === "already_resolved") &&
    hasValidRuntimeCursorFields(value);
}

export function isCodexEventReason(value: unknown): value is CodexEventReason {
  return value === "thread" ||
    value === "selection" ||
    value === "interaction" ||
    value === "runtime";
}

export function isCodexEventsResponse(value: unknown): value is CodexEventsResponse {
  return isRecord(value) &&
    hasExactKeys(value, [
      "changed",
      "connectionEpoch",
      "revision",
      "resyncRequired",
      "reasons",
    ]) &&
    typeof value.changed === "boolean" &&
    isIdentifier(value.connectionEpoch) &&
    isRevision(value.revision) &&
    typeof value.resyncRequired === "boolean" &&
    isBoundedArray(value.reasons, 0, 4, isCodexEventReason) &&
    hasUniqueStrings(value.reasons);
}

export function isCodexApiErrorCode(value: unknown): value is CodexApiErrorCode {
  return typeof value === "string" &&
    CODEX_API_ERROR_CODES.some((code) => code === value);
}

export function isCodexApiFailure(value: unknown): value is CodexApiFailure {
  return isRecord(value) &&
    hasExactKeys(value, ["error"]) &&
    isRecord(value.error) &&
    hasExactKeys(value.error, ["code", "message"]) &&
    isCodexApiErrorCode(value.error.code) &&
    isBoundedString(value.error.message, CODEX_API_ERROR_MESSAGE_MAX_LENGTH);
}

export function isCodexThreadListRequest(value: unknown): value is CodexThreadListRequest {
  if (!isRecord(value) || !hasExactKeys(value, [], ["archived", "cursor", "limit", "search"])) {
    return false;
  }
  return (value.archived === undefined || typeof value.archived === "boolean") &&
    (value.cursor === undefined || isBoundedString(value.cursor, CODEX_CURSOR_MAX_LENGTH)) &&
    (value.limit === undefined || (
      Number.isSafeInteger(value.limit) &&
      Number(value.limit) >= 1 &&
      Number(value.limit) <= CODEX_THREAD_LIST_LIMIT_MAX
    )) &&
    (value.search === undefined || isBoundedString(value.search, CODEX_SEARCH_TERM_MAX_LENGTH));
}

export function isCodexThreadReadRequest(value: unknown): value is CodexThreadReadRequest {
  return isRecord(value) && hasExactKeys(value, ["threadId"]) && isIdentifier(value.threadId);
}

export function isCodexNewThreadRequest(value: unknown): value is CodexNewThreadRequest {
  return isRecord(value) &&
    hasExactKeys(value, ["requestId", "expectedSelectionRevision"]) &&
    isRequestId(value.requestId) &&
    isRevision(value.expectedSelectionRevision);
}

export function isCodexSelectThreadRequest(value: unknown): value is CodexSelectThreadRequest {
  return isRecord(value) &&
    hasExactKeys(value, ["requestId", "threadId", "expectedSelectionRevision"]) &&
    isRequestId(value.requestId) &&
    (value.threadId === null || isIdentifier(value.threadId)) &&
    isRevision(value.expectedSelectionRevision);
}

export function isCodexArchiveThreadRequest(value: unknown): value is CodexArchiveThreadRequest {
  return isRecord(value) &&
    hasExactKeys(value, ["requestId", "threadId", "expectedSelectionRevision"]) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.threadId) &&
    isRevision(value.expectedSelectionRevision);
}

export function isCodexSendTurnRequest(value: unknown): value is CodexSendTurnRequest {
  return isRecord(value) &&
    hasExactKeys(value, [
      "requestId",
      "threadId",
      "expectedSelectionRevision",
      "clientUserMessageId",
      "message",
    ]) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.threadId) &&
    isRevision(value.expectedSelectionRevision) &&
    isBoundedString(value.clientUserMessageId, CODEX_CLIENT_MESSAGE_ID_MAX_LENGTH) &&
    isBoundedString(value.message, CODEX_MESSAGE_MAX_LENGTH);
}

export function isCodexInterruptTurnRequest(value: unknown): value is CodexInterruptTurnRequest {
  return isRecord(value) &&
    hasExactKeys(value, ["requestId", "threadId", "expectedSelectionRevision", "turnId"]) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.threadId) &&
    isRevision(value.expectedSelectionRevision) &&
    isIdentifier(value.turnId);
}

export function isCodexInteractionListRequest(value: unknown): value is CodexInteractionListRequest {
  return isRecord(value) &&
    hasExactKeys(value, [], ["threadId"]) &&
    (value.threadId === undefined || isIdentifier(value.threadId));
}

function isCodexQuestionAnswer(value: unknown): value is CodexQuestionAnswer {
  return isRecord(value) &&
    hasExactKeys(value, ["questionId", "answers"]) &&
    isIdentifier(value.questionId) &&
    Array.isArray(value.answers) &&
    value.answers.length === 1 &&
    value.answers.every((answer) =>
      isBoundedString(answer, CODEX_INTERACTION_ANSWER_MAX_LENGTH),
    );
}

function isCodexInteractionResponse(value: unknown): value is CodexInteractionResponse {
  if (!isRecord(value) || value.kind !== "answers" || !hasExactKeys(value, ["kind", "answers"])) {
    return false;
  }
  if (!Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > 3) {
    return false;
  }
  const questionIds = new Set<string>();
  for (const answer of value.answers) {
    if (!isCodexQuestionAnswer(answer) || questionIds.has(answer.questionId)) return false;
    questionIds.add(answer.questionId);
  }
  return true;
}

export function isCodexRespondInteractionRequest(
  value: unknown,
): value is CodexRespondInteractionRequest {
  return isRecord(value) &&
    hasExactKeys(value, [
      "requestId",
      "threadId",
      "expectedSelectionRevision",
      "interactionId",
      "response",
    ]) &&
    isRequestId(value.requestId) &&
    isIdentifier(value.threadId) &&
    isRevision(value.expectedSelectionRevision) &&
    isIdentifier(value.interactionId) &&
    isCodexInteractionResponse(value.response);
}

export function isCodexEventsRequest(value: unknown): value is CodexEventsRequest {
  return isRecord(value) &&
    hasExactKeys(value, ["connectionEpoch", "afterRevision"], ["waitMs", "threadId"]) &&
    (value.connectionEpoch === null || isIdentifier(value.connectionEpoch)) &&
    isRevision(value.afterRevision) &&
    (value.waitMs === undefined || (
      Number.isSafeInteger(value.waitMs) &&
      Number(value.waitMs) >= 0 &&
      Number(value.waitMs) <= CODEX_EVENT_WAIT_MS_MAX
    )) &&
    (value.threadId === undefined || isIdentifier(value.threadId));
}
