#!/usr/bin/env node

import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "normal-duplicates";
const pending = new Map();
let threadParams = null;
let turnParams = null;
let toolResponses = 0;
let firstDependentResult = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, message) {
  send({ id, error: { code: -32602, message } });
}

function complete(reply) {
  const item = {
    id: "agent-message-1",
    type: "agentMessage",
    phase: "final_answer",
    text: JSON.stringify({ reply }),
  };
  send({
    method: "item/completed",
    params: {
      completedAtMs: Date.now(),
      item,
      threadId: "thread-embedded",
      turnId: "turn-embedded",
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: "thread-embedded",
      turn: {
        id: "turn-embedded",
        status: "completed",
        items: [item],
      },
    },
  });
}

function validateThread(params, recovery) {
  const namespace = params.dynamicTools?.[0];
  const common = params.approvalPolicy === "never" &&
    params.permissions === ":read-only" && !("sandbox" in params) &&
    params.cwd === process.cwd() &&
    Array.isArray(params.environments) && params.environments.length === 0 &&
    params.config?.web_search === "disabled" &&
    params.config?.features?.shell_tool === false &&
    params.config?.features?.plugins === false &&
    params.config?.features?.multi_agent === false;
  if (!common) return false;
  if (recovery) {
    return Array.isArray(params.dynamicTools) && params.dynamicTools.length === 0;
  }
  return Array.isArray(params.dynamicTools) && params.dynamicTools.length === 1 &&
    namespace?.type === "namespace" && namespace?.name === "planner" &&
    namespace.tools?.map((tool) => tool.name).join(",") === "read,preview,apply";
}

function validateToolResponse(message, expectedCallId) {
  if (
    !message?.result || typeof message.result.success !== "boolean" ||
    !Array.isArray(message.result.contentItems) || message.result.contentItems.length !== 1 ||
    message.result.contentItems[0]?.type !== "inputText" ||
    typeof message.result.contentItems[0]?.text !== "string"
  ) {
    throw new Error("host returned a malformed dynamic-tool response");
  }
  const envelope = JSON.parse(message.result.contentItems[0].text);
  if (
    envelope.schemaVersion !== 1 || envelope.callId !== expectedCallId ||
    envelope.ok !== message.result.success || !Number.isSafeInteger(envelope.plannerVersion)
  ) {
    throw new Error("host response envelope did not match its wire call");
  }
  return envelope;
}

function sendToolRequest(requestId, callId, tool, argumentsValue, identity = {}) {
  pending.set(requestId, { callId });
  send({
    id: requestId,
    method: "item/tool/call",
    params: {
      arguments: argumentsValue,
      callId,
      namespace: "planner",
      threadId: identity.threadId ?? "thread-embedded",
      tool,
      turnId: identity.turnId ?? "turn-embedded",
    },
  });
}

