const objectSchema = () => ({ type: "object", properties: {} });

const taggedItem = (type, required, properties = {}) => ({
  type: "object",
  required,
  properties: {
    ...properties,
    type: { type: "string", enum: [type] },
  },
});

const nativeThreadDefinitions = () => ({
  CollabAgentTool: {
    type: "string",
    enum: ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"],
  },
  SubAgentActivityKind: {
    type: "string",
    enum: ["started", "interacted", "interrupted"],
  },
  ThreadItem: {
    oneOf: [
      taggedItem("userMessage", ["content", "id", "type"], {
        content: { type: "array" }, id: { type: "string" },
      }),
      taggedItem("agentMessage", ["id", "text", "type"], {
        id: { type: "string" }, text: { type: "string" }, phase: { type: ["string", "null"] },
      }),
      taggedItem("plan", ["id", "text", "type"], {
        id: { type: "string" }, text: { type: "string" },
      }),
      taggedItem("reasoning", ["id", "type"], {
        id: { type: "string" },
        summary: { type: "array", items: { type: "string" } },
        content: { type: "array", items: { type: "string" } },
      }),
      taggedItem("dynamicToolCall", ["arguments", "id", "status", "tool", "type"], {
        arguments: true, id: { type: "string" }, status: { type: "string" }, tool: { type: "string" },
      }),
      taggedItem(
        "collabAgentToolCall",
        ["agentsStates", "id", "receiverThreadIds", "senderThreadId", "status", "tool", "type"],
        {
          agentsStates: { type: "object" }, id: { type: "string" },
          receiverThreadIds: { type: "array" }, senderThreadId: { type: "string" },
          status: { type: "string" }, tool: { $ref: "#/definitions/CollabAgentTool" },
        },
      ),
      taggedItem("subAgentActivity", ["agentPath", "agentThreadId", "id", "kind", "type"], {
        agentPath: { type: "string" }, agentThreadId: { type: "string" }, id: { type: "string" },
        kind: { $ref: "#/definitions/SubAgentActivityKind" },
      }),
      taggedItem("webSearch", ["id", "query", "type"], {
        id: { type: "string" }, query: { type: "string" },
      }),
      taggedItem("contextCompaction", ["id", "type"], { id: { type: "string" } }),
    ],
  },
  Turn: {
    type: "object",
    required: ["id", "items", "status"],
    properties: {
      id: { type: "string" },
      items: { type: "array", items: { $ref: "#/definitions/ThreadItem" } },
      status: { type: "string" },
    },
  },
  Thread: {
    type: "object",
    required: [
      "createdAt", "cwd", "ephemeral", "id", "preview", "source", "status", "turns", "updatedAt",
    ],
    properties: {
      createdAt: { type: "integer" }, cwd: { type: "string" }, ephemeral: { type: "boolean" },
      id: { type: "string" }, name: { type: ["string", "null"] },
      parentThreadId: { type: ["string", "null"] }, preview: { type: "string" },
      source: { type: "string" }, status: { type: "object" },
      turns: { type: "array", items: { $ref: "#/definitions/Turn" } },
      updatedAt: { type: "integer" },
    },
  },
});

const methodEnvelope = (method, definition, request = false) => ({
  type: "object",
  required: request ? ["id", "method", "params"] : ["method", "params"],
  properties: {
    ...(request ? { id: { type: ["integer", "string"] } } : {}),
    method: { type: "string", enum: [method] },
    params: { $ref: `#/definitions/${definition}` },
  },
});

const lifecycleNotification = (required, definitions = undefined) => ({
  type: "object",
  required,
  properties: Object.fromEntries(required.map((key) => [
    key,
    key.endsWith("AtMs") || key === "summaryIndex" ? { type: "integer" } :
      key === "item" || key === "thread" || key === "turn" || key === "status" ? {} :
        { type: "string" },
  ])),
  ...(definitions ? { definitions } : {}),
});

