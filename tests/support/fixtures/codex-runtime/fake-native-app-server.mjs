#!/usr/bin/env node

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const stateFile = process.env.FAKE_NATIVE_STATE_FILE ?? null;
const restoredState = (() => {
  if (stateFile === null || !existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    process.exit(24);
  }
})();
const threads = new Map(Array.isArray(restoredState?.threads) ? restoredState.threads : []);
const liveRootIds = new Set();
const pendingServerRequests = new Map();
const requestCounts = Object.create(null);
const requestSequence = [];
const threadReadRequests = [];
const serverResponses = [];
let nextThread = Number.isSafeInteger(restoredState?.nextThread) ? restoredState.nextThread : 0;
let nextTurn = Number.isSafeInteger(restoredState?.nextTurn) ? restoredState.nextTurn : 0;
let nextServerRequest = 0;
let initializedNotified = false;
let protocolViolation = false;
let earlyInputThread = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function environmentInteger(name, fallback = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function environmentErrorCode(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) ? value : fallback;
}

function persistState() {
  if (stateFile === null) return;
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    nextThread,
    nextTurn,
    // The real provider does not write an allocated blank root to rollout
    // history until its first user turn. Keep the deterministic id counter,
    // but exclude process-local roots from the restart image.
    threads: [...threads.entries()].filter(([, thread]) =>
      process.env.FAKE_NATIVE_PERSIST_UNMATERIALIZED_ROOT === "1" ||
      thread.materialized !== false
    ),
  }), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, stateFile);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function count(method) {
  requestCounts[method] = (requestCounts[method] ?? 0) + 1;
  requestSequence.push(method);
}

function threadView(thread) {
  return {
    cliVersion: "0.142.5",
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    cwd: process.cwd(),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    modelProvider: "fake-native-provider",
    sessionId: `fake-session-${thread.id}`,
    status: thread.status,
    source: thread.source,
    threadSource: thread.threadSource,
    parentThreadId: thread.parentThreadId,
    ephemeral: thread.ephemeral,
    turns: thread.turns,
  };
}

function threadListView(thread) {
  const view = threadView(thread);
  if (thread.materialized !== false && thread.parentThreadId === null) {
    // Codex 0.142.5 rebuilds materialized list projections from ThreadItem,
    // whose schema drops the custom thread source.
    view.threadSource = null;
  }
  return view;
}

function threadReadView(thread) {
  const view = threadView(thread);
  const revalidationNullReads = environmentInteger("FAKE_NATIVE_REVALIDATION_NULL_READS");
  const readCount = threadReadRequests.filter((request) => request.threadId === thread.id).length;
  if (!liveRootIds.has(thread.id) && readCount <= revalidationNullReads) {
    view.threadSource = null;
    return view;
  }
  if (thread.materialized !== false && thread.parentThreadId === null &&
      liveRootIds.has(thread.id)) {
    // The same lossy rollout projection replaces the live read once the first
    // turn materializes. A fresh process can still recover the marker through
    // the unloaded SQLite projection before the task is resumed.
    view.threadSource = process.env.FAKE_NATIVE_LIVE_READ_THREAD_SOURCE ?? null;
  }
  return view;
}

function authorizedThreadResult(thread, drift = null) {
  const result = {
    activePermissionProfile: { id: ":read-only", extends: null },
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: process.cwd(),
    instructionSources: [],
    model: "fake-native-model",
    modelProvider: "fake-native-provider",
    sandbox: { type: "readOnly", networkAccess: false },
    thread: threadView(thread),
  };
  if (drift === "cwd") result.cwd = `${process.cwd()}/drift`;
  if (drift === "approvalPolicy") result.approvalPolicy = "on-request";
  if (drift === "approvalsReviewer") result.approvalsReviewer = "auto_review";
  if (drift === "permissionProfileId") result.activePermissionProfile.id = ":workspace";
  if (drift === "permissionProfileExtends") {
    result.activePermissionProfile.extends = ":workspace";
  }
  if (drift === "sandboxType") result.sandbox.type = "workspaceWrite";
  if (drift === "networkAccess") result.sandbox.networkAccess = true;
  if (drift === "threadSource") result.thread.threadSource = "unmarked-native-thread";
  return result;
}

