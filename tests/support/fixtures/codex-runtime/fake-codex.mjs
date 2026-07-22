#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import {
  acceptsOnlyLegacySimplifiedPlannerNamespace,
  createCodexSchemaDocuments,
  projectDynamicToolSpecsForProvider,
} from "./schema-fixtures.mjs";
import {
  createGeneratedCodexAuthSchemaDocuments,
} from "./auth-schema-fixtures.mjs";

const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME;
const bakedFixtureVariant = "compatible-a";
const bakedInvocationLog = typeof __RELEASE_PROBE_INVOCATION_LOG__ === "string"
  ? __RELEASE_PROBE_INVOCATION_LOG__
  : null;

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function variant() {
  if (codexHome) {
    try {
      return (await readFile(join(codexHome, ".fixture-variant"), "utf8")).trim() || bakedFixtureVariant;
    } catch {
      // Capability probes use a disposable CODEX_HOME that intentionally omits
      // fixture-only control files. Fall through to executable-local state.
    }
  }
  try {
    return (await readFile(join(dirname(process.argv[1]), ".fixture-variant-global"), "utf8")).trim() || bakedFixtureVariant;
  } catch {
    // Verified execution snapshots copy only the executable. Baking the
    // scenario into those bytes keeps negative fixtures intact without adding
    // a production environment or adjacent-file bypass.
    return bakedFixtureVariant;
  }
}

async function recordInvocation(event = "process-start", details = {}) {
  if (!codexHome) return;
  try {
    const executable = await stat(process.argv[1]);
    await appendFile(bakedInvocationLog ?? join(codexHome, ".fixture-invocations.jsonl"), `${JSON.stringify({
      event,
      bakedFixtureVariant,
      pid: process.pid,
      args,
      cwd: process.cwd(),
      executablePath: process.argv[1],
      executableMode: executable.mode & 0o777,
      executableUid: executable.uid,
      environmentKeys: Object.keys(process.env).sort(),
      ...details,
    })}\n`);
  } catch {
    // A fixture record must never affect the behavior under test.
  }
}

await recordInvocation();
const fixtureVariant = await variant();
let initializedClientName = null;

if (fixtureVariant === "early-exit") process.exit(23);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write(`fake-codex ${fixtureVariant}\n`);
  process.exit(0);
}

if (args[0] === "app-server" && args[1] === "generate-json-schema") {
  const outputIndex = args.indexOf("--out");
  if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(64);
  const outputDirectory = args[outputIndex + 1];
  const protocolDocuments = createCodexSchemaDocuments(fixtureVariant);
  const authDocuments = createGeneratedCodexAuthSchemaDocuments();
  authDocuments["v1/InitializeParams.json"].description =
    protocolDocuments["v1/InitializeParams.json"].description;
  const protocolNotifications = protocolDocuments["ServerNotification.json"];
  const authNotifications = authDocuments["ServerNotification.json"];
  const protocolMethods = new Set(protocolNotifications.oneOf.map(
    (entry) => entry.properties.method.enum[0],
  ));
  const documents = {
    ...protocolDocuments,
    ...authDocuments,
    "ServerNotification.json": {
      ...protocolNotifications,
      oneOf: [
        ...protocolNotifications.oneOf,
        ...authNotifications.oneOf.filter(
          (entry) => !protocolMethods.has(entry.properties.method.enum[0]),
        ),
      ],
      definitions: {
        ...protocolNotifications.definitions,
        ...authNotifications.definitions,
      },
    },
  };
  for (const file of Object.keys(documents).sort()) {
    const path = join(outputDirectory, file);
    await mkdir(dirname(path), { recursive: true });
    const body = fixtureVariant === "malformed-schema" && file === "v2/TurnStartParams.json"
      ? "{not-json"
      : fixtureVariant === "oversize-schema" && file === "v2/TurnStartParams.json"
        ? "x".repeat((2 * 1024 * 1024) + 1)
        : `${JSON.stringify(documents[file], null, 2)}\n`;
    await writeFile(path, body);
  }
  process.exit(0);
}

if (args[0] !== "app-server" || args[1] !== "--listen" || args[2] !== "stdio://") {
  process.stderr.write(`unsupported fake Codex args: ${JSON.stringify(args)}\n`);
  process.exit(64);
}