export const LEGACY_SIMPLIFIED_PLANNER_NAMESPACE_FIXTURE = Object.freeze({
  type: "namespace",
  name: "planner",
  description: "No-effect planner compatibility tools.",
  tools: [
    {
      type: "function",
      name: "read",
      description: "Return a synthetic planner version.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "preview",
      description: "Return a synthetic no-effect preview token.",
      inputSchema: {
        type: "object",
        properties: { operation: { type: "string", enum: ["probe"] } },
        required: ["operation"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "apply",
      description: "Consume the synthetic preview token without effects.",
      inputSchema: {
        type: "object",
        properties: { previewToken: { type: "string", enum: ["preview-123"] } },
        required: ["previewToken"],
        additionalProperties: false,
      },
    },
  ],
});

function canonicalFixtureJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalFixtureJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function acceptsOnlyLegacySimplifiedPlannerNamespace(dynamicTools) {
  return Array.isArray(dynamicTools) &&
    dynamicTools.length === 1 &&
    canonicalFixtureJson(dynamicTools[0]) ===
      canonicalFixtureJson(LEGACY_SIMPLIFIED_PLANNER_NAMESPACE_FIXTURE);
}

const PROVIDER_SCHEMA_TYPES = new Set([
  "string", "number", "boolean", "integer", "object", "array", "null",
]);
const PROVIDER_SCHEMA_CHILD_KEYS = ["items", "anyOf", "oneOf", "allOf"];
const PROVIDER_SCHEMA_COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"];

function normalizeProviderSchema(value) {
  if (typeof value === "boolean") return { type: "string" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  if (typeof value.$ref === "string") normalized.$ref = value.$ref;
  if (typeof value.description === "string") normalized.description = value.description;
  if (typeof value.encrypted === "boolean") normalized.encrypted = value.encrypted;
  if (Array.isArray(value.enum)) normalized.enum = value.enum;
  else if (Object.hasOwn(value, "const")) normalized.enum = [value.const];
  if (value.properties !== null && typeof value.properties === "object" && !Array.isArray(value.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(value.properties).map(([key, child]) => [key, normalizeProviderSchema(child)]),
    );
  }
  if (Object.hasOwn(value, "items")) normalized.items = normalizeProviderSchema(value.items);
  if (Array.isArray(value.required)) normalized.required = value.required;
  if (typeof value.additionalProperties === "boolean") normalized.additionalProperties = value.additionalProperties;
  else if (Object.hasOwn(value, "additionalProperties")) {
    normalized.additionalProperties = normalizeProviderSchema(value.additionalProperties);
  }
  for (const key of PROVIDER_SCHEMA_COMPOSITION_KEYS) {
    if (Array.isArray(value[key])) normalized[key] = value[key].map(normalizeProviderSchema);
  }
  for (const key of ["$defs", "definitions"]) {
    if (value[key] !== null && typeof value[key] === "object" && !Array.isArray(value[key])) {
      normalized[key] = Object.fromEntries(
        Object.entries(value[key]).map(([name, child]) => [name, normalizeProviderSchema(child)]),
      );
    }
  }
  const rawTypes = typeof value.type === "string" ? [value.type] : Array.isArray(value.type) ? value.type : [];
  const types = rawTypes.filter((candidate) => typeof candidate === "string" && PROVIDER_SCHEMA_TYPES.has(candidate));
  if (types.length === 0 && !normalized.$ref &&
      !PROVIDER_SCHEMA_COMPOSITION_KEYS.some((key) => Object.hasOwn(normalized, key))) {
    if (["properties", "required", "additionalProperties"].some((key) => Object.hasOwn(value, key))) types.push("object");
    else if (Object.hasOwn(value, "items") || Object.hasOwn(value, "prefixItems")) types.push("array");
    else if (Object.hasOwn(normalized, "enum") || Object.hasOwn(value, "format")) types.push("string");
    else if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => Object.hasOwn(value, key))) types.push("number");
    else return {};
  }
  if (types.length === 1) normalized.type = types[0];
  else if (types.length > 1) normalized.type = types;
  if (types.includes("object") && !Object.hasOwn(normalized, "properties")) normalized.properties = {};
  if (types.includes("array") && !Object.hasOwn(normalized, "items")) normalized.items = { type: "string" };
  return normalized;
}

function mapChildren(value, transform, includeDefinitions) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const mapped = { ...value };
  if (mapped.properties !== null && typeof mapped.properties === "object" && !Array.isArray(mapped.properties)) {
    mapped.properties = Object.fromEntries(Object.entries(mapped.properties).map(([key, child]) => [key, transform(child)]));
  }
  for (const key of PROVIDER_SCHEMA_CHILD_KEYS) if (Object.hasOwn(mapped, key)) mapped[key] = transform(mapped[key]);
  if (mapped.additionalProperties !== null && typeof mapped.additionalProperties === "object") {
    mapped.additionalProperties = transform(mapped.additionalProperties);
  }
  if (includeDefinitions) {
    for (const key of ["$defs", "definitions"]) {
      if (mapped[key] !== null && typeof mapped[key] === "object" && !Array.isArray(mapped[key])) {
        mapped[key] = Object.fromEntries(Object.entries(mapped[key]).map(([name, child]) => [name, transform(child)]));
      }
    }
  }
  return mapped;
}

