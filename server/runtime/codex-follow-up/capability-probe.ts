import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  PLANNER_DYNAMIC_TOOL_NAMESPACE,
  isPlannerApplyArguments,
  isPlannerPreviewArguments,
  isPlannerReadArguments,
} from "../../../lib/planner-tool-contract.ts";
import {
  buildCodexFollowUpChildEnvironment,
  type ValidatedCodexFollowUpDeployment,
} from "./deployment.ts";
import {
  CODEX_FOLLOW_UP_FORBIDDEN_CAPABILITY_CLASSES,
  CODEX_FOLLOW_UP_RESEARCH_WEB_SEARCH_MODE,
  CODEX_FOLLOW_UP_RPC_POLICY,
  CODEX_FOLLOW_UP_TOOL_MANIFESTS,
  type CodexCapabilityEvidence,
  type CodexDeploymentReadbackEvidence,
} from "./compatibility.ts";
import {
  CODEX_APP_SERVER_ARGUMENTS,
  spawnAcceptedCodexProcess,
  type CodexExecutableIdentity,
} from "./launcher.ts";
import {
  CODEX_FOLLOW_UP_RESOURCE_POLICY,
  inventoryBoundedTree,
  sha256BoundedFile,
} from "./resource-policy.ts";

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;

type ProbeOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
};

type JsonRpcMessage = {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
};

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type MessageWaiter = {
  readonly predicate: (message: JsonRpcMessage) => boolean;
  readonly resolve: (message: JsonRpcMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

function rejectedServerRequestResponse(method: string) {
  if (method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval") {
    return { result: { decision: "decline" } } as const;
  }
  if (method === "mcpServer/elicitation/request") {
    return { result: { action: "decline", content: null, _meta: null } } as const;
  }
  if (CODEX_FOLLOW_UP_RPC_POLICY.rejectedServerRequests.includes(
    method as (typeof CODEX_FOLLOW_UP_RPC_POLICY.rejectedServerRequests)[number],
  )) {
    return {
      error: {
        code: -32001,
        message: `The planner does not permit ${method}.`,
      },
    } as const;
  }
  return null;
}

export class CodexCapabilityProbeError extends Error {
  readonly code:
    | "PROBE_PROTOCOL"
    | "PROBE_CAPABILITY"
    | "PROBE_TIMEOUT"
    | "READBACK_PROVENANCE";

  constructor(code: CodexCapabilityProbeError["code"], message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CodexCapabilityProbeError";
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringProperty(value: unknown, key: string) {
  if (!isObject(value)) return null;
  return typeof value[key] === "string" ? value[key] : null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 200
  ) || (
    typeof value === "number" &&
    Number.isSafeInteger(value)
  );
}

function arrayProperty(value: unknown, key: string) {
  if (!isObject(value)) return [];
  return Array.isArray(value[key]) ? value[key] : [];
}

function requiredArrayProperty(
  value: unknown,
  key: string,
  label: string,
  code: "PROBE_CAPABILITY" | "READBACK_PROVENANCE" = "READBACK_PROVENANCE",
) {
  if (!isObject(value) || !Array.isArray(value[key])) {
    throw new CodexCapabilityProbeError(code, `${label} omitted ${key}.`);
  }
  return value[key];
}

function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalText(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJsonObject(value: unknown): JsonObject | null {
  if (isObject(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasExactProviderFunctionCall(
  input: readonly unknown[],
  callId: string,
  name: string,
  argumentsValue: JsonObject,
) {
  return input.some((item) =>
    isObject(item) &&
    item.type === "function_call" &&
    item.call_id === callId &&
    item.name === name &&
    canonicalText(parseJsonObject(item.arguments)) === canonicalText(argumentsValue));
}

function hasExactProviderFunctionOutput(
  input: readonly unknown[],
  callId: string,
  outputValue: JsonObject,
) {
  return input.some((item) =>
    isObject(item) &&
    item.type === "function_call_output" &&
    item.call_id === callId &&
    canonicalText(parseJsonObject(item.output)) === canonicalText(outputValue));
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(
      new CodexCapabilityProbeError("PROBE_TIMEOUT", `${message} was aborted.`),
    ));
    const timer = setTimeout(() => finish(() => reject(
      new CodexCapabilityProbeError("PROBE_TIMEOUT", message),
    )), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

class JsonlRpcClient {
  readonly child: ChildProcess;
  readonly allowedRequests: ReadonlySet<string>;
  readonly allowedServerRequests: ReadonlySet<string>;
  readonly observedClientRequests: string[] = [];
  readonly observedServerRequests: string[] = [];
  readonly unexpectedServerRequests: string[] = [];

  #nextId = 1;
  #pending = new Map<JsonRpcId, PendingRequest>();
  #messages: JsonRpcMessage[] = [];
  #waiters: MessageWaiter[] = [];
  #closed = false;
  #closing = false;
  #childClosed = false;
  #failed = false;
  #failure: Error | null = null;
  #stdoutBuffer = Buffer.alloc(0);
  #stdoutBytes = 0;
  #frameCount = 0;
  #stderrTail = Buffer.alloc(0);
  #signal: AbortSignal | null;
  #onAbort: (() => void) | null = null;

  constructor(
    child: ChildProcess,
    allowedRequests: ReadonlySet<string>,
    allowedServerRequests: ReadonlySet<string>,
    signal?: AbortSignal,
  ) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Codex app-server must expose piped stdin, stdout, and stderr.",
      );
    }
    this.child = child;
    this.allowedRequests = allowedRequests;
    this.allowedServerRequests = allowedServerRequests;
    this.#signal = signal ?? null;

    child.stdout.on("data", (chunk: Buffer | string) => this.#handleStdoutChunk(chunk));
    child.stdout.on("error", (error) => this.#fail(
      new CodexCapabilityProbeError("PROBE_PROTOCOL", "Codex app-server stdout failed.", error),
    ));
    child.stderr.on("data", (chunk: Buffer | string) => this.#handleStderrChunk(chunk));
    child.stderr.on("error", (error) => this.#fail(
      new CodexCapabilityProbeError("PROBE_PROTOCOL", "Codex app-server stderr failed.", error),
    ));
    child.once("error", (error) => {
      const aborted = error.name === "AbortError" ||
        ("code" in error && error.code === "ABORT_ERR");
      this.#fail(new CodexCapabilityProbeError(
        aborted ? "PROBE_TIMEOUT" : "PROBE_PROTOCOL",
        aborted
          ? "Codex capability observation was aborted."
          : "Codex app-server failed.",
        error,
      ));
    });
    child.once("close", (code, signal) => {
      this.#childClosed = true;
      if (this.#closed || this.#failed || this.#closing) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      const stderr = this.#stderrTail.toString("utf8").replace(/\s+/g, " ").trim();
      this.#fail(new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        `Codex app-server exited with ${detail}${stderr ? `: ${stderr}` : "."}`,
      ));
    });
    if (this.#signal) {
      this.#onAbort = () => this.#fail(new CodexCapabilityProbeError(
        "PROBE_TIMEOUT",
        "Codex capability observation was aborted.",
      ));
      if (this.#signal.aborted) this.#onAbort();
      else this.#signal.addEventListener("abort", this.#onAbort, { once: true });
    }
  }

  request(method: string, params: unknown, timeoutMs = 15_000) {
    if (!this.allowedRequests.has(method)) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        `Outbound app-server method ${method} is outside the fixed allowlist.`,
      );
    }
    const id = this.#nextId++;
    this.observedClientRequests.push(method);
    this.#write({ id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexCapabilityProbeError(
          "PROBE_TIMEOUT",
          `Timed out waiting for ${method}.`,
        ));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
    });
  }

  notify(method: string, params: unknown) {
    if (!CODEX_FOLLOW_UP_RPC_POLICY.clientNotifications.includes(method)) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        `Outbound app-server notification ${method} is outside the fixed allowlist.`,
      );
    }
    this.#write({ method, params });
  }

  respond(request: JsonRpcMessage, result: unknown) {
    if (request.id === undefined) {
      throw new CodexCapabilityProbeError("PROBE_PROTOCOL", "Cannot respond without a JSON-RPC id.");
    }
    this.#write({ id: request.id, result });
  }

  waitFor(
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs = 15_000,
    label = "an app-server event",
  ) {
    if (this.#failure) return Promise.reject(this.#failure);
    const index = this.#messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.#messages.splice(index, 1)[0]);
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
        reject(new CodexCapabilityProbeError(
          "PROBE_TIMEOUT",
          `Timed out waiting for ${label}.`,
        ));
      }, timeoutMs);
      timer.unref?.();
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async close() {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    try {
      const closed = this.#childClosed
        ? Promise.resolve()
        : new Promise<void>((resolve) => this.child.once("close", () => resolve()));
      this.child.stdin?.end();
      if (this.#childClosed) return;
      try {
        await withTimeout(closed, 2_000, "Codex app-server did not close cleanly.");
      } catch {
        this.child.kill("SIGTERM");
        try {
          await withTimeout(closed, 2_000, "Codex app-server did not terminate.");
        } catch {
          this.child.kill("SIGKILL");
          await withTimeout(closed, 2_000, "Codex app-server survived SIGKILL.");
        }
      }
    } finally {
      this.#detachAbort();
      this.#closed = true;
      this.#closing = false;
    }
  }

  assertHealthy() {
    if (this.#failure) throw this.#failure;
  }

  #write(message: JsonRpcMessage) {
    if (this.#failure) throw this.#failure;
    if (this.#closed || this.#closing || !this.child.stdin?.writable) {
      throw new CodexCapabilityProbeError("PROBE_PROTOCOL", "Codex app-server input is closed.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleStdoutChunk(chunk: Buffer | string) {
    if (this.#closed || this.#failed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#stdoutBytes += incoming.byteLength;
    if (this.#stdoutBytes > CODEX_FOLLOW_UP_RESOURCE_POLICY.rpcIngress.maxTotalBytes) {
      this.#abortProtocol(new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Codex app-server exceeded its aggregate stdout byte budget.",
      ));
      return;
    }
    let buffered = Buffer.concat([this.#stdoutBuffer, incoming]);
    let newline = buffered.indexOf(0x0a);
    while (newline >= 0) {
      const frame = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (frame.byteLength > CODEX_FOLLOW_UP_RESOURCE_POLICY.rpcIngress.maxFrameBytes) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server emitted an oversized JSONL frame.",
        ));
        return;
      }
      this.#frameCount += 1;
      if (this.#frameCount > CODEX_FOLLOW_UP_RESOURCE_POLICY.rpcIngress.maxFrames) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server exceeded its JSONL frame-count budget.",
        ));
        return;
      }
      const content = frame.byteLength > 0 && frame[frame.byteLength - 1] === 0x0d
        ? frame.subarray(0, frame.byteLength - 1)
        : frame;
      try {
        this.#handleLine(content.toString("utf8"));
      } catch (error) {
        this.#abortProtocol(error instanceof Error
          ? error
          : new CodexCapabilityProbeError(
              "PROBE_PROTOCOL",
              "Codex app-server frame handling failed.",
            ));
      }
      if (this.#failed) return;
      newline = buffered.indexOf(0x0a);
    }
    if (buffered.byteLength > CODEX_FOLLOW_UP_RESOURCE_POLICY.rpcIngress.maxFrameBytes) {
      this.#abortProtocol(new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Codex app-server emitted an oversized unterminated JSONL frame.",
      ));
      return;
    }
    this.#stdoutBuffer = Buffer.from(buffered);
  }

  #handleStderrChunk(chunk: Buffer | string) {
    if (this.#closed || this.#failed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = Buffer.concat([this.#stderrTail, incoming]);
    const limit = CODEX_FOLLOW_UP_RESOURCE_POLICY.rpcIngress.maxStderrBytes;
    this.#stderrTail = combined.byteLength > limit
      ? Buffer.from(combined.subarray(combined.byteLength - limit))
      : combined;
  }

  #handleLine(line: string) {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.#fail(new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Codex app-server emitted invalid JSONL.",
        error,
      ));
      return;
    }
    if (!isObject(message)) {
      this.#fail(new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Codex app-server emitted a non-object JSON-RPC frame.",
      ));
      return;
    }

    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    if (hasId && !isJsonRpcId(message.id)) {
      this.#abortProtocol(new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Codex app-server emitted a malformed JSON-RPC id.",
      ));
      return;
    }
    if (
      hasMethod &&
      (
        typeof message.method !== "string" ||
        message.method.length === 0 ||
        Buffer.byteLength(message.method, "utf8") > 200
      )
    ) {
      this.#abortProtocol(new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Codex app-server emitted a malformed JSON-RPC method.",
      ));
      return;
    }
    const rpcId = hasId ? message.id as JsonRpcId : null;
    const rpcMethod = hasMethod ? message.method as string : null;

    if (hasId && !hasMethod) {
      if (Object.hasOwn(message, "params")) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server returned a malformed JSON-RPC response envelope.",
        ));
        return;
      }
      const pending = this.#pending.get(rpcId!);
      if (!pending) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server returned an unknown JSON-RPC response id.",
        ));
        return;
      }
      const hasResult = Object.hasOwn(message, "result");
      const hasError = Object.hasOwn(message, "error");
      if (hasResult === hasError) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          `${pending.method} returned a malformed JSON-RPC response envelope.`,
        ));
        return;
      }
      if (hasError) {
        if (
          !isObject(message.error) ||
          typeof message.error.code !== "number" ||
          typeof message.error.message !== "string"
        ) {
          this.#abortProtocol(new CodexCapabilityProbeError(
            "PROBE_PROTOCOL",
            `${pending.method} returned a malformed JSON-RPC error envelope.`,
          ));
          return;
        }
      }
      this.#pending.delete(rpcId!);
      clearTimeout(pending.timer);
      if (hasError && message.error) {
        pending.reject(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          `${pending.method} failed: ${message.error.message}`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (hasId && hasMethod) {
      if (this.#closing) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server emitted a server request during shutdown.",
        ));
        return;
      }
      if (
        Object.hasOwn(message, "result") ||
        Object.hasOwn(message, "error") ||
        !Object.hasOwn(message, "params")
      ) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server emitted a malformed JSON-RPC server request.",
        ));
        return;
      }
      if (this.observedServerRequests.length >= CODEX_FOLLOW_UP_RESOURCE_POLICY.rpcIngress.maxObservedMethods) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server exceeded its server-request observation budget.",
        ));
        return;
      }
      this.observedServerRequests.push(rpcMethod!);
      if (!this.allowedServerRequests.has(rpcMethod!)) {
        if (this.unexpectedServerRequests.length >= CODEX_FOLLOW_UP_RESOURCE_POLICY.rpcIngress.maxObservedMethods) {
          this.#abortProtocol(new CodexCapabilityProbeError(
            "PROBE_PROTOCOL",
            "Codex app-server exceeded its unexpected-request observation budget.",
          ));
          return;
        }
        this.unexpectedServerRequests.push(rpcMethod!);
        const rejected = rejectedServerRequestResponse(rpcMethod!);
        this.#write(rejected
          ? { id: rpcId!, ...rejected }
          : {
              id: rpcId!,
              error: { code: -32601, message: `Unsupported server request ${rpcMethod}.` },
            });
        return;
      }
      this.#pushMessage(message);
      return;
    }
    if (!hasId && hasMethod) {
      if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server emitted a malformed JSON-RPC notification.",
        ));
        return;
      }
      if (message.method === "error") {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server emitted a terminal error notification.",
        ));
        return;
      }
      if (CODEX_FOLLOW_UP_RPC_POLICY.ignoredNotifications.includes(
        message.method as (typeof CODEX_FOLLOW_UP_RPC_POLICY.ignoredNotifications)[number],
      )) return;
      if (!CODEX_FOLLOW_UP_RPC_POLICY.consumedNotifications.includes(
        message.method as (typeof CODEX_FOLLOW_UP_RPC_POLICY.consumedNotifications)[number],
      )) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          `Codex app-server emitted an undeclared notification ${message.method}.`,
        ));
        return;
      }
      this.#pushMessage(message);
      return;
    }
    this.#abortProtocol(new CodexCapabilityProbeError(
      "PROBE_PROTOCOL",
      "Codex app-server emitted an unclassified JSON-RPC frame.",
    ));
  }

  #pushMessage(message: JsonRpcMessage) {
    const index = this.#waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) {
      if (this.#messages.length >= CODEX_FOLLOW_UP_RESOURCE_POLICY.rpcIngress.maxQueuedMessages) {
        this.#abortProtocol(new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Codex app-server exceeded its queued-notification budget.",
        ));
        return;
      }
      this.#messages.push(message);
      return;
    }
    const [waiter] = this.#waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  #fail(error: Error) {
    if (this.#failed) return;
    this.#failed = true;
    this.#detachAbort();
    this.#failure = error;
    this.#stdoutBuffer = Buffer.alloc(0);
    this.#messages.length = 0;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #detachAbort() {
    if (this.#signal && this.#onAbort) {
      this.#signal.removeEventListener("abort", this.#onAbort);
    }
    this.#onAbort = null;
    this.#signal = null;
  }

  #abortProtocol(error: Error) {
    if (this.#closed || this.#failed) return;
    this.#fail(error);
    this.child.stdout?.pause();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }
}

