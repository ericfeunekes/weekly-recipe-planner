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

function isIdentifier(value: unknown): value is string {
  return isBoundedString(value, CODEX_THREAD_ID_MAX_LENGTH);
}

function isRequestId(value: unknown): value is string {
  return isBoundedString(value, CODEX_REQUEST_ID_MAX_LENGTH);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
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
