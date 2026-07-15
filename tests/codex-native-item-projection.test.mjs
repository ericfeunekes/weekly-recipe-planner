import assert from "node:assert/strict";
import test from "node:test";

import {
  getCodexToolActivityLabel,
  projectCodexThread,
  projectCodexThreadItem,
  projectCodexThreadStatus,
} from "../server/codex/activity-projection.ts";

test("thread projection exposes native conversation state without runtime paths or metadata", () => {
  const projected = projectCodexThread({
    id: "thread-1",
    name: "Friday dinner",
    preview: "Help plan Friday dinner",
    cwd: "/private/canary-cwd",
    path: "/private/canary-rollout.jsonl",
    cliVersion: "canary-version",
    sessionId: "canary-session",
    modelProvider: "canary-provider",
    createdAt: 10,
    updatedAt: 20,
    recencyAt: 21,
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
    turns: [{
      id: "turn-1",
      status: "inProgress",
      itemsView: "full",
      startedAt: 22,
      items: [],
    }],
  });

  assert.deepEqual(projected, {
    id: "thread-1",
    title: "Friday dinner",
    preview: "Help plan Friday dinner",
    status: { state: "active", waitingFor: "approval" },
    createdAtMs: 10_000,
    updatedAtMs: 20_000,
    recencyAtMs: 21_000,
    threadKind: "conversation",
    parentThreadId: null,
    turns: [{
      id: "turn-1",
      status: "in_progress",
      itemsView: "full",
      startedAtMs: 22_000,
      completedAtMs: null,
      durationMs: null,
      errorMessage: null,
      items: [],
    }],
    workers: [],
    historyTruncated: false,
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("canary-cwd"), false);
  assert.equal(serialized.includes("canary-rollout"), false);
  assert.equal(serialized.includes("canary-version"), false);
  assert.equal(serialized.includes("canary-session"), false);
  assert.equal(serialized.includes("canary-provider"), false);
});

test("message projection retains text and skill identity but removes local and image paths", () => {
  const projected = projectCodexThreadItem({
    id: "message-1",
    type: "userMessage",
    clientId: "client-message-1",
    content: [
      { type: "text", text: "Use my meal-planning skill." },
      { type: "skill", name: "weekly-planning", path: "/secret/skill/path" },
      { type: "mention", name: "family", path: "/secret/mention/path" },
      { type: "localImage", path: "/secret/image.png" },
      { type: "image", url: "data:image/png;base64,SECRET_IMAGE_BYTES" },
    ],
  });

  assert.deepEqual(projected, {
    kind: "message",
    id: "message-1",
    role: "user",
    phase: null,
    text: "Use my meal-planning skill.",
    clientUserMessageId: "client-message-1",
    attachments: [
      { kind: "skill", label: "weekly-planning" },
      { kind: "mention", label: "family" },
      { kind: "image", label: "Image" },
      { kind: "image", label: "Image" },
    ],
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("/secret/"), false);
  assert.equal(serialized.includes("SECRET_IMAGE_BYTES"), false);
});

test("reasoning projection exposes summaries and never raw reasoning content", () => {
  const projected = projectCodexThreadItem({
    id: "reasoning-1",
    type: "reasoning",
    summary: ["Checking the meal plan", "Comparing two options"],
    content: ["CANARY_PRIVATE_REASONING", "CANARY_RAW_DELTA"],
  });
  assert.deepEqual(projected, {
    kind: "reasoning",
    id: "reasoning-1",
    label: "Thinking",
    summaries: ["Checking the meal plan", "Comparing two options"],
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("CANARY_PRIVATE_REASONING"), false);
  assert.equal(serialized.includes("CANARY_RAW_DELTA"), false);
});

test("planner, web, plan, and worker activities receive stable human-facing labels", () => {
  assert.equal(getCodexToolActivityLabel("planner", "read"), "Reading the planner");
  assert.equal(getCodexToolActivityLabel("planner", "preview"), "Checking planner changes");
  assert.equal(getCodexToolActivityLabel("planner", "apply"), "Updating the planner");
  assert.equal(getCodexToolActivityLabel("unknown", "unknown"), "Using an app tool");

  assert.deepEqual(projectCodexThreadItem({
    id: "tool-1",
    type: "dynamicToolCall",
    namespace: "planner",
    tool: "apply",
    status: "inProgress",
    arguments: { raw: "CANARY_TOOL_ARGUMENT" },
    contentItems: [{ text: "CANARY_TOOL_RESULT" }],
  }), {
    kind: "activity",
    id: "tool-1",
    category: "tool",
    label: "Updating the planner",
    detail: null,
    status: "running",
  });

  const webActivity = projectCodexThreadItem({
    id: "web-1",
    type: "webSearch",
    query: "CANARY_PRIVATE_WEB_SEARCH_QUERY",
    action: { type: "openPage", url: "https://canary-secret.example/private" },
  });
  assert.deepEqual(webActivity, {
    kind: "activity",
    id: "web-1",
    category: "web",
    label: "Opening a source",
    detail: null,
    status: "completed",
  });
  assert.equal(JSON.stringify(webActivity).includes("CANARY_PRIVATE_WEB_SEARCH_QUERY"), false);

  assert.deepEqual(projectCodexThreadItem({
    id: "plan-1",
    type: "plan",
    text: "1. Read the week\n2. Suggest dinner",
  }), {
    kind: "activity",
    id: "plan-1",
    category: "plan",
    label: "Making a plan",
    detail: "1. Read the week\n2. Suggest dinner",
    status: "completed",
  });

  assert.deepEqual(projectCodexThreadItem({
    id: "worker-1",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "inProgress",
    receiverThreadIds: ["worker-thread-1"],
    senderThreadId: "thread-1",
    prompt: "CANARY_WORKER_PROMPT",
    model: "CANARY_WORKER_MODEL",
    agentsStates: {
      "worker-thread-1": { status: "running", message: "CANARY_WORKER_MESSAGE" },
    },
  }), {
    kind: "worker",
    id: "worker-1",
    label: "Starting a background worker",
    operation: "start",
    workerThreadIds: ["worker-thread-1"],
    workerStates: [{ threadId: "worker-thread-1", status: "running" }],
    status: "running",
  });
});

test("collab worker projection keeps operation status separate from each receiver state", () => {
  const receiverThreadIds = [
    "worker-pending",
    "worker-running",
    "worker-interrupted",
    "worker-completed",
    "worker-errored",
    "worker-shutdown",
    "worker-not-found",
    "worker-missing-state",
  ];
  const projected = projectCodexThreadItem({
    id: "worker-wait-1",
    type: "collabAgentToolCall",
    tool: "wait",
    status: "completed",
    receiverThreadIds,
    senderThreadId: "thread-1",
    prompt: "CANARY_PRIVATE_WORKER_PROMPT /secret/prompt/path",
    agentsStates: {
      "worker-pending": { status: "pendingInit", message: "CANARY_PENDING_MESSAGE" },
      "worker-running": { status: "running", message: "CANARY_RUNNING_MESSAGE" },
      "worker-interrupted": { status: "interrupted", message: "CANARY_INTERRUPTED_MESSAGE" },
      "worker-completed": { status: "completed", message: "CANARY_COMPLETED_MESSAGE" },
      "worker-errored": { status: "errored", message: "CANARY_ERRORED_MESSAGE" },
      "worker-shutdown": { status: "shutdown", message: "CANARY_SHUTDOWN_MESSAGE" },
      "worker-not-found": { status: "notFound", message: "CANARY_NOT_FOUND_MESSAGE" },
      "/secret/unrelated-agent-path": {
        status: "completed",
        message: "CANARY_UNRELATED_MESSAGE",
      },
    },
  });

  assert.deepEqual(projected, {
    kind: "worker",
    id: "worker-wait-1",
    label: "Waiting for background workers",
    operation: "wait",
    workerThreadIds: receiverThreadIds,
    workerStates: [
      { threadId: "worker-pending", status: "pending" },
      { threadId: "worker-running", status: "running" },
      { threadId: "worker-interrupted", status: "interrupted" },
      { threadId: "worker-completed", status: "completed" },
      { threadId: "worker-errored", status: "failed" },
      { threadId: "worker-shutdown", status: "completed" },
      { threadId: "worker-not-found", status: "failed" },
      { threadId: "worker-missing-state", status: "unknown" },
    ],
    status: "completed",
  });

  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("CANARY_"), false);
  assert.equal(serialized.includes("/secret/"), false);
});

test("collab worker projection bounds receiver states to the public DTO limit", () => {
  const receiverThreadIds = Array.from({ length: 25 }, (_, index) => `worker-${index}`);
  const agentsStates = Object.fromEntries(receiverThreadIds.map((threadId) => [
    threadId,
    { status: "running", message: `CANARY_WORKER_MESSAGE_${threadId}` },
  ]));
  const projected = projectCodexThreadItem({
    id: "worker-bounded-1",
    type: "collabAgentToolCall",
    tool: "sendInput",
    status: "completed",
    receiverThreadIds,
    agentsStates,
  });

  assert.equal(projected.kind, "worker");
  assert.deepEqual(projected.workerThreadIds, receiverThreadIds.slice(0, 20));
  assert.deepEqual(
    projected.workerStates,
    receiverThreadIds.slice(0, 20).map((threadId) => ({ threadId, status: "running" })),
  );
  assert.equal(JSON.stringify(projected).includes("CANARY_WORKER_MESSAGE"), false);
});

test("forbidden and unknown native items become data-free bounded activities", () => {
  const variants = [
    {
      id: "command-1",
      type: "commandExecution",
      status: "completed",
      command: "CANARY_COMMAND",
      cwd: "/secret/command/cwd",
      aggregatedOutput: "CANARY_COMMAND_OUTPUT",
    },
    {
      id: "file-1",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "/secret/file", diff: "CANARY_DIFF" }],
    },
    {
      id: "mcp-1",
      type: "mcpToolCall",
      status: "completed",
      server: "CANARY_MCP_SERVER",
      tool: "CANARY_MCP_TOOL",
      arguments: { token: "CANARY_MCP_ARGUMENT" },
      result: { text: "CANARY_MCP_RESULT" },
    },
    { id: "image-1", type: "imageView", path: "/secret/image/path" },
    {
      id: "image-gen-1",
      type: "imageGeneration",
      status: "completed",
      result: "CANARY_IMAGE_RESULT",
      savedPath: "/secret/generated/image",
    },
    {
      id: "future-1",
      type: "futureProviderItem",
      rawDelta: "CANARY_FUTURE_DELTA",
      path: "/secret/future/path",
      arguments: { secret: "CANARY_FUTURE_ARGUMENT" },
    },
  ];

  const projected = variants.map((variant, index) => projectCodexThreadItem(variant, index));
  for (const item of projected.slice(0, 5)) {
    assert.equal(item.kind, "activity");
    assert.equal(item.category, "restricted");
    assert.equal(item.label, "Restricted activity");
    assert.equal(item.detail, null);
  }
  assert.deepEqual(projected.at(-1), {
    kind: "activity",
    id: "future-1",
    category: "other",
    label: "Working",
    detail: null,
    status: "unknown",
  });

  const serialized = JSON.stringify(projected);
  for (const canary of [
    "CANARY_COMMAND",
    "CANARY_COMMAND_OUTPUT",
    "CANARY_DIFF",
    "CANARY_MCP_SERVER",
    "CANARY_MCP_TOOL",
    "CANARY_MCP_ARGUMENT",
    "CANARY_MCP_RESULT",
    "CANARY_IMAGE_RESULT",
    "CANARY_FUTURE_DELTA",
    "CANARY_FUTURE_ARGUMENT",
    "/secret/",
  ]) {
    assert.equal(serialized.includes(canary), false, canary);
  }
});