function sse(events: readonly JsonObject[]) {
  return Buffer.from(events.map((event) =>
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
  ).join(""));
}

function responseCreated(responseId: string) {
  return { type: "response.created", response: { id: responseId } };
}

function responseCompleted(responseId: string) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function assistantMessage(responseId: string, messageId: string, text: string) {
  return sse([
    responseCreated(responseId),
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: messageId,
        content: [{ type: "output_text", text }],
      },
    },
    responseCompleted(responseId),
  ]);
}

function dynamicFunctionCall(
  responseId: string,
  callId: string,
  name: string,
  argumentsValue: JsonObject,
) {
  return sse([
    responseCreated(responseId),
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: callId,
        namespace: "planner",
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    },
    responseCompleted(responseId),
  ]);
}

function ordinaryFunctionCall(
  responseId: string,
  callId: string,
  name: string,
  argumentsValue: JsonObject,
) {
  return sse([
    responseCreated(responseId),
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    },
    responseCompleted(responseId),
  ]);
}

const PLANNER_PROBE_OPERATION = Object.freeze({
  command: Object.freeze({
    type: "captureWeekLesson",
    weekId: "2000-01-03",
    weekLesson: "Compatibility probe",
  }),
});
const PLANNER_PROBE_READ_ARGUMENTS = Object.freeze({
  query: Object.freeze({ kind: "workspace" }),
});
const PLANNER_PROBE_PREVIEW_ARGUMENTS = Object.freeze({
  basePlannerVersion: 0,
  operations: Object.freeze([PLANNER_PROBE_OPERATION]),
});
const PLANNER_PROBE_APPLY_ARGUMENTS = Object.freeze({
  basePlannerVersion: 0,
  operations: Object.freeze([PLANNER_PROBE_OPERATION]),
  readback: Object.freeze({ kind: "workspace" }),
});
const PLANNER_PROBE_PREVIEW_RESULT_TEXT = JSON.stringify({
  schemaVersion: 1,
  ok: true,
  callId: "call-A",
  plannerVersion: 0,
  syncRevision: 0,
  serverTime: 0,
  data: {
    status: "previewed",
    outcomes: [{
      operationIndex: 0,
      summary: "Compatibility probe preview",
      target: "2000-01-03",
      changes: ["Validated one disposable operation."],
    }],
  },
});
const PLANNER_PROBE_READ_RESULT_TEXT = JSON.stringify({
  schemaVersion: 1,
  ok: true,
  callId: "call-read",
  plannerVersion: 0,
  syncRevision: 0,
  serverTime: 0,
  data: { kind: "workspace", activeWeekId: null, weeks: [] },
});
const PLANNER_PROBE_APPLY_RESULT_TEXT = JSON.stringify({
  schemaVersion: 1,
  ok: true,
  callId: "call-B",
  plannerVersion: 1,
  syncRevision: 1,
  serverTime: 0,
  data: {
    status: "accepted",
    eventId: "compatibility-probe-event",
    readback: { kind: "workspace", activeWeekId: null, weeks: [] },
  },
});

