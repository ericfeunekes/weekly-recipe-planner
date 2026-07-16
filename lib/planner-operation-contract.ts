import {
  isHistoricalGroceryReconciliationCommand,
  isHouseholdCommand,
  type HistoricalGroceryReconciliationCommand,
  type HouseholdCommand,
} from "./household-command-contract.ts";
import type { InitializedWorkspace } from "./planner-api-contract.ts";

export const MIN_PLANNER_OPERATIONS = 1;
export const MAX_PLANNER_OPERATIONS = 16;
export const GENERATED_AFTER_APPLY = "[generated after apply]" as const;

export type PlannerOperation = { command: HouseholdCommand };
export type HistoricalPlannerEventOperation = {
  command: HouseholdCommand | HistoricalGroceryReconciliationCommand;
};

export type PlannerActor = "Household" | "Codex";

export type PlannerEventProvenance =
  | {
      actorClass: "household";
      actorSource: "browser";
      admission: "same_origin_http_v1";
    }
  | {
      actorClass: "codex";
      actorSource: "embedded_legacy";
      admission: "structured_output_v1";
    }
  | {
      actorClass: "codex";
      actorSource: "embedded";
      admission: "app_server_dynamic_v1";
    }
  | {
      actorClass: "codex";
      actorSource: "global";
      admission: "same_uid_uds_v1";
    };

export const BROWSER_PROVENANCE = {
  actorClass: "household",
  actorSource: "browser",
  admission: "same_origin_http_v1",
} as const satisfies PlannerEventProvenance;

export const EMBEDDED_LEGACY_PROVENANCE = {
  actorClass: "codex",
  actorSource: "embedded_legacy",
  admission: "structured_output_v1",
} as const satisfies PlannerEventProvenance;

export const EMBEDDED_CODEX_PROVENANCE = {
  actorClass: "codex",
  actorSource: "embedded",
  admission: "app_server_dynamic_v1",
} as const satisfies PlannerEventProvenance;

export const GLOBAL_CODEX_PROVENANCE = {
  actorClass: "codex",
  actorSource: "global",
  admission: "same_uid_uds_v1",
} as const satisfies PlannerEventProvenance;

export const OPERATION_KINDS = [
  "planner_command",
  "planner_chat_command",
  "planner_undo",
  "workspace_bootstrap",
  "chat_submit",
  "chat_retry",
  "embedded_codex_apply_planner_operations_v1",
  "native_codex_apply_planner_operations_v1",
  "global_codex_apply_planner_batch_v1",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];
export type PlannerApplyOperationKind =
  | "planner_command"
  | "planner_chat_command"
  | "embedded_codex_apply_planner_operations_v1"
  | "native_codex_apply_planner_operations_v1"
  | "global_codex_apply_planner_batch_v1";

export type ApplyPlannerOperationsRequest = {
  requestId: string;
  basePlannerVersion: number;
  operations: PlannerOperation[];
};

export type PlannerMutationContext = {
  operationKind: PlannerApplyOperationKind;
  provenance: PlannerEventProvenance;
  chatTurnId?: string;
  now?: number;
};

export type PlannerOperationsDecision =
  | { status: "accepted"; eventId: string; plannerVersion: number }
  | {
      status: "version_conflict";
      expectedVersion: number;
      actualVersion: number;
    }
  | { status: "domain_rejected"; operationIndex: number; message: string };

export type ApplyPlannerOperationsResponse = {
  decision: PlannerOperationsDecision;
  workspace: InitializedWorkspace;
};

export type PreviewPlannerOperationsRequest = {
  basePlannerVersion: number;
  operations: PlannerOperation[];
};

export type PlannerOperationPreview = {
  operationIndex: number;
  summary: string;
  target: string;
  changes: string[];
};

export type PreviewPlannerOperationsDecision =
  | {
      status: "previewed";
      plannerVersion: number;
      outcomes: PlannerOperationPreview[];
    }
  | {
      status: "version_conflict";
      expectedVersion: number;
      actualVersion: number;
    }
  | { status: "domain_rejected"; operationIndex: number; message: string };

