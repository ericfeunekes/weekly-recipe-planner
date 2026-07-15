const objectSchema = () => ({ type: "object", properties: {} });

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
  "v2/ThreadStartParams.json",
  "v2/ThreadStartResponse.json",
  "v2/ThreadUnsubscribeParams.json",
  "v2/ThreadUnsubscribeResponse.json",
  "v2/TurnStartParams.json",
  "v2/TurnStartResponse.json",
  "v2/TurnInterruptParams.json",
  "v2/TurnInterruptResponse.json",
  "DynamicToolCallParams.json",
  "DynamicToolCallResponse.json",
  "v2/ItemCompletedNotification.json",
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
    oneOf: [
      ["account/login/completed", "AccountLoginCompletedNotification"],
      ["remoteControl/status/changed", "RemoteControlStatusChangedNotification"],
    ].map(([method, definition]) => ({
      type: "object",
      required: ["method", "params"],
      properties: {
        method: { type: "string", enum: [method] },
        params: { $ref: `#/definitions/${definition}` },
      },
    })),
    definitions: {
      AccountLoginCompletedNotification: { type: "object" },
      RemoteControlStatusChangedNotification: { type: "object" },
    },
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
  documents["v2/TurnStartParams.json"] = {
    type: "object",
    required: variant === "incompatible-required" ? ["input"] : ["input", "threadId"],
    properties: {
      input: { type: "array" },
      threadId: { type: "string" },
      cwd: { type: ["string", "null"] },
      environments: { type: ["array", "null"] },
      permissions: { type: ["string", "null"] },
    },
  };
  documents["v2/TurnStartResponse.json"] = {
    type: "object",
    required: ["turn"],
    properties: { turn: { type: "object" } },
  };
  documents["v2/TurnInterruptParams.json"] = {
    type: "object",
    required: ["threadId", "turnId"],
    properties: { threadId: { type: "string" }, turnId: { type: "string" } },
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
  documents["v2/ItemCompletedNotification.json"] = {
    type: "object",
    required: ["completedAtMs", "item", "threadId", "turnId"],
    properties: { completedAtMs: { type: "integer" }, item: {}, threadId: { type: "string" }, turnId: { type: "string" } },
  };
  documents["v2/TurnCompletedNotification.json"] = {
    type: "object",
    required: ["threadId", "turn"],
    properties: { threadId: { type: "string" }, turn: {} },
  };
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
