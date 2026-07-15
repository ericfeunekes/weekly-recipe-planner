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
  UndoLatestRequest,
  TranscriptPage,
  WorkspaceResponse,
} from "../../lib/planner-api-contract.ts";
import type {
  ChatTurn,
  ChatTurnBase,
  ChatTurnDecision,
  NewChatResearchLifecycle,
  RetryChatTurnRequest,
  SubmitChatTurnRequest,
  TranscriptEntry,
} from "../../lib/planner-chat-contract.ts";
import type {
  ApplyPlannerOperationsRequest,
  ApplyPlannerOperationsResponse,
  PlannerMutationContext,
  PreviewPlannerOperationsRequest,
  PreviewPlannerOperationsResponse,
} from "../../lib/planner-operation-contract.ts";
import type {
  PlannerToolName,
  PlannerToolResult,
} from "../../lib/planner-tool-contract.ts";
import type { ResearchCandidateReference } from "../../lib/sourced-recipe-contract.ts";

export interface TransactionRunner<Transaction> {
  transaction<Result>(work: (transaction: Transaction) => Result): Result;
}

export interface PlannerMutationKernel<Transaction> {
  previewPlannerOperations(
    transaction: Transaction,
    request: PreviewPlannerOperationsRequest,
  ): PreviewPlannerOperationsResponse;
  applyPlannerOperations(
    transaction: Transaction,
    request: ApplyPlannerOperationsRequest,
    context: PlannerMutationContext,
  ): ApplyPlannerOperationsResponse;
}

export interface PlannerApplicationService {
  readWorkspace(): WorkspaceResponse;
  readEventPage(request: PageRequest): PlannerEventPage;
  readTranscriptPage(request: PageRequest): TranscriptPage;
  applyCommand(request: ApplyPlannerCommandRequest): ApplyPlannerCommandResponse;
  applyOperations(
    request: ApplyPlannerOperationsRequest,
    context: PlannerMutationContext,
  ): ApplyPlannerOperationsResponse;
  previewOperations(
    request: PreviewPlannerOperationsRequest,
  ): PreviewPlannerOperationsResponse;
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

export const APPLICATION_FAILPOINTS = [
  "after_workspace_update",
  "after_event_insert",
  "after_receipt_insert",
  "after_planner_mutation",
  "after_chat_terminal_write",
  "after_tool_reservation",
  "before_tool_effect_commit",
  "after_tool_effect_commit",
  "after_tool_response",
  "after_embedded_terminal_reply",
  "after_research_candidate_attachment",
  "before_commit",
] as const;

export type ApplicationFailpoint = (typeof APPLICATION_FAILPOINTS)[number];

export interface FailureInjector {
  hit(point: ApplicationFailpoint): void;
}

export type NewTranscriptEntry = Omit<TranscriptEntry, "sequence">;

export type NewRunningChatTurn = Omit<
  ChatTurnBase,
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
} & NewChatResearchLifecycle;

export const PLANNER_TOOL_CALL_STATUSES = [
  "running",
  "succeeded",
  "rejected",
  "cancelled",
  "timed_out",
  "abandoned",
] as const;

export type PlannerToolCallStatus =
  (typeof PLANNER_TOOL_CALL_STATUSES)[number];

export type EmbeddedTurnIdentity = {
  turnId: string;
  completionTokenHash: string;
  appServerThreadId: string;
  appServerTurnId: string;
};

export type PlannerToolCallIdentity = EmbeddedTurnIdentity & {
  toolCallId: string;
  appServerCallId: string;
  callbackIdentityHash: string;
  tool: PlannerToolName;
  argumentHash: string;
};

export type PlannerToolCall = PlannerToolCallIdentity & {
  sequence: number;
  status: PlannerToolCallStatus;
  resultCode: string | null;
  operationKind: "embedded_codex_apply_planner_operations_v1" | null;
  requestId: string | null;
  eventId: string | null;
  basePlannerVersion: number | null;
  resultPlannerVersion: number | null;
  resultEnvelope: PlannerToolResult | null;
  effectSequence: number | null;
  createdAt: number;
  completedAt: number | null;
};

export type PlannerToolCallReservation = PlannerToolCallIdentity & {
  createdAt: number;
};

export type PlannerToolCallReservationDecision =
  | { status: "reserved"; call: PlannerToolCall }
  | { status: "replay"; call: PlannerToolCall }
  | { status: "orphaned"; call: PlannerToolCall }
  | { status: "duplicate_mismatch" }
  | { status: "late_call" }
  | { status: "turn_not_running" }
  | { status: "turn_unbound" }
  | { status: "call_limit" };

export type PlannerToolCallCompletion = PlannerToolCallIdentity & {
  status: Exclude<PlannerToolCallStatus, "running">;
  resultCode: string;
  resultEnvelope: PlannerToolResult;
  completedAt: number;
  operationKind?: "embedded_codex_apply_planner_operations_v1";
  requestId?: string;
  eventId?: string;
  basePlannerVersion?: number;
  resultPlannerVersion?: number;
  effectSequence?: number;
};

export type EmbeddedTurnTerminalUpdate = {
  status: "completed" | "failed" | "interrupted";
  replyEntryId: string | null;
  mutationOutcome: "no_command" | "model_failed" | "timed_out" | null;
  errorCode: string | null;
  errorDetail: string | null;
  terminalOutcome: ChatTurn["terminalOutcome"];
  completedAt: number;
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
  interruptRunningTurns(transaction: Transaction, completedAt: number): number;
  bindEmbeddedTurn(
    transaction: Transaction,
    turnId: string,
    completionTokenHash: string,
    appServerThreadId: string,
    appServerTurnId: string,
  ): boolean;
  attachResearchCandidate(
    transaction: Transaction,
    turnId: string,
    completionTokenHash: string,
    reference: ResearchCandidateReference,
  ): boolean;
  reservePlannerToolCall(
    transaction: Transaction,
    reservation: PlannerToolCallReservation,
  ): PlannerToolCallReservationDecision;
  completePlannerToolCall(
    transaction: Transaction,
    completion: PlannerToolCallCompletion,
  ): boolean;
  incrementEmbeddedTurnEffect(
    transaction: Transaction,
    identity: EmbeddedTurnIdentity,
  ): number | null;
  terminalizeEmbeddedTurn(
    transaction: Transaction,
    identity: EmbeddedTurnIdentity,
    update: EmbeddedTurnTerminalUpdate,
  ): boolean;
  terminalizeUnboundEmbeddedTurn(
    transaction: Transaction,
    turnId: string,
    completionTokenHash: string,
    update: EmbeddedTurnTerminalUpdate,
  ): boolean;
  readPlannerToolCalls(
    transaction: Transaction,
    turnId: string,
  ): PlannerToolCall[];
  incrementSyncRevision(transaction: Transaction, updatedAt: number): number;
}

export interface PlannerReadPort<Transaction = unknown> {
  readInitializedWorkspace(transaction?: Transaction): InitializedWorkspace;
}

export interface IdFactory {
  createId(prefix: string): string;
}

export interface Clock {
  now(): number;
}
