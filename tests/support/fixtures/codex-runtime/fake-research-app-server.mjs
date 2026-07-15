#!/usr/bin/env node

import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "normal";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function providerOutput(overrides = {}) {
  return {
    source: {
      kind: "web",
      identity: "Example Kitchen",
      url: "https://example.com/recipes/lentil-soup",
    },
    title: "Lentil soup",
    yieldText: null,
    steps: [{
      inputs: [{ amount: "1 cup", ingredient: "lentils" }],
      instruction: "Simmer until tender.",
      timerDurationSeconds: 900,
    }],
    ...overrides,
  };
}

function complete(output) {
  if (scenario !== "no-search") {
    send({
      method: "item/completed",
      params: {
        completedAtMs: Date.now(),
        item: {
          id: "research-web-search",
          type: "webSearch",
          query: "fixture query is intentionally not projected",
          action: { type: "search", query: "fixture query is intentionally not projected" },
        },
        threadId: "research-thread",
        turnId: "research-turn",
      },
    });
  }
  const item = {
    id: "research-message",
    type: "agentMessage",
    phase: "final_answer",
    text: JSON.stringify(output),
  };
  send({
    method: "item/completed",
    params: {
      completedAtMs: Date.now(),
      item,
      threadId: "research-thread",
      turnId: "research-turn",
    },
  });
  send({
    method: "turn/completed",
    params: {
      threadId: "research-thread",
      turn: { id: "research-turn", status: "completed", items: [item] },
    },
  });
}

function validateThread(params) {
  return params.approvalPolicy === "never" && params.permissions === ":read-only" &&
    params.cwd === process.cwd() && !Object.hasOwn(params, "sandbox") &&
    Array.isArray(params.dynamicTools) && params.dynamicTools.length === 0 &&
    params.config?.web_search === "live" &&
    params.config?.features?.shell_tool === false &&
    params.config?.features?.plugins === false &&
    params.config?.features?.multi_agent === false &&
    params.config?.mcp_servers && Object.keys(params.config.mcp_servers).length === 0;
}

function validateTurn(params) {
  const schema = params.outputSchema;
  return params.threadId === "research-thread" &&
    !Object.hasOwn(params, "additionalContext") &&
    Array.isArray(params.input) && params.input.length === 1 &&
    params.input[0]?.type === "text" &&
    typeof params.input[0]?.text === "string" &&
    schema?.additionalProperties === false &&
    schema?.required?.join(",") === "source,title,yieldText,steps" &&
    schema?.properties?.yieldText?.anyOf?.some((entry) => entry.type === "null") &&
    schema?.properties?.steps?.items?.required?.includes("timerDurationSeconds");
}

function handle(message) {
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-research" } });
    return;
  }
  if (message.method === "thread/start") {
    if (!validateThread(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "research profile mismatch" } });
      return;
    }
    send({
      id: message.id,
      result: {
        thread: { id: "research-thread" },
        cwd: process.cwd(),
        approvalPolicy: "never",
        activePermissionProfile: { id: ":read-only", extends: null },
        sandbox: { type: "readOnly", networkAccess: false },
      },
    });
    return;
  }
  if (message.method === "turn/start") {
    if (!validateTurn(message.params)) {
      send({ id: message.id, error: { code: -32602, message: "research turn mismatch" } });
      return;
    }
    send({ id: message.id, result: { turn: { id: "research-turn" } } });
    send({
      method: "turn/started",
      params: {
        threadId: "research-thread",
        turn: { id: "research-turn", status: "inProgress", items: [] },
      },
    });
    send({
      method: "thread/settings/updated",
      params: { threadId: "research-thread" },
    });
    if (scenario === "hang") return;
    if (scenario === "unknown-request") {
      send({
        id: "dangerous-request",
        method: "item/tool/call",
        params: { threadId: "research-thread", turnId: "research-turn" },
      });
      return;
    }
    if (scenario === "protocol-error") {
      send({
        method: "item/completed",
        params: {
          completedAtMs: Date.now(),
          threadId: "other-thread",
          turnId: "research-turn",
          item: {},
        },
      });
      return;
    }
    if (scenario === "partial-turn-notification") {
      send({
        method: "item/completed",
        params: { completedAtMs: Date.now(), threadId: "research-thread", item: {} },
      });
      return;
    }
    if (scenario === "missing-completed-at") {
      send({
        method: "item/completed",
        params: {
          threadId: "research-thread",
          turnId: "research-turn",
          item: { id: "missing-completed-at", type: "webSearch" },
        },
      });
      return;
    }
    if (scenario === "invalid-completed-at") {
      send({
        method: "item/completed",
        params: {
          completedAtMs: "not-an-integer",
          threadId: "research-thread",
          turnId: "research-turn",
          item: { id: "invalid-completed-at", type: "webSearch" },
        },
      });
      return;
    }
    if (scenario === "hostile-field") {
      complete(providerOutput({ pageBody: "PROMPT_INJECTION_SENTINEL" }));
      return;
    }
    if (scenario === "oversize") {
      complete(providerOutput({
        steps: [{
          inputs: [],
          instruction: "x".repeat(1_001),
          timerDurationSeconds: null,
        }],
      }));
      return;
    }
    complete(providerOutput());
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    process.exit(0);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  handle(message);
});
