import type { IncomingMessage, ServerResponse } from "node:http";

import { isHouseholdCommand } from "../../lib/household-command-contract.ts";
import {
  PLANNER_API_ROUTES,
  normalizePageRequest,
  type ApiErrorCode,
  type BootstrapWorkspaceRequest,
  type HealthResponse,
  type LegacyV2Payload,
  type PageRequest,
  type WorkspaceResponse,
} from "../../lib/planner-api-contract.ts";
import { isPlannerChatContext } from "../../lib/planner-chat-contract.ts";
import type {
  ChatApplicationService,
  PlannerApplicationService,
} from "../application/ports.ts";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 200;
const MAX_CHAT_MESSAGE_LENGTH = 4_000;

export type ApplicationRouterDependencies = {
  planner: PlannerApplicationService;
  chat: ChatApplicationService;
  readHealth(): Promise<HealthResponse> | HealthResponse;
};

export type ApplicationRouterOptions = {
  allowedOrigins?: ReadonlySet<string>;
  allowOriginlessMutations?: boolean;
};

class ApiRouteError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly fieldErrors?: Record<string, string>;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function setCommonHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  if (response.writableEnded) return;
  setCommonHeaders(response);
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

function sendFailure(response: ServerResponse, error: ApiRouteError) {
  sendJson(response, error.statusCode, {
    error: {
      code: error.code,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    },
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ApiRouteError(415, "INVALID_REQUEST", "Content-Type must be application/json.");
  }

  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new ApiRouteError(413, "INVALID_REQUEST", "Request body is too large.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiRouteError(413, "INVALID_REQUEST", "Request body is too large.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiRouteError(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }
}

function assertMutationOrigin(
  request: IncomingMessage,
  { allowedOrigins, allowOriginlessMutations = true }: ApplicationRouterOptions,
) {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (origin && !allowedOrigins?.has(origin)) {
    throw new ApiRouteError(403, "INVALID_REQUEST", "This origin cannot mutate the planner.");
  }
  if (!origin && !allowOriginlessMutations) {
    throw new ApiRouteError(403, "INVALID_REQUEST", "Mutation requests require an allowed origin.");
  }
  if (fetchSite === "cross-site") {
    throw new ApiRouteError(403, "INVALID_REQUEST", "Cross-site planner requests are blocked.");
  }
}

function workspaceEtag(workspace: WorkspaceResponse) {
  return workspace.initialized
    ? `"workspace-${workspace.syncRevision}"`
    : `"workspace-uninitialized-${workspace.schemaVersion}"`;
}

function validateBootstrapRequest(value: unknown): BootstrapWorkspaceRequest {
  if (!isRecord(value) || !isId(value.requestId)) {
    throw new ApiRouteError(400, "INVALID_REQUEST", "A valid requestId is required.");
  }
  if (value.mode === "seed" && hasExactKeys(value, ["requestId", "mode"])) {
    return { requestId: value.requestId, mode: "seed" };
  }
  if (
    value.mode === "import-v2" &&
    hasExactKeys(value, ["requestId", "mode", "payload"]) &&
    hasExactKeys(value.payload, ["data", "events", "chatMessages"])
  ) {
    return {
      requestId: value.requestId,
      mode: "import-v2",
      payload: value.payload as LegacyV2Payload,
    };
  }
  throw new ApiRouteError(400, "INVALID_REQUEST", "Bootstrap must select seed or an exact v2 import.");
}

function parsePageRequest(url: URL): PageRequest {
  const beforeRaw = url.searchParams.get("beforeSequence");
  const limitRaw = url.searchParams.get("limit");
  if ([...url.searchParams.keys()].some((key) => !["beforeSequence", "limit"].includes(key))) {
    throw new ApiRouteError(400, "INVALID_REQUEST", "Unknown pagination parameter.");
  }
  const request: PageRequest = {};
  if (beforeRaw !== null) request.beforeSequence = Number(beforeRaw);
  if (limitRaw !== null) request.limit = Number(limitRaw);
  const normalized = normalizePageRequest(request);
  if (!normalized) {
    throw new ApiRouteError(400, "INVALID_REQUEST", "Invalid pagination cursor or limit.");
  }
  return {
    ...(normalized.beforeSequence === null
      ? {}
      : { beforeSequence: normalized.beforeSequence }),
    limit: normalized.limit,
  };
}

function plannerDecisionStatus(status: string) {
  if (status === "accepted") return 200;
  if (status === "version_conflict") return 409;
  return 422;
}

function chatDecisionStatus(status: string) {
  if (status === "accepted") return 202;
  if (status === "turn_busy" || status === "context_stale" || status === "request_id_reuse") return 409;
  if (status === "not_found") return 404;
  if (status === "codex_unavailable") return 503;
  return 422;
}

function mapThrownError(error: unknown): ApiRouteError {
  if (error instanceof ApiRouteError) return error;
  if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
    const code = error.code as ApiErrorCode;
    const status =
      code === "NOT_INITIALIZED" || code === "NOT_FOUND"
        ? 404
        : code === "ALREADY_INITIALIZED" || code === "VERSION_CONFLICT" || code === "REQUEST_ID_REUSE" || code === "TURN_BUSY" || code === "CONTEXT_STALE"
          ? 409
          : code === "DOMAIN_REJECTED" || code === "INVALID_REQUEST"
            ? 422
            : code === "UNAVAILABLE" || code === "CODEX_UNAVAILABLE" || code === "STORE_CORRUPT"
              ? 503
              : 500;
    return new ApiRouteError(status, code, error.message);
  }
  return new ApiRouteError(500, "INTERNAL_ERROR", "The planner failed unexpectedly.");
}

export function createApplicationRouter(
  dependencies: ApplicationRouterDependencies,
  options: ApplicationRouterOptions = {},
) {
  const routeByPath = new Map<string, { method: "GET" | "POST"; path: string }>(
    Object.values(PLANNER_API_ROUTES).map((route) => [route.path, route]),
  );

  return async function applicationRouter(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!isLoopbackHost(request.headers.host)) {
        throw new ApiRouteError(400, "INVALID_REQUEST", "Planner requests require a loopback host.");
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const route = routeByPath.get(url.pathname);
      if (!route) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
        return;
      }
      if (request.method !== route.method) {
        response.setHeader("Allow", route.method);
        sendJson(response, 405, { error: { code: "INVALID_REQUEST", message: "Method not allowed." } });
        return;
      }
      if (route.method === "POST") assertMutationOrigin(request, options);

      if (url.pathname === PLANNER_API_ROUTES.health.path) {
        const health = await dependencies.readHealth();
        sendJson(response, health.status === "unavailable" ? 503 : 200, health);
        return;
      }
      if (url.pathname === PLANNER_API_ROUTES.workspace.path) {
        const workspace = dependencies.planner.readWorkspace();
        const etag = workspaceEtag(workspace);
        response.setHeader("ETag", etag);
        if (request.headers["if-none-match"] === etag) {
          response.statusCode = 304;
          response.end();
        } else {
          sendJson(response, 200, workspace);
        }
        return;
      }
      if (url.pathname === PLANNER_API_ROUTES.history.path) {
        sendJson(response, 200, dependencies.planner.readEventPage(parsePageRequest(url)));
        return;
      }
      if (url.pathname === PLANNER_API_ROUTES.transcript.path) {
        sendJson(response, 200, dependencies.planner.readTranscriptPage(parsePageRequest(url)));
        return;
      }
      if (url.pathname === PLANNER_API_ROUTES.export.path) {
        response.setHeader("Content-Disposition", 'attachment; filename="meal-planner-export.json"');
        sendJson(response, 200, dependencies.planner.exportWorkspace());
        return;
      }

      const body = await readJsonBody(request);
      if (url.pathname === PLANNER_API_ROUTES.bootstrap.path) {
        sendJson(response, 201, dependencies.planner.bootstrap(validateBootstrapRequest(body)));
        return;
      }
      if (url.pathname === PLANNER_API_ROUTES.commands.path) {
        if (
          !hasExactKeys(body, ["requestId", "basePlannerVersion", "command"]) ||
          !isId(body.requestId) ||
          !isNonnegativeInteger(body.basePlannerVersion) ||
          !isHouseholdCommand(body.command)
        ) {
          throw new ApiRouteError(400, "INVALID_REQUEST", "Malformed planner command request.");
        }
        const result = dependencies.planner.applyCommand({
          requestId: body.requestId,
          basePlannerVersion: body.basePlannerVersion,
          command: body.command,
        });
        sendJson(response, plannerDecisionStatus(result.decision.status), result);
        return;
      }
      if (url.pathname === PLANNER_API_ROUTES.undo.path) {
        if (
          !hasExactKeys(body, ["requestId", "basePlannerVersion", "targetEventId"]) ||
          !isId(body.requestId) ||
          !isNonnegativeInteger(body.basePlannerVersion) ||
          !isId(body.targetEventId)
        ) {
          throw new ApiRouteError(400, "INVALID_REQUEST", "Malformed undo request.");
        }
        const result = dependencies.planner.undoLatest({
          requestId: body.requestId,
          basePlannerVersion: body.basePlannerVersion,
          targetEventId: body.targetEventId,
        });
        sendJson(response, plannerDecisionStatus(result.decision.status), result);
        return;
      }
      if (url.pathname === PLANNER_API_ROUTES.chatSubmit.path) {
        if (
          !hasExactKeys(body, ["requestId", "basePlannerVersion", "message", "context"]) ||
          !isId(body.requestId) ||
          !isNonnegativeInteger(body.basePlannerVersion) ||
          typeof body.message !== "string" ||
          body.message.trim().length === 0 ||
          body.message.length > MAX_CHAT_MESSAGE_LENGTH ||
          !isPlannerChatContext(body.context)
        ) {
          throw new ApiRouteError(400, "INVALID_REQUEST", "Malformed chat submission.");
        }
        const result = await dependencies.chat.submit({
          requestId: body.requestId,
          basePlannerVersion: body.basePlannerVersion,
          message: body.message.trim(),
          context: body.context,
        });
        sendJson(response, chatDecisionStatus(result.decision.status), result);
        return;
      }
      if (url.pathname === PLANNER_API_ROUTES.chatRetry.path) {
        if (
          !hasExactKeys(body, ["requestId", "basePlannerVersion", "turnId"]) ||
          !isId(body.requestId) ||
          !isNonnegativeInteger(body.basePlannerVersion) ||
          !isId(body.turnId)
        ) {
          throw new ApiRouteError(400, "INVALID_REQUEST", "Malformed chat retry.");
        }
        const result = await dependencies.chat.retry({
          requestId: body.requestId,
          basePlannerVersion: body.basePlannerVersion,
          turnId: body.turnId,
        });
        sendJson(response, chatDecisionStatus(result.decision.status), result);
        return;
      }

      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (error) {
      sendFailure(response, mapThrownError(error));
    }
  };
}
