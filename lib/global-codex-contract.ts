import { homedir } from "node:os";
import { join } from "node:path";

import { validateHouseholdState } from "./household-domain.ts";
import { isHouseholdCommand } from "./household-command-contract.ts";
import type { HouseholdPlannerState } from "./household-contract.ts";
import type {
  PlannerEvent,
  PlannerEventCommand,
} from "./planner-api-contract.ts";
import {
  isPlannerOperationList,
  type PlannerEventProvenance,
  type PlannerOperation,
  type PlannerOperationsDecision,
} from "./planner-operation-contract.ts";

export const GLOBAL_CODEX_CONTRACT_VERSION = 1 as const;
export const GLOBAL_CODEX_SOCKET_PATH = join(
  homedir(),
  "meal-planner",
  "run",
  "global-codex.sock",
);
export const GLOBAL_CODEX_REQUEST_MAX_BYTES = 163_840;
export const GLOBAL_CODEX_RESPONSE_MAX_BYTES = 67_108_864;
export const GLOBAL_CODEX_EVENT_TAIL_LIMIT = 50;

export const GLOBAL_CODEX_ROUTES = {
  health: "/v1/health",
  workspace: "/v1/workspace",
  batches: "/v1/planner/batches",
} as const;

export type GlobalCodexBatchRequest = {
  contractVersion: 1;
  requestId: string;
  basePlannerVersion: number;
  operations: PlannerOperation[];
};

export type PlannerReadEvent = Omit<PlannerEvent, "chatTurnId">;

export type PlannerReadProjection =
  | {
      initialized: false;
      schemaVersion: number;
      events: PlannerReadEvent[];
    }
  | {
      initialized: true;
      schemaVersion: number;
      plannerVersion: number;
      syncRevision: number;
      state: HouseholdPlannerState;
      events: PlannerReadEvent[];
    };

export type GlobalCodexHealthResponse = {
  contractVersion: 1;
  status: "ready";
  serverTime: number;
};

export type GlobalCodexWorkspaceResponse = {
  contractVersion: 1;
  planner: PlannerReadProjection;
};

export type GlobalCodexApplyResponse = {
  contractVersion: 1;
  decision: PlannerOperationsDecision;
  planner: PlannerReadProjection;
};

export const GLOBAL_CODEX_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  "version_conflict",
  "request_id_reuse",
  "planner_unavailable",
  "internal_error",
] as const;

export type GlobalCodexErrorCode = (typeof GLOBAL_CODEX_ERROR_CODES)[number];

export type GlobalCodexErrorResponse = {
  contractVersion: 1;
  error: {
    code: GlobalCodexErrorCode;
    message: string;
    fieldErrors?: Record<string, string>;
  };
};

export type GlobalCodexResponse =
  | GlobalCodexHealthResponse
  | GlobalCodexWorkspaceResponse
  | GlobalCodexApplyResponse
  | GlobalCodexErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function isGlobalCodexBatchRequest(value: unknown): value is GlobalCodexBatchRequest {
  return isRecord(value) &&
    hasExactKeys(value, ["contractVersion", "requestId", "basePlannerVersion", "operations"]) &&
    value.contractVersion === GLOBAL_CODEX_CONTRACT_VERSION &&
    isUuid(value.requestId) &&
    isNonNegativeSafeInteger(value.basePlannerVersion) &&
    isPlannerOperationList(value.operations);
}

function isProvenance(value: unknown): value is PlannerEventProvenance {
  if (!isRecord(value) || !hasExactKeys(value, ["actorClass", "actorSource", "admission"])) return false;
  const signature = `${String(value.actorClass)}:${String(value.actorSource)}:${String(value.admission)}`;
  return signature === "household:browser:same_origin_http_v1" ||
    signature === "codex:embedded_legacy:structured_output_v1" ||
    signature === "codex:embedded:app_server_dynamic_v1" ||
    signature === "codex:global:same_uid_uds_v1";
}

