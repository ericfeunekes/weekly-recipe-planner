import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  opendir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { ValidatedCodexFollowUpDeployment } from "./deployment.ts";
import {
  CodexLauncherError,
  runAcceptedCodexProcess,
  type CodexExecutableIdentity,
} from "./launcher.ts";
import {
  CODEX_FOLLOW_UP_RESOURCE_POLICY,
  inventoryBoundedTree,
  readBoundedFile,
} from "./resource-policy.ts";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const CODEX_FOLLOW_UP_CONTRACT_VERSION = 1;
export const CODEX_FOLLOW_UP_RESEARCH_WEB_SEARCH_MODE = "live" as const;

export const CODEX_FOLLOW_UP_RPC_POLICY = Object.freeze({
  clientRequests: Object.freeze([
    "initialize",
    "account/read",
    "config/read",
    "skills/list",
    "permissionProfile/list",
    "mcpServerStatus/list",
    "app/list",
    "plugin/list",
    "thread/list",
    "thread/read",
    "thread/resume",
    "thread/start",
    "thread/archive",
    "thread/unsubscribe",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
  ]),
  readinessRequests: Object.freeze([
    "account/read",
    "config/read",
    "skills/list",
    "permissionProfile/list",
    "mcpServerStatus/list",
    "app/list",
    "plugin/list",
    "thread/start",
    "thread/unsubscribe",
  ]),
  clientNotifications: Object.freeze(["initialized"]),
  serverRequests: Object.freeze([
    "item/tool/call",
    "item/tool/requestUserInput",
  ]),
  rejectedServerRequests: Object.freeze([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval",
  ]),
  consumedNotifications: Object.freeze([
    "thread/started",
    "thread/status/changed",
    "thread/archived",
    "thread/name/updated",
    "turn/started",
    "item/started",
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/summaryTextDelta",
    "item/completed",
    "serverRequest/resolved",
    "turn/completed",
    "error",
  ]),
  ignoredNotifications: Object.freeze([
    "account/rateLimits/updated",
    // Codex 0.142.5 emits this additive cache-invalidation event after the
    // bounded `app/list` readback. This runtime never consumes app listings,
    // so it carries no planner authority and must not invalidate readiness.
    "app/list/updated",
    "item/reasoning/textDelta",
    "remoteControl/status/changed",
    "thread/tokenUsage/updated",
    "warning",
  ]),
});

export const CODEX_FOLLOW_UP_TOOL_MANIFESTS = Object.freeze({
  researchWebSearchMode: CODEX_FOLLOW_UP_RESEARCH_WEB_SEARCH_MODE,
  nativeThread: Object.freeze([
    "update_plan",
    "request_user_input",
    "spawn_agent",
    "send_message",
    "followup_task",
    "wait_agent",
    "interrupt_agent",
    "list_agents",
    "skills",
    "planner",
    "web_search",
  ]),
  workerRequired: Object.freeze([
    "update_plan",
    "request_user_input",
    "spawn_agent",
    "send_message",
    "followup_task",
    "wait_agent",
    "interrupt_agent",
    "list_agents",
    "skills",
    "web_search",
  ]),
  skillsNamespace: Object.freeze(["list", "read"]),
  // Stable release-evidence projections retained for the version-1 artifact
  // schema. The capability probe derives both from one unified root request;
  // they no longer represent separate research and planner sessions.
  research: Object.freeze(["update_plan", "web_search"]),
  planner: Object.freeze(["update_plan", "planner"]),
  plannerNamespace: Object.freeze(["read", "preview", "apply"]),
  ambient: Object.freeze({ update_plan: "inert_client_progress" }),
});

export const CODEX_FOLLOW_UP_FORBIDDEN_CAPABILITY_CLASSES = Object.freeze([
  "shell",
  "exec",
  "patch",
  "filesystem",
  "database",
  "browser",
  "computer",
  "apps",
  "plugins",
  "mcp",
  "multi_agent",
  "arbitrary_network",
]);

const REQUIRED_SCHEMA_FILES = Object.freeze([
  "v1/InitializeParams.json",
  "ServerNotification.json",
  "ServerRequest.json",
  "v1/InitializeResponse.json",
  "v2/GetAccountParams.json",
  "v2/GetAccountResponse.json",
  "v2/ConfigReadParams.json",
  "v2/ConfigReadResponse.json",
  "v2/SkillsListParams.json",
  "v2/SkillsListResponse.json",
  "v2/PermissionProfileListParams.json",
  "v2/PermissionProfileListResponse.json",
  "v2/ListMcpServerStatusParams.json",
  "v2/ListMcpServerStatusResponse.json",
  "v2/AppsListParams.json",
  "v2/AppsListResponse.json",
  "v2/PluginListParams.json",
  "v2/PluginListResponse.json",
  "v2/ThreadListParams.json",
  "v2/ThreadListResponse.json",
  "v2/ThreadReadParams.json",
  "v2/ThreadReadResponse.json",
  "v2/ThreadResumeParams.json",
  "v2/ThreadResumeResponse.json",
  "v2/ThreadStartParams.json",
  "v2/ThreadStartResponse.json",
  "v2/ThreadArchiveParams.json",
  "v2/ThreadArchiveResponse.json",
  "v2/ThreadUnsubscribeParams.json",
  "v2/ThreadUnsubscribeResponse.json",
  "v2/TurnStartParams.json",
  "v2/TurnStartResponse.json",
  "v2/TurnSteerParams.json",
  "v2/TurnSteerResponse.json",
  "v2/TurnInterruptParams.json",
  "v2/TurnInterruptResponse.json",
  "ToolRequestUserInputParams.json",
  "ToolRequestUserInputResponse.json",
  "CommandExecutionRequestApprovalParams.json",
  "CommandExecutionRequestApprovalResponse.json",
  "FileChangeRequestApprovalParams.json",
  "FileChangeRequestApprovalResponse.json",
  "PermissionsRequestApprovalParams.json",
  "PermissionsRequestApprovalResponse.json",
  "DynamicToolCallParams.json",
  "DynamicToolCallResponse.json",
  "v2/ThreadStartedNotification.json",
  "v2/ThreadStatusChangedNotification.json",
  "v2/ThreadArchivedNotification.json",
  "v2/ThreadNameUpdatedNotification.json",
  "v2/TurnStartedNotification.json",
  "v2/ItemStartedNotification.json",
  "v2/AgentMessageDeltaNotification.json",
  "v2/PlanDeltaNotification.json",
  "v2/ReasoningSummaryPartAddedNotification.json",
  "v2/ReasoningSummaryTextDeltaNotification.json",
  "v2/ItemCompletedNotification.json",
  "v2/ServerRequestResolvedNotification.json",
  "v2/TurnCompletedNotification.json",
  "v2/ErrorNotification.json",
] as const);