const threads = new Map();
const pendingServerRequests = new Map();
const pendingLogins = new Set();
let nextThread = 1;
let nextTurn = 1;
let nextLogin = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function completeLogin(loginId) {
  if (!pendingLogins.delete(loginId)) return;
  await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  send({
    method: "account/login/completed",
    params: { loginId, success: true, error: null },
  });
}

async function providerUrl() {
  const config = await readFile(join(codexHome, "config.toml"), "utf8");
  const match = config.match(/^base_url\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? null;
}

function toolsFor(thread) {
  const updatePlan = fixtureVariant === "name-only-update-plan"
    ? { name: "update_plan" }
    : fixtureVariant === "other-function-tool"
      ? { type: "function", name: "calendar", strict: false, parameters: closedParameters() }
      : { type: "function", name: "update_plan", strict: false, parameters: closedParameters() };
  const functionTool = (name) => ({
    type: "function",
    name,
    strict: false,
    parameters: closedParameters(),
  });
  const skillsNamespace = {
    type: "namespace",
    name: "skills",
    description: "Tools in the skills namespace.",
    tools: [functionTool("list"), functionTool("read")],
  };
  const projected = projectDynamicToolSpecsForProvider(thread.dynamicTools ?? []);
  const projectedPlanner = projected.find((tool) =>
    tool.type === "namespace" && tool.name === "planner");
  const plannerNamespace = projectedPlanner ? structuredClone(projectedPlanner) : null;
  if (plannerNamespace && fixtureVariant === "wrong-planner-members") {
    plannerNamespace.tools.push({ type: "function", name: "shell" });
  }
  if (plannerNamespace && fixtureVariant === "malformed-planner-member") {
    delete plannerNamespace.tools.find((tool) => tool.name === "read").type;
  }
  if (plannerNamespace && fixtureVariant === "stripped-planner-schemas") {
    for (const tool of plannerNamespace.tools) {
      if (tool.name === "preview" || tool.name === "apply") delete tool.parameters;
    }
  }
  if (plannerNamespace && fixtureVariant === "broadened-planner-schemas") {
    for (const tool of plannerNamespace.tools) {
      if (tool.name === "preview" || tool.name === "apply") {
        tool.parameters.additionalProperties = true;
      }
    }
  }
  if (plannerNamespace && fixtureVariant === "stripped-planner-command-union") {
    for (const tool of plannerNamespace.tools) {
      if (tool.name !== "preview" && tool.name !== "apply") continue;
      const commandType = tool.parameters?.properties?.operations?.items?.properties
        ?.command?.properties?.type;
      if (!Array.isArray(commandType?.enum)) {
        throw new Error("compatible provider fixture omitted the planner command union");
      }
      tool.parameters.properties.operations.items.properties.command.properties.type = {};
    }
  }
  const tools = [
    updatePlan,
    functionTool("request_user_input"),
    functionTool("spawn_agent"),
    functionTool("send_message"),
    functionTool("followup_task"),
    functionTool("wait_agent"),
    functionTool("interrupt_agent"),
    functionTool("list_agents"),
    skillsNamespace,
    ...(plannerNamespace ? [plannerNamespace] : []),
    {
      type: "web_search",
      external_web_access: true,
      ...(fixtureVariant === "wrong-web-flags"
        ? { index_gated_web_access: true }
        : {}),
    },
    ...(fixtureVariant === "extra-tool" ? [{ type: "shell" }] : []),
  ];
  if (fixtureVariant === "stripped-worker-capability" && thread.kind === "worker") {
    return tools.filter((tool) => tool.name !== "skills");
  }
  return tools;
}

function closedParameters() {
  return { type: "object", properties: {}, additionalProperties: false };
}

async function postProvider(thread, input) {
  const baseUrl = await providerUrl();
  if (!baseUrl) throw new Error("fake provider URL is missing");
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "planner-capability-probe",
      input,
      tools: toolsFor(thread),
      parallel_tool_calls: fixtureVariant === "parallel-tools",
      stream: true,
    }),
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`fake provider returned ${response.status}`);
}

