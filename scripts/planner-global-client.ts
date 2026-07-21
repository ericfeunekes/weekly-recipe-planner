import { request as requestHttp } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GLOBAL_CODEX_REQUEST_MAX_BYTES,
  GLOBAL_CODEX_RESPONSE_MAX_BYTES,
  GLOBAL_CODEX_ROUTES,
  GLOBAL_CODEX_SOCKET_PATH,
  isGlobalCodexBatchRequest,
  isGlobalCodexPreviewRequest,
  isGlobalCodexResponse,
  type GlobalCodexBatchRequest,
  type GlobalCodexPreviewRequest,
  type GlobalCodexResponse,
} from "../lib/global-codex-contract.ts";

type Command = "health" | "workspace" | "apply" | "preview";

class ClientError extends Error {
  readonly kind: "input" | "transport" | "protocol";

  constructor(kind: ClientError["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClientError";
    this.kind = kind;
  }
}

function readStdinBounded(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > GLOBAL_CODEX_REQUEST_MAX_BYTES) {
        reject(new ClientError("input", "Planner batch input exceeds 163840 bytes."));
        process.stdin.pause();
        return;
      }
      chunks.push(bytes);
    });
    process.stdin.once("error", (error) => reject(new ClientError("input", "Could not read planner batch input.", { cause: error })));
    process.stdin.once("end", () => resolve(Buffer.concat(chunks, size)));
    process.stdin.resume();
  });
}

function routeFor(command: Command): string {
  return command === "health"
    ? GLOBAL_CODEX_ROUTES.health
    : command === "workspace"
      ? GLOBAL_CODEX_ROUTES.workspace
      : command === "preview"
        ? GLOBAL_CODEX_ROUTES.previews
        : GLOBAL_CODEX_ROUTES.batches;
}

function validateCommandResponse(command: Command, response: GlobalCodexResponse): boolean {
  if ("error" in response) return true;
  if (command === "health") return "status" in response;
  if (command === "workspace") return "planner" in response && !("decision" in response);
  if (!("decision" in response)) return false;
  if (command === "preview") {
    return response.decision.status === "previewed" ||
      response.decision.status === "version_conflict" ||
      response.decision.status === "domain_rejected";
  }
  return response.decision.status === "accepted" ||
    response.decision.status === "version_conflict" ||
    response.decision.status === "domain_rejected";
}

function expectedStatus(response: GlobalCodexResponse): number {
  if ("error" in response) {
    switch (response.error.code) {
      case "not_found": return 404;
      case "method_not_allowed": return 405;
      case "payload_too_large": return 413;
      case "unsupported_media_type": return 415;
      case "version_conflict":
      case "request_id_reuse": return 409;
      case "planner_unavailable":
      case "internal_error": return 503;
      default: return 400;
    }
  }
  if ("decision" in response) {
    return response.decision.status === "accepted" || response.decision.status === "previewed"
      ? 200
      : response.decision.status === "version_conflict"
        ? 409
        : 422;
  }
  return 200;
}

