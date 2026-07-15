import type {
  InitializedWorkspace,
  OperationReceipt,
} from "../../lib/planner-api-contract.ts";
import {
  MODEL_TRANSCRIPT_TAIL_LIMIT,
  type NewChatResearchLifecycle,
  type ChatTurn,
  type ChatTurnDecision,
  type RetryChatTurnRequest,
  type SubmitChatTurnRequest,
  type TranscriptEntry,
} from "../../lib/planner-chat-contract.ts";
import type {
  ChatPersistencePort,
  ChatServiceResponse,
  Clock,
  FailureInjector,
  IdFactory,
  NewRunningChatTurn,
  PlannerReadPort,
  TransactionRunner,
} from "../application/ports.ts";
import { resolveCanonicalContext } from "./prompt.ts";

type ReceiptKind = "chat_submit" | "chat_retry";
type StoredDecision =
  | { kind: "accepted"; turnId: string }
  | { kind: "decision"; decision: ChatTurnDecision };

type ChatLifecycleBaseFields = Pick<
  NewRunningChatTurn,
  | "mode"
  | "completionTokenHash"
  | "appServerThreadId"
  | "appServerTurnId"
  | "foregroundAuthority"
  | "acceptedEffectCount"
  | "lastEffectSequence"
  | "recoveryOfTurnId"
  | "terminalOutcome"
>;

export type ChatLifecycleTurnFields = Omit<ChatLifecycleBaseFields, "mode"> &
  NewChatResearchLifecycle;

type TurnSetup<PrivateState> = {
  fields: ChatLifecycleTurnFields;
  privateState: PrivateState;
};

type PreparedContext<Transaction, PrivateState> = {
  transaction: Transaction;
  turn: ChatTurn;
  workspace: InitializedWorkspace;
  transcriptEntries: TranscriptEntry[];
  userEntry: TranscriptEntry;
  privateState: PrivateState;
  priorTurn: ChatTurn | null;
};

