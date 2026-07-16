import type { HouseholdCommand } from "./household-command-contract";
import type { ForegroundAuthority } from "./planner-tool-contract.ts";
import { isWeekId, type WeekId } from "./household-contract.ts";
import {
  isResearchCandidateReference,
  type ResearchCandidateReference,
} from "./sourced-recipe-contract.ts";

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
export const CHAT_TURN_MODES = ["normal", "recovery"] as const;
export const CHAT_RESEARCH_KINDS = ["none", "sourced_recipe"] as const;
export const CHAT_TURN_TERMINAL_OUTCOMES = [
  "completed_no_effect",
  "completed_with_effects",
  "failed_no_effect",
  "failed_after_effect",
  "interrupted_no_effect",
  "interrupted_after_effect",
  "recovery_completed",
  "recovery_failed",
] as const;
export type ChatTurnMode = (typeof CHAT_TURN_MODES)[number];
export type ChatResearchKind = (typeof CHAT_RESEARCH_KINDS)[number];
export type ChatTurnTerminalOutcome =
  (typeof CHAT_TURN_TERMINAL_OUTCOMES)[number];
export type TranscriptRole = "user" | "assistant" | "system";
export type PlannerView = "week" | "tonight" | "prep" | "groceries" | "closeout";

type PlannerContextReference =
  | { weekId?: never; mealId?: never; stepId?: never; leftoverId?: never }
  | { weekId: WeekId; mealId?: never; stepId?: never; leftoverId?: never }
  | { weekId: WeekId; mealId: string; stepId?: never; leftoverId?: never }
  | { weekId: WeekId; mealId: string; stepId: string; leftoverId?: never }
  | { weekId: WeekId; mealId?: never; stepId?: never; leftoverId: string };

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

export type ChatResearchLifecycle =
  | { mode: "normal"; researchKind: "none"; researchCandidate: null }
  | {
      mode: "normal";
      researchKind: "sourced_recipe";
      researchCandidate: ResearchCandidateReference | null;
    }
  | { mode: "recovery"; researchKind: "none"; researchCandidate: null };

/** Legacy SQLite rows may be read/exported but are no longer runtime turns. */
export type NewChatResearchLifecycle =
  | { mode: "normal"; researchKind: "none"; researchCandidate: null }
  | { mode: "normal"; researchKind: "sourced_recipe"; researchCandidate: null }
  | { mode: "recovery"; researchKind: "none"; researchCandidate: null };

export function isChatResearchLifecycle(value: unknown): value is ChatResearchLifecycle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === "recovery") {
    return candidate.researchKind === "none" && candidate.researchCandidate === null;
  }
  if (candidate.mode !== "normal") return false;
  if (candidate.researchKind === "none") return candidate.researchCandidate === null;
  return candidate.researchKind === "sourced_recipe" &&
    (candidate.researchCandidate === null ||
      isResearchCandidateReference(candidate.researchCandidate));
}

export type ChatTurnBase = {
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
  completionTokenHash: string | null;
  appServerThreadId: string | null;
  appServerTurnId: string | null;
  foregroundAuthority: ForegroundAuthority;
  acceptedEffectCount: number;
  lastEffectSequence: number;
  recoveryOfTurnId: string | null;
  terminalOutcome: ChatTurnTerminalOutcome | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdAt: number;
  startedAt: number;
  completedAt: number | null;
};

export type ChatTurn = ChatTurnBase & ChatResearchLifecycle;

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
    !keys.every((key) => ["view", "weekId", "mealId", "stepId", "leftoverId"].includes(key)) ||
    !keys.includes("view") ||
    !PLANNER_VIEWS.includes(candidate.view as PlannerView)
  ) {
    return false;
  }
  if (!keys.includes("weekId")) return keys.length === 1;
  if (!isWeekId(candidate.weekId)) return false;
  const isId = (id: unknown) =>
    typeof id === "string" && id.trim().length > 0 && id.length <= 200;
  if (candidate.mealId !== undefined && !isId(candidate.mealId)) return false;
  if (candidate.stepId !== undefined && !isId(candidate.stepId)) return false;
  if (candidate.leftoverId !== undefined && !isId(candidate.leftoverId)) return false;
  if (candidate.leftoverId !== undefined) {
    return candidate.mealId === undefined && candidate.stepId === undefined;
  }
  return candidate.stepId === undefined || candidate.mealId !== undefined;
}
