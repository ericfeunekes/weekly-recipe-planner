import { createHash, randomUUID } from "node:crypto";

import {
  CODEX_CURSOR_MAX_LENGTH,
  CODEX_THREAD_LIST_LIMIT_DEFAULT,
  type CodexApiErrorCode,
  type CodexArchiveThreadRequest,
  type CodexEventsRequest,
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
  type CodexThreadSelection,
  type CodexThreadSummary,
  type CodexTurnMutationResponse,
} from "../../lib/codex-thread-contract.ts";
import {
  projectCodexThread,
  projectCodexThreadSummary,
} from "./activity-projection.ts";
import {
  NATIVE_CODEX_THREAD_SOURCE,
  NativeCodexSession,
  NativeCodexSessionError,
} from "./native-session.ts";
import {
  NATIVE_THREAD_START_ROOT_ID_LIMIT,
  type NativeMutationReceipt,
  type NativeThreadStartAdmission,
  type SqliteCodexThreadStore,
} from "../store/codex-thread-store.ts";

const MAX_REPLAY_ENTRIES = 256;
const MAX_ANCESTRY_DEPTH = 64;
const ROOT_RECONCILIATION_PAGE_SIZE = 100;
const MAX_ROOT_RECONCILIATION_PAGES = 64;
const DEFAULT_SELECTION_PAGE_SIZE = 100;
const MAX_DEFAULT_SELECTION_PAGES = 64;
const ARCHIVED_ROOT_PAGE_SIZE = 100;
const MAX_ARCHIVED_ROOT_PAGES = 64;
const DEFAULT_TURN_HISTORY_CONVERGENCE_WAIT_MS = 5_000;
const MAX_TURN_HISTORY_CONVERGENCE_WAIT_MS = 30_000;
const DEFAULT_CLIENT_MESSAGE_COMPLETION_WAIT_MS = 90_000;
const MAX_CLIENT_MESSAGE_COMPLETION_WAIT_MS = 300_000;
const MIN_TURN_HISTORY_WAIT_SLICE_MS = 10;
const MAX_TURN_HISTORY_WAIT_SLICE_MS = 250;

type ReplayEntry = {
  payloadHash: string;
  promise: Promise<unknown>;
  status:
    | "pending"
    | "fulfilled"
    | "identity_rejection"
    | "retryable_rejection"
    | "ambiguous_tombstone"
    | "rejected";
};

export type NativeCodexThreadServiceOptions = {
  session: NativeCodexSession;
  store: SqliteCodexThreadStore;
  now?: () => number;
  /** Testable hard cap; production always uses the default maximum. */
  replayLimit?: number;
  /** Testable convergence budget; production uses the bounded default. */
  turnHistoryConvergenceWaitMs?: number;
  /** Testable first-message lifecycle budget; production uses the bounded default. */
  clientMessageCompletionWaitMs?: number;
  /** Stable only for this live service instance; defaults to a random UUID. */
  admissionOwnerId?: string;
  /**
   * Adopt admissions left by a crashed instance. Set only after the caller has
   * established the planner runtime's exclusive owner boundary.
   */
  recoverAdmissionsOnStartup?: boolean;
};

export class CodexThreadServiceError extends Error {
  readonly code: CodexApiErrorCode;
  readonly httpStatus: number;

  constructor(
    code: CodexApiErrorCode,
    message: string,
    httpStatus: number,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CodexThreadServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNativeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    value.trim().length > 0 && !value.includes("\0");
}

function isNativeCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= CODEX_CURSOR_MAX_LENGTH && value.trim().length > 0 &&
    !value.includes("\0");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function selectionView(value: ReturnType<SqliteCodexThreadStore["readSelection"]>): CodexThreadSelection {
  return { threadId: value.selectedThreadId, revision: value.revision };
}

function statusForCode(code: CodexApiErrorCode) {
  if (code === "NOT_FOUND") return 404;
  if (code === "CODEX_UNAVAILABLE" || code === "CODEX_INCOMPATIBLE") return 503;
  if (code === "INTERNAL_ERROR") return 500;
  if (code === "INVALID_REQUEST") return 400;
  return 409;
}

function serviceError(code: CodexApiErrorCode, message: string, cause?: unknown) {
  return new CodexThreadServiceError(
    code,
    message,
    statusForCode(code),
    cause === undefined ? {} : { cause },
  );
}

function isMissingThreadResponse(message: string) {
  const normalized = message.trim().toLowerCase();
  return normalized.includes("thread not found") ||
    normalized.includes("no rollout found for thread id") ||
    normalized.includes("no rollout found for conversation id") ||
    normalized.includes("invalid thread id");
}

function isThreadNotLoadedReadResponse(
  method: string,
  code: number,
  message: string,
  expectedThreadId: string,
) {
  return method === "thread/read" && code === -32600 &&
    message.trim() === `thread not loaded: ${expectedThreadId}`;
}

const UNMATERIALIZED_THREAD_READ_SUFFIX =
  " is not materialized yet; includeTurns is unavailable before first user message";

function isUnmaterializedThreadReadResponse(
  method: string,
  code: number,
  message: string,
  expectedThreadId?: string,
) {
  if (method !== "thread/read" || code !== -32600) return false;
  const normalized = message.trim();
  if (expectedThreadId !== undefined) {
    return normalized === `thread ${expectedThreadId}${UNMATERIALIZED_THREAD_READ_SUFFIX}`;
  }
  return normalized.startsWith("thread ") &&
    normalized.length > `thread ${UNMATERIALIZED_THREAD_READ_SUFFIX}`.length &&
    normalized.endsWith(UNMATERIALIZED_THREAD_READ_SUFFIX);
}

function isTurnConflictResponse(method: string, message: string) {
  if (method !== "turn/steer" && method !== "turn/interrupt") return false;
  const normalized = message.toLowerCase();
  return normalized.includes("no active turn") ||
    normalized.includes("expected active turn id") ||
    normalized.includes("active turn not steerable") ||
    normalized.includes("cannot steer");
}

function mapRejectedNativeRequest(error: NativeCodexSessionError) {
  const response = error.responseError;
  const method = error.requestMethod;
  if (response === null || method === null) {
    return serviceError("CODEX_INCOMPATIBLE", "Codex returned an invalid error response.", error);
  }
  if (isUnmaterializedThreadReadResponse(method, response.code, response.message)) {
    return serviceError(
      "CODEX_UNAVAILABLE",
      "Codex has allocated this conversation but has not materialized its first message yet.",
      error,
    );
  }
  if (response.code === -32600 && isMissingThreadResponse(response.message)) {
    return serviceError("NOT_FOUND", "That Codex conversation is not available.", error);
  }
  if (response.code === -32600 && isTurnConflictResponse(method, response.message)) {
    return serviceError("TURN_CONFLICT", "That Codex turn is no longer active.", error);
  }
  if (response.code === -32700 || response.code === -32600 ||
      response.code === -32601 || response.code === -32602) {
    return serviceError(
      "CODEX_INCOMPATIBLE",
      "Codex app-server rejected the planner protocol contract.",
      error,
    );
  }
  if (response.code === -32603 || (response.code >= -32099 && response.code <= -32000)) {
    return serviceError("CODEX_UNAVAILABLE", "Codex is temporarily unavailable.", error);
  }
  return serviceError("CODEX_INCOMPATIBLE", "Codex returned an unknown error response.", error);
}

function isUnmaterializedThreadReadError(error: unknown, expectedThreadId: string) {
  if (!(error instanceof CodexThreadServiceError) ||
      !(error.cause instanceof NativeCodexSessionError)) return false;
  const response = error.cause.responseError;
  const method = error.cause.requestMethod;
  return response !== null && method !== null &&
    isUnmaterializedThreadReadResponse(
      method,
      response.code,
      response.message,
      expectedThreadId,
    );
}

function isThreadNotLoadedReadError(error: unknown, expectedThreadId: string) {
  if (!(error instanceof CodexThreadServiceError) ||
      !(error.cause instanceof NativeCodexSessionError)) return false;
  const response = error.cause.responseError;
  const method = error.cause.requestMethod;
  return response !== null && method !== null &&
    isThreadNotLoadedReadResponse(
      method,
      response.code,
      response.message,
      expectedThreadId,
    );
}

function rootThreadAtFixedCwd(value: unknown, fixedCwd: string) {
  return isRecord(value) && isNativeIdentifier(value.id) && value.cwd === fixedCwd &&
    value.ephemeral === false &&
    (value.parentThreadId === null || value.parentThreadId === undefined) &&
    value.threadSource === NATIVE_CODEX_THREAD_SOURCE;
}

function threadResult(value: unknown) {
  return isRecord(value) && isRecord(value.thread) ? value.thread : null;
}

function authorizedRootThreadResult(
  value: unknown,
  fixedCwd: string,
): Record<string, unknown> {
  const activePermissionProfile = isRecord(value) && isRecord(value.activePermissionProfile)
    ? value.activePermissionProfile
    : null;
  const sandbox = isRecord(value) && isRecord(value.sandbox) ? value.sandbox : null;
  const thread = threadResult(value);
  if (!isRecord(value) || value.cwd !== fixedCwd || value.approvalPolicy !== "never" ||
      value.approvalsReviewer !== "user" || activePermissionProfile?.id !== ":read-only" ||
      activePermissionProfile?.extends !== null || sandbox?.type !== "readOnly" ||
      sandbox?.networkAccess !== false || !isRecord(thread) ||
      !rootThreadAtFixedCwd(thread, fixedCwd)) {
    throw serviceError(
      "CODEX_INCOMPATIBLE",
      "Codex returned a native thread with incompatible execution authority.",
    );
  }
  return thread as Record<string, unknown>;
}

function turnResultId(value: unknown) {
  return isRecord(value) && isRecord(value.turn) && typeof value.turn.id === "string"
    ? value.turn.id
    : null;
}

function steerResultId(value: unknown) {
  return isRecord(value) && typeof value.turnId === "string" ? value.turnId : null;
}

function activeTurnId(thread: Record<string, unknown>) {
  if (!isRecord(thread.status) || thread.status.type !== "active") return null;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (isRecord(turn) && typeof turn.id === "string" && turn.status === "inProgress") {
      return turn.id;
    }
  }
  return null;
}

