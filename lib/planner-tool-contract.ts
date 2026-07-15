import {
  HOUSEHOLD_COMMAND_AUTHORITY_MANIFEST,
  HOUSEHOLD_COMMAND_REGISTRY,
  isHouseholdCommand,
  type HouseholdCommand,
} from "./household-command-contract.ts";
import {
  DEFAULT_HOUSEHOLD_TIME_ZONE,
  isIsoDate,
  type HouseholdPlannerState,
  type Meal,
  type WeekId,
  type WeekPlan,
} from "./household-contract.ts";
import {
  mondayForIsoDate,
  validateHouseholdState,
} from "./household-domain.ts";
import type {
  InitializedWorkspace,
  PlannerEvent,
  PlannerEventCommand,
} from "./planner-api-contract.ts";
import {
  MAX_PLANNER_OPERATIONS,
  MIN_PLANNER_OPERATIONS,
  isPlannerOperationList,
  type PlannerEventProvenance,
  type PlannerOperation,
  type PlannerOperationPreview,
} from "./planner-operation-contract.ts";

export const PLANNER_TOOL_SCHEMA_VERSION = 1 as const;
export const PLANNER_TOOL_NAMESPACE = "planner" as const;
export const PLANNER_TOOL_NAMES = ["read", "preview", "apply"] as const;
export const PLANNER_TOOL_CALL_LIMIT = 32;
export const PLANNER_TOOL_ARGUMENT_BYTES_LIMIT = 65_536;
export const PLANNER_TOOL_RESULT_BYTES_LIMIT = 131_072;
export const PLANNER_TOOL_HISTORY_LIMIT = 20;
export const PLANNER_TOOL_FIELD_ERROR_LIMIT = 20;

export type PlannerToolName = (typeof PLANNER_TOOL_NAMES)[number];

export type ReadQuery =
  | { kind: "workspace" }
  | { kind: "week"; weekId: string }
  | { kind: "meal"; weekId: string; mealId: string }
  | { kind: "history"; afterSequence?: number; limit: number };

export type PlannerReadArguments = { query: ReadQuery };
export type PlannerPreviewArguments = {
  basePlannerVersion: number;
  operations: PlannerOperation[];
};
export type PlannerApplyArguments = PlannerPreviewArguments & {
  readback: ReadQuery;
};

export type ForegroundGrant = {
  commandType: HouseholdCommand["type"];
  target: string;
};
export type ForegroundAuthority = readonly ForegroundGrant[];

export const EMPTY_FOREGROUND_AUTHORITY: ForegroundAuthority = Object.freeze([]);

export const PLANNER_TOOL_ERROR_CODES = [
  "INVALID_ARGUMENTS",
  "NOT_AUTHORIZED",
  "VERSION_CONFLICT",
  "DOMAIN_REJECTED",
  "DUPLICATE_MISMATCH",
  "CALL_IN_PROGRESS",
  "CALL_CANCELLED",
  "CALL_TIMED_OUT",
  "LATE_CALL",
  "TURN_NOT_RUNNING",
  "INTERNAL_ERROR",
] as const;

export const PLANNER_TOOL_RETRY_DISPOSITIONS = [
  "revise_new_call",
  "refresh_new_call",
  "wait_same_call",
  "new_foreground_turn",
  "none",
] as const;

export type PlannerToolErrorCode = (typeof PLANNER_TOOL_ERROR_CODES)[number];
export type PlannerToolRetryDisposition =
  (typeof PLANNER_TOOL_RETRY_DISPOSITIONS)[number];

export type PlannerToolFieldError = {
  path: string;
  message: string;
};

type PlannerToolEnvelopeBase = {
  schemaVersion: typeof PLANNER_TOOL_SCHEMA_VERSION;
  callId: string;
  plannerVersion: number;
  syncRevision: number;
  serverTime: number;
};

export type PlannerToolSuccess<Data = unknown> = PlannerToolEnvelopeBase & {
  ok: true;
  data: Data;
};

export type PlannerToolFailure = PlannerToolEnvelopeBase & {
  ok: false;
  error: {
    code: PlannerToolErrorCode;
    message: string;
    operationIndex?: number;
    fieldErrors?: PlannerToolFieldError[];
    retry: PlannerToolRetryDisposition;
  };
};

export type PlannerToolResult<Data = unknown> =
  | PlannerToolSuccess<Data>
  | PlannerToolFailure;

