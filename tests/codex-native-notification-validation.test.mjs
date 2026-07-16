import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNativeCodexSession } from "../server/codex/native-session.ts";
import { CODEX_FOLLOW_UP_RPC_POLICY } from
  "../server/runtime/codex-follow-up/compatibility.ts";

const fixturePath = new URL(
  "./support/fixtures/codex-runtime/fake-native-app-server.mjs",
  import.meta.url,
);

async function createFixture(t, environment = {}, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "planner-native-notifications-")));
  const nativeStateFile = join(directory, "native-app-server-state.json");
  const dispatched = [];
  let epoch = 0;
  let spawnCount = 0;
  const session = createNativeCodexSession({
    fixedCwd: directory,
    execution: {
      async spawnAppServer() {
        const useEnvironment = !options.firstSpawnOnly || spawnCount === 0;
        spawnCount += 1;
        return spawn(process.execPath, [fixturePath.pathname], {
          cwd: directory,
          env: {
            ...process.env,
            FAKE_NATIVE_STATE_FILE: nativeStateFile,
            ...(useEnvironment ? environment : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    },
    createEpoch: () => `notification-epoch-${epoch += 1}`,
    requestTimeoutMs: 2_000,
    async dispatchPlannerTool(params) {
      dispatched.push(params);
      return { success: true, contentItems: [] };
    },
  });
  t.after(async () => {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, dispatched, session };
}

function emitNotification(session, notification, afterNotification = []) {
  return session.request("thread/list", {
    searchTerm: "__emit_notification__",
    fixtureNotification: notification,
    fixtureAfterNotification: afterNotification,
  });
}

const validItem = Object.freeze({
  id: "notification-item",
  type: "agentMessage",
  text: "A schema-valid item.",
  additiveItemField: { accepted: true },
});

const validNestedItems = Object.freeze([
  {
    id: "nested-user-message",
    type: "userMessage",
    clientId: "nested-client-message",
    content: [
      {
        type: "text",
        text: "Dinner",
        text_elements: [{ byteRange: { start: 0, end: 6 }, placeholder: null }],
      },
      { type: "image", url: "data:image/png;base64,AA==", detail: "low" },
      { type: "localImage", path: "/tmp/dinner.png", detail: null },
      { type: "skill", name: "recipes", path: "/tmp/recipes/SKILL.md" },
      { type: "mention", name: "pantry", path: "/tmp/pantry.md" },
    ],
  },
  {
    id: "nested-hook-prompt",
    type: "hookPrompt",
    fragments: [{ hookRunId: "hook-run", text: "Use the household plan." }],
  },
  { id: "nested-agent-message", type: "agentMessage", text: "Dinner is ready." },
  { id: "nested-plan", type: "plan", text: "1. Cook dinner." },
  { id: "nested-reasoning", type: "reasoning" },
  {
    id: "nested-command",
    type: "commandExecution",
    command: "pwd",
    commandActions: [
      { type: "read", command: "cat meal.md", name: "meal.md", path: "/tmp/meal.md" },
      { type: "listFiles", command: "ls", path: null },
      { type: "search", command: "rg dinner", path: "/tmp", query: "dinner" },
      { type: "unknown", command: "meal-command" },
    ],
    cwd: "/tmp",
    status: "completed",
  },
  {
    id: "nested-file-change",
    type: "fileChange",
    changes: [{ diff: "@@ dinner @@", kind: { type: "update", move_path: null }, path: "meal.md" }],
    status: "completed",
  },
  {
    id: "nested-mcp-call",
    type: "mcpToolCall",
    arguments: { dinner: true },
    server: "household",
    status: "completed",
    tool: "read",
  },
  {
    id: "nested-dynamic-call",
    type: "dynamicToolCall",
    arguments: { query: { kind: "workspace" } },
    status: "completed",
    tool: "read",
  },
  {
    id: "nested-collab-call",
    type: "collabAgentToolCall",
    agentsStates: { worker: { status: "running", message: null } },
    receiverThreadIds: ["worker-thread"],
    senderThreadId: "root-thread",
    status: "completed",
    tool: "spawnAgent",
  },
  {
    id: "nested-sub-agent",
    type: "subAgentActivity",
    agentPath: "/root/worker",
    agentThreadId: "worker-thread",
    kind: "started",
  },
  { id: "nested-web-search", type: "webSearch", query: "weeknight dinner" },
  { id: "nested-image-view", type: "imageView", path: "/tmp/dinner.png" },
  { id: "nested-sleep", type: "sleep", durationMs: 0 },
  {
    id: "nested-image-generation",
    type: "imageGeneration",
    result: "generated",
    status: "completed",
  },
  { id: "nested-entered-review", type: "enteredReviewMode", review: "Check dinner." },
  { id: "nested-exited-review", type: "exitedReviewMode", review: "Dinner checked." },
  { id: "nested-compaction", type: "contextCompaction" },
].map((item) => ({ ...item, additiveNestedItemField: true })));

const validTurn = Object.freeze({
  id: "notification-turn",
  items: [validItem],
  status: "inProgress",
  additiveTurnField: ["accepted"],
});

const validThread = Object.freeze({
  cliVersion: "0.142.5",
  createdAt: 1,
  cwd: "/tmp",
  ephemeral: false,
  id: "notification-thread",
  modelProvider: "openai",
  preview: "Schema-valid notification thread",
  sessionId: "notification-session",
  source: "appServer",
  status: { type: "idle", additiveStatusField: true },
  threadSource: "foreign-notification-test",
  turns: [],
  updatedAt: 2,
  additiveThreadField: "accepted",
});

const validNotifications = Object.freeze([
  ["thread/started", { thread: validThread }],
  ["thread/status/changed", { threadId: "foreign-thread", status: { type: "idle" } }],
  ["thread/archived", { threadId: "foreign-thread" }],
  ["thread/name/updated", { threadId: "foreign-thread", threadName: null }],
  ["turn/started", { threadId: "foreign-thread", turn: validTurn }],
  ["item/started", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    item: validItem,
    startedAtMs: 0,
  }],
  ["item/agentMessage/delta", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    itemId: "foreign-item",
    delta: "agent delta",
  }],
  ["item/plan/delta", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    itemId: "foreign-item",
    delta: "plan delta",
  }],
  ["item/reasoning/summaryPartAdded", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    itemId: "foreign-item",
    summaryIndex: 0,
  }],
  ["item/reasoning/summaryTextDelta", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    itemId: "foreign-item",
    summaryIndex: 0,
    delta: "reasoning delta",
  }],
  ["item/completed", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    item: validItem,
    completedAtMs: 1,
  }],
  ["serverRequest/resolved", { threadId: "foreign-thread", requestId: 7 }],
  ["turn/completed", {
    threadId: "foreign-thread",
    turn: { ...validTurn, status: "completed" },
  }],
  ["error", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    error: { message: "Provider error", additiveErrorField: "accepted" },
    willRetry: false,
  }],
].map(([method, params]) => [method, { ...params, additiveParamsField: { accepted: true } }]));