const NON_SEMANTIC_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
]);

const SET_LIKE_ARRAY_KEYS = new Set([
  "allOf",
  "anyOf",
  "enum",
  "oneOf",
  "required",
  "type",
]);

type RequiredSchemaContract = {
  readonly file: (typeof REQUIRED_SCHEMA_FILES)[number];
  readonly requiredPaths: readonly (readonly string[])[];
};

const REQUIRED_SCHEMA_CONTRACT: readonly RequiredSchemaContract[] = [
  {
    file: "v1/InitializeParams.json",
    requiredPaths: [
      ["properties", "capabilities"],
      ["definitions", "InitializeCapabilities", "properties", "experimentalApi"],
      ["definitions", "InitializeCapabilities", "properties", "experimentalApi", "type", "=boolean"],
      ["definitions", "InitializeCapabilities", "properties", "optOutNotificationMethods"],
      ["definitions", "InitializeCapabilities", "properties", "optOutNotificationMethods", "items", "type", "=string"],
    ],
  },
  { file: "ServerNotification.json", requiredPaths: [["oneOf"]] },
  { file: "ServerRequest.json", requiredPaths: [["oneOf"]] },
  { file: "v1/InitializeResponse.json", requiredPaths: [["type", "=object"]] },
  { file: "v2/GetAccountParams.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/GetAccountResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~requiresOpenaiAuth"],
      ["properties", "account"],
      ["properties", "requiresOpenaiAuth", "type", "=boolean"],
    ],
  },
  { file: "v2/ConfigReadParams.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/ConfigReadResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~config"],
      ["required", "~origins"],
      ["properties", "layers"],
    ],
  },
  { file: "v2/SkillsListParams.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/SkillsListResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~data"],
      ["properties", "data", "type", "=array"],
    ],
  },
  { file: "v2/PermissionProfileListParams.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/PermissionProfileListResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~data"],
      ["properties", "data", "type", "=array"],
      ["definitions", "PermissionProfileSummary", "required", "~allowed"],
      ["definitions", "PermissionProfileSummary", "required", "~id"],
    ],
  },
  { file: "v2/ListMcpServerStatusParams.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/ListMcpServerStatusResponse.json",
    requiredPaths: [
      ["type", "=object"], ["required", "~data"], ["properties", "data", "type", "=array"],
    ],
  },
  { file: "v2/AppsListParams.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/AppsListResponse.json",
    requiredPaths: [
      ["type", "=object"], ["required", "~data"], ["properties", "data", "type", "=array"],
    ],
  },
  { file: "v2/PluginListParams.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/PluginListResponse.json",
    requiredPaths: [
      ["type", "=object"], ["required", "~marketplaces"], ["properties", "marketplaces", "type", "=array"],
    ],
  },
  {
    file: "v2/ThreadListParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["properties", "archived"],
      ["properties", "cursor"],
      ["properties", "cwd"],
      ["properties", "limit"],
      ["properties", "parentThreadId"],
      ["properties", "sourceKinds"],
    ],
  },
  {
    file: "v2/ThreadListResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~data"],
      ["properties", "data", "type", "=array"],
      ["properties", "data", "items", "$ref", "=#/definitions/Thread"],
      ["properties", "nextCursor"],
      ["properties", "backwardsCursor"],
      ["definitions", "Thread"],
      ["definitions", "Turn"],
      ["definitions", "ThreadItem", "oneOf"],
      ["definitions", "CollabAgentTool"],
      ["definitions", "SubAgentActivityKind"],
    ],
  },
  {
    file: "v2/ThreadReadParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~threadId"],
      ["properties", "includeTurns", "type", "=boolean"],
    ],
  },
  {
    file: "v2/ThreadReadResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~thread"],
      ["properties", "thread", "$ref", "=#/definitions/Thread"],
      ["definitions", "Thread"],
      ["definitions", "Turn"],
      ["definitions", "ThreadItem", "oneOf"],
      ["definitions", "CollabAgentTool"],
      ["definitions", "SubAgentActivityKind"],
    ],
  },
  {
    file: "v2/ThreadResumeParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~threadId"],
      ["properties", "config"],
      ["properties", "cwd"],
      ["properties", "permissions"],
      ["properties", "sandbox"],
    ],
  },
  {
    file: "v2/ThreadResumeResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~approvalPolicy"],
      ["required", "~approvalsReviewer"],
      ["required", "~cwd"],
      ["required", "~sandbox"],
      ["required", "~thread"],
      ["properties", "activePermissionProfile"],
      ["properties", "instructionSources"],
      ["definitions", "ThreadItem", "oneOf"],
    ],
  },
  {
    file: "v2/ThreadStartParams.json",
    requiredPaths: [
      ["properties", "cwd"],
      ["properties", "config"],
      ["properties", "dynamicTools"],
      ["properties", "environments"],
      ["properties", "ephemeral"],
      ["properties", "permissions"],
      ["properties", "sandbox"],
    ],
  },
  {
    file: "v2/ThreadStartResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~approvalPolicy"],
      ["required", "~cwd"],
      ["required", "~sandbox"],
      ["required", "~thread"],
      ["properties", "activePermissionProfile"],
      ["properties", "instructionSources"],
    ],
  },
  {
    file: "v2/ThreadArchiveParams.json",
    requiredPaths: [["type", "=object"], ["required", "~threadId"]],
  },
  { file: "v2/ThreadArchiveResponse.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/ThreadUnsubscribeParams.json",
    requiredPaths: [["type", "=object"], ["required", "~threadId"]],
  },
  { file: "v2/ThreadUnsubscribeResponse.json", requiredPaths: [["type", "=object"]] },
  {
    file: "v2/TurnStartParams.json",
    requiredPaths: [
      ["required", "~threadId"],
      ["required", "~input"],
      ["properties", "clientUserMessageId"],
      ["properties", "cwd"],
      ["properties", "effort"],
      ["properties", "environments"],
      ["properties", "permissions"],
    ],
  },
  {
    file: "v2/TurnStartResponse.json",
    requiredPaths: [["type", "=object"], ["required", "~turn"]],
  },
  {
    file: "v2/TurnSteerParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~expectedTurnId"],
      ["required", "~input"],
      ["required", "~threadId"],
      ["properties", "clientUserMessageId"],
    ],
  },
  {
    file: "v2/TurnSteerResponse.json",
    requiredPaths: [["type", "=object"], ["required", "~turnId"]],
  },
  {
    file: "v2/TurnInterruptParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~threadId"],
      ["required", "~turnId"],
    ],
  },
  { file: "v2/TurnInterruptResponse.json", requiredPaths: [["type", "=object"]] },
  {
    file: "ToolRequestUserInputParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~itemId"],
      ["required", "~questions"],
      ["required", "~threadId"],
      ["required", "~turnId"],
      ["properties", "autoResolutionMs"],
      ["properties", "questions", "type", "=array"],
      ["definitions", "ToolRequestUserInputQuestion", "required", "~header"],
      ["definitions", "ToolRequestUserInputQuestion", "required", "~id"],
      ["definitions", "ToolRequestUserInputQuestion", "required", "~question"],
      ["definitions", "ToolRequestUserInputQuestion", "properties", "isOther"],
      ["definitions", "ToolRequestUserInputQuestion", "properties", "isSecret"],
      ["definitions", "ToolRequestUserInputQuestion", "properties", "options"],
      ["definitions", "ToolRequestUserInputOption", "required", "~description"],
      ["definitions", "ToolRequestUserInputOption", "required", "~label"],
    ],
  },
  {
    file: "ToolRequestUserInputResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~answers"],
      ["properties", "answers", "type", "=object"],
      ["definitions", "ToolRequestUserInputAnswer", "required", "~answers"],
      ["definitions", "ToolRequestUserInputAnswer", "properties", "answers", "type", "=array"],
    ],
  },
  {
    file: "CommandExecutionRequestApprovalParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~itemId"],
      ["required", "~startedAtMs"],
      ["required", "~threadId"],
      ["required", "~turnId"],
    ],
  },
  {
    file: "CommandExecutionRequestApprovalResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~decision"],
      ["definitions", "CommandExecutionApprovalDecision", "oneOf"],
    ],
  },
  {
    file: "FileChangeRequestApprovalParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~itemId"],
      ["required", "~startedAtMs"],
      ["required", "~threadId"],
      ["required", "~turnId"],
    ],
  },
  {
    file: "FileChangeRequestApprovalResponse.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~decision"],
      ["definitions", "FileChangeApprovalDecision", "oneOf"],
    ],
  },
  {
    file: "PermissionsRequestApprovalParams.json",
    requiredPaths: [
      ["type", "=object"],
      ["required", "~cwd"],
      ["required", "~itemId"],
      ["required", "~permissions"],
      ["required", "~startedAtMs"],
      ["required", "~threadId"],
      ["required", "~turnId"],
    ],
  },
  {
    file: "PermissionsRequestApprovalResponse.json",
    requiredPaths: [["type", "=object"], ["required", "~permissions"]],
  },
  {
    file: "DynamicToolCallParams.json",
    requiredPaths: [
      ["required", "~arguments"],
      ["required", "~callId"],
      ["required", "~threadId"],
      ["required", "~tool"],
      ["required", "~turnId"],
      ["properties", "namespace"],
    ],
  },
  {
    file: "DynamicToolCallResponse.json",
    requiredPaths: [
      ["required", "~contentItems"],
      ["required", "~success"],
      ["properties", "contentItems", "items"],
      ["properties", "contentItems", "type", "=array"],
      ["properties", "success", "type", "=boolean"],
      ["definitions", "DynamicToolCallOutputContentItem", "oneOf"],
    ],
  },
  {
    file: "v2/ThreadStartedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~thread"], ["definitions", "ThreadItem", "oneOf"]],
  },
  {
    file: "v2/ThreadStatusChangedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~status"], ["required", "~threadId"]],
  },
  {
    file: "v2/ThreadArchivedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~threadId"]],
  },
  {
    file: "v2/ThreadNameUpdatedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~threadId"], ["properties", "threadName"]],
  },
  {
    file: "v2/TurnStartedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~threadId"], ["required", "~turn"], ["definitions", "ThreadItem", "oneOf"]],
  },
  {
    file: "v2/ItemStartedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~item"], ["required", "~startedAtMs"], ["required", "~threadId"], ["required", "~turnId"], ["definitions", "ThreadItem", "oneOf"]],
  },
  {
    file: "v2/AgentMessageDeltaNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~delta"], ["required", "~itemId"], ["required", "~threadId"], ["required", "~turnId"]],
  },
  {
    file: "v2/PlanDeltaNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~delta"], ["required", "~itemId"], ["required", "~threadId"], ["required", "~turnId"]],
  },
  {
    file: "v2/ReasoningSummaryPartAddedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~itemId"], ["required", "~summaryIndex"], ["required", "~threadId"], ["required", "~turnId"]],
  },
  {
    file: "v2/ReasoningSummaryTextDeltaNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~delta"], ["required", "~itemId"], ["required", "~summaryIndex"], ["required", "~threadId"], ["required", "~turnId"]],
  },
  {
    file: "v2/ItemCompletedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~completedAtMs"], ["required", "~item"], ["required", "~threadId"], ["required", "~turnId"], ["definitions", "ThreadItem", "oneOf"]],
  },
  {
    file: "v2/ServerRequestResolvedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~requestId"], ["required", "~threadId"]],
  },
  {
    file: "v2/TurnCompletedNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~threadId"], ["required", "~turn"]],
  },
  {
    file: "v2/ErrorNotification.json",
    requiredPaths: [["type", "=object"], ["required", "~error"], ["required", "~threadId"], ["required", "~turnId"], ["required", "~willRetry"]],
  },
];