export type PlannerReadProjection =
  | {
      kind: "workspace";
      activeWeekId: string | null;
      weeks: Array<{ id: string; weekStartDate: string; status: string }>;
    }
  | { kind: "week"; week: InitializedWorkspace["state"]["weeks"][number] }
  | {
      kind: "meal";
      meal: InitializedWorkspace["state"]["weeks"][number]["data"]["meals"][number];
    }
  | { kind: "history"; events: SanitizedPlannerEvent[] };

export type SanitizedPlannerEvent = Pick<
  PlannerEvent,
  | "sequence"
  | "eventId"
  | "actor"
  | "provenance"
  | "command"
  | "baseVersion"
  | "resultVersion"
  | "summary"
  | "target"
  | "changes"
  | "occurredAt"
>;

export type PlannerPreviewData = {
  status: "previewed";
  outcomes: PlannerOperationPreview[];
};

export type PlannerApplyData = {
  status: "accepted" | "replayed";
  eventId: string;
  readback: PlannerReadProjection;
};

export type PlannerToolDataByName = {
  read: PlannerReadProjection;
  preview: PlannerPreviewData;
  apply: PlannerApplyData;
};

const readQuerySchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { type: "string", const: "workspace" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "weekId"],
      properties: {
        kind: { type: "string", const: "week" },
        weekId: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "weekId", "mealId"],
      properties: {
        kind: { type: "string", const: "meal" },
        weekId: { type: "string", minLength: 1, maxLength: 200 },
        mealId: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "limit"],
      properties: {
        kind: { type: "string", const: "history" },
        afterSequence: { type: "integer", minimum: 0 },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PLANNER_TOOL_HISTORY_LIMIT,
        },
      },
    },
  ],
} as const;

// Codex 0.142.5 compacts dynamic-tool schemas above 4,000 normalized bytes and
// would otherwise erase this nested union. Keep the model-facing discriminator
// alternatives compact; the generated field guide names each alternative's
// required fields, while the registry validator remains the canonical
// field/type/limit authority for every call.
const plannerCommandModelSchema = {
  type: "object",
  required: ["type"],
  anyOf: Object.values(HOUSEHOLD_COMMAND_REGISTRY).map((entry) => ({
    properties: { type: entry.schema.properties.type },
  })),
} as const;

const plannerCommandFieldGuide = Object.entries(HOUSEHOLD_COMMAND_REGISTRY)
  .map(([type, entry]) =>
    `${type}[${entry.schema.required.filter((field) => field !== "type").join(",")}]`)
  .join("; ");

const readQueryFieldGuide = readQuerySchema.oneOf
  .map((query) => {
    const required = query.required as readonly string[];
    const optional = Object.keys(query.properties).filter((field) =>
      !required.includes(field)
    );
    return `${query.properties.kind.const}[${required.join(",")}${
      optional.length > 0 ? `; optional ${optional.join(",")}` : ""
    }]`;
  })
  .join("; ");

// Keep apply below Codex 0.142.5's 4,000-byte normalized-schema compaction
// boundary without weakening host authority. The model sees every readback
// discriminator and the generated field guide above; isReadQuery remains the
// canonical validator for fields, types, limits, optionality, and extras.
const readQueryModelSchema = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: readQuerySchema.oneOf.map((query) => query.properties.kind.const),
    },
  },
} as const;

const plannerOperationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: { command: plannerCommandModelSchema },
} as const;

const operationsSchema = {
  type: "array",
  minItems: MIN_PLANNER_OPERATIONS,
  maxItems: MAX_PLANNER_OPERATIONS,
  items: plannerOperationSchema,
} as const;

