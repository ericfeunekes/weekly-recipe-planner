import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import {
  GLOBAL_CODEX_CONTRACT_VERSION,
  GLOBAL_CODEX_REQUEST_MAX_BYTES,
  GLOBAL_CODEX_RESPONSE_MAX_BYTES,
  GLOBAL_CODEX_ROUTES,
  isGlobalCodexBatchRequest,
  isGlobalCodexPreviewRequest,
  isGlobalCodexResponse,
  type GlobalCodexErrorCode,
  type GlobalCodexErrorResponse,
  type GlobalCodexResponse,
} from "../../lib/global-codex-contract.ts";
import type { GlobalCodexPlannerPort } from "./planner-port.ts";

const GET_HEADERS = new Set(["host", "connection"]);
const POST_HEADERS = new Set(["host", "connection", "content-type", "content-length"]);

type ErrorShape = {
  code?: unknown;
  fieldErrors?: unknown;
};

export type GlobalCodexRouterOptions = {
  now?: () => number;
};

function errorEnvelope(
  code: GlobalCodexErrorCode,
  message: string,
  fieldErrors?: Record<string, string>,
): GlobalCodexErrorResponse {
  return {
    contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
    error: {
      code,
      message,
      ...(fieldErrors === undefined ? {} : { fieldErrors }),
    },
  };
}

function sendSerialized(
  response: ServerResponse,
  status: number,
  payload: GlobalCodexResponse,
  extraHeaders: Record<string, string> = {},
): void {
  let effectivePayload = payload;
  if (!isGlobalCodexResponse(effectivePayload)) {
    effectivePayload = errorEnvelope("internal_error", "The planner response is unavailable.");
    status = 503;
  }
  let body = JSON.stringify(effectivePayload);
  let effectiveStatus = status;
  if (Buffer.byteLength(body) > GLOBAL_CODEX_RESPONSE_MAX_BYTES) {
    effectiveStatus = 503;
    body = JSON.stringify(errorEnvelope(
      "planner_unavailable",
      "The planner response is unavailable.",
    ));
  }
  response.writeHead(effectiveStatus, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    Connection: "close",
    ...extraHeaders,
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: GlobalCodexErrorCode,
  message: string,
  options?: { allow?: string; fieldErrors?: Record<string, string> },
): void {
  sendSerialized(
    response,
    status,
    errorEnvelope(code, message, options?.fieldErrors),
    options?.allow === undefined ? {} : { Allow: options.allow },
  );
}

function rawHeaderMap(request: IncomingMessage): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase();
    const values = result.get(name) ?? [];
    values.push(request.rawHeaders[index + 1] ?? "");
    result.set(name, values);
  }
  return result;
}

function validateHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  method: "GET" | "POST",
): { contentLength: number } | null {
  const headers = rawHeaderMap(request);
  const accepted = method === "GET" ? GET_HEADERS : POST_HEADERS;
  for (const [name, values] of headers) {
    if (values.length !== 1 || !accepted.has(name)) {
      sendError(response, 400, "invalid_request", "The request headers are invalid.");
      return null;
    }
  }
  const host = headers.get("host")?.[0];
  if (host === undefined || host.trim().length === 0) {
    sendError(response, 400, "invalid_request", "A single Host header is required.");
    return null;
  }
  if (method === "GET") return { contentLength: 0 };

  const mediaType = headers.get("content-type")?.[0];
  if (mediaType !== "application/json") {
    sendError(response, 415, "unsupported_media_type", "Content-Type must be application/json.");
    return null;
  }
  const lengthText = headers.get("content-length")?.[0];
  if (lengthText === undefined || !/^(0|[1-9][0-9]*)$/u.test(lengthText)) {
    sendError(response, 400, "invalid_request", "A valid Content-Length header is required.");
    return null;
  }
  const contentLength = Number(lengthText);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    sendError(response, 400, "invalid_request", "The request body must not be empty.");
    return null;
  }
  if (contentLength > GLOBAL_CODEX_REQUEST_MAX_BYTES) {
    sendError(response, 413, "payload_too_large", "The request body is too large.");
    return null;
  }
  return { contentLength };
}