function createThread(params, overrides = {}, persist = true) {
  const id = `native-thread-${++nextThread}`;
  const now = Math.floor(Date.now() / 1_000);
  const thread = {
    id,
    name: typeof params?.name === "string" ? params.name : null,
    preview: "",
    createdAt: now,
    updatedAt: now,
    status: { type: "idle" },
    turns: [],
    materialized: overrides.materialized ?? true,
    archived: false,
    // Native Codex returns the host transport source (`vscode`) even for an
    // app-server thread. The app-owned `threadSource` marker is authoritative.
    source: overrides.source ?? "vscode",
    threadSource: overrides.threadSource ?? params?.threadSource ?? "weekly_recipe_planner",
    parentThreadId: overrides.parentThreadId ?? null,
    ephemeral: false,
  };
  threads.set(id, thread);
  if (persist) persistState();
  return thread;
}

if (restoredState === null) {
  for (let index = 0; index < environmentInteger("FAKE_NATIVE_ROOT_COUNT"); index += 1) {
    createThread({}, {}, false);
  }
  if (process.env.FAKE_NATIVE_FOREIGN_UNMATERIALIZED_ROOT === "1") {
    createThread({}, {
      materialized: false,
      threadSource: "foreign-native-thread",
    }, false);
  }
  if (process.env.FAKE_NATIVE_FOREIGN_MATERIALIZED_ROOT === "1") {
    createThread({}, { threadSource: "foreign-native-thread" }, false);
  }
  if (process.env.FAKE_NATIVE_UNVERIFIABLE_MATERIALIZED_ROOT === "1") {
    const unverifiable = createThread({}, {}, false);
    liveRootIds.add(unverifiable.id);
  }
  if (process.env.FAKE_NATIVE_DEFAULT_EPHEMERAL_FIRST_PAGE === "1") {
    if (nextThread === 0) createThread({}, {}, false);
    const newestEligibleUpdatedAt = Math.max(
      ...[...threads.values()].map((thread) => thread.updatedAt),
    );
    for (let index = 0; index < 100; index += 1) {
      const ephemeral = createThread({}, {}, false);
      ephemeral.ephemeral = true;
      ephemeral.updatedAt = newestEligibleUpdatedAt + index + 1;
    }
  }
  if (process.env.FAKE_NATIVE_LARGE_CHILD === "1" && nextThread > 0) {
    const parentThreadId = `native-thread-${nextThread}`;
    createThread({}, {
      parentThreadId,
      source: { subAgent: { thread_spawn: { depth: 1, parent_thread_id: parentThreadId } } },
    }, false);
  }
  if (nextThread > 0) persistState();
}

if (process.env.FAKE_NATIVE_EARLY_INPUT === "1" ||
    process.env.FAKE_NATIVE_EARLY_PLANNER_TOOL === "1") {
  earlyInputThread = createThread({});
  earlyInputThread.status = { type: "active" };
  earlyInputThread.turns.push({
    id: "native-turn-early",
    status: "inProgress",
    items: [],
  });
  persistState();
}

function requireThread(id) {
  const thread = threads.get(id);
  if (!thread) throw new Error(`Unknown fixture thread ${id}.`);
  return thread;
}