export type CodexProtocolProjection = {
  readonly files: Readonly<Record<string, JsonValue>>;
};

export type CodexCompatibilityContract = {
  readonly contractVersion: number;
  readonly protocol: CodexProtocolProjection;
  readonly rpcPolicy: typeof CODEX_FOLLOW_UP_RPC_POLICY;
  readonly toolManifests: typeof CODEX_FOLLOW_UP_TOOL_MANIFESTS;
  readonly forbiddenCapabilityClasses: typeof CODEX_FOLLOW_UP_FORBIDDEN_CAPABILITY_CLASSES;
};

export type GeneratedCodexSchema = {
  readonly directory: string;
  readonly rawBundleSha256: string;
  readonly projection: CodexProtocolProjection;
  readonly fingerprint: string;
};

export type CodexCompatibilityDisposition =
  | "checking"
  | "compatible"
  | "incompatible"
  | "unavailable";

export type CodexCapabilityEvidence = {
  readonly researchWebSearchMode: typeof CODEX_FOLLOW_UP_RESEARCH_WEB_SEARCH_MODE;
  readonly researchTools: readonly string[];
  readonly plannerTools: readonly string[];
  /** Exact top-level provider tools observed on the spawned native worker. */
  readonly workerTools: readonly string[];
  readonly plannerNamespaceMembers: readonly string[];
  readonly forbiddenHits: readonly string[];
  readonly unexpectedRpcMethods: readonly string[];
  readonly plannerReadObserved: boolean;
  readonly workerWaitCallObserved: boolean;
  readonly workerWaitResultObserved: boolean;
  readonly workerResultObserved: boolean;
  readonly userInputRoundTripObserved: boolean;
  readonly dependentResultObserved: boolean;
  readonly outboundPolicyRejected: boolean;
  readonly approvalPolicy: "never";
  readonly permissionProfile: ":read-only";
  readonly effectiveSandbox: "read-only-network-disabled";
  readonly probeRuntimeFiles: readonly string[];
};

