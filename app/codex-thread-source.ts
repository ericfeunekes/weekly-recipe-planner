import type {
  CodexArchiveThreadRequest,
  CodexInteraction,
  CodexInteractionListRequest,
  CodexInteractionResponse,
  CodexInterruptTurnRequest,
  CodexNewThreadRequest,
  CodexRespondInteractionRequest,
  CodexSelectThreadRequest,
  CodexSendTurnRequest,
  CodexThreadListRequest,
  CodexThreadListResponse,
  CodexThreadMutationResponse,
  CodexThreadReadResponse,
  CodexThreadSelection,
  CodexThreadSummary,
  CodexThreadView,
} from "../lib/codex-thread-contract.ts";

import {
  CodexThreadClientError,
  archiveCodexThread,
  createCodexRequestId,
  interruptCodexTurn,
  listCodexInteractions,
  listCodexThreads,
  newCodexThread,
  readCodexThread,
  respondToCodexInteraction,
  selectCodexThread,
  sendCodexTurn,
  waitForCodexEvents,
} from "./codex-thread-api.ts";
import { createPreviewCodexThreadSource, type PreviewScenario } from "./codex-thread-fixture.ts";

export type CodexThreadSourceStatus =
  | "loading"
  | "ready"
  | "empty"
  | "selected_unmaterialized"
  | "materializing"
  | "selected_unavailable"
  | "runtime_unavailable";

export type CodexThreadSnapshot = {
  mode: "native" | "preview";
  status: CodexThreadSourceStatus;
  threads: CodexThreadSummary[];
  selection: CodexThreadSelection;
  thread: CodexThreadView | null;
  interactions: CodexInteraction[];
  connectionEpoch: string | null;
  activityRevision: number;
  message: string | null;
};

export type CodexThreadSource = {
  readonly mode: "native" | "preview";
  start(): Promise<CodexThreadSnapshot>;
  stop(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): CodexThreadSnapshot;
  load(): Promise<CodexThreadSnapshot>;
  list(request?: CodexThreadListRequest): Promise<CodexThreadListResponse>;
  select(threadId: string): Promise<CodexThreadSnapshot>;
  newThread(): Promise<CodexThreadSnapshot>;
  archive(threadId: string): Promise<CodexThreadSnapshot>;
  send(message: string): Promise<CodexThreadSnapshot>;
  interrupt(turnId: string): Promise<CodexThreadSnapshot>;
  answer(interactionId: string, response: CodexInteractionResponse): Promise<CodexThreadSnapshot>;
  refreshInteractions(request?: CodexInteractionListRequest): Promise<CodexThreadSnapshot>;
  readWorker(workerThreadId: string): Promise<CodexThreadReadResponse>;
  /** Compatibility seam for focused callers; the source-owned loop uses the same logic continuously. */
  waitForChange(signal: AbortSignal): Promise<CodexThreadSnapshot | null>;
};

type MutationFamily = "new" | "select" | "archive" | "send" | "interrupt" | "interaction";

type MutationAttempt<TResult> = {
  semanticKey: string;
  body: unknown;
  state: "submitting" | "ambiguous";
  inFlight: Promise<TResult> | null;
};

const SUBSCRIPTION_RECOVERY_DELAY_MS = 500;
const MAX_CONSISTENT_LOAD_ATTEMPTS = 3;

const loadingSnapshot = (mode: CodexThreadSnapshot["mode"]): CodexThreadSnapshot => ({
  mode,
  status: "loading",
  threads: [],
  selection: { threadId: null, revision: 0 },
  thread: null,
  interactions: [],
  connectionEpoch: null,
  activityRevision: 0,
  message: null,
});

function unavailableSnapshot(
  prior: CodexThreadSnapshot,
  message: string,
): CodexThreadSnapshot {
  return {
    ...prior,
    mode: "native",
    status: "runtime_unavailable",
    thread: null,
    interactions: [],
    message,
  };
}

function selectedUnavailableSnapshot(options: {
  threads: CodexThreadSummary[];
  selection: CodexThreadSelection;
  connectionEpoch: string;
  activityRevision: number;
}): CodexThreadSnapshot {
  return {
    mode: "native",
    status: "selected_unavailable",
    threads: options.threads,
    selection: options.selection,
    thread: null,
    interactions: [],
    connectionEpoch: options.connectionEpoch,
    activityRevision: options.activityRevision,
    message: "The selected task is no longer available. Choose another task or start a new one.",
  };
}

