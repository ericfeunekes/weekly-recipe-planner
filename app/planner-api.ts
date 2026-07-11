import type { HouseholdCommand } from "../lib/household-command-contract.ts";
import type {
  ApiError,
  ApiFailure,
  ApplyPlannerCommandResponse,
  BootstrapWorkspaceRequest,
  BootstrapWorkspaceResponse,
  ExportEnvelope,
  HealthResponse,
  InitializedWorkspace,
  LegacyV2Payload,
  PageRequest,
  PlannerEventPage,
  TranscriptPage,
  UndoLatestRequest,
  WorkspaceResponse,
} from "../lib/planner-api-contract.ts";
import { LEGACY_V2_STORAGE_KEY, PLANNER_API_ROUTES } from "../lib/planner-api-contract.ts";
import type {
  ChatTurnDecision,
  RetryChatTurnRequest,
  SubmitChatTurnRequest,
} from "../lib/planner-chat-contract.ts";

export const LEGACY_V1_STORAGE_KEY = "weekly-recipe-planner:v1";

export type WorkspaceReadResult =
  | { kind: "not_modified"; etag: string | null; serverDate: number | null }
  | {
      kind: "workspace";
      workspace: WorkspaceResponse;
      etag: string | null;
      serverDate: number | null;
    };

export type ChatServiceResponse = {
  decision: ChatTurnDecision;
  workspace: InitializedWorkspace;
};

export type LegacyImportCandidate =
  | { present: false; payload: null; error: null }
  | { present: true; payload: LegacyV2Payload; error: null }
  | { present: true; payload: null; error: string };

export class PlannerApiError extends Error {
  readonly status: number;
  readonly code: ApiError["code"] | "NETWORK_ERROR" | "INVALID_RESPONSE";
  readonly fieldErrors?: Record<string, string>;
  readonly workspace?: WorkspaceResponse;

  constructor(options: {
    status: number;
    code: PlannerApiError["code"];
    message: string;
    fieldErrors?: Record<string, string>;
    workspace?: WorkspaceResponse;
  }) {
    super(options.message);
    this.name = "PlannerApiError";
    this.status = options.status;
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
    this.workspace = options.workspace;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWorkspaceResponse(value: unknown): value is WorkspaceResponse {
  if (!isRecord(value) || typeof value.initialized !== "boolean" || !Number.isSafeInteger(value.schemaVersion)) {
    return false;
  }
  if (!value.initialized) return true;
  return (
    Number.isSafeInteger(value.plannerVersion) &&
    Number.isSafeInteger(value.syncRevision) &&
    isRecord(value.state) &&
    typeof value.state.householdTimeZone === "string" &&
    Array.isArray(value.state.weeks) &&
    Array.isArray(value.events) &&
    Array.isArray(value.transcriptEntries) &&
    Array.isArray(value.chatTurns)
  );
}

function isInitializedWorkspace(value: unknown): value is InitializedWorkspace {
  return isWorkspaceResponse(value) && value.initialized;
}

function isApiFailure(value: unknown): value is ApiFailure {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

function serverDate(response: Response): number | null {
  const raw = response.headers.get("Date");
  if (!raw) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new PlannerApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The planner returned an unreadable response.",
    });
  }
}

function throwFailure(response: Response, value: unknown): never {
  if (isApiFailure(value)) {
    throw new PlannerApiError({
      status: response.status,
      code: value.error.code,
      message: value.error.message,
      fieldErrors: value.error.fieldErrors,
      workspace: value.workspace,
    });
  }
  throw new PlannerApiError({
    status: response.status,
    code: "INVALID_RESPONSE",
    message: "The planner returned an unexpected response.",
  });
}

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new PlannerApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "The planner server is unreachable.",
    });
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
}

async function postJson(path: string, body: unknown): Promise<{ response: Response; value: unknown }> {
  const response = await fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await parseJson(response);
  if (isApiFailure(value)) throwFailure(response, value);
  return { response, value };
}

export function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function readWorkspace(options: {
  etag?: string | null;
  signal?: AbortSignal;
} = {}): Promise<WorkspaceReadResult> {
  const headers: HeadersInit = {};
  if (options.etag) headers["If-None-Match"] = options.etag;
  const response = await fetchApi(PLANNER_API_ROUTES.workspace.path, {
    headers,
    signal: options.signal,
  });
  const metadata = {
    etag: response.headers.get("ETag"),
    serverDate: serverDate(response),
  };
  if (response.status === 304) return { kind: "not_modified", ...metadata };
  const value = await parseJson(response);
  if (!response.ok) throwFailure(response, value);
  if (!isWorkspaceResponse(value)) {
    throwFailure(response, value);
  }
  return { kind: "workspace", workspace: value as WorkspaceResponse, ...metadata };
}