function startTurn() {
  send({
    method: "thread/started",
    params: { thread: { id: "thread-embedded" } },
  });
  send({
    method: "turn/started",
    params: {
      threadId: "thread-embedded",
      turn: { id: "turn-embedded", status: "inProgress", items: [] },
    },
  });
  if (scenario === "recovery") {
    complete("Recovered from durable planner outcomes.");
    return;
  }
  if (scenario === "research-candidate-input") {
    complete("Received the dedicated bounded research candidate.");
    return;
  }
  if (scenario === "thread-scoped-notification") {
    send({
      method: "thread/settings/updated",
      params: { threadId: "thread-embedded" },
    });
    complete("Ignored the valid thread-scoped notification.");
    return;
  }
  if (scenario === "partial-turn-notification") {
    send({
      method: "item/completed",
      params: {
        item: {
          id: "partial-turn-final",
          type: "agentMessage",
          phase: "final_answer",
          text: JSON.stringify({ reply: "This partial identity must be rejected." }),
        },
        threadId: "thread-embedded",
      },
    });
    return;
  }
  if (scenario === "unknown-request") {
    send({
      id: "dangerous-request",
      method: "command/exec/requestApproval",
      params: { threadId: "thread-embedded", turnId: "turn-embedded" },
    });
    return;
  }
  if (scenario === "notification-flood") {
    for (let index = 0; index < 513; index += 1) {
      send({ method: "test/progress", params: {} });
    }
    return;
  }
  if (scenario === "message-flood") {
    for (let index = 0; index < 65; index += 1) {
      send({
        method: "item/completed",
        params: {
          item: {
            id: `agent-message-${index}`,
            type: "agentMessage",
            phase: "commentary",
            text: JSON.stringify({ reply: `message ${index}` }),
          },
          threadId: "thread-embedded",
          turnId: "turn-embedded",
        },
      });
    }
    return;
  }
  if (scenario === "identity-free-message") {
    send({
      method: "item/completed",
      params: {
        item: {
          id: "identity-free-final",
          type: "agentMessage",
          phase: "final_answer",
          text: JSON.stringify({ reply: "This identity-free reply must be rejected." }),
        },
      },
    });
    return;
  }
  if (scenario === "early-exit") {
    process.exit(23);
  }
  if (scenario === "hang") return;
  if (scenario === "dependent-calls") {
    sendToolRequest("dependent-a", "call-a", "read", {
      query: { kind: "workspace" },
    });
    return;
  }
  if (scenario === "changed-identity") {
    sendToolRequest("changed-first", "changed-call", "read", {
      query: { kind: "workspace" },
    });
    return;
  }
  if (scenario === "callback-terminal-race") {
    sendToolRequest("race-call", "race-call", "read", {
      query: { kind: "workspace" },
    });
    complete("This terminal reply raced an active callback.");
    return;
  }
  if (scenario === "identity-mismatch") {
    sendToolRequest("mismatch-call", "mismatch-call", "read", {
      query: { kind: "workspace" },
    }, { turnId: "wrong-turn" });
    return;
  }
  send({
    method: "item/started",
    params: {
      item: { id: "tool-1", type: "dynamicToolCall" },
      threadId: "thread-embedded",
      turnId: "turn-embedded",
    },
  });
  const duplicateCount = scenario === "callback-timeout" ? 1 : 5;
  for (let index = 0; index < duplicateCount; index += 1) {
    const requestId = `tool-request-${index}`;
    sendToolRequest(requestId, "same-call", "read", {
      query: { kind: "workspace" },
    });
  }
}

