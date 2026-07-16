import type { HouseholdCommand } from "../lib/household-command-contract.ts";
import type {
  ApiError,
  ApiFailure,
  ApplyPlannerCommandRequest,
  ApplyPlannerCommandResponse,
  BootstrapWorkspaceRequest,
  BootstrapWorkspaceResponse,
  DiagnosticExportEnvelope,
  HealthResponse,
  InitializedWorkspace,
  LegacyV2Payload,
  PageRequest,
  PlannerEventPage,
  UndoLatestRequest,
  WorkspaceResponse,
} from "../lib/planner-api-contract.ts";
import {
  LEGACY_V2_STORAGE_KEY,
  PLANNER_API_ROUTES,
  isDiagnosticExportEnvelope,
} from "../lib/planner-api-contract.ts";
import {
  markAuthorityOperationAmbiguous,
  prepareAuthorityOperation,
  resolveAuthorityOperation,
  settleAuthorityOperation,
  type AuthorityOperationKind,
  type PendingAuthorityOperation,
} from "./authority-operation-journal.ts";

export const LEGACY_V1_STORAGE_KEY = "weekly-recipe-planner:v1";

export type WorkspaceReadResult =
  | { kind: "not_modified"; etag: string | null; serverDate: number | null }
  | {
      kind: "workspace";
      workspace: WorkspaceResponse;
      etag: string | null;
      serverDate: number | null;
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

export type AuthorityOperationPresentation = {
  label: string;
  submittedDraft?: unknown;
};

type PostResolution =
  | { accepted: true }
  | { accepted: false; code: string; message: string };

const DEFAULT_OPERATION_LABELS: Record<AuthorityOperationKind, string> = {
  planner: "Save shared planner change",
  bootstrap: "Set up shared planner",
  undo: "Undo latest change",
};

async function postJson<Result>(
  kind: AuthorityOperationKind,
  path: string,
  body: unknown,
  accept: (response: Response, value: unknown) => Result,
  resolution: (result: Result) => PostResolution,
  presentation?: AuthorityOperationPresentation,
): Promise<Result> {
  const operation = prepareAuthorityOperation({
    kind,
    path,
    body,
    label: presentation?.label ?? DEFAULT_OPERATION_LABELS[kind],
    submittedDraft: presentation?.submittedDraft ?? body,
  });
  const request: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: operation.serializedBody,
  };
  let response: Response;
  try {
    try {
      response = await fetchApi(path, request);
    } catch (error) {
      if (!(error instanceof PlannerApiError) || error.code !== "NETWORK_ERROR") throw error;
      // A response can disappear after commit. Retry the identical envelope so
      // the authority can resolve the existing receipt without duplicating work.
      response = await fetchApi(path, request);
    }
  } catch (error) {
    if (error instanceof PlannerApiError && error.code === "NETWORK_ERROR") {
      markAuthorityOperationAmbiguous(operation);
    }
    throw error;
  }
  let value: unknown;
  try {
    value = await parseJson(response);
  } catch (error) {
    markAuthorityOperationAmbiguous(operation);
    throw error;
  }
  if (isApiFailure(value)) {
    resolveAuthorityOperation(operation, {
      code: value.error.code,
      message: value.error.message,
    });
    throwFailure(response, value);
  }
  try {
    const result = accept(response, value);
    const outcome = resolution(result);
    if (outcome.accepted) {
      settleAuthorityOperation(operation);
    } else {
      resolveAuthorityOperation(operation, {
        code: outcome.code,
        message: outcome.message,
      });
    }
    return result;
  } catch (error) {
    markAuthorityOperationAmbiguous(operation);
    throw error;
  }
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
  presentation?: AuthorityOperationPresentation,
): Promise<BootstrapWorkspaceResponse> {
  return postJson("bootstrap", PLANNER_API_ROUTES.bootstrap.path, request, (response, value) => {
    if (!response.ok) throwFailure(response, value);
    if (
      !isRecord(value) ||
      typeof value.imported !== "boolean" ||
      !isInitializedWorkspace(value.workspace)
    ) {
      throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid bootstrap response." });
    }
    return value as BootstrapWorkspaceResponse;
  }, () => ({ accepted: true }), presentation);
}

export async function applyPlannerCommand(options: {
  requestId: string;
  basePlannerVersion: number;
  command: HouseholdCommand;
}, presentation?: AuthorityOperationPresentation): Promise<ApplyPlannerCommandResponse> {
  return postJson("planner", PLANNER_API_ROUTES.commands.path, options, (_response, value) => {
    if (!isRecord(value) || !isRecord(value.decision) || !isInitializedWorkspace(value.workspace)) {
      throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid command response." });
    }
    return value as ApplyPlannerCommandResponse;
  }, (result) => result.decision.status === "accepted"
    ? { accepted: true }
    : {
        accepted: false,
        code: result.decision.status,
        message: result.decision.status === "domain_rejected"
          ? result.decision.message
          : `Someone else changed the plan. “${presentation?.label ?? DEFAULT_OPERATION_LABELS.planner}” was not saved. Review the latest plan, then retry it.`,
      }, presentation);
}

export async function undoLatest(
  request: UndoLatestRequest,
  presentation?: AuthorityOperationPresentation,
): Promise<ApplyPlannerCommandResponse> {
  return postJson("undo", PLANNER_API_ROUTES.undo.path, request, (_response, value) => {
    if (!isRecord(value) || !isRecord(value.decision) || !isInitializedWorkspace(value.workspace)) {
      throw new PlannerApiError({ status: 0, code: "INVALID_RESPONSE", message: "Invalid undo response." });
    }
    return value as ApplyPlannerCommandResponse;
  }, (result) => result.decision.status === "accepted"
    ? { accepted: true }
    : {
        accepted: false,
        code: result.decision.status,
        message: result.decision.status === "domain_rejected"
          ? result.decision.message
          : "The workspace changed before undo was accepted.",
      }, presentation);
}

export type AuthorityOperationReplayResult =
  | { kind: "planner" | "undo"; response: ApplyPlannerCommandResponse }
  | { kind: "bootstrap"; response: BootstrapWorkspaceResponse };

export async function replayAuthorityOperation(
  operation: PendingAuthorityOperation,
): Promise<AuthorityOperationReplayResult> {
  const request: unknown = JSON.parse(operation.serializedBody);
  const presentation = {
    label: operation.label,
    submittedDraft: operation.editableDraft,
  };
  if (operation.kind === "planner") {
    return {
      kind: operation.kind,
      response: await applyPlannerCommand(request as ApplyPlannerCommandRequest, presentation),
    };
  }
  if (operation.kind === "bootstrap") {
    return {
      kind: operation.kind,
      response: await bootstrapWorkspace(request as BootstrapWorkspaceRequest, presentation),
    };
  }
  return {
    kind: "undo",
    response: await undoLatest(request as UndoLatestRequest, presentation),
  };
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

export async function exportWorkspace(): Promise<DiagnosticExportEnvelope> {
  const value = await getJson(PLANNER_API_ROUTES.export.path);
  if (!isDiagnosticExportEnvelope(value)) {
    throw new PlannerApiError({
      status: 0,
      code: "INVALID_RESPONSE",
      message: "Invalid diagnostic export response.",
    });
  }
  return value;
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