export type CodexDeploymentReadbackEvidence = {
  readonly authenticated: boolean | null;
  readonly accountKind: string | null;
  readonly permissionProfile: ":read-only";
  readonly effectiveSandbox: "read-only-network-disabled";
  readonly configSourceHashes: Readonly<Record<string, string>>;
  readonly systemConfigPaths: readonly string[];
  readonly instructionSourceHashes: Readonly<Record<string, string>>;
  readonly skillNames: readonly string[];
  readonly mcpServerNames: readonly string[];
  readonly appNames: readonly string[];
  readonly pluginNames: readonly string[];
  readonly runtimeFiles: readonly string[];
};

export type CodexCompatibilityEvidence = {
  readonly contractVersion: 1;
  readonly evaluatedAt: string;
  readonly disposition: CodexCompatibilityDisposition;
  readonly active: false;
  readonly executable: CodexExecutableIdentity | null;
  readonly schemaFingerprint: string | null;
  readonly rawSchemaBundleSha256: string | null;
  readonly capability: CodexCapabilityEvidence | null;
  readonly deploymentReadback: CodexDeploymentReadbackEvidence | null;
  readonly detail: string;
};

export class CodexCompatibilityError extends Error {
  readonly code: "SCHEMA_GENERATION" | "SCHEMA_PARSE" | "SCHEMA_INCOMPATIBLE";

  constructor(code: CodexCompatibilityError["code"], message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CodexCompatibilityError";
    this.code = code;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSchemaValue(value: unknown, parentKey = ""): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Schema contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeSchemaValue(entry));
    if (SET_LIKE_ARRAY_KEYS.has(parentKey)) {
      return [...normalized].sort((left, right) =>
        canonicalJson(left).localeCompare(canonicalJson(right)),
      );
    }
    return normalized;
  }
  if (!isJsonObject(value)) throw new TypeError("Schema contains a non-JSON value.");
  const normalized: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    if (NON_SEMANTIC_SCHEMA_KEYS.has(key)) continue;
    normalized[key] = normalizeSchemaValue(value[key], key);
  }
  return normalized;
}

function schemaHasOnlySemanticKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value)
    .filter((key) => !NON_SEMANTIC_SCHEMA_KEYS.has(key))
    .sort();
  return canonicalJson(actual) === canonicalJson([...expected].sort());
}

export function canonicalJson(value: JsonValue) {
  return JSON.stringify(value);
}

export function semanticSchemaProjection(
  schemas: Readonly<Record<string, unknown>>,
): CodexProtocolProjection {
  const files: Record<string, JsonValue> = {};
  for (const file of REQUIRED_SCHEMA_FILES) {
    if (!Object.hasOwn(schemas, file)) {
      throw new CodexCompatibilityError(
        "SCHEMA_INCOMPATIBLE",
        `Generated Codex schema is missing ${file}.`,
      );
    }
    files[file] = normalizeSchemaValue(schemas[file]);
  }
  return Object.freeze({ files: Object.freeze(files) });
}

function readRequiredPath(document: unknown, path: readonly string[]) {
  let cursor: unknown = document;
  for (const part of path) {
    if (part.startsWith("=")) return cursor === part.slice(1);
    if (part.startsWith("~")) {
      return Array.isArray(cursor) && cursor.includes(part.slice(1));
    }
    if (!isJsonObject(cursor) || !Object.hasOwn(cursor, part)) return false;
    cursor = cursor[part];
  }
  return true;
}

function hasMethodReference(
  document: unknown,
  method: string,
  definition: string,
  request: boolean,
) {
  if (!isJsonObject(document) || !Array.isArray(document.oneOf)) return false;
  return document.oneOf.some((variant) => {
    if (!isJsonObject(variant) || !isJsonObject(variant.properties)) return false;
    const methodProperty = variant.properties.method;
    const paramsProperty = variant.properties.params;
    const required = variant.required;
    return (
      Array.isArray(required) &&
      required.includes("method") &&
      required.includes("params") &&
      (!request || required.includes("id")) &&
      isJsonObject(methodProperty) &&
      Array.isArray(methodProperty.enum) &&
      methodProperty.enum.includes(method) &&
      isJsonObject(paramsProperty) &&
      paramsProperty.$ref === `#/definitions/${definition}`
    );
  });
}

function taggedDefinitionVariant(
  document: unknown,
  definition: string,
  type: string,
) {
  const union = isJsonObject(document) && isJsonObject(document.definitions)
    ? document.definitions[definition]
    : null;
  if (!isJsonObject(union) || !Array.isArray(union.oneOf)) return null;
  return union.oneOf.find((variant) => {
    if (!isJsonObject(variant) || !isJsonObject(variant.properties)) return false;
    const typeProperty = variant.properties.type;
    return isJsonObject(typeProperty) &&
      Array.isArray(typeProperty.enum) &&
      typeProperty.enum.includes(type);
  }) ?? null;
}

function definitionUnionIncludesEnumValue(
  document: unknown,
  definition: string,
  value: string,
) {
  const union = isJsonObject(document) && isJsonObject(document.definitions)
    ? document.definitions[definition]
    : null;
  return isJsonObject(union) && Array.isArray(union.oneOf) &&
    union.oneOf.some((variant) =>
      isJsonObject(variant) && Array.isArray(variant.enum) && variant.enum.includes(value)
    );
}

function hasRequiredFields(value: unknown, fields: readonly string[]) {
  if (!isJsonObject(value) || !Array.isArray(value.required)) return false;
  const required = value.required;
  return fields.every((field) => required.includes(field));
}