function handleRequest(message) {
  if (message.method === "initialize") {
    return send({ id: message.id, result: { userAgent: "fake-embedded" } });
  }
  if (message.method === "thread/start") {
    threadParams = message.params;
    const recovery = scenario === "recovery";
    if (!validateThread(threadParams, recovery)) {
      return fail(message.id, "thread capability manifest mismatch");
    }
    if (scenario === "unknown-before-thread-response") {
      send({
        id: "dangerous-request",
        method: "command/exec/requestApproval",
        params: {},
      });
      return;
    }
    if (scenario === "oversized-stdout") {
      process.stdout.write("x".repeat(1_048_577));
      return;
    }
    if (scenario === "oversized-stderr") {
      process.stderr.write("x".repeat(4_097));
      return;
    }
    if (scenario === "hostile-rpc-error") {
      return send({
        id: message.id,
        error: { code: -32000, message: "SECRET_CHILD_PROSE_MUST_NOT_PERSIST" },
      });
    }
    const policy = {
      cwd: process.cwd(),
      approvalPolicy: "never",
      activePermissionProfile: { id: ":read-only", extends: null },
      sandbox: { type: "readOnly", networkAccess: false },
    };
    if (scenario === "policy-cwd") policy.cwd = "/wrong/cwd";
    if (scenario === "policy-approval") policy.approvalPolicy = "on-request";
    if (scenario === "policy-profile") policy.activePermissionProfile.id = ":workspace";
    if (scenario === "policy-sandbox") policy.sandbox.type = "workspaceWrite";
    if (scenario === "policy-network") policy.sandbox.networkAccess = true;
    return send({
      id: message.id,
      result: {
        ...policy,
        instructionSources: [],
        thread: { id: "thread-embedded" },
      },
    });
  }
  if (message.method === "turn/start") {
    turnParams = message.params;
    if (
      turnParams.threadId !== "thread-embedded" ||
      turnParams.environments?.length !== 0 ||
      turnParams.outputSchema?.required?.join(",") !== "reply"
    ) {
      return fail(message.id, "turn contract mismatch");
    }
    if (scenario === "research-candidate-input") {
      if (
        turnParams.input?.length !== 2 ||
        turnParams.input[0]?.type !== "text" ||
        turnParams.input[1]?.type !== "text" ||
        Object.hasOwn(turnParams, "additionalContext")
      ) return fail(message.id, "dedicated candidate item mismatch");
      const candidateItem = turnParams.input[1].text;
      const newline = candidateItem.indexOf("\n");
      const header = candidateItem.slice(0, newline);
      const candidateJson = candidateItem.slice(newline + 1);
      const expectedBytes = Number(header.split("=").at(-1));
      const candidate = JSON.parse(candidateJson);
      if (
        !header.startsWith("UNTRUSTED_RESEARCH_CANDIDATE_JSON_UTF8_BYTES=") ||
        Buffer.byteLength(candidateJson, "utf8") !== expectedBytes ||
        JSON.stringify(candidate) !== candidateJson ||
        candidate.schemaVersion !== 1 ||
        !candidate.candidateId ||
        threadParams.baseInstructions.includes(candidate.candidateId) ||
        threadParams.developerInstructions.includes(candidate.candidateId) ||
        turnParams.input[0].text.includes(candidate.candidateId)
      ) return fail(message.id, "candidate byte transfer mismatch");
    }
    const turnStartResponse = {
      id: message.id,
      result: { turn: { id: "turn-embedded", status: "inProgress" } },
    };
    if (scenario === "coalesced-turn-response-forbidden-request") {
      process.stdout.write([
        turnStartResponse,
        {
          id: "coalesced-dangerous-request",
          method: "command/exec/requestApproval",
          params: { threadId: "thread-embedded", turnId: "turn-embedded" },
        },
      ].map((frame) => JSON.stringify(frame)).join("\n") + "\n");
      return;
    }
    send(turnStartResponse);
    startTurn();
    return;
  }
  if (message.method === "turn/interrupt") {
    return send({ id: message.id, result: {} });
  }
  return fail(message.id, `unsupported client method ${message.method}`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method) {
    handleRequest(message);
    return;
  }
  if (pending.has(message.id)) {
    const expected = pending.get(message.id);
    pending.delete(message.id);
    const envelope = validateToolResponse(message, expected.callId);
    toolResponses += 1;
    if (scenario === "dependent-calls" && message.id === "dependent-a") {
      firstDependentResult = envelope;
      sendToolRequest("dependent-b", "call-b", "read", {
        query: {
          kind: "week",
          weekId: envelope.data.activeWeekId,
        },
      });
      return;
    }
    if (scenario === "dependent-calls" && message.id === "dependent-b") {
      complete(`Dependent call used ${firstDependentResult.data.activeWeekId}.`);
      return;
    }
    if (scenario === "changed-identity" && message.id === "changed-first") {
      sendToolRequest("changed-second", "changed-call", "read", {
        query: { kind: "week", weekId: "changed-payload" },
      });
      return;
    }
    if (scenario === "normal-duplicates" && toolResponses === 5) {
      complete("All exact duplicate callbacks joined one host call.");
    }
    return;
  }
  if (message.id === "dangerous-request") {
    process.stderr.write("dangerous request was rejected\n");
  }
});
