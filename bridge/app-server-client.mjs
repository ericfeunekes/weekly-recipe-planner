import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

import {
  createIsolatedCodexRuntimeEnvironment,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  DEFAULT_CODEX_EXECUTABLE_PATH,
  lockThreadStartParams,
  lockTurnStartParams,
  resolveCodexExecutable,
} from "./codex-runtime-policy.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class CodexBridgeError extends Error {
  constructor(message, { code = "CODEX_BRIDGE_ERROR", cause } = {}) {
    super(message, { cause });
    this.name = "CodexBridgeError";
    this.code = code;
  }
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    command,
    cwd = process.cwd(),
    env = process.env,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    spawnImpl = spawn,
  } = {}) {
    super();
    this.command = command ?? env.PLANNER_CODEX_BINARY ?? DEFAULT_CODEX_EXECUTABLE_PATH;
    this.args = DEFAULT_CODEX_APP_SERVER_ARGS;
    this.cwd = cwd;
    this.env = { ...env };
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnImpl = spawnImpl;
    this.runtimeEnvironment = null;
    this.child = null;
    this.initialized = false;
    this.startPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turnRecords = new Map();
    this.unclaimedTurnIds = new Set();
    this.ignoredTurnIds = new Set();
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.child && !this.child.killed && this.initialized) return;

    const launch = this.#launch();
    this.startPromise = launch;
    try {
      await launch;
    } finally {
      if (this.startPromise === launch) this.startPromise = null;
    }
  }

  async #launch() {
    this.#cleanupRuntimeEnvironment();
    let child;
    try {
      const executable = this.spawnImpl === spawn
        ? resolveCodexExecutable(this.command)
        : this.command;
      this.runtimeEnvironment = createIsolatedCodexRuntimeEnvironment(this.env);
      child = this.spawnImpl(executable, this.args, {
        cwd: this.cwd,
        env: this.runtimeEnvironment.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.#cleanupRuntimeEnvironment();
      throw error;
    }
    this.child = child;
    this.initialized = false;

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });

    stdout.on("line", (line) => {
      if (this.child === child) this.#handleLine(line);
    });
    stderr.on("line", () => {
      this.emit("stderr", "Codex app-server reported an error.");
    });
    child.stdin.on("error", (error) => this.#handleExit(error, child));
    child.once("error", (error) => this.#handleExit(error, child));
    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#handleExit(new Error(`codex app-server exited with ${detail}.`), child);
    });

    try {
      await this.#requestWithoutStart(
        "initialize",
        {
          clientInfo: {
            name: "weekly_recipe_planner",
            title: "Weekly Recipe Planner",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
        this.requestTimeoutMs,
      );
      this.notify("initialized");
      this.initialized = true;
    } catch (error) {
      this.close();
      throw new CodexBridgeError(
        "Could not initialize Codex app-server. Confirm that Codex is installed and `codex login status` succeeds.",
        { code: "CODEX_UNAVAILABLE", cause: error },
      );
    }
  }

  #handleLine(line) {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("Codex app-server emitted invalid JSONL."));
      return;
    }

    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.emit("protocolError", new Error("Codex app-server emitted a non-object JSONL frame."));
      return;
    }

    if (typeof message.method === "string" && Object.hasOwn(message, "id")) {
      this.emit("serverRequest", message);
      try {
        this.#writeMessage({
          id: message.id,
          error: {
            code: -32601,
            message: `Client does not support server request ${message.method}.`,
          },
        });
      } catch {
        // The write path already transitions the client to unavailable.
      }
      return;
    }

    if (Object.hasOwn(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.cleanup?.();
      if (message.error) {
        pending.reject(
          new CodexBridgeError("Codex request failed.", {
            code: "CODEX_RPC_ERROR",
          }),
        );
      } else {
        if (
          pending.method === "turn/start" &&
          typeof message.result?.turn?.id === "string"
        ) {
          this.unclaimedTurnIds.add(message.result.turn.id);
        }
        pending.resolve(message.result);
      }
      this.#pruneOrphanedTurnRecords();
      return;
    }

    if (typeof message.method === "string") {
      this.#recordTurnNotification(message);
      this.emit("notification", message);
      // EventEmitter treats the bare event name "error" as fatal without a listener.
      this.emit(`notification:${message.method}`, message.params);
    }
  }

  #recordTurnNotification(message) {
    const params = message.params ?? {};
    const turnId = params.turnId ?? params.turn?.id;
    if (typeof turnId !== "string") return;
    if (this.ignoredTurnIds.has(turnId)) {
      if (message.method === "turn/completed") this.ignoredTurnIds.delete(turnId);
      return;
    }

    const record = this.turnRecords.get(turnId) ?? {
      deltas: [],
      messages: [],
      completion: null,
      waiters: [],
    };

    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      record.deltas.push(params.delta);
    } else if (
      message.method === "item/completed" &&
      params.item?.type === "agentMessage" &&
      typeof params.item.text === "string"
    ) {
      record.messages.push({ text: params.item.text, phase: params.item.phase ?? null });
    } else if (message.method === "turn/completed") {
      record.completion = params.turn;
    }

    this.turnRecords.set(turnId, record);
    if (record.completion) this.#settleTurnRecord(turnId, record);
  }

  #settleTurnRecord(turnId, record) {
    if (record.waiters.length === 0) {
      if (
        !this.unclaimedTurnIds.has(turnId) &&
        !this.#hasPendingTurnStart()
      ) {
        this.turnRecords.delete(turnId);
      }
      return;
    }
    const completion = record.completion;
    const finalMessage =
      record.messages.findLast((message) => message.phase === "final_answer") ??
      record.messages.at(-1);
    const text = finalMessage?.text ?? record.deltas.join("");

    for (const waiter of record.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.cleanup?.();
      if (completion?.status === "completed") {
        waiter.resolve({ text, turn: completion });
      } else {
        waiter.reject(
          new CodexBridgeError(
            "Codex turn did not complete.",
            { code: "CODEX_TURN_FAILED" },
          ),
        );
      }
    }
    this.turnRecords.delete(turnId);
  }

  #hasPendingTurnStart() {
    return [...this.pending.values()].some((pending) => pending.method === "turn/start");
  }

  #pruneOrphanedTurnRecords() {
    if (this.#hasPendingTurnStart()) return;
    for (const [turnId, record] of this.turnRecords) {
      if (
        record.waiters.length === 0 &&
        !this.unclaimedTurnIds.has(turnId)
      ) {
        this.turnRecords.delete(turnId);
      }
    }
  }

  #handleExit(error, child = this.child) {
    if (!this.child || this.child !== child) return;
    this.child = null;
    this.initialized = false;
    const wrapped = new CodexBridgeError("Codex app-server stopped.", {
      code: "CODEX_UNAVAILABLE",
      cause: error,
    });

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(wrapped);
    }
    this.pending.clear();

    for (const record of this.turnRecords.values()) {
      for (const waiter of record.waiters) {
        clearTimeout(waiter.timer);
        waiter.cleanup?.();
        waiter.reject(wrapped);
      }
    }
    this.turnRecords.clear();
    this.unclaimedTurnIds.clear();
    this.ignoredTurnIds.clear();
    this.emit("stopped", wrapped);
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // The process is already unavailable.
      }
    }
    this.#cleanupRuntimeEnvironment();
  }

  #cleanupRuntimeEnvironment() {
    this.runtimeEnvironment?.cleanup();
    this.runtimeEnvironment = null;
  }

  #writeMessage(message) {
    const child = this.child;
    if (!child?.stdin?.writable) {
      throw new CodexBridgeError("Codex app-server is not running.", {
        code: "CODEX_UNAVAILABLE",
      });
    }

    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.#handleExit(error, child);
      });
    } catch (error) {
      this.#handleExit(error, child);
      throw new CodexBridgeError("Could not write to Codex app-server.", {
        code: "CODEX_UNAVAILABLE",
        cause: error,
      });
    }
  }

  #ignoreTurn(turnId) {
    this.turnRecords.delete(turnId);
    this.ignoredTurnIds.add(turnId);
    while (this.ignoredTurnIds.size > 256) {
      this.ignoredTurnIds.delete(this.ignoredTurnIds.values().next().value);
    }
  }

  #requestWithoutStart(method, params, timeoutMs, signal) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(
        new CodexBridgeError("Codex app-server is not running.", { code: "CODEX_UNAVAILABLE" }),
      );
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const rejectPending = (error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.cleanup?.();
        this.#pruneOrphanedTurnRecords();
        pending.reject(error);
      };
      const onAbort = () => {
        rejectPending(
          new CodexBridgeError(`Codex request ${method} was interrupted.`, {
            code: "CODEX_ABORTED",
          }),
        );
      };
      const timer = setTimeout(() => {
        rejectPending(
          new CodexBridgeError(`Codex request ${method} timed out.`, {
            code: "CODEX_TIMEOUT",
          }),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.#writeMessage({ id, method, params });
      } catch (error) {
        rejectPending(error);
      }
    });
  }

  async request(
    method,
    params = {},
    { timeoutMs = this.requestTimeoutMs, signal } = {},
  ) {
    await this.start();
    return this.#requestWithoutStart(method, params, timeoutMs, signal);
  }

  notify(method, params) {
    this.#writeMessage(params === undefined ? { method } : { method, params });
  }

  async getAccount() {
    const result = await this.request("account/read", { refreshToken: false });
    return result?.account ?? null;
  }

  async startThread(params) {
    return this.request("thread/start", lockThreadStartParams(params));
  }

  async unsubscribeThread(threadId) {
    if (!this.child || !this.initialized) return;
    return this.#requestWithoutStart(
      "thread/unsubscribe",
      { threadId },
      this.requestTimeoutMs,
    );
  }

  async runTurn(params, { timeoutMs, signal } = {}) {
    timeoutMs ??= this.requestTimeoutMs;
    if (signal?.aborted) {
      throw new CodexBridgeError("Codex turn was interrupted.", {
        code: "CODEX_ABORTED",
      });
    }
    const deadline = Date.now() + timeoutMs;
    const lockedParams = lockTurnStartParams(params);
    let result;
    try {
      result = await this.request("turn/start", lockedParams, { timeoutMs, signal });
    } catch (error) {
      if (error?.code === "CODEX_TIMEOUT" || error?.code === "CODEX_ABORTED") {
        this.close();
      }
      throw error;
    }
    const turnId = result?.turn?.id;
    if (typeof turnId !== "string") {
      throw new CodexBridgeError("Codex did not return a turn id.", {
        code: "CODEX_PROTOCOL_ERROR",
      });
    }
    try {
      this.unclaimedTurnIds.delete(turnId);
      return await this.waitForTurn(turnId, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal,
      });
    } catch (error) {
      if (error?.code === "CODEX_TIMEOUT" || error?.code === "CODEX_ABORTED") {
        this.#ignoreTurn(turnId);
        try {
          await this.#requestWithoutStart(
            "turn/interrupt",
            { threadId: lockedParams.threadId, turnId },
            Math.min(5_000, this.requestTimeoutMs),
          );
        } catch {
          // The original timeout remains the useful error for the caller.
        }
      }
      throw error;
    }
  }

  waitForTurn(turnId, { timeoutMs, signal } = {}) {
    const record = this.turnRecords.get(turnId) ?? {
      deltas: [],
      messages: [],
      completion: null,
      waiters: [],
    };
    this.turnRecords.set(turnId, record);

    return new Promise((resolve, reject) => {
      let waiter;
      const removeWaiter = () => {
        const current = this.turnRecords.get(turnId);
        if (!current || !waiter) return;
        current.waiters = current.waiters.filter((candidate) => candidate !== waiter);
        if (current.waiters.length === 0 && !current.completion) this.#ignoreTurn(turnId);
      };
      const onAbort = () => {
        clearTimeout(waiter.timer);
        waiter.cleanup?.();
        removeWaiter();
        reject(
          new CodexBridgeError("Codex turn was interrupted.", {
            code: "CODEX_ABORTED",
          }),
        );
      };
      const timer = setTimeout(() => {
        waiter.cleanup?.();
        removeWaiter();
        reject(
          new CodexBridgeError("Codex took too long to answer.", {
            code: "CODEX_TIMEOUT",
          }),
        );
      }, timeoutMs);
      waiter = {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      record.waiters.push(waiter);
      if (signal?.aborted) onAbort();
      if (record.completion) this.#settleTurnRecord(turnId, record);
    });
  }

  close() {
    const child = this.child;
    if (!child) {
      this.#cleanupRuntimeEnvironment();
      return;
    }
    this.#handleExit(new Error("Codex app-server client closed."), child);
  }
}