function validateNativeThreadProjection(
  schemas: Readonly<Record<string, unknown>>,
  failures: string[],
) {
  const document = schemas["v2/ThreadReadResponse.json"];
  const definitions = isJsonObject(document) && isJsonObject(document.definitions)
    ? document.definitions
    : null;
  const thread = definitions?.Thread;
  if (!hasRequiredFields(thread, [
    "createdAt", "cwd", "ephemeral", "id", "preview", "source", "status", "turns", "updatedAt",
  ]) || !isJsonObject(thread) || !isJsonObject(thread.properties) ||
      !Object.hasOwn(thread.properties, "name") ||
      !Object.hasOwn(thread.properties, "parentThreadId")) {
    failures.push("v2/ThreadReadResponse.json: incomplete native Thread projection");
  }
  const turn = definitions?.Turn;
  if (!hasRequiredFields(turn, ["id", "items", "status"])) {
    failures.push("v2/ThreadReadResponse.json: incomplete native Turn projection");
  }

  const requiredItemFields: Readonly<Record<string, readonly string[]>> = {
    userMessage: ["content", "id", "type"],
    agentMessage: ["id", "text", "type"],
    plan: ["id", "text", "type"],
    reasoning: ["id", "type"],
    dynamicToolCall: ["arguments", "id", "status", "tool", "type"],
    collabAgentToolCall: [
      "agentsStates", "id", "receiverThreadIds", "senderThreadId", "status", "tool", "type",
    ],
    subAgentActivity: ["agentPath", "agentThreadId", "id", "kind", "type"],
    webSearch: ["id", "query", "type"],
    contextCompaction: ["id", "type"],
  };
  for (const [type, fields] of Object.entries(requiredItemFields)) {
    const variant = taggedDefinitionVariant(document, "ThreadItem", type);
    if (!hasRequiredFields(variant, fields)) {
      failures.push(`v2/ThreadReadResponse.json: incomplete ${type} ThreadItem`);
    }
  }
  const reasoning = taggedDefinitionVariant(document, "ThreadItem", "reasoning");
  const reasoningSummary = isJsonObject(reasoning) && isJsonObject(reasoning.properties)
    ? reasoning.properties.summary
    : null;
  if (!isJsonObject(reasoningSummary) || reasoningSummary.type !== "array" ||
      !isJsonObject(reasoningSummary.items) || reasoningSummary.items.type !== "string") {
    failures.push("v2/ThreadReadResponse.json: reasoning summary is not a string array");
  }
  const collabTools = definitions?.CollabAgentTool;
  const collabToolEnum = isJsonObject(collabTools) && Array.isArray(collabTools.enum)
    ? collabTools.enum
    : [];
  if (collabToolEnum.length === 0 ||
      !["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"].every(
        (tool) => collabToolEnum.includes(tool),
      )) {
    failures.push("v2/ThreadReadResponse.json: incomplete collaboration tool enum");
  }
  const subAgentKinds = definitions?.SubAgentActivityKind;
  const subAgentKindEnum = isJsonObject(subAgentKinds) && Array.isArray(subAgentKinds.enum)
    ? subAgentKinds.enum
    : [];
  if (subAgentKindEnum.length === 0 ||
      !["started", "interacted", "interrupted"].every(
        (kind) => subAgentKindEnum.includes(kind),
      )) {
    failures.push("v2/ThreadReadResponse.json: incomplete sub-agent activity enum");
  }

  for (const file of [
    "v2/ThreadResumeResponse.json",
    "v2/TurnStartedNotification.json",
    "v2/ItemStartedNotification.json",
    "v2/ItemCompletedNotification.json",
    "v2/TurnCompletedNotification.json",
  ]) {
    const lifecycleDocument = schemas[file];
    if (!hasRequiredFields(
      taggedDefinitionVariant(lifecycleDocument, "ThreadItem", "collabAgentToolCall"),
      requiredItemFields.collabAgentToolCall!,
    ) || !hasRequiredFields(
      taggedDefinitionVariant(lifecycleDocument, "ThreadItem", "subAgentActivity"),
      requiredItemFields.subAgentActivity!,
    )) {
      failures.push(`${file}: incomplete native worker ThreadItems`);
    }
  }
}

