import type { HouseholdCommand } from "./household-command-contract";
import type { HouseholdPlannerState } from "./household-contract";
import type {
  ChatTurn,
  PlannerChatContext,
  RetryChatTurnRequest,
  SubmitChatTurnRequest,
  TranscriptEntry,
} from "./planner-chat-contract";

export const API_ERROR_CODES = [
  "INVALID_REQUEST",
  "NOT_INITIALIZED",
  "ALREADY_INITIALIZED",
  "VERSION_CONFLICT",
  "DOMAIN_REJECTED",
  "REQUEST_ID_REUSE",
  "TURN_BUSY",
  "CONTEXT_STALE",
  "NOT_FOUND",
  "UNAVAILABLE",
  "CODEX_UNAVAILABLE",
  "STORE_CORRUPT",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export type PlannerActor = "Household" | "Codex";

export const OPERATION_KINDS = [
  "planner_command",
  "planner_chat_command",
  "planner_undo",
  "workspace_bootstrap",
  "chat_submit",
  "chat_retry",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

export type OperationReceipt = {
  operationKind: OperationKind;
  requestId: string;
  payloadHash: string;
  httpStatus: number;
  decision: unknown;
  createdAt: number;
};

export type PlannerEventCommand =
  | HouseholdCommand
  | { type: "undoLatest"; targetEventId: string };

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  fieldErrors?: Record<string, string>;
};

export type PlannerEvent = {
  sequence: number;
  eventId: string;
  requestId: string;
  actor: PlannerActor;
  command: PlannerEventCommand;
  baseVersion: number;
  resultVersion: number;
  summary: string;
  target: string;
  changes: string[];
  revertsEventId: string | null;
  chatTurnId: string | null;
  occurredAt: number;
};

export type UninitializedWorkspace = {
  initialized: false;
  schemaVersion: number;
};

export type InitializedWorkspace = {
  initialized: true;
  schemaVersion: number;
  plannerVersion: number;
  syncRevision: number;
  state: HouseholdPlannerState;
  events: PlannerEvent[];
  transcriptEntries: TranscriptEntry[];
  chatTurns: ChatTurn[];
};

export type WorkspaceResponse = UninitializedWorkspace | InitializedWorkspace;

export type PageRequest = {
  /** Exclusive sequence cursor. Omit to start from the newest row. */
  beforeSequence?: number;
  limit?: number;
};

export type PlannerEventPage = {
  order: "newest_first";
  items: PlannerEvent[];
  /** Smallest returned sequence when more older rows exist; otherwise null. */
  nextBeforeSequence: number | null;
};

export type TranscriptPage = {
  order: "newest_first";
  items: TranscriptEntry[];
  /** Smallest returned sequence when more older rows exist; otherwise null. */
  nextBeforeSequence: number | null;
};

export type ApplyPlannerCommandRequest = {
  requestId: string;
  basePlannerVersion: number;
  command: HouseholdCommand;
};

export type PlannerCommandDecision =
  | { status: "accepted"; eventId: string; plannerVersion: number }
  | {
      status: "version_conflict";
      expectedVersion: number;
      actualVersion: number;
    }
  | { status: "domain_rejected"; message: string };

export type ApplyPlannerCommandResponse = {
  decision: PlannerCommandDecision;
  workspace: InitializedWorkspace;
};

export type UndoLatestRequest = {
  requestId: string;
  basePlannerVersion: number;
  targetEventId: string;
};

export type LegacyV2Payload = {
  data: unknown;
  events: unknown;
  chatMessages: unknown;
};

export const LEGACY_V2_STORAGE_KEY = "weekly-recipe-planner:v2" as const;
export const LEGACY_V2_WEEK_START_DATE = "2026-07-06" as const;

export type LegacyV2TranscriptEntryInput = {
  role: "user" | "assistant";
  text: string;
  context: PlannerChatContext | null;
};

export type LegacyV2TransformResult = {
  state: HouseholdPlannerState;
  transcriptEntries: LegacyV2TranscriptEntryInput[];
  discardedEventCount: number;
};

export type BootstrapWorkspaceRequest =
  | { requestId: string; mode: "seed" }
  | { requestId: string; mode: "import-v2"; payload: LegacyV2Payload };

export type BootstrapWorkspaceResponse = {
  workspace: InitializedWorkspace;
  imported: boolean;
};

export type ChatTurnResponse = {
  turn: ChatTurn;
};

export type ExportEnvelope = {
  schemaVersion: number;
  exportedAt: number;
  plannerVersion: number;
  syncRevision: number;
  state: HouseholdPlannerState;
  events: PlannerEvent[];
  transcriptEntries: TranscriptEntry[];
  chatTurns: ChatTurn[];
};

export type ReadinessStatus = "ready" | "degraded" | "unavailable";

export type HealthResponse = {
  status: ReadinessStatus;
  web: { status: ReadinessStatus };
  application: { status: ReadinessStatus; initialized: boolean };
  store: { status: ReadinessStatus; quickCheck: "ok" | "failed" };
  codex: { status: ReadinessStatus; authenticated: boolean | null };
};

export type ApiFailure = { error: ApiError; workspace?: WorkspaceResponse };

export type { RetryChatTurnRequest, SubmitChatTurnRequest };

export const WORKSPACE_EVENT_TAIL_LIMIT = 50;
export const HISTORY_PAGE_LIMIT_DEFAULT = 50;
export const HISTORY_PAGE_LIMIT_MAX = 100;

export type NormalizedPageRequest = {
  beforeSequence: number | null;
  limit: number;
};

export function normalizePageRequest(value: PageRequest): NormalizedPageRequest | null {
  const beforeSequence = value.beforeSequence ?? null;
  const limit = value.limit ?? HISTORY_PAGE_LIMIT_DEFAULT;
  if (
    (beforeSequence !== null &&
      (!Number.isSafeInteger(beforeSequence) || beforeSequence <= 0)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > HISTORY_PAGE_LIMIT_MAX
  ) {
    return null;
  }
  return { beforeSequence, limit };
}

export const PLANNER_API_ROUTES = {
  health: { method: "GET", path: "/api/health" },
  workspace: { method: "GET", path: "/api/workspace" },
  bootstrap: { method: "POST", path: "/api/bootstrap" },
  commands: { method: "POST", path: "/api/commands" },
  undo: { method: "POST", path: "/api/undo" },
  export: { method: "GET", path: "/api/export" },
  chatSubmit: { method: "POST", path: "/api/chat/submit" },
  chatRetry: { method: "POST", path: "/api/chat/retry" },
  history: { method: "GET", path: "/api/history" },
  transcript: { method: "GET", path: "/api/transcript" },
} as const;