function clientMessageTurnMapping(thread: Record<string, unknown>, clientId: string):
  | { status: "absent" }
  | { status: "unique"; turnId: string }
  | { status: "ambiguous" } {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const matches: string[] = [];
  for (const turn of turns) {
    if (!isRecord(turn) || typeof turn.id !== "string" || !Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      if (isRecord(item) && item.type === "userMessage" && item.clientId === clientId) {
        matches.push(turn.id);
      }
    }
  }
  if (matches.length === 0) return { status: "absent" };
  if (matches.length !== 1) return { status: "ambiguous" };
  return { status: "unique", turnId: matches[0] };
}

function createdAtSeconds(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function isAmbiguousNativeMutationFailure(error: unknown) {
  return error instanceof CodexThreadServiceError &&
    (error.code === "CODEX_UNAVAILABLE" || error.code === "CODEX_INCOMPATIBLE");
}

class AsyncKeyLock {
  #tails = new Map<string, Promise<void>>();

  async run<Result>(key: string, work: () => Promise<Result>): Promise<Result> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

export class NativeCodexThreadService {
  readonly #options: NativeCodexThreadServiceOptions;
  readonly #locks = new AsyncKeyLock();
  readonly #replays = new Map<string, ReplayEntry>();
  readonly #replayLimit: number;
  readonly #turnHistoryConvergenceWaitMs: number;
  readonly #clientMessageCompletionWaitMs: number;
  readonly #admissionOwnerId: string;

  constructor(options: NativeCodexThreadServiceOptions) {
    const replayLimit = options.replayLimit ?? MAX_REPLAY_ENTRIES;
    if (!Number.isSafeInteger(replayLimit) || replayLimit < 1 ||
        replayLimit > MAX_REPLAY_ENTRIES) {
      throw new TypeError("Native Codex replay limit is invalid.");
    }
    this.#options = options;
    this.#replayLimit = replayLimit;
    const turnHistoryConvergenceWaitMs = options.turnHistoryConvergenceWaitMs ??
      DEFAULT_TURN_HISTORY_CONVERGENCE_WAIT_MS;
    if (!Number.isSafeInteger(turnHistoryConvergenceWaitMs) ||
        turnHistoryConvergenceWaitMs < 0 ||
        turnHistoryConvergenceWaitMs > MAX_TURN_HISTORY_CONVERGENCE_WAIT_MS) {
      throw new TypeError("Native Codex turn-history convergence wait is invalid.");
    }
    this.#turnHistoryConvergenceWaitMs = turnHistoryConvergenceWaitMs;
    const clientMessageCompletionWaitMs = options.clientMessageCompletionWaitMs ??
      DEFAULT_CLIENT_MESSAGE_COMPLETION_WAIT_MS;
    if (!Number.isSafeInteger(clientMessageCompletionWaitMs) ||
        clientMessageCompletionWaitMs < 0 ||
        clientMessageCompletionWaitMs > MAX_CLIENT_MESSAGE_COMPLETION_WAIT_MS) {
      throw new TypeError("Native Codex client-message completion wait is invalid.");
    }
    this.#clientMessageCompletionWaitMs = clientMessageCompletionWaitMs;
    const admissionOwnerId = options.admissionOwnerId ?? randomUUID();
    if (!isNativeIdentifier(admissionOwnerId)) {
      throw new TypeError("Native Codex admission owner id is invalid.");
    }
    this.#admissionOwnerId = admissionOwnerId;
    if (options.recoverAdmissionsOnStartup === true) {
      options.store.adoptAdmissionsForExclusiveRecovery(admissionOwnerId);
    }
  }

  async listThreads(request: CodexThreadListRequest): Promise<CodexThreadListResponse> {
    await this.#ensureConnected();
    await this.#locks.run("selection", () => this.#reconcileThreadStartAdmission());
    await this.#ensureDefaultSelection();
    const result = await this.#request("thread/list", {
      archived: request.archived ?? false,
      cwd: this.#options.session.fixedCwd,
      cursor: request.cursor ?? null,
      limit: request.limit ?? CODEX_THREAD_LIST_LIMIT_DEFAULT,
      parentThreadId: null,
      searchTerm: request.search ?? null,
      sourceKinds: [],
      sortKey: "recency_at",
      sortDirection: "desc",
    });
    if (!isRecord(result) || !Array.isArray(result.data) ||
        (result.nextCursor !== null && result.nextCursor !== undefined &&
          !isNativeCursor(result.nextCursor))) {
      throw serviceError("CODEX_INCOMPATIBLE", "Codex returned an invalid thread list.");
    }
    const archived = request.archived ?? false;
    const threads: CodexThreadSummary[] = [];
    for (const thread of result.data) {
      if (!await this.#authenticateRootProjection(thread, archived)) continue;
      if (archived) this.#options.session.forgetThread(thread.id);
      const projected = projectCodexThreadSummary(thread);
      if (projected !== null) threads.push(projected);
    }
    let selection = this.#options.store.readSelection();
    const selectedThreadId = selection.selectedThreadId;
    if (!archived && request.cursor === undefined && request.limit === undefined &&
        request.search === undefined &&
        selectedThreadId !== null &&
        !threads.some((thread) => thread.id === selectedThreadId) &&
        (this.#options.session.isUnmaterializedRoot(selectedThreadId) ||
          !this.#options.session.isEligibleRoot(selectedThreadId))) {
      const selected = await this.#readSelectedUnmaterializedSummary(selectedThreadId);
      if (selected.kind === "found") {
        threads.unshift(selected.thread);
      } else {
        // A blank thread/start result is process-local in the native provider:
        // it is absent from history until the first user turn and cannot be
        // resumed after app-server restarts. Reconcile that dead pointer so a
        // read-only load returns the empty state and the next message can
        // allocate a fresh root instead of permanently failing the rail.
        const cleared = this.#options.store.compareAndSetSelection(
          selection.revision,
          null,
          this.#now(),
        );
        selection = cleared ?? this.#options.store.readSelection();
        if (cleared !== null) this.#options.session.mark("selection", null);
      }
    }
    return {
      threads,
      nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
      selection: selectionView(selection),
      ...this.#options.session.coordinates(),
    };
  }

  async readThread(request: CodexThreadReadRequest): Promise<CodexThreadReadResponse> {
    await this.#ensureConnected();
    await this.#ensureDefaultSelection();
    return this.#locks.run("selection", async () => {
      await this.#reconcileTurnAdmission(request.threadId);
      const thread = await this.#readEligibleThread(request.threadId, true);
      const projected = projectCodexThread(thread);
      if (projected === null) {
        throw serviceError("CODEX_INCOMPATIBLE", "Codex returned an invalid thread history.");
      }
      return {
        thread: projected,
        selection: selectionView(this.#options.store.readSelection()),
        interactions: this.#options.session.listInteractions(request.threadId),
        ...this.#options.session.coordinates(),
      };
    });
  }

  newThread(request: CodexNewThreadRequest): Promise<CodexThreadMutationResponse> {
    return this.#replay("new", request.requestId, request, () =>
      this.#locks.run("selection", async () => {
        const hash = payloadHash(request);
        const receipt = this.#readMutationReceipt("new", request.requestId, hash);
        if (receipt !== null) return this.#threadStartReceiptResponse(receipt);
        const pending = this.#options.store.readThreadStartAdmission();
        if (pending?.requestId === request.requestId && pending.payloadHash !== hash) {
          throw serviceError(
            "REQUEST_ID_REUSE",
            "This request id was already used with a different Codex operation.",
          );
        }
        const ownPending = pending !== null && pending.requestId === request.requestId &&
          pending.payloadHash === hash;
        const reconciliation = await this.#reconcileThreadStartAdmission();
        if (reconciliation === "ambiguous") {
          throw serviceError(
            "CODEX_UNAVAILABLE",
            "A prior native conversation creation has more than one possible result; select a conversation from history before retrying.",
          );
        }
        if (ownPending && typeof reconciliation === "object") {
          return {
            thread: reconciliation.thread,
            selection: selectionView(reconciliation.selection),
            ...this.#options.session.coordinates(),
          };
        }
        this.#assertSelectionRevision(request.expectedSelectionRevision);
        const snapshot = await this.#readNewestRootCohort();
        const admission = this.#options.store.beginThreadStartAdmission({
          requestId: request.requestId,
          ownerId: this.#admissionOwnerId,
          payloadHash: hash,
          expectedSelectionRevision: request.expectedSelectionRevision,
          newestBeforeCreatedAtSeconds: snapshot.createdAtSeconds,
          newestBeforeRootThreadIds: snapshot.threadIds,
          createdAt: this.#now(),
        });
        if (admission.status === "completed") {
          return this.#threadStartReceiptResponse(admission.receipt);
        }
        if (admission.status === "mismatch" || admission.status === "receipt_mismatch") {
          throw serviceError(
            "REQUEST_ID_REUSE",
            "This request id was already used with a different Codex operation.",
          );
        }
        if (admission.status === "busy") {
          throw serviceError(
            "TURN_CONFLICT",
            "A prior native conversation creation still needs reconciliation.",
          );
        }
        if (admission.status === "replay") {
          throw serviceError(
            "CODEX_UNAVAILABLE",
            "Another planner process owns this native conversation creation; retry reconciliation.",
          );
        }
        let result: unknown;
        try {
          result = await this.#request(
            "thread/start",
            this.#options.session.lockedThreadStartParams(),
          );
        } catch (error) {
          if (!isAmbiguousNativeMutationFailure(error)) {
            this.#options.store.clearThreadStartAdmission(
              request.requestId,
              this.#admissionOwnerId,
              hash,
            );
          }
          throw error;
        }
        const thread = authorizedRootThreadResult(result, this.#options.session.fixedCwd);
        if (!this.#options.session.observeThread(thread)) {
          throw serviceError("CODEX_INCOMPATIBLE", "Codex created an ineligible native thread.");
        }
        const projected = projectCodexThreadSummary(thread);
        if (projected === null) {
          throw serviceError("CODEX_INCOMPATIBLE", "Codex created an invalid native thread.");
        }
        this.#options.session.markRootUnmaterialized(projected.id);
        const completion = this.#options.store.completeThreadStartAdmission({
          requestId: request.requestId,
          ownerId: this.#admissionOwnerId,
          payloadHash: hash,
          selectedThreadId: projected.id,
          updatedAt: this.#now(),
        });
        if (completion.status !== "completed") {
          if (completion.status === "selection_conflict") {
            this.#options.store.clearThreadStartAdmission(
              request.requestId,
              this.#admissionOwnerId,
              hash,
            );
          }
          throw serviceError(
            completion.status === "mismatch" ? "REQUEST_ID_REUSE" : "SELECTION_CONFLICT",
            completion.status === "mismatch"
              ? "This request id was already used with a different Codex operation."
              : "The selected Codex thread changed while creating a conversation.",
          );
        }
        const selection = completion.selection;
        this.#options.session.mark("thread", projected.id);
        this.#options.session.mark("selection", projected.id);
        return {
          thread: projected,
          selection: selectionView(selection),
          ...this.#options.session.coordinates(),
        };
      })
    );
  }

  selectThread(request: CodexSelectThreadRequest): Promise<CodexThreadMutationResponse> {
    return this.#replay("select", request.requestId, request, () =>
      this.#locks.run("selection", async () => {
        const threadStartReconciliation = await this.#reconcileThreadStartAdmission();
        if (request.threadId !== null) {
          await this.#reconcileTurnAdmission(request.threadId);
        }
        this.#assertSelectionRevision(request.expectedSelectionRevision);
        let projected: CodexThreadSummary | null = null;
        if (request.threadId !== null) {
          await this.#readRoot(request.threadId, false);
          const resumed = await this.#request(
            "thread/resume",
            this.#options.session.lockedThreadResumeParams(request.threadId),
          );
          const thread = authorizedRootThreadResult(resumed, this.#options.session.fixedCwd);
          if (!this.#options.session.observeThread(thread)) {
            throw serviceError("CODEX_INCOMPATIBLE", "Codex resumed an ineligible native thread.");
          }
          projected = projectCodexThreadSummary(thread);
          if (projected === null) {
            throw serviceError("CODEX_INCOMPATIBLE", "Codex resumed an invalid native thread.");
          }
        }
        const selection = this.#options.store.compareAndSetSelection(
          request.expectedSelectionRevision,
          request.threadId,
          this.#now(),
        );
        if (selection === null) {
          throw serviceError("SELECTION_CONFLICT", "The selected Codex thread changed.");
        }
        if (threadStartReconciliation === "ambiguous") {
          const pending = this.#options.store.readThreadStartAdmission();
          if (pending) {
            this.#options.store.clearThreadStartAdmission(
              pending.requestId,
              this.#admissionOwnerId,
              pending.payloadHash,
            );
          }
        }
        this.#options.session.mark("selection", request.threadId);
        return {
          thread: projected,
          selection: selectionView(selection),
          ...this.#options.session.coordinates(),
        };
      })
    );
  }

  archiveThread(request: CodexArchiveThreadRequest): Promise<CodexThreadMutationResponse> {
    return this.#replay("archive", request.requestId, request, () =>
      this.#locks.run("selection", async () => {
        await this.#assertNativeAdmissionsResolved(request.threadId);
        const current = this.#assertSelectionRevision(request.expectedSelectionRevision);
        await this.#readRoot(request.threadId, false);
        await this.#request("thread/archive", { threadId: request.threadId });
        this.#options.session.forgetThread(request.threadId);
        const selectedThreadId = current.selectedThreadId === request.threadId
          ? null
          : current.selectedThreadId;
        const selection = this.#options.store.compareAndSetSelection(
          request.expectedSelectionRevision,
          selectedThreadId,
          this.#now(),
        );
        if (selection === null) {
          throw serviceError(
            "SELECTION_CONFLICT",
            "The selected Codex thread changed while archiving the conversation.",
          );
        }
        this.#options.session.mark("thread", request.threadId);
        this.#options.session.mark("selection", selectedThreadId);
        return {
          thread: null,
          selection: selectionView(selection),
          ...this.#options.session.coordinates(),
        };
      })
    );
  }

  sendTurn(request: CodexSendTurnRequest): Promise<CodexTurnMutationResponse> {
    return this.#replay("send", request.requestId, request, () =>
      this.#locks.run("selection", async () => {
        const hash = payloadHash(request);
        const receipt = this.#readMutationReceipt("send", request.requestId, hash);
        if (receipt !== null) return this.#turnReceiptResponse(receipt);
        const pendingByRequest = this.#options.store.readTurnAdmissionByRequestId(
          request.requestId,
        );
        if (pendingByRequest !== null && pendingByRequest.payloadHash !== hash) {
          throw serviceError(
            "REQUEST_ID_REUSE",
            "This request id was already used with a different Codex operation.",
          );
        }
        await this.#assertNativeAdmissionsResolved(request.threadId);
        const reconciledReceipt = this.#readMutationReceipt("send", request.requestId, hash);
        if (reconciledReceipt !== null) return this.#turnReceiptResponse(reconciledReceipt);
        const selection = this.#assertSelectionRevision(request.expectedSelectionRevision);
        if (selection.selectedThreadId !== request.threadId) {
          throw serviceError("SELECTION_CONFLICT", "This Codex thread is no longer selected.");
        }
        let thread = await this.#readRootForSend(request.threadId);
        if (thread !== null) {
          const priorMapping = clientMessageTurnMapping(thread, request.clientUserMessageId);
          if (priorMapping.status === "ambiguous") {
            throw serviceError(
              "CODEX_INCOMPATIBLE",
              "Codex history contains duplicate client message identities.",
            );
          }
          if (priorMapping.status === "unique") {
            throw serviceError(
              "REQUEST_ID_REUSE",
              "This client message id already belongs to a completed Codex operation.",
            );
          }
          const status = isRecord(thread.status) ? thread.status.type : null;
          if (status === "notLoaded") {
            const resumed = await this.#request(
              "thread/resume",
              this.#options.session.lockedThreadResumeParams(request.threadId),
            );
            const resumedThread = authorizedRootThreadResult(
              resumed,
              this.#options.session.fixedCwd,
            );
            if (!this.#options.session.observeThread(resumedThread)) {
              throw serviceError("CODEX_INCOMPATIBLE", "Codex resumed an invalid native thread.");
            }
            thread = resumedThread;
          }
        }
        const input = [{ type: "text", text: request.message, text_elements: [] }];
        const currentStatus = thread !== null && isRecord(thread.status) ? thread.status : null;
        const waiting = currentStatus?.type === "active" && Array.isArray(currentStatus.activeFlags)
          ? currentStatus.activeFlags
          : [];
        if (waiting.includes("waitingOnUserInput")) {
          throw serviceError("TURN_CONFLICT", "Codex is waiting for an interaction response.");
        }
        let operation: "start" | "steer";
        let expectedTurnId: string | null;
        let nativeMethod: "turn/start" | "turn/steer";
        let nativeParams: Record<string, unknown>;
        if (thread === null) {
          operation = "start";
          expectedTurnId = null;
          nativeMethod = "turn/start";
          nativeParams = {
            threadId: request.threadId,
            clientUserMessageId: request.clientUserMessageId,
            input,
          };
        } else if (currentStatus?.type === "active") {
          expectedTurnId = activeTurnId(thread);
          if (expectedTurnId === null) {
            throw serviceError("TURN_CONFLICT", "The active Codex turn cannot be steered.");
          }
          operation = "steer";
          nativeMethod = "turn/steer";
          nativeParams = {
            threadId: request.threadId,
            expectedTurnId,
            clientUserMessageId: request.clientUserMessageId,
            input,
          };
        } else if (currentStatus?.type === "idle" || currentStatus?.type === "notLoaded") {
          operation = "start";
          expectedTurnId = null;
          nativeMethod = "turn/start";
          nativeParams = {
            threadId: request.threadId,
            clientUserMessageId: request.clientUserMessageId,
            input,
          };
        } else {
          throw serviceError("TURN_CONFLICT", "The Codex thread cannot accept a message now.");
        }
        const admission = this.#options.store.beginTurnAdmission({
          threadId: request.threadId,
          requestId: request.requestId,
          ownerId: this.#admissionOwnerId,
          payloadHash: hash,
          clientUserMessageId: request.clientUserMessageId,
          operation,
          expectedTurnId,
          createdAt: this.#now(),
        });
        if (admission.status === "completed") {
          return this.#turnReceiptResponse(admission.receipt);
        }
        if (admission.status === "mismatch" || admission.status === "receipt_mismatch") {
          throw serviceError(
            "REQUEST_ID_REUSE",
            "This request id was already used with a different Codex operation.",
          );
        }
        if (admission.status === "busy" || admission.status === "replay") {
          throw serviceError(
            "TURN_CONFLICT",
            "A prior native message still needs authoritative reconciliation.",
          );
        }
        let nativeResult: unknown;
        try {
          nativeResult = await this.#request(nativeMethod, nativeParams);
        } catch (error) {
          if (!isAmbiguousNativeMutationFailure(error)) {
            this.#options.store.clearTurnAdmission(
              request.threadId,
              request.requestId,
              this.#admissionOwnerId,
              hash,
            );
          }
          throw error;
        }
        const turnId = nativeMethod === "turn/steer"
          ? steerResultId(nativeResult)
          : turnResultId(nativeResult);
        if (turnId === null) {
          throw serviceError("CODEX_INCOMPATIBLE", "Codex returned an invalid turn identity.");
        }
        if (operation === "steer" && turnId !== expectedTurnId) {
          throw serviceError(
            "CODEX_INCOMPATIBLE",
            "Codex steered a different active turn than the admitted operation.",
          );
        }
        if (!this.#options.session.bindActiveRootTurn(request.threadId, turnId)) {
          throw serviceError(
            "CODEX_INCOMPATIBLE",
            "Codex returned a turn outside the selected top-level conversation.",
          );
        }
        await this.#waitForCompletedClientMessage(
          request.threadId,
          turnId,
          request.clientUserMessageId,
        );
        await this.#confirmAdmittedTurnHistory(
          request.threadId,
          request.clientUserMessageId,
          turnId,
        );
        const completion = this.#options.store.completeTurnAdmission({
          threadId: request.threadId,
          requestId: request.requestId,
          ownerId: this.#admissionOwnerId,
          payloadHash: hash,
          turnId,
          completedAt: this.#now(),
        });
        if (completion.status !== "completed") {
          throw serviceError(
            "INTERNAL_ERROR",
            "The native message admission could not be settled.",
          );
        }
        this.#options.session.mark("thread", request.threadId);
        return {
          threadId: request.threadId,
          turnId,
          ...this.#options.session.coordinates(),
        };
      })
    );
  }

  interruptTurn(request: CodexInterruptTurnRequest): Promise<CodexTurnMutationResponse> {
    return this.#replay("interrupt", request.requestId, request, () =>
      this.#locks.run("selection", async () => {
        await this.#assertNativeAdmissionsResolved(request.threadId);
        const selection = this.#assertSelectionRevision(request.expectedSelectionRevision);
        if (selection.selectedThreadId !== request.threadId) {
          throw serviceError("SELECTION_CONFLICT", "This Codex thread is no longer selected.");
        }
        const thread = await this.#readRoot(request.threadId, true);
        if (activeTurnId(thread) !== request.turnId) {
          throw serviceError("TURN_CONFLICT", "That Codex turn is no longer active.");
        }
        await this.#request("turn/interrupt", {
          threadId: request.threadId,
          turnId: request.turnId,
        });
        this.#options.session.clearActiveRootTurn(request.threadId, request.turnId);
        this.#options.session.mark("thread", request.threadId);
        return {
          threadId: request.threadId,
          turnId: request.turnId,
          ...this.#options.session.coordinates(),
        };
      })
    );
  }

  async listInteractions(
    request: CodexInteractionListRequest,
  ): Promise<CodexInteractionListResponse> {
    await this.#ensureConnected();
    return {
      interactions: this.#options.session.listInteractions(request.threadId),
      ...this.#options.session.coordinates(),
    };
  }

  respondInteraction(
    request: CodexRespondInteractionRequest,
  ): Promise<CodexInteractionMutationResponse> {
    return this.#replay("interaction", request.requestId, request, () =>
      this.#locks.run("selection", async () => {
        await this.#ensureConnected();
        await this.#assertNativeAdmissionsResolved(request.threadId);
        const selection = this.#assertSelectionRevision(request.expectedSelectionRevision);
        if (selection.selectedThreadId !== request.threadId) {
          throw serviceError("SELECTION_CONFLICT", "This Codex thread is no longer selected.");
        }
        const answers = Object.fromEntries(
          request.response.answers.map((answer) => [answer.questionId, answer.answers]),
        );
        if (!this.#options.session.answerInteraction(
          request.interactionId,
          request.threadId,
          answers,
        )) {
          throw serviceError("INTERACTION_STALE", "That Codex interaction is no longer pending.");
        }
        return {
          interactionId: request.interactionId,
          status: "resolved",
          ...this.#options.session.coordinates(),
        };
      })
    );
  }

  async waitForEvents(request: CodexEventsRequest, options: { signal?: AbortSignal } = {}) {
    await this.#ensureConnected();
    return this.#options.session.waitForEvents(request, options);
  }

  close() {
    return this.#options.session.close();
  }

  async #assertNativeAdmissionsResolved(threadId?: string) {
    const threadStart = await this.#reconcileThreadStartAdmission();
    if (threadStart === "ambiguous") {
      throw serviceError(
        "CODEX_UNAVAILABLE",
        "A prior native conversation creation has more than one possible result; select a conversation from history before retrying.",
      );
    }
    if (threadId !== undefined) await this.#reconcileTurnAdmission(threadId);
  }

  async #readRootPage(cursor: string | null) {
    const result = await this.#request("thread/list", {
      archived: false,
      cwd: this.#options.session.fixedCwd,
      limit: ROOT_RECONCILIATION_PAGE_SIZE,
      parentThreadId: null,
      sourceKinds: [],
      sortKey: "created_at",
      sortDirection: "desc",
      ...(cursor === null ? {} : { cursor }),
    });
    if (!isRecord(result) || !Array.isArray(result.data) ||
        (result.nextCursor !== null && result.nextCursor !== undefined &&
          !isNativeCursor(result.nextCursor))) {
      throw serviceError(
        "CODEX_INCOMPATIBLE",
        "Codex returned an invalid root conversation page.",
      );
    }
    return {
      data: result.data,
      nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
    };
  }

  async #readNewestRootCohort(): Promise<{
    createdAtSeconds: number | null;
    threadIds: readonly string[];
  }> {
    let cursor: string | null = null;
    let newest: number | null = null;
    const threadIds: string[] = [];
    for (let pageIndex = 0; pageIndex < MAX_ROOT_RECONCILIATION_PAGES; pageIndex += 1) {
      const page = await this.#readRootPage(cursor);
      for (const value of page.data) {
        if (!await this.#authenticateRootProjection(value)) continue;
        const valueCreatedAt = createdAtSeconds(value.createdAt);
        if (valueCreatedAt === null) {
          throw serviceError(
            "CODEX_INCOMPATIBLE",
            "Codex returned a conversation without a valid creation time.",
          );
        }
        if (newest === null) newest = valueCreatedAt;
        if (valueCreatedAt > newest) {
          throw serviceError("CODEX_INCOMPATIBLE", "Codex root history is not stably ordered.");
        }
        if (valueCreatedAt < newest) {
          return { createdAtSeconds: newest, threadIds };
        }
        if (threadIds.length >= NATIVE_THREAD_START_ROOT_ID_LIMIT) {
          throw serviceError(
            "TURN_CONFLICT",
            "Too many conversations share the newest creation boundary to create another safely.",
          );
        }
        threadIds.push(value.id);
      }
      cursor = page.nextCursor;
      if (cursor === null) return { createdAtSeconds: newest, threadIds };
    }
    throw serviceError("CODEX_INCOMPATIBLE", "Codex root history pagination did not terminate.");
  }

  async #findCreatedRootsAfter(admission: NativeThreadStartAdmission) {
    const beforeIds = new Set(admission.newestBeforeRootThreadIds);
    const candidates = new Map<string, Record<string, unknown>>();
    let cursor: string | null = null;
    let priorCreatedAt: number | null = null;
    for (let pageIndex = 0; pageIndex < MAX_ROOT_RECONCILIATION_PAGES; pageIndex += 1) {
      const page = await this.#readRootPage(cursor);
      let reachedBeforeBoundary = false;
      for (const value of page.data) {
        if (!await this.#authenticateRootProjection(value)) continue;
        const valueCreatedAt = createdAtSeconds(value.createdAt);
        if (valueCreatedAt === null ||
            (priorCreatedAt !== null && valueCreatedAt > priorCreatedAt)) {
          throw serviceError("CODEX_INCOMPATIBLE", "Codex root history is not stably ordered.");
        }
        priorCreatedAt = valueCreatedAt;
        const newer = admission.newestBeforeCreatedAtSeconds === null ||
          valueCreatedAt > admission.newestBeforeCreatedAtSeconds;
        const sameBoundaryNewId = valueCreatedAt === admission.newestBeforeCreatedAtSeconds &&
          !beforeIds.has(value.id);
        if (newer || sameBoundaryNewId) {
          candidates.set(value.id, value);
          if (candidates.size > 1) return [...candidates.values()];
          continue;
        }
        if (admission.newestBeforeCreatedAtSeconds !== null &&
            valueCreatedAt < admission.newestBeforeCreatedAtSeconds) {
          reachedBeforeBoundary = true;
          break;
        }
      }
      if (reachedBeforeBoundary || page.nextCursor === null) {
        return [...candidates.values()];
      }
      cursor = page.nextCursor;
    }
    throw serviceError("CODEX_INCOMPATIBLE", "Codex root reconciliation did not terminate.");
  }

  async #reconcileThreadStartAdmission(): Promise<
    | "none"
    | "cleared"
    | "ambiguous"
    | { thread: CodexThreadSummary; selection: ReturnType<SqliteCodexThreadStore["readSelection"]> }
  > {
    const admission = this.#options.store.readThreadStartAdmission();
    if (admission === null) return "none";
    if (admission.ownerId !== this.#admissionOwnerId) {
      throw serviceError(
        "CODEX_UNAVAILABLE",
        "Another live planner runtime owns the unresolved conversation creation.",
      );
    }
    const candidates = await this.#findCreatedRootsAfter(admission);
    if (candidates.length === 0) {
      this.#options.store.clearThreadStartAdmission(
        admission.requestId,
        this.#admissionOwnerId,
        admission.payloadHash,
      );
      return "cleared";
    }
    if (candidates.length > 1) return "ambiguous";
    const candidate = candidates[0];
    if (!this.#options.session.observeThread(candidate)) return "ambiguous";
    const projected = projectCodexThreadSummary(candidate);
    if (projected === null) return "ambiguous";
    this.#options.session.markRootUnmaterialized(projected.id);
    const completion = this.#options.store.completeThreadStartAdmission({
      requestId: admission.requestId,
      ownerId: this.#admissionOwnerId,
      payloadHash: admission.payloadHash,
      selectedThreadId: projected.id,
      updatedAt: this.#now(),
    });
    if (completion.status === "completed") {
      this.#options.session.mark("thread", projected.id);
      this.#options.session.mark("selection", projected.id);
      return { thread: projected, selection: completion.selection };
    }
    if (completion.status === "selection_conflict") {
      this.#options.store.clearThreadStartAdmission(
        admission.requestId,
        this.#admissionOwnerId,
        admission.payloadHash,
      );
      return "cleared";
    }
    if (completion.status === "missing") return "none";
    throw serviceError("INTERNAL_ERROR", "The native conversation admission changed unexpectedly.");
  }

  async #reconcileTurnAdmission(threadId: string) {
    const admission = this.#options.store.readTurnAdmission(threadId);
    if (admission === null) return;
    if (admission.ownerId !== this.#admissionOwnerId) {
      throw serviceError(
        "CODEX_UNAVAILABLE",
        "Another live planner runtime owns the unresolved message operation.",
      );
    }
    try {
      const mapping = await this.#confirmAdmittedTurnHistory(
        admission.threadId,
        admission.clientUserMessageId,
        admission.operation === "steer" ? admission.expectedTurnId : null,
      );
      const completion = this.#options.store.completeTurnAdmission({
        threadId: admission.threadId,
        requestId: admission.requestId,
        ownerId: this.#admissionOwnerId,
        payloadHash: admission.payloadHash,
        turnId: mapping.turnId,
        completedAt: this.#now(),
      });
      if (completion.status !== "completed") {
        throw serviceError("INTERNAL_ERROR", "The native message admission changed unexpectedly.");
      }
      return;
    } catch (error) {
      if (error instanceof CodexThreadServiceError && error.code === "NOT_FOUND") {
        this.#options.store.clearTurnAdmission(
          admission.threadId,
          admission.requestId,
          this.#admissionOwnerId,
          admission.payloadHash,
        );
        return;
      }
      throw error;
    }
  }

  async #confirmAdmittedTurnHistory(
    threadId: string,
    clientUserMessageId: string,
    expectedTurnId: string | null,
  ): Promise<{ status: "unique"; turnId: string }> {
    let remainingWaitMs = this.#turnHistoryConvergenceWaitMs;
    let waitSliceMs = MIN_TURN_HISTORY_WAIT_SLICE_MS;
    while (true) {
      let thread: Record<string, unknown> | null = null;
      try {
        thread = await this.#readRoot(threadId, true);
      } catch (error) {
        if (!isUnmaterializedThreadReadError(error, threadId) ||
            !this.#options.session.markRootUnmaterialized(threadId)) {
          throw error;
        }
      }
      if (thread !== null) {
        const mapping = clientMessageTurnMapping(thread, clientUserMessageId);
        if (mapping.status === "ambiguous" ||
            (mapping.status === "unique" && expectedTurnId !== null &&
              mapping.turnId !== expectedTurnId)) {
          throw serviceError(
            "CODEX_INCOMPATIBLE",
            "Codex history does not uniquely match the admitted native message operation.",
          );
        }
        if (mapping.status === "unique") {
          if (!this.#options.session.markRootMaterialized(threadId)) {
            throw serviceError(
              "CODEX_INCOMPATIBLE",
              "Codex materialized a turn outside the selected top-level conversation.",
            );
          }
          return mapping;
        }
      }
      if (remainingWaitMs === 0) {
        throw serviceError(
          "CODEX_UNAVAILABLE",
          "Codex accepted the message but its authoritative history is not ready.",
        );
      }
      const boundedWaitMs = Math.min(waitSliceMs, remainingWaitMs);
      const coordinates = this.#options.session.coordinates();
      try {
        await this.#options.session.waitForEvents({
          connectionEpoch: coordinates.connectionEpoch,
          afterRevision: coordinates.activityRevision,
          waitMs: boundedWaitMs,
          threadId,
        });
      } catch (error) {
        throw this.#mapSessionError(error);
      }
      remainingWaitMs -= boundedWaitMs;
      waitSliceMs = Math.min(waitSliceMs * 2, MAX_TURN_HISTORY_WAIT_SLICE_MS);
    }
  }

  async #waitForCompletedClientMessage(
    threadId: string,
    turnId: string,
    clientUserMessageId: string,
  ) {
    const deadline = performance.now() + this.#clientMessageCompletionWaitMs;
    while (true) {
      try {
        if (this.#options.session.hasCompletedClientMessage(
          threadId,
          turnId,
          clientUserMessageId,
        )) return;
      } catch (error) {
        throw this.#mapSessionError(error);
      }
      const remainingWaitMs = Math.max(0, Math.ceil(deadline - performance.now()));
      if (remainingWaitMs === 0) {
        throw serviceError(
          "CODEX_UNAVAILABLE",
          "Codex accepted the message but has not completed its client-message lifecycle yet.",
        );
      }
      const coordinates = this.#options.session.coordinates();
      let event;
      try {
        event = await this.#options.session.waitForEvents({
          connectionEpoch: coordinates.connectionEpoch,
          afterRevision: coordinates.activityRevision,
          waitMs: remainingWaitMs,
          threadId,
        });
      } catch (error) {
        throw this.#mapSessionError(error);
      }
      if (event.resyncRequired || event.connectionEpoch !== coordinates.connectionEpoch) {
        throw serviceError(
          "CODEX_UNAVAILABLE",
          "Codex restarted before the admitted client message could be confirmed.",
        );
      }
    }
  }

  async #ensureDefaultSelection() {
    const current = this.#options.store.readSelection();
    if (current.revision !== 0 || current.selectedThreadId !== null) return;
    await this.#locks.run("selection", async () => {
      const inside = this.#options.store.readSelection();
      if (inside.revision !== 0 || inside.selectedThreadId !== null) return;
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < MAX_DEFAULT_SELECTION_PAGES; pageIndex += 1) {
        const result = await this.#request("thread/list", {
          archived: false,
          cwd: this.#options.session.fixedCwd,
          cursor,
          limit: DEFAULT_SELECTION_PAGE_SIZE,
          parentThreadId: null,
          sourceKinds: [],
          sortKey: "recency_at",
          sortDirection: "desc",
        });
        if (!isRecord(result) || !Array.isArray(result.data) ||
            (result.nextCursor !== null && result.nextCursor !== undefined &&
              !isNativeCursor(result.nextCursor))) {
          throw serviceError("CODEX_INCOMPATIBLE", "Codex returned an invalid default history list.");
        }
        let thread: Record<string, unknown> | null = null;
        for (const candidate of result.data) {
          if (await this.#authenticateRootProjection(candidate)) {
            thread = candidate;
            break;
          }
        }
        if (thread !== null && isNativeIdentifier(thread.id)) {
          const selection = this.#options.store.compareAndSetSelection(0, thread.id, this.#now());
          if (selection) this.#options.session.mark("selection", thread.id);
          return;
        }
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
        if (cursor === null) return;
      }
      throw serviceError(
        "CODEX_INCOMPATIBLE",
        "Codex default history pagination did not terminate.",
      );
    });
  }

  async #readRootForSend(threadId: string): Promise<Record<string, unknown> | null> {
    if (!this.#options.session.isEligibleRoot(threadId)) {
      await this.#readRoot(threadId, false);
    }
    if (this.#options.session.isUnmaterializedRoot(threadId)) {
      if (!this.#options.session.isEligibleRoot(threadId) || await this.#isArchivedRoot(threadId)) {
        throw serviceError("NOT_FOUND", "That active Codex conversation is not available.");
      }
      return null;
    }
    try {
      return await this.#readRoot(threadId, true);
    } catch (error) {
      if (!isUnmaterializedThreadReadError(error, threadId) ||
          !this.#options.session.markRootUnmaterialized(threadId)) {
        throw error;
      }
      return null;
    }
  }

  async #readSelectedUnmaterializedSummary(
    threadId: string,
  ): Promise<
    | { kind: "found"; thread: CodexThreadSummary }
    | { kind: "missing" }
  > {
    let thread: Record<string, unknown>;
    try {
      thread = await this.#readRoot(threadId, false);
    } catch (error) {
      if (error instanceof CodexThreadServiceError && error.code === "NOT_FOUND") {
        return { kind: "missing" };
      }
      throw error;
    }
    const unmaterialized = this.#options.session.markRootUnmaterialized(threadId);
    const projected = projectCodexThreadSummary(unmaterialized
      ? { ...thread, status: { type: "notLoaded" } }
      : thread);
    if (projected?.id !== threadId) {
      throw serviceError(
        "CODEX_INCOMPATIBLE",
        "Codex returned an invalid selected conversation summary.",
      );
    }
    return { kind: "found", thread: projected };
  }

  async #readRoot(threadId: string, includeTurns: boolean) {
    if (await this.#isArchivedRoot(threadId)) {
      throw serviceError("NOT_FOUND", "That active Codex conversation is not available.");
    }
    let result: unknown;
    try {
      result = await this.#request("thread/read", { threadId, includeTurns });
    } catch (error) {
      if (isThreadNotLoadedReadError(error, threadId)) {
        throw serviceError(
          "NOT_FOUND",
          "That Codex conversation is not available.",
          error,
        );
      }
      throw error;
    }
    const thread = threadResult(result);
    if (!isRecord(thread) || thread.id !== threadId ||
        !await this.#authenticateRootProjection(thread)) {
      throw serviceError("NOT_FOUND", "That Codex conversation is not available to the planner.");
    }
    return thread as Record<string, unknown>;
  }

  async #isArchivedRoot(threadId: string) {
    if (this.#options.session.isKnownArchived(threadId)) return true;
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_ARCHIVED_ROOT_PAGES; pageIndex += 1) {
      const result = await this.#request("thread/list", {
        archived: true,
        cwd: this.#options.session.fixedCwd,
        cursor,
        limit: ARCHIVED_ROOT_PAGE_SIZE,
        parentThreadId: null,
        sourceKinds: [],
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      if (!isRecord(result) || !Array.isArray(result.data) ||
          (result.nextCursor !== null && result.nextCursor !== undefined &&
            !isNativeCursor(result.nextCursor))) {
        throw serviceError("CODEX_INCOMPATIBLE", "Codex returned an invalid archive history list.");
      }
      for (const candidate of result.data) {
        if (!isRecord(candidate) || candidate.id !== threadId) continue;
        if (await this.#authenticateRootProjection(candidate, true)) {
          this.#options.session.forgetThread(threadId);
          return true;
        }
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      if (cursor === null) return false;
    }
    throw serviceError("CODEX_INCOMPATIBLE", "Codex archive history pagination did not terminate.");
  }

  async #readEligibleThread(threadId: string, includeTurns: boolean) {
    await this.#isArchivedRoot(threadId);
    return this.#readEligibleThreadWithAncestry(
      threadId,
      includeTurns,
      new Set<string>(),
    );
  }

  async #readEligibleThreadWithAncestry(
    threadId: string,
    includeTurns: boolean,
    ancestry: Set<string>,
  ): Promise<Record<string, unknown>> {
    if (ancestry.size >= MAX_ANCESTRY_DEPTH || ancestry.has(threadId)) {
      throw serviceError("NOT_FOUND", "That Codex worker ancestry is invalid.");
    }
    ancestry.add(threadId);
    const result = await this.#request("thread/read", { threadId, includeTurns });
    const thread = threadResult(result);
    if (!isRecord(thread)) {
      throw serviceError("NOT_FOUND", "That Codex conversation is not available to the planner.");
    }
    if (await this.#authenticateRootProjection(
      thread,
      this.#options.session.isKnownArchived(threadId),
    )) {
      return thread;
    }
    if (!this.#options.session.observeThread(thread)) {
      throw serviceError("NOT_FOUND", "That Codex conversation is not available to the planner.");
    }
    if (!this.#options.session.isEligibleThread(threadId)) {
      const parentThreadId = isNativeIdentifier(thread.parentThreadId)
        ? thread.parentThreadId
        : null;
      if (parentThreadId === null) {
        throw serviceError("NOT_FOUND", "That Codex conversation is not available to the planner.");
      }
      await this.#isArchivedRoot(parentThreadId);
      await this.#readEligibleThreadWithAncestry(parentThreadId, false, ancestry);
      if (!this.#options.session.isEligibleThread(threadId)) {
        throw serviceError("NOT_FOUND", "That Codex conversation is not available to the planner.");
      }
    }
    return thread;
  }

  #assertSelectionRevision(expectedRevision: number) {
    const current = this.#options.store.readSelection();
    if (current.revision !== expectedRevision) {
      throw serviceError("SELECTION_CONFLICT", "The selected Codex thread changed.");
    }
    return current;
  }

  #readMutationReceipt(
    scope: "new" | "send",
    requestId: string,
    hash: string,
  ) {
    const receipt = this.#options.store.readMutationReceipt(scope, requestId);
    if (receipt !== null && receipt.payloadHash !== hash) {
      throw serviceError(
        "REQUEST_ID_REUSE",
        "This request id was already used with a different Codex operation.",
      );
    }
    return receipt;
  }

  async #threadStartReceiptResponse(
    receipt: NativeMutationReceipt,
  ): Promise<CodexThreadMutationResponse> {
    if (receipt.scope !== "new" || receipt.selectionRevision === null) {
      throw serviceError("INTERNAL_ERROR", "The native conversation receipt is invalid.");
    }
    const thread = await this.#readEligibleThread(receipt.threadId, false);
    const projected = projectCodexThreadSummary(thread);
    if (projected === null || projected.id !== receipt.threadId) {
      throw serviceError("CODEX_INCOMPATIBLE", "Codex returned an invalid receipt thread.");
    }
    return {
      thread: projected,
      selection: selectionView(this.#options.store.readSelection()),
      ...this.#options.session.coordinates(),
    };
  }

  #turnReceiptResponse(receipt: NativeMutationReceipt): CodexTurnMutationResponse {
    if (receipt.scope !== "send" || receipt.turnId === null) {
      throw serviceError("INTERNAL_ERROR", "The native turn receipt is invalid.");
    }
    return {
      threadId: receipt.threadId,
      turnId: receipt.turnId,
      ...this.#options.session.coordinates(),
    };
  }

  async #request(method: Parameters<NativeCodexSession["request"]>[0], params: unknown) {
    try {
      return await this.#options.session.request(method, params);
    } catch (error) {
      throw this.#mapSessionError(error);
    }
  }

  async #authenticateRootProjection(value: unknown, archived = false) {
    try {
      return await this.#options.session.authenticateRootProjection(value, {
        archived,
      });
    } catch (error) {
      throw this.#mapSessionError(error);
    }
  }

  async #ensureConnected() {
    try {
      await this.#options.session.ensureConnected();
    } catch (error) {
      throw this.#mapSessionError(error);
    }
  }

  #mapSessionError(error: unknown) {
    if (error instanceof CodexThreadServiceError) return error;
    if (error instanceof NativeCodexSessionError && error.code === "REQUEST_REJECTED") {
      return mapRejectedNativeRequest(error);
    }
    if (error instanceof NativeCodexSessionError && error.code === "PROTOCOL_ERROR") {
      return serviceError("CODEX_INCOMPATIBLE", "Codex app-server protocol is incompatible.", error);
    }
    return serviceError("CODEX_UNAVAILABLE", "Codex is temporarily unavailable.", error);
  }

  #replay<Result>(
    scope: string,
    requestId: string,
    request: unknown,
    work: () => Promise<Result>,
  ): Promise<Result> {
    const key = `${scope}\0${requestId}`;
    const hash = payloadHash(request);
    const existing = this.#replays.get(key);
    if (existing) {
      if (existing.status === "identity_rejection" &&
          (scope === "new" || scope === "send")) {
        const retry = this.#createReplayEntry(scope, hash, work);
        this.#replays.set(key, retry);
        return retry.promise as Promise<Result>;
      }
      if (existing.payloadHash !== hash) {
        return Promise.reject(serviceError(
          "REQUEST_ID_REUSE",
          "This request id was already used with a different Codex operation.",
        ));
      }
      if (existing.status === "retryable_rejection" &&
          (scope === "new" || scope === "send")) {
        const retry = this.#createReplayEntry(scope, hash, work);
        this.#replays.set(key, retry);
        return retry.promise as Promise<Result>;
      }
      return existing.promise as Promise<Result>;
    }
    this.#evictReplayEntriesForCapacity();
    if (this.#replays.size >= this.#replayLimit) {
      return Promise.reject(serviceError(
        "CODEX_UNAVAILABLE",
        "The native Codex replay fence is at capacity; retry after active operations settle.",
      ));
    }
    const entry = this.#createReplayEntry(scope, hash, work);
    this.#replays.set(key, entry);
    return entry.promise as Promise<Result>;
  }

  #createReplayEntry<Result>(
    scope: string,
    hash: string,
    work: () => Promise<Result>,
  ): ReplayEntry {
    const entry: ReplayEntry = {
      payloadHash: hash,
      promise: Promise.resolve(),
      status: "pending",
    };
    entry.promise = Promise.resolve().then(work).then(
      (value) => {
        entry.status = "fulfilled";
        return value;
      },
      (error) => {
        entry.status = error instanceof CodexThreadServiceError &&
            error.code === "REQUEST_ID_REUSE" && (scope === "new" || scope === "send")
          ? "identity_rejection"
          : isAmbiguousNativeMutationFailure(error)
          ? scope === "new" || scope === "send"
            ? "retryable_rejection"
            : "ambiguous_tombstone"
          : "rejected";
        throw error;
      },
    );
    return entry;
  }

  #evictReplayEntriesForCapacity() {
    if (this.#replays.size < this.#replayLimit) return;
    for (const [key, entry] of this.#replays) {
      if (entry.status !== "fulfilled" && entry.status !== "rejected" &&
          entry.status !== "retryable_rejection" &&
          entry.status !== "identity_rejection") continue;
      this.#replays.delete(key);
      if (this.#replays.size < this.#replayLimit) return;
    }
  }

  #now() {
    const value = this.#options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw serviceError("INTERNAL_ERROR", "The planner clock is invalid.");
    }
    return value;
  }
}

export function createNativeCodexThreadService(options: NativeCodexThreadServiceOptions) {
  return new NativeCodexThreadService(options);
}