type ProviderIngressState = {
  requests: number;
  totalBytes: number;
  failure: CodexCapabilityProbeError | null;
};

async function readJsonBody(
  request: import("node:http").IncomingMessage,
  ingress: ProviderIngressState,
) {
  ingress.requests += 1;
  if (ingress.requests > CODEX_FOLLOW_UP_RESOURCE_POLICY.providerIngress.maxRequests) {
    throw new CodexCapabilityProbeError(
      "PROBE_PROTOCOL",
      "Local provider exceeded its request-count budget.",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    ingress.totalBytes += buffer.length;
    if (size > CODEX_FOLLOW_UP_RESOURCE_POLICY.providerIngress.maxRequestBytes) {
      throw new CodexCapabilityProbeError("PROBE_PROTOCOL", "Local provider request was too large.");
    }
    if (ingress.totalBytes > CODEX_FOLLOW_UP_RESOURCE_POLICY.providerIngress.maxTotalBytes) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Local provider exceeded its aggregate request-byte budget.",
      );
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function startLocalResponsesServer() {
  const requests: unknown[] = [];
  let dependentPlannerResultObserved = false;
  let workerRequestObserved = false;
  let workerWaitCallObserved = false;
  let workerWaitResultObserved = false;
  let workerResultObserved = false;
  let userInputRoundTripObserved = false;
  let plannerReadObserved = false;
  let resolveProtocolFailure: (error: CodexCapabilityProbeError) => void = () => undefined;
  const protocolFailure = new Promise<CodexCapabilityProbeError>((resolve) => {
    resolveProtocolFailure = resolve;
  });
  const ingress: ProviderIngressState = { requests: 0, totalBytes: 0, failure: null };
  const server = createServer(async (request, response) => {
    try {
      const body = await readJsonBody(request, ingress);
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        throw new CodexCapabilityProbeError(
          "PROBE_PROTOCOL",
          "Local provider received a request outside its exact route.",
        );
      }
      requests.push(body);
      const input = arrayProperty(body, "input");
      const serializedInput = canonicalText(input);
      const rootRequest = serializedInput.includes("NATIVE_THREAD_CAPABILITY_PROBE");
      const workerRequest = !rootRequest && serializedInput.includes("WORKER_CONTEXT_PROBE");
      let payload: Buffer;
      if (workerRequest) {
        workerRequestObserved = true;
        payload = assistantMessage(
          "response-worker",
          "message-worker",
          "worker-research-report-complete",
        );
      } else if (rootRequest) {
        if (serializedInput.includes("call-B") && serializedInput.includes("accepted")) {
          payload = assistantMessage("response-root-4", "message-root", "native-thread-complete");
        } else if (serializedInput.includes("call-A") && serializedInput.includes("previewed")) {
          dependentPlannerResultObserved = true;
          payload = dynamicFunctionCall(
            "response-root-3",
            "call-B",
            "apply",
            PLANNER_PROBE_APPLY_ARGUMENTS,
          );
        } else if (serializedInput.includes("call-read") && serializedInput.includes("workspace")) {
          plannerReadObserved = true;
          payload = dynamicFunctionCall(
            "response-root-readback",
            "call-A",
            "preview",
            PLANNER_PROBE_PREVIEW_ARGUMENTS,
          );
        } else if (serializedInput.includes("question-capability") &&
                   serializedInput.includes("Continue")) {
          userInputRoundTripObserved = true;
          payload = dynamicFunctionCall(
            "response-root-read",
            "call-read",
            "read",
            PLANNER_PROBE_READ_ARGUMENTS,
          );
        } else if (serializedInput.includes("root-wait")) {
          workerWaitCallObserved = hasExactProviderFunctionCall(
            input,
            "root-wait",
            "wait_agent",
            {},
          );
          workerWaitResultObserved = hasExactProviderFunctionOutput(
            input,
            "root-wait",
            { message: "Wait completed.", timed_out: false },
          );
          workerResultObserved = serializedInput.includes("FINAL_ANSWER") &&
            serializedInput.includes("worker-research-report-complete");
          payload = ordinaryFunctionCall(
            "response-root-input",
            "root-input",
            "request_user_input",
            {
              questions: [{
                header: "Probe",
                id: "question-capability",
                question: "Continue the compatibility probe?",
                options: [{
                  label: "Continue",
                  description: "Continue the deterministic probe.",
                }],
              }],
            },
          );
        } else if (serializedInput.includes("root-spawn")) {
          payload = ordinaryFunctionCall(
            "response-root-wait",
            "root-wait",
            "wait_agent",
            {},
          );
        } else {
          payload = ordinaryFunctionCall(
            "response-root-1",
            "root-spawn",
            "spawn_agent",
            {
              task_name: "capability_worker",
              message: "WORKER_CONTEXT_PROBE: finish without calling tools",
              fork_turns: "none",
            },
          );
        }
      } else {
        payload = assistantMessage("response-unclassified", "message-unclassified", "unclassified");
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-length": payload.length,
        connection: "close",
      });
      response.end(payload);
    } catch (error) {
      ingress.failure = error instanceof CodexCapabilityProbeError
        ? error
        : new CodexCapabilityProbeError(
            "PROBE_PROTOCOL",
            "Local provider request failed validation.",
            error,
          );
      resolveProtocolFailure(ingress.failure);
      response.writeHead(500, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "provider error" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new CodexCapabilityProbeError("PROBE_PROTOCOL", "Could not bind the local Responses server.");
  }
  return {
    server,
    requests,
    ingress,
    dependentPlannerResultObserved: () => dependentPlannerResultObserved,
    workerRequestObserved: () => workerRequestObserved,
    workerWaitCallObserved: () => workerWaitCallObserved,
    workerWaitResultObserved: () => workerWaitResultObserved,
    workerResultObserved: () => workerResultObserved,
    userInputRoundTripObserved: () => userInputRoundTripObserved,
    plannerReadObserved: () => plannerReadObserved,
    guard<T>(operation: Promise<T>) {
      return Promise.race([
        operation,
        protocolFailure.then((error) => Promise.reject(error)),
      ]);
    },
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const DISABLED_FEATURES = [
  "apps",
  "artifact",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_only",
  "computer_use",
  "current_time_reminder",
  "deferred_executor",
  "enable_fanout",
  "enable_mcp_apps",
  "goals",
  "image_generation",
  "imagegenext",
  "in_app_browser",
  "memories",
  "multi_agent",
  "network_proxy",
  "plugins",
  "remote_plugin",
  "request_permissions_tool",
  "shell_tool",
  "sleep_tool",
  "standalone_web_search",
  "token_budget",
  "tool_suggest",
  "unified_exec",
  "unified_exec_zsh_fork",
  "workspace_dependencies",
] as const;
const UNIFIED_CAPABILITY_MARKER_FILE = ".planner-unified-native-thread-v1";

function disposableProbeConfig(baseUrl: string) {
  const features = DISABLED_FEATURES.map((feature) => `${feature} = false`).join("\n");
  return `model = "planner-capability-probe"
model_provider = "planner_local_probe"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "live"
check_for_update_on_startup = false

[tools.experimental_request_user_input]
enabled = true

[features]
${features}
default_mode_request_user_input = true
multi_agent_v2 = true

[skills]
include_instructions = true

[skills.bundled]
enabled = false

[orchestrator.skills]
enabled = true

[orchestrator.mcp]
enabled = false

[model_providers.planner_local_probe]
name = "Planner local capability probe"
base_url = "${baseUrl}"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
requires_openai_auth = false
`;
}

function featureOverrides() {
  return {
    ...Object.fromEntries(DISABLED_FEATURES.map((feature) => [feature, false])),
    default_mode_request_user_input: true,
    multi_agent_v2: true,
  };
}

function commonProbeThread(appCwd: string) {
  return {
    approvalPolicy: "never",
    permissions: ":read-only",
    cwd: appCwd,
    ephemeral: true,
    environments: [],
    runtimeWorkspaceRoots: [],
    selectedCapabilityRoots: [],
    model: "planner-capability-probe",
    modelProvider: "planner_local_probe",
    baseInstructions: "This is a deterministic localhost capability probe.",
    developerInstructions: "Use only the capability explicitly provided for this probe.",
    config: {
      web_search: "live",
      features: featureOverrides(),
      tools: { experimental_request_user_input: { enabled: true } },
      mcp_servers: {},
      orchestrator: { skills: { enabled: true }, mcp: { enabled: false } },
      skills: { include_instructions: true, bundled: { enabled: false } },
    },
  };
}

function topLevelToolName(tool: unknown) {
  if (!isObject(tool)) return "<unknown>";
  if (tool.type === "namespace") return stringProperty(tool, "name") ?? "<unknown>";
  if (tool.type === "function") {
    const name = stringProperty(tool, "name") ?? "<unknown>";
    // The closed manifest and schema checks below classify ordinary function
    // tools by logical name while independently validating their exact
    // function/strict/closed-parameters transport shape.
    return name;
  }
  return stringProperty(tool, "type") ?? "<unknown>";
}

const PROVIDER_JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "integer",
  "object",
  "array",
  "null",
]);
const PROVIDER_SCHEMA_CHILD_KEYS = ["items", "anyOf", "oneOf", "allOf"] as const;
const PROVIDER_SCHEMA_COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;
const PROVIDER_SCHEMA_BYTE_BUDGET = 4_000;
const PROVIDER_SCHEMA_DEPTH_BUDGET = 3;

function providerSchemaTypes(schema: JsonObject) {
  const raw = schema.type;
  const candidates = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return candidates.filter((candidate): candidate is string =>
    typeof candidate === "string" && PROVIDER_JSON_SCHEMA_TYPES.has(candidate)
  );
}

function normalizeProviderSchema(value: unknown): unknown {
  if (typeof value === "boolean") return { type: "string" };
  if (!isObject(value)) return {};

  const normalized: JsonObject = {};
  if (typeof value.$ref === "string") normalized.$ref = value.$ref;
  if (typeof value.description === "string") normalized.description = value.description;
  if (typeof value.encrypted === "boolean") normalized.encrypted = value.encrypted;
  if (Array.isArray(value.enum)) normalized.enum = value.enum;
  else if (Object.hasOwn(value, "const")) normalized.enum = [value.const];

  if (isObject(value.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, child]) => [key, normalizeProviderSchema(child)]),
    );
  }
  if (Object.hasOwn(value, "items")) normalized.items = normalizeProviderSchema(value.items);
  if (Array.isArray(value.required)) normalized.required = value.required;
  if (typeof value.additionalProperties === "boolean") {
    normalized.additionalProperties = value.additionalProperties;
  } else if (Object.hasOwn(value, "additionalProperties")) {
    normalized.additionalProperties = normalizeProviderSchema(value.additionalProperties);
  }
  for (const key of PROVIDER_SCHEMA_COMPOSITION_KEYS) {
    if (Array.isArray(value[key])) {
      normalized[key] = value[key].map(normalizeProviderSchema);
    }
  }
  for (const key of ["$defs", "definitions"] as const) {
    if (isObject(value[key])) {
      normalized[key] = Object.fromEntries(
        Object.entries(value[key]).map(([name, child]) => [name, normalizeProviderSchema(child)]),
      );
    }
  }

  const types = providerSchemaTypes(value);
  if (types.length === 0 && !normalized.$ref &&
      !PROVIDER_SCHEMA_COMPOSITION_KEYS.some((key) => Object.hasOwn(normalized, key))) {
    if (Object.hasOwn(value, "properties") || Object.hasOwn(value, "required") ||
        Object.hasOwn(value, "additionalProperties")) {
      types.push("object");
    } else if (Object.hasOwn(value, "items") || Object.hasOwn(value, "prefixItems")) {
      types.push("array");
    } else if (Object.hasOwn(normalized, "enum") || Object.hasOwn(value, "format")) {
      types.push("string");
    } else if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]
      .some((key) => Object.hasOwn(value, key))) {
      types.push("number");
    } else {
      return {};
    }
  }
  if (types.length === 1) normalized.type = types[0];
  else if (types.length > 1) normalized.type = types;
  if (types.includes("object") && !Object.hasOwn(normalized, "properties")) {
    normalized.properties = {};
  }
  if (types.includes("array") && !Object.hasOwn(normalized, "items")) {
    normalized.items = { type: "string" };
  }
  return normalized;
}