test("thread projection summarizes worker ids without agent paths or prompts", () => {
  const projected = projectCodexThread({
    id: "thread-1",
    preview: "Coordinate helpers",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [{
      id: "turn-1",
      status: "completed",
      items: [{
        id: "subagent-1",
        type: "subAgentActivity",
        agentThreadId: "worker-thread-1",
        agentPath: "/root/secret-worker-path",
        kind: "started",
      }],
    }],
  });

  assert.deepEqual(projected?.workers, [{
    threadId: "worker-thread-1",
    label: "Background worker",
    status: "running",
  }]);
  assert.equal(JSON.stringify(projected).includes("secret-worker-path"), false);
});

test("thread worker summaries use receiver states instead of completed collab operations", () => {
  const projected = projectCodexThread({
    id: "thread-1",
    preview: "Coordinate helpers",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [{
      id: "turn-1",
      status: "completed",
      items: [{
        id: "wait-1",
        type: "collabAgentToolCall",
        tool: "wait",
        status: "completed",
        receiverThreadIds: ["worker-completed", "worker-errored", "worker-not-found"],
        senderThreadId: "thread-1",
        agentsStates: {
          "worker-completed": { status: "completed", message: "CANARY_COMPLETED_RESULT" },
          "worker-errored": { status: "errored", message: "CANARY_ERRORED_RESULT" },
          "worker-not-found": { status: "notFound", message: null },
        },
      }],
    }],
  });

  assert.deepEqual(projected?.workers, [
    { threadId: "worker-completed", label: "Background worker", status: "completed" },
    { threadId: "worker-errored", label: "Background worker", status: "failed" },
    { threadId: "worker-not-found", label: "Background worker", status: "failed" },
  ]);
  assert.equal(JSON.stringify(projected).includes("CANARY_"), false);
});

test("thread projection identifies a child as a read-only worker view", () => {
  const projected = projectCodexThread({
    id: "worker-thread-1",
    parentThreadId: "thread-1",
    preview: "Compare dinner recipes",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
    turns: [],
  });
  assert.equal(projected?.threadKind, "worker");
  assert.equal(projected?.parentThreadId, "thread-1");
});

test("thread status projection represents approval and user-input waits separately", () => {
  assert.deepEqual(projectCodexThreadStatus({
    type: "active",
    activeFlags: ["waitingOnApproval"],
  }), { state: "active", waitingFor: "approval" });
  assert.deepEqual(projectCodexThreadStatus({
    type: "active",
    activeFlags: ["waitingOnUserInput"],
  }), { state: "active", waitingFor: "user_input" });
});
