import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CODEX_API_ERROR_CODES,
  CODEX_THREAD_API_ROUTES,
  isCodexArchiveThreadRequest,
  isCodexEventsRequest,
  isCodexInteractionListRequest,
  isCodexInterruptTurnRequest,
  isCodexNewThreadRequest,
  isCodexRespondInteractionRequest,
  isCodexSelectThreadRequest,
  isCodexSendTurnRequest,
  isCodexThreadListRequest,
  isCodexThreadReadRequest,
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
  type CodexThreadReadRequest,
  type CodexThreadReadResponse,
  type CodexTurnMutationResponse,
} from "../../lib/codex-thread-contract.ts";

const MAX_BODY_BYTES = 256 * 1024;

type MaybePromise<T> = T | Promise<T>;

export type CodexThreadServicePort = {
  listThreads(request: CodexThreadListRequest): MaybePromise<CodexThreadListResponse>;
  readThread(request: CodexThreadReadRequest): MaybePromise<CodexThreadReadResponse>;
  newThread(request: CodexNewThreadRequest): MaybePromise<CodexThreadMutationResponse>;
  selectThread(request: CodexSelectThreadRequest): MaybePromise<CodexThreadMutationResponse>;
  archiveThread(request: CodexArchiveThreadRequest): MaybePromise<CodexThreadMutationResponse>;
  sendTurn(request: CodexSendTurnRequest): MaybePromise<CodexTurnMutationResponse>;
  interruptTurn(request: CodexInterruptTurnRequest): MaybePromise<CodexTurnMutationResponse>;
  listInteractions(
    request: CodexInteractionListRequest,
  ): MaybePromise<CodexInteractionListResponse>;
  respondInteraction(
    request: CodexRespondInteractionRequest,
  ): MaybePromise<CodexInteractionMutationResponse>;
  waitForEvents(
    request: CodexEventsRequest,
    context: { signal: AbortSignal },
  ): MaybePromise<CodexEventsResponse>;
};

export type CodexRouterOptions = {
  allowedOrigins?: ReadonlySet<string>;
  allowOriginlessMutations?: boolean;
  now?: () => number;
};

class CodexRouteError extends Error {
  readonly statusCode: number;
  readonly code: CodexApiErrorCode;