async function violateProviderThenStall(thread, input) {
  const baseUrl = await providerUrl();
  if (!baseUrl) throw new Error("fake provider URL is missing");
  const response = await fetch(`${baseUrl}/unexpected-route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "planner-capability-probe",
      input,
      tools: toolsFor(thread),
      parallel_tool_calls: false,
      stream: true,
    }),
  });
  await response.arrayBuffer();
  await new Promise(() => undefined);
}

function waitForServerResponse(id) {
  return new Promise((resolve, reject) => pendingServerRequests.set(id, { resolve, reject }));
}

function sendTurnCompleted(thread, turnId) {
  send({
    method: "turn/completed",
    params: {
      threadId: fixtureVariant === "wrong-terminal-thread" ? "thread-wrong" : thread.id,
      turn: {
        id: turnId,
        items: [],
        status: fixtureVariant === "failed-terminal-status" ? "failed" : "completed",
      },
    },
  });
}

async function runNativeThread(thread, turnId, text) {
  if (fixtureVariant === "provider-violation-then-stall") {
    await violateProviderThenStall(thread, [
      { type: "message", role: "user", content: text },
    ]);
    return;
  }
  await postProvider(thread, [{ type: "message", role: "user", content: text }]);
  const worker = {
    id: `thread-${nextThread++}`,
    kind: "worker",
    parentThreadId: fixtureVariant === "worker-wrong-parent"
      ? "thread-wrong-parent"
      : thread.id,
    cwd: process.cwd(),
    dynamicTools: fixtureVariant === "worker-planner-namespace"
      ? structuredClone(thread.dynamicTools ?? [])
      : [],
  };
  threads.set(worker.id, worker);
  send({
    method: "item/completed",
    params: {
      threadId: thread.id,
      turnId,
      item: {
        type: "subAgentActivity",
        id: "root-spawn",
        kind: "started",
        agentThreadId: worker.id,
        agentPath: "/root/capability_worker",
      },
      completedAtMs: 0,
    },
  });
  if (fixtureVariant !== "missing-worker-provider-call") {
    await postProvider(worker, [{
      type: "message",
      role: "user",
      content: "WORKER_CONTEXT_PROBE: finish without calling tools",
    }]);
  }
  const rootSpawnHistory = [
    { type: "message", role: "user", content: text },
    {
      type: "function_call",
      name: "spawn_agent",
      call_id: "root-spawn",
      arguments: JSON.stringify({
        task_name: "capability_worker",
        message: "WORKER_CONTEXT_PROBE: finish without calling tools",
        fork_turns: "none",
      }),
    },
    {
      type: "function_call_output",
      call_id: "root-spawn",
      output: JSON.stringify({ task_name: "/root/capability_worker" }),
    },
  ];
  await postProvider(thread, rootSpawnHistory);
  const rootWaitHistory = [
    ...rootSpawnHistory,
    {
      type: "function_call",
      name: "wait_agent",
      call_id: "root-wait",
      arguments: JSON.stringify(fixtureVariant === "worker-wait-call-not-returned"
        ? { timeout_ms: 9_999 }
        : {}),
    },
    {
      type: "function_call_output",
      call_id: "root-wait",
      output: JSON.stringify(fixtureVariant === "worker-wait-result-not-returned"
        ? { message: "Wait timed out.", timed_out: true }
        : { message: "Wait completed.", timed_out: false }),
    },
    {
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: fixtureVariant === "worker-report-not-returned"
          ? "FINAL_ANSWER worker-report-missing"
          : "FINAL_ANSWER worker-research-report-complete",
      }],
    },
  ];
  await postProvider(thread, rootWaitHistory);
  const inputRequestId = `server-${turnId}-input`;
  send({
    id: inputRequestId,
    method: "item/tool/requestUserInput",
    params: {
      threadId: thread.id,
      turnId,
      itemId: "item-capability-input",
      questions: [{
        header: "Probe",
        id: "question-capability",
        question: "Continue the compatibility probe?",
        options: [{
          label: "Continue",
          description: "Continue the deterministic probe.",
        }],
      }],
    },
  });
  const inputResult = await waitForServerResponse(inputRequestId);
  await postProvider(thread, [
    ...rootWaitHistory,
    { type: "function_call_output", call_id: "root-input", output: inputResult },
  ]);
  if (fixtureVariant === "unexpected-approval-request") {
    const approvalRequestId = `server-${turnId}-approval`;
    send({
      id: approvalRequestId,
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "approval-capability",
        startedAtMs: 0,
        threadId: thread.id,
        turnId,
      },
    });
    const approvalResult = await waitForServerResponse(approvalRequestId);
    if (JSON.stringify(approvalResult) !== JSON.stringify({ decision: "decline" })) {
      throw new Error("capability host did not return the exact command-approval decline");
    }
  }
  const readRequestId = `server-${turnId}-read`;
  send({
    id: readRequestId,
    method: "item/tool/call",
    params: {
      arguments: { query: { kind: "workspace" } },
      callId: "call-read",
      namespace: "planner",
      threadId: thread.id,
      tool: "read",
      turnId,
    },
  });
  const readResult = await waitForServerResponse(readRequestId);
  await postProvider(thread, [
    ...rootWaitHistory,
    { type: "function_call_output", call_id: "root-input", output: inputResult },
    { type: "function_call_output", call_id: "call-read", output: readResult },
  ]);
  const operation = {
    command: {
      type: "captureWeekLesson",
      weekId: "2000-01-03",
      weekLesson: "Compatibility probe",
    },
  };
  const callARequestId = `server-${turnId}-A`;
  send({
    id: callARequestId,
    method: "item/tool/call",
    params: {
      arguments: { basePlannerVersion: 0, operations: [operation] },
      callId: "call-A",
      namespace: "planner",
      threadId: thread.id,
      tool: "preview",
      turnId,
    },
  });
  const resultA = await waitForServerResponse(callARequestId);
  await postProvider(thread, [
    ...rootWaitHistory,
    { type: "function_call_output", call_id: "root-input", output: inputResult },
    { type: "function_call_output", call_id: "call-read", output: readResult },
    { type: "function_call_output", call_id: "call-A", output: resultA },
  ]);
  const callBRequestId = `server-${turnId}-B`;
  send({
    id: callBRequestId,
    method: "item/tool/call",
    params: {
      arguments: {
        basePlannerVersion: 0,
        operations: [operation],
        readback: { kind: "workspace" },
      },
      callId: "call-B",
      namespace: "planner",
      threadId: thread.id,
      tool: "apply",
      turnId,
    },
  });
  const resultB = await waitForServerResponse(callBRequestId);
  await postProvider(thread, [
    ...rootWaitHistory,
    { type: "function_call_output", call_id: "root-input", output: inputResult },
    { type: "function_call_output", call_id: "call-read", output: readResult },
    { type: "function_call_output", call_id: "call-A", output: resultA },
    { type: "function_call_output", call_id: "call-B", output: resultB },
  ]);
  if (fixtureVariant === "extra-provider-call") {
    await postProvider(thread, [{ type: "message", role: "user", content: "UNCLASSIFIED_PROVIDER_CALL" }]);
  }
  sendTurnCompleted(thread, turnId);
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    initializedClientName = params.clientInfo?.name ?? null;
    if (params.clientInfo?.name === "weekly-recipe-planner-auth-operator") {
      await recordInvocation("auth-initialize", { authOperator: true });
    }
    send({ id, result: { codexHome, userAgent: "fake-codex" } });
    if (fixtureVariant === "rpc-unknown-notification") {
      send({ method: "hostile/unknown", params: {} });
    }
    if (
      fixtureVariant === "auth-unexpected-notification" &&
      params.clientInfo?.name === "weekly-recipe-planner-auth-operator"
    ) {
      send({ method: "hostile/unknown", params: {} });
    }
    if (fixtureVariant === "rpc-unknown-response-id") {
      send({ id: 999_999, result: {} });
    }
    if (fixtureVariant === "rpc-null-method") {
      send({ id: 999_999, method: null, result: {} });
    }
    if (fixtureVariant === "rpc-malformed-request-id") {
      send({ id: {}, method: "item/tool/call", params: {} });
    }
    if (fixtureVariant === "rpc-error-notification") {
      send({ method: "error", params: { error: { message: "fixture failure" } } });
    }
    if (fixtureVariant === "rpc-oversized-frame") {
      process.stdout.write("x".repeat((4 * 1024 * 1024) + 1));
    }
    if (fixtureVariant === "rpc-frame-flood") {
      for (let index = 0; index < 2050; index += 1) {
        send({ method: "warning", params: { message: `warning-${index}` } });
      }
    }
    if (fixtureVariant === "rpc-queue-flood") {
      for (let index = 0; index < 257; index += 1) {
        send({ method: "item/completed", params: { item: { id: `item-${index}` } } });
      }
    }
    return;
  }
  if (method === "account/read") {
    await recordInvocation("auth-account-read", {
      authOperator: initializedClientName === "weekly-recipe-planner-auth-operator",
      refreshToken: params.refreshToken === true,
    });
    const authenticated = await fileExists(join(codexHome, "auth.json"));
    if (fixtureVariant === "malformed-account-readback") {
      return send({ id, result: { account: null, requiresOpenaiAuth: "yes" } });
    }
    send({ id, result: {
      ...(fixtureVariant === "missing-account-field" ? {} : { account: authenticated
        ? { type: fixtureVariant === "auth-api-key" ? "apiKey" : "chatgpt", email: null, planType: "unknown" }
        : null }),
      requiresOpenaiAuth: true,
    } });
    if (
      fixtureVariant === "auth-late-notification" &&
      initializedClientName === "weekly-recipe-planner-auth-operator"
    ) {
      setTimeout(() => send({ method: "hostile/late", params: {} }), 5);
    }
    return;
  }
  if (method === "account/logout") {
    await recordInvocation("auth-account-logout");
    pendingLogins.clear();
    await rm(join(codexHome, "auth.json"), { force: true });
    return send({ id, result: {} });
  }
  if (method === "account/login/start") {
    await recordInvocation("auth-account-login-start");
    const loginId = `fixture-login-${nextLogin++}`;
    pendingLogins.add(loginId);
    send({ id, result: {
      type: "chatgptDeviceCode",
      loginId,
      verificationUrl: "https://device.example.test/fixture",
      userCode: `FIXTURE-${loginId}`,
    } });
    setTimeout(() => {
      completeLogin(loginId).catch((error) => send({
        method: "account/login/completed",
        params: { loginId, success: false, error: error.message },
      }));
    }, 5).unref?.();
    return;
  }
  if (method === "account/login/cancel") {
    await recordInvocation("auth-account-login-cancel");
    const matched = pendingLogins.delete(params.loginId);
    return send({ id, result: { status: matched ? "canceled" : "notFound" } });
  }
  if (method === "config/read") {
    const absentSystemConfig = join(dirname(codexHome), "absent-system-config.toml");
    const systemFile = fixtureVariant === "system-file-wrong-shape"
      ? {}
      : fixtureVariant === "system-file-relative"
        ? "etc/codex/config.toml"
        : fixtureVariant === "system-file-existing"
          ? join(codexHome, "AGENTS.md")
          : absentSystemConfig;
    return send({ id, result: {
      ...(fixtureVariant === "config-missing-config"
        ? {}
        : { config: fixtureVariant === "config-wrong-shape" ? [] : {
            forced_login_method: fixtureVariant === "wrong-effective-login-policy"
              ? "api"
              : "chatgpt",
          } }),
      ...(fixtureVariant === "config-missing-origins"
        ? {}
        : { origins: fixtureVariant === "origins-wrong-shape" ? [] : {} }),
      layers: [{
        config: {
          forced_login_method: fixtureVariant === "wrong-user-login-policy" ? "api" : "chatgpt",
          cli_auth_credentials_store: fixtureVariant === "wrong-credential-store" ? "keyring" : "file",
        },
        name: fixtureVariant === "unknown-config-layer"
          ? { type: "project", file: join(codexHome, "config.toml"), profile: null }
          : {
              type: "user",
              file: fixtureVariant === "wrong-user-config-path"
                ? join(codexHome, "AGENTS.md")
                : join(codexHome, "config.toml"),
              profile: null,
            },
        version: "1",
      }, ...(fixtureVariant === "missing-system-layer" ? [] : [{
        config: fixtureVariant === "system-config-active" ? { model: "inherited" } : {},
        name: { type: "system", file: systemFile },
        version: "1",
      }]), ...(fixtureVariant === "duplicate-system-layer"
        ? [{ config: {}, name: { type: "system", file: absentSystemConfig }, version: "1" }]
        : [])],
    } });
  }
  if (method === "skills/list") return send({ id, result: { data: [{
    cwd: params.cwds?.[0] ?? process.cwd(),
    errors: fixtureVariant === "skill-loader-error"
      ? [{ path: join(codexHome, "bad"), message: "bad skill" }]
      : [],
    skills: fixtureVariant === "repo-skill-readback"
      ? [{
          name: "release-fixture-skill",
          path: join(params.cwds?.[0] ?? process.cwd(), ".agents", "skills", "release-fixture-skill", "SKILL.md"),
          scope: "repo",
          enabled: true,
        }]
      : fixtureVariant === "user-skill-readback"
        ? [{
            name: "fixture-skill",
            path: join(process.env.HOME, ".agents", "skills", "fixture-skill", "SKILL.md"),
            scope: "user",
            enabled: true,
          }]
        : fixtureVariant === "noncanonical-skill-path"
          ? [{
              name: "fixture-skill",
              path: `${join(process.env.HOME, ".agents", "skills", "fixture-skill")}/../fixture-skill/SKILL.md`,
              scope: "user",
            enabled: true,
          }]
        : fixtureVariant === "skill-directory-readback"
          ? [{
              name: "fixture-skill",
              path: join(process.env.HOME, ".agents", "skills", "fixture-skill"),
              scope: "user",
              enabled: true,
            }]
        : [],
  }] } });
  if (method === "permissionProfile/list") {
    if (fixtureVariant === "rpc-malformed-error-envelope") return send({ id, error: null });
    if (fixtureVariant === "malformed-permission-readback") return send({ id, result: {} });
    return send({ id, result: {
      data: [
      ...(fixtureVariant === "missing-read-only-profile" ? [] : [{
        id: ":read-only",
        description: null,
        allowed: fixtureVariant !== "disallowed-read-only-profile",
      }]),
      { id: ":workspace", description: null, allowed: true },
      { id: ":danger-full-access", description: null, allowed: true },
      ],
      nextCursor: null,
    } });
  }
  if (method === "mcpServerStatus/list") {
    if (fixtureVariant === "malformed-mcp-readback") return send({ id, result: {} });
    if (fixtureVariant === "pagination-malformed-cursor") {
      return send({ id, result: { data: [], nextCursor: {} } });
    }
    if (fixtureVariant === "pagination-empty-cursor") {
      return send({ id, result: { data: [], nextCursor: "" } });
    }
    if (fixtureVariant === "pagination-repeated-cursor") {
      return send({ id, result: { data: [], nextCursor: "repeat" } });
    }
    if (fixtureVariant === "pagination-too-many-pages") {
      const page = params.cursor === null ? 0 : Number(String(params.cursor).replace("page-", ""));
      return send({ id, result: { data: [], nextCursor: `page-${page + 1}` } });
    }
    if (fixtureVariant === "pagination-too-many-rows") {
      return send({ id, result: {
        data: Array.from({ length: 1025 }, (_, index) => ({ name: `server-${index}` })),
        nextCursor: null,
      } });
    }
    if (fixtureVariant === "paginated-hidden-mcp") {
      return send({ id, result: params.cursor === "more"
        ? { data: [{ name: "hidden-server" }], nextCursor: null }
        : { data: [], nextCursor: "more" } });
    }
    return send({ id, result: { data: [], nextCursor: null } });
  }
  if (method === "app/list") {
    if (fixtureVariant === "malformed-app-readback") return send({ id, result: {} });
    return send({ id, result: {
      data: fixtureVariant === "app-surface"
        ? [{ name: "unexpected-app", isEnabled: true, isAccessible: true }]
        : [],
      nextCursor: null,
    } });
  }
  if (method === "plugin/list") {
    if (fixtureVariant === "malformed-plugin-readback") return send({ id, result: {} });
    return send({ id, result: {
    marketplaces: fixtureVariant === "plugin-surface" ? [{ name: "unexpected" }] : [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
    } });
  }
  if (method === "thread/list") {
    await recordInvocation("thread-list");
    return send({ id, result: { data: [], nextCursor: null } });
  }
  if (method === "thread/start") {
    if (
      params.approvalPolicy !== "never" ||
      params.permissions !== ":read-only" ||
      Object.hasOwn(params, "sandbox")
    ) {
      return send({ id, error: { code: -32602, message: "unsafe permission contract" } });
    }
    if (
      fixtureVariant === "legacy-simplified-planner-schema-only" &&
      Array.isArray(params.dynamicTools) &&
      params.dynamicTools.length > 0 &&
      !acceptsOnlyLegacySimplifiedPlannerNamespace(params.dynamicTools)
    ) {
      return send({
        id,
        error: {
          code: -32602,
          message: "fixture accepts only the legacy simplified planner schema",
        },
      });
    }
    const threadId = `thread-${nextThread++}`;
    const kind = Array.isArray(params.dynamicTools) && params.dynamicTools.length
      ? "native"
      : "readback";
    const thread = { id: threadId, kind, dynamicTools: structuredClone(params.dynamicTools ?? []) };
    threads.set(threadId, thread);
    const instructionSources = await fileExists(join(codexHome, "AGENTS.md"))
      ? [join(codexHome, "AGENTS.md")]
      : [];
    if (fixtureVariant === "extra-instruction-source") {
      instructionSources.push(join(codexHome, "config.toml"));
    }
    return send({ id, result: {
      approvalPolicy: fixtureVariant === "wrong-thread-policy" ? "on-request" : "never",
      activePermissionProfile: fixtureVariant === "wrong-thread-policy"
        ? { id: ":workspace", extends: null }
        : { id: ":read-only", extends: null },
      approvalsReviewer: "user",
      cwd: params.cwd ?? process.cwd(),
      instructionSources,
      model: "fake",
      modelProvider: "fake",
      runtimeWorkspaceRoots: [],
      sandbox: fixtureVariant === "wrong-thread-policy"
        ? { type: "workspaceWrite", networkAccess: true }
        : { type: "readOnly", networkAccess: false },
      thread: { id: threadId },
    } });
  }
  if (method === "thread/read") {
    const thread = threads.get(params.threadId);
    if (!thread) return send({ id, error: { code: -32602, message: "unknown thread" } });
    return send({ id, result: {
      thread: {
        id: thread.id,
        parentThreadId: thread.parentThreadId ?? null,
        cwd: thread.cwd ?? process.cwd(),
      },
    } });
  }
  if (method === "turn/start") {
    if (fixtureVariant === "capability-hang") return;
    const thread = threads.get(params.threadId);
    if (!thread) return send({ id, error: { code: -32602, message: "unknown thread" } });
    const turnId = `turn-${nextTurn++}`;
    send({ id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
    const text = params.input?.[0]?.text ?? "";
    const operation = thread.kind === "native"
      ? runNativeThread(thread, turnId, text)
      : Promise.resolve().then(() => sendTurnCompleted(thread, turnId));
    operation.catch((error) => send({
      method: "error",
      params: { error: { message: error.message }, threadId: thread.id, turnId, willRetry: false },
    }));
    return;
  }
  if (method === "thread/unsubscribe" || method === "turn/interrupt") return send({ id, result: {} });
  send({ id, error: { code: -32601, message: `unsupported method ${method}` } });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("close", () => {
  if (
    fixtureVariant !== "shutdown-late-notification" &&
    fixtureVariant !== "shutdown-late-server-request"
  ) return;
  const lateMessage = fixtureVariant === "shutdown-late-server-request"
    ? { id: "late-request", method: "item/tool/call", params: {} }
    : { method: "hostile/late", params: {} };
  const child = spawn(process.execPath, [
    "-e",
    `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(lateMessage))} + '\\n'), 100)`,
  ], { stdio: ["ignore", "inherit", "ignore"] });
  child.unref();
});
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 65;
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const pending = pendingServerRequests.get(message.id);
    if (pending) {
      pendingServerRequests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
    return;
  }
  if (message.method === "initialized") return;
  handleRequest(message).catch((error) => send({ id: message.id, error: { code: -32000, message: error.message } }));
});