function askForInput(threadId, turnId) {
  const sequence = ++nextServerRequest;
  const id = process.env.FAKE_NATIVE_STRING_INPUT_REQUEST_ID === "1"
    ? `fixture-server-${sequence}`
    : sequence;
  pendingServerRequests.set(id, { kind: "user_input", threadId, turnId });
  send({
    id,
    method: "item/tool/requestUserInput",
    params: {
      threadId,
      turnId,
      itemId: `input-${nextServerRequest}`,
      autoResolutionMs: 60_000,
      questions: [{
        id: "choice",
        header: "Dinner",
        question: "Which dinner should I plan?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Tacos", description: "Plan tacos." },
          { label: "Soup", description: "Plan soup." },
        ],
      }],
    },
  });
  return id;
}

function askForForbiddenApproval(threadId, turnId) {
  const id = `fixture-server-${++nextServerRequest}`;
  pendingServerRequests.set(id, { kind: "approval", threadId, turnId });
  send({
    id,
    method: "item/commandExecution/requestApproval",
    params: { threadId, turnId, itemId: `command-${nextServerRequest}` },
  });
}

function askForFileChangeApproval(threadId, turnId) {
  const id = `V2-FILE-REQUEST-ID-CANARY-${++nextServerRequest}`;
  pendingServerRequests.set(id, { kind: "v2_file_change", threadId, turnId });
  send({
    id,
    method: "item/fileChange/requestApproval",
    params: {
      threadId,
      turnId,
      itemId: `file-change-${nextServerRequest}`,
      reason: "V2-FILE-REASON-CANARY",
      grantRoot: "/tmp/V2-FILE-PATH-CANARY",
    },
  });
}

function askForPermissionsApproval(threadId, turnId) {
  const id = `PERMISSION-REQUEST-ID-CANARY-${++nextServerRequest}`;
  pendingServerRequests.set(id, { kind: "permissions", threadId, turnId });
  send({
    id,
    method: "item/permissions/requestApproval",
    params: {
      threadId,
      turnId,
      itemId: `permissions-${nextServerRequest}`,
      reason: "PERMISSION-REASON-CANARY",
      permissions: {
        fileSystem: {
          read: ["/tmp/PERMISSION-READ-PATH-CANARY"],
          write: ["/tmp/PERMISSION-WRITE-PATH-CANARY"],
        },
        network: { enabled: true },
      },
    },
  });
}

function askForMcpElicitation(threadId) {
  const id = `fixture-server-${++nextServerRequest}`;
  pendingServerRequests.set(id, { kind: "mcp_elicitation", threadId, turnId: null });
  send({
    id,
    method: "mcpServer/elicitation/request",
    params: {
      threadId,
      serverName: "fixture-mcp",
      mode: "form",
      _meta: null,
      message: "Allow the external connector to continue?",
      requestedSchema: {
        type: "object",
        properties: {
          confirmation: { type: "boolean", title: "Continue" },
        },
        required: ["confirmation"],
      },
    },
  });
}

function askForLegacyApprovals(threadId) {
  const applyId = `fixture-server-${++nextServerRequest}`;
  pendingServerRequests.set(applyId, {
    kind: "legacy_apply_patch",
    threadId,
    turnId: null,
  });
  send({
    id: applyId,
    method: "applyPatchApproval",
    params: {
      conversationId: threadId,
      callId: `legacy-patch-${nextServerRequest}`,
      fileChanges: {
        "/tmp/LEGACY-PATH-CANARY": {
          type: "update",
          unified_diff: "@@ LEGACY-PATCH-DIFF-CANARY @@",
          move_path: null,
        },
      },
      reason: "LEGACY-PATCH-REASON-CANARY",
      grantRoot: null,
    },
  });

  const commandId = `fixture-server-${++nextServerRequest}`;
  pendingServerRequests.set(commandId, {
    kind: "legacy_exec_command",
    threadId,
    turnId: null,
  });
  send({
    id: commandId,
    method: "execCommandApproval",
    params: {
      conversationId: threadId,
      callId: `legacy-command-${nextServerRequest}`,
      approvalId: null,
      command: ["echo", "LEGACY-COMMAND-CANARY"],
      cwd: "/tmp/LEGACY-CWD-CANARY",
      reason: "LEGACY-COMMAND-REASON-CANARY",
      parsedCmd: [{
        type: "read",
        cmd: "cat /tmp/LEGACY-PARSED-CMD-CANARY",
        name: "LEGACY-PARSED-NAME-CANARY",
        path: "/tmp/LEGACY-PARSED-PATH-CANARY",
      }],
    },
  });
}