function mapProviderSchemaChildren(
  value: unknown,
  transform: (child: unknown) => unknown,
  includeDefinitions: boolean,
) {
  if (!isObject(value)) return value;
  const mapped: JsonObject = { ...value };
  if (isObject(mapped.properties)) {
    mapped.properties = Object.fromEntries(
      Object.entries(mapped.properties).map(([key, child]) => [key, transform(child)]),
    );
  }
  for (const key of PROVIDER_SCHEMA_CHILD_KEYS) {
    if (Object.hasOwn(mapped, key)) mapped[key] = transform(mapped[key]);
  }
  if (isObject(mapped.additionalProperties)) {
    mapped.additionalProperties = transform(mapped.additionalProperties);
  }
  if (includeDefinitions) {
    for (const key of ["$defs", "definitions"] as const) {
      if (isObject(mapped[key])) {
        mapped[key] = Object.fromEntries(
          Object.entries(mapped[key]).map(([name, child]) => [name, transform(child)]),
        );
      }
    }
  }
  return mapped;
}

function stripProviderSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProviderSchemaDescriptions);
  if (!isObject(value)) return value;
  const mapped = mapProviderSchemaChildren(
    value,
    stripProviderSchemaDescriptions,
    true,
  ) as JsonObject;
  delete mapped.description;
  return mapped;
}

function dropProviderSchemaDefinitions(value: unknown): unknown {
  const rewriteReferences = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(rewriteReferences);
    if (!isObject(candidate)) return candidate;
    if (typeof candidate.$ref === "string" && /^#\/(?:\$defs|definitions)\//.test(candidate.$ref)) {
      return {};
    }
    return mapProviderSchemaChildren(candidate, rewriteReferences, false);
  };
  const mapped = rewriteReferences(value);
  if (!isObject(mapped)) return mapped;
  const withoutDefinitions: JsonObject = { ...mapped };
  delete withoutDefinitions.$defs;
  delete withoutDefinitions.definitions;
  return withoutDefinitions;
}

function collapseDeepProviderSchemas(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((child) => collapseDeepProviderSchemas(child, depth));
  if (!isObject(value)) return value;
  const complex = PROVIDER_SCHEMA_CHILD_KEYS.some((key) => Object.hasOwn(value, key)) ||
    Object.hasOwn(value, "properties") || Object.hasOwn(value, "additionalProperties") ||
    Object.hasOwn(value, "$ref");
  if (depth >= PROVIDER_SCHEMA_DEPTH_BUDGET && complex) return {};
  return mapProviderSchemaChildren(
    value,
    (child) => collapseDeepProviderSchemas(child, depth + 1),
    false,
  );
}

function pruneProviderSchemaCompositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneProviderSchemaCompositions);
  if (!isObject(value)) return value;
  if (PROVIDER_SCHEMA_COMPOSITION_KEYS.some((key) => Object.hasOwn(value, key))) return {};
  return mapProviderSchemaChildren(value, pruneProviderSchemaCompositions, false);
}

function normalizeProviderParameters(value: unknown) {
  let normalized = normalizeProviderSchema(value);
  for (const compact of [
    stripProviderSchemaDescriptions,
    dropProviderSchemaDefinitions,
    collapseDeepProviderSchemas,
    pruneProviderSchemaCompositions,
  ]) {
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") <= PROVIDER_SCHEMA_BYTE_BUDGET) break;
    normalized = compact(normalized);
  }
  return normalized;
}

function expectedProviderPlannerNamespace() {
  return Object.freeze({
    type: "namespace",
    name: PLANNER_DYNAMIC_TOOL_NAMESPACE.name,
    description: PLANNER_DYNAMIC_TOOL_NAMESPACE.description,
    tools: Object.freeze(PLANNER_DYNAMIC_TOOL_NAMESPACE.tools.map((tool) => Object.freeze({
      type: "function",
      name: tool.name,
      description: tool.description,
      strict: false,
      parameters: normalizeProviderParameters(tool.inputSchema),
    })).sort((left, right) => left.name.localeCompare(right.name))),
  });
}

function forbiddenToolFragment(tool: unknown) {
  const text = JSON.stringify(tool).toLowerCase();
  const fragments = [
    "shell",
    "exec_command",
    "unified_exec",
    "apply_patch",
    "filesystem",
    "fs_",
    "view_image",
    "imagegen",
    "image_generation",
    "mcp",
    "plugin",
    "app/",
    "browser",
    "computer",
    "spawn_agents_on_csv",
  ];
  return fragments.find((fragment) => text.includes(fragment)) ?? null;
}

function assertHostedSearch(tools: readonly unknown[], context: string) {
  const hostedSearch = tools.find((tool) => topLevelToolName(tool) === "web_search");
  if (
    !isObject(hostedSearch) ||
    hostedSearch.type !== "web_search" ||
    hostedSearch.external_web_access !== true ||
    Object.hasOwn(hostedSearch, "index_gated_web_access") ||
    Object.hasOwn(hostedSearch, "indexed_web_access")
  ) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      `${context} did not expose the exact live hosted-search capability.`,
    );
  }
}