function invokeAtSocket(
  command: Command,
  batch: GlobalCodexBatchRequest | GlobalCodexPreviewRequest | null,
  socketPath: string,
): Promise<GlobalCodexResponse> {
  return new Promise((resolve, reject) => {
    const body = batch === null ? null : Buffer.from(JSON.stringify(batch));
    const request = requestHttp({
      socketPath,
      method: body === null ? "GET" : "POST",
      path: routeFor(command),
      headers: body === null
        ? { Host: "localhost", Connection: "close" }
        : {
            Host: "localhost",
            Connection: "close",
            "Content-Type": "application/json",
            "Content-Length": String(body.length),
          },
    }, (response) => {
      const declaredLength = response.headers["content-length"];
      if (response.headers["content-type"] !== "application/json" ||
          typeof declaredLength !== "string" || !/^(0|[1-9][0-9]*)$/u.test(declaredLength)) {
        const error = new ClientError("protocol", "Global Codex returned invalid response framing.");
        reject(error);
        response.destroy(error);
        return;
      }
      const expectedLength = Number(declaredLength);
      if (!Number.isSafeInteger(expectedLength) || expectedLength > GLOBAL_CODEX_RESPONSE_MAX_BYTES) {
        const error = new ClientError("protocol", "Global Codex response exceeds 67108864 bytes.");
        reject(error);
        response.destroy(error);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > GLOBAL_CODEX_RESPONSE_MAX_BYTES) {
          response.destroy(new ClientError("protocol", "Global Codex response exceeds 67108864 bytes."));
          return;
        }
        chunks.push(bytes);
      });
      response.once("error", (error) => {
        reject(error instanceof ClientError ? error : new ClientError("protocol", "Could not read the Global Codex response.", { cause: error }));
      });
      response.once("end", () => {
        if (size !== expectedLength) {
          reject(new ClientError("protocol", "Global Codex response length did not match its framing."));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        } catch (error) {
          reject(new ClientError("protocol", "Global Codex returned invalid JSON.", { cause: error }));
          return;
        }
        if (!isGlobalCodexResponse(parsed) || !validateCommandResponse(command, parsed) ||
            response.statusCode !== expectedStatus(parsed)) {
          reject(new ClientError("protocol", "Global Codex returned an invalid response contract."));
          return;
        }
        resolve(parsed);
      });
    });
    request.once("error", (error) => {
      reject(error instanceof ClientError
        ? error
        : new ClientError(
            "transport",
            "Global Codex transport failed; retry only with the identical request UUID and payload.",
            { cause: error },
          ));
    });
    request.end(body ?? undefined);
  });
}

type HostOnlyGlobalCodexClient = Readonly<{
  invoke(
    command: Command,
    batch: GlobalCodexBatchRequest | GlobalCodexPreviewRequest | null,
  ): Promise<GlobalCodexResponse>;
}>;

/** In-memory QA seam. The production CLI below always uses GLOBAL_CODEX_SOCKET_PATH. */
export function createGlobalCodexClientForHostTesting(
  socketPath: string,
): HostOnlyGlobalCodexClient {
  if (!isAbsolute(socketPath) || socketPath.includes("\u0000")) {
    throw new TypeError("The host-only Global Codex socket path must be absolute.");
  }
  return Object.freeze({
    invoke: (command, batch) => invokeAtSocket(command, batch, socketPath),
  });
}

function invoke(command: Command, batch: GlobalCodexBatchRequest | GlobalCodexPreviewRequest | null) {
  return invokeAtSocket(command, batch, GLOBAL_CODEX_SOCKET_PATH);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if ((command !== "health" && command !== "workspace" && command !== "apply" && command !== "preview") || rest.length !== 0) {
    throw new ClientError("input", "Usage: planner-global-client <health|workspace|apply|preview>");
  }

  let batch: GlobalCodexBatchRequest | GlobalCodexPreviewRequest | null = null;
  if (command === "apply" || command === "preview") {
    const input = await readStdinBounded();
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.toString("utf8"));
    } catch (error) {
      throw new ClientError("input", "Planner batch stdin is not valid JSON.", { cause: error });
    }
    if (command === "apply") {
      if (!isGlobalCodexBatchRequest(parsed)) {
        throw new ClientError("input", "Planner batch stdin does not match contract version 1.");
      }
      batch = parsed;
    } else {
      if (!isGlobalCodexPreviewRequest(parsed)) {
        throw new ClientError("input", "Planner preview stdin does not match contract version 1.");
      }
      batch = parsed;
    }
  }

  const response = await invoke(command, batch);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const isEntrypoint = typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  void main().catch((error: unknown) => {
    const clientError = error instanceof ClientError
      ? error
      : new ClientError("protocol", "The Global Codex client failed.", { cause: error });
    process.stderr.write(`${clientError.message}\n`);
    process.exitCode = clientError.kind === "input" ? 1 : clientError.kind === "transport" ? 2 : 3;
  });
}