function askPlannerTool(threadId, turnId) {
  const id = `fixture-server-${++nextServerRequest}`;
  pendingServerRequests.set(id, { kind: "planner_tool", threadId, turnId });
  send({
    id,
    method: "item/tool/call",
    params: {
      threadId,
      turnId,
      callId: `planner-${nextServerRequest}`,
      namespace: "planner",
      tool: "read",
      arguments: { query: { kind: "workspace" } },
    },
  });
}

async function handleRequest(message) {
  if (Object.hasOwn(message, "jsonrpc")) {
    protocolViolation = true;
  }

  if (Object.hasOwn(message, "id") && typeof message.method !== "string") {
    const pending = pendingServerRequests.get(message.id);
    if (!pending) return;
    pendingServerRequests.delete(message.id);
    const response = {
      kind: pending.kind,
      threadId: pending.threadId,
      turnId: pending.turnId,
      result: message.result ?? null,
      error: message.error ?? null,
    };
    serverResponses.push(response);
    send({
      method: "fixture/serverResponse",
      params: response,
    });
    send({
      method: "serverRequest/resolved",
      params: { threadId: pending.threadId, requestId: message.id },
    });
    return;
  }

  if (typeof message.method !== "string") return;
  if (!Object.hasOwn(message, "id")) {
    if (message.method === "initialized") initializedNotified = true;
    return;
  }
  count(message.method);

  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-native-app-server" } });
    if (earlyInputThread !== null) {
      if (process.env.FAKE_NATIVE_EARLY_INPUT === "1") {
        const requestId = askForInput(earlyInputThread.id, "native-turn-early");
        if (process.env.FAKE_NATIVE_EARLY_INPUT_RESOLVED === "1") {
          pendingServerRequests.delete(requestId);
          send({
            method: "serverRequest/resolved",
            params: { threadId: earlyInputThread.id, requestId },
          });
        }
      }
      if (process.env.FAKE_NATIVE_EARLY_PLANNER_TOOL === "1") {
        askPlannerTool(earlyInputThread.id, "native-turn-early");
      }
      earlyInputThread = null;
    }
    if (process.env.FAKE_NATIVE_EARLY_NOTIFICATION !== undefined) {
      send(JSON.parse(process.env.FAKE_NATIVE_EARLY_NOTIFICATION));
    }
    return;
  }

  if (message.method === "thread/start") {
    await delay(environmentInteger("FAKE_NATIVE_DELAY_BEFORE_THREAD_START_MS"));
    const unmaterialized = process.env.FAKE_NATIVE_UNMATERIALIZED_FIRST_ROOT === "1";
    const thread = createThread(
      message.params,
      unmaterialized ? { materialized: false } : {},
    );
    liveRootIds.add(thread.id);
    await delay(environmentInteger("FAKE_NATIVE_DELAY_THREAD_START_MS"));
    send({
      id: message.id,
      result: authorizedThreadResult(thread, process.env.FAKE_NATIVE_START_POLICY_DRIFT),
    });
    send({ method: "thread/started", params: { thread: threadView(thread) } });
    return;
  }

  if (message.method === "thread/list") {
    const respond = () => {
      if (message.params?.searchTerm === "__emit_notification__") {
        send(message.params.fixtureNotification);
        for (const frame of message.params.fixtureAfterNotification ?? []) send(frame);
        send({ id: message.id, result: { data: [], nextCursor: null } });
        return;
      }
      if (message.params?.searchTerm === "__stats__") {
        send({
          id: message.id,
          result: {
            data: [],
            nextCursor: null,
            requestCounts: { ...requestCounts },
            requestSequence: [...requestSequence],
            threadReadRequests: structuredClone(threadReadRequests),
            serverResponses: structuredClone(serverResponses),
            initializedNotified,
            protocolViolation,
          },
        });
        return;
      }
      if (requestCounts["thread/list"] > 1) {
        if (process.env.FAKE_NATIVE_LIST_DRIFT === "method") {
          send({
            id: message.id,
            error: { code: -32601, message: "Unknown fixture method thread/list." },
          });
          return;
        }
        if (process.env.FAKE_NATIVE_LIST_DRIFT === "schema") {
          send({
            id: message.id,
            error: { code: -32602, message: "Invalid params for thread/list." },
          });
          return;
        }
      }
      const candidates = [...threads.values()]
        .filter((thread) => thread.materialized !== false)
        .filter((thread) => thread.archived === (message.params?.archived === true))
        .filter((thread) => message.params?.parentThreadId === undefined ||
          thread.parentThreadId === message.params.parentThreadId)
        .filter((thread) => !Array.isArray(message.params?.sourceKinds) ||
          message.params.sourceKinds.length === 0 ||
          (message.params.sourceKinds.includes("appServer") && thread.source === "appServer") ||
          (message.params.sourceKinds.includes("subAgent") && thread.parentThreadId !== null))
        .filter((thread) => message.params?.searchTerm === "slow" ||
          typeof message.params?.searchTerm !== "string" ||
          thread.preview.includes(message.params.searchTerm) ||
          (thread.name ?? "").includes(message.params.searchTerm));
      const direction = message.params?.sortDirection === "asc" ? 1 : -1;
      const sortKey = message.params?.sortKey === "created_at" ? "createdAt" : "updatedAt";
      candidates.sort((left, right) =>
        direction * ((left[sortKey] - right[sortKey]) || left.id.localeCompare(right.id))
      );
      const cursorMatch = /^fixture-cursor-(\d+)$/u.exec(message.params?.cursor ?? "");
      const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
      const limit = Number.isSafeInteger(message.params?.limit) ? message.params.limit : 100;
      const page = candidates.slice(offset, offset + limit);
      const ordinaryNextCursor = offset + page.length < candidates.length
        ? `fixture-cursor-${offset + page.length}`
        : null;
      const nextCursor = process.env.FAKE_NATIVE_LIST_REPEAT_CURSOR === "1"
        ? (message.params?.cursor ?? "fixture-cursor-100")
        : process.env.FAKE_NATIVE_LIST_ENDLESS_CURSOR === "1"
          ? `fixture-cursor-${offset + Math.max(limit, 1)}`
          : ordinaryNextCursor;
      send({
        id: message.id,
        result: {
          data: page.map(threadListView),
          nextCursor,
        },
      });
    };
    setTimeout(respond, message.params?.searchTerm === "slow" ? 150 : 0);
    return;
  }

  if (message.method === "thread/read") {
    const threadId = message.params?.threadId;
    threadReadRequests.push({
      threadId: typeof threadId === "string" ? threadId : null,
      includeTurns: message.params?.includeTurns === true,
    });
    if (process.env.FAKE_NATIVE_BLOCK_THREAD_READ === "1") {
      writeFileSync(`${process.cwd()}/.fake-native-thread-read-started`, "started\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      while (!existsSync(`${process.cwd()}/.fake-native-thread-read-release`)) {
        await delay(5);
      }
    }
    if (threadId === "never") return;
    if (threadId === process.env.FAKE_NATIVE_UNAVAILABLE_THREAD_ID) return;
    if (threadId === "missing-native-thread") {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: `thread not found: ${threadId}`,
          data: { kind: "missing_thread" },
        },
      });
      return;
    }
    if (threadId === process.env.FAKE_NATIVE_NOT_LOADED_THREAD_ID) {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: `thread not loaded: ${
            process.env.FAKE_NATIVE_NOT_LOADED_RESPONSE_THREAD_ID ?? threadId
          }`,
        },
      });
      return;
    }
    if (threadId === "crash") {
      setTimeout(() => process.exit(23), 10);
      return;
    }
    if (threadId === "oversized") {
      process.stdout.write(`${"x".repeat(1_100_000)}\n`);
      return;
    }
    if (threadId === "invalid-json") {
      process.stdout.write("{invalid-json\n");
      return;
    }
    if (!threads.has(threadId)) {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: `thread not loaded: ${threadId}`,
        },
      });
      return;
    }
    const thread = requireThread(threadId);
    if (thread.materialized === false && message.params?.includeTurns === true) {
      send({
        id: message.id,
        error: {
          code: environmentErrorCode("FAKE_NATIVE_UNMATERIALIZED_READ_ERROR_CODE", -32600),
          message: process.env.FAKE_NATIVE_UNMATERIALIZED_READ_MESSAGE ??
            `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`,
          data: { kind: "unmaterialized_thread" },
        },
      });
      return;
    }
    send({ id: message.id, result: { thread: threadReadView(thread) } });
    return;
  }

  if (message.method === "thread/resume") {
    if (!threads.has(message.params?.threadId)) {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: `no rollout found for thread id ${message.params?.threadId}`,
        },
      });
      return;
    }
    const thread = requireThread(message.params?.threadId);
    liveRootIds.add(thread.id);
    await delay(environmentInteger("FAKE_NATIVE_DELAY_RESUME_MS"));
    send({
      id: message.id,
      result: authorizedThreadResult(thread, process.env.FAKE_NATIVE_RESUME_POLICY_DRIFT),
    });
    return;
  }

  if (message.method === "thread/archive") {
    const thread = requireThread(message.params?.threadId);
    thread.archived = true;
    persistState();
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "turn/start") {
    if (!threads.has(message.params?.threadId)) {
      send({
        id: message.id,
        error: {
          code: -32600,
          message: `thread not loaded: ${message.params?.threadId}`,
        },
      });
      return;
    }
    const thread = requireThread(message.params?.threadId);
    await delay(environmentInteger("FAKE_NATIVE_DELAY_BEFORE_TURN_START_MS"));
    const turnNumber = ++nextTurn;
    const userItem = {
      id: `user-${turnNumber}`,
      type: "userMessage",
      clientId: message.params?.clientUserMessageId ?? null,
      content: message.params?.input ?? [],
    };
    const turn = {
      id: `native-turn-${turnNumber}`,
      status: "inProgress",
      items: [userItem],
    };
    if (process.env.FAKE_NATIVE_PRIVACY_CANARY_ITEMS === "1") {
      turn.items.push(
        {
          id: `reasoning-${nextTurn}`,
          type: "reasoning",
          content: "RAW_REASONING_PRIVACY_CANARY",
          summary: ["Considering the request"],
        },
        {
          id: `planner-tool-${nextTurn}`,
          type: "dynamicToolCall",
          namespace: "planner",
          tool: "read",
          status: "completed",
          arguments: { query: "PLANNER_ARGUMENT_PRIVACY_CANARY" },
          result: "PLANNER_RESULT_PRIVACY_CANARY",
        },
        {
          id: `web-search-${nextTurn}`,
          type: "webSearch",
          query: "WEB_QUERY_PRIVACY_CANARY",
          action: {
            type: "openPage",
            url: "https://example.invalid/WEB_URL_PRIVACY_CANARY",
          },
        },
        {
          id: `command-${nextTurn}`,
          type: "commandExecution",
          command: "COMMAND_PRIVACY_CANARY",
          commandActions: [],
          cwd: "/private/COMMAND_PATH_PRIVACY_CANARY",
          status: "completed",
        },
      );
    }
    if (process.env.FAKE_NATIVE_DUPLICATE_CLIENT_MESSAGE === "1") {
      turn.items.push({ ...turn.items[0], id: `user-duplicate-${nextTurn}` });
    }
    const startedTurn = {
      id: turn.id,
      status: "inProgress",
      items: [],
      itemsView: "notLoaded",
    };
    const responseDelayMs = environmentInteger("FAKE_NATIVE_DELAY_TURN_START_MS");
    const delayedMaterializationMs = environmentInteger(
      "FAKE_NATIVE_DELAY_FIRST_TURN_MATERIALIZATION_MS",
    );
    if (responseDelayMs === 0) {
      send({ id: message.id, result: { turn: startedTurn } });
    }
    send({ method: "turn/started", params: { threadId: thread.id, turn: startedTurn } });
    if (process.env.FAKE_NATIVE_OMIT_USER_MESSAGE_COMPLETION !== "1") {
      send({
        method: "item/started",
        params: { item: userItem, startedAtMs: Date.now(), threadId: thread.id, turnId: turn.id },
      });
      if (process.env.FAKE_NATIVE_BLOCK_USER_MESSAGE_COMPLETION === "1") {
        writeFileSync(`${process.cwd()}/.fake-native-user-completion-started`, "started\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        while (!existsSync(`${process.cwd()}/.fake-native-user-completion-release`)) {
          await delay(5);
        }
      }
      await delay(environmentInteger("FAKE_NATIVE_DELAY_USER_MESSAGE_COMPLETION_MS"));
      send({
        method: "item/completed",
        params: {
          completedAtMs: Date.now(),
          item: userItem,
          threadId: thread.id,
          turnId: process.env.FAKE_NATIVE_USER_MESSAGE_COMPLETION_TURN_ID ?? turn.id,
        },
      });
    }
    if (delayedMaterializationMs > 0) {
      // Codex emits the completed user item immediately before the legacy
      // history write that makes thread/read authoritative. Preserve that
      // ordered race instead of making the fake projection synchronous.
      await delay(delayedMaterializationMs);
    }
    if (process.env.FAKE_NATIVE_OMIT_TURN_START_HISTORY !== "1") {
      thread.turns.push(turn);
    }
    thread.materialized = true;
    thread.status = { type: "active" };
    thread.updatedAt = Math.floor(Date.now() / 1_000);
    persistState();
    if (responseDelayMs > 0) {
      await delay(responseDelayMs);
      send({ id: message.id, result: { turn: startedTurn } });
    }
    const prompt = message.params?.input?.[0]?.text;
    if (typeof prompt === "string" && prompt.includes("ask me")) {
      askForInput(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("command approval")) {
      askForForbiddenApproval(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("file change approval")) {
      askForFileChangeApproval(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("permissions approval")) {
      askForPermissionsApproval(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("MCP elicitation")) {
      askForMcpElicitation(thread.id);
    }
    if (typeof prompt === "string" && prompt.includes("legacy approvals")) {
      askForLegacyApprovals(thread.id);
    }
    if (typeof prompt === "string" && prompt.includes("root planner read")) {
      askPlannerTool(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("stale planner read")) {
      askPlannerTool(thread.id, "native-turn-stale");
    }
    if (typeof prompt === "string" && prompt.includes("worker planner read")) {
      const child = createThread({}, {
        parentThreadId: thread.id,
        source: {
          subAgent: {
            thread_spawn: { depth: 1, parent_thread_id: thread.id },
          },
        },
      });
      send({ method: "thread/started", params: { thread: threadView(child) } });
      const childTurn = {
        id: `native-turn-${++nextTurn}`,
        status: "inProgress",
        items: [],
      };
      child.turns.push(childTurn);
      child.status = { type: "active" };
      askPlannerTool(child.id, childTurn.id);
    }
    return;
  }

  if (message.method === "turn/steer") {
    const thread = requireThread(message.params?.threadId);
    await delay(environmentInteger("FAKE_NATIVE_DELAY_BEFORE_TURN_STEER_MS"));
    const turn = thread.turns.find((candidate) => candidate.id === message.params?.expectedTurnId);
    if (process.env.FAKE_NATIVE_STEER_CONFLICT === "1") {
      send({
        id: message.id,
        error: { code: -32600, message: "no active turn to steer" },
      });
      return;
    }
    const userItem = {
      id: `user-steer-${nextTurn}-${turn.items.length}`,
      type: "userMessage",
      clientId: message.params?.clientUserMessageId ?? null,
      content: message.params?.input ?? [],
    };
    turn?.items.push(userItem);
    persistState();
    if (process.env.FAKE_NATIVE_OMIT_USER_MESSAGE_COMPLETION !== "1") {
      send({
        method: "item/started",
        params: { item: userItem, startedAtMs: Date.now(), threadId: thread.id, turnId: turn.id },
      });
      send({
        method: "item/completed",
        params: { completedAtMs: Date.now(), item: userItem, threadId: thread.id, turnId: turn.id },
      });
    }
    await delay(environmentInteger("FAKE_NATIVE_DELAY_TURN_STEER_MS"));
    const prompt = message.params?.input?.[0]?.text;
    if (typeof prompt === "string" && prompt.includes("ask me")) {
      askForInput(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("command approval")) {
      askForForbiddenApproval(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("file change approval")) {
      askForFileChangeApproval(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("permissions approval")) {
      askForPermissionsApproval(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("MCP elicitation")) {
      askForMcpElicitation(thread.id);
    }
    if (typeof prompt === "string" && prompt.includes("legacy approvals")) {
      askForLegacyApprovals(thread.id);
    }
    if (typeof prompt === "string" && prompt.includes("root planner read")) {
      askPlannerTool(thread.id, turn.id);
    }
    if (typeof prompt === "string" && prompt.includes("stale planner read")) {
      askPlannerTool(thread.id, "native-turn-stale");
    }
    send({
      id: message.id,
      result: {
        turnId: process.env.FAKE_NATIVE_STEER_RESULT_MISMATCH === "1"
          ? "native-turn-mismatched-result"
          : message.params?.expectedTurnId,
      },
    });
    send({ method: "turn/steered", params: message.params });
    return;
  }

  if (message.method === "turn/interrupt") {
    const thread = requireThread(message.params?.threadId);
    const turn = thread.turns.find((candidate) => candidate.id === message.params?.turnId);
    if (process.env.FAKE_NATIVE_INTERRUPT_CONFLICT === "1") {
      send({
        id: message.id,
        error: { code: -32600, message: "no active turn to interrupt" },
      });
      return;
    }
    await delay(environmentInteger("FAKE_NATIVE_DELAY_INTERRUPT_MS"));
    for (const [requestId, pending] of pendingServerRequests) {
      if (pending.threadId !== thread.id || pending.turnId !== message.params?.turnId) continue;
      pendingServerRequests.delete(requestId);
      const resolutionParams = process.env.FAKE_NATIVE_MALFORMED_RESOLUTION === "1"
        ? { threadId: thread.id }
        : {
            threadId: process.env.FAKE_NATIVE_MISMATCHED_RESOLUTION_THREAD === "1"
              ? "native-thread-mismatched"
              : thread.id,
            requestId,
          };
      send({
        method: "serverRequest/resolved",
        params: resolutionParams,
      });
    }
    if (turn) turn.status = "interrupted";
    thread.status = { type: "idle" };
    persistState();
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: thread.id, turn } });
    return;
  }

  send({
    id: message.id,
    error: { code: -32601, message: `Unknown fixture method ${message.method}.` },
  });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 21;
    return;
  }
  void handleRequest(message).catch((error) => {
    if (Object.hasOwn(message, "id")) {
      send({ id: message.id, error: { code: -32000, message: error.message } });
    }
  });
});