function assertSkillsNamespace(tools: readonly unknown[], context: string) {
  const namespace = tools.find((tool) =>
    isObject(tool) && tool.type === "namespace" && tool.name === "skills");
  const members = isObject(namespace) && Array.isArray(namespace.tools)
    ? namespace.tools
    : [];
  const names = members.map((member) =>
    isObject(member) && member.type === "function" ? stringProperty(member, "name") : null);
  if (
    canonicalText(names) !== canonicalText(CODEX_FOLLOW_UP_TOOL_MANIFESTS.skillsNamespace) ||
    members.some((member) =>
      !isObject(member) || member.strict !== false || !isObject(member.parameters) ||
      member.parameters.type !== "object" || member.parameters.additionalProperties !== false)
  ) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      `${context} did not expose the exact bounded skills namespace.`,
    );
  }
}

const REQUIRED_NATIVE_FUNCTIONS = Object.freeze([
  "update_plan",
  "request_user_input",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
]);

function assertNativeFunctions(tools: readonly unknown[], context: string) {
  for (const name of REQUIRED_NATIVE_FUNCTIONS) {
    const tool = tools.find((candidate) =>
      isObject(candidate) && candidate.type === "function" && candidate.name === name);
    if (!isObject(tool) || tool.strict !== false || !isObject(tool.parameters) ||
        tool.parameters.type !== "object" || tool.parameters.additionalProperties !== false) {
      throw new CodexCapabilityProbeError(
        "PROBE_CAPABILITY",
        `${context} exposed a malformed ${name} function tool.`,
      );
    }
  }
}

function assertPlannerNamespace(tools: readonly unknown[], context: string) {
  const plannerNamespace = tools.find((tool) =>
    isObject(tool) && tool.type === "namespace" && tool.name === "planner");
  if (canonicalText(plannerNamespace) !== canonicalText(expectedProviderPlannerNamespace())) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      `${context} planner namespace description or input schemas changed in provider transport.`,
    );
  }
}

export function evaluateObservedCapabilityRequests(
  requests: readonly unknown[],
  options: {
    readonly dependentResultObserved: boolean;
    readonly plannerReadObserved?: boolean;
    readonly workerWaitCallObserved?: boolean;
    readonly workerWaitResultObserved?: boolean;
    readonly workerResultObserved?: boolean;
    readonly userInputRoundTripObserved?: boolean;
    readonly unexpectedRpcMethods?: readonly string[];
    readonly probeRuntimeFiles?: readonly string[];
    readonly permissionProfileVerified?: boolean;
    readonly outboundPolicyRejected?: boolean;
  },
): CodexCapabilityEvidence {
  if (requests.length !== 8) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      `Expected exactly eight local provider calls; observed ${requests.length}.`,
    );
  }
  const nativeThread = requests.filter((request) =>
    canonicalText(isObject(request) ? request.input : null)
      .includes("NATIVE_THREAD_CAPABILITY_PROBE")
  );
  const workers = requests.filter((request) =>
    !canonicalText(isObject(request) ? request.input : null)
      .includes("NATIVE_THREAD_CAPABILITY_PROBE") &&
    canonicalText(isObject(request) ? request.input : null).includes("WORKER_CONTEXT_PROBE")
  );
  if (nativeThread.length !== 7 || workers.length !== 1) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      `Expected seven native-thread and one worker provider calls; observed ${nativeThread.length} and ${workers.length}.`,
    );
  }

  const expectedRoot = [...CODEX_FOLLOW_UP_TOOL_MANIFESTS.nativeThread];
  const expectedWorker = [...CODEX_FOLLOW_UP_TOOL_MANIFESTS.workerRequired];
  const nativeToolSets = nativeThread.map((request) => arrayProperty(request, "tools"));
  for (const [index, request] of nativeThread.entries()) {
    const tools = arrayProperty(request, "tools");
    const names = tools.map(topLevelToolName);
    if (canonicalText(names) !== canonicalText(expectedRoot)) {
      throw new CodexCapabilityProbeError(
        "PROBE_CAPABILITY",
        `Native thread tools changed on provider call ${index + 1}: ${JSON.stringify(names)}.`,
      );
    }
    assertHostedSearch(tools, "Native thread");
    assertNativeFunctions(tools, "Native thread");
    assertSkillsNamespace(tools, "Native thread");
    assertPlannerNamespace(tools, "Native thread");
    if (!isObject(request) || request.parallel_tool_calls !== false) {
      throw new CodexCapabilityProbeError(
        "PROBE_CAPABILITY",
        "Native-thread provider execution did not disable parallel tool calls.",
      );
    }
  }

  const workerTools = arrayProperty(workers[0], "tools");
  const workerNames = workerTools.map(topLevelToolName);
  if (canonicalText(workerNames) !== canonicalText(expectedWorker)) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      `Worker tools changed: ${JSON.stringify(workerNames)}.`,
    );
  }
  assertHostedSearch(workerTools, "Worker");
  assertNativeFunctions(workerTools, "Worker");
  assertSkillsNamespace(workerTools, "Worker");
  if (!isObject(workers[0]) || workers[0].parallel_tool_calls !== false) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "Worker provider execution did not disable parallel tool calls.",
    );
  }
  if (!options.permissionProfileVerified) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "The read-only permission profile was not verified.",
    );
  }
  if (!options.outboundPolicyRejected) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "The dangerous outbound RPC negative control was not verified.",
    );
  }

  const forbiddenHits: string[] = [];
  for (const [context, toolSets] of [["native", nativeToolSets], ["worker", [workerTools]]] as const) {
    for (const tools of toolSets) {
      for (const tool of tools) {
        const fragment = forbiddenToolFragment(tool);
        if (fragment) forbiddenHits.push(`${context}:${fragment}`);
      }
    }
  }
  if (forbiddenHits.length > 0) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      `Forbidden model-visible capability detected: ${forbiddenHits.join(", ")}.`,
    );
  }
  if (!options.dependentResultObserved) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "The second synthetic planner call did not consume the first host result.",
    );
  }
  if (!options.plannerReadObserved) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "The native thread did not consume an exact planner.read result.",
    );
  }
  if (!options.workerWaitCallObserved) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "The owning native thread did not issue the exact bounded wait_agent call.",
    );
  }
  if (!options.workerWaitResultObserved) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "The owning native thread did not receive the exact successful wait_agent result.",
    );
  }
  if (!options.workerResultObserved) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "The owning native thread did not receive the spawned worker report.",
    );
  }
  if (!options.userInputRoundTripObserved) {
    throw new CodexCapabilityProbeError(
      "PROBE_CAPABILITY",
      "The native request_user_input answer did not return to the owning thread.",
    );
  }
  const unexpectedRpcMethods = [...new Set(options.unexpectedRpcMethods ?? [])].sort();
  if (unexpectedRpcMethods.length > 0) {
    throw new CodexCapabilityProbeError(
      "PROBE_PROTOCOL",
      `Unexpected app-server methods: ${unexpectedRpcMethods.join(", ")}.`,
    );
  }
  return Object.freeze({
    researchWebSearchMode: CODEX_FOLLOW_UP_RESEARCH_WEB_SEARCH_MODE,
    researchTools: Object.freeze([...CODEX_FOLLOW_UP_TOOL_MANIFESTS.research]),
    plannerTools: Object.freeze([...CODEX_FOLLOW_UP_TOOL_MANIFESTS.planner]),
    workerTools: Object.freeze([...workerNames]),
    plannerNamespaceMembers: Object.freeze([
      ...CODEX_FOLLOW_UP_TOOL_MANIFESTS.plannerNamespace,
    ]),
    forbiddenHits: Object.freeze(forbiddenHits),
    unexpectedRpcMethods: Object.freeze(unexpectedRpcMethods),
    plannerReadObserved: true,
    workerWaitCallObserved: true,
    workerWaitResultObserved: true,
    workerResultObserved: true,
    userInputRoundTripObserved: true,
    dependentResultObserved: true,
    outboundPolicyRejected: true,
    approvalPolicy: "never",
    permissionProfile: ":read-only",
    effectiveSandbox: "read-only-network-disabled",
    probeRuntimeFiles: Object.freeze([...(options.probeRuntimeFiles ?? [])]),
  });
}

function resultThreadId(result: unknown) {
  const thread = isObject(result) && isObject(result.thread) ? result.thread : null;
  const id = thread ? stringProperty(thread, "id") : null;
  if (!id) throw new CodexCapabilityProbeError("PROBE_PROTOCOL", "thread/start omitted thread.id.");
  return id;
}

function resultTurnId(result: unknown) {
  const turn = isObject(result) && isObject(result.turn) ? result.turn : null;
  const id = turn ? stringProperty(turn, "id") : null;
  if (!id) throw new CodexCapabilityProbeError("PROBE_PROTOCOL", "turn/start omitted turn.id.");
  return id;
}

function turnInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function messageMethod(message: JsonRpcMessage, method: string) {
  return message.method === method;
}

function assertCompletedTurnNotification(
  message: JsonRpcMessage,
  expectedThreadId: string,
  expectedTurnId: string,
) {
  const params = isObject(message.params) ? message.params : null;
  const turn = params && isObject(params.turn) ? params.turn : null;
  if (
    message.method !== "turn/completed" ||
    stringProperty(params, "threadId") !== expectedThreadId ||
    stringProperty(turn, "id") !== expectedTurnId ||
    stringProperty(turn, "status") !== "completed"
  ) {
    throw new CodexCapabilityProbeError(
      "PROBE_PROTOCOL",
      "Codex app-server emitted a mismatched or unsuccessful terminal turn notification.",
    );
  }
}