function stripDescriptions(value) {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value === null || typeof value !== "object") return value;
  const mapped = mapChildren(value, stripDescriptions, true);
  delete mapped.description;
  return mapped;
}

function dropDefinitions(value) {
  const rewrite = (candidate) => {
    if (Array.isArray(candidate)) return candidate.map(rewrite);
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (typeof candidate.$ref === "string" && /^#\/(?:\$defs|definitions)\//.test(candidate.$ref)) return {};
    return mapChildren(candidate, rewrite, false);
  };
  const mapped = rewrite(value);
  delete mapped.$defs;
  delete mapped.definitions;
  return mapped;
}

function collapseDeep(value, depth = 0) {
  if (Array.isArray(value)) return value.map((child) => collapseDeep(child, depth));
  if (value === null || typeof value !== "object") return value;
  const complex = PROVIDER_SCHEMA_CHILD_KEYS.some((key) => Object.hasOwn(value, key)) ||
    ["properties", "additionalProperties", "$ref"].some((key) => Object.hasOwn(value, key));
  if (depth >= 3 && complex) return {};
  return mapChildren(value, (child) => collapseDeep(child, depth + 1), false);
}

function pruneCompositions(value) {
  if (Array.isArray(value)) return value.map(pruneCompositions);
  if (value === null || typeof value !== "object") return value;
  if (PROVIDER_SCHEMA_COMPOSITION_KEYS.some((key) => Object.hasOwn(value, key))) return {};
  return mapChildren(value, pruneCompositions, false);
}

function projectProviderParameters(inputSchema) {
  let normalized = normalizeProviderSchema(inputSchema);
  for (const compact of [stripDescriptions, dropDefinitions, collapseDeep, pruneCompositions]) {
    if (Buffer.byteLength(JSON.stringify(normalized), "utf8") <= 4_000) break;
    normalized = compact(normalized);
  }
  return normalized;
}

export function projectDynamicToolSpecsForProvider(dynamicTools) {
  return dynamicTools.map((spec) => spec.type === "namespace" ? {
    type: "namespace",
    name: spec.name,
    description: spec.description,
    tools: spec.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      strict: false,
      parameters: projectProviderParameters(tool.inputSchema),
    })).sort((left, right) => left.name.localeCompare(right.name)),
  } : {
    type: "function",
    name: spec.name,
    description: spec.description,
    strict: false,
    parameters: projectProviderParameters(spec.inputSchema),
  });
}

export const REQUIRED_CODEX_SCHEMA_FILES = Object.freeze([
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
]);