function unmaterializedSnapshot(options: {
  threads: CodexThreadSummary[];
  selection: CodexThreadSelection;
  connectionEpoch: string;
  activityRevision: number;
  status?: "selected_unmaterialized" | "materializing";
}): CodexThreadSnapshot {
  return {
    mode: "native",
    status: options.status ?? "selected_unmaterialized",
    threads: options.threads,
    selection: options.selection,
    thread: null,
    interactions: [],
    connectionEpoch: options.connectionEpoch,
    activityRevision: options.activityRevision,
    message: null,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof CodexThreadClientError && error.code === "NOT_FOUND";
}

function isAbort(error: unknown): boolean {
  return error !== null && typeof error === "object" && "name" in error && error.name === "AbortError";
}

function isAmbiguousMutationFailure(error: unknown): boolean {
  return error instanceof CodexThreadClientError &&
    (error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE" || error.status >= 500);
}

function operationConflict(message: string): CodexThreadClientError {
  return new CodexThreadClientError({
    status: 409,
    code: "TURN_CONFLICT",
    message,
  });
}

function invalidProjection(message: string): CodexThreadClientError {
  return new CodexThreadClientError({
    status: 0,
    code: "INVALID_RESPONSE",
    message,
  });
}

function summaryForSelection(
  threads: readonly CodexThreadSummary[],
  selection: CodexThreadSelection,
): CodexThreadSummary | null {
  if (selection.threadId === null) return null;
  return threads.find((thread) => thread.id === selection.threadId) ?? null;
}

function replaceSummary(
  threads: readonly CodexThreadSummary[],
  summary: CodexThreadSummary,
): CodexThreadSummary[] {
  const without = threads.filter((thread) => thread.id !== summary.id);
  return [summary, ...without];
}

function delayWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

class NativeCodexThreadSource implements CodexThreadSource {
  readonly mode = "native" as const;
  private snapshot: CodexThreadSnapshot = loadingSnapshot("native");
  private readonly listeners = new Set<() => void>();
  private readonly attempts = new Map<MutationFamily, MutationAttempt<unknown>>();
  private lifecycleController: AbortController | null = null;
  private lifecycleGeneration = 0;
  private projectionGeneration = 0;
  private pollEpoch: string | null = null;
  private pollRevision = 0;

  getSnapshot(): CodexThreadSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<CodexThreadSnapshot> {
    if (this.lifecycleController !== null) return this.snapshot;
    const controller = new AbortController();
    this.lifecycleController = controller;
    const generation = ++this.lifecycleGeneration;
    const loaded = await this.loadForGeneration(generation);
    if (!controller.signal.aborted && this.lifecycleController === controller) {
      void this.runSubscription(generation, controller.signal);
    }
    return loaded;
  }

  stop(): void {
    const controller = this.lifecycleController;
    if (controller === null) return;
    this.lifecycleController = null;
    this.lifecycleGeneration += 1;
    controller.abort();
  }

  async load(): Promise<CodexThreadSnapshot> {
    return this.loadForGeneration(null);
  }

  private async loadForGeneration(
    lifecycleGeneration: number | null,
  ): Promise<CodexThreadSnapshot> {
    const projectionGeneration = ++this.projectionGeneration;
    let latestList: CodexThreadListResponse | null = null;
    try {
      for (let attempt = 0; attempt < MAX_CONSISTENT_LOAD_ATTEMPTS; attempt += 1) {
        const list = await listCodexThreads();
        latestList = list;
        if (list.selection.threadId === null) {
          return this.commitIfCurrent(projectionGeneration, lifecycleGeneration, {
            mode: "native",
            status: "empty",
            threads: list.threads,
            selection: list.selection,
            thread: null,
            interactions: [],
            connectionEpoch: list.connectionEpoch,
            activityRevision: list.activityRevision,
            message: null,
          });
        }

        const selectedSummary = summaryForSelection(list.threads, list.selection);
        if (selectedSummary?.status.state === "not_loaded") {
          return this.commitIfCurrent(projectionGeneration, lifecycleGeneration, unmaterializedSnapshot({
            threads: list.threads,
            selection: list.selection,
            connectionEpoch: list.connectionEpoch,
            activityRevision: list.activityRevision,
          }));
        }

        try {
          const read = await readCodexThread(list.selection.threadId);
          if (
            read.connectionEpoch !== list.connectionEpoch ||
            read.selection.threadId !== list.selection.threadId ||
            read.thread.id !== list.selection.threadId ||
            read.selection.revision < list.selection.revision
          ) {
            continue;
          }
          return this.commitIfCurrent(projectionGeneration, lifecycleGeneration, {
            mode: "native",
            status: "ready",
            threads: list.threads,
            selection: read.selection,
            thread: read.thread,
            interactions: read.interactions,
            connectionEpoch: read.connectionEpoch,
            activityRevision: read.activityRevision,
            message: null,
          });
        } catch (error) {
          if (isNotFound(error)) {
            return this.commitIfCurrent(projectionGeneration, lifecycleGeneration, selectedUnavailableSnapshot({
              threads: list.threads,
              selection: list.selection,
              connectionEpoch: list.connectionEpoch,
              activityRevision: list.activityRevision,
            }));
          }
          throw error;
        }
      }
      throw invalidProjection("Codex selection changed repeatedly while loading the active task.");
    } catch (error) {
      if (isAbort(error)) throw error;
      const message = error instanceof Error ? error.message : "The Codex thread service is unavailable.";
      const prior = latestList === null ? this.snapshot : {
        ...this.snapshot,
        threads: latestList.threads,
        selection: latestList.selection,
        connectionEpoch: latestList.connectionEpoch,
        activityRevision: latestList.activityRevision,
      };
      return this.commitIfCurrent(
        projectionGeneration,
        lifecycleGeneration,
        unavailableSnapshot(prior, message),
      );
    }
  }

  list(request: CodexThreadListRequest = {}): Promise<CodexThreadListResponse> {
    return listCodexThreads(request);
  }

  async select(threadId: string): Promise<CodexThreadSnapshot> {
    const response = await this.runMutation(
      "select",
      threadId,
      () => ({
        requestId: createCodexRequestId(),
        threadId,
        expectedSelectionRevision: this.snapshot.selection.revision,
      } satisfies CodexSelectThreadRequest),
      (request) => selectCodexThread(request as CodexSelectThreadRequest),
    );
    return this.acceptThreadMutation(response as CodexThreadMutationResponse, false);
  }

  async newThread(): Promise<CodexThreadSnapshot> {
    const response = await this.runMutation(
      "new",
      "new",
      () => ({
        requestId: createCodexRequestId(),
        expectedSelectionRevision: this.snapshot.selection.revision,
      } satisfies CodexNewThreadRequest),
      (request) => newCodexThread(request as CodexNewThreadRequest),
    );
    return this.acceptThreadMutation(response as CodexThreadMutationResponse, true);
  }

  async archive(threadId: string): Promise<CodexThreadSnapshot> {
    const response = await this.runMutation(
      "archive",
      threadId,
      () => ({
        requestId: createCodexRequestId(),
        threadId,
        expectedSelectionRevision: this.snapshot.selection.revision,
      } satisfies CodexArchiveThreadRequest),
      (request) => archiveCodexThread(request as CodexArchiveThreadRequest),
    );
    void response;
    return this.load();
  }

  async send(message: string): Promise<CodexThreadSnapshot> {
    const trimmed = message.trim();
    if (!trimmed) return this.snapshot;
    let current = this.snapshot;
    if (current.status === "empty") current = await this.newThread();
    const threadId = current.status === "ready" && current.thread !== null
      ? current.thread.id
      : (current.status === "selected_unmaterialized" && current.selection.threadId !== null)
          ? current.selection.threadId
          : null;
    if (threadId === null) {
      throw new CodexThreadClientError({
        status: 0,
        code: "CODEX_UNAVAILABLE",
        message: current.message ?? "Codex cannot accept a message right now.",
      });
    }
    const semanticKey = JSON.stringify([threadId, trimmed]);
    await this.runMutation(
      "send",
      semanticKey,
      () => ({
        requestId: createCodexRequestId(),
        threadId,
        expectedSelectionRevision: current.selection.revision,
        clientUserMessageId: createCodexRequestId(),
        message: trimmed,
      } satisfies CodexSendTurnRequest),
      (request) => sendCodexTurn(request as CodexSendTurnRequest),
      (response) => {
        if (response.threadId !== threadId) {
          throw invalidProjection("Codex acknowledged the message on a different task.");
        }
        return response;
      },
    );
    if (current.status === "selected_unmaterialized") {
      if (current.connectionEpoch === null) {
        throw invalidProjection("Codex allocated a task without runtime coordinates.");
      }
      this.commit(unmaterializedSnapshot({
        threads: current.threads,
        selection: current.selection,
        connectionEpoch: current.connectionEpoch,
        activityRevision: current.activityRevision,
        status: "materializing",
      }));
    }
    return this.load();
  }

  async interrupt(turnId: string): Promise<CodexThreadSnapshot> {
    const current = this.requireReadyThread("interrupt a turn");
    const semanticKey = JSON.stringify([current.thread.id, turnId]);
    await this.runMutation(
      "interrupt",
      semanticKey,
      () => ({
        requestId: createCodexRequestId(),
        threadId: current.thread.id,
        expectedSelectionRevision: current.selection.revision,
        turnId,
      } satisfies CodexInterruptTurnRequest),
      (request) => interruptCodexTurn(request as CodexInterruptTurnRequest),
      (response) => {
        if (response.threadId !== current.thread.id || response.turnId !== turnId) {
          throw invalidProjection("Codex acknowledged a different interrupted turn.");
        }
        return response;
      },
    );
    return this.load();
  }

  async answer(
    interactionId: string,
    response: CodexInteractionResponse,
  ): Promise<CodexThreadSnapshot> {
    const current = this.requireReadyThread("answer a question");
    const semanticKey = JSON.stringify([current.thread.id, interactionId, response]);
    await this.runMutation(
      "interaction",
      semanticKey,
      () => ({
        requestId: createCodexRequestId(),
        threadId: current.thread.id,
        expectedSelectionRevision: current.selection.revision,
        interactionId,
        response,
      } satisfies CodexRespondInteractionRequest),
      (request) => respondToCodexInteraction(request as CodexRespondInteractionRequest),
      (result) => {
        if (result.interactionId !== interactionId) {
          throw invalidProjection("Codex acknowledged a different interaction.");
        }
        return result;
      },
    );
    return this.load();
  }

  async refreshInteractions(
    request: CodexInteractionListRequest = {},
  ): Promise<CodexThreadSnapshot> {
    const response = await listCodexInteractions(request);
    if (
      request.threadId !== undefined &&
      request.threadId !== this.snapshot.selection.threadId
    ) {
      return this.snapshot;
    }
    if (
      this.snapshot.connectionEpoch !== null &&
      response.connectionEpoch !== this.snapshot.connectionEpoch
    ) {
      return this.load();
    }
    return this.commit({
      ...this.snapshot,
      interactions: response.interactions,
      connectionEpoch: response.connectionEpoch,
      activityRevision: response.activityRevision,
    });
  }

  async readWorker(workerThreadId: string): Promise<CodexThreadReadResponse> {
    const before = this.snapshot.selection;
    const response = await readCodexThread(workerThreadId);
    if (response.thread.threadKind !== "worker" || response.thread.parentThreadId === null) {
      throw invalidProjection("Codex returned a non-worker task for a worker read.");
    }
    if (
      response.selection.threadId !== before.threadId ||
      response.selection.revision !== before.revision
    ) {
      throw invalidProjection("Reading a Codex worker changed the selected task.");
    }
    return response;
  }

  async waitForChange(signal: AbortSignal): Promise<CodexThreadSnapshot | null> {
    while (!signal.aborted) {
      const current = this.snapshot;
      if (current.connectionEpoch === null) return null;
      const event = await waitForCodexEvents({
        connectionEpoch: this.pollEpoch ?? current.connectionEpoch,
        afterRevision: this.pollRevision,
        threadId: current.selection.threadId ?? undefined,
        signal,
      });
      if (event.connectionEpoch === (this.pollEpoch ?? current.connectionEpoch)) {
        this.pollRevision = Math.max(this.pollRevision, event.revision);
      }
      if (!event.changed && !event.resyncRequired && event.connectionEpoch === current.connectionEpoch) {
        continue;
      }
      return this.load();
    }
    return null;
  }

  private async runSubscription(generation: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && generation === this.lifecycleGeneration) {
      try {
        if (this.snapshot.connectionEpoch === null || this.snapshot.status === "runtime_unavailable") {
          await delayWithAbort(SUBSCRIPTION_RECOVERY_DELAY_MS, signal);
          await this.loadForGeneration(generation);
          continue;
        }
        const event = await waitForCodexEvents({
          connectionEpoch: this.pollEpoch ?? this.snapshot.connectionEpoch,
          afterRevision: this.pollRevision,
          threadId: this.snapshot.selection.threadId ?? undefined,
          signal,
        });
        if (signal.aborted || generation !== this.lifecycleGeneration) return;
        const requestEpoch = this.pollEpoch ?? this.snapshot.connectionEpoch;
        if (event.connectionEpoch === requestEpoch) {
          this.pollRevision = Math.max(this.pollRevision, event.revision);
        }
        if (
          event.connectionEpoch !== this.snapshot.connectionEpoch ||
          event.resyncRequired ||
          event.changed
        ) {
          await this.loadForGeneration(generation);
        }
      } catch (error) {
        if (isAbort(error) || signal.aborted || generation !== this.lifecycleGeneration) return;
        await delayWithAbort(SUBSCRIPTION_RECOVERY_DELAY_MS, signal).catch(() => undefined);
        if (signal.aborted || generation !== this.lifecycleGeneration) return;
        await this.loadForGeneration(generation);
      }
    }
  }

  private requireReadyThread(action: string): CodexThreadSnapshot & { thread: CodexThreadView } {
    const current = this.snapshot;
    if (current.status !== "ready" || current.thread === null) {
      throw new CodexThreadClientError({
        status: 0,
        code: "CODEX_UNAVAILABLE",
        message: current.message ?? `Codex cannot ${action} right now.`,
      });
    }
    return current as CodexThreadSnapshot & { thread: CodexThreadView };
  }

  private async acceptThreadMutation(
    response: CodexThreadMutationResponse,
    definitelyUnmaterialized: boolean,
  ): Promise<CodexThreadSnapshot> {
    if (response.selection.threadId === null || response.thread === null) return this.load();
    if (response.selection.threadId !== response.thread.id) {
      // A replayed thread-start receipt deliberately reports the created root
      // alongside the current shared selection. Navigation remains available
      // while creation is ambiguous, so the selected projection wins.
      return this.load();
    }
    if (definitelyUnmaterialized || response.thread.status.state === "not_loaded") {
      this.projectionGeneration += 1;
      return this.commit(unmaterializedSnapshot({
        threads: replaceSummary(this.snapshot.threads, response.thread),
        selection: response.selection,
        connectionEpoch: response.connectionEpoch,
        activityRevision: response.activityRevision,
      }));
    }
    return this.load();
  }

  private async runMutation<TResult>(
    family: MutationFamily,
    semanticKey: string,
    createBody: () => unknown,
    submit: (body: unknown) => Promise<TResult>,
    validate: (result: TResult) => TResult = (result) => result,
  ): Promise<TResult> {
    const existing = this.attempts.get(family) as MutationAttempt<TResult> | undefined;
    if (existing !== undefined && existing.semanticKey !== semanticKey) {
      throw operationConflict(`Resolve the pending Codex ${family} request before starting another one.`);
    }
    const attempt = existing ?? {
      semanticKey,
      body: createBody(),
      state: "submitting" as const,
      inFlight: null,
    };
    if (existing === undefined) this.attempts.set(family, attempt as MutationAttempt<unknown>);
    if (attempt.inFlight !== null) return attempt.inFlight;
    attempt.state = "submitting";
    const inFlight = (async () => {
      try {
        const result = validate(await submit(attempt.body));
        if (this.attempts.get(family) === attempt) this.attempts.delete(family);
        return result;
      } catch (error) {
        attempt.inFlight = null;
        if (isAmbiguousMutationFailure(error)) {
          attempt.state = "ambiguous";
        } else if (this.attempts.get(family) === attempt) {
          this.attempts.delete(family);
        }
        throw error;
      }
    })();
    attempt.inFlight = inFlight;
    return inFlight;
  }

  private commitIfCurrent(
    projectionGeneration: number,
    lifecycleGeneration: number | null,
    snapshot: CodexThreadSnapshot,
  ): CodexThreadSnapshot {
    if (
      projectionGeneration !== this.projectionGeneration ||
      (lifecycleGeneration !== null && lifecycleGeneration !== this.lifecycleGeneration)
    ) return this.snapshot;
    return this.commit(snapshot);
  }

  private commit(snapshot: CodexThreadSnapshot): CodexThreadSnapshot {
    this.snapshot = snapshot;
    if (snapshot.connectionEpoch !== this.pollEpoch) {
      this.pollEpoch = snapshot.connectionEpoch;
      this.pollRevision = snapshot.activityRevision;
    } else {
      this.pollRevision = Math.max(this.pollRevision, snapshot.activityRevision);
    }
    for (const listener of this.listeners) listener();
    return snapshot;
  }
}

export function isDevelopmentCodexPreview(
  search: string,
  development: boolean,
): PreviewScenario | null {
  if (!development) return null;
  const value = new URLSearchParams(search).get("codexPreview");
  if (value === "1") return "default";
  if (value === "activity-burst") return "activity-burst";
  return null;
}

export function createCodexThreadSource(options: {
  search?: string;
  development?: boolean;
} = {}): CodexThreadSource {
  const search = options.search ?? (typeof window === "undefined" ? "" : window.location.search);
  const development = options.development ?? process.env.NODE_ENV === "development";
  const preview = isDevelopmentCodexPreview(search, development);
  return preview ? createPreviewCodexThreadSource(preview) : new NativeCodexThreadSource();
}