async function inventoryRelativeFiles(root: string) {
  const inventory = await inventoryBoundedTree(
    root,
    CODEX_FOLLOW_UP_RESOURCE_POLICY.runtimeInventory,
    "Codex runtime inventory",
  );
  return inventory.files.map((file) => file.relativePath);
}

async function initializeClient(client: JsonlRpcClient, timeoutMs: number) {
  await client.request("initialize", {
    clientInfo: {
      name: "weekly-recipe-planner-compatibility",
      title: "Weekly Recipe Planner Compatibility",
      version: "1",
    },
    capabilities: { experimentalApi: true },
  }, timeoutMs);
  client.notify("initialized", {});
}

async function collectPaginated(
  client: JsonlRpcClient,
  method: "permissionProfile/list" | "mcpServerStatus/list" | "app/list",
  params: Record<string, unknown>,
  timeoutMs: number,
) {
  const failureCode = method === "permissionProfile/list"
    ? "PROBE_CAPABILITY"
    : "READBACK_PROVENANCE";
  const rows: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < CODEX_FOLLOW_UP_RESOURCE_POLICY.pagination.maxPages; page += 1) {
    const result = await client.request(method, { ...params, cursor }, timeoutMs);
    rows.push(...requiredArrayProperty(result, "data", method, failureCode));
    if (rows.length > CODEX_FOLLOW_UP_RESOURCE_POLICY.pagination.maxRows) {
      throw new CodexCapabilityProbeError(failureCode, `${method} exceeded its row budget.`);
    }
    if (!isObject(result) || result.nextCursor === undefined || result.nextCursor === null) {
      return rows;
    }
    if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0) {
      throw new CodexCapabilityProbeError(failureCode, `${method} returned a malformed cursor.`);
    }
    if (cursors.has(result.nextCursor)) {
      throw new CodexCapabilityProbeError(failureCode, `${method} repeated a pagination cursor.`);
    }
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new CodexCapabilityProbeError(failureCode, `${method} exceeded its page budget.`);
}

function assertReadOnlyPermissionProfiles(
  rows: readonly unknown[],
  code: "PROBE_CAPABILITY" | "READBACK_PROVENANCE" = "READBACK_PROVENANCE",
) {
  let matches = 0;
  for (const row of rows) {
    if (
      !isObject(row) ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      typeof row.allowed !== "boolean"
    ) {
      throw new CodexCapabilityProbeError(
        code,
        "permissionProfile/list returned a malformed profile.",
      );
    }
    if (row.id === ":read-only") {
      matches += 1;
      if (row.allowed !== true) {
        throw new CodexCapabilityProbeError(
          code,
          "The :read-only permission profile is disallowed.",
        );
      }
    }
  }
  if (matches !== 1) {
    throw new CodexCapabilityProbeError(
      code,
      "permissionProfile/list must expose exactly one allowed :read-only profile.",
    );
  }
}

function assertReadOnlyThread(
  result: unknown,
  expectedCwd: string,
  code: "PROBE_CAPABILITY" | "READBACK_PROVENANCE" = "READBACK_PROVENANCE",
) {
  const activeProfile = isObject(result) && isObject(result.activePermissionProfile)
    ? result.activePermissionProfile
    : null;
  const sandbox = isObject(result) && isObject(result.sandbox) ? result.sandbox : null;
  if (
    stringProperty(result, "cwd") !== expectedCwd ||
    stringProperty(result, "approvalPolicy") !== "never" ||
    stringProperty(activeProfile, "id") !== ":read-only" ||
    activeProfile?.extends !== null ||
    stringProperty(sandbox, "type") !== "readOnly" ||
    sandbox?.networkAccess !== false
  ) {
    throw new CodexCapabilityProbeError(
      code,
      "thread/start did not return the exact read-only, no-network deployment policy.",
    );
  }
  return resultThreadId(result);
}