test("every compatibility-consumed native notification accepts its schema-valid additive form", async (t) => {
  assert.deepEqual(
    validNotifications.map(([method]) => method),
    [...CODEX_FOLLOW_UP_RPC_POLICY.consumedNotifications],
  );
  const { session } = await createFixture(t);
  const client = await session.ensureConnected();
  let expectedRevision = 0;

  for (const [method, params] of validNotifications) {
    await emitNotification(session, { method, params });
    if (method.startsWith("thread/") || method.startsWith("turn/") ||
        method.startsWith("item/")) {
      expectedRevision += 1;
    }
    assert.deepEqual(session.coordinates(), {
      connectionEpoch: "notification-epoch-1",
      activityRevision: expectedRevision,
    }, method);
    assert.equal(await session.ensureConnected(), client, method);
  }
  assert.equal(validNotifications.length, 14);
});

test("each consumed notification uses its method-owned turn identity", async (t) => {
  const { session } = await createFixture(t, { FAKE_NATIVE_ROOT_COUNT: "1" });
  await session.ensureConnected();
  const threadId = "native-thread-1";
  const nestedTurnId = "nested-turn";
  const additiveTurnId = "additive-turn";

  await emitNotification(session, {
    method: "turn/started",
    params: {
      threadId,
      turnId: additiveTurnId,
      turn: { ...validTurn, id: nestedTurnId, items: [] },
    },
  });
  assert.equal(session.isEligibleRootTurn(threadId, nestedTurnId), true);
  assert.equal(session.isEligibleRootTurn(threadId, additiveTurnId), false);

  const clientUserMessageId = "direct-item-client-id";
  const directItemTurnId = "direct-item-turn";
  await emitNotification(session, {
    method: "item/completed",
    params: {
      threadId,
      turnId: directItemTurnId,
      turn: { ...validTurn, id: additiveTurnId },
      item: {
        id: "completed-user-item",
        type: "userMessage",
        clientId: clientUserMessageId,
        content: [{ type: "text", text: "Dinner" }],
      },
      completedAtMs: 1,
    },
  });
  assert.equal(
    session.hasCompletedClientMessage(threadId, directItemTurnId, clientUserMessageId),
    true,
  );
  assert.throws(
    () => session.hasCompletedClientMessage(threadId, additiveTurnId, clientUserMessageId),
    (error) => error.code === "PROTOCOL_ERROR" && /unexpected turn/.test(error.message),
  );

  await emitNotification(session, {
    method: "turn/completed",
    params: {
      threadId,
      turnId: additiveTurnId,
      turn: { ...validTurn, id: nestedTurnId, items: [], status: "completed" },
    },
  });
  assert.equal(session.isEligibleRootTurn(threadId, nestedTurnId), false);
});