export function validateRequiredCodexSchema(
  schemas: Readonly<Record<string, unknown>>,
) {
  const failures: string[] = [];
  for (const contract of REQUIRED_SCHEMA_CONTRACT) {
    const document = schemas[contract.file];
    if (document === undefined) {
      failures.push(`${contract.file}: missing file`);
      continue;
    }
    for (const path of contract.requiredPaths) {
      if (!readRequiredPath(document, path)) {
        failures.push(`${contract.file}: missing ${path.join(".")}`);
      }
    }
  }
  const initialize = schemas["v1/InitializeParams.json"];
  const initializeCapabilities = isJsonObject(initialize) &&
      isJsonObject(initialize.properties)
    ? initialize.properties.capabilities
    : null;
  const capabilityVariants = isJsonObject(initializeCapabilities) &&
      Array.isArray(initializeCapabilities.anyOf)
    ? initializeCapabilities.anyOf
    : [];
  const directlyReferencesCapabilities = isJsonObject(initializeCapabilities) &&
    initializeCapabilities.$ref === "#/definitions/InitializeCapabilities" &&
    schemaHasOnlySemanticKeys(initializeCapabilities, ["$ref"]);
  const nullableReference = isJsonObject(initializeCapabilities) &&
    !Object.hasOwn(initializeCapabilities, "$ref") &&
    capabilityVariants.length === 2 &&
    capabilityVariants.some((variant) =>
      isJsonObject(variant) &&
      variant.$ref === "#/definitions/InitializeCapabilities" &&
      schemaHasOnlySemanticKeys(variant, ["$ref"])
    ) &&
    capabilityVariants.some((variant) =>
      isJsonObject(variant) && variant.type === "null" &&
      schemaHasOnlySemanticKeys(variant, ["type"])
    );
  if (!directlyReferencesCapabilities && !nullableReference) {
    failures.push(
      "v1/InitializeParams.json: capabilities must reference InitializeCapabilities",
    );
  }
  const requiredServerRequests = Object.freeze({
    "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalParams",
    "item/fileChange/requestApproval": "FileChangeRequestApprovalParams",
    "item/tool/requestUserInput": "ToolRequestUserInputParams",
    "mcpServer/elicitation/request": "McpServerElicitationRequestParams",
    "item/permissions/requestApproval": "PermissionsRequestApprovalParams",
    "item/tool/call": "DynamicToolCallParams",
    applyPatchApproval: "ApplyPatchApprovalParams",
    execCommandApproval: "ExecCommandApprovalParams",
  });
  for (const [method, definition] of Object.entries(requiredServerRequests)) {
    if (!hasMethodReference(schemas["ServerRequest.json"], method, definition, true)) {
      failures.push(`ServerRequest.json: missing ${method} -> ${definition}`);
    }
  }
  const requiredNotifications = Object.freeze({
    error: "ErrorNotification",
    "thread/started": "ThreadStartedNotification",
    "thread/status/changed": "ThreadStatusChangedNotification",
    "thread/archived": "ThreadArchivedNotification",
    "thread/name/updated": "ThreadNameUpdatedNotification",
    "turn/started": "TurnStartedNotification",
    "item/started": "ItemStartedNotification",
    "item/agentMessage/delta": "AgentMessageDeltaNotification",
    "item/plan/delta": "PlanDeltaNotification",
    "item/reasoning/summaryPartAdded": "ReasoningSummaryPartAddedNotification",
    "item/reasoning/summaryTextDelta": "ReasoningSummaryTextDeltaNotification",
    "item/completed": "ItemCompletedNotification",
    "serverRequest/resolved": "ServerRequestResolvedNotification",
    "turn/completed": "TurnCompletedNotification",
  });
  for (const [method, definition] of Object.entries(requiredNotifications)) {
    if (!hasMethodReference(schemas["ServerNotification.json"], method, definition, false)) {
      failures.push(`ServerNotification.json: missing ${method} -> ${definition}`);
    }
  }
  for (const [file, definition] of [
    ["CommandExecutionRequestApprovalResponse.json", "CommandExecutionApprovalDecision"],
    ["FileChangeRequestApprovalResponse.json", "FileChangeApprovalDecision"],
  ] as const) {
    if (!definitionUnionIncludesEnumValue(schemas[file], definition, "decline")) {
      failures.push(`${file}: missing decline decision`);
    }
  }
  validateNativeThreadProjection(schemas, failures);
  const dynamicResponse = schemas["DynamicToolCallResponse.json"];
  const outputDefinition = isJsonObject(dynamicResponse) && isJsonObject(dynamicResponse.definitions)
    ? dynamicResponse.definitions.DynamicToolCallOutputContentItem
    : null;
  const variants = isJsonObject(outputDefinition) && Array.isArray(outputDefinition.oneOf)
    ? outputDefinition.oneOf
    : [];
  const supportsInputText = variants.some((variant) => {
    if (!isJsonObject(variant) || !isJsonObject(variant.properties)) return false;
    const typeProperty = variant.properties.type;
    return (
      Array.isArray(variant.required) &&
      variant.required.includes("text") &&
      variant.required.includes("type") &&
      isJsonObject(typeProperty) &&
      Array.isArray(typeProperty.enum) &&
      typeProperty.enum.includes("inputText")
    );
  });
  if (!supportsInputText) {
    failures.push("DynamicToolCallResponse.json: missing inputText content item shape");
  }
  return Object.freeze(failures);
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintCodexCompatibilityContract(
  projection: CodexProtocolProjection,
) {
  const contract: CodexCompatibilityContract = {
    contractVersion: CODEX_FOLLOW_UP_CONTRACT_VERSION,
    protocol: projection,
    rpcPolicy: CODEX_FOLLOW_UP_RPC_POLICY,
    toolManifests: CODEX_FOLLOW_UP_TOOL_MANIFESTS,
    forbiddenCapabilityClasses: CODEX_FOLLOW_UP_FORBIDDEN_CAPABILITY_CLASSES,
  };
  return sha256Text(canonicalJson(normalizeSchemaValue(contract)));
}

async function readSchemaFiles(directory: string) {
  const schemas: Record<string, unknown> = {};
  for (const file of REQUIRED_SCHEMA_FILES) {
    try {
      const bytes = await readBoundedFile(
        join(directory, file),
        CODEX_FOLLOW_UP_RESOURCE_POLICY.schema.maxFileBytes,
        `Generated schema ${file}`,
      );
      schemas[file] = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new CodexCompatibilityError(
        "SCHEMA_PARSE",
        `Could not parse generated schema ${file}.`,
        error,
      );
    }
  }
  return schemas;
}

async function boundedSchemaInventory(directory: string) {
  return inventoryBoundedTree(
    directory,
    CODEX_FOLLOW_UP_RESOURCE_POLICY.schema,
    "Generated Codex schema bundle",
  );
}

async function hashDirectory(
  directory: string,
  inventory: Awaited<ReturnType<typeof boundedSchemaInventory>>,
  signal?: AbortSignal,
) {
  const hash = createHash("sha256");
  for (const file of [...inventory.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    let consumed = 0;
    for await (const chunk of createReadStream(file.absolutePath, { signal })) {
      consumed += chunk.length;
      if (consumed > CODEX_FOLLOW_UP_RESOURCE_POLICY.schema.maxFileBytes) {
        throw new CodexCompatibilityError(
          "SCHEMA_GENERATION",
          `Generated schema ${file.relativePath} exceeded its byte budget while hashing.`,
        );
      }
      hash.update(chunk);
    }
    if (consumed !== file.size) {
      throw new CodexCompatibilityError(
        "SCHEMA_GENERATION",
        `Generated schema ${file.relativePath} changed while hashing.`,
      );
    }
    hash.update("\0");
    if (signal?.aborted) throw signal.reason;
  }
  return hash.digest("hex");
}

async function boundedSchemaCacheEntries(schemaCacheDirectory: string) {
  const entries = [];
  const directory = await opendir(schemaCacheDirectory);
  for await (const entry of directory) {
    entries.push(entry);
    if (entries.length > CODEX_FOLLOW_UP_RESOURCE_POLICY.schema.maxCacheEntries) {
      throw new CodexCompatibilityError(
        "SCHEMA_GENERATION",
        "Codex schema cache exceeds its root-entry budget.",
      );
    }
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function cleanupInterruptedSchemaGenerations(schemaCacheDirectory: string) {
  for (const entry of await boundedSchemaCacheEntries(schemaCacheDirectory)) {
    if (!entry.name.startsWith(".generate-")) continue;
    const path = join(schemaCacheDirectory, entry.name);
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs < 5 * 60_000) continue;
    await rm(path, { recursive: true, force: true });
  }
}

async function protectedSchemaHashes(evidenceDirectory: string | undefined) {
  const hashes = new Set<string>();
  if (!evidenceDirectory) return hashes;
  for (const name of ["compatibility-v1.json", "last-accepted-v1.json"]) {
    try {
      const bytes = await readBoundedFile(
        join(evidenceDirectory, name),
        CODEX_FOLLOW_UP_RESOURCE_POLICY.evidenceBytes,
        "Codex compatibility evidence",
      );
      const parsed = JSON.parse(bytes.toString("utf8")) as { rawSchemaBundleSha256?: unknown };
      if (typeof parsed.rawSchemaBundleSha256 === "string" && /^[a-f0-9]{64}$/u.test(parsed.rawSchemaBundleSha256)) {
        hashes.add(parsed.rawSchemaBundleSha256);
      }
    } catch {
      // Evidence validity is checked by its store. Missing/corrupt evidence does
      // not grant retention authority here.
    }
  }
  return hashes;
}

async function pruneSchemaBundles(
  schemaCacheDirectory: string,
  evidenceDirectory: string | undefined,
  currentHash: string,
) {
  const protectedHashes = await protectedSchemaHashes(evidenceDirectory);
  protectedHashes.add(currentHash);
  const bundles: { name: string; modifiedAt: number }[] = [];
  for (const entry of await boundedSchemaCacheEntries(schemaCacheDirectory)) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const metadata = await stat(join(schemaCacheDirectory, entry.name));
    bundles.push({ name: entry.name, modifiedAt: metadata.mtimeMs });
  }
  const keep = new Set(protectedHashes);
  for (const bundle of bundles.sort((left, right) => right.modifiedAt - left.modifiedAt)) {
    if (keep.size >= CODEX_FOLLOW_UP_RESOURCE_POLICY.schema.retainedBundles) break;
    keep.add(bundle.name);
  }
  if (keep.size > CODEX_FOLLOW_UP_RESOURCE_POLICY.schema.retainedBundles) {
    throw new CodexCompatibilityError(
      "SCHEMA_GENERATION",
      "Schema evidence references exceed the retained-bundle budget.",
    );
  }
  await Promise.all(bundles
    .filter((bundle) => !keep.has(bundle.name))
    .map((bundle) => rm(join(schemaCacheDirectory, bundle.name), { recursive: true, force: true })));
}

export async function generateAndEvaluateCodexSchema(
  identity: CodexExecutableIdentity,
  deployment: Pick<ValidatedCodexFollowUpDeployment, "schemaCacheDirectory" | "evidenceDirectory" | "appCwd">,
  childEnvironment: Readonly<Record<string, string | undefined>>,
  options: { readonly signal?: AbortSignal } = {},
) : Promise<GeneratedCodexSchema> {
  await cleanupInterruptedSchemaGenerations(deployment.schemaCacheDirectory);
  const temporaryDirectory = join(
    deployment.schemaCacheDirectory,
    `.generate-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    await runAcceptedCodexProcess(
      identity,
      ["app-server", "generate-json-schema", "--experimental", "--out", temporaryDirectory],
      {
        cwd: deployment.appCwd,
        env: childEnvironment,
        signal: options.signal,
        timeoutMs: 20_000,
        maxOutputBytes: 256 * 1024,
      },
    );
    const inventory = await boundedSchemaInventory(temporaryDirectory);
    const schemas = await readSchemaFiles(temporaryDirectory);
    const failures = validateRequiredCodexSchema(schemas);
    if (failures.length > 0) {
      throw new CodexCompatibilityError(
        "SCHEMA_INCOMPATIBLE",
        `Generated Codex schema violates the required contract: ${failures.join("; ")}`,
      );
    }
    const projection = semanticSchemaProjection(schemas);
    const rawBundleSha256 = await hashDirectory(temporaryDirectory, inventory, options.signal);
    const fingerprint = fingerprintCodexCompatibilityContract(projection);
    const retainedDirectory = join(deployment.schemaCacheDirectory, rawBundleSha256);
    try {
      await rename(temporaryDirectory, retainedDirectory);
    } catch (error) {
      const existingMatches = await (async () => {
        try {
          const retainedInventory = await boundedSchemaInventory(retainedDirectory);
          await readSchemaFiles(retainedDirectory);
          return await hashDirectory(retainedDirectory, retainedInventory, options.signal) === rawBundleSha256;
        } catch {
          return false;
        }
      })();
      if (!existingMatches) throw error;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    await pruneSchemaBundles(
      deployment.schemaCacheDirectory,
      deployment.evidenceDirectory,
      rawBundleSha256,
    );
    return Object.freeze({
      directory: retainedDirectory,
      rawBundleSha256,
      projection,
      fingerprint,
    });
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (error instanceof CodexCompatibilityError) throw error;
    // An updater swap is not a schema incompatibility. Preserve the launcher
    // signal so readiness can restart evaluation against the new exact target.
    if (error instanceof CodexLauncherError && error.code === "IDENTITY_CHANGED") {
      throw error;
    }
    throw new CodexCompatibilityError(
      "SCHEMA_GENERATION",
      "Codex schema generation failed.",
      error,
    );
  }
}

function boundedStringArray(
  value: unknown,
  maximum: number,
): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((entry) =>
    typeof entry === "string");
}

function exactStringArray(value: unknown, expected: readonly string[]) {
  return boundedStringArray(value, expected.length) &&
    canonicalJson(value) === canonicalJson([...expected]);
}

function hashRecord(value: unknown, maximum: number): value is Record<string, string> {
  if (!isJsonObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= maximum && entries.every(([key, hash]) =>
    key.length > 0 && typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash));
}

function reusableCapabilityEvidence(value: unknown): value is CodexCapabilityEvidence {
  if (!isJsonObject(value)) return false;
  const probeRuntimeFiles = value.probeRuntimeFiles;
  return (
    value.researchWebSearchMode === CODEX_FOLLOW_UP_RESEARCH_WEB_SEARCH_MODE &&
    exactStringArray(value.researchTools, CODEX_FOLLOW_UP_TOOL_MANIFESTS.research) &&
    exactStringArray(value.plannerTools, CODEX_FOLLOW_UP_TOOL_MANIFESTS.planner) &&
    exactStringArray(value.workerTools, CODEX_FOLLOW_UP_TOOL_MANIFESTS.workerRequired) &&
    exactStringArray(
      value.plannerNamespaceMembers,
      CODEX_FOLLOW_UP_TOOL_MANIFESTS.plannerNamespace,
    ) &&
    exactStringArray(value.forbiddenHits, []) &&
    exactStringArray(value.unexpectedRpcMethods, []) &&
    value.plannerReadObserved === true &&
    value.workerWaitCallObserved === true &&
    value.workerWaitResultObserved === true &&
    value.workerResultObserved === true &&
    value.userInputRoundTripObserved === true &&
    value.dependentResultObserved === true &&
    value.outboundPolicyRejected === true &&
    value.approvalPolicy === "never" &&
    value.permissionProfile === ":read-only" &&
    value.effectiveSandbox === "read-only-network-disabled" &&
    boundedStringArray(
      probeRuntimeFiles,
      CODEX_FOLLOW_UP_RESOURCE_POLICY.runtimeInventory.maxFiles,
    ) &&
    probeRuntimeFiles.includes(".planner-unified-native-thread-v1") &&
    new Set(probeRuntimeFiles).size === probeRuntimeFiles.length
  );
}

function reusableDeploymentReadback(value: unknown): value is CodexDeploymentReadbackEvidence {
  if (!isJsonObject(value) || typeof value.authenticated !== "boolean") return false;
  const accountKind = value.accountKind;
  if (
    (value.authenticated && accountKind !== "chatgpt") ||
    (!value.authenticated && accountKind !== null)
  ) return false;
  const configHashes = value.configSourceHashes;
  const systemConfigPaths = value.systemConfigPaths;
  const instructionHashes = value.instructionSourceHashes;
  const configKeys = isJsonObject(configHashes) ? Object.keys(configHashes) : [];
  return (
    value.permissionProfile === ":read-only" &&
    value.effectiveSandbox === "read-only-network-disabled" &&
    hashRecord(configHashes, CODEX_FOLLOW_UP_RESOURCE_POLICY.provenance.maxSources) &&
    configKeys.length === 2 &&
    configKeys.filter((key) => key.startsWith("user:")).length === 1 &&
    configKeys.filter((key) => key.startsWith("system:")).length === 1 &&
    boundedStringArray(systemConfigPaths, 1) &&
    systemConfigPaths.length === 1 &&
    isAbsolute(systemConfigPaths[0]) &&
    resolve(systemConfigPaths[0]) === systemConfigPaths[0] &&
    hashRecord(instructionHashes, CODEX_FOLLOW_UP_RESOURCE_POLICY.provenance.maxSources) &&
    Object.keys(instructionHashes).length === 1 &&
    Object.hasOwn(instructionHashes, "dedicated:0") &&
    boundedStringArray(value.skillNames, CODEX_FOLLOW_UP_RESOURCE_POLICY.pagination.maxRows) &&
    new Set(value.skillNames).size === value.skillNames.length &&
    exactStringArray(value.mcpServerNames, []) &&
    exactStringArray(value.appNames, []) &&
    exactStringArray(value.pluginNames, []) &&
    boundedStringArray(
      value.runtimeFiles,
      CODEX_FOLLOW_UP_RESOURCE_POLICY.runtimeInventory.maxFiles,
    ) &&
    new Set(value.runtimeFiles).size === value.runtimeFiles.length
  );
}

function evidenceIdentityMatches(
  evidence: unknown,
  identity: CodexExecutableIdentity,
  fingerprint: string,
): evidence is CodexCompatibilityEvidence {
  if (
    !isJsonObject(evidence) ||
    evidence.contractVersion !== CODEX_FOLLOW_UP_CONTRACT_VERSION ||
    evidence.disposition !== "compatible" ||
    evidence.active !== false ||
    evidence.schemaFingerprint !== fingerprint ||
    typeof evidence.rawSchemaBundleSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(evidence.rawSchemaBundleSha256) ||
    !isJsonObject(evidence.executable) ||
    !reusableCapabilityEvidence(evidence.capability) ||
    !reusableDeploymentReadback(evidence.deploymentReadback) ||
    typeof evidence.detail !== "string" ||
    evidence.detail.length > 1_024
  ) return false;
  return (
    canonicalJson(normalizeSchemaValue(evidence.executable)) ===
      canonicalJson(normalizeSchemaValue(identity))
  );
}

async function atomicWriteJson(path: string, value: JsonValue) {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export class CodexCompatibilityEvidenceStore {
  readonly currentPath: string;
  readonly lastAcceptedPath: string;

  constructor(evidenceDirectory: string) {
    this.currentPath = join(evidenceDirectory, "compatibility-v1.json");
    this.lastAcceptedPath = join(evidenceDirectory, "last-accepted-v1.json");
  }

  async publishChecking(
    identity: CodexExecutableIdentity | null,
    schemaFingerprint: string | null,
    rawSchemaBundleSha256: string | null,
  ) {
    await this.#publish({
      contractVersion: 1,
      evaluatedAt: new Date().toISOString(),
      disposition: "checking",
      active: false,
      executable: identity,
      schemaFingerprint,
      rawSchemaBundleSha256,
      capability: null,
      deploymentReadback: null,
      detail: "Compatibility evaluation is in progress.",
    });
  }

  async publishFinal(evidence: CodexCompatibilityEvidence) {
    if (evidence.disposition === "checking") {
      throw new TypeError("publishFinal cannot publish a checking disposition.");
    }
    await this.#publish(evidence);
    if (evidence.disposition === "compatible") {
      await atomicWriteJson(
        this.lastAcceptedPath,
        normalizeSchemaValue(evidence),
      );
    }
  }

  async readReusablePositive(
    identity: CodexExecutableIdentity,
    schemaFingerprint: string,
  ): Promise<CodexCompatibilityEvidence | null> {
    try {
      const bytes = await readBoundedFile(
        this.lastAcceptedPath,
        CODEX_FOLLOW_UP_RESOURCE_POLICY.evidenceBytes,
        "Codex compatibility evidence",
      );
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      return evidenceIdentityMatches(parsed, identity, schemaFingerprint) ? parsed : null;
    } catch {
      return null;
    }
  }

  async #publish(evidence: CodexCompatibilityEvidence) {
    await atomicWriteJson(this.currentPath, normalizeSchemaValue(evidence));
  }
}

export function createCompatibilityEvidence(
  value: Omit<CodexCompatibilityEvidence, "contractVersion" | "active" | "evaluatedAt"> & {
    readonly evaluatedAt?: string;
  },
): CodexCompatibilityEvidence {
  return Object.freeze({
    contractVersion: 1,
    evaluatedAt: value.evaluatedAt ?? new Date().toISOString(),
    active: false,
    disposition: value.disposition,
    executable: value.executable,
    schemaFingerprint: value.schemaFingerprint,
    rawSchemaBundleSha256: value.rawSchemaBundleSha256,
    capability: value.capability,
    deploymentReadback: value.deploymentReadback,
    detail: value.detail,
  });
}