  constructor(statusCode: number, code: CodexApiErrorCode, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAllowedRequestHost(
  host: string | undefined,
  allowedOrigins: ReadonlySet<string> | undefined,
): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return false;
    if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
    return [...(allowedOrigins ?? [])].some((origin) => {
      try {
        return new URL(origin).host === parsed.host;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  setCommonHeaders(response);
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

function sendFailure(response: ServerResponse, error: CodexRouteError): void {
  sendJson(response, error.statusCode, {
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

function defaultErrorStatus(code: CodexApiErrorCode): number {
  if (code === "INVALID_REQUEST") return 400;
  if (code === "NOT_FOUND") return 404;
  if (
    code === "REQUEST_ID_REUSE" ||
    code === "SELECTION_CONFLICT" ||
    code === "TURN_CONFLICT" ||
    code === "INTERACTION_STALE"
  ) {
    return 409;
  }
  if (code === "CODEX_UNAVAILABLE" || code === "CODEX_INCOMPATIBLE") return 503;
  return 500;
}

function mapThrownError(error: unknown): CodexRouteError {
  if (error instanceof CodexRouteError) return error;
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    CODEX_API_ERROR_CODES.includes(error.code as CodexApiErrorCode) &&
    typeof error.message === "string"
  ) {
    const code = error.code as CodexApiErrorCode;
    const explicitStatus = Number(error.httpStatus);
    const statusCode =
      Number.isSafeInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599
        ? explicitStatus
        : defaultErrorStatus(code);
    return new CodexRouteError(statusCode, code, error.message);
  }
  return new CodexRouteError(
    500,
    "INTERNAL_ERROR",
    "The Codex thread service failed unexpectedly.",
  );
}

function assertMutationOrigin(
  request: IncomingMessage,
  { allowedOrigins, allowOriginlessMutations = true }: CodexRouterOptions,
): void {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (origin && !allowedOrigins?.has(origin)) {
    throw new CodexRouteError(403, "INVALID_REQUEST", "This origin cannot mutate Codex threads.");
  }
  if (!origin && !allowOriginlessMutations) {
    throw new CodexRouteError(
      403,
      "INVALID_REQUEST",
      "Mutation requests require an allowed origin.",
    );
  }
  if (fetchSite === "cross-site") {
    throw new CodexRouteError(403, "INVALID_REQUEST", "Cross-site Codex requests are blocked.");
  }
}

function assertNoDuplicateOrUnknownQuery(
  url: URL,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new CodexRouteError(400, "INVALID_REQUEST", "Unknown Codex query parameter.");
    }
    if (seen.has(key)) {
      throw new CodexRouteError(400, "INVALID_REQUEST", "Duplicate Codex query parameter.");
    }
    seen.add(key);
  }
}

function parseCanonicalNonnegativeInteger(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseCanonicalPositiveInteger(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseThreadListRequest(url: URL): CodexThreadListRequest {
  assertNoDuplicateOrUnknownQuery(url, ["archived", "cursor", "limit", "search"]);
  const request: Record<string, unknown> = {};
  const archived = url.searchParams.get("archived");
  const cursor = url.searchParams.get("cursor");
  const limit = url.searchParams.get("limit");
  const search = url.searchParams.get("search");
  if (archived !== null) {
    if (archived !== "true" && archived !== "false") {
      throw new CodexRouteError(400, "INVALID_REQUEST", "Invalid archived filter.");
    }
    request.archived = archived === "true";
  }
  if (cursor !== null) request.cursor = cursor;
  if (limit !== null) request.limit = parseCanonicalPositiveInteger(limit);
  if (search !== null) request.search = search;
  if (!isCodexThreadListRequest(request)) {
    throw new CodexRouteError(400, "INVALID_REQUEST", "Malformed Codex thread list request.");
  }
  return request;
}

function parseThreadReadRequest(url: URL): CodexThreadReadRequest {
  assertNoDuplicateOrUnknownQuery(url, ["threadId"]);
  const request = { threadId: url.searchParams.get("threadId") };
  if (!isCodexThreadReadRequest(request)) {
    throw new CodexRouteError(400, "INVALID_REQUEST", "Malformed Codex thread read request.");
  }
  return request;
}

function parseInteractionListRequest(url: URL): CodexInteractionListRequest {
  assertNoDuplicateOrUnknownQuery(url, ["threadId"]);
  const threadId = url.searchParams.get("threadId");
  const request = threadId === null ? {} : { threadId };
  if (!isCodexInteractionListRequest(request)) {
    throw new CodexRouteError(400, "INVALID_REQUEST", "Malformed Codex interaction list request.");
  }
  return request;
}

function parseEventsRequest(url: URL): CodexEventsRequest {
  assertNoDuplicateOrUnknownQuery(url, [
    "connectionEpoch",
    "afterRevision",
    "waitMs",
    "threadId",
  ]);
  const connectionEpoch = url.searchParams.get("connectionEpoch");
  const afterRevision = parseCanonicalNonnegativeInteger(
    url.searchParams.get("afterRevision"),
  );
  const waitMsRaw = url.searchParams.get("waitMs");
  const threadId = url.searchParams.get("threadId");
  const request: Record<string, unknown> = {
    connectionEpoch,
    afterRevision,
  };
  if (waitMsRaw !== null) request.waitMs = parseCanonicalNonnegativeInteger(waitMsRaw);
  if (threadId !== null) request.threadId = threadId;
  if (!isCodexEventsRequest(request)) {
    throw new CodexRouteError(400, "INVALID_REQUEST", "Malformed Codex events request.");
  }
  return request;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const rawContentType = request.headers["content-type"];
  const contentType = Array.isArray(rawContentType) ? "" : rawContentType ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    request.resume();
    throw new CodexRouteError(415, "INVALID_REQUEST", "Content-Type must be application/json.");
  }

  const rawContentLength = request.headers["content-length"];
  if (Array.isArray(rawContentLength) || (
    rawContentLength !== undefined && !/^(?:0|[1-9][0-9]*)$/u.test(rawContentLength)
  )) {
    request.resume();
    throw new CodexRouteError(400, "INVALID_REQUEST", "Content-Length is invalid.");
  }
  if (rawContentLength !== undefined && Number(rawContentLength) > MAX_BODY_BYTES) {
    request.resume();
    throw new CodexRouteError(413, "INVALID_REQUEST", "Request body is too large.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new CodexRouteError(413, "INVALID_REQUEST", "Request body is too large.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CodexRouteError(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }
}

function assertNoQuery(url: URL): void {
  assertNoDuplicateOrUnknownQuery(url, []);
}

function invalidBody(message: string): never {
  throw new CodexRouteError(400, "INVALID_REQUEST", message);
}

function createRequestAbortContext(request: IncomingMessage, response: ServerResponse): {
  signal: AbortSignal;
  close(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnPrematureResponseClose = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", abortOnPrematureResponseClose);
  return {
    signal: controller.signal,
    close() {
      request.off("aborted", abort);
      response.off("close", abortOnPrematureResponseClose);
    },
  };
}

const routeByPath = new Map<
  string,
  { readonly method: "GET" | "POST"; readonly path: string }
>(Object.values(CODEX_THREAD_API_ROUTES).map((route) => [route.path, route]));

export function createCodexRouter(
  service: CodexThreadServicePort,
  options: CodexRouterOptions = {},
) {
  return async function codexRouter(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://planner.local");
    const route = routeByPath.get(url.pathname);
    if (!route) return false;

    const responseTime = options.now?.() ?? Date.now();
    if (Number.isFinite(responseTime)) {
      response.setHeader("Date", new Date(responseTime).toUTCString());
    }

    try {
      if (!isAllowedRequestHost(request.headers.host, options.allowedOrigins)) {
        throw new CodexRouteError(
          400,
          "INVALID_REQUEST",
          "Codex requests require a loopback or explicitly allowed proxy host.",
        );
      }
      if (request.method !== route.method) {
        response.setHeader("Allow", route.method);
        throw new CodexRouteError(405, "INVALID_REQUEST", "Method not allowed.");
      }
      if (route.method === "POST") assertMutationOrigin(request, options);

      if (url.pathname === CODEX_THREAD_API_ROUTES.threadsList.path) {
        sendJson(response, 200, await service.listThreads(parseThreadListRequest(url)));
        return true;
      }
      if (url.pathname === CODEX_THREAD_API_ROUTES.threadRead.path) {
        sendJson(response, 200, await service.readThread(parseThreadReadRequest(url)));
        return true;
      }
      if (url.pathname === CODEX_THREAD_API_ROUTES.interactionsList.path) {
        sendJson(response, 200, await service.listInteractions(parseInteractionListRequest(url)));
        return true;
      }
      if (url.pathname === CODEX_THREAD_API_ROUTES.events.path) {
        const context = createRequestAbortContext(request, response);
        try {
          const result = await service.waitForEvents(parseEventsRequest(url), {
            signal: context.signal,
          });
          if (!context.signal.aborted) sendJson(response, 200, result);
        } finally {
          context.close();
        }
        return true;
      }

      assertNoQuery(url);
      const body = await readJsonBody(request);
      if (url.pathname === CODEX_THREAD_API_ROUTES.threadNew.path) {
        if (!isCodexNewThreadRequest(body)) invalidBody("Malformed Codex new-thread request.");
        sendJson(response, 201, await service.newThread(body));
        return true;
      }
      if (url.pathname === CODEX_THREAD_API_ROUTES.threadSelect.path) {
        if (!isCodexSelectThreadRequest(body)) invalidBody("Malformed Codex selection request.");
        sendJson(response, 200, await service.selectThread(body));
        return true;
      }
      if (url.pathname === CODEX_THREAD_API_ROUTES.threadArchive.path) {
        if (!isCodexArchiveThreadRequest(body)) invalidBody("Malformed Codex archive request.");
        sendJson(response, 200, await service.archiveThread(body));
        return true;
      }
      if (url.pathname === CODEX_THREAD_API_ROUTES.turnSend.path) {
        if (!isCodexSendTurnRequest(body)) invalidBody("Malformed Codex turn request.");
        sendJson(response, 202, await service.sendTurn(body));
        return true;
      }
      if (url.pathname === CODEX_THREAD_API_ROUTES.turnInterrupt.path) {
        if (!isCodexInterruptTurnRequest(body)) invalidBody("Malformed Codex interrupt request.");
        sendJson(response, 200, await service.interruptTurn(body));
        return true;
      }
      if (url.pathname === CODEX_THREAD_API_ROUTES.interactionRespond.path) {
        if (!isCodexRespondInteractionRequest(body)) {
          invalidBody("Malformed Codex interaction response.");
        }
        sendJson(response, 200, await service.respondInteraction(body));
        return true;
      }

      throw new CodexRouteError(404, "NOT_FOUND", "Not found.");
    } catch (error) {
      if (request.aborted || response.destroyed) return true;
      if (!request.readableEnded && !request.destroyed) request.resume();
      sendFailure(response, mapThrownError(error));
      return true;
    }
  };
}