export async function runDisposableCapabilityProbe(
  identity: CodexExecutableIdentity,
  deployment: ValidatedCodexFollowUpDeployment,
  options: ProbeOptions = {},
): Promise<CodexCapabilityEvidence> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const probeHome = await mkdtemp(join(deployment.runtimeDirectory, "probe-"));
  await chmod(probeHome, 0o700);
  let provider: Awaited<ReturnType<typeof startLocalResponsesServer>> | null = null;
  let client: JsonlRpcClient | null = null;
  try {
    provider = await startLocalResponsesServer();
    await writeFile(join(probeHome, "config.toml"), disposableProbeConfig(provider.baseUrl), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const childEnvironment = buildCodexFollowUpChildEnvironment(
      deployment,
      options.sourceEnvironment,
      { codexHome: probeHome },
    );
    const child = await spawnAcceptedCodexProcess(identity, CODEX_APP_SERVER_ARGUMENTS, {
      cwd: deployment.appCwd,
      env: childEnvironment,
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    client = new JsonlRpcClient(
      child,
      new Set(CODEX_FOLLOW_UP_RPC_POLICY.clientRequests),
      new Set(CODEX_FOLLOW_UP_RPC_POLICY.serverRequests),
      options.signal,
    );
    await initializeClient(client, timeoutMs);
    const permissionProfiles = await collectPaginated(
      client,
      "permissionProfile/list",
      { limit: 100 },
      timeoutMs,
    );
    assertReadOnlyPermissionProfiles(permissionProfiles, "PROBE_CAPABILITY");

    const nativeResult = await client.request("thread/start", {
      ...commonProbeThread(deployment.appCwd),
      dynamicTools: [PLANNER_DYNAMIC_TOOL_NAMESPACE],
    }, timeoutMs);
    const nativeThreadId = assertReadOnlyThread(nativeResult, deployment.appCwd, "PROBE_CAPABILITY");
    const nativeTurn = await provider.guard(client.request("turn/start", {
      threadId: nativeThreadId,
      input: turnInput(
        "NATIVE_THREAD_CAPABILITY_PROBE: spawn one worker, ask one question, then read, preview, and apply",
      ),
    }, timeoutMs));
    const nativeTurnId = resultTurnId(nativeTurn);

    const workerActivity = await provider.guard(client.waitFor((message) => {
      const params = isObject(message.params) ? message.params : null;
      const item = params && isObject(params.item) ? params.item : null;
      return message.method === "item/completed" &&
        stringProperty(params, "threadId") === nativeThreadId &&
        stringProperty(params, "turnId") === nativeTurnId &&
        Number.isSafeInteger(params?.completedAtMs) &&
        stringProperty(item, "type") === "subAgentActivity" &&
        stringProperty(item, "id") === "root-spawn" &&
        stringProperty(item, "kind") === "started";
    }, timeoutMs, "the spawned worker activity"));
    const workerActivityParams = isObject(workerActivity.params) ? workerActivity.params : null;
    const workerActivityItem = workerActivityParams && isObject(workerActivityParams.item)
      ? workerActivityParams.item
      : null;
    const workerThreadId = workerActivityItem
      ? stringProperty(workerActivityItem, "agentThreadId")
      : null;
    const workerPath = workerActivityItem
      ? stringProperty(workerActivityItem, "agentPath")
      : null;
    if (!workerThreadId || workerThreadId === nativeThreadId || !workerPath) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "The native thread did not publish an exact spawned-worker activity.",
      );
    }
    const workerRead = await provider.guard(client.request("thread/read", {
      threadId: workerThreadId,
      includeTurns: false,
    }, timeoutMs));
    const workerThread = isObject(workerRead) && isObject(workerRead.thread)
      ? workerRead.thread
      : null;
    if (
      stringProperty(workerThread, "id") !== workerThreadId ||
      stringProperty(workerThread, "parentThreadId") !== nativeThreadId ||
      stringProperty(workerThread, "cwd") !== deployment.appCwd
    ) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "thread/read did not bind the spawned worker to its exact parent and cwd.",
      );
    }

    const inputRequest = await provider.guard(client.waitFor(
      (message) => messageMethod(message, "item/tool/requestUserInput"),
      timeoutMs,
      "the request_user_input callback",
    ));
    const inputParams = isObject(inputRequest.params) ? inputRequest.params : null;
    const questions = inputParams ? arrayProperty(inputParams, "questions") : [];
    const question = questions.length === 1 && isObject(questions[0]) ? questions[0] : null;
    const optionsForQuestion = question ? arrayProperty(question, "options") : [];
    const onlyOption = optionsForQuestion.length === 1 && isObject(optionsForQuestion[0])
      ? optionsForQuestion[0]
      : null;
    if (
      stringProperty(inputParams, "threadId") !== nativeThreadId ||
      stringProperty(inputParams, "turnId") !== nativeTurnId ||
      stringProperty(inputParams, "itemId") === null ||
      stringProperty(question, "id") !== "question-capability" ||
      stringProperty(question, "header") !== "Probe" ||
      stringProperty(question, "question") !== "Continue the compatibility probe?" ||
      stringProperty(onlyOption, "label") !== "Continue" ||
      stringProperty(onlyOption, "description") !== "Continue the deterministic probe."
    ) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "The native request_user_input request changed identity or bounded question shape.",
      );
    }
    client.respond(inputRequest, {
      answers: { "question-capability": { answers: ["Continue"] } },
    });

    const readCall = await provider.guard(client.waitFor(
      (message) => messageMethod(message, "item/tool/call"),
      timeoutMs,
      "the planner.read callback",
    ));
    const readArguments = isObject(readCall.params) ? readCall.params.arguments : null;
    if (
      stringProperty(readCall.params, "threadId") !== nativeThreadId ||
      stringProperty(readCall.params, "turnId") !== nativeTurnId ||
      stringProperty(readCall.params, "callId") !== "call-read" ||
      stringProperty(readCall.params, "namespace") !== "planner" ||
      stringProperty(readCall.params, "tool") !== "read" ||
      !isPlannerReadArguments(readArguments) ||
      canonicalText(readArguments) !== canonicalText(PLANNER_PROBE_READ_ARGUMENTS)
    ) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Synthetic planner read changed identity or canonical arguments.",
      );
    }
    client.respond(readCall, {
      success: true,
      contentItems: [{ type: "inputText", text: PLANNER_PROBE_READ_RESULT_TEXT }],
    });

    const callA = await provider.guard(client.waitFor(
      (message) => messageMethod(message, "item/tool/call"),
      timeoutMs,
      "the planner.preview callback",
    ));
    const callAArguments = isObject(callA.params) ? callA.params.arguments : null;
    if (
      stringProperty(callA.params, "threadId") !== nativeThreadId ||
      stringProperty(callA.params, "turnId") !== nativeTurnId ||
      stringProperty(callA.params, "callId") !== "call-A" ||
      stringProperty(callA.params, "namespace") !== "planner" ||
      stringProperty(callA.params, "tool") !== "preview" ||
      !isPlannerPreviewArguments(callAArguments) ||
      canonicalText(callAArguments) !== canonicalText(PLANNER_PROBE_PREVIEW_ARGUMENTS)
    ) {
      throw new CodexCapabilityProbeError(
        "PROBE_PROTOCOL",
        "Synthetic planner preview changed identity or canonical arguments.",
      );
    }
    client.respond(callA, {
      success: true,
      contentItems: [{ type: "inputText", text: PLANNER_PROBE_PREVIEW_RESULT_TEXT }],
    });

    const callB = await provider.guard(client.waitFor(
      (message) => messageMethod(message, "item/tool/call"),
      timeoutMs,
      "the planner.apply callback",
    ));
    const callBArguments = isObject(callB.params) && isObject(callB.params.arguments)
      ? callB.params.arguments
      : null;
    const dependentResultObserved =
      stringProperty(callB.params, "threadId") === nativeThreadId &&
      stringProperty(callB.params, "turnId") === nativeTurnId &&
      stringProperty(callB.params, "callId") === "call-B" &&
      stringProperty(callB.params, "namespace") === "planner" &&
      stringProperty(callB.params, "tool") === "apply" &&
      isPlannerApplyArguments(callBArguments) &&
      canonicalText(callBArguments) === canonicalText(PLANNER_PROBE_APPLY_ARGUMENTS) &&
      provider.dependentPlannerResultObserved();
    if (!dependentResultObserved) {
      throw new CodexCapabilityProbeError("PROBE_PROTOCOL", "Synthetic planner call B changed identity or arguments.");
    }
    client.respond(callB, {
      success: true,
      contentItems: [{ type: "inputText", text: PLANNER_PROBE_APPLY_RESULT_TEXT }],
    });
    assertCompletedTurnNotification(
      await provider.guard(client.waitFor((message) => {
        if (!messageMethod(message, "turn/completed") || !isObject(message.params) ||
            !isObject(message.params.turn)) return false;
        return stringProperty(message.params.turn, "id") === nativeTurnId;
      }, timeoutMs, "the terminal native turn")),
      nativeThreadId,
      nativeTurnId,
    );
    await client.request("thread/unsubscribe", { threadId: workerThreadId }, timeoutMs);
    await client.request("thread/unsubscribe", { threadId: nativeThreadId }, timeoutMs);

    // The client policy must reject a dangerous method locally without putting
    // it on the app-server channel.
    let policyRejected = false;
    try {
      await client.request("command/exec", {}, 1);
    } catch (error) {
      policyRejected = error instanceof CodexCapabilityProbeError;
    }
    if (!policyRejected || client.observedClientRequests.includes("command/exec")) {
      throw new CodexCapabilityProbeError("PROBE_PROTOCOL", "The outbound RPC policy did not fail closed.");
    }
    await client.close();
    await closeServer(provider.server);
    client.assertHealthy();
    if (provider.ingress.failure) throw provider.ingress.failure;

    const workerObserved = provider.workerRequestObserved();
    if (!workerObserved) {
      throw new CodexCapabilityProbeError(
        "PROBE_CAPABILITY",
        "The spawned worker never reached the local provider.",
      );
    }
    await writeFile(join(probeHome, UNIFIED_CAPABILITY_MARKER_FILE), "v1\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const runtimeFiles = await inventoryRelativeFiles(probeHome);
    const providerRequests = Object.freeze([...provider.requests]);
    return evaluateObservedCapabilityRequests(providerRequests, {
      dependentResultObserved,
      plannerReadObserved: provider.plannerReadObserved(),
      workerWaitCallObserved: provider.workerWaitCallObserved(),
      workerWaitResultObserved: provider.workerWaitResultObserved(),
      workerResultObserved: provider.workerResultObserved(),
      userInputRoundTripObserved: provider.userInputRoundTripObserved(),
      permissionProfileVerified: true,
      outboundPolicyRejected: policyRejected,
      unexpectedRpcMethods: client.unexpectedServerRequests,
      probeRuntimeFiles: runtimeFiles,
    });
  } finally {
    await client?.close().catch(() => undefined);
    if (provider) await closeServer(provider.server).catch(() => undefined);
    await rm(probeHome, { recursive: true, force: true });
  }
}

function pathWithin(root: string, candidate: string) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
  );
}

async function hashProvenanceFile(path: string) {
  try {
    return await sha256BoundedFile(
      path,
      CODEX_FOLLOW_UP_RESOURCE_POLICY.provenance.maxFileBytes,
      "Codex provenance source",
    );
  } catch (error) {
    throw new CodexCapabilityProbeError(
      "READBACK_PROVENANCE",
      "A declared Codex provenance source could not be read within budget.",
      error,
    );
  }
}

function configLayers(result: unknown) {
  return requiredArrayProperty(result, "layers", "config/read");
}

async function configSourceEvidence(
  configResult: unknown,
  deployment: ValidatedCodexFollowUpDeployment,
) {
  if (
    !isObject(configResult) ||
    !Object.hasOwn(configResult, "config") ||
    !Object.hasOwn(configResult, "origins") ||
    !isObject(configResult.config) ||
    !isObject(configResult.origins)
  ) {
    throw new CodexCapabilityProbeError(
      "READBACK_PROVENANCE",
      "config/read omitted its required config or origins object.",
    );
  }
  const hashes: Record<string, string> = {};
  const systemConfigPaths: string[] = [];
  let sawDedicatedUserLayer = false;
  let sawSystemLayer = false;
  let index = 0;
  const layers = configLayers(configResult);
  if (configResult.config.forced_login_method !== "chatgpt") {
    throw new CodexCapabilityProbeError(
      "READBACK_PROVENANCE",
      "Effective Codex config does not force ChatGPT login.",
    );
  }
  if (layers.length > CODEX_FOLLOW_UP_RESOURCE_POLICY.provenance.maxSources) {
    throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "config/read exceeded its source budget.");
  }
  for (const layer of layers) {
    if (
      !isObject(layer) ||
      !isObject(layer.name) ||
      !isObject(layer.config) ||
      typeof layer.version !== "string" ||
      layer.version.length === 0
    ) {
      throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "config/read returned a malformed layer.");
    }
    const source = layer.name;
    const type = stringProperty(source, "type");
    if (type !== "user" && type !== "system") {
      throw new CodexCapabilityProbeError(
        "READBACK_PROVENANCE",
        "Actual deployment config readback contains an undeclared layer type.",
      );
    }
    const rawPath = source.file;
    if (type === "user") {
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "User config layer omitted its path.");
      }
      const canonical = await realpath(rawPath);
      if (canonical !== join(deployment.codexHome, "config.toml")) {
        throw new CodexCapabilityProbeError(
          "READBACK_PROVENANCE",
          "Actual deployment config is not sourced from the dedicated Codex home.",
        );
      }
      if (sawDedicatedUserLayer) {
        throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "config/read duplicated its user layer.");
      }
      if (
        layer.config.forced_login_method !== "chatgpt" ||
        layer.config.cli_auth_credentials_store !== "file"
      ) {
        throw new CodexCapabilityProbeError(
          "READBACK_PROVENANCE",
          "Dedicated Codex config does not enforce ChatGPT login with file-backed credentials.",
        );
      }
      sawDedicatedUserLayer = true;
      hashes[`user:${index}`] = await hashProvenanceFile(canonical);
    } else {
      if (
        sawSystemLayer ||
        typeof rawPath !== "string" ||
        rawPath.length === 0 ||
        !isAbsolute(rawPath) ||
        resolve(rawPath) !== rawPath
      ) {
        throw new CodexCapabilityProbeError(
          "READBACK_PROVENANCE",
          "The system config layer returned a malformed or duplicate file source.",
        );
      }
      if (Object.keys(layer.config).length !== 0) {
        throw new CodexCapabilityProbeError(
          "READBACK_PROVENANCE",
          "The system config layer contains active configuration.",
        );
      }
      try {
        await lstat(rawPath);
        throw new CodexCapabilityProbeError(
          "READBACK_PROVENANCE",
          "The system config layer names an existing file.",
        );
      } catch (error) {
        if (error instanceof CodexCapabilityProbeError) throw error;
        if (!isObject(error) || error.code !== "ENOENT") {
          throw new CodexCapabilityProbeError(
            "READBACK_PROVENANCE",
            "The system config layer could not be proven absent.",
            error,
          );
        }
      }
      sawSystemLayer = true;
      systemConfigPaths.push(rawPath);
      hashes[`${type}:${index}`] = createHash("sha256").update(canonicalText(source)).digest("hex");
    }
    index += 1;
  }
  if (!sawDedicatedUserLayer) {
    throw new CodexCapabilityProbeError(
      "READBACK_PROVENANCE",
      "Actual deployment readback did not include the dedicated config.toml.",
    );
  }
  if (!sawSystemLayer) {
    throw new CodexCapabilityProbeError(
      "READBACK_PROVENANCE",
      "Actual deployment readback omitted the empty system config layer.",
    );
  }
  return Object.freeze({
    hashes: Object.freeze(hashes),
    systemConfigPaths: Object.freeze(systemConfigPaths),
  });
}