test("a foreign archive notification cannot create planner ownership", async (t) => {
  const { session } = await createFixture(t, { FAKE_NATIVE_ROOT_COUNT: "1" });
  await session.ensureConnected();
  assert.equal(session.isEligibleRoot("native-thread-1"), true);

  await emitNotification(session, {
    method: "thread/archived",
    params: { threadId: "foreign-thread" },
  });

  assert.equal(session.isKnownArchived("foreign-thread"), false);
  assert.equal(session.isEligibleThread("foreign-thread"), false);
  assert.equal(session.isEligibleRoot("native-thread-1"), true);
});

test("all current nested ThreadItem and SessionSource unions accept valid additive forms", async (t) => {
  const { session } = await createFixture(t);
  const client = await session.ensureConnected();

  for (const item of validNestedItems) {
    await emitNotification(session, {
      method: "item/started",
      params: {
        threadId: "foreign-thread",
        turnId: "foreign-turn",
        item,
        startedAtMs: 0,
      },
    });
    assert.equal(await session.ensureConnected(), client, item.type);
  }

  const sourceVariants = [
    { custom: "household", additiveSourceField: true },
    { subAgent: "review", additiveSourceField: true },
    {
      subAgent: {
        thread_spawn: {
          depth: 1,
          parent_thread_id: "parent-thread",
          agent_nickname: null,
          agent_path: "/root/worker",
          agent_role: "worker",
          additiveSpawnField: true,
        },
        additiveSubAgentField: true,
      },
      additiveSourceField: true,
    },
    { subAgent: { other: "future-source", additiveSubAgentField: true } },
  ];
  for (const [index, source] of sourceVariants.entries()) {
    await emitNotification(session, {
      method: "thread/started",
      params: {
        thread: {
          ...validThread,
          id: `source-thread-${index}`,
          sessionId: `source-session-${index}`,
          source,
        },
      },
    });
    assert.equal(await session.ensureConnected(), client, `source variant ${index}`);
  }
});