function readExactBody(request: IncomingMessage, contentLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += bytes.length;
      if (received > contentLength || received > GLOBAL_CODEX_REQUEST_MAX_BYTES) {
        reject(new TypeError("body_length_mismatch"));
        request.destroy();
        return;
      }
      chunks.push(bytes);
    });
    request.once("aborted", () => reject(new TypeError("body_aborted")));
    request.once("error", reject);
    request.once("end", () => {
      if (received !== contentLength) {
        reject(new TypeError("body_length_mismatch"));
        return;
      }
      resolve(Buffer.concat(chunks, received));
    });
  });
}

function safeFieldErrors(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([key, entry]) => key.length <= 200 && typeof entry === "string" && entry.length <= 500)) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function mapApplicationError(response: ServerResponse, error: unknown): void {
  const shaped = error !== null && typeof error === "object" ? error as ErrorShape : {};
  switch (shaped.code) {
    case "REQUEST_ID_REUSE":
      sendError(response, 409, "request_id_reuse", "The request ID was already used with a different payload.");
      return;
    case "VERSION_CONFLICT":
      sendError(response, 409, "version_conflict", "The planner version changed before the batch committed.");
      return;
    case "INVALID_REQUEST":
      sendError(
        response,
        400,
        "invalid_request",
        "The planner batch is invalid.",
        { fieldErrors: safeFieldErrors(shaped.fieldErrors) },
      );
      return;
    case "NOT_INITIALIZED":
    case "UNAVAILABLE":
    case "STORE_CORRUPT":
    case "INTERNAL_ERROR":
      sendError(response, 503, "planner_unavailable", "The planner is unavailable.");
      return;
    default:
      sendError(response, 503, "internal_error", "The planner request could not be completed.");
  }
}

function allowedMethod(path: string): "GET" | "POST" | null {
  if (path === GLOBAL_CODEX_ROUTES.health || path === GLOBAL_CODEX_ROUTES.workspace) return "GET";
  if (path === GLOBAL_CODEX_ROUTES.batches || path === GLOBAL_CODEX_ROUTES.previews) return "POST";
  return null;
}

export function createGlobalCodexRouter(
  planner: GlobalCodexPlannerPort,
  options: GlobalCodexRouterOptions = {},
): RequestListener {
  const now = options.now ?? Date.now;
  return (request, response) => {
    void (async () => {
      if (request.httpVersion !== "1.1") {
        sendError(response, 400, "invalid_request", "HTTP/1.1 is required.");
        return;
      }
      const path = request.url ?? "";
      const allowed = allowedMethod(path);
      if (allowed === null) {
        sendError(response, 404, "not_found", "The requested route does not exist.");
        return;
      }
      if (request.method !== allowed) {
        sendError(
          response,
          405,
          "method_not_allowed",
          "The request method is not allowed for this route.",
          { allow: allowed },
        );
        return;
      }
      const framing = validateHeaders(request, response, allowed);
      if (framing === null) return;

      try {
        if (path === GLOBAL_CODEX_ROUTES.health) {
          sendSerialized(response, 200, {
            contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
            status: "ready",
            serverTime: now(),
          });
          return;
        }
        if (path === GLOBAL_CODEX_ROUTES.workspace) {
          sendSerialized(response, 200, {
            contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
            planner: planner.readPlanner(),
          });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse((await readExactBody(request, framing.contentLength)).toString("utf8"));
        } catch {
          sendError(response, 400, "invalid_request", "The request body is not valid JSON.");
          return;
        }
        let result;
        if (path === GLOBAL_CODEX_ROUTES.previews) {
          if (!isGlobalCodexPreviewRequest(parsed)) {
            sendError(response, 400, "invalid_request", "The planner preview contract is invalid.");
            return;
          }
          result = planner.previewBatch({
            basePlannerVersion: parsed.basePlannerVersion,
            operations: parsed.operations,
          });
        } else {
          if (!isGlobalCodexBatchRequest(parsed)) {
            sendError(response, 400, "invalid_request", "The planner batch contract is invalid.");
            return;
          }
          result = planner.applyBatch({
            requestId: parsed.requestId,
            basePlannerVersion: parsed.basePlannerVersion,
            operations: parsed.operations,
          });
        }
        const status = result.decision.status === "accepted" || result.decision.status === "previewed"
          ? 200
          : result.decision.status === "version_conflict"
            ? 409
            : 422;
        sendSerialized(response, status, {
          contractVersion: GLOBAL_CODEX_CONTRACT_VERSION,
          decision: result.decision,
          planner: result.planner,
        });
      } catch (error) {
        mapApplicationError(response, error);
      }
    })();
  };
}