async function instructionSourceEvidence(
  threadResult: unknown,
  deployment: ValidatedCodexFollowUpDeployment,
) {
  const hashes: Record<string, string> = {};
  const sources = requiredArrayProperty(threadResult, "instructionSources", "thread/start");
  const expectedGlobalInstructions = join(deployment.codexHome, "AGENTS.md");
  let expectedCanonical: string;
  try {
    const expectedStats = await stat(expectedGlobalInstructions);
    expectedCanonical = await realpath(expectedGlobalInstructions);
    if (
      !expectedStats.isFile() ||
      expectedCanonical !== expectedGlobalInstructions ||
      sources.length !== 1 ||
      typeof sources[0] !== "string" ||
      await realpath(sources[0]) !== expectedCanonical ||
      sources[0] !== expectedCanonical
    ) {
      throw new Error("missing expected instruction source");
    }
  } catch (error) {
    throw new CodexCapabilityProbeError(
      "READBACK_PROVENANCE",
      "Actual deployment did not load CODEX_HOME/AGENTS.md as its canonical instruction source.",
      error,
    );
  }
  // Preserve the bounded-file diagnostic instead of collapsing an oversized
  // canonical source into a path/provenance mismatch.
  hashes["dedicated:0"] = await hashProvenanceFile(expectedCanonical);
  return Object.freeze(hashes);
}

async function skillNames(result: unknown, deployment: ValidatedCodexFollowUpDeployment) {
  const names: string[] = [];
  const entries = requiredArrayProperty(result, "data", "skills/list");
  if (entries.length !== 1 || !isObject(entries[0]) || entries[0].cwd !== deployment.appCwd) {
    throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "skills/list changed its requested cwd projection.");
  }
  for (const entry of entries) {
    const errors = requiredArrayProperty(entry, "errors", "skills/list entry");
    if (errors.length > 0) {
      throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "skills/list reported loader errors.");
    }
    const skills = requiredArrayProperty(entry, "skills", "skills/list entry");
    if (skills.length > CODEX_FOLLOW_UP_RESOURCE_POLICY.pagination.maxRows) {
      throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "skills/list exceeded its row budget.");
    }
    for (const skill of skills) {
      if (
        !isObject(skill) ||
        typeof skill.name !== "string" ||
        skill.name.length === 0 ||
        typeof skill.path !== "string" ||
        (skill.scope !== "user" && skill.scope !== "repo") ||
        typeof skill.enabled !== "boolean"
      ) {
        throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "skills/list returned a malformed skill.");
      }
      const root = await realpath(skill.scope === "repo"
        ? join(deployment.appCwd, ".agents", "skills")
        : join(deployment.normalHome, ".agents", "skills"));
      const path = await realpath(skill.path);
      const pathStats = await stat(path);
      if (
        skill.path !== path ||
        !pathWithin(root, path) ||
        basename(path) !== "SKILL.md" ||
        !pathStats.isFile()
      ) {
        throw new CodexCapabilityProbeError(
          "READBACK_PROVENANCE",
          "skills/list exposed a non-file or non-canonical skill outside its declared user or release-owned root.",
        );
      }
      const name = stringProperty(skill, "name");
      if (name) names.push(name);
    }
  }
  const unique = [...new Set(names)].sort();
  if (unique.length !== names.length) {
    throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "skills/list returned duplicate skill names.");
  }
  return unique;
}

export async function readActualCodexDeployment(
  identity: CodexExecutableIdentity,
  deployment: ValidatedCodexFollowUpDeployment,
  options: ProbeOptions = {},
): Promise<CodexDeploymentReadbackEvidence> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const childEnvironment = buildCodexFollowUpChildEnvironment(
    deployment,
    options.sourceEnvironment,
  );
  const child = await spawnAcceptedCodexProcess(identity, CODEX_APP_SERVER_ARGUMENTS, {
    cwd: deployment.appCwd,
    env: childEnvironment,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new JsonlRpcClient(
    child,
    new Set([
      "initialize",
      ...CODEX_FOLLOW_UP_RPC_POLICY.readinessRequests,
    ]),
    new Set(),
    options.signal,
  );
  try {
    await initializeClient(client, timeoutMs);
    const permissionProfiles = await collectPaginated(
      client,
      "permissionProfile/list",
      { limit: 100 },
      timeoutMs,
    );
    assertReadOnlyPermissionProfiles(permissionProfiles);
    const account = await client.request("account/read", { refreshToken: false }, timeoutMs);
    const config = await client.request("config/read", {
      cwd: deployment.appCwd,
      includeLayers: true,
    }, timeoutMs);
    const skills = await client.request("skills/list", {
      cwds: [deployment.appCwd],
      forceReload: true,
    }, timeoutMs);
    const thread = await client.request("thread/start", {
      approvalPolicy: "never",
      permissions: ":read-only",
      cwd: deployment.appCwd,
      ephemeral: true,
      environments: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      dynamicTools: [],
      config: {
        web_search: "disabled",
        features: featureOverrides(),
        mcp_servers: {},
        orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
        skills: { include_instructions: false, bundled: { enabled: false } },
      },
    }, timeoutMs);
    const threadId = assertReadOnlyThread(thread, deployment.appCwd);
    await client.request("thread/unsubscribe", { threadId }, timeoutMs);

    const mcpServerNames: readonly string[] = [];
    const appNames: readonly string[] = [];
    const pluginNames: readonly string[] = [];
    if (mcpServerNames.length || appNames.length || pluginNames.length) {
      throw new CodexCapabilityProbeError(
        "READBACK_PROVENANCE",
        "Actual deployment exposes MCP, app, or installed plugin capability.",
      );
    }
    if (client.unexpectedServerRequests.length > 0) {
      throw new CodexCapabilityProbeError(
        "READBACK_PROVENANCE",
        `Actual deployment emitted unexpected server requests: ${client.unexpectedServerRequests.join(", ")}.`,
      );
    }

    if (
      !isObject(account) ||
      !Object.hasOwn(account, "account") ||
      typeof account.requiresOpenaiAuth !== "boolean"
    ) {
      throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "account/read returned a malformed response.");
    }
    if (account.requiresOpenaiAuth !== true) {
      throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "The deployment does not require OpenAI authentication.");
    }
    if (account.account !== undefined && account.account !== null && !isObject(account.account)) {
      throw new CodexCapabilityProbeError("READBACK_PROVENANCE", "account/read returned a malformed account.");
    }
    const accountValue = isObject(account.account) ? account.account : null;
    const accountKind = accountValue ? stringProperty(accountValue, "type") : null;
    if (accountValue && accountKind !== "chatgpt") {
      throw new CodexCapabilityProbeError(
        "READBACK_PROVENANCE",
        "The dedicated runtime is authenticated with a non-ChatGPT credential mode.",
      );
    }
    const configEvidence = await configSourceEvidence(config, deployment);
    const instructionSourceHashes = await instructionSourceEvidence(thread, deployment);
    const discoveredSkillNames = Object.freeze(await skillNames(skills, deployment));
    await client.close();
    client.assertHealthy();
    return Object.freeze({
      authenticated: accountValue !== null,
      accountKind,
      permissionProfile: ":read-only",
      effectiveSandbox: "read-only-network-disabled",
      configSourceHashes: configEvidence.hashes,
      systemConfigPaths: configEvidence.systemConfigPaths,
      instructionSourceHashes,
      skillNames: discoveredSkillNames,
      mcpServerNames: Object.freeze(mcpServerNames),
      appNames: Object.freeze(appNames),
      pluginNames: Object.freeze(pluginNames),
      // The generated runtime cache is updater-owned and can grow without
      // changing executable, config, instructions, or model capabilities.
      // Those authoritative boundaries are verified above.
      runtimeFiles: Object.freeze([]),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export const CODEX_CAPABILITY_BOUNDARY = Object.freeze({
  manifests: CODEX_FOLLOW_UP_TOOL_MANIFESTS,
  forbiddenClasses: CODEX_FOLLOW_UP_FORBIDDEN_CAPABILITY_CLASSES,
  rpcPolicy: CODEX_FOLLOW_UP_RPC_POLICY,
});