export const PLANNER_DYNAMIC_TOOL_NAMESPACE = Object.freeze({
  type: "namespace",
  name: PLANNER_TOOL_NAMESPACE,
  description:
    "Read, preview, and transactionally apply household planner operations. " +
    "Every operation is exactly {command:{type:<schema camelCase type>,...}}; " +
    "never invent action, kind, commandType, event-style names, data, or payload wrappers. " +
    "A supplied research candidate can replace a meal only through " +
    "replaceMealRecipeFromSource with its exact title, optional yieldText, source, and steps; " +
    "setMealRecipe is not a command. Clear old prep references, completion, notes, or running " +
    "timers in an earlier apply call when the domain requires it.",
  tools: Object.freeze([
    Object.freeze({
      type: "function",
      name: "read",
      description: "Read one bounded canonical planner projection.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: readQuerySchema },
      },
    }),
    Object.freeze({
      type: "function",
      name: "preview",
      description:
        "Validate one ordered operation batch without effects. Example grocery add: " +
        "{command:{type:'addGroceryItem',weekId:'...',item:{section:'Pantry'," +
        "item:'Rice',detail:'1 bag',farmBox:false}}}. Required fields by type: " +
        plannerCommandFieldGuide,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["basePlannerVersion", "operations"],
        properties: {
          basePlannerVersion: { type: "integer", minimum: 0 },
          operations: operationsSchema,
        },
      },
    }),
    Object.freeze({
      type: "function",
      name: "apply",
      description:
        "Atomically apply one ordered operation batch and return one readback. Example grocery update: " +
        "{command:{type:'updateGroceryItem',weekId:'...',itemId:'...',changes:{" +
        "section:'Pantry',item:'Rice',detail:'2 bags',farmBox:false}}}. Required fields by type: " +
        plannerCommandFieldGuide + ". Readback fields by kind: " + readQueryFieldGuide + ".",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["basePlannerVersion", "operations", "readback"],
        properties: {
          basePlannerVersion: { type: "integer", minimum: 0 },
          operations: operationsSchema,
          readback: readQueryModelSchema,
        },
      },
    }),
  ]),
});

export const PLANNER_TOOL_AUTHORITY_MANIFEST = Object.freeze({
  ...HOUSEHOLD_COMMAND_AUTHORITY_MANIFEST,
  namespace: PLANNER_TOOL_NAMESPACE,
  tools: PLANNER_TOOL_NAMES,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

export function isReadQuery(value: unknown): value is ReadQuery {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "workspace":
      return hasExactKeys(value, ["kind"]);
    case "week":
      return hasExactKeys(value, ["kind", "weekId"]) && isBoundedId(value.weekId);
    case "meal":
      return hasExactKeys(value, ["kind", "weekId", "mealId"]) &&
        isBoundedId(value.weekId) && isBoundedId(value.mealId);
    case "history":
      return hasExactKeys(value, ["kind", "limit"], ["afterSequence"]) &&
        Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 &&
        Number(value.limit) <= PLANNER_TOOL_HISTORY_LIMIT &&
        (value.afterSequence === undefined ||
          (Number.isSafeInteger(value.afterSequence) && Number(value.afterSequence) >= 0));
    default:
      return false;
  }
}

export function isPlannerReadArguments(value: unknown): value is PlannerReadArguments {
  return isRecord(value) && hasExactKeys(value, ["query"]) && isReadQuery(value.query);
}

export function isPlannerPreviewArguments(value: unknown): value is PlannerPreviewArguments {
  return isRecord(value) && hasExactKeys(value, ["basePlannerVersion", "operations"]) &&
    Number.isSafeInteger(value.basePlannerVersion) && Number(value.basePlannerVersion) >= 0 &&
    isPlannerOperationList(value.operations);
}

export function isPlannerApplyArguments(value: unknown): value is PlannerApplyArguments {
  return isRecord(value) &&
    hasExactKeys(value, ["basePlannerVersion", "operations", "readback"]) &&
    Number.isSafeInteger(value.basePlannerVersion) && Number(value.basePlannerVersion) >= 0 &&
    isPlannerOperationList(value.operations) && isReadQuery(value.readback);
}

export function freezeForegroundAuthority(value: unknown): ForegroundAuthority {
  if (!Array.isArray(value) || value.length > PLANNER_TOOL_CALL_LIMIT) {
    throw new TypeError("Foreground authority must be a bounded grant array.");
  }
  const unique = new Map<string, ForegroundGrant>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["commandType", "target"]) ||
      typeof candidate.commandType !== "string" ||
      !(candidate.commandType in HOUSEHOLD_COMMAND_REGISTRY) ||
      !isBoundedId(candidate.target)
    ) {
      throw new TypeError("Foreground authority contains an invalid grant.");
    }
    const grant = Object.freeze({
      commandType: candidate.commandType as HouseholdCommand["type"],
      target: candidate.target as string,
    });
    unique.set(`${grant.commandType}\u0000${grant.target}`, grant);
  }
  return Object.freeze([...unique.values()].sort((left, right) =>
    left.commandType.localeCompare(right.commandType) || left.target.localeCompare(right.target)
  ));
}