export function createCodexSchemaDocuments(variant = "compatible-a") {
  const documents = Object.fromEntries(
    REQUIRED_CODEX_SCHEMA_FILES.map((file) => [file, objectSchema()]),
  );

  documents["v1/InitializeParams.json"] = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "InitializeParams",
    description: variant === "compatible-docs"
      ? "Documentation changed."
      : variant === "compatible-b"
        ? "Compatible fixture B."
        : variant === "compatible-c"
          ? "Compatible fixture C."
          : "Initialize.",
    type: "object",
    required: ["clientInfo"],
    properties: {
      clientInfo: { type: "object" },
      capabilities: {
        anyOf: [
          { $ref: "#/definitions/InitializeCapabilities" },
          { type: "null" },
        ],
      },
    },
    definitions: {
      InitializeCapabilities: {
        type: "object",
        properties: {
          experimentalApi: { type: "boolean", default: false },
          optOutNotificationMethods: {
            type: ["array", "null"],
            items: { type: "string" },
          },
        },
      },
    },
  };
  documents["ServerNotification.json"] = {
    type: "object",
    oneOf: Object.entries({
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
      "account/login/completed": "AccountLoginCompletedNotification",
      "remoteControl/status/changed": "RemoteControlStatusChangedNotification",
    }).map(([method, definition]) => methodEnvelope(method, definition)),
    definitions: Object.fromEntries([
      "ErrorNotification", "ThreadStartedNotification", "ThreadStatusChangedNotification",
      "ThreadArchivedNotification", "ThreadNameUpdatedNotification", "TurnStartedNotification",
      "ItemStartedNotification", "AgentMessageDeltaNotification", "PlanDeltaNotification",
      "ReasoningSummaryPartAddedNotification", "ReasoningSummaryTextDeltaNotification",
      "ItemCompletedNotification", "ServerRequestResolvedNotification", "TurnCompletedNotification",
      "AccountLoginCompletedNotification", "RemoteControlStatusChangedNotification",
    ].map((definition) => [definition, { type: "object" }])),
  };
  documents["ServerRequest.json"] = {
    type: "object",
    oneOf: Object.entries({
      "item/commandExecution/requestApproval": "CommandExecutionRequestApprovalParams",
      "item/fileChange/requestApproval": "FileChangeRequestApprovalParams",
      "item/tool/requestUserInput": "ToolRequestUserInputParams",
      "mcpServer/elicitation/request": "McpServerElicitationRequestParams",
      "item/permissions/requestApproval": "PermissionsRequestApprovalParams",
      "item/tool/call": "DynamicToolCallParams",
      applyPatchApproval: "ApplyPatchApprovalParams",
      execCommandApproval: "ExecCommandApprovalParams",
    }).map(([method, definition]) => methodEnvelope(method, definition, true)),
    definitions: Object.fromEntries([
      "CommandExecutionRequestApprovalParams", "FileChangeRequestApprovalParams",
      "ToolRequestUserInputParams", "McpServerElicitationRequestParams",
      "PermissionsRequestApprovalParams", "DynamicToolCallParams", "ApplyPatchApprovalParams",
      "ExecCommandApprovalParams",
    ].map((definition) => [definition, { type: "object" }])),
  };
  documents["v2/ThreadStartParams.json"] = {
    type: "object",
    properties: {
      approvalPolicy: { type: ["string", "null"] },
      config: { type: ["object", "null"], additionalProperties: true },
      cwd: { type: ["string", "null"] },
      dynamicTools: { type: ["array", "null"], items: { type: "object" } },
      environments: { type: ["array", "null"], items: { type: "object" } },
      ephemeral: { type: ["boolean", "null"] },
      permissions: { type: ["string", "null"] },
      sandbox: { type: ["string", "null"] },
      ...(variant === "compatible-additive" ? { optionalNewField: { type: "string" } } : {}),
    },
  };
  documents["v2/GetAccountResponse.json"] = {
    type: "object",
    required: ["requiresOpenaiAuth"],
    properties: {
      account: { type: ["object", "null"] },
      requiresOpenaiAuth: { type: "boolean" },
    },
  };
  documents["v2/ConfigReadResponse.json"] = {
    type: "object",
    required: ["config", "origins"],
    properties: {
      config: { type: "object" },
      layers: { type: ["array", "null"] },
      origins: { type: "object" },
    },
  };
  documents["v2/SkillsListResponse.json"] = {
    type: "object",
    required: ["data"],
    properties: { data: { type: "array" } },
  };
  documents["v2/PermissionProfileListResponse.json"] = {
    type: "object",
    required: ["data"],
    properties: {
      data: { type: "array" },
      nextCursor: { type: ["string", "null"] },
    },
    definitions: {
      PermissionProfileSummary: {
        type: "object",
        required: ["allowed", "id"],
        properties: { allowed: { type: "boolean" }, id: { type: "string" } },
      },
    },
  };
  for (const file of [
    "v2/ListMcpServerStatusResponse.json",
    "v2/AppsListResponse.json",
  ]) {
    documents[file] = {
      type: "object",
      required: ["data"],
      properties: {
        data: { type: "array" },
        nextCursor: { type: ["string", "null"] },
      },
    };
  }
  documents["v2/PluginListResponse.json"] = {
    type: "object",
    required: ["marketplaces"],
    properties: { marketplaces: { type: "array" } },
  };
  documents["v2/ThreadListParams.json"] = {
    type: "object",
    properties: {
      archived: { type: ["boolean", "null"] },
      cursor: { type: ["string", "null"] },
      cwd: { type: ["string", "null"] },
      limit: { type: ["integer", "null"] },
      parentThreadId: { type: ["string", "null"] },
      sourceKinds: { type: ["array", "null"], items: { type: "string" } },
    },
  };
  documents["v2/ThreadListResponse.json"] = {
    type: "object",
    required: ["data"],
    properties: {
      data: { type: "array", items: { $ref: "#/definitions/Thread" } },
      nextCursor: { type: ["string", "null"] },
      backwardsCursor: { type: ["string", "null"] },
    },
    definitions: nativeThreadDefinitions(),
  };
  documents["v2/ThreadReadParams.json"] = {
    type: "object",
    required: ["threadId"],
    properties: {
      includeTurns: { type: "boolean" },
      threadId: { type: "string" },
    },
  };
  documents["v2/ThreadReadResponse.json"] = {
    type: "object",
    required: ["thread"],
    properties: { thread: { $ref: "#/definitions/Thread" } },
    definitions: nativeThreadDefinitions(),
  };
  documents["v2/ThreadResumeParams.json"] = {
    type: "object",
    required: ["threadId"],
    properties: {
      config: { type: ["object", "null"] },
      cwd: { type: ["string", "null"] },
      permissions: { type: ["string", "null"] },
      sandbox: { type: ["string", "null"] },
      threadId: { type: "string" },
    },
  };
  documents["v2/ThreadResumeResponse.json"] = {
    type: "object",
    required: ["approvalPolicy", "approvalsReviewer", "cwd", "sandbox", "thread"],
    properties: {
      activePermissionProfile: { type: ["object", "null"] },
      approvalPolicy: { type: "string" },
      approvalsReviewer: { type: "string" },
      cwd: { type: "string" },
      instructionSources: { type: "array" },
      sandbox: { type: "object" },
      thread: { $ref: "#/definitions/Thread" },
    },
    definitions: nativeThreadDefinitions(),
  };
  documents["v2/ThreadStartResponse.json"] = {
    type: "object",
    required: ["approvalPolicy", "cwd", "sandbox", "thread"],
    properties: {
      activePermissionProfile: { type: ["object", "null"] },
      approvalPolicy: { type: "string" },
      cwd: { type: "string" },
      instructionSources: { type: "array", items: { type: "string" } },
      sandbox: { type: "object" },
      thread: { type: "object" },
    },
  };
  documents["v2/ThreadUnsubscribeParams.json"] = {
    type: "object",
    required: ["threadId"],
    properties: { threadId: { type: "string" } },
  };
  documents["v2/ThreadArchiveParams.json"] = {
    type: "object",
    required: ["threadId"],
    properties: { threadId: { type: "string" } },
  };
  documents["v2/ThreadArchiveResponse.json"] = objectSchema();
  documents["v2/TurnStartParams.json"] = {
    type: "object",
    required: variant === "incompatible-required" ? ["input"] : ["input", "threadId"],
    properties: {
      input: { type: "array" },
      threadId: { type: "string" },
      clientUserMessageId: { type: ["string", "null"] },
      cwd: { type: ["string", "null"] },
      effort: { type: ["string", "null"] },
      environments: { type: ["array", "null"] },
      permissions: { type: ["string", "null"] },
    },
  };
  documents["v2/TurnStartResponse.json"] = {
    type: "object",
    required: ["turn"],
    properties: { turn: { type: "object" } },
  };
  documents["v2/TurnSteerParams.json"] = {
    type: "object",
    required: ["expectedTurnId", "input", "threadId"],
    properties: {
      clientUserMessageId: { type: ["string", "null"] },
      expectedTurnId: { type: "string" },
      input: { type: "array" },
      threadId: { type: "string" },
    },
  };
  documents["v2/TurnSteerResponse.json"] = {
    type: "object",
    required: ["turnId"],
    properties: { turnId: { type: "string" } },
  };
  documents["v2/TurnInterruptParams.json"] = {
    type: "object",
    required: ["threadId", "turnId"],
    properties: { threadId: { type: "string" }, turnId: { type: "string" } },
  };
  documents["ToolRequestUserInputParams.json"] = {
    type: "object",
    required: ["itemId", "questions", "threadId", "turnId"],
    properties: {
      autoResolutionMs: { type: ["integer", "null"] },
      itemId: { type: "string" },
      questions: { type: "array", items: { $ref: "#/definitions/ToolRequestUserInputQuestion" } },
      threadId: { type: "string" },
      turnId: { type: "string" },
    },
    definitions: {
      ToolRequestUserInputQuestion: {
        type: "object",
        required: ["header", "id", "question"],
        properties: {
          header: { type: "string" }, id: { type: "string" }, question: { type: "string" },
          isOther: { type: "boolean" }, isSecret: { type: "boolean" },
          options: { type: ["array", "null"], items: { $ref: "#/definitions/ToolRequestUserInputOption" } },
        },
      },
      ToolRequestUserInputOption: {
        type: "object",
        required: ["description", "label"],
        properties: { description: { type: "string" }, label: { type: "string" } },
      },
    },
  };
  documents["ToolRequestUserInputResponse.json"] = {
    type: "object",
    required: ["answers"],
    properties: {
      answers: {
        type: "object",
        additionalProperties: { $ref: "#/definitions/ToolRequestUserInputAnswer" },
      },
    },
    definitions: {
      ToolRequestUserInputAnswer: {
        type: "object",
        required: ["answers"],
        properties: { answers: { type: "array", items: { type: "string" } } },
      },
    },
  };
  for (const [file, required] of Object.entries({
    "CommandExecutionRequestApprovalParams.json": ["itemId", "startedAtMs", "threadId", "turnId"],
    "FileChangeRequestApprovalParams.json": ["itemId", "startedAtMs", "threadId", "turnId"],
    "PermissionsRequestApprovalParams.json": [
      "cwd", "itemId", "permissions", "startedAtMs", "threadId", "turnId",
    ],
  })) {
    documents[file] = {
      type: "object",
      required,
      properties: Object.fromEntries(required.map((key) => [
        key,
        key === "startedAtMs" ? { type: "integer" } :
          key === "permissions" ? { type: "object" } : { type: "string" },
      ])),
    };
  }
  for (const [file, definition] of Object.entries({
    "CommandExecutionRequestApprovalResponse.json": "CommandExecutionApprovalDecision",
    "FileChangeRequestApprovalResponse.json": "FileChangeApprovalDecision",
  })) {
    documents[file] = {
      type: "object",
      required: ["decision"],
      properties: { decision: { $ref: `#/definitions/${definition}` } },
      definitions: {
        [definition]: {
          oneOf: [
            { type: "string", enum: ["accept"] },
            { type: "string", enum: ["decline"] },
            { type: "string", enum: ["cancel"] },
          ],
        },
      },
    };
  }
  documents["PermissionsRequestApprovalResponse.json"] = {
    type: "object",
    required: ["permissions"],
    properties: { permissions: { type: "object" } },
  };
  documents["DynamicToolCallParams.json"] = {
    type: "object",
    required: ["arguments", "callId", "threadId", "tool", "turnId"],
    properties: {
      arguments: true,
      callId: { type: "string" },
      namespace: { type: ["string", "null"] },
      threadId: { type: "string" },
      tool: { type: "string" },
      turnId: { type: "string" },
    },
  };
  documents["DynamicToolCallResponse.json"] = {
    type: "object",
    required: ["contentItems", "success"],
    properties: {
      contentItems: {
        type: "array",
        items: { $ref: "#/definitions/DynamicToolCallOutputContentItem" },
      },
      success: { type: "boolean" },
    },
    definitions: {
      DynamicToolCallOutputContentItem: {
        oneOf: [
          {
            type: "object",
            required: ["text", "type"],
            properties: {
              text: { type: "string" },
              type: { type: "string", enum: ["inputText"] },
            },
          },
        ],
      },
    },
  };
  const nativeDefinitions = nativeThreadDefinitions();
  documents["v2/ThreadStartedNotification.json"] = lifecycleNotification(
    ["thread"], nativeDefinitions,
  );
  documents["v2/ThreadStatusChangedNotification.json"] = lifecycleNotification(
    ["status", "threadId"],
  );
  documents["v2/ThreadArchivedNotification.json"] = lifecycleNotification(["threadId"]);
  documents["v2/ThreadNameUpdatedNotification.json"] = {
    type: "object",
    required: ["threadId"],
    properties: { threadId: { type: "string" }, threadName: { type: ["string", "null"] } },
  };
  documents["v2/TurnStartedNotification.json"] = lifecycleNotification(
    ["threadId", "turn"], nativeThreadDefinitions(),
  );
  documents["v2/ItemStartedNotification.json"] = lifecycleNotification(
    ["item", "startedAtMs", "threadId", "turnId"], nativeThreadDefinitions(),
  );
  documents["v2/AgentMessageDeltaNotification.json"] = lifecycleNotification(
    ["delta", "itemId", "threadId", "turnId"],
  );
  documents["v2/PlanDeltaNotification.json"] = lifecycleNotification(
    ["delta", "itemId", "threadId", "turnId"],
  );
  documents["v2/ReasoningSummaryPartAddedNotification.json"] = lifecycleNotification(
    ["itemId", "summaryIndex", "threadId", "turnId"],
  );
  documents["v2/ReasoningSummaryTextDeltaNotification.json"] = lifecycleNotification(
    ["delta", "itemId", "summaryIndex", "threadId", "turnId"],
  );
  documents["v2/ItemCompletedNotification.json"] = lifecycleNotification(
    ["completedAtMs", "item", "threadId", "turnId"], nativeThreadDefinitions(),
  );
  documents["v2/ServerRequestResolvedNotification.json"] = {
    type: "object",
    required: ["requestId", "threadId"],
    properties: {
      requestId: { type: ["integer", "string"] },
      threadId: { type: "string" },
    },
  };
  documents["v2/TurnCompletedNotification.json"] = lifecycleNotification(
    ["threadId", "turn"], nativeThreadDefinitions(),
  );
  documents["v2/ErrorNotification.json"] = {
    type: "object",
    required: ["error", "threadId", "turnId", "willRetry"],
    properties: { error: {}, threadId: { type: "string" }, turnId: { type: "string" }, willRetry: { type: "boolean" } },
  };
  if (variant === "compatible-docs") {
    documents["DynamicToolCallParams.json"] = {
      description: "The prose and object key order changed.",
      properties: documents["DynamicToolCallParams.json"].properties,
      required: ["turnId", "tool", "threadId", "callId", "arguments"],
      type: "object",
    };
  }
  return documents;
}
