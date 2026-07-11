import { createHash } from "node:crypto";

import {
  isPlannerChatContext,
  MODEL_TRANSCRIPT_TAIL_LIMIT,
} from "../../lib/planner-chat-contract.ts";
import type {
  ChatTurn,
  ChatTurnDecision,
  RetryChatTurnRequest,
  SubmitChatTurnRequest,
} from "../../lib/planner-chat-contract.ts";
import type { OperationReceipt } from "../../lib/planner-api-contract.ts";
import type {
  ChatApplicationService,
  ChatPersistencePort,
  ChatServiceResponse,
  Clock,
  CodexPlannerAdapter,
  FailureInjector,
  IdFactory,
  PlannerMutationKernel,
  PlannerReadPort,
  TransactionRunner,
} from "../application/ports.ts";
import { buildCanonicalPlannerPrompt, resolveCanonicalContext } from "./prompt.ts";

const MAX_CHAT_MESSAGE_LENGTH = 4_000;
const MAX_REQUEST_ID_LENGTH = 200;
const DEFAULT_MODEL_TIMEOUT_MS = 90_000;

type ReceiptKind = "chat_submit" | "chat_retry";
type StoredDecision =
  | { kind: "accepted"; turnId: string }
  | { kind: "decision"; decision: ChatTurnDecision };

type PreparedTurn = {
  turn: ChatTurn;
  prompt: string;
};

export type ChatApplicationServiceOptions<Transaction> = {
  transactionRunner: TransactionRunner<Transaction>;
  persistence: ChatPersistencePort<Transaction>;
  plannerMutationKernel: PlannerMutationKernel<Transaction>;
  plannerRead: PlannerReadPort<Transaction>;
  clock: Clock;
  idFactory: IdFactory;
  failureInjector: FailureInjector;
  codexAdapter: CodexPlannerAdapter;
  modelTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH
  );
}

function isPlannerVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function normalizeSubmit(request: SubmitChatTurnRequest): SubmitChatTurnRequest | null {
  if (
    !isRecord(request) ||
    !hasExactKeys(request, ["requestId", "basePlannerVersion", "message", "context"]) ||
    !isRequestId(request.requestId) ||
    !isPlannerVersion(request.basePlannerVersion) ||
    typeof request.message !== "string" ||
    request.message.trim().length === 0 ||
    request.message.length > MAX_CHAT_MESSAGE_LENGTH ||
    !isPlannerChatContext(request.context)
  ) {
    return null;
  }
  return { ...request, message: request.message.trim() };
}

function normalizeRetry(request: RetryChatTurnRequest): RetryChatTurnRequest | null {
  if (
    !isRecord(request) ||
    !hasExactKeys(request, ["requestId", "basePlannerVersion", "turnId"]) ||
    !isRequestId(request.requestId) ||
    !isPlannerVersion(request.basePlannerVersion) ||
    !isRequestId(request.turnId)
  ) {
    return null;
  }
  return request;
}

function decisionStatus(decision: ChatTurnDecision) {
  switch (decision.status) {
    case "accepted":
      return 202;
    case "not_found":
      return 404;
    case "codex_unavailable":
      return 503;
    default:
      return 409;
  }
}

function errorDetail(error: unknown) {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return "Codex failed without an error message.";
}

function errorCode(error: unknown) {
  if (isRecord(error) && typeof error.code === "string") return error.code.slice(0, 200);
  return "CODEX_MODEL_FAILED";
}

function accepted(turn: ChatTurn): ChatTurnDecision {
  return { status: "accepted", turn };
}

function isStoredPublicDecision(value: unknown): value is Exclude<
  ChatTurnDecision,
  { status: "accepted" }
> {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "request_id_reuse":
      return true;
    case "turn_busy":
      return isRecord(value.runningTurn) && isRequestId(value.runningTurn.turnId);
    case "context_stale":
      return (
        isPlannerVersion(value.expectedVersion) && isPlannerVersion(value.actualVersion)
      );
    case "not_found":
    case "domain_rejected":
    case "codex_unavailable":
      return typeof value.message === "string";
    default:
      return false;
  }
}

