import {
  CODEX_EVENT_WAIT_MS_DEFAULT,
  CODEX_THREAD_API_ROUTES,
  type CodexApiErrorCode,
  type CodexArchiveThreadRequest,
  type CodexEventsRequest,
  type CodexEventsResponse,
  type CodexInteractionListRequest,
  type CodexInteractionListResponse,
  type CodexInteractionMutationResponse,
  type CodexInterruptTurnRequest,
  type CodexNewThreadRequest,
  type CodexRespondInteractionRequest,
  type CodexSelectThreadRequest,
  type CodexSendTurnRequest,
  type CodexThreadListRequest,
  type CodexThreadListResponse,
  type CodexThreadMutationResponse,
  type CodexThreadReadResponse,
  type CodexTurnMutationResponse,
  isCodexApiFailure,
  isCodexEventsResponse,
  isCodexInteractionListResponse,
  isCodexInteractionMutationResponse,
  isCodexThreadListResponse,
  isCodexThreadMutationResponse,
  isCodexThreadReadResponse,
  isCodexTurnMutationResponse,
} from "../lib/codex-thread-contract.ts";
import { resolvePublicPath } from "./public-path.ts";

export type CodexThreadClientErrorCode = CodexApiErrorCode | "NETWORK_ERROR" | "INVALID_RESPONSE";

export class CodexThreadClientError extends Error {
  readonly status: number;
  readonly code: CodexThreadClientErrorCode;

  constructor(options: { status: number; code: CodexThreadClientErrorCode; message: string }) {
    super(options.message);
    this.name = "CodexThreadClientError";
    this.status = options.status;
    this.code = options.code;
  }
}

function isAbortError(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError";
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new CodexThreadClientError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "Codex returned an unreadable response.",
    });
  }
}

type ResponseValidator<T> = (value: unknown) => value is T;

function requireResponse<T>(
  response: Response,
  value: unknown,
  expectedStatus: number,
  label: string,
  validator: ResponseValidator<T>,
): T {
  if (response.status !== expectedStatus) {
    if (!response.ok && isCodexApiFailure(value)) {
      throw new CodexThreadClientError({
        status: response.status,
        code: value.error.code,
        message: value.error.message,
      });
    }
    throw new CodexThreadClientError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "Codex returned an unexpected error response.",
    });
  }
  if (!validator(value)) {
    throw new CodexThreadClientError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: `Codex returned an invalid ${label} response.`,
    });
  }
  return value;
}

async function fetchCodex(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(resolvePublicPath(path, import.meta.env.BASE_URL), {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new CodexThreadClientError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "The Codex thread service is unreachable.",
    });
  }
}

async function getJson<T>(
  path: string,
  expectedStatus: number,
  label: string,
  validator: ResponseValidator<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetchCodex(path, { signal });
  return requireResponse(response, await parseJson(response), expectedStatus, label, validator);
}

async function postJson<T>(
  path: string,
  body: unknown,
  expectedStatus: number,
  label: string,
  validator: ResponseValidator<T>,
): Promise<T> {
  const response = await fetchCodex(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return requireResponse(response, await parseJson(response), expectedStatus, label, validator);
}

function query(path: string, values: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function createCodexRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `browser-${crypto.randomUUID()}`;
  }
  return `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function listCodexThreads(
  request: CodexThreadListRequest = {},
): Promise<CodexThreadListResponse> {
  return getJson(
    query(CODEX_THREAD_API_ROUTES.threadsList.path, {
      archived: request.archived === undefined ? undefined : String(request.archived),
      cursor: request.cursor,
      limit: request.limit,
      search: request.search,
    }),
    200,
    "thread list",
    isCodexThreadListResponse,
  );
}

export function readCodexThread(threadId: string): Promise<CodexThreadReadResponse> {
  return getJson(
    query(CODEX_THREAD_API_ROUTES.threadRead.path, { threadId }),
    200,
    "thread",
    isCodexThreadReadResponse,
  );
}

export function listCodexInteractions(
  request: CodexInteractionListRequest = {},
): Promise<CodexInteractionListResponse> {
  return getJson(
    query(CODEX_THREAD_API_ROUTES.interactionsList.path, { threadId: request.threadId }),
    200,
    "interaction list",
    isCodexInteractionListResponse,
  );
}

export function newCodexThread(
  request: CodexNewThreadRequest,
): Promise<CodexThreadMutationResponse> {
  return postJson(
    CODEX_THREAD_API_ROUTES.threadNew.path,
    request,
    201,
    "new-thread",
    isCodexThreadMutationResponse,
  );
}

export function selectCodexThread(
  request: CodexSelectThreadRequest,
): Promise<CodexThreadMutationResponse> {
  return postJson(
    CODEX_THREAD_API_ROUTES.threadSelect.path,
    request,
    200,
    "selection",
    isCodexThreadMutationResponse,
  );
}

export function archiveCodexThread(
  request: CodexArchiveThreadRequest,
): Promise<CodexThreadMutationResponse> {
  return postJson(
    CODEX_THREAD_API_ROUTES.threadArchive.path,
    request,
    200,
    "archive",
    isCodexThreadMutationResponse,
  );
}

export function sendCodexTurn(request: CodexSendTurnRequest): Promise<CodexTurnMutationResponse> {
  return postJson(
    CODEX_THREAD_API_ROUTES.turnSend.path,
    request,
    202,
    "turn",
    isCodexTurnMutationResponse,
  );
}

export function interruptCodexTurn(
  request: CodexInterruptTurnRequest,
): Promise<CodexTurnMutationResponse> {
  return postJson(
    CODEX_THREAD_API_ROUTES.turnInterrupt.path,
    request,
    200,
    "interrupt",
    isCodexTurnMutationResponse,
  );
}

export function respondToCodexInteraction(
  request: CodexRespondInteractionRequest,
): Promise<CodexInteractionMutationResponse> {
  return postJson(
    CODEX_THREAD_API_ROUTES.interactionRespond.path,
    request,
    200,
    "interaction",
    isCodexInteractionMutationResponse,
  );
}

export function waitForCodexEvents(request: CodexEventsRequest & {
  signal?: AbortSignal;
}): Promise<CodexEventsResponse> {
  return getJson(
    query(CODEX_THREAD_API_ROUTES.events.path, {
      connectionEpoch: request.connectionEpoch,
      afterRevision: request.afterRevision,
      waitMs: request.waitMs ?? CODEX_EVENT_WAIT_MS_DEFAULT,
      threadId: request.threadId,
    }),
    200,
    "event",
    isCodexEventsResponse,
    request.signal,
  );
}