export async function readHealth(): Promise<HealthResponse> {
  const response = await fetchApi(PLANNER_API_ROUTES.health.path);
  const value = await parseJson(response);
  if (isApiFailure(value)) throwFailure(response, value);
  if (!isRecord(value) || typeof value.status !== "string") throwFailure(response, value);
  return value as HealthResponse;
}

export async function bootstrapWorkspace(
  request: BootstrapWorkspaceRequest,
): Promise<BootstrapWorkspaceResponse> {
  const { response, value } = await postJson(PLANNER_API_ROUTES.bootstrap.path, request);
  if (!response.ok) throwFailure(response, value);
  if (
    !isRecord(value) ||
    typeof value.imported !== "boolean" ||
    !isInitializedWorkspace(value.workspace)
  ) {
    throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid bootstrap response." });
  }
  return value as BootstrapWorkspaceResponse;
}

export async function applyPlannerCommand(options: {
  requestId: string;
  basePlannerVersion: number;
  command: HouseholdCommand;
}): Promise<ApplyPlannerCommandResponse> {
  const { value } = await postJson(PLANNER_API_ROUTES.commands.path, options);
  if (!isRecord(value) || !isRecord(value.decision) || !isInitializedWorkspace(value.workspace)) {
    throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid command response." });
  }
  return value as ApplyPlannerCommandResponse;
}

export async function undoLatest(request: UndoLatestRequest): Promise<ApplyPlannerCommandResponse> {
  const { value } = await postJson(PLANNER_API_ROUTES.undo.path, request);
  if (!isRecord(value) || !isRecord(value.decision) || !isInitializedWorkspace(value.workspace)) {
    throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid undo response." });
  }
  return value as ApplyPlannerCommandResponse;
}

export async function submitChatTurn(request: SubmitChatTurnRequest): Promise<ChatServiceResponse> {
  const { value } = await postJson(PLANNER_API_ROUTES.chatSubmit.path, request);
  if (!isRecord(value) || !isRecord(value.decision) || !isInitializedWorkspace(value.workspace)) {
    throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid chat response." });
  }
  return value as ChatServiceResponse;
}

export async function retryChatTurn(request: RetryChatTurnRequest): Promise<ChatServiceResponse> {
  const { value } = await postJson(PLANNER_API_ROUTES.chatRetry.path, request);
  if (!isRecord(value) || !isRecord(value.decision) || !isInitializedWorkspace(value.workspace)) {
    throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid chat response." });
  }
  return value as ChatServiceResponse;
}

function pagePath(path: string, request: PageRequest): string {
  const query = new URLSearchParams();
  if (request.beforeSequence !== undefined) query.set("beforeSequence", String(request.beforeSequence));
  if (request.limit !== undefined) query.set("limit", String(request.limit));
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetchApi(path);
  const value = await parseJson(response);
  if (!response.ok) throwFailure(response, value);
  return value;
}

export async function readHistoryPage(request: PageRequest = {}): Promise<PlannerEventPage> {
  const value = await getJson(pagePath(PLANNER_API_ROUTES.history.path, request));
  if (!isRecord(value) || value.order !== "newest_first" || !Array.isArray(value.items)) {
    throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid history response." });
  }
  return value as PlannerEventPage;
}

export async function readTranscriptPage(request: PageRequest = {}): Promise<TranscriptPage> {
  const value = await getJson(pagePath(PLANNER_API_ROUTES.transcript.path, request));
  if (!isRecord(value) || value.order !== "newest_first" || !Array.isArray(value.items)) {
    throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid transcript response." });
  }
  return value as TranscriptPage;
}

export async function exportWorkspace(): Promise<ExportEnvelope> {
  const value = await getJson(PLANNER_API_ROUTES.export.path);
  if (!isRecord(value) || !isInitializedWorkspace({ initialized: true, ...value })) {
    throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid export response." });
  }
  return value as ExportEnvelope;
}

export function readLegacyImport(storage: Pick<Storage, "getItem">): LegacyImportCandidate {
  const raw = storage.getItem(LEGACY_V2_STORAGE_KEY);
  if (raw === null) return { present: false, payload: null, error: null };
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, "data") ||
      !Object.hasOwn(value, "events") ||
      !Object.hasOwn(value, "chatMessages")
    ) {
      return {
        present: true,
        payload: null,
        error: "The saved browser planner is not a recognized v2 export.",
      };
    }
    return {
      present: true,
      payload: {
        data: value.data,
        events: value.events,
        chatMessages: value.chatMessages,
      },
      error: null,
    };
  } catch {
    return {
      present: true,
      payload: null,
      error: "The saved browser planner is damaged and cannot be imported.",
    };
  }
}

export function shouldAcceptWorkspace(
  current: WorkspaceResponse | null,
  incoming: WorkspaceResponse,
): boolean {
  if (!current) return true;
  if (!current.initialized) return true;
  if (!incoming.initialized) return false;
  return incoming.syncRevision >= current.syncRevision;
}
