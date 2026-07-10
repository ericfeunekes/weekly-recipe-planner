import type { HouseholdCommand } from "./household-command-contract";
import { isWeekId, type WeekId } from "./household-contract.ts";

export const CHAT_TURN_STATUSES = [
  "running",
  "completed",
  "failed",
  "interrupted",
] as const;

export const CHAT_MUTATION_OUTCOMES = [
  "no_command",
  "applied",
  "version_conflict",
  "domain_rejected",
  "model_failed",
  "timed_out",
] as const;

export type ChatTurnStatus = (typeof CHAT_TURN_STATUSES)[number];
export type ChatMutationOutcome = (typeof CHAT_MUTATION_OUTCOMES)[number];
export type TranscriptRole = "user" | "assistant" | "system";
export type PlannerView = "week" | "tonight" | "prep" | "groceries" | "closeout";

type PlannerContextReference =
  | { weekId: WeekId; mealId?: never; stepId?: never }
  | { weekId: WeekId; mealId: string; stepId?: never }
  | { weekId: WeekId; mealId: string; stepId: string };

export type PlannerChatContext = { view: PlannerView } & PlannerContextReference;

export type TranscriptEntry = {
  sequence: number;
  entryId: string;
  role: TranscriptRole;
  text: string;
  context: PlannerChatContext | null;
  turnId: string | null;
  occurredAt: number;
};

export type ChatTurn = {
  turnId: string;
  requestId: string;
  turnSequence: number;
  status: ChatTurnStatus;
  userEntryId: string;
  context: PlannerChatContext;
  inputPlannerVersion: number;
  replyEntryId: string | null;
  proposedCommand: HouseholdCommand | null;
  mutationOutcome: ChatMutationOutcome | null;
  retryOfTurnId: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
};

export type SubmitChatTurnRequest = {
  requestId: string;
  basePlannerVersion: number;
  message: string;
  context: PlannerChatContext;
};

export type RetryChatTurnRequest = {
  requestId: string;
  basePlannerVersion: number;
  turnId: string;
};

export type ChatTurnDecision =
  | { status: "accepted"; turn: ChatTurn }
  | { status: "turn_busy"; runningTurn: ChatTurn }
  | {
      status: "context_stale";
      expectedVersion: number;
      actualVersion: number;
    }
  | { status: "request_id_reuse" }
  | { status: "not_found"; message: string }
  | { status: "domain_rejected"; message: string }
  | { status: "codex_unavailable"; message: string };

export const MODEL_TRANSCRIPT_TAIL_LIMIT = 12;
export const WORKSPACE_TRANSCRIPT_TAIL_LIMIT = 50;
export const WORKSPACE_CHAT_TURN_TAIL_LIMIT = 20;

const PLANNER_VIEWS: PlannerView[] = [
  "week",
  "tonight",
  "prep",
  "groceries",
  "closeout",
];

export function isPlannerChatContext(value: unknown): value is PlannerChatContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    !keys.every((key) => ["view", "weekId", "mealId", "stepId"].includes(key)) ||
    !keys.includes("view") ||
    !keys.includes("weekId") ||
    !PLANNER_VIEWS.includes(candidate.view as PlannerView) ||
    !isWeekId(candidate.weekId)
  ) {
    return false;
  }
  const isId = (id: unknown) =>
    typeof id === "string" && id.trim().length > 0 && id.length <= 200;
  if (candidate.mealId !== undefined && !isId(candidate.mealId)) return false;
  if (candidate.stepId !== undefined && !isId(candidate.stepId)) return false;
  return candidate.stepId === undefined || candidate.mealId !== undefined;
}