type BeginResult<Prepared> =
  | { response: ChatServiceResponse }
  | { prepared: Prepared };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
) {
  const keys = Object.keys(value).sort();
  const expected = [...required].sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

function isPlannerVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function accepted(turn: ChatTurn): ChatTurnDecision {
  return { status: "accepted", turn };
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

function isStoredPublicDecision(value: unknown): value is Exclude<
  ChatTurnDecision,
  { status: "accepted" }
> {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "request_id_reuse":
      return hasExactKeys(value, ["status"]);
    case "turn_busy":
      return hasExactKeys(value, ["status", "runningTurn"]) &&
        isRecord(value.runningTurn) && isRequestId(value.runningTurn.turnId);
    case "context_stale":
      return hasExactKeys(value, ["status", "expectedVersion", "actualVersion"]) &&
        isPlannerVersion(value.expectedVersion) && isPlannerVersion(value.actualVersion);
    case "not_found":
    case "domain_rejected":
    case "codex_unavailable":
      return hasExactKeys(value, ["status", "message"]) &&
        typeof value.message === "string" && value.message.length <= 1_000;
    default:
      return false;
  }
}

/**
 * The single durable submit/retry/receipt/interruption authority. Execution
 * variants supply only immutable turn fields and prompt/executor preparation.
 */
export class DurableChatLifecycleCoordinator<Transaction> {
  readonly #transactionRunner: TransactionRunner<Transaction>;
  readonly #persistence: ChatPersistencePort<Transaction>;
  readonly #plannerRead: PlannerReadPort<Transaction>;
  readonly #clock: Clock;
  readonly #idFactory: IdFactory;
  readonly #failureInjector: FailureInjector;

  constructor(options: {
    transactionRunner: TransactionRunner<Transaction>;
    persistence: ChatPersistencePort<Transaction>;
    plannerRead: PlannerReadPort<Transaction>;
    clock: Clock;
    idFactory: IdFactory;
    failureInjector: FailureInjector;
  }) {
    this.#transactionRunner = options.transactionRunner;
    this.#persistence = options.persistence;
    this.#plannerRead = options.plannerRead;
    this.#clock = options.clock;
    this.#idFactory = options.idFactory;
    this.#failureInjector = options.failureInjector;
  }

  guardSubmit(
    transaction: Transaction,
    request: SubmitChatTurnRequest,
    requestHash: string,
  ): ChatServiceResponse | null {
    const replay = this.#resolveReceipt(transaction, "chat_submit", request.requestId, requestHash);
    if (replay) return replay;
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    if (request.basePlannerVersion !== workspace.plannerVersion) {
      return this.#storeDecisionResponse(transaction, "chat_submit", request, requestHash, {
        status: "context_stale",
        expectedVersion: request.basePlannerVersion,
        actualVersion: workspace.plannerVersion,
      }, workspace);
    }
    if (!resolveCanonicalContext(workspace, request.context)) {
      return this.#storeDecisionResponse(transaction, "chat_submit", request, requestHash, {
        status: "not_found",
        message: "The selected planner context no longer exists.",
      }, workspace);
    }
    const running = this.#persistence.readRunningTurn(transaction);
    if (running) {
      return this.#storeDecisionResponse(transaction, "chat_submit", request, requestHash, {
        status: "turn_busy",
        runningTurn: running,
      }, workspace);
    }
    return null;
  }

  guardRetry(
    transaction: Transaction,
    request: RetryChatTurnRequest,
    requestHash: string,
  ): ChatServiceResponse | null {
    const replay = this.#resolveReceipt(transaction, "chat_retry", request.requestId, requestHash);
    if (replay) return replay;
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    if (request.basePlannerVersion !== workspace.plannerVersion) {
      return this.#storeDecisionResponse(transaction, "chat_retry", request, requestHash, {
        status: "context_stale",
        expectedVersion: request.basePlannerVersion,
        actualVersion: workspace.plannerVersion,
      }, workspace);
    }
    const prior = this.#persistence.readTurn(transaction, request.turnId);
    if (!prior) {
      return this.#storeDecisionResponse(transaction, "chat_retry", request, requestHash, {
        status: "not_found",
        message: "The chat turn no longer exists.",
      }, workspace);
    }
    if (prior.status !== "failed" && prior.status !== "interrupted") {
      return this.#storeDecisionResponse(transaction, "chat_retry", request, requestHash, {
        status: "domain_rejected",
        message: "Only failed or interrupted chat turns can be retried.",
      }, workspace);
    }
    if (!resolveCanonicalContext(workspace, prior.context)) {
      return this.#storeDecisionResponse(transaction, "chat_retry", request, requestHash, {
        status: "not_found",
        message: "The original planner context no longer exists.",
      }, workspace);
    }
    const userEntry = this.#persistence.readTranscriptEntry(transaction, prior.userEntryId);
    if (!userEntry || userEntry.role !== "user") {
      throw new Error("The retry source is missing its durable user transcript entry.");
    }
    const running = this.#persistence.readRunningTurn(transaction);
    if (running) {
      return this.#storeDecisionResponse(transaction, "chat_retry", request, requestHash, {
        status: "turn_busy",
        runningTurn: running,
      }, workspace);
    }
    return null;
  }

  beginSubmit<PrivateState, Prepared>(
    transaction: Transaction,
    request: SubmitChatTurnRequest,
    requestHash: string,
    blockedDecision: Exclude<ChatTurnDecision, { status: "accepted" }> | null,
    createTurn: (context: {
      transaction: Transaction;
      turnId: string;
      userEntryId: string;
      workspace: InitializedWorkspace;
      now: number;
    }) => TurnSetup<PrivateState>,
    prepare: (context: PreparedContext<Transaction, PrivateState>) => Prepared,
  ): BeginResult<Prepared> {
    const guarded = this.guardSubmit(transaction, request, requestHash);
    if (guarded) return { response: guarded };
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    if (blockedDecision) {
      return {
        response: this.#storeDecisionResponse(
          transaction,
          "chat_submit",
          request,
          requestHash,
          blockedDecision,
          workspace,
        ),
      };
    }
    const now = this.#clock.now();
    const turnId = this.#idFactory.createId("chat-turn");
    const userEntry = this.#persistence.insertTranscriptEntry(transaction, {
      entryId: this.#idFactory.createId("transcript"),
      role: "user",
      text: request.message,
      context: request.context,
      turnId,
      occurredAt: now,
    });
    const setup = createTurn({
      transaction,
      turnId,
      userEntryId: userEntry.entryId,
      workspace,
      now,
    });
    const turn = this.#persistence.insertRunningTurn(transaction, {
      turnId,
      requestId: request.requestId,
      userEntryId: userEntry.entryId,
      context: request.context,
      inputPlannerVersion: workspace.plannerVersion,
      retryOfTurnId: null,
      ...setup.fields,
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
    this.#storeAccepted(transaction, "chat_submit", request.requestId, requestHash, turnId);
    const prepared = prepare({
      transaction,
      turn,
      workspace: this.#plannerRead.readInitializedWorkspace(transaction),
      transcriptEntries: this.#persistence.readTranscriptTail(
        transaction,
        MODEL_TRANSCRIPT_TAIL_LIMIT,
      ),
      userEntry,
      privateState: setup.privateState,
      priorTurn: null,
    });
    this.#failureInjector.hit("before_commit");
    return { prepared };
  }

  beginRetry<PrivateState, Prepared>(
    transaction: Transaction,
    request: RetryChatTurnRequest,
    requestHash: string,
    blockedDecision: Exclude<ChatTurnDecision, { status: "accepted" }> | null,
    createTurn: (context: {
      transaction: Transaction;
      turnId: string;
      priorTurn: ChatTurn;
      userEntry: TranscriptEntry;
      workspace: InitializedWorkspace;
      now: number;
    }) => TurnSetup<PrivateState>,
    prepare: (context: PreparedContext<Transaction, PrivateState>) => Prepared,
  ): BeginResult<Prepared> {
    const guarded = this.guardRetry(transaction, request, requestHash);
    if (guarded) return { response: guarded };
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    if (blockedDecision) {
      return {
        response: this.#storeDecisionResponse(
          transaction,
          "chat_retry",
          request,
          requestHash,
          blockedDecision,
          workspace,
        ),
      };
    }
    const priorTurn = this.#persistence.readTurn(transaction, request.turnId);
    if (!priorTurn) throw new Error("Guarded chat retry source disappeared.");
    const userEntry = this.#persistence.readTranscriptEntry(transaction, priorTurn.userEntryId);
    if (!userEntry || userEntry.role !== "user") {
      throw new Error("Guarded chat retry source lost its durable user request.");
    }
    const now = this.#clock.now();
    const turnId = this.#idFactory.createId("chat-turn");
    const setup = createTurn({ transaction, turnId, priorTurn, userEntry, workspace, now });
    const turn = this.#persistence.insertRunningTurn(transaction, {
      turnId,
      requestId: request.requestId,
      userEntryId: priorTurn.userEntryId,
      context: priorTurn.context,
      inputPlannerVersion: workspace.plannerVersion,
      retryOfTurnId: priorTurn.turnId,
      ...setup.fields,
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
    this.#storeAccepted(transaction, "chat_retry", request.requestId, requestHash, turnId);
    const prepared = prepare({
      transaction,
      turn,
      workspace: this.#plannerRead.readInitializedWorkspace(transaction),
      transcriptEntries: this.#persistence.readTranscriptTail(
        transaction,
        MODEL_TRANSCRIPT_TAIL_LIMIT,
      ),
      userEntry,
      privateState: setup.privateState,
      priorTurn,
    });
    this.#failureInjector.hit("before_commit");
    return { prepared };
  }

  interruptRunningTurns(now = this.#clock.now()) {
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

  currentAccepted(transaction: Transaction, turnId: string): ChatServiceResponse {
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    const turn = this.#persistence.readTurn(transaction, turnId);
    if (!turn) throw new Error("Chat turn is missing from authoritative persistence.");
    return { decision: accepted(turn), workspace };
  }

  immediateDecision(decision: ChatTurnDecision): ChatServiceResponse {
    return { decision, workspace: this.#plannerRead.readInitializedWorkspace() };
  }

  #resolveReceipt(
    transaction: Transaction,
    kind: ReceiptKind,
    requestId: string,
    requestHash: string,
  ): ChatServiceResponse | null {
    const receipt = this.#persistence.findReceipt(transaction, kind, requestId);
    if (!receipt) return null;
    const workspace = this.#plannerRead.readInitializedWorkspace(transaction);
    if (receipt.payloadHash !== requestHash) {
      return { decision: { status: "request_id_reuse" }, workspace };
    }
    const stored = receipt.decision;
    if (
      isRecord(stored) && hasExactKeys(stored, ["kind", "turnId"]) &&
      stored.kind === "accepted" && isRequestId(stored.turnId)
    ) {
      const turn = this.#persistence.readTurn(transaction, stored.turnId);
      if (!turn) throw new Error("Accepted chat receipt references a missing turn.");
      return { decision: accepted(turn), workspace };
    }
    if (
      isRecord(stored) && hasExactKeys(stored, ["kind", "decision"]) &&
      stored.kind === "decision" && isStoredPublicDecision(stored.decision)
    ) {
      return { decision: stored.decision, workspace };
    }
    throw new Error("Stored chat receipt has an invalid decision.");
  }

  #storeDecisionResponse(
    transaction: Transaction,
    kind: ReceiptKind,
    request: Pick<SubmitChatTurnRequest, "requestId">,
    requestHash: string,
    decision: Exclude<ChatTurnDecision, { status: "accepted" }>,
    workspace: InitializedWorkspace,
  ): ChatServiceResponse {
    this.#insertReceipt(transaction, kind, request.requestId, requestHash, decisionStatus(decision), {
      kind: "decision",
      decision,
    });
    this.#failureInjector.hit("before_commit");
    return { decision, workspace };
  }

  #storeAccepted(
    transaction: Transaction,
    kind: ReceiptKind,
    requestId: string,
    requestHash: string,
    turnId: string,
  ) {
    this.#insertReceipt(transaction, kind, requestId, requestHash, 202, {
      kind: "accepted",
      turnId,
    });
  }

  #insertReceipt(
    transaction: Transaction,
    operationKind: ReceiptKind,
    requestId: string,
    payloadHash: string,
    httpStatus: number,
    decision: StoredDecision,
  ) {
    const receipt: OperationReceipt = {
      operationKind,
      requestId,
      payloadHash,
      httpStatus,
      decision,
      createdAt: this.#clock.now(),
    };
    this.#persistence.insertReceipt(transaction, receipt);
    this.#failureInjector.hit("after_receipt_insert");
  }
}