test("unknown and explicitly ignored additive notifications remain tolerated", async (t) => {
  const { session } = await createFixture(t);
  const client = await session.ensureConnected();
  for (const notification of [
    { method: "future/notification", params: 42 },
    { method: "toString", params: 42 },
    { method: "warning", params: { message: 42, future: true } },
    { method: "thread/tokenUsage/updated", params: 42 },
  ]) {
    await emitNotification(session, notification);
    assert.equal(await session.ensureConnected(), client, notification.method);
  }
});

const malformedNotifications = Object.freeze([
  ["thread/started", { thread: { ...validThread, id: 42 } }],
  ["thread/status/changed", {
    threadId: "foreign-thread",
    status: { type: "active" },
  }],
  ["thread/archived", { threadId: 42 }],
  ["thread/name/updated", { threadId: "foreign-thread", threadName: 42 }],
  ["turn/started", {
    threadId: "foreign-thread",
    turn: { ...validTurn, status: "waiting" },
  }],
  ["item/started", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    item: validItem,
    startedAtMs: 1.5,
  }],
  ["item/agentMessage/delta", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    itemId: "foreign-item",
    delta: 42,
  }],
  ["item/plan/delta", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    delta: "missing item identity",
  }],
  ["item/reasoning/summaryPartAdded", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    itemId: "foreign-item",
    summaryIndex: Number.MAX_SAFE_INTEGER + 1,
  }],
  ["item/reasoning/summaryTextDelta", {
    threadId: "foreign-thread",
    turnId: null,
    itemId: "foreign-item",
    summaryIndex: 0,
    delta: "wrong turn identity type",
  }],
  ["item/completed", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    item: { id: "foreign-item", type: "agentMessage" },
    completedAtMs: 1,
  }],
  ["serverRequest/resolved", { threadId: "foreign-thread", requestId: 1.5 }],
  ["turn/completed", {
    threadId: "foreign-thread",
    turn: { id: "foreign-turn", status: "completed" },
  }],
  ["error", {
    threadId: "foreign-thread",
    turnId: "foreign-turn",
    error: { message: 42 },
    willRetry: false,
  }],
]);

test("every malformed known notification retires its production native session", async (t) => {
  for (const [method, params] of malformedNotifications) {
    await t.test(method, async (t) => {
      const { session } = await createFixture(t, { FAKE_NATIVE_ROOT_COUNT: "1" });
      await session.ensureConnected();
      assert.equal(session.isEligibleRoot("native-thread-1"), true);
      await assert.rejects(
        emitNotification(session, { method, params }),
        (error) => error.code === "PROTOCOL_ERROR",
      );
      assert.deepEqual(session.coordinates(), {
        connectionEpoch: "notification-epoch-2",
        activityRevision: 0,
      });
      assert.equal(session.isEligibleThread("native-thread-1"), false);
      assert.equal(session.isEligibleRoot("native-thread-1"), false);
    });
  }
  assert.equal(malformedNotifications.length, 14);
});