export function foregroundTarget(command: HouseholdCommand): string {
  switch (command.type) {
    case "createWeekPlan":
      return command.weekStartDate;
    case "handoffWeek":
      return `${command.currentWeekId}->${command.nextWeekId}`;
    default:
      return command.weekId;
  }
}

export function authorizePlannerOperations(
  operations: readonly PlannerOperation[],
  authority: ForegroundAuthority,
): { ok: true } | { ok: false; operationIndex: number; message: string } {
  for (const [operationIndex, operation] of operations.entries()) {
    if (!isHouseholdCommand(operation.command)) {
      return { ok: false, operationIndex, message: "The operation command is not registered." };
    }
    const registration = HOUSEHOLD_COMMAND_REGISTRY[operation.command.type];
    if (!registration) {
      return { ok: false, operationIndex, message: "The operation command is not registered." };
    }
    if (registration.exposure !== "explicit_foreground") continue;
    const target = foregroundTarget(operation.command);
    if (!authority.some((grant) =>
      grant.commandType === operation.command.type && grant.target === target
    )) {
      return {
        ok: false,
        operationIndex,
        message: `The ${operation.command.type} operation requires an exact foreground grant.`,
      };
    }
  }
  return { ok: true };
}

export function projectPlannerRead(
  workspace: InitializedWorkspace,
  query: ReadQuery,
): PlannerReadProjection | null {
  switch (query.kind) {
    case "workspace":
      return {
        kind: "workspace",
        activeWeekId: workspace.state.activeWeekId,
        weeks: workspace.state.weeks.map(({ id, weekStartDate, status }) => ({
          id,
          weekStartDate,
          status,
        })),
      };
    case "week": {
      const week = workspace.state.weeks.find((candidate) => candidate.id === query.weekId);
      return week ? { kind: "week", week: structuredClone(week) } : null;
    }
    case "meal": {
      const week = workspace.state.weeks.find((candidate) => candidate.id === query.weekId);
      const meal = week?.data.meals.find((candidate) => candidate.id === query.mealId);
      return meal ? { kind: "meal", meal: structuredClone(meal) } : null;
    }
    case "history": {
      const events = workspace.events
        .filter((event) => query.afterSequence === undefined || event.sequence > query.afterSequence)
        .slice(-query.limit)
        .map(({ sequence, eventId, actor, provenance, command, baseVersion, resultVersion,
          summary, target, changes, occurredAt }) => ({
          sequence,
          eventId,
          actor,
          provenance: structuredClone(provenance),
          command: structuredClone(command),
          baseVersion,
          resultVersion,
          summary,
          target,
          changes: [...changes],
          occurredAt,
        }));
      return { kind: "history", events };
    }
  }
}

export function createPlannerToolSuccess<Data>(
  callId: string,
  workspace: Pick<InitializedWorkspace, "plannerVersion" | "syncRevision">,
  serverTime: number,
  data: Data,
): PlannerToolSuccess<Data> {
  return {
    schemaVersion: PLANNER_TOOL_SCHEMA_VERSION,
    ok: true,
    callId,
    plannerVersion: workspace.plannerVersion,
    syncRevision: workspace.syncRevision,
    serverTime,
    data,
  };
}

export function createPlannerToolFailure(
  callId: string,
  workspace: Pick<InitializedWorkspace, "plannerVersion" | "syncRevision">,
  serverTime: number,
  error: PlannerToolFailure["error"],
): PlannerToolFailure {
  const fieldErrors = error.fieldErrors?.slice(0, PLANNER_TOOL_FIELD_ERROR_LIMIT);
  const operationIndex = error.operationIndex;
  if (
    operationIndex !== undefined &&
    (!Number.isSafeInteger(operationIndex) || operationIndex < 0 || operationIndex >= MAX_PLANNER_OPERATIONS)
  ) {
    throw new TypeError("Planner tool operationIndex is outside the operation bound.");
  }
  return {
    schemaVersion: PLANNER_TOOL_SCHEMA_VERSION,
    ok: false,
    callId,
    plannerVersion: workspace.plannerVersion,
    syncRevision: workspace.syncRevision,
    serverTime,
    error: {
      code: error.code,
      message: error.message.replaceAll(/\s+/g, " ").slice(0, 512),
      ...(operationIndex === undefined ? {} : { operationIndex }),
      ...(fieldErrors?.length ? { fieldErrors } : {}),
      retry: error.retry,
    },
  };
}

