import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export type JsonRpcId = string | number;
export type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_JSONL_FRAME_BYTES = 1_048_576;
const MAX_STDERR_LINE_BYTES = 4_096;
const MAX_SESSION_FRAMES = 1_024;
const MAX_OBSERVED_NOTIFICATIONS = 512;
export const MAX_PROTOCOL_IDENTIFIER_LENGTH = 200;

export class RestrictedSessionProtocolError extends Error {
  readonly code:
    | "PROTOCOL_ERROR"
    | "SESSION_TIMEOUT"
    | "SESSION_CANCELLED"
    | "TURN_FAILED";

  constructor(
    code: RestrictedSessionProtocolError["code"],
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "DynamicPlannerSessionError";
    this.code = code;
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringProperty(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

export function isProtocolIdentifier(value: string | null): value is string {
  return value !== null && value.length > 0 &&
    value.length <= MAX_PROTOCOL_IDENTIFIER_LENGTH && !value.includes("\u0000");
}

export function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function timeoutPromise<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
  message: string,
) {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(() => reject(
      new RestrictedSessionProtocolError("SESSION_TIMEOUT", message),
    ), timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function subscribeBoundedLines(
  stream: Readable,
  maxLineBytes: number,
  label: "stdout" | "stderr",
  onLine: (line: string) => void,
  onFailure: (error: Error) => void,
) {
  let fragments: Buffer[] = [];
  let bufferedBytes = 0;
  let failed = false;

  const fail = () => {
    if (failed) return;
    failed = true;
    stream.pause();
    fragments = [];
    bufferedBytes = 0;
    onFailure(new RestrictedSessionProtocolError(
      "PROTOCOL_ERROR",
      `Codex app-server emitted an oversized ${label} line.`,
    ));
  };

  const append = (fragment: Buffer) => {
    if (fragment.length === 0 || failed) return true;
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

export class RestrictedAppServerClient {
  readonly child: ChildProcess;
  readonly observedNotifications: string[] = [];
  onServerRequest: (message: JsonRpcMessage) => void = () => undefined;
  onNotification: (message: JsonRpcMessage) => void = () => undefined;
  onFailure: (error: Error) => void = () => undefined;

  #nextId = 1;
  #pending = new Map<JsonRpcId, PendingRequest>();
  #closed = false;
  #failed = false;
  #frameCount = 0;
  #stderr: string[] = [];

  constructor(child: ChildProcess) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new RestrictedSessionProtocolError(
        "PROTOCOL_ERROR",
        "Codex app-server did not expose closed JSONL stdio.",
      );
    }
    this.child = child;
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
        if (this.#stderr.length > 12) this.#stderr.shift();
      },
      (error) => this.#signalFailure(error),
    );
    child.once("error", (error) => this.#signalFailure(new RestrictedSessionProtocolError(
      "PROTOCOL_ERROR",
      "Codex app-server failed.",
      { cause: error },
    )));
    child.once("close", (code, signal) => {
      if (this.#closed) return;
      const disposition = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#signalFailure(new RestrictedSessionProtocolError(
        "PROTOCOL_ERROR",
        `Codex app-server exited with ${disposition}.`,
      ));
    });
  }

  request(
    method: "initialize" | "thread/start" | "turn/start" | "turn/interrupt",
    params: unknown,
    timeoutMs: number,
  ) {
    if (this.#closed || this.#failed) {
      return Promise.reject(new RestrictedSessionProtocolError(
        "PROTOCOL_ERROR",
        "Codex app-server is no longer accepting requests.",
      ));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RestrictedSessionProtocolError(
          "SESSION_TIMEOUT",
          `Timed out waiting for ${method}.`,
        ));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  notifyInitialized() {
    this.#write({ method: "initialized", params: {} });
  }

  respond(id: JsonRpcId, result: unknown) {
    this.#write({ id, result });
  }

  respondUnsupported(id: JsonRpcId, method: string) {
    this.#write({
      id,
      error: { code: -32601, message: `Unsupported server request ${method}.` },
    });
  }

  abort(error: Error) {
    this.#failed = true;
    this.#rejectPending(error);
  }

  abortAfterHostFence(error: Error) {
    this.abort(error);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new RestrictedSessionProtocolError(
      "PROTOCOL_ERROR",
      "Codex app-server client closed with pending requests.",
    ));
    this.child.stdin?.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    const timer = setTimeout(() => this.child.kill("SIGTERM"), 500);
    timer.unref?.();
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    clearTimeout(timer);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  #write(message: JsonRpcMessage) {
    if (this.#closed || this.#failed || !this.child.stdin?.writable) {
      throw new RestrictedSessionProtocolError(
        "PROTOCOL_ERROR",
        "Codex app-server input is closed.",
      );
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string) {
    if (this.#failed || !line.trim()) return;
    this.#frameCount += 1;
    if (this.#frameCount > MAX_SESSION_FRAMES) {
      this.#signalFailure(new RestrictedSessionProtocolError(
        "PROTOCOL_ERROR",
        "Codex app-server exceeded the bounded session frame count.",
      ));
      return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_JSONL_FRAME_BYTES) {
      this.#signalFailure(new RestrictedSessionProtocolError(
        "PROTOCOL_ERROR",
        "Codex app-server emitted an oversized JSONL frame.",
      ));
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.#signalFailure(new RestrictedSessionProtocolError(
        "PROTOCOL_ERROR",
        "Codex app-server emitted invalid JSONL.",
        { cause: error },
      ));
      return;
    }
    if (!isRecord(message)) {
      this.#signalFailure(new RestrictedSessionProtocolError(
        "PROTOCOL_ERROR",
        "Codex app-server emitted a non-object frame.",
      ));
      return;
    }
    if (message.id !== undefined && typeof message.method !== "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new RestrictedSessionProtocolError(
          "PROTOCOL_ERROR",
          `Codex app-server rejected ${pending.method}.`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      this.onServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      if (this.observedNotifications.length >= MAX_OBSERVED_NOTIFICATIONS) {
        this.#signalFailure(new RestrictedSessionProtocolError(
          "PROTOCOL_ERROR",
          "Codex app-server exceeded the bounded notification count.",
        ));
        return;
      }
      this.observedNotifications.push(message.method);
      this.onNotification(message);
      return;
    }
    this.#signalFailure(new RestrictedSessionProtocolError(
      "PROTOCOL_ERROR",
      "Codex app-server emitted an unclassified frame.",
    ));
  }

  #signalFailure(error: Error) {
    if (this.#closed || this.#failed) return;
    this.#failed = true;
    this.onFailure(error);
  }

  #rejectPending(error: Error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
