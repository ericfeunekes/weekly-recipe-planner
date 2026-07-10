import type {
  ApplyPlannerCommandRequest,
  ApplyPlannerCommandResponse,
  BootstrapWorkspaceRequest,
  BootstrapWorkspaceResponse,
  ExportEnvelope,
  InitializedWorkspace,
  OperationReceipt,
  PageRequest,
  PlannerEventPage,
  PlannerActor,
  UndoLatestRequest,
  TranscriptPage,
  WorkspaceResponse,
} from "../../lib/planner-api-contract.ts";
import type {
  ChatTurn,
  ChatTurnDecision,
  RetryChatTurnRequest,
  SubmitChatTurnRequest,
  TranscriptEntry,
} from "../../lib/planner-chat-contract.ts";
import type { HouseholdCommand } from "../../lib/household-command-contract.ts";

export interface TransactionRunner<Transaction> {
  transaction<Result>(work: (transaction: Transaction) => Result): Result;
}

export interface PlannerMutationKernel<Transaction> {
  applyPlannerCommand(
    transaction: Transaction,
    request: ApplyPlannerCommandRequest,
    actor: PlannerActor,
    options?: { chatTurnId?: string; now?: number },
  ): ApplyPlannerCommandResponse;
}

export interface PlannerApplicationService {
  readWorkspace(): WorkspaceResponse;
  readEventPage(request: PageRequest): PlannerEventPage;
  readTranscriptPage(request: PageRequest): TranscriptPage;
  applyCommand(request: ApplyPlannerCommandRequest): ApplyPlannerCommandResponse;
  undoLatest(request: UndoLatestRequest): ApplyPlannerCommandResponse;
  bootstrap(request: BootstrapWorkspaceRequest): BootstrapWorkspaceResponse;
  exportWorkspace(): ExportEnvelope;
}

export interface ChatApplicationService {
  submit(request: SubmitChatTurnRequest): Promise<ChatServiceResponse>;
  retry(request: RetryChatTurnRequest): Promise<ChatServiceResponse>;
  interruptRunningTurns(now?: number): number;
}

export type ChatServiceResponse = {
  decision: ChatTurnDecision;
  workspace: InitializedWorkspace;
};

export type CodexCompletionRequest = {
  turnId: string;
  prompt: string;
  signal: AbortSignal;
};

export type CodexCompletionResult = {
  reply: string;
  command: HouseholdCommand | null;
};

export interface CodexPlannerAdapter {
  complete(request: CodexCompletionRequest): Promise<CodexCompletionResult>;
  readStatus(): Promise<{
    available: boolean;
    authenticated: boolean | null;
    detail: string;
  }>;
}

export const APPLICATION_FAILPOINTS = [
  "after_workspace_update",
  "after_event_insert",
  "after_receipt_insert",
  "after_planner_mutation",
  "after_chat_terminal_write",
  "before_commit",
] as const;

export type ApplicationFailpoint = (typeof APPLICATION_FAILPOINTS)[number];

export interface FailureInjector {
  hit(point: ApplicationFailpoint): void;
}

export type NewTranscriptEntry = Omit<TranscriptEntry, "sequence">;

export type ChatTurnTerminalUpdate =
  | {
      status: "completed";
      replyEntryId: string;
      proposedCommand: null;
      mutationOutcome: "no_command";
      errorCode: null;
      errorDetail: null;
      completedAt: number;
    }
  | {
      status: "completed";
      replyEntryId: string;
      proposedCommand: HouseholdCommand;
      mutationOutcome: "applied" | "version_conflict" | "domain_rejected";
      errorCode: null;
      errorDetail: null;
      completedAt: number;
    }
  | {
      status: "failed";
      replyEntryId: null;
      proposedCommand: null;
      mutationOutcome: "model_failed" | "timed_out";
      errorCode: string;
      errorDetail: string | null;
      completedAt: number;
    }
  | {
      status: "interrupted";
      replyEntryId: null;
      proposedCommand: null;
      mutationOutcome: null;
      errorCode: string;
      errorDetail: string | null;
      completedAt: number;
    };

export type NewRunningChatTurn = Omit<
  ChatTurn,
  | "turnSequence"
  | "status"
  | "replyEntryId"
  | "proposedCommand"
  | "mutationOutcome"
  | "errorCode"
  | "errorDetail"
  | "completedAt"
> & {
  status: "running";
  replyEntryId: null;
  proposedCommand: null;
  mutationOutcome: null;
  errorCode: null;
  errorDetail: null;
  completedAt: null;
};

export interface ChatPersistencePort<Transaction> {
  findReceipt(
    transaction: Transaction,
    operationKind: "chat_submit" | "chat_retry",
    requestId: string,
  ): OperationReceipt | null;
  insertReceipt(transaction: Transaction, receipt: OperationReceipt): void;
  readRunningTurn(transaction: Transaction): ChatTurn | null;
  readTurn(transaction: Transaction, turnId: string): ChatTurn | null;
  readTranscriptEntry(
    transaction: Transaction,
    entryId: string,
  ): TranscriptEntry | null;
  readTranscriptTail(transaction: Transaction, limit: number): TranscriptEntry[];
  insertTranscriptEntry(
    transaction: Transaction,
    entry: NewTranscriptEntry,
  ): TranscriptEntry;
  insertRunningTurn(
    transaction: Transaction,
    turn: NewRunningChatTurn,
  ): ChatTurn;
  updateTurnIfRunning(
    transaction: Transaction,
    turnId: string,
    update: ChatTurnTerminalUpdate,
  ): boolean;
  interruptRunningTurns(transaction: Transaction, completedAt: number): number;
  incrementSyncRevision(transaction: Transaction, updatedAt: number): number;
}

export interface PlannerReadPort {
  readInitializedWorkspace(): InitializedWorkspace;
}

export interface IdFactory {
  createId(prefix: string): string;
}

export interface Clock {
  now(): number;
}