export function isPlannerToolResult(value: unknown): value is PlannerToolResult {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PLANNER_TOOL_SCHEMA_VERSION ||
    typeof value.ok !== "boolean" ||
    !isBoundedId(value.callId) ||
    !Number.isSafeInteger(value.plannerVersion) || Number(value.plannerVersion) < 0 ||
    !Number.isSafeInteger(value.syncRevision) || Number(value.syncRevision) < 0 ||
    !Number.isSafeInteger(value.serverTime) || Number(value.serverTime) < 0
  ) {
    return false;
  }
  if (value.ok) {
    if (!hasExactKeys(
      value,
      ["schemaVersion", "ok", "callId", "plannerVersion", "syncRevision", "serverTime", "data"],
    )) return false;
  } else {
    if (
      !hasExactKeys(
        value,
        ["schemaVersion", "ok", "callId", "plannerVersion", "syncRevision", "serverTime", "error"],
      ) ||
      !isRecord(value.error) ||
      !hasExactKeys(value.error, ["code", "message", "retry"], ["operationIndex", "fieldErrors"]) ||
      typeof value.error.code !== "string" ||
      !PLANNER_TOOL_ERROR_CODES.includes(value.error.code as PlannerToolErrorCode) ||
      typeof value.error.message !== "string" ||
      value.error.message.length === 0 || value.error.message.length > 512 ||
      typeof value.error.retry !== "string" ||
      !PLANNER_TOOL_RETRY_DISPOSITIONS.includes(
        value.error.retry as PlannerToolRetryDisposition,
      ) ||
      (value.error.operationIndex !== undefined &&
        (!Number.isSafeInteger(value.error.operationIndex) ||
          Number(value.error.operationIndex) < 0 ||
          Number(value.error.operationIndex) >= MAX_PLANNER_OPERATIONS))
    ) {
      return false;
    }
    if (value.error.fieldErrors !== undefined) {
      if (
        !Array.isArray(value.error.fieldErrors) ||
        value.error.fieldErrors.length === 0 ||
        value.error.fieldErrors.length > PLANNER_TOOL_FIELD_ERROR_LIMIT ||
        !value.error.fieldErrors.every((fieldError) =>
          isRecord(fieldError) && hasExactKeys(fieldError, ["path", "message"]) &&
          typeof fieldError.path === "string" && fieldError.path.length > 0 &&
          fieldError.path.length <= 512 &&
          typeof fieldError.message === "string" && fieldError.message.length > 0 &&
          fieldError.message.length <= 512
        )
      ) return false;
    }
  }
  return true;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPlannerEventProvenance(value: unknown): value is PlannerEventProvenance {
  if (!isRecord(value) || !hasExactKeys(value, ["actorClass", "actorSource", "admission"])) {
    return false;
  }
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
    return hasExactKeys(value, ["type", "operations"]) &&
      isPlannerOperationList(value.operations);
  }
  return value.type === "undoLatest" &&
    hasExactKeys(value, ["type", "targetEventId"]) &&
    isBoundedId(value.targetEventId);
}

function isSanitizedPlannerEvent(value: unknown): value is SanitizedPlannerEvent {
  if (!isRecord(value) || !hasExactKeys(value, [
    "sequence",
    "eventId",
    "actor",
    "provenance",
    "command",
    "baseVersion",
    "resultVersion",
    "summary",
    "target",
    "changes",
    "occurredAt",
  ])) return false;
  if (
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
    !isBoundedId(value.eventId) ||
    (value.actor !== "Household" && value.actor !== "Codex") ||
    !isPlannerEventProvenance(value.provenance) ||
    !isPlannerEventCommand(value.command) ||
    !isNonNegativeSafeInteger(value.baseVersion) ||
    !isNonNegativeSafeInteger(value.resultVersion) ||
    typeof value.summary !== "string" ||
    typeof value.target !== "string" ||
    !isStringArray(value.changes) ||
    !isNonNegativeSafeInteger(value.occurredAt)
  ) return false;
  return value.actor === (value.provenance.actorClass === "household" ? "Household" : "Codex");
}

function isWeekPlan(value: unknown): value is WeekPlan {
  if (!isRecord(value)) return false;
  const activeWeekId = value.status === "active" && typeof value.id === "string"
    ? value.id as WeekId
    : null;
  const state = {
    householdTimeZone: DEFAULT_HOUSEHOLD_TIME_ZONE,
    activeWeekId,
    weeks: [value as WeekPlan],
  } satisfies HouseholdPlannerState;
  return validateHouseholdState(state).ok;
}