function isPlannerEventCommand(value: unknown): value is PlannerEventCommand {
  if (isHouseholdCommand(value)) return true;
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "plannerBatch") {
    return hasExactKeys(value, ["type", "operations"]) && isPlannerOperationList(value.operations);
  }
  return value.type === "undoLatest" &&
    hasExactKeys(value, ["type", "targetEventId"]) &&
    typeof value.targetEventId === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPlannerReadEvent(value: unknown): value is PlannerReadEvent {
  if (!isRecord(value) || !hasExactKeys(value, [
    "sequence",
    "eventId",
    "requestId",
    "actor",
    "provenance",
    "command",
    "baseVersion",
    "resultVersion",
    "summary",
    "target",
    "changes",
    "revertsEventId",
    "occurredAt",
  ])) return false;
  return Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0 &&
    typeof value.eventId === "string" &&
    typeof value.requestId === "string" &&
    (value.actor === "Household" || value.actor === "Codex") &&
    isProvenance(value.provenance) &&
    isPlannerEventCommand(value.command) &&
    isNonNegativeSafeInteger(value.baseVersion) &&
    isNonNegativeSafeInteger(value.resultVersion) &&
    typeof value.summary === "string" &&
    typeof value.target === "string" &&
    isStringArray(value.changes) &&
    (value.revertsEventId === null || typeof value.revertsEventId === "string") &&
    isNonNegativeSafeInteger(value.occurredAt);
}

export function isPlannerReadProjection(value: unknown): value is PlannerReadProjection {
  if (!isRecord(value) || typeof value.initialized !== "boolean" ||
      !isNonNegativeSafeInteger(value.schemaVersion) || !Array.isArray(value.events) ||
      value.events.length > GLOBAL_CODEX_EVENT_TAIL_LIMIT ||
      !value.events.every(isPlannerReadEvent)) return false;
  if (!value.initialized) {
    return hasExactKeys(value, ["initialized", "schemaVersion", "events"]) && value.events.length === 0;
  }
  if (!hasExactKeys(value, [
    "initialized",
    "schemaVersion",
    "plannerVersion",
    "syncRevision",
    "state",
    "events",
  ]) || !isNonNegativeSafeInteger(value.plannerVersion) ||
      !isNonNegativeSafeInteger(value.syncRevision)) return false;
  try {
    return validateHouseholdState(value.state as HouseholdPlannerState).ok;
  } catch {
    return false;
  }
}

function isDecision(value: unknown): value is PlannerOperationsDecision {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "accepted") {
    return hasExactKeys(value, ["status", "eventId", "plannerVersion"]) &&
      typeof value.eventId === "string" && isNonNegativeSafeInteger(value.plannerVersion);
  }
  if (value.status === "version_conflict") {
    return hasExactKeys(value, ["status", "expectedVersion", "actualVersion"]) &&
      isNonNegativeSafeInteger(value.expectedVersion) && isNonNegativeSafeInteger(value.actualVersion);
  }
  return value.status === "domain_rejected" &&
    hasExactKeys(value, ["status", "operationIndex", "message"]) &&
    isNonNegativeSafeInteger(value.operationIndex) && typeof value.message === "string";
}

function isFieldErrors(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function isGlobalCodexResponse(value: unknown): value is GlobalCodexResponse {
  if (!isRecord(value) || value.contractVersion !== GLOBAL_CODEX_CONTRACT_VERSION) return false;
  if ("status" in value) {
    return hasExactKeys(value, ["contractVersion", "status", "serverTime"]) &&
      value.status === "ready" && isNonNegativeSafeInteger(value.serverTime);
  }
  if ("error" in value) {
    if (!hasExactKeys(value, ["contractVersion", "error"]) || !isRecord(value.error) ||
        !hasExactKeys(value.error, ["code", "message"], ["fieldErrors"]) ||
        !GLOBAL_CODEX_ERROR_CODES.includes(value.error.code as GlobalCodexErrorCode) ||
        typeof value.error.message !== "string") return false;
    return value.error.fieldErrors === undefined || isFieldErrors(value.error.fieldErrors);
  }
  if ("decision" in value) {
    return hasExactKeys(value, ["contractVersion", "decision", "planner"]) &&
      isDecision(value.decision) && isPlannerReadProjection(value.planner);
  }
  return hasExactKeys(value, ["contractVersion", "planner"]) &&
    isPlannerReadProjection(value.planner);
}