const malformedNestedNotifications = Object.freeze([
  ["empty SessionSource object", {
    method: "thread/started",
    params: { thread: { ...validThread, source: {} } },
  }],
  ["legacy malformed thread-spawn discriminator", {
    method: "thread/started",
    params: { thread: { ...validThread, source: { subAgent: { threadSpawn: {} } } } },
  }],
  ["userMessage content member", {
    method: "item/started",
    params: {
      threadId: "foreign-thread",
      turnId: "foreign-turn",
      item: { id: "bad-user", type: "userMessage", content: [{ type: "text" }] },
      startedAtMs: 0,
    },
  }],
  ["userMessage client identity", {
    method: "item/started",
    params: {
      threadId: "foreign-thread",
      turnId: "foreign-turn",
      item: {
        id: "bad-user-client",
        type: "userMessage",
        clientId: 42,
        content: [{ type: "text", text: "Dinner", text_elements: [] }],
      },
      startedAtMs: 0,
    },
  }],
  ["hookPrompt fragment", {
    method: "item/started",
    params: {
      threadId: "foreign-thread",
      turnId: "foreign-turn",
      item: { id: "bad-hook", type: "hookPrompt", fragments: [{ hookRunId: "run" }] },
      startedAtMs: 0,
    },
  }],
  ["commandExecution action", {
    method: "item/started",
    params: {
      threadId: "foreign-thread",
      turnId: "foreign-turn",
      item: {
        id: "bad-command",
        type: "commandExecution",
        command: "pwd",
        commandActions: [{}],
        cwd: "/tmp",
        status: "completed",
      },
      startedAtMs: 0,
    },
  }],
  ["fileChange kind", {
    method: "item/started",
    params: {
      threadId: "foreign-thread",
      turnId: "foreign-turn",
      item: {
        id: "bad-change",
        type: "fileChange",
        changes: [{ diff: "@@ dinner @@", kind: "update", path: "meal.md" }],
        status: "completed",
      },
      startedAtMs: 0,
    },
  }],
  ["collabAgentToolCall agent state", {
    method: "item/started",
    params: {
      threadId: "foreign-thread",
      turnId: "foreign-turn",
      item: {
        id: "bad-collab",
        type: "collabAgentToolCall",
        agentsStates: { worker: {} },
        receiverThreadIds: ["worker-thread"],
        senderThreadId: "root-thread",
        status: "completed",
        tool: "spawnAgent",
      },
      startedAtMs: 0,
    },
  }],
]);

test("malformed required nested notification shapes retire before mutation", async (t) => {
  for (const [label, notification] of malformedNestedNotifications) {
    await t.test(label, async (t) => {
      const { session } = await createFixture(t, { FAKE_NATIVE_ROOT_COUNT: "1" });
      await session.ensureConnected();
      await assert.rejects(
        emitNotification(session, notification),
        (error) => error.code === "PROTOCOL_ERROR",
      );
      assert.deepEqual(session.coordinates(), {
        connectionEpoch: "notification-epoch-2",
        activityRevision: 0,
      });
      assert.equal(session.isEligibleThread("native-thread-1"), false);
    });
  }
});

test("failure clears archive tombstones before recovery rehydrates authority", async (t) => {
  const { session } = await createFixture(
    t,
    { FAKE_NATIVE_ROOT_COUNT: "1" },
    { firstSpawnOnly: true },
  );
  const staleClient = await session.ensureConnected();
  assert.equal(session.isEligibleRoot("native-thread-1"), true);

  await emitNotification(session, {
    method: "thread/archived",
    params: { threadId: "native-thread-1" },
  });
  assert.equal(session.isKnownArchived("native-thread-1"), true);
  assert.equal(session.isEligibleThread("native-thread-1"), false);
  const before = session.coordinates();
  const event = session.waitForEvents({
    connectionEpoch: before.connectionEpoch,
    afterRevision: before.activityRevision,
    threadId: "native-thread-1",
    waitMs: 1_000,
  });

  await assert.rejects(
    emitNotification(session, {
      method: "item/plan/delta",
      params: {
        threadId: "native-thread-1",
        turnId: "native-turn",
        delta: "missing item identity",
      },
    }),
    (error) => error.code === "PROTOCOL_ERROR",
  );
  assert.equal(session.isKnownArchived("native-thread-1"), false);
  assert.deepEqual(await event, {
    changed: true,
    connectionEpoch: "notification-epoch-2",
    revision: 0,
    resyncRequired: true,
    reasons: ["runtime"],
  });

  const recoveredClient = await session.ensureConnected();
  assert.notEqual(recoveredClient, staleClient);
  assert.equal(session.isEligibleRoot("native-thread-1"), true);
  assert.equal(session.isKnownArchived("native-thread-1"), false);
});