function isMeal(value: unknown): value is Meal {
  if (!isRecord(value) || !isIsoDate(value.date)) return false;
  const weekId = mondayForIsoDate(value.date);
  const state = {
    householdTimeZone: DEFAULT_HOUSEHOLD_TIME_ZONE,
    activeWeekId: null,
    weeks: [{
      id: weekId,
      weekStartDate: weekId,
      status: "planned",
      data: {
        meals: [value as Meal],
        prep: [],
        groceries: [],
        leftovers: [],
        farmBoxReconciled: false,
        feedback: {},
        weekLesson: "",
      },
    }],
  } satisfies HouseholdPlannerState;
  return validateHouseholdState(state).ok;
}

export function isPlannerReadProjection(value: unknown): value is PlannerReadProjection {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "workspace": {
      if (
        !hasExactKeys(value, ["kind", "activeWeekId", "weeks"]) ||
        (value.activeWeekId !== null && !isBoundedId(value.activeWeekId)) ||
        !Array.isArray(value.weeks)
      ) return false;
      const weekIds = new Set<string>();
      return value.weeks.every((week) => {
        if (
          !isRecord(week) ||
          !hasExactKeys(week, ["id", "weekStartDate", "status"]) ||
          !isBoundedId(week.id) ||
          !isIsoDate(week.weekStartDate) ||
          typeof week.status !== "string" ||
          week.status.length === 0 ||
          weekIds.has(week.id)
        ) return false;
        weekIds.add(week.id);
        return true;
      });
    }
    case "week":
      return hasExactKeys(value, ["kind", "week"]) && isWeekPlan(value.week);
    case "meal":
      return hasExactKeys(value, ["kind", "meal"]) && isMeal(value.meal);
    case "history":
      return hasExactKeys(value, ["kind", "events"]) &&
        Array.isArray(value.events) &&
        value.events.length <= PLANNER_TOOL_HISTORY_LIMIT &&
        value.events.every(isSanitizedPlannerEvent);
    default:
      return false;
  }
}

export function isPlannerPreviewData(value: unknown): value is PlannerPreviewData {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "outcomes"]) ||
    value.status !== "previewed" ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length < MIN_PLANNER_OPERATIONS ||
    value.outcomes.length > MAX_PLANNER_OPERATIONS
  ) return false;
  const indexes = new Set<number>();
  return value.outcomes.every((outcome) => {
    if (
      !isRecord(outcome) ||
      !hasExactKeys(outcome, ["operationIndex", "summary", "target", "changes"]) ||
      !Number.isSafeInteger(outcome.operationIndex) ||
      Number(outcome.operationIndex) < 0 ||
      Number(outcome.operationIndex) >= MAX_PLANNER_OPERATIONS ||
      indexes.has(Number(outcome.operationIndex)) ||
      typeof outcome.summary !== "string" ||
      typeof outcome.target !== "string" ||
      !isStringArray(outcome.changes)
    ) return false;
    indexes.add(Number(outcome.operationIndex));
    return true;
  });
}

export function isPlannerApplyData(value: unknown): value is PlannerApplyData {
  return isRecord(value) &&
    hasExactKeys(value, ["status", "eventId", "readback"]) &&
    (value.status === "accepted" || value.status === "replayed") &&
    isBoundedId(value.eventId) &&
    isPlannerReadProjection(value.readback);
}

export function isPlannerToolResultForTool<Tool extends PlannerToolName>(
  tool: Tool,
  value: unknown,
): value is PlannerToolResult<PlannerToolDataByName[Tool]> {
  if (!isPlannerToolResult(value)) return false;
  if (!value.ok) return true;
  switch (tool) {
    case "read":
      return isPlannerReadProjection(value.data);
    case "preview":
      return isPlannerPreviewData(value.data);
    case "apply":
      return isPlannerApplyData(value.data);
    default:
      return false;
  }
}

export function serializePlannerToolResult(result: PlannerToolResult): string {
  if (!isPlannerToolResult(result)) {
    throw new TypeError("Planner tool result did not match the closed result contract.");
  }
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text, "utf8") > PLANNER_TOOL_RESULT_BYTES_LIMIT) {
    throw new RangeError("Planner tool result exceeded the bounded result limit.");
  }
  return text;
}
