import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export const APP_SERVER_CLIENT_METHODS = [
  "initialize",
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/archive",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

export type AppServerClientMethod = typeof APP_SERVER_CLIENT_METHODS[number];
export type AppServerRequestId = string | number;
export type AppServerResponseError = {
  code: number;
  message: string;
  data?: unknown;
};
export type AppServerMessage = {
  id?: AppServerRequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: AppServerResponseError;
};
export type AppServerServerRequest = AppServerMessage & {
  id: AppServerRequestId;
  method: string;
};
export type AppServerNotification = AppServerMessage & {
  id?: never;
  method: string;
};

export type AppServerClientOptions = {
  requestTimeoutMs?: number;
  onNotification?: (notification: AppServerNotification) => void;
  onServerRequest?: (request: AppServerServerRequest) => void;
  onFailure?: (error: AppServerClientError) => void;
};

type PendingRequest = {
  method: AppServerClientMethod;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const CLIENT_METHOD_SET = new Set<string>(APP_SERVER_CLIENT_METHODS);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_JSONL_FRAME_BYTES = 1_048_576;
const MAX_STDERR_LINE_BYTES = 8_192;
const MAX_PENDING_REQUESTS = 128;
const MAX_RETAINED_STDERR_LINES = 12;

export class AppServerClientError extends Error {
  readonly code:
    | "PROTOCOL_ERROR"
    | "TRANSPORT_ERROR"
    | "REQUEST_TIMEOUT"
    | "CLIENT_CLOSED";

  constructor(
    code: AppServerClientError["code"],
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "AppServerClientError";
    this.code = code;
  }
}

/** A valid error response from app-server for one client request. */
export class AppServerRequestError extends Error {
  readonly method: AppServerClientMethod;
  readonly response: AppServerResponseError;

  constructor(method: AppServerClientMethod, response: AppServerResponseError) {
    super(`Codex app-server rejected ${method}: ${response.message}`);
    this.name = "AppServerRequestError";
    this.method = method;
    this.response = {
      code: response.code,
      message: response.message,
      ...(response.data === undefined ? {} : { data: response.data }),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is AppServerRequestId {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function isResponseError(value: unknown): value is AppServerResponseError {
  return isRecord(value) && Number.isSafeInteger(value.code) &&
    typeof value.message === "string" && value.message.length > 0;
}

function asClientError(
  error: unknown,
  message: string,
  code: AppServerClientError["code"] = "PROTOCOL_ERROR",
) {
  return error instanceof AppServerClientError
    ? error
    : new AppServerClientError(code, message, { cause: error });
}

function validateTimeout(timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new AppServerClientError(
      "PROTOCOL_ERROR",
      `Codex app-server request timeout must be between 1 and ${MAX_REQUEST_TIMEOUT_MS} ms.`,
    );
  }
}

function subscribeBoundedLines(
  stream: Readable,
  maxLineBytes: number,
  label: "stdout" | "stderr",
  onLine: (line: string) => void,
  onFailure: (error: AppServerClientError) => void,
) {
  let fragments: Buffer[] = [];
  let bufferedBytes = 0;
  let failed = false;

  const fail = () => {
    if (failed) return;
    failed = true;
    fragments = [];
    bufferedBytes = 0;
    stream.pause();
    onFailure(new AppServerClientError(
      "PROTOCOL_ERROR",
      `Codex app-server emitted an oversized ${label} line.`,
    ));
  };

  const append = (fragment: Buffer) => {
    if (failed || fragment.length === 0) return !failed;
    if (bufferedBytes + fragment.length > maxLineBytes) {
      fail();
      return false;
    }
    fragments.push(fragment);
    bufferedBytes += fragment.length;
    return true;
  };

  const emit = (fragment: Buffer) => {
    if (!append(fragment)) return;
    let line = Buffer.concat(fragments, bufferedBytes);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    fragments = [];
    bufferedBytes = 0;
    onLine(line.toString("utf8"));
  };

  stream.on("data", (value: Buffer | string) => {
    if (failed) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length && !failed) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline < 0) {
        append(chunk.subarray(offset));
        return;
      }
      emit(chunk.subarray(offset, newline));
      offset = newline + 1;
    }
  });
  stream.once("end", () => {
    if (!failed && bufferedBytes > 0) emit(Buffer.alloc(0));
  });
}

export class AppServerClient {
  readonly child: ChildProcess;

  #nextId = 1;
  #pending = new Map<AppServerRequestId, PendingRequest>();
  #closed = false;
  #failure: AppServerClientError | null = null;
  #stderr: string[] = [];
  #requestTimeoutMs: number;
  #onNotification: (notification: AppServerNotification) => void;
  #onServerRequest: (request: AppServerServerRequest) => void;
  #onFailure: (error: AppServerClientError) => void;

  constructor(child: ChildProcess, options: AppServerClientOptions = {}) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new AppServerClientError(
        "PROTOCOL_ERROR",
        "Codex app-server did not expose closed JSONL stdio.",
      );
    }
    this.child = child;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    validateTimeout(this.#requestTimeoutMs);
    this.#onNotification = options.onNotification ?? (() => undefined);
    this.#onServerRequest = options.onServerRequest ?? (() => undefined);
    this.#onFailure = options.onFailure ?? (() => undefined);

    subscribeBoundedLines(
      child.stdout,
      MAX_JSONL_FRAME_BYTES,
      "stdout",
      (line) => this.#handleLine(line),
      (error) => this.#signalFailure(error),
    );
    subscribeBoundedLines(
      child.stderr,
      MAX_STDERR_LINE_BYTES,
      "stderr",
      (line) => {
        this.#stderr.push(line.slice(0, 512));
        if (this.#stderr.length > MAX_RETAINED_STDERR_LINES) this.#stderr.shift();
      },
      (error) => this.#signalFailure(error),
    );
    child.stdin.on("error", (error) => this.#signalFailure(asClientError(
      error,
      "Codex app-server input failed.",
      "TRANSPORT_ERROR",
    )));
    child.once("error", (error) => this.#signalFailure(asClientError(
      error,
      "Codex app-server process failed.",
      "TRANSPORT_ERROR",
    )));
    child.once("close", (code, signal) => {
      if (this.#closed || this.#failure) return;
      const disposition = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#signalFailure(new AppServerClientError(
        "TRANSPORT_ERROR",
        `Codex app-server exited with ${disposition}.`,
      ));
    });
  }

  get closed() {
    return this.#closed;
  }

  get failure() {
    return this.#failure;
  }

  request(
    method: AppServerClientMethod,
    params: unknown,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
    if (!CLIENT_METHOD_SET.has(method)) {
      return Promise.reject(new AppServerClientError(
        "PROTOCOL_ERROR",
        `Unsupported Codex app-server client method ${String(method)}.`,
      ));
    }
    try {
      validateTimeout(timeoutMs);
      this.#assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new AppServerClientError(
        "PROTOCOL_ERROR",
        "Codex app-server exceeded the bounded pending request count.",
      ));
    }
    if (!Number.isSafeInteger(this.#nextId)) {
      return Promise.reject(new AppServerClientError(
        "PROTOCOL_ERROR",
        "Codex app-server request identifiers were exhausted.",
      ));
    }

    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        const error = new AppServerClientError(
          "REQUEST_TIMEOUT",
          `Timed out waiting for Codex app-server ${method}.`,
        );
        reject(error);
        // A timed-out request has an ambiguous remote outcome. Retire the
        // entire process so no later request can race ahead of reconciliation.
        this.#signalFailure(error);
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notifyInitialized() {
    this.#write({ method: "initialized", params: {} });
  }

  respond(id: AppServerRequestId, result: unknown) {
    if (!isRequestId(id)) {
      throw new AppServerClientError("PROTOCOL_ERROR", "Invalid app-server response id.");
    }
    this.#write({ id, result });
  }

  respondError(id: AppServerRequestId, error: AppServerResponseError) {
    if (!isRequestId(id) || !Number.isInteger(error.code) || !error.message) {
      throw new AppServerClientError("PROTOCOL_ERROR", "Invalid app-server error response.");
    }
    this.#write({ id, error });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new AppServerClientError(
      "CLIENT_CLOSED",
      "Codex app-server client closed with pending requests.",
    ));
    this.child.stdin?.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    const closed = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    const terminateTimer = setTimeout(() => this.child.kill("SIGTERM"), 500);
    terminateTimer.unref?.();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      }),
    ]);
    clearTimeout(terminateTimer);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
    }
  }

  #assertOpen() {
    if (this.#closed) {
      throw new AppServerClientError(
        "CLIENT_CLOSED",
        "Codex app-server client is closed.",
      );
    }
    if (this.#failure) throw this.#failure;
  }

  #write(message: AppServerMessage) {
    this.#assertOpen();
    if (!this.child.stdin?.writable) {
      throw new AppServerClientError("TRANSPORT_ERROR", "Codex app-server input is closed.");
    }
    let line: string;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      throw new AppServerClientError(
        "PROTOCOL_ERROR",
        "Codex app-server request was not JSON serializable.",
        { cause: error },
      );
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_FRAME_BYTES) {
      throw new AppServerClientError(
        "PROTOCOL_ERROR",
        "Codex app-server request exceeded the bounded JSONL frame size.",
      );
    }
    this.child.stdin.write(line, (error) => {
      if (error) {
        this.#signalFailure(asClientError(
          error,
          "Codex app-server input failed.",
          "TRANSPORT_ERROR",
        ));
      }
    });
  }

  #handleLine(line: string) {
    if (this.#closed || this.#failure || !line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.#signalFailure(new AppServerClientError(
        "PROTOCOL_ERROR",
        "Codex app-server emitted invalid JSONL.",
        { cause: error },
      ));
      return;
    }
    if (!isRecord(value) || "jsonrpc" in value) {
      this.#signalFailure(new AppServerClientError(
        "PROTOCOL_ERROR",
        "Codex app-server emitted a non-canonical protocol frame.",
      ));
      return;
    }
    const message = value as AppServerMessage;
    const hasId = Object.hasOwn(value, "id");
    if (hasId && !isRequestId(value.id)) {
      this.#signalFailure(new AppServerClientError(
        "PROTOCOL_ERROR",
        "Codex app-server emitted an invalid request id.",
      ));
      return;
    }

    if (hasId && typeof value.method !== "string") {
      const pending = this.#pending.get(message.id!);
      if (!pending) return;
      const hasResult = Object.hasOwn(value, "result");
      const hasError = Object.hasOwn(value, "error");
      if (hasResult === hasError) {
        this.#signalFailure(new AppServerClientError(
          "PROTOCOL_ERROR",
          `Codex app-server emitted an invalid response for ${pending.method}.`,
        ));
        return;
      }
      if (hasError) {
        if (!isResponseError(value.error)) {
          this.#signalFailure(new AppServerClientError(
            "PROTOCOL_ERROR",
            `Codex app-server emitted an invalid response for ${pending.method}.`,
          ));
          return;
        }
        clearTimeout(pending.timer);
        this.#pending.delete(message.id!);
        pending.reject(new AppServerRequestError(pending.method, value.error));
      } else {
        clearTimeout(pending.timer);
        this.#pending.delete(message.id!);
        pending.resolve(value.result);
      }
      return;
    }

    if (hasId && typeof value.method === "string") {
      this.#invokeCallback(
        () => this.#onServerRequest(message as AppServerServerRequest),
        "Codex app-server server-request callback failed.",
      );
      return;
    }

    if (!hasId && typeof value.method === "string") {
      this.#invokeCallback(
        () => this.#onNotification(message as AppServerNotification),
        "Codex app-server notification callback failed.",
      );
      return;
    }

    this.#signalFailure(new AppServerClientError(
      "PROTOCOL_ERROR",
      "Codex app-server emitted an unclassified protocol frame.",
    ));
  }

  #invokeCallback(callback: () => void, message: string) {
    try {
      callback();
    } catch (error) {
      this.#signalFailure(asClientError(error, message));
    }
  }

  #signalFailure(error: AppServerClientError) {
    if (this.#closed || this.#failure) return;
    this.#failure = error;
    this.#rejectPending(error);
    try {
      this.#onFailure(error);
    } catch {
      // Failure reporting is advisory; it cannot replace the owning protocol error.
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  #rejectPending(error: Error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