test("startup prevalidates a later malformed notification before an earlier planner request", async (t) => {
  const beforeEnvironment = {
    FAKE_NATIVE_EARLY_PLANNER_TOOL: "1",
    FAKE_NATIVE_EARLY_NOTIFICATION: JSON.stringify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "native-thread-1",
        turnId: "native-turn-early",
        delta: "missing item identity",
      },
    }),
  };
  const { dispatched, session } = await createFixture(
    t,
    beforeEnvironment,
    { firstSpawnOnly: true },
  );
  const before = session.coordinates();
  const event = session.waitForEvents({
    connectionEpoch: before.connectionEpoch,
    afterRevision: before.activityRevision,
    threadId: "native-thread-1",
    waitMs: 1_000,
  });

  await assert.rejects(
    session.ensureConnected(),
    (error) => error.code === "PROTOCOL_ERROR",
  );
  assert.deepEqual(dispatched, []);
  assert.equal(session.isEligibleThread("native-thread-1"), false);
  assert.equal(session.isEligibleRootTurn("native-thread-1", "native-turn-early"), false);
  assert.deepEqual(session.listInteractions("native-thread-1"), []);
  assert.deepEqual(await event, {
    changed: true,
    connectionEpoch: "notification-epoch-2",
    revision: 0,
    resyncRequired: true,
    reasons: ["runtime"],
  });

  await session.ensureConnected();
  assert.deepEqual(dispatched, []);
  assert.equal(session.isEligibleRootTurn("native-thread-1", "native-turn-early"), true);
});

test("malformed known frames clear transient authority and expose only epoch resync", async (t) => {
  const { dispatched, session } = await createFixture(
    t,
    { FAKE_NATIVE_EARLY_INPUT: "1" },
    { firstSpawnOnly: true },
  );
  const staleClient = await session.ensureConnected();
  assert.equal(session.isEligibleRoot("native-thread-1"), true);
  assert.equal(session.isEligibleRootTurn("native-thread-1", "native-turn-early"), true);
  assert.equal(session.listInteractions("native-thread-1").length, 1);
  const before = session.coordinates();
  const event = session.waitForEvents({
    connectionEpoch: before.connectionEpoch,
    afterRevision: before.activityRevision,
    threadId: "native-thread-1",
    waitMs: 1_000,
  });

  await assert.rejects(
    emitNotification(
      session,
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "native-thread-1",
          turnId: "native-turn-early",
          delta: "missing item id",
        },
      },
      [{
        id: "stale-planner-tool",
        method: "item/tool/call",
        params: {
          threadId: "native-thread-1",
          turnId: "native-turn-early",
          callId: "stale-call",
          namespace: "planner",
          tool: "read",
          arguments: {},
        },
      }],
    ),
    (error) => error.code === "PROTOCOL_ERROR",
  );

  assert.deepEqual(await event, {
    changed: true,
    connectionEpoch: "notification-epoch-2",
    revision: 0,
    resyncRequired: true,
    reasons: ["runtime"],
  });
  assert.deepEqual(session.coordinates(), {
    connectionEpoch: "notification-epoch-2",
    activityRevision: 0,
  });
  assert.equal(session.isEligibleThread("native-thread-1"), false);
  assert.equal(session.isEligibleRootTurn("native-thread-1", "native-turn-early"), false);
  assert.deepEqual(session.listInteractions("native-thread-1"), []);
  assert.deepEqual(dispatched, []);

  const recoveredClient = await session.ensureConnected();
  assert.notEqual(recoveredClient, staleClient);
  assert.deepEqual(session.coordinates(), {
    connectionEpoch: "notification-epoch-2",
    activityRevision: 0,
  });
  assert.deepEqual(session.listInteractions("native-thread-1"), []);
});