export class DurableChatApplicationService<Transaction>
  implements ChatApplicationService
{
  readonly #transactionRunner: TransactionRunner<Transaction>;
  readonly #persistence: ChatPersistencePort<Transaction>;
  readonly #plannerMutationKernel: PlannerMutationKernel<Transaction>;
  readonly #plannerRead: PlannerReadPort<Transaction>;
  readonly #clock: Clock;
  readonly #idFactory: IdFactory;
  readonly #failureInjector: FailureInjector;
  readonly #codexAdapter: CodexPlannerAdapter;
  readonly #modelTimeoutMs: number;

  constructor(options: ChatApplicationServiceOptions<Transaction>) {
    this.#transactionRunner = options.transactionRunner;
    this.#persistence = options.persistence;
    this.#plannerMutationKernel = options.plannerMutationKernel;
    this.#plannerRead = options.plannerRead;
    this.#clock = options.clock;
    this.#idFactory = options.idFactory;
    this.#failureInjector = options.failureInjector;
    this.#codexAdapter = options.codexAdapter;
    this.#modelTimeoutMs = options.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#modelTimeoutMs) || this.#modelTimeoutMs <= 0) {
      throw new TypeError("modelTimeoutMs must be a positive integer.");
    }
  }

  async submit(request: SubmitChatTurnRequest): Promise<ChatServiceResponse> {
    const normalized = normalizeSubmit(request);
    if (!normalized) {
      return this.#immediateDecision({
        status: "domain_rejected",
        message: "Chat submission is malformed.",
      });
    }

    const hash = payloadHash(normalized);
    const preflight = this.#transactionRunner.transaction((transaction) =>
      this.#guardSubmit(transaction, normalized, hash),
    );
    if (preflight) return preflight;

    const status = await this.#readCodexStatus();
    const preparation = this.#transactionRunner.transaction((transaction) => {
      const guarded = this.#guardSubmit(transaction, normalized, hash);
      if (guarded) return { response: guarded };

      const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
      if (!status.available || !status.authenticated) {
        const decision: ChatTurnDecision = {
          status: "codex_unavailable",
          message: status.detail,
        };
        this.#storeDecision(transaction, "chat_submit", normalized.requestId, hash, decision);
        return { response: { decision, workspace } };
      }

      const now = this.#clock.now();
      const turnId = this.#idFactory.createId("chat-turn");
      const userEntryId = this.#idFactory.createId("transcript");
      this.#persistence.insertTranscriptEntry(transaction, {
        entryId: userEntryId,
        role: "user",
        text: normalized.message,
        context: normalized.context,
        turnId,
        occurredAt: now,
      });
      const turn = this.#persistence.insertRunningTurn(transaction, {
        turnId,
        requestId: normalized.requestId,
        userEntryId,
        context: normalized.context,
        inputPlannerVersion: workspace.plannerVersion,
        retryOfTurnId: null,
        createdAt: now,
        startedAt: now,
        status: "running",
        replyEntryId: null,
        proposedCommand: null,
        mutationOutcome: null,
        errorCode: null,
        errorDetail: null,
        completedAt: null,
      });
      this.#persistence.incrementSyncRevision(transaction, now);
      this.#storeAccepted(transaction, "chat_submit", normalized.requestId, hash, turnId);

      const transcriptEntries = this.#persistence.readTranscriptTail(
        transaction,
        MODEL_TRANSCRIPT_TAIL_LIMIT,
      );
      const currentWorkspace = this.#plannerRead.readInitializedWorkspace(transaction);
      const prepared = {
        prepared: {
          turn,
          prompt: buildCanonicalPlannerPrompt({
            workspace: currentWorkspace,
            context: turn.context,
            transcriptEntries,
            userEntryId,
            userText: normalized.message,
          }),
        } satisfies PreparedTurn,
      };
      this.#failureInjector.hit("before_commit");
      return prepared;
    });

    if ("prepared" in preparation) return this.#runPreparedTurn(preparation.prepared!);
    return preparation.response!;
  }

  async retry(request: RetryChatTurnRequest): Promise<ChatServiceResponse> {
    const normalized = normalizeRetry(request);
    if (!normalized) {
      return this.#immediateDecision({
        status: "domain_rejected",
        message: "Chat retry is malformed.",
      });
    }

    const hash = payloadHash(normalized);
    const preflight = this.#transactionRunner.transaction((transaction) =>
      this.#guardRetry(transaction, normalized, hash),
    );
    if (preflight) return preflight;

    const status = await this.#readCodexStatus();
    const preparation = this.#transactionRunner.transaction((transaction) => {
      const guarded = this.#guardRetry(transaction, normalized, hash);
      if (guarded) return { response: guarded };

      const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
      if (!status.available || !status.authenticated) {
        const decision: ChatTurnDecision = {
          status: "codex_unavailable",
          message: status.detail,
        };
        this.#storeDecision(transaction, "chat_retry", normalized.requestId, hash, decision);
        return { response: { decision, workspace } };
      }
      const priorTurn = this.#persistence.readTurn(transaction, normalized.turnId);
      if (!priorTurn) throw new Error("Guarded retry source disappeared inside one transaction.");
      const userEntry = this.#persistence.readTranscriptEntry(
        transaction,
        priorTurn.userEntryId,
      );
      if (!userEntry || userEntry.role !== "user") throw new Error("Guarded retry user entry disappeared inside one transaction.");

      const now = this.#clock.now();
      const turnId = this.#idFactory.createId("chat-turn");
      const turn = this.#persistence.insertRunningTurn(transaction, {
        turnId,
        requestId: normalized.requestId,
        userEntryId: priorTurn.userEntryId,
        context: priorTurn.context,
        inputPlannerVersion: workspace.plannerVersion,
        retryOfTurnId: priorTurn.turnId,
        createdAt: now,
        startedAt: now,
        status: "running",
        replyEntryId: null,
        proposedCommand: null,
        mutationOutcome: null,
        errorCode: null,
        errorDetail: null,
        completedAt: null,
      });
      this.#persistence.incrementSyncRevision(transaction, now);
      this.#storeAccepted(transaction, "chat_retry", normalized.requestId, hash, turnId);

      const transcriptEntries = this.#persistence.readTranscriptTail(
        transaction,
        MODEL_TRANSCRIPT_TAIL_LIMIT,
      );
      const currentWorkspace = this.#plannerRead.readInitializedWorkspace(transaction);
      const prepared = {
        prepared: {
          turn,
          prompt: buildCanonicalPlannerPrompt({
            workspace: currentWorkspace,
            context: turn.context,
            transcriptEntries,
            userEntryId: userEntry.entryId,
            userText: userEntry.text,
          }),
        } satisfies PreparedTurn,
      };
      this.#failureInjector.hit("before_commit");
      return prepared;
    });

    if ("prepared" in preparation) return this.#runPreparedTurn(preparation.prepared!);
    return preparation.response!;
  }

  interruptRunningTurns(now = this.#clock.now()): number {
    return this.#transactionRunner.transaction((transaction) => {
      const count = this.#persistence.interruptRunningTurns(transaction, now);
      if (count > 0) {
        this.#persistence.incrementSyncRevision(transaction, now);
        this.#failureInjector.hit("after_chat_terminal_write");
        this.#failureInjector.hit("before_commit");
      }
      return count;
    });
  }

  async #runPreparedTurn(prepared: PreparedTurn): Promise<ChatServiceResponse> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;

    const modelTask = this.#codexAdapter.complete({
      turnId: prepared.turn.turnId,
      prompt: prepared.prompt,
      signal: controller.signal,
    });
    const terminalTask = modelTask.then(
      (result) => this.#completeTurn(prepared.turn.turnId, result),
      (error) =>
        this.#failTurn(
          prepared.turn.turnId,
          errorCode(error) === "CODEX_TIMEOUT" ? "timed_out" : "model_failed",
          error,
        ),
    );
    const timeoutTask = new Promise<ChatServiceResponse>((resolve, reject) => {
      timeout = setTimeout(() => {
        try {
          const response = this.#failTurn(
            prepared.turn.turnId,
            "timed_out",
            Object.assign(new Error("Codex took too long to answer."), {
              code: "CODEX_TIMEOUT",
            }),
          );
          controller.abort();
          resolve(response);
        } catch (error) {
          reject(error);
        }
      }, this.#modelTimeoutMs);
    });

    try {
      return await Promise.race([terminalTask, timeoutTask]);
    } finally {
      clearTimeout(timeout!);
    }
  }

  #completeTurn(
    turnId: string,
    result: { reply: string; command: import("../../lib/household-command-contract.ts").HouseholdCommand | null },
  ): ChatServiceResponse {
    return this.#transactionRunner.transaction((transaction) => {
      const running = this.#persistence.readTurn(transaction, turnId);
      if (!running || running.status !== "running") {
        return this.#currentAccepted(transaction, turnId);
      }

      let mutationOutcome: "no_command" | "applied" | "version_conflict" | "domain_rejected" =
        "no_command";
      if (result.command) {
        const mutation = this.#plannerMutationKernel.applyPlannerCommand(
          transaction,
          {
            requestId: `chat-command:${turnId}`,
            basePlannerVersion: running.inputPlannerVersion,
            command: result.command,
          },
          "Codex",
          { chatTurnId: turnId, now: this.#clock.now() },
        );
        mutationOutcome =
          mutation.decision.status === "accepted"
            ? "applied"
            : mutation.decision.status === "version_conflict"
              ? "version_conflict"
              : "domain_rejected";
        if (mutationOutcome === "applied") {
          this.#failureInjector.hit("after_planner_mutation");
        }
      }

      const now = this.#clock.now();
      const replyEntry = this.#persistence.insertTranscriptEntry(transaction, {
        entryId: this.#idFactory.createId("transcript"),
        role: "assistant",
        text: result.reply,
        context: running.context,
        turnId,
        occurredAt: now,
      });
      const terminalUpdate = result.command
        ? {
            status: "completed" as const,
            replyEntryId: replyEntry.entryId,
            proposedCommand: result.command,
            mutationOutcome: mutationOutcome as "applied" | "version_conflict" | "domain_rejected",
            errorCode: null,
            errorDetail: null,
            completedAt: now,
          }
        : {
            status: "completed" as const,
            replyEntryId: replyEntry.entryId,
            proposedCommand: null,
            mutationOutcome: "no_command" as const,
            errorCode: null,
            errorDetail: null,
            completedAt: now,
          };
      const changed = this.#persistence.updateTurnIfRunning(
        transaction,
        turnId,
        terminalUpdate,
      );
      if (!changed) throw new Error("Chat turn changed during its terminal transaction.");
      this.#persistence.incrementSyncRevision(transaction, now);
      this.#failureInjector.hit("after_chat_terminal_write");
      const response = this.#currentAccepted(transaction, turnId);
      this.#failureInjector.hit("before_commit");
      return response;
    });
  }

  #failTurn(
    turnId: string,
    outcome: "model_failed" | "timed_out",
    error: unknown,
  ): ChatServiceResponse {
    return this.#transactionRunner.transaction((transaction) => {
      const running = this.#persistence.readTurn(transaction, turnId);
      if (!running || running.status !== "running") {
        return this.#currentAccepted(transaction, turnId);
      }
      const now = this.#clock.now();
      const changed = this.#persistence.updateTurnIfRunning(transaction, turnId, {
        status: "failed",
        replyEntryId: null,
        proposedCommand: null,
        mutationOutcome: outcome,
        errorCode: errorCode(error),
        errorDetail: errorDetail(error),
        completedAt: now,
      });
      if (!changed) throw new Error("Chat turn changed during its failure transaction.");
      this.#persistence.incrementSyncRevision(transaction, now);
      this.#failureInjector.hit("after_chat_terminal_write");
      const response = this.#currentAccepted(transaction, turnId);
      this.#failureInjector.hit("before_commit");
      return response;
    });
  }

  #guardSubmit(
    transaction: Transaction,
    request: SubmitChatTurnRequest,
    hash: string,
  ): ChatServiceResponse | null {
    const replay = this.#resolveReceipt(
      transaction,
      "chat_submit",
      request.requestId,
      hash,
    );
    if (replay) return replay;
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    if (request.basePlannerVersion !== workspace.plannerVersion) {
      const decision: ChatTurnDecision = {
        status: "context_stale",
        expectedVersion: request.basePlannerVersion,
        actualVersion: workspace.plannerVersion,
      };
      this.#storeDecision(transaction, "chat_submit", request.requestId, hash, decision);
      return { decision, workspace };
    }
    if (!resolveCanonicalContext(workspace, request.context)) {
      const decision: ChatTurnDecision = {
        status: "not_found",
        message: "The selected planner context no longer exists.",
      };
      this.#storeDecision(transaction, "chat_submit", request.requestId, hash, decision);
      return { decision, workspace };
    }
    const running = this.#persistence.readRunningTurn(transaction);
    if (running) {
      const decision: ChatTurnDecision = { status: "turn_busy", runningTurn: running };
      this.#storeDecision(transaction, "chat_submit", request.requestId, hash, decision);
      return { decision, workspace };
    }
    return null;
  }

  #guardRetry(
    transaction: Transaction,
    request: RetryChatTurnRequest,
    hash: string,
  ): ChatServiceResponse | null {
    const replay = this.#resolveReceipt(
      transaction,
      "chat_retry",
      request.requestId,
      hash,
    );
    if (replay) return replay;
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    if (request.basePlannerVersion !== workspace.plannerVersion) {
      const decision: ChatTurnDecision = {
        status: "context_stale",
        expectedVersion: request.basePlannerVersion,
        actualVersion: workspace.plannerVersion,
      };
      this.#storeDecision(transaction, "chat_retry", request.requestId, hash, decision);
      return { decision, workspace };
    }
    const priorTurn = this.#persistence.readTurn(transaction, request.turnId);
    if (!priorTurn) {
      const decision: ChatTurnDecision = {
        status: "not_found",
        message: "The chat turn no longer exists.",
      };
      this.#storeDecision(transaction, "chat_retry", request.requestId, hash, decision);
      return { decision, workspace };
    }
    if (priorTurn.status !== "failed" && priorTurn.status !== "interrupted") {
      const decision: ChatTurnDecision = {
        status: "domain_rejected",
        message: "Only failed or interrupted chat turns can be retried.",
      };
      this.#storeDecision(transaction, "chat_retry", request.requestId, hash, decision);
      return { decision, workspace };
    }
    if (!resolveCanonicalContext(workspace, priorTurn.context)) {
      const decision: ChatTurnDecision = {
        status: "not_found",
        message: "The original planner context no longer exists.",
      };
      this.#storeDecision(transaction, "chat_retry", request.requestId, hash, decision);
      return { decision, workspace };
    }
    const userEntry = this.#persistence.readTranscriptEntry(
      transaction,
      priorTurn.userEntryId,
    );
    if (!userEntry || userEntry.role !== "user") {
      throw new Error("The retry source is missing its durable user transcript entry.");
    }
    const running = this.#persistence.readRunningTurn(transaction);
    if (running) {
      const decision: ChatTurnDecision = { status: "turn_busy", runningTurn: running };
      this.#storeDecision(transaction, "chat_retry", request.requestId, hash, decision);
      return { decision, workspace };
    }
    return null;
  }

  #resolveReceipt(
    transaction: Transaction,
    kind: ReceiptKind,
    requestId: string,
    hash: string,
  ): ChatServiceResponse | null {
    const receipt = this.#persistence.findReceipt(transaction, kind, requestId);
    if (!receipt) return null;
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    if (receipt.payloadHash !== hash) {
      return { decision: { status: "request_id_reuse" }, workspace };
    }
    const stored = receipt.decision as StoredDecision;
    if (stored?.kind === "accepted" && isRequestId(stored.turnId)) {
      const turn = this.#persistence.readTurn(transaction, stored.turnId);
      if (!turn) throw new Error("Accepted chat receipt references a missing turn.");
      return { decision: accepted(turn), workspace };
    }
    if (stored?.kind === "decision" && isStoredPublicDecision(stored.decision)) {
      return { decision: stored.decision, workspace };
    }
    throw new Error("Stored chat receipt has an invalid decision.");
  }

  #storeAccepted(
    transaction: Transaction,
    kind: ReceiptKind,
    requestId: string,
    hash: string,
    turnId: string,
  ) {
    this.#insertReceipt(transaction, kind, requestId, hash, 202, {
      kind: "accepted",
      turnId,
    });
  }

  #storeDecision(
    transaction: Transaction,
    kind: ReceiptKind,
    requestId: string,
    hash: string,
    decision: ChatTurnDecision,
  ) {
    this.#insertReceipt(transaction, kind, requestId, hash, decisionStatus(decision), {
      kind: "decision",
      decision,
    });
    this.#failureInjector.hit("before_commit");
  }

  #insertReceipt(
    transaction: Transaction,
    operationKind: ReceiptKind,
    requestId: string,
    hash: string,
    httpStatus: number,
    decision: StoredDecision,
  ) {
    const receipt: OperationReceipt = {
      operationKind,
      requestId,
      payloadHash: hash,
      httpStatus,
      decision,
      createdAt: this.#clock.now(),
    };
    this.#persistence.insertReceipt(transaction, receipt);
    this.#failureInjector.hit("after_receipt_insert");
  }

  #currentAccepted(transaction: Transaction, turnId: string): ChatServiceResponse {
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    const turn = this.#persistence.readTurn(transaction, turnId);
    if (!turn) throw new Error("Chat turn is missing from authoritative persistence.");
    return { decision: accepted(turn), workspace };
  }

  #immediateDecision(decision: ChatTurnDecision): ChatServiceResponse {
    return { decision, workspace: this.#plannerRead.readInitializedWorkspace() };
  }

  async #readCodexStatus() {
    try {
      return await this.#codexAdapter.readStatus();
    } catch (error) {
      return {
        available: false,
        authenticated: null,
        detail: errorDetail(error),
      };
    }
  }
}

export function createChatApplicationService<Transaction>(
  options: ChatApplicationServiceOptions<Transaction>,
): ChatApplicationService {
  return new DurableChatApplicationService(options);
}