export type PreviewPlannerOperationsResponse = {
  decision: PreviewPlannerOperationsDecision;
};

export type PlannerBatchEventCommand = {
  type: "plannerBatch";
  operations: HistoricalPlannerEventOperation[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isPlannerOperation(value: unknown): value is PlannerOperation {
  return isRecord(value) && hasExactKeys(value, ["command"]) && isHouseholdCommand(value.command);
}

export function isPlannerOperationList(value: unknown): value is PlannerOperation[] {
  return Array.isArray(value) &&
    value.length >= MIN_PLANNER_OPERATIONS &&
    value.length <= MAX_PLANNER_OPERATIONS &&
    value.every(isPlannerOperation);
}

function isHistoricalPlannerEventOperation(
  value: unknown,
): value is HistoricalPlannerEventOperation {
  return isRecord(value) && hasExactKeys(value, ["command"]) &&
    (isHouseholdCommand(value.command) || isHistoricalGroceryReconciliationCommand(value.command));
}

export function isHistoricalPlannerEventOperationList(
  value: unknown,
): value is HistoricalPlannerEventOperation[] {
  return Array.isArray(value) &&
    value.length >= MIN_PLANNER_OPERATIONS &&
    value.length <= MAX_PLANNER_OPERATIONS &&
    value.every(isHistoricalPlannerEventOperation);
}

export function isApplyPlannerOperationsRequest(
  value: unknown,
): value is ApplyPlannerOperationsRequest {
  return isRecord(value) &&
    hasExactKeys(value, ["requestId", "basePlannerVersion", "operations"]) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 200 &&
    Number.isSafeInteger(value.basePlannerVersion) &&
    Number(value.basePlannerVersion) >= 0 &&
    isPlannerOperationList(value.operations);
}

export function isPreviewPlannerOperationsRequest(
  value: unknown,
): value is PreviewPlannerOperationsRequest {
  return isRecord(value) &&
    hasExactKeys(value, ["basePlannerVersion", "operations"]) &&
    Number.isSafeInteger(value.basePlannerVersion) &&
    Number(value.basePlannerVersion) >= 0 &&
    isPlannerOperationList(value.operations);
}

export function plannerActorForProvenance(
  provenance: PlannerEventProvenance,
): PlannerActor {
  return provenance.actorClass === "household" ? "Household" : "Codex";
}

function sameProvenance(
  left: unknown,
  right: PlannerEventProvenance,
): boolean {
  return isRecord(left) &&
    left.actorClass === right.actorClass &&
    left.actorSource === right.actorSource &&
    left.admission === right.admission;
}

function expectedProvenance(
  operationKind: unknown,
): PlannerEventProvenance | null {
  switch (operationKind) {
    case "planner_command":
      return BROWSER_PROVENANCE;
    case "planner_chat_command":
      return EMBEDDED_LEGACY_PROVENANCE;
    case "embedded_codex_apply_planner_operations_v1":
    case "native_codex_apply_planner_operations_v1":
      return EMBEDDED_CODEX_PROVENANCE;
    case "global_codex_apply_planner_batch_v1":
      return GLOBAL_CODEX_PROVENANCE;
    default:
      return null;
  }
}

export function isValidPlannerMutationContext(
  context: PlannerMutationContext,
  operationCount: number,
): boolean {
  if (!Number.isSafeInteger(operationCount) || operationCount < 1 || operationCount > 16) return false;
  const expected = expectedProvenance(context.operationKind);
  if (expected === null || !sameProvenance(context.provenance, expected)) return false;
  if (
    (context.operationKind === "planner_command" || context.operationKind === "planner_chat_command") &&
    operationCount !== 1
  ) {
    return false;
  }
  const requiresChatTurn = context.operationKind === "planner_chat_command" ||
    context.operationKind === "embedded_codex_apply_planner_operations_v1";
  return requiresChatTurn
    ? typeof context.chatTurnId === "string" && context.chatTurnId.length > 0
    : context.chatTurnId === undefined;
}
